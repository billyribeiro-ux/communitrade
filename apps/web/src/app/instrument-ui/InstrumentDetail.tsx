import Link from "next/link";
import type { ReactNode } from "react";
import type { DataMeta, Instrument, InstrumentDetail, Quote } from "@/lib/instruments";
import { formatAsOf, formatDateUTC, getExpirationStatus } from "@/lib/instruments";
import styles from "../instruments.module.css";
import { OptionStrategySelector, FuturesContractSelector } from "./ContractSelectors";
import { InstrumentFollow } from "@/components/community/CommunityActions";
import type { Viewer } from "@/lib/community";

function MetaPanel({ envelope, quoteFailure }: { envelope?: DataMeta | undefined; quoteFailure?: string | undefined }) {
  if (!envelope) return <div className={`${styles.notice} ${styles.warning}`} role="status"><strong>Freshness unavailable.</strong> No source envelope was returned. Quotes are withheld until source and allowed-use status can be confirmed.{quoteFailure && <p>{quoteFailure}</p>}</div>;
  const unavailable = envelope.freshness === "missing" || envelope.freshness === "unavailable";
  const stale = envelope.freshness === "stale";
  return <div className={`${styles.notice} ${stale || unavailable ? styles.warning : ""}`} role="status">
    <strong>{envelope.providerReference}</strong> · {envelope.freshness} · {envelope.delaySeconds} second delay · as of {formatAsOf(envelope.asOf)}
    <div className={styles.tags}>{Object.entries(envelope.capabilities).map(([capability, permitted]) => <span className={styles.tag} key={capability}>{capability.replace(/[A-Z]/g, letter => ` ${letter.toLowerCase()}`)}: {permitted ? "permitted" : "not permitted"}</span>)}</div>
    {envelope.freshness === "stale" && <p>Provider data is stale; this view does not imply a current market quote.</p>}
    {envelope.delaySeconds > 0 && <p>The provider reports {envelope.delaySeconds} seconds of data delay.</p>}
    {unavailable && <p>Data is missing or the provider failed. Contract identity and retained history remain visible where allowed.</p>}
    {quoteFailure && <p>{quoteFailure}</p>}
  </div>;
}
function formatSession(value: unknown) {
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && !Array.isArray(value)) return Object.entries(value).map(([key, entry]) => `${key}: ${String(entry)}`).join(" · ");
  return "Not supplied";
}
export function InstrumentDetailView({ instrument, quote, quoteFailure, csrfToken, viewer, following, underlying, underlyingFailure, chart }: { instrument: InstrumentDetail; quote?: Quote | undefined; quoteFailure?: string | undefined; csrfToken: string | null; viewer: Viewer | null; following?: boolean | null; underlying?: Instrument | undefined; underlyingFailure?: string | undefined; chart?: ReactNode }) {
  const env = quote?.meta ?? instrument.meta;
  const currentVersions = instrument.versions ?? [];
  const expirationStatus = getExpirationStatus(instrument.expiration);
  const stockUnderlying = instrument.asset === "stock" ? instrument : instrument.asset === "option" ? underlying : undefined;
  return <div className={styles.page}>
    <p className={styles.eyebrow}>INSTRUMENT REFERENCE · {instrument.asset.toUpperCase()}</p><h1>{instrument.symbol}</h1><p className={styles.intro}>{instrument.name} · {instrument.venue} · {instrument.currency} · catalog metadata version {instrument.metadataVersion}. This reference is not an execution venue or recommendation.</p>
    {(instrument.synthetic || instrument.meta?.demo || env?.demo) && <p className={`${styles.notice} ${styles.warning}`}><strong>Demo data · synthetic.</strong> Values and catalog entries are deterministic fixtures, not live or broker-verified market data.</p>}
    {(!instrument.enabled || !instrument.meta.capabilities.newPublishing || instrument.meta.freshness !== "fresh") && <p className={`${styles.notice} ${styles.warning}`} role="status"><strong>{!instrument.enabled ? "Catalog disabled." : !instrument.meta.capabilities.newPublishing ? "New publishing is not permitted by data rights." : "New publishing is held because data is not fresh."}</strong> Existing publications keep their original metadata and history.</p>}
    {expirationStatus?.expired && <p className={`${styles.notice} ${styles.warning}`} role="status"><strong>Expired contract · reference history only.</strong> This contract remains readable for historical context and cannot be selected for a new plan.</p>}
    {expirationStatus && !expirationStatus.expired && <p className={styles.notice} role="status"><strong>Near expiry.</strong> {expirationStatus.days} days remain through the UTC expiration date.</p>}
    <section className={styles.detailGrid}>
      <article className={styles.card}>
        <h2>Reference identity</h2>
        <dl className={styles.facts}>
          <dt>Asset</dt><dd>{instrument.asset}</dd>
          <dt>Exchange</dt><dd>{instrument.venue}</dd>
          <dt>Metadata version</dt><dd>v{instrument.metadataVersion}</dd>
          {instrument.root && <><dt>Futures root</dt><dd>{instrument.root}</dd></>}
          {instrument.contractMonth && <><dt>Contract month</dt><dd>{instrument.contractMonth}</dd></>}
          {instrument.expiration && <><dt>Expiration</dt><dd>{formatDateUTC(instrument.expiration)}</dd></>}
          {instrument.optionType && <><dt>Option right / strike</dt><dd>{instrument.optionType} · {instrument.strike}</dd></>}
          {instrument.multiplier && <><dt>Multiplier</dt><dd>{instrument.multiplier}</dd></>}
          {instrument.tickSize && <><dt>Minimum tick</dt><dd>{instrument.tickSize}</dd></>}
          {instrument.adjusted !== undefined && <><dt>Adjusted contract</dt><dd>{instrument.adjusted ? "Yes · unsupported for Phase 1 trade plans" : "No · standard contract"}</dd></>}
          {instrument.session != null && <><dt>Session</dt><dd>{formatSession(instrument.session)}</dd></>}
        </dl>
        <InstrumentFollow instrumentId={instrument.id} viewer={viewer} {...(following === undefined ? {} : { initialFollowing: following })}/>
        <div><h3>Metadata history</h3>{currentVersions.length ? <><p>Version changes are retained so historical plans continue to reference their original terms. Select a version to inspect its recorded metadata.</p><div className={styles.versions}>{currentVersions.map(version => <Link className={styles.tag} href={`/instruments/${encodeURIComponent(instrument.id)}?metadataVersion=${version.metadataVersion}`} key={version.metadataVersion}>v{version.metadataVersion}{version.metadataVersion === instrument.metadataVersion ? " · current" : " · historical"}{version.sourceId ? ` · ${version.sourceId}` : ""}</Link>)}</div></> : <p>The catalog returned current metadata v{instrument.metadataVersion}; it did not return a historical version inventory for this instrument.</p>}</div>
      </article>
      <article className={styles.card}><h2>Data source and permitted use</h2><MetaPanel envelope={env} quoteFailure={quoteFailure}/>{quote && env && <p>Bid {quote.bid ?? "unavailable"} · Ask {quote.ask ?? "unavailable"}</p>}<p>License capabilities independently govern public/member display, retained bars, snapshots, exports, and new publishing. Restricted values are not displayed.</p></article>
    </section>
    {chart}
    {stockUnderlying && <OptionStrategySelector underlying={stockUnderlying} csrfToken={csrfToken}/>}
    {instrument.asset === "future" && instrument.root && <FuturesContractSelector rootInstrument={instrument}/>}
    {instrument.asset === "option" && instrument.underlyingId && <p className={styles.intro}>Underlying instrument: {underlying ? <Link href={`/instruments/${encodeURIComponent(underlying.id)}`}>{underlying.symbol} · {underlying.name}</Link> : underlyingFailure ?? "Reference unavailable."}</p>}
    {instrument.asset === "stock" && <p className={styles.intro}>This is the underlying instrument. Option contracts are listed individually from licensed reference data above. Supported option plans are long calls, long puts, bull call debit spreads, bear put debit spreads, bull put credit spreads, and bear call credit spreads. No Greeks are inferred when supplier data is absent.</p>}
    <p className={styles.intro}><Link href="/instruments">Back to instrument lookup</Link> · <Link href="/ideas">Explore public ideas</Link></p>
  </div>;
}
