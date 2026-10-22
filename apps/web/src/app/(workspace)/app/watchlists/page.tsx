import { redirect } from "next/navigation";
import { apiFetch } from "@/lib/server-api";
import type { components } from "@trading/contracts";
import { PrivateFailure, WatchlistManager } from "../research/PrivateResearch";
import styles from "../research/private-research.module.css";
type WatchlistPage=components["schemas"]["WatchlistPage"];
type WatchlistWithInstruments=components["schemas"]["Watchlist"] & {instruments?:components["schemas"]["Instrument"][]};
type Instrument=components["schemas"]["Instrument"];
type Usage={plan:"free"|"pro";monthStart:string;nextMonthStart:string;journalEntriesThisMonth:number;journalMonthly:number;watchlists:number;watchlistItems:number;layouts:number;watchlistCount:number;layoutCount:number};
export default async function WatchlistsPage(){const[me,lists,usage]=await Promise.all([apiFetch<{csrfToken:string}>("/me"),apiFetch<WatchlistPage>("/watchlists?limit=50"),apiFetch<Usage>("/workspace-usage")]);if(!me.ok&&(me.reason==="missing-session"||me.response?.status===401))redirect("/login?returnTo=%2Fapp%2Fwatchlists");const knownInstruments:Instrument[]=lists.ok?(lists.data.items as readonly WatchlistWithInstruments[]).flatMap(item=>item.instruments??[]):[];return <div className={styles.page}><header className={styles.pageHeader}><div><p className={styles.kicker}>PRIVATE · YOUR ACCOUNT</p><h1>Watchlists</h1><p>Save supported instruments for quick reference. Your plan sets list and item limits.</p></div></header>{!me.ok||!lists.ok?<PrivateFailure title="Your watchlists are unavailable"/>:<WatchlistManager csrfToken={me.data.csrfToken} items={lists.data.items} usage={usage.ok?usage.data:null} knownInstruments={knownInstruments}/>}</div>;}
