import Link from "next/link";
import type {components} from "@trading/contracts";
import {apiFetch} from "@/lib/server-api";
import {CorrectionReview} from "@/components/publications/CorrectionReview";
import styles from "@/components/publications/Publication.module.css";
export default async function CorrectionsPage({searchParams}:{searchParams:Promise<{cursor?:string}>}){
 const query=await searchParams;const [queue,me]=await Promise.all([apiFetch<components["schemas"]["CorrectionRequestPage"]>(`/admin/corrections?${new URLSearchParams({limit:"50",...(query.cursor?{cursor:query.cursor}:{})})}`),apiFetch<{csrfToken:string;user:{id:string}}>("/me")]);
 return <main className={styles.page} id="main-content"><p className={styles.eyebrow}>STAFF · REVIEWED CORRECTIONS</p><h1>Correction review queue</h1><p>Compare proposals against immutable source evidence, record a specific reason, and preserve the original. Authors cannot approve their own corrections.</p>{!queue.ok||!me.ok?<p role="alert" className={styles.notice}>The queue is unavailable or recent staff verification is required. <a href="/api/v1/auth/step-up">Complete secure verification</a>, then reload.</p>:queue.data.items.length?<>{queue.data.items.map(request=><CorrectionReview key={request.id} request={request} csrfToken={me.data.csrfToken} reviewerId={me.data.user.id}/>)}{queue.data.nextCursor&&<Link href={`/admin/corrections?${new URLSearchParams({cursor:queue.data.nextCursor})}`}>More requests</Link>}</>:<p className={styles.notice}>No correction requests are waiting in this queue.</p>}</main>;
}
