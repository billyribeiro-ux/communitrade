import Link from "next/link";
import { type Instrument, type InstrumentPage, type DataMeta, formatAsOf, getExpirationStatus } from "@/lib/instruments";
import styles from "../instruments.module.css";

export function DataStatus({ envelope }: { envelope?: DataMeta | undefined }) {
  if (!envelope) return <div className={`${styles.notice} ${styles.warning}`} role="status"><strong>Data status unavailable.</strong> The reference response did not include source and freshness details.</div>;
  const stale = envelope.freshness === "stale";
  const failed = envelope.freshness === "missing" || envelope.freshness === "unavailable";
  return <div className={`${styles.notice} ${stale || failed ? styles.warning : ""}`} role="status">
    <strong>{envelope.providerReference ?? envelope.provider ?? "Source unavailable"}</strong> · {envelope.freshness} · as of {formatAsOf(envelope.asOf)} · {Math.ceil(envelope.delaySeconds / 60)} min delay
    <div className={styles.tags} aria-label="Allowed data uses">{Object.entries(envelope.capabilities).map(([name, allowed]) => <span className={styles.tag} key={name}>{name.replace(/[A-Z]/g, letter => ` ${letter.toLowerCase()}`)}: {allowed ? "allowed" : "unavailable"}</span>)}</div>
  </div>;
}

export function InstrumentResults({ page, query = "", assetClass = "", basePath = "/instruments", cursorParam="cursor" }: { page: InstrumentPage; query?: string; assetClass?: string; basePath?: string; cursorParam?: "cursor"|"instrumentCursor" }) {
  return <>
    <DataStatus envelope={page.envelope ?? page.items[0]?.meta}/>
    {page.items.length ? <ul className={styles.results}>{page.items.map((instrument: Instrument) => <li key={instrument.id} className={styles.result}>
      <div><Link href={`/instruments/${encodeURIComponent(instrument.id)}`}>{instrument.symbol} · {instrument.name}</Link><p>{instrument.asset} · {instrument.venue} · metadata v{instrument.metadataVersion}{instrument.root ? ` · ${instrument.root} ${instrument.contractMonth ?? ""}` : ""}</p></div>
      <div className={styles.tags}><span className={styles.tag}>{!instrument.enabled ? "New publishing disabled by catalog" : !instrument.meta.capabilities.newPublishing ? "New publishing not permitted by data rights" : instrument.meta.freshness !== "fresh" ? "New publishing held · data not fresh" : "New publishing enabled"}</span>{(instrument.asset === "future" || instrument.asset === "option") && getExpirationStatus(instrument.expiration) && <span className={styles.tag}>{getExpirationStatus(instrument.expiration)!.expired ? "Expired · reference history only" : `Near expiry · ${getExpirationStatus(instrument.expiration)!.days} days`}</span>}{(instrument.synthetic || instrument.meta?.demo) && <span className={`${styles.tag} ${styles.demo}`}>Demo data · synthetic</span>}</div>
    </li>)}</ul> : <div className={styles.empty}>No matching instruments. Try a ticker, company name, or supported futures root.</div>}
    {page.nextCursor && <p><Link href={`${basePath}?${new URLSearchParams({ ...(query ? { q: query } : {}), ...(assetClass ? { asset: assetClass } : {}), [cursorParam]: page.nextCursor }).toString()}`}>Load more results</Link></p>}
  </>;
}
