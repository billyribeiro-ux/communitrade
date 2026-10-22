"use client";

import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import type { components } from "@trading/contracts";
import styles from "./DraftSetup.module.css";

type Draft = components["schemas"]["Draft"];
type Instrument = components["schemas"]["Instrument"];
type InstrumentPage = components["schemas"]["InstrumentPage"];
type Asset = "stock" | "option" | "future";
type Kind = "trade" | "education";
type Strategy = "long_call" | "long_put" | "bull_call_debit" | "bear_put_debit" | "bull_put_credit" | "bear_call_credit";
type PriceKind = "underlying" | "option_premium" | "spread_debit" | "spread_credit" | "futures";
type SavedDraft = { draft: Draft; etag: string };
type DraftResponse = Draft & { revision: number };

const optionStrategies: readonly { value: Strategy; label: string; priceKind: PriceKind }[] = [
  { value: "long_call", label: "Long call", priceKind: "option_premium" },
  { value: "long_put", label: "Long put", priceKind: "option_premium" },
  { value: "bull_call_debit", label: "Call debit spread", priceKind: "spread_debit" },
  { value: "bear_put_debit", label: "Put debit spread", priceKind: "spread_debit" },
  { value: "bull_put_credit", label: "Put credit spread", priceKind: "spread_credit" },
  { value: "bear_call_credit", label: "Call credit spread", priceKind: "spread_credit" },
];
const roots = ["ES", "MES", "NQ", "MNQ"] as const;
const isSynthetic = (instrument: Instrument) => instrument.meta.demo
  || Boolean((instrument as Instrument & { synthetic?: boolean }).synthetic);
const permitted = (instrument: Instrument) => instrument.enabled
  && instrument.meta.capabilities.displayMember
  && instrument.meta.capabilities.retainBars;
const publicationStatus = (instrument: Instrument) => instrument.meta.capabilities.newPublishing
  && instrument.meta.freshness === "fresh"
  && !isSynthetic(instrument)
  ? "New publishing available"
  : "New publishing held";
const instrumentLabel = (instrument: Instrument) => `${instrument.symbol} · ${instrument.name}${instrument.contractMonth ? ` · ${instrument.contractMonth}` : ""}`;

function responseMessage(body: unknown, fallback: string): string {
  if (body && typeof body === "object" && "detail" in body && typeof body.detail === "string") return body.detail;
  if (body && typeof body === "object" && "title" in body && typeof body.title === "string") return body.title;
  return fallback;
}

async function readJson<T>(response: Response): Promise<T | null> {
  return response.json().catch(() => null) as Promise<T | null>;
}

function parseEtag(response: Response, revision: number): string {
  return response.headers.get("etag") ?? `"${revision}"`;
}

