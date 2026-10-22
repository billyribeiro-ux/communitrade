"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import type { DataMeta, Instrument, InstrumentPage, ValidateOptionStrategyRequest, ValidateOptionStrategyResponse } from "@/lib/instruments";
import { formatDateUTC, getExpirationStatus } from "@/lib/instruments";
import { optionStrategies, orderOptionLegs, strategyDefinition, validContractSelection, type OptionStrategyId } from "@/lib/option-strategies";
import { DataStatus } from "./InstrumentBrowser";
import styles from "../instruments.module.css";

type OptionContract = Instrument & { expiration: string; optionType: "call" | "put"; strike: string };
type FuturesContract = Instrument & { root: "ES" | "MES" | "NQ" | "MNQ"; contractMonth: string; expiration: string };
function selectionBlockReason(contract: Instrument) {
  if (!contract.enabled) return "Catalog disabled";
  if (!contract.meta.capabilities.newPublishing) return "New publishing not permitted";
  if (contract.meta.freshness !== "fresh") return "Data is not fresh";
  if (contract.adjusted) return "Adjusted contracts are unsupported";
  if (getExpirationStatus(contract.expiration)?.expired) return "Expired · reference history only";
  return undefined;
}

async function loadPage(path: string): Promise<InstrumentPage> {
  const response = await fetch(`/api/v1${path}`, { credentials: "same-origin", cache: "no-store", headers: { Accept: "application/json" } });
  if (!response.ok) throw new Error(response.status === 403 ? "The supplier license does not permit this audience to display these contracts." : response.status === 404 ? "No matching listed contracts were found." : response.status === 503 ? "The licensed contract reference provider is unavailable." : `Contracts could not be loaded (HTTP ${response.status}).`);
  return response.json() as Promise<InstrumentPage>;
}

