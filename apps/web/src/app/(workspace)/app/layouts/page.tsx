import { redirect } from "next/navigation";
import { apiFetch } from "@/lib/server-api";
import type { components } from "@trading/contracts";
import { LayoutManager, PrivateFailure } from "../research/PrivateResearch";
import styles from "../research/private-research.module.css";
type LayoutPage=components["schemas"]["LayoutPage"];
type Usage={plan:"free"|"pro";monthStart:string;nextMonthStart:string;journalEntriesThisMonth:number;journalMonthly:number;watchlists:number;watchlistItems:number;layouts:number;watchlistCount:number;layoutCount:number};
export default async function LayoutsPage(){const[me,layouts,usage]=await Promise.all([apiFetch<{csrfToken:string}>("/me"),apiFetch<LayoutPage>("/layouts?limit=50"),apiFetch<Usage>("/workspace-usage")]);if(!me.ok&&(me.reason==="missing-session"||me.response?.status===401))redirect("/login?returnTo=%2Fapp%2Flayouts");return <div className={styles.page}><header className={styles.pageHeader}><div><p className={styles.kicker}>PRIVATE · CHART TEMPLATES</p><h1>Saved layouts</h1><p>Save chart settings and drawings as a private template. Each template belongs to your account.</p></div></header>{!me.ok||!layouts.ok?<PrivateFailure title="Your saved layouts are unavailable"/>:<LayoutManager csrfToken={me.data.csrfToken} items={layouts.data.items} usage={usage.ok?usage.data:null}/>}</div>;}