export function DraftSetup({ csrfToken }: { csrfToken: string }) {
  const router = useRouter();
  const createKey = useRef<string | null>(null);
  const [kind, setKind] = useState<Kind>("trade");
  const [asset, setAsset] = useState<Asset>("stock");
  const [title, setTitle] = useState("");
  const [query, setQuery] = useState("");
  const [root, setRoot] = useState<(typeof roots)[number]>("ES");
  const [instruments, setInstruments] = useState<readonly Instrument[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [catalogLoading, setCatalogLoading] = useState(true);
  const [catalogError, setCatalogError] = useState("");
  const [strategy, setStrategy] = useState<Strategy | "">("");
  const [priceKind, setPriceKind] = useState<PriceKind>("underlying");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [savedDraft, setSavedDraft] = useState<SavedDraft | null>(null);
  const selectedInstrument = useMemo(() => instruments.find(item => item.id === selectedId), [instruments, selectedId]);
  const usable = useMemo(() => instruments.filter(item => permitted(item)
    && (asset === "future" ? item.asset === "future" && !!item.contractMonth && !!item.expiration : item.asset === "stock")), [asset, instruments]);

  useEffect(() => {
    const controller = new AbortController();
    setCatalogLoading(true);
    setCatalogError("");
    const timer = window.setTimeout(() => {
      const params = new URLSearchParams({ limit: "50" });
      const path = asset === "future" ? "/futures-contracts" : "/instruments";
      if (asset === "future") params.set("root", root);
      else {
        params.set("asset", "stock");
        if (query.trim()) params.set("q", query.trim().slice(0, 100));
      }
      fetch(`/api/v1${path}?${params}`, {
        method: "GET", credentials: "same-origin", cache: "no-store", signal: controller.signal,
        headers: { Accept: "application/json" },
      }).then(async response => {
        if (response.status === 401) {
          window.location.assign(`/login?returnTo=${encodeURIComponent("/app/publish")}`);
          return;
        }
        const body = await readJson<InstrumentPage>(response);
        if (!response.ok || !body || !Array.isArray(body.items)) throw new Error(responseMessage(body, "The member instrument catalog is unavailable. Retry the search."));
        setInstruments(body.items);
        setSelectedId(current => body.items.some(item => item.id === current) ? current : "");
      }).catch(reason => {
        if (controller.signal.aborted) return;
        setInstruments([]);
        setSelectedId("");
        setCatalogError(reason instanceof Error ? reason.message : "The member instrument catalog is unavailable. Retry the search.");
      }).finally(() => { if (!controller.signal.aborted) setCatalogLoading(false); });
    }, 250);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [asset, query, root]);

  useEffect(() => {
    setSelectedId("");
    if (asset === "stock") setPriceKind("underlying");
    else if (asset === "future") { setPriceKind("futures"); setStrategy(""); }
    else { setPriceKind(strategy ? optionStrategies.find(item => item.value === strategy)!.priceKind : "option_premium"); }
  }, [asset]);

  function onStrategy(value: Strategy | "") {
    setStrategy(value);
    const selected = optionStrategies.find(item => item.value === value);
    setPriceKind(selected?.priceKind ?? "option_premium");
  }

  async function createOrRetry(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    if (busy) return;
    if (!savedDraft && !selectedInstrument) { setError("Choose an eligible instrument from the member catalog first."); return; }
    setBusy(true);
    try {
      let saved = savedDraft;
      if (!saved) {
        createKey.current ??= globalThis.crypto.randomUUID();
        const response = await fetch("/api/v1/drafts", {
          method: "POST", credentials: "same-origin", cache: "no-store",
          headers: { Accept: "application/json", "Content-Type": "application/json", "X-CSRF-Token": csrfToken, "Idempotency-Key": createKey.current },
          body: JSON.stringify({ kind, asset }),
        });
        if (response.status === 401) { window.location.assign(`/login?returnTo=${encodeURIComponent("/app/publish")}`); return; }
        const body = await readJson<DraftResponse>(response);
        if (!response.ok || !body || typeof body.id !== "string" || !Number.isInteger(body.revision)) throw new Error(responseMessage(body, "The draft could not be created. Retry to safely resume the same request."));
        saved = { draft: body, etag: parseEtag(response, body.revision) };
        setSavedDraft(saved);
      }

      const payload = {
        title: title.trim() || `${asset === "option" ? "Options" : asset === "future" ? "Futures" : "Stock"} trade idea · ${selectedInstrument?.symbol ?? "Draft"}`,
        plan: {
          asset,
          ...(selectedInstrument ? { instrumentId: selectedInstrument.id } : {}),
          priceKind: asset === "stock" ? "underlying" : asset === "future" ? "futures" : priceKind,
          ...(asset === "option" && strategy ? { strategy } : {}),
        },
      };
      const response = await fetch(`/api/v1/drafts/${encodeURIComponent(saved.draft.id)}`, {
        method: "PATCH", credentials: "same-origin", cache: "no-store",
        headers: { Accept: "application/json", "Content-Type": "application/json", "X-CSRF-Token": csrfToken, "If-Match": saved.etag },
        body: JSON.stringify(payload),
      });
      if (response.status === 401) { window.location.assign(`/login?returnTo=${encodeURIComponent("/app/publish")}`); return; }
      const body = await readJson<DraftResponse>(response);
      if (response.ok && body && Number.isInteger(body.revision)) {
        router.push(`/app/drafts/${encodeURIComponent(body.id)}`);
        return;
      }
      if (response.status === 409 || response.status === 412) {
        const refreshedResponse = await fetch(`/api/v1/drafts/${encodeURIComponent(saved.draft.id)}`, { credentials: "same-origin", cache: "no-store", headers: { Accept: "application/json" } });
        if (refreshedResponse.ok) {
          const refreshed = await readJson<DraftResponse>(refreshedResponse);
          if (refreshed && Number.isInteger(refreshed.revision)) {
            const nextSaved = { draft: refreshed, etag: parseEtag(refreshedResponse, refreshed.revision) };
            setSavedDraft(nextSaved);
            const matching = refreshed.title === payload.title && refreshed.plan?.asset === asset
              && refreshed.plan?.instrumentId === selectedInstrument?.id && refreshed.plan?.priceKind === payload.plan.priceKind
              && refreshed.plan?.strategy === (strategy || undefined);
            if (matching) { router.push(`/app/drafts/${encodeURIComponent(refreshed.id)}`); return; }
            throw new Error("The draft changed elsewhere. Its latest revision is loaded; review the setup and retry the save.");
          }
        }
      }
      throw new Error(responseMessage(body, "The draft exists, but its setup could not be saved. Retry setup to continue without creating another draft."));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "The draft setup could not be saved. Retry to continue.");
    } finally {
      setBusy(false);
    }
  }

  const isOptions = asset === "option";
  const instrumentLabelText = asset === "future" ? "Listed futures contract" : isOptions ? "Underlying stock" : "Stock";

  return <form className={styles.form} onSubmit={createOrRetry}>
    {savedDraft && <div className={styles.saved} role="status"><strong>Draft created and reserved.</strong><span>Draft {savedDraft.draft.id} · revision {savedDraft.draft.revision}. Retry setup to save the selected instrument; a second draft will not be created.</span></div>}
    <div className={styles.fields}>
      <label>Draft type
        <select value={kind} onChange={event => setKind(event.target.value as Kind)} disabled={busy || !!savedDraft || createKey.current !== null}><option value="trade">Trade idea</option><option value="education">Educational post</option></select>
      </label>
      <label>Asset class
        <select value={asset} onChange={event => setAsset(event.target.value as Asset)} disabled={busy || !!savedDraft || createKey.current !== null}><option value="stock">Stock</option><option value="option">Options</option><option value="future">Futures</option></select>
      </label>
      <label className={styles.wide}>Draft title <span className={styles.hint}>(optional)</span>
        <input value={title} maxLength={120} onChange={event => setTitle(event.target.value)} placeholder="Example: XYZ earnings setup" disabled={busy}/>
      </label>
      {asset === "future" ? <label>Futures root
        <select value={root} onChange={event => setRoot(event.target.value as (typeof roots)[number])} disabled={busy}>{roots.map(value => <option key={value} value={value}>{value}</option>)}</select>
      </label> : <label className={styles.wide}>{asset === "option" ? "Search underlying stocks" : "Search stocks"}
        <input autoComplete="off" value={query} onChange={event => setQuery(event.target.value)} placeholder="Symbol or company name" disabled={busy}/>
      </label>}
      {isOptions && <>
        <label>Options strategy <span className={styles.hint}>(optional)</span>
          <select value={strategy} onChange={event => onStrategy(event.target.value as Strategy | "")} disabled={busy}><option value="">Choose later</option>{optionStrategies.map(item => <option key={item.value} value={item.value}>{item.label}</option>)}</select>
        </label>
        <label>Price type
          <select value={priceKind} onChange={event => setPriceKind(event.target.value as PriceKind)} disabled={busy}><option value="option_premium">Option premium</option><option value="spread_debit">Spread debit</option><option value="spread_credit">Spread credit</option></select>
        </label>
      </>}
    </div>

    <div className={styles.catalog}>
      <div className={styles.catalogHeading}><div><h2>{instrumentLabelText}</h2><p>{isOptions ? "Options use the selected stock as the chart underlying. The option contract can be added in the trade plan later." : asset === "future" ? "Choose an actual dated listed contract. No continuous contract is used." : "Choose an enabled instrument that allows member display and retained bars. Private chart drafts can use retained history while new publishing is held."}</p></div>{catalogLoading && <span role="status">Loading catalog…</span>}</div>
      {catalogError && <p className={styles.error} role="alert">{catalogError}</p>}
      {!catalogLoading && !catalogError && usable.length === 0 && <p className={styles.empty}>No enabled instruments with member display and retained-bar access are available for this search. Try another symbol or futures root.</p>}
      {usable.length > 0 && <fieldset className={styles.choices}>
        <legend>Available instruments · current member catalog</legend>
        {usable.map(instrument => <label className={styles.choice} key={instrument.id}>
          <input type="radio" name="instrument" value={instrument.id} checked={selectedId === instrument.id} onChange={() => setSelectedId(instrument.id)} disabled={busy}/>
          <span><strong>{instrumentLabel(instrument)}</strong><small>{instrument.venue} · {instrument.currency} · metadata v{instrument.metadataVersion} · {instrument.meta.providerReference ?? instrument.meta.provider} · {instrument.meta.freshness} · {isSynthetic(instrument) ? "Synthetic fixture · not production data · " : ""}{publicationStatus(instrument)}</small></span>
        </label>)}
      </fieldset>}
    </div>

    {selectedInstrument && <p className={styles.selection} role="status">Selected {instrumentLabel(selectedInstrument)}. {asset === "option" ? "Only its underlying stock is linked in this setup." : asset === "future" ? "This draft is linked to the listed contract shown above." : "The plan uses underlying stock prices."}</p>}
    {error && <p className={styles.error} role="alert">{error}</p>}
    <button className={styles.submit} type="submit" disabled={busy || catalogLoading || (!savedDraft && !selectedInstrument)}>{busy ? "Saving setup…" : savedDraft ? "Retry setup save" : "Create draft and continue"}</button>
  </form>;
}
