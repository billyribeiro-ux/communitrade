import Link from "next/link";
import type { components } from "@trading/contracts";
import { apiFetch, optionalApiFetch } from "@/lib/server-api";
import type { CommunityPage, CommunityPublication, Viewer } from "@/lib/community";
import { CommunityCard } from "./PublicationCard";
import styles from "./community.module.css";

type Feed = "discover" | "following" | "editorial";
type Filters = { feed?: string; q?: string; author?: string; asset?: string; instrumentId?: string; strategy?: string; status?: string; cursor?: string };
type Me = { user: { id: string; handle: string; displayName: string; avatarUrl: string | null; pro?: boolean }; csrfToken: string };
const feeds: Feed[] = ["discover", "following", "editorial"];
const assets = ["stock", "option", "future"];
const strategies = ["long", "short", "long_call", "long_put", "bull_call_debit", "bear_put_debit", "bull_put_credit", "bear_call_credit"];
const states = ["pending", "entered", "partially_closed", "closed", "unresolved", "canceled", "never_entered"];

export async function CommunityFeed({ filters = {}, basePath = "/ideas", workspace = false, author }: { filters?: Filters; basePath?: string; workspace?: boolean; author?: string }) {
  const requestedFeed = feeds.includes(filters.feed as Feed) ? filters.feed as Feed : "discover";
  const authorFilter = author ?? (/^[a-z0-9_]{3,30}$/i.test(filters.author ?? "") ? filters.author : undefined);
  const validFilters = {
    feed: requestedFeed,
    sort: "newest",
    q: filters.q?.slice(0, 200),
    asset: assets.includes(filters.asset ?? "") ? filters.asset : undefined,
    instrumentId: /^[0-9a-f-]{36}$/i.test(filters.instrumentId ?? "") ? filters.instrumentId : undefined,
    strategy: strategies.includes(filters.strategy ?? "") ? filters.strategy : undefined,
    status: states.includes(filters.status ?? "") ? filters.status : undefined,
    cursor: filters.cursor?.slice(0, 500),
    author: authorFilter,
    limit: "20",
  };
  const params = new URLSearchParams(Object.entries(validFilters).filter(([, value]) => Boolean(value)) as [string, string][]);
  const [meResult, pageResult, instrumentResult] = await Promise.all([
    workspace ? apiFetch<Me>("/me") : optionalApiFetch<Me>("/me"),
    optionalApiFetch<CommunityPage>(`/publications?${params}`),
    optionalApiFetch<components["schemas"]["InstrumentPage"]>("/instruments?limit=50"),
  ]);
  const viewer: Viewer | null = meResult.ok ? { ...meResult.data.user, csrfToken: meResult.data.csrfToken } : null;
  const queryFilters = { q: filters.q?.slice(0,200), author: authorFilter, asset: validFilters.asset, instrumentId: validFilters.instrumentId, strategy: validFilters.strategy, status: validFilters.status };
  const hrefForFeed = (feed: Feed) => {
    const next = new URLSearchParams(Object.entries({ ...queryFilters, feed }).filter(([, value]) => Boolean(value)) as [string, string][]);
    return `${basePath}?${next}`;
  };
  const activeFeed = requestedFeed;
  const responseStatus = pageResult.ok ? undefined : pageResult.response?.status;
  const failureHeading = responseStatus === 400 ? "These filters could not be applied" : responseStatus === 404 && validFilters.instrumentId ? "Instrument unavailable" : responseStatus === 429 ? "Search temporarily limited" : "Ideas could not be loaded";
  const failureText = responseStatus === 400 ? "One of the search filters or this page cursor is no longer valid. Clear a filter or restart from the first page." : responseStatus === 404 && validFilters.instrumentId ? "This instrument is no longer available for public idea search. Clear the instrument filter to continue." : responseStatus === 429 ? "The search service is handling too many requests. Wait briefly, then try again." : activeFeed === "following" && responseStatus === 401 ? "Sign in with a verified account to load your Following feed." : "The public community service is unavailable. Try again shortly.";
  return <>
    {!author&&<nav className={styles.tabs} aria-label="Idea feed"><Link href={hrefForFeed("discover")} aria-current={activeFeed === "discover" ? "page" : undefined}>Discover</Link><Link href={hrefForFeed("following")} aria-current={activeFeed === "following" ? "page" : undefined}>Following</Link><Link href={hrefForFeed("editorial")} aria-current={activeFeed === "editorial" ? "page" : undefined}>Editorial</Link></nav>}
    <form method="get" action={basePath} role="search" aria-label="Search public ideas" className={styles.filterRow}>
      <input type="hidden" name="feed" value={activeFeed}/>
      <input type="hidden" name="sort" value="newest"/>
      <label>Search ideas, thesis, authors<input name="q" maxLength={200} defaultValue={filters.q} placeholder="Try a title, thesis, or handle"/></label>
      {author ? <input type="hidden" name="author" value={author}/> : <label>Author handle<input name="author" maxLength={30} pattern="[A-Za-z0-9_]{3,30}" defaultValue={filters.author?.slice(0,30)} placeholder="e.g. marketreader"/></label>}
      <label>Asset<select name="asset" defaultValue={validFilters.asset ?? ""}><option value="">All assets</option><option value="stock">Stocks</option><option value="option">Options</option><option value="future">Futures</option></select></label>
      <label>Instrument<select name="instrumentId" defaultValue={validFilters.instrumentId ?? ""}><option value="">All instruments</option>{instrumentResult.ok && instrumentResult.data.items.map(instrument => <option key={instrument.id} value={instrument.id}>{instrument.symbol}{instrument.contractMonth ? ` · ${instrument.contractMonth}` : ""}</option>)}</select></label>
      <label>Strategy<select name="strategy" defaultValue={validFilters.strategy ?? ""}><option value="">All strategies</option>{strategies.map(value => <option key={value} value={value}>{value.replaceAll("_", " ")}</option>)}</select></label>
      <label>Status<select name="status" defaultValue={validFilters.status ?? ""}><option value="">All statuses</option>{states.map(value => <option key={value} value={value}>{value.replaceAll("_", " ")}</option>)}</select></label>
      <button type="submit">Apply filters</button>
    </form>
    {!instrumentResult.ok && <p className={styles.meta} role="status">The instrument filter list is temporarily unavailable. Other filters and public idea search remain available.</p>}
    {!pageResult.ok ? <section className={styles.failure} role="alert"><h2>{failureHeading}</h2><p>{failureText}</p>{activeFeed === "following" && responseStatus === 401 && <Link href={`/login?returnTo=${encodeURIComponent(`${basePath}?feed=following`)}`}>Sign in</Link>}</section> : pageResult.data.items.length === 0 ? <section className={styles.empty}><h2>{filters.q || authorFilter ? "No matching ideas" : activeFeed === "following" ? "Your Following feed is empty" : activeFeed === "editorial" ? "No editorial collection is available" : "No public ideas are available yet"}</h2><p>{filters.q || authorFilter ? "Try a shorter query or adjust the filters." : activeFeed === "following" ? "Follow authors or instruments to see their public ideas here." : activeFeed === "editorial" ? "Editorial items appear here when the collection has eligible content." : "Completed public publications will appear here when they are available."}</p></section> : <section className={styles.feed} aria-label="Public ideas">{pageResult.data.items.map((item: CommunityPublication) => <CommunityCard key={`${item.id}:${item.repost?.id ?? "original"}`} item={item} viewer={viewer} />)}</section>}
    {pageResult.ok && pageResult.data.nextCursor && <div className={styles.pagination}><Link className={styles.loadMore} href={`${basePath}?${new URLSearchParams(Object.entries({ ...queryFilters, feed: activeFeed, cursor: pageResult.data.nextCursor }).filter(([, value]) => Boolean(value)) as [string, string][])}`}>Load more ideas</Link></div>}
  </>;
}
