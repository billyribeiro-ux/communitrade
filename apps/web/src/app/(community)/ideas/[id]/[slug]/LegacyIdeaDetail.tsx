import { notFound, redirect } from "next/navigation";
import Link from "next/link";
import { publicMetadata } from "@/lib/site";
import { isLocalPreview } from "@/lib/preview";
import { Avatar } from "@trading/ui";
import styles from "../../../community.module.css";

const records = {
  "idea-demo-01": { slug:"spy-defined-risk-call-spread", symbol:"SPY", title:"Defined-risk SPY scenario into a scheduled catalyst", author:"Maya Chen", handle:"mayaresearch", initials:"MC", strategy:"Call debit spread · synthetic example", thesis:"This hypothetical scenario describes a bullish thesis while making room for uncertainty. The position and levels below are educational placeholders, not an actionable recommendation.", entry:"Illustrative debit: $2.10", target:"Illustrative review level: $3.20", invalidation:"Illustrative invalidation: $1.35", updated:"Preview publication · no real timestamp", authorBio:"Researching defined-risk options scenarios and documenting uncertainty.", reported:"1 of 3 entries reported · unresolved excluded", replies:[["KT","Kai T.","How are you thinking about the risk around the scheduled event?","Preview reply · 3 hours ago"],["MC","Maya Chen","The example treats the full debit as risk and leaves the outcome open.","Preview author reply · 2 hours ago"]] },
  "idea-demo-02": { slug:"mes-levels-and-invalidation", symbol:"MES", title:"Mapping MES levels without assuming a breakout", author:"Jordan Lee", handle:"jordanplans", initials:"JL", strategy:"Futures · educational example", thesis:"An educational example of documenting a market scenario and the conditions that would invalidate it. This page contains no live quote or execution report.", entry:"Scenario: observe above a hypothetical range", target:"No target reported", invalidation:"Reassess if the scenario fails", updated:"Preview publication · no real timestamp", authorBio:"Educational notes on futures levels, invalidation, and process.", reported:"2 of 4 entries reported · unresolved excluded", replies:[["RK","Riley K.","As an educational scenario, what would invalidate this level?","Preview reply · 1 day ago"],["JL","Jordan Lee","A sustained move back through the marked range would prompt a review.","Preview author reply · 20 hours ago"]] },
  "idea-demo-03": { slug:"aapl-share-scenario-and-risk", symbol:"AAPL", title:"AAPL scenario planning with a clear invalidation", author:"Alex Morgan", handle:"alexshares", initials:"AM", strategy:"Stocks · shares · synthetic example", thesis:"A hypothetical stock scenario emphasizing uncertainty, position sizing, and invalidation rather than a price prediction.", entry:"Illustrative planning level: $218", target:"No target reported", invalidation:"Reassess below a hypothetical support zone", updated:"Preview publication · no real timestamp", authorBio:"Writing about process and risk context for stock scenarios.", reported:"1 of 3 entries reported · unresolved excluded", replies:[["AM","Alex Morgan","This is a planning example, not a forecast or execution claim.","Preview author note · 2 days ago"]] }
} as const;
export async function generateMetadata({ params }: { params: Promise<{ id: string }> }) { if(!isLocalPreview()) return {robots:{index:false,follow:false}}; const {id}=await params; const record=records[id as keyof typeof records]; return record ? { ...publicMetadata(`/ideas/${id}/${record.slug}`, `${record.title} · Trading Community`, `${record.strategy}. Synthetic preview publication.`), robots: { index: false, follow: false } } : {}; }
export default async function IdeaDetail({params}:{params:Promise<{id:string;slug:string}>}) {
  if(!isLocalPreview()) notFound();
  const {id,slug}=await params; const idea=records[id as keyof typeof records];
  if (!idea) notFound(); if (slug!==idea.slug) redirect(`/ideas/${id}/${idea.slug}`);
  return <main id="main-content" tabIndex={-1} className={`${styles.page} ${styles.narrow}`}>
    <p className={styles.eyebrow}>PUBLICATION · SYNTHETIC PREVIEW</p>
    <div className={styles.byline}><Avatar name={idea.author} size="medium"/><span><b>{idea.author}</b> · <Link href={`/u/${idea.handle}`}>@{idea.handle}</Link><br />{idea.updated} · Member-reported, unverified</span></div>
    <h1>{idea.title}</h1><p className={styles.lede}>{idea.symbol} · {idea.strategy}</p>
    <div className={styles.notice}><div><h2>Preview and risk note</h2><p>All values and chart artwork on this page are synthetic. Market data is not connected. Members execute trades separately; reported execution prices and results are not verified.</p></div></div>
    <div className={styles.twoCol}>
      <section>
        <div className={styles.chart}><strong>Static illustrative snapshot · not market data</strong><svg viewBox="0 0 720 200" role="img" aria-label="Static synthetic chart illustration"><path d="M0 40H720M0 90H720M0 140H720M0 190H720"/><polyline points="0,165 75,138 150,151 220,102 290,125 360,66 430,87 500,52 570,68 640,29 720,47"/></svg></div>
        <section className={styles.card}><h2>Thesis and plan</h2><p>{idea.thesis}</p><dl><dt>Entry</dt><dd>{idea.entry}</dd><dt>Target</dt><dd>{idea.target}</dd><dt>Invalidation</dt><dd>{idea.invalidation}</dd></dl></section>
        <section className={styles.card}><h2>Discussion · synthetic preview</h2><p>These sample replies are fixed design fixtures, not real member activity or a writable discussion.</p>{idea.replies.map(([_initials,name,text,time],index)=><article className={styles.reply} key={`${name}-${time}`}><div className={styles.byline}><Avatar name={name} size="small"/><span><b>{name}</b> · {time}{index>0&&<span> · Reply</span>}</span></div><p>{text}</p></article>)}</section>
      </section>
      <aside className={styles.card}><h2>Author · synthetic preview</h2><div className={styles.byline}><Avatar name={idea.author} size="medium"/><span><b><Link href={`/u/${idea.handle}`}>{idea.author}</Link></b><br />@{idea.handle}</span></div><p>{idea.authorBio}</p><div className={styles.metric}><b>Reported examples</b><span>{idea.reported}</span></div><p>No verified performance evidence. Pro membership does not affect public credibility.</p></aside>
    </div>
    <div className={styles.actions}><p>Local synthetic example · read-only. Sharing, reporting, bookmarking, and reactions are available on real public publications.</p></div>
  </main>;
}
