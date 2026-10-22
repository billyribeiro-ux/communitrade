import type { Metadata } from "next";
import { publicMetadata } from "@/lib/site";
import { instrumentFailure } from "@/lib/instruments";
import { searchInstruments } from "@/lib/instrument-api";
import { InstrumentResults } from "../../instrument-ui/InstrumentBrowser";
import styles from "../../instruments.module.css";

export const metadata: Metadata = publicMetadata("/instruments", "Instrument reference", "Look up supported stocks, options, and listed futures with data source, freshness, and permitted-use status.");
type Props = { searchParams: Promise<{ q?: string; asset?: string; cursor?: string }> };
export default async function InstrumentsPage({ searchParams }: Props) {
  const query = await searchParams;
  const q = query.q?.slice(0, 100) ?? "";
  const assetClass = ["stock", "option", "future"].includes(query.asset ?? "") ? query.asset! : "";
  const result = await searchInstruments(q, assetClass, query.cursor ?? "");
  return <div className={styles.page}><p className={styles.eyebrow}>PUBLIC REFERENCE</p><h1>Instrument lookup</h1><p className={styles.intro}>Search the supported catalog. This is a reference lookup, not a scanner or a recommendation. Price data access depends on the supplier’s current license and display permissions.</p>
    <form action="/instruments" className={styles.search} method="get"><label>Symbol or name<input autoComplete="off" maxLength={100} name="q" placeholder="Try SPY or ES" defaultValue={q}/></label><label>Asset class<select name="asset" defaultValue={assetClass}><option value="">All supported assets</option><option value="stock">Stocks</option><option value="option">Options</option><option value="future">Futures</option></select></label><button type="submit">Search catalog</button></form>
    {result.ok ? <InstrumentResults page={result.data} query={q} assetClass={assetClass}/> : <div className={`${styles.notice} ${styles.warning}`} role="alert"><strong>{instrumentFailure(result.response?.status, "Public catalog").title}.</strong> {instrumentFailure(result.response?.status, "Public catalog").message}</div>}
    <p className={styles.intro}>Supported options are standard, unadjusted equity and ETF contracts. Futures are limited to actual ES, MES, NQ, and MNQ contract months.</p>
  </div>;
}
