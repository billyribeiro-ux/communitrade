import type { Metadata } from "next";
import { CommunityFeed } from "@/components/community/CommunityFeed";
import { publicMetadata } from "@/lib/site";
import { isLocalPreview } from "@/lib/preview";
import { Avatar } from "@trading/ui";
import Link from "next/link";
import styles from "../community.module.css";

export const metadata: Metadata = publicMetadata("/ideas", "Explore public ideas · Trading Community", "Search public stock, options, and futures research shared by the community.");

type Query = { feed?: string; q?: string; author?: string; asset?: string; instrumentId?: string; strategy?: string; status?: string; cursor?: string };
const localExamples = [
  { id: "idea-demo-01", slug: "spy-defined-risk-call-spread", symbol: "SPY", kind: "Options · Call debit spread", title: "Defined-risk SPY scenario into a scheduled catalyst", author: "Maya Chen", handle: "mayaresearch", initials: "MC", summary: "A hypothetical bullish scenario with a defined invalidation level. This synthetic example illustrates recording a thesis and its risks." },
  { id: "idea-demo-02", slug: "mes-levels-and-invalidation", symbol: "MES", kind: "Futures · Micro E-mini S&P 500", title: "Mapping MES levels without assuming a breakout", author: "Jordan Lee", handle: "jordanplans", initials: "JL", summary: "An educational example of documenting levels, uncertainty, and what would invalidate a scenario." },
  { id: "idea-demo-03", slug: "aapl-share-scenario-and-risk", symbol: "AAPL", kind: "Stocks · Shares", title: "AAPL scenario planning with a clear invalidation", author: "Alex Morgan", handle: "alexshares", initials: "AM", summary: "A hypothetical stock scenario emphasizing uncertainty, position sizing, and invalidation rather than a price prediction." },
];
export default async function IdeasPage({ searchParams }: { searchParams: Promise<Query> }) {
  const filters = await searchParams;
  return <main id="main-content" tabIndex={-1} className={styles.page}>
    <p className={styles.eyebrow}>PUBLIC RESEARCH</p>
    <h1>Explore ideas</h1>
    <p className={styles.lede}>Search public titles, theses, and author handles. Every result follows the publication’s current visibility and market-data rights.</p>
    <CommunityFeed filters={filters}/>
    {isLocalPreview() && <section aria-labelledby="synthetic-preview-heading"><h2 id="synthetic-preview-heading">Local design preview · synthetic examples</h2><p className={styles.lede}>These examples are fixed local fixtures, not live market data, member activity, or verified outcomes. They never fill an unavailable real feed.</p><div className={styles.grid}>{localExamples.map(idea => <article className={styles.card} key={idea.id}><div className={styles.byline}><Avatar name={idea.author} size="small"/><span><b>{idea.author}</b><br/>@{idea.handle} · Preview author</span></div><p className={styles.eyebrow}>{idea.symbol} · {idea.kind}</p><h2><Link href={`/ideas/${idea.id}/${idea.slug}`}>{idea.title}</Link></h2><p>{idea.summary}</p><span className={styles.tag}>Synthetic preview</span></article>)}</div></section>}
  </main>;
}
