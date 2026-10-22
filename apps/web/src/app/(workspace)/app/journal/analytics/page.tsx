import { redirect } from "next/navigation";
import { apiFetch } from "@/lib/server-api";
import type { components } from "@trading/contracts";
import { AnalyticsPanel, PrivateFailure } from "../../research/PrivateResearch";
import styles from "../../research/private-research.module.css";
type Performance=components["schemas"]["Performance"];
export default async function JournalAnalyticsPage(){const[me,analytics]=await Promise.all([apiFetch<{csrfToken:string;user:{pro:boolean}}>("/me"),apiFetch<Performance>("/journal-analytics")]);if(!me.ok&&(me.reason==="missing-session"||me.response?.status===401))redirect("/login?returnTo=%2Fapp%2Fjournal%2Fanalytics");return <div className={styles.page}><header className={styles.pageHeader}><div><p className={styles.kicker}>PRIVATE · MEMBER REPORTED</p><h1>Journal analytics</h1><p>Review reported trade outcomes using eligible records, realized results and cost coverage.</p></div></header>{!me.ok||!analytics.ok?<PrivateFailure title={analytics.response?.status===403?"Pro analytics are locked":"Journal analytics are unavailable"}/>:<AnalyticsPanel csrfToken={me.data.csrfToken} data={analytics.data as unknown as Record<string,unknown>} plan={me.data.user.pro?"pro":"free"}/>}</div>;}
