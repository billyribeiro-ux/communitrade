import Link from "next/link";
import { redirect } from "next/navigation";
import { apiFetch } from "@/lib/server-api";
import type { components } from "@trading/contracts";
import { JournalListTools, PrivateFailure } from "../research/PrivateResearch";
import styles from "../research/private-research.module.css";

type JournalPage = components["schemas"]["JournalEntryPage"];
type Me = { csrfToken: string; user: { pro: boolean } };
type Usage = { plan: "free"|"pro"; monthStart: string; nextMonthStart: string; journalEntriesThisMonth: number; journalMonthly: number; watchlists: number; watchlistItems: number; layouts: number; watchlistCount: number; layoutCount: number };
type ExportJob = { id:string;kind:"personal_raw"|"journal_analytics";status:"pending"|"running"|"succeeded"|"failed"|"expired";createdAt:string;updatedAt:string;expiresAt:string|null;byteSize:number|null;failureCode:string|null;downloadUrl:string|null };
export default async function JournalPageView({searchParams}:{searchParams:Promise<{q?:string;tag?:string;asset?:string;cursor?:string}>}) {
  const query=await searchParams; const params=new URLSearchParams({limit:"20"}); for(const key of ["q","tag","asset","cursor"] as const) if(query[key]) params.set(key,query[key]!.slice(0,key==="cursor"?500:200));
  const [me,result,usage,jobs]=await Promise.all([apiFetch<Me>("/me"),apiFetch<JournalPage>(`/journal?${params}`),apiFetch<Usage>("/workspace-usage"),apiFetch<{items:ExportJob[]}>("/exports?limit=20")]);
  if(!me.ok&&(me.reason==="missing-session"||me.response?.status===401))redirect("/login?returnTo=%2Fapp%2Fjournal");
  return <div className={styles.page}><header className={styles.pageHeader}><div><p className={styles.kicker}>PRIVATE · ONLY YOU CAN SEE THESE NOTES</p><h1>Journal</h1><p>Keep private trade notes, tags and reviews. Linking a public idea never exposes your journal content.</p></div><Link href="/app/journal/new">Create entry</Link></header>
    {!result.ok||!me.ok?<PrivateFailure title="Your journal is unavailable"/>:<JournalListTools csrfToken={me.data.csrfToken} entries={result.data} {...(result.data.nextCursor?{nextCursor:result.data.nextCursor}:{})} query={query} usage={usage.ok?usage.data:null} jobs={jobs.ok?jobs.data.items:[]}/>}</div>;
}
