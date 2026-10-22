import { PerformancePanel } from "@/components/publications/PerformancePanel";
import { CommunityFeed } from "@/components/community/CommunityFeed";
import { CommunityCard } from "@/components/community/PublicationCard";
import { AuthorActions } from "@/components/community/CommunityActions";
import type { Performance as ReportedPerformance } from "@/lib/publications";
import type { Metadata } from "next";
import { notFound, permanentRedirect } from "next/navigation";
import Link from "next/link";
import { Avatar } from "@trading/ui";
import { publicMetadata, site } from "@/lib/site";
import { optionalApiFetch, publicApiFetch } from "@/lib/server-api";
import { classifyProfileLookupFailure } from "@/lib/public-profile-lookup";
import { profileTabEmptyState, publicProfileTab, PUBLIC_PROFILE_TABS } from "@/lib/public-profile-tabs";
import { ProfileShare } from "@/components/sharing/ShareMenu";
import type { CommunityRepostPage, Viewer } from "@/lib/community";
import styles from "../../community.module.css";
import communityStyles from "@/components/community/community.module.css";

type Performance = { closedCount: number; wins: number; losses: number; breakevens: number; unresolved: number; retrospective: number; incompleteCosts: number; winRate: number | null; reportedRealizedPnl: string; meanR: string | null; evidence: "member_reported" };
type Profile = { user: { id: string; handle: string; displayName: string; avatarUrl: string | null; pro: boolean }; bio: string; links: string[]; interests: string[]; joinedAt: string; followers: number; following: number; statistics: Performance; revision: number };
async function load(handle: string) {
  if (!/^[a-z0-9_]{3,30}$/.test(handle)) return { kind: "not-found" } as const;
  const result = await optionalApiFetch<Profile>(`/users/${encodeURIComponent(handle)}`);
  if (result.ok) return /^[a-z0-9_]{3,30}$/.test(result.data.user.handle) ? { kind: "found", profile: result.data } as const : { kind: "unavailable" } as const;
  return classifyProfileLookupFailure(result.response?.status, result.response?.headers.get("location") ?? null, handle);
}
export async function generateMetadata({ params }: { params: Promise<{ handle: string }> }): Promise<Metadata> {
  const { handle } = await params; const result = await load(handle);
  if (result.kind === "found") return publicMetadata(`/u/${result.profile.user.handle}`, `${result.profile.user.displayName} · Trading Community`, result.profile.bio || `Public profile for @${result.profile.user.handle}.`);
  if (result.kind === "canonical") return { alternates: { canonical: `/u/${result.handle}` }, robots: { index: false, follow: false } };
  return { robots: { index: false, follow: false } };
}
export default async function ProfilePage({ params, searchParams }: { params: Promise<{ handle: string }>; searchParams: Promise<{ tab?: string | string[]; asset?: string; strategy?: string; cursor?: string }> }) {
  const [{ handle }, query] = await Promise.all([params, searchParams]); const tab = publicProfileTab(query.tab); const result = await load(handle);
  if (result.kind === "canonical") permanentRedirect(`/u/${result.handle}`);
  if (result.kind === "not-found") notFound();
  if (result.kind === "unavailable") return <main id="main-content" tabIndex={-1} className={styles.page}><p className={styles.eyebrow}>PUBLIC PROFILE</p><h1>Profile temporarily unavailable</h1><section className={styles.notice}><p>We could not load this public profile right now. Try again shortly.</p></section></main>;
  const profile = result.profile;
  if (profile.user.handle !== handle) permanentRedirect(`/u/${profile.user.handle}`);
  const filters = new URLSearchParams();
  if (["stock", "option", "future"].includes(query.asset ?? "")) filters.set("asset", query.asset!);
  if (["long", "short", "long_call", "long_put", "bull_call_debit", "bear_put_debit", "bull_put_credit", "bear_call_credit"].includes(query.strategy ?? "")) filters.set("strategy", query.strategy!);
  const [performance, meResult, relationship, reposts] = await Promise.all([
    publicApiFetch<ReportedPerformance>(`/users/${handle}/performance?${filters}`),
    optionalApiFetch<{ user: Viewer; csrfToken: string }>("/me"),
    optionalApiFetch<{ following: boolean; muted: boolean }>(`/users/${encodeURIComponent(handle)}/relationship`),
    tab === "reposts" ? optionalApiFetch<CommunityRepostPage>(`/users/${encodeURIComponent(handle)}/reposts?${new URLSearchParams({ limit: "20", ...(query.cursor ? { cursor: query.cursor } : {}) })}`) : Promise.resolve(null),
  ]);
  const viewer: Viewer | null = meResult.ok ? { ...meResult.data.user, csrfToken: meResult.data.csrfToken } : null;
  const stats = performance.ok ? performance.data : profile.statistics;
  const emptyState = profileTabEmptyState(tab);
  return <main id="main-content" tabIndex={-1} className={styles.page}>
    <p className={styles.eyebrow}>PUBLIC PROFILE</p><section className={styles.card}>
      <div className={styles.byline}><Avatar name={profile.user.displayName} src={profile.user.avatarUrl} size="large" className={styles.profileAvatar}/><div><h1 className={styles.profileHeading}>{profile.user.displayName}</h1><span>@{profile.user.handle}{profile.user.pro ? " · Pro" : ""}</span></div></div>
      {profile.bio && <p>{profile.bio}</p>}
      <div className={styles.tags}>{profile.interests.map(tag => <span className={styles.tag} key={tag}>{tag}</span>)}</div>
      <div className={styles.metric}><strong>Member-reported activity</strong><span>{stats.closedCount} closed · {stats.wins} wins · {stats.losses} losses · {stats.breakevens} breakeven · {stats.unresolved} unresolved</span>{stats.winRate !== null && <span>Reported win rate: {(stats.winRate * 100).toFixed(1)}%</span>}<span>Reported values are not independently verified. {stats.incompleteCosts} report{stats.incompleteCosts === 1 ? " has" : "s have"} incomplete costs; {stats.retrospective} are retrospective.</span></div>
      <p>{profile.followers} followers · {profile.following} following · Joined {new Intl.DateTimeFormat("en", { month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(profile.joinedAt))}</p>
      {profile.links.map(url => <p key={url}><a href={url} rel="nofollow ugc noopener noreferrer">{url}</a></p>)}
      <div className={communityStyles.profileActions}><AuthorActions handle={handle} viewer={viewer} {...(relationship?.ok ? { initialFollowing: relationship.data.following, initialMuted: relationship.data.muted } : {})} profileId={profile.user.id}/><ProfileShare handle={handle} displayName={profile.user.displayName} canonicalUrl={new URL(`/u/${handle}`, site.url).href}/></div>
    </section>
    <form method="get" action={`/u/${handle}`}><input type="hidden" name="tab" value={tab}/><label>Reported outcomes by asset<select name="asset" defaultValue={query.asset ?? ""}><option value="">All assets</option><option value="stock">Stock</option><option value="option">Options</option><option value="future">Futures</option></select></label><label>Strategy<select name="strategy" defaultValue={query.strategy ?? ""}><option value="">All supported strategies</option>{["long", "short", "long_call", "long_put", "bull_call_debit", "bear_put_debit", "bull_put_credit", "bear_call_credit"].map(value => <option key={value}>{value}</option>)}</select></label><button>Filter reported results</button></form>
    {performance.ok ? <PerformancePanel performance={performance.data}/> : <p role="status">Reported performance is temporarily unavailable.</p>}
    <nav className={styles.tabs} aria-label="Public profile content">{PUBLIC_PROFILE_TABS.map(item => <Link key={item} href={`/u/${handle}?${new URLSearchParams({ tab: item, ...(query.asset ? { asset: query.asset } : {}), ...(query.strategy ? { strategy: query.strategy } : {}) })}`} aria-current={tab === item ? "page" : undefined}>{item.charAt(0).toUpperCase() + item.slice(1)}</Link>)}</nav>
    {tab === "ideas" && <CommunityFeed author={handle} filters={{ feed: "discover", ...(query.asset ? { asset: query.asset } : {}), ...(query.strategy ? { strategy: query.strategy } : {}), ...(query.cursor ? { cursor: query.cursor } : {}) }} basePath={`/u/${handle}`}/>}
    {tab === "reposts" && (reposts?.ok ? reposts.data.items.length ? <><section className={communityStyles.feed} aria-label={`Reposts by @${handle}`}>{reposts.data.items.map(repost => repost.publication ? <CommunityCard key={repost.id} item={{ ...repost.publication, repost: { id: repost.id, author: repost.author, commentary: repost.commentary, createdAt: repost.createdAt } }} viewer={viewer}/> : <article className={communityStyles.empty} key={repost.id}><h2>Original publication unavailable</h2><p>This repost no longer has a visible source publication.</p></article>)}</section>{reposts.data.nextCursor && <p><Link href={`/u/${handle}?${new URLSearchParams({ tab: "reposts", cursor: reposts.data.nextCursor })}`}>Load more reposts</Link></p>}</> : <section className={communityStyles.empty}><h2>No visible reposts</h2><p>This member has not shared a currently visible community publication.</p></section> : <section className={communityStyles.failure} role="alert"><h2>Reposts temporarily unavailable</h2><p>We could not load this profile’s reposts. Try again shortly.</p></section>)}
    {tab === "updates" && <section className={communityStyles.empty} aria-labelledby="profile-tab-heading"><h2 id="profile-tab-heading">{emptyState.heading}</h2><p>{emptyState.message}</p></section>}
  </main>;
}