export function OptionStrategySelector({ underlying, csrfToken }: { underlying: Instrument; csrfToken: string | null }) {
  const [contracts, setContracts] = useState<OptionContract[]>([]); const [envelope, setEnvelope] = useState<DataMeta>(); const [nextCursor, setNextCursor] = useState<string | null>(null); const [expiration, setExpiration] = useState(""); const [right, setRight] = useState<"call" | "put">("call");
  const [strategy, setStrategy] = useState<OptionStrategyId>("long_call"); const [selected, setSelected] = useState<string[]>([]); const [quantity, setQuantity] = useState("1"); const [error, setError] = useState(""); const [busy, setBusy] = useState(false); const [validation, setValidation] = useState<ValidateOptionStrategyResponse | null>(null);
  const required = strategyDefinition(strategy)?.contracts ?? 1;
  const available = useMemo(() => contracts.filter(contract => (!expiration || contract.expiration === expiration) && contract.optionType === right).sort((a, b) => Number(a.strike) - Number(b.strike)), [contracts, expiration, right]);
  const orderedLegs = useMemo(() => orderOptionLegs(strategy, selected.map(id => contracts.find(contract => contract.id === id)).filter((contract): contract is OptionContract => Boolean(contract))), [contracts, selected, strategy]);
  const orderedSelected = orderedLegs.map(leg => leg.contract);
  const sideByContractId = new Map(orderedLegs.map(leg => [leg.contract.id, leg.side]));
  const expirations = useMemo(() => Array.from(new Set(contracts.filter(item => item.optionType === right).map(item => item.expiration))).sort(), [contracts, right]);
  useEffect(() => { let alive = true; loadPage(`/instruments/${encodeURIComponent(underlying.id)}/option-contracts?limit=50`).then(page => { if (alive) { setContracts(page.items as OptionContract[]); setNextCursor(page.nextCursor); setEnvelope(page.items[0]?.meta); setError(""); } }).catch(reason => { if (alive) setError(reason instanceof Error ? reason.message : "Option contracts are unavailable."); }); return () => { alive = false; }; }, [underlying.id]);
  useEffect(() => { const needs = strategyDefinition(strategy)?.optionType ?? "call"; setRight(needs); setSelected([]); setValidation(null); }, [strategy]);
  function toggle(id: string) { setSelected(old => old.includes(id) ? old.filter(item => item !== id) : required === 1 ? [id] : old.length < required ? [...old, id] : old); setValidation(null); }
  async function loadMore() {
    if (!nextCursor) return;
    const params = new URLSearchParams({ limit: "50", cursor: nextCursor });
    try { const page = await loadPage(`/instruments/${encodeURIComponent(underlying.id)}/option-contracts?${params}`); setContracts(items => [...items, ...(page.items as OptionContract[]).filter(item => !items.some(old => old.id === item.id))]); setNextCursor(page.nextCursor); setEnvelope(page.items[0]?.meta); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "More option contracts could not be loaded."); }
  }
  async function validate() {
    setError(""); setBusy(true); setValidation(null);
    try {
      if (!validContractSelection(selected, required) || orderedSelected.length !== required) throw new Error(`Select exactly ${required} distinct listed contract${required === 1 ? "" : "s"}.`);
      if (orderedSelected.some(contract => selectionBlockReason(contract))) throw new Error("Selected contract is expired, disabled, adjusted, stale, or not permitted for new publishing. Choose an eligible contract.");
      const legs: ValidateOptionStrategyRequest["legs"] = orderedLegs.map(({ side }) => ({ side, quantity: Number(quantity) }));
      const request: ValidateOptionStrategyRequest = { strategy, underlyingInstrumentId: underlying.id, optionContractIds: orderedSelected.map(contract => contract.id), quantity: Number(quantity), legs };
      const response = await fetch("/api/v1/trade-plans/validate-strategy", { method: "POST", credentials: "same-origin", cache: "no-store", headers: { Accept: "application/json", "Content-Type": "application/json", "X-CSRF-Token": csrfToken ?? "" }, body: JSON.stringify(request) });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(typeof body.detail === "string" ? body.detail : response.status === 401 ? "Sign in to validate a trade structure." : "The server could not validate these contracts. Correct the selections or retry.");
      setValidation(body as ValidateOptionStrategyResponse);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Strategy validation failed."); }
    finally { setBusy(false); }
  }
  return <section className={`${styles.card} ${styles.selector}`} aria-labelledby="option-selector-title"><h2 id="option-selector-title">Select actual option contracts</h2><p>Contracts are chosen by expiration, call/put right, strike, and stable contract ID. Server validation checks actual listed terms.</p>
    <DataStatus envelope={envelope ?? contracts[0]?.meta}/>
    <div className={styles.strategyGrid}>{optionStrategies.map(({ id, label }) => <div className={styles.strategy} key={id}><input checked={strategy === id} id={`strategy-${id}`} name="option-strategy" onChange={() => setStrategy(id)} type="radio"/><label htmlFor={`strategy-${id}`}>{label}</label></div>)}</div>
    <label>Option right<select value={right} onChange={event => { setRight(event.target.value as "call" | "put"); setSelected([]); setValidation(null); }}><option value="call">Call</option><option value="put">Put</option></select></label>
    <label>Expiration<select value={expiration} onChange={event => { setExpiration(event.target.value); setSelected([]); setValidation(null); }}><option value="">All returned expirations</option>{expirations.map(value => <option key={value} value={value}>{formatDateUTC(value)}</option>)}</select></label>
    {error && <div className={`${styles.notice} ${styles.warning}`} role="alert">{error}</div>}
    {available.length ? <div className={styles.contracts} aria-label="Actual option contracts">{available.map(contract => { const reason = selectionBlockReason(contract); return <div className={styles.contract} key={contract.id}><input aria-label={`Select ${contract.symbol}`} checked={selected.includes(contract.id)} disabled={Boolean(reason) || (!selected.includes(contract.id) && selected.length >= required)} onChange={() => toggle(contract.id)} type={required === 1 ? "radio" : "checkbox"} name="option-contract"/><div><label>{contract.symbol}</label><small>{formatDateUTC(contract.expiration)} · {contract.optionType} · strike {contract.strike} · multiplier {contract.multiplier} · metadata v{contract.metadataVersion}{reason ? ` · ${reason}` : " · standard contract"}</small>{sideByContractId.has(contract.id) && <span className={styles.tag}>Selected leg: {sideByContractId.get(contract.id)}</span>}{getExpirationStatus(contract.expiration) && !getExpirationStatus(contract.expiration)?.expired && <span className={styles.tag}>Near expiry · {getExpirationStatus(contract.expiration)?.days} days</span>}</div><span className={styles.tag}>{contract.id.slice(0, 8)}…</span></div>; })}</div> : !error && <div className={styles.empty}>No contracts were returned for this option right and expiration filter.</div>}
    {nextCursor && <button onClick={loadMore} type="button">Load more actual contracts</button>}
    <label>Contract quantity<input min="1" step="1" inputMode="numeric" type="number" value={quantity} onChange={event => setQuantity(event.target.value)}/><small>Vertical legs use equal contract quantities.</small></label>
    <button disabled={!csrfToken || busy || selected.length !== required || Number(quantity) < 1} onClick={validate} type="button">{busy ? "Validating…" : "Validate with licensed quote data"}</button>
    {!csrfToken && <p>Sign in to validate a trade plan. Reference data remains public where the supplier permits it.</p>}
    {validation && <div className={styles.validation} role="status"><strong>{validation.valid ? "Server validation passed" : "Server validation found an issue"}</strong><p>Structure: {validation.strategy} · premium type: {validation.netKind ?? "unavailable"}</p><p>Net debit/credit: {validation.netPrice == null ? "No permitted net value was validated." : `${validation.netKind} ${validation.netPrice} per share`}</p><DataStatus envelope={validation.meta}/>{validation.validationIssues.map((issue, index) => <p key={`${issue.code}-${index}`}>{issue.message}</p>)}</div>}
  </section>;
}

export function FuturesContractSelector({ rootInstrument }: { rootInstrument: Instrument }) {
  const [contracts, setContracts] = useState<FuturesContract[]>([]); const [envelope, setEnvelope] = useState<DataMeta>(); const [month, setMonth] = useState(""); const [error, setError] = useState(""); const [nextCursor, setNextCursor] = useState<string | null>(null);
  useEffect(() => { let alive = true; loadPage(`/futures-contracts?${new URLSearchParams({ root: rootInstrument.root ?? rootInstrument.symbol, limit: "50" })}`).then(page => { if (alive) { setContracts(page.items as FuturesContract[]); setNextCursor(page.nextCursor); setEnvelope(page.items[0]?.meta); } }).catch(reason => { if (alive) setError(reason instanceof Error ? reason.message : "Listed futures unavailable."); }); return () => { alive = false; }; }, [rootInstrument.root, rootInstrument.symbol]);
  async function loadMore() { if (!nextCursor) return; const params = new URLSearchParams({ root: rootInstrument.root ?? rootInstrument.symbol, limit: "50", cursor: nextCursor }); try { const page = await loadPage(`/futures-contracts?${params}`); setContracts(items => [...items, ...(page.items as FuturesContract[]).filter(item => !items.some(old => old.id === item.id))]); setNextCursor(page.nextCursor); setEnvelope(page.items[0]?.meta); } catch (reason) { setError(reason instanceof Error ? reason.message : "More listed months could not be loaded."); } }
  const months = Array.from(new Set(contracts.map(item => item.contractMonth))).sort();
  const chosen = contracts.find(item => item.contractMonth === month);
  return <section className={`${styles.card} ${styles.selector}`} aria-labelledby="future-selector-title"><h2 id="future-selector-title">Choose the listed futures contract</h2><p>Futures references always identify the exchange-listed month. The root symbol alone is not a tradable contract selection.</p><DataStatus envelope={envelope ?? contracts[0]?.meta}/>{error && <div className={`${styles.notice} ${styles.warning}`} role="alert">{error}</div>}<label>Root and contract month<select value={month} onChange={event => setMonth(event.target.value)}><option value="">Select a listed month</option>{months.map(value => { const contract = contracts.find(item => item.contractMonth === value)!; const reason = selectionBlockReason(contract); const expiry = getExpirationStatus(contract.expiration); const label = expiry?.expired ? "expired · history only" : expiry ? `near expiry · ${expiry.days} days` : reason; return <option disabled={Boolean(reason)} key={value} value={value}>{rootInstrument.root ?? rootInstrument.symbol} · {value}{label ? ` · ${label}` : ""}</option>; })}</select></label>{chosen && <div className={styles.validation}><strong>{chosen.symbol} · {chosen.contractMonth}</strong><p><Link href={`/instruments/${encodeURIComponent(chosen.id)}`}>Open this contract’s price chart</Link></p><p>Contract ID {chosen.id} · expires {formatDateUTC(chosen.expiration)} · multiplier {chosen.multiplier} · tick {chosen.tickSize} · metadata v{chosen.metadataVersion}</p><p>{selectionBlockReason(chosen) ? `${selectionBlockReason(chosen)}. Existing historical references remain readable.` : getExpirationStatus(chosen.expiration) ? `Near expiry: ${getExpirationStatus(chosen.expiration)!.days} days remaining.` : "Current listed contract is available for new plans."}</p></div>}{nextCursor && <button onClick={loadMore} type="button">Load more listed months</button>}</section>;
}
