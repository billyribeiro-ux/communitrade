import Link from "next/link";
import {WorkspaceOverview} from "@/components/publications/PublishedIdeas";
import { notFound, redirect } from "next/navigation";
import { apiFetch, publicApiFetch } from "@/lib/server-api";
import { ProfileSettings } from "../../workspace-ui/ProfileSettings";
import { PreferencesForm, SessionManager } from "../../workspace-ui/AccountSettings";
import styles from "../../workspace-ui/workspace.module.css";
import profileStyles from "../../workspace-ui/profile-settings.module.css";
import { instrumentFailure } from "@/lib/instruments";
import { searchMemberInstruments } from "@/lib/instrument-api";
import { InstrumentResults } from "../../../instrument-ui/InstrumentBrowser";
import instrumentStyles from "@/app/instruments.module.css";
import { CommunityFeed } from "@/components/community/CommunityFeed";
import { CommunityCard } from "@/components/community/PublicationCard";
import type { CommunityPage, Viewer } from "@/lib/community";
import communityStyles from "@/components/community/community.module.css";
import { DashboardResearchLinks } from "../research/PrivateResearch";
import { SavedPublicSearches } from "../../workspace-ui/SavedPublicSearches";
import { ApprovedReturnEvent } from "../../workspace-ui/ApprovedReturnEvent";
import { BillingPanel } from "../BillingPanel";
import type { BillingSummary } from "@/lib/billing";

type Props = { params: Promise<{ segments?: string[] }>; searchParams: Promise<{ updated?: string; q?: string; author?: string; asset?: string; cursor?: string; instrumentCursor?: string; feed?: string; instrumentId?: string; strategy?: string; status?: string }> };
type Me = { user: { id: string; handle: string; displayName: string; avatarUrl: string | null; pro: boolean }; csrfToken: string };
type Profile = { user: Me["user"]; bio: string; links: string[]; interests: string[]; revision: number };
type Preference = { theme?: "system" | "dark" | "light"; timezone?: string; digestEnabled?: boolean; digestHour?: 8; digestSuppressed?: boolean; quietFrom?: string; quietUntil?: string; publicationNotices?: boolean; replyNotices?: boolean; mentionNotices?: boolean; bookmarkNotices?: boolean; moderationNotices?: boolean; accountNotices?: boolean; billingNotices?: boolean; analyticsConsent?: boolean; analyticsConsentVersion?: string | null };
type Session = { id: string; createdAt: string; lastSeenAt: string; current: boolean; expiresAt: string };
type SessionPage = { items: Session[]; nextCursor: string | null };

const titles: Record<string, string> = { home: "Dashboard", feed: "Feed", explore: "Explore", publish: "Publish an idea", drafts: "Drafts", journal: "Journal", watchlists: "Watchlists", bookmarks: "Bookmarks", layouts: "Saved layouts", notifications: "Notifications", profile: "Profile", billing: "Plan and billing", settings: "Settings", "settings/security": "Security settings", "settings/preferences": "Preferences", "settings/privacy": "Privacy settings" };
function EmptyWorkspace({ title }: { title: string }) { return <section className={styles.card}><h2>{title}</h2><p>This signed-in workspace is ready for your account. There are no private records to show yet.</p><p>Private member workflows will appear here when connected services return authorized data.</p></section>; }
function ApiUnavailable() { return <section className={styles.card} role="status"><h2>Account data unavailable</h2><p>The account service did not return this data. Refresh to try again. Nothing has been changed.</p></section>; }

export default async function WorkspacePage({ params, searchParams }: Props) {
  const [{ segments }, query] = await Promise.all([params, searchParams]);
  const key = segments?.join("/") || "home";
  if (!titles[key] && key !== "journal/new" && key !== "journal/analytics") notFound();
  const meResult = await apiFetch<Me>("/me");
  if (!meResult.ok) { if (meResult.response?.status === 401) redirect(`/login?returnTo=${encodeURIComponent(`/app${segments?.length ? `/${segments.join("/")}` : ""}`)}`); return <ApiUnavailable/>; }
  const me = meResult.data;
  const viewer: Viewer = { ...me.user, csrfToken: me.csrfToken };
  if (key === "feed") {
    return <div className={styles.main}><p className={styles.eyebrow}>MEMBER COMMUNITY</p><h1>Feed</h1><p className={styles.intro}>Following activity reflects the authors and instruments you follow. Mutes hide their feed items and nonessential notifications.</p><CommunityFeed filters={{ ...query, feed: query.feed ?? "following" }} basePath="/app/feed" workspace/></div>;
  }
  if (key === "explore") {
    const q = query.q?.slice(0, 100) ?? "";
    const assetClass = ["stock", "option", "future"].includes(query.asset ?? "") ? query.asset! : "";
    const results = await searchMemberInstruments(q, assetClass, query.instrumentCursor ?? "");
    return <div className={styles.main}><p className={styles.eyebrow}>MEMBER EXPLORE</p><h1>Search community and instruments</h1><p className={styles.intro}>Search public ideas, titles, thesis text, and author handles, or find supported reference instruments and licensed option contracts.</p>
      <h2>Public ideas</h2><CommunityFeed filters={{ ...query, feed: query.feed ?? "discover" }} basePath="/app/explore" workspace/>
      <h2>Instrument lookup</h2>
      <form action="/app/explore" className={instrumentStyles.search} method="get"><label>Symbol or name<input autoComplete="off" maxLength={100} name="q" placeholder="Try SPY or ES" defaultValue={q}/></label><label>Asset class<select name="asset" defaultValue={assetClass}><option value="">All supported assets</option><option value="stock">Stocks</option><option value="option">Options</option><option value="future">Futures</option></select></label><button type="submit">Search instruments</button></form>
      {results.ok ? <InstrumentResults page={results.data} query={q} assetClass={assetClass} basePath="/app/explore" cursorParam="instrumentCursor"/> : <section className={styles.card} role="alert"><h2>{instrumentFailure(results.response?.status, "Member catalog").title}</h2><p>{instrumentFailure(results.response?.status, "Member catalog").message}</p></section>}
      <p><Link href="/instruments">Open the public instrument reference</Link></p></div>;
  }
  if (key === "profile") {
    const result = await publicApiFetch<Profile>(`/users/${encodeURIComponent(me.user.handle)}`);
    if (!result.ok) { if (result.response?.status === 401) redirect("/login?returnTo=%2Fapp%2Fprofile"); return <ApiUnavailable/>; }
    const etag = result.response.headers.get("etag") ?? `"${result.data.revision}"`;
    return <div className={styles.main}><p className={styles.eyebrow}>YOUR PUBLIC PROFILE</p><h1>Profile</h1>{query.updated === "1" && <p role="status" className={profileStyles.success}>Profile saved.</p>}<ProfileSettings profile={result.data} csrfToken={me.csrfToken} etag={etag}/></div>;
  }
  if (key === "settings/security") {
    const [sessions, account] = await Promise.all([apiFetch<SessionPage>("/me/sessions?limit=50"), Promise.resolve(me)]);
    if (!sessions.ok && sessions.response?.status === 401) redirect("/login?returnTo=%2Fapp%2Fsettings%2Fsecurity");
    return <div className={styles.main}><p className={styles.eyebrow}>PRIVATE ACCOUNT</p><h1>Security settings</h1><div className={profileStyles.columns}><section className={profileStyles.card}><h2>Identity provider</h2><p>Passwords, recovery, and multi-factor authentication stay with the identity provider.</p><p><a href="/api/v1/auth/account">Manage sign-in and verification</a></p><p>Account changes that need fresh authentication use an identity provider step-up.</p><p><a href="/api/v1/auth/step-up">Verify identity for a sensitive change</a></p></section>{sessions.ok ? <SessionManager csrfToken={account.csrfToken} sessions={sessions.data.items}/> : <ApiUnavailable/>}</div></div>;
  }
  if (key === "settings/preferences") {
    const [result, searches] = await Promise.all([apiFetch<Preference>("/me/preferences"), apiFetch<{ items: Array<{ id: string; name: string; filters: Record<string, string>; revision: number; createdAt: string; updatedAt: string }> }>("/me/saved-searches")]);
    if (!result.ok && result.response?.status === 401) redirect("/login?returnTo=%2Fapp%2Fsettings%2Fpreferences");
    return <div className={styles.main}><p className={styles.eyebrow}>PRIVATE ACCOUNT</p><h1>Preferences</h1>{result.ok ? <><PreferencesForm csrfToken={me.csrfToken} initial={result.data}/>{searches.ok ? <SavedPublicSearches csrfToken={me.csrfToken} initial={searches.data} pro={me.user.pro}/> : <ApiUnavailable/>}</> : <ApiUnavailable/>}</div>;
  }
  if (key === "bookmarks") {
    const params = new URLSearchParams({ limit: "20", ...(query.cursor ? { cursor: query.cursor } : {}) });
    const result = await apiFetch<CommunityPage>(`/me/bookmarks?${params}`);
    if (!result.ok) return <div className={styles.main}><p className={styles.eyebrow}>PRIVATE COMMUNITY</p><h1>Saved ideas</h1><ApiUnavailable/></div>;
    return <div className={styles.main}><p className={styles.eyebrow}>PRIVATE COMMUNITY</p><h1>Saved ideas</h1><p className={styles.intro}>Bookmarks follow the source publication’s current visibility and access rights. A hidden or restricted source is unavailable here too.</p>{result.data.items.length ? <><div className={communityStyles.feed}>{result.data.items.map(item => <CommunityCard key={item.id} item={item} viewer={viewer}/>)}</div>{result.data.nextCursor && <p><Link href={`/app/bookmarks?cursor=${encodeURIComponent(result.data.nextCursor)}`}>Load more saved ideas</Link></p>}</> : <section className={styles.card}><h2>No saved ideas yet</h2><p>Save a public idea from its card to keep it in this private list.</p><Link href="/ideas">Explore public ideas</Link></section>}</div>;
  }
  if (key === "settings") { const items = [["Security", "/app/settings/security"], ["Preferences", "/app/settings/preferences"], ["Privacy and data", "/app/settings/privacy"]] as const; return <div className={styles.main}><p className={styles.eyebrow}>PRIVATE ACCOUNT</p><h1>Settings</h1><div className={styles.grid}>{items.map(([label, href]) => <section className={styles.card} key={href}><h2><Link href={href}>{label}</Link></h2><p>Account information is available only after your session and role are validated by the server.</p></section>)}</div></div>; }
  if (key === "billing") {
    const billing = await apiFetch<BillingSummary>("/billing/subscription");
    if (!billing.ok) {
      if (billing.response?.status === 401) redirect("/login?returnTo=%2Fapp%2Fbilling");
      return <div className={styles.main}><p className={styles.eyebrow}>PRIVATE · BILLING</p><h1>Plan and billing</h1><section className={styles.card} role="alert"><h2>Billing status unavailable</h2><p>Your current plan and invoices could not be loaded. No billing change was made.</p><Link href="/app/billing">Retry billing status</Link></section></div>;
    }
    const appOrigin = new URL(process.env.APP_ORIGIN ?? "http://localhost:3000").origin;
    return <div className={styles.main}><p className={styles.eyebrow}>PRIVATE · ACCOUNT BILLING</p><h1>Plan and billing</h1><p className={styles.intro}>Manage your subscription, review account usage, and open invoices. Public publications remain accessible under their visibility rules.</p><BillingPanel initial={billing.data} csrfToken={me.csrfToken} appOrigin={appOrigin}/></div>;
  }
  const title = titles[key] ?? (key === "journal/new" ? "New journal entry" : key === "journal/analytics" ? "Journal analytics" : key);
  if (key === "home") {
    const [notifications, preferences] = await Promise.all([apiFetch<{ unreadCount: number }>("/notifications?limit=1"), apiFetch<{ analyticsConsent?: boolean; analyticsConsentVersion?: string | null }>("/me/preferences")]);
    return <div className={styles.main}>{preferences.ok && <ApprovedReturnEvent csrfToken={me.csrfToken} analyticsConsent={preferences.data.analyticsConsent === true} consentVersion={preferences.data.analyticsConsentVersion ?? null}/>}<p className={styles.eyebrow}>PRIVATE · YOUR ACCOUNT</p><h1>{title}</h1><section className={styles.card}><h2>Welcome, {me.user.displayName}</h2><p>Your account is ready. Public profile: <Link href={`/u/${me.user.handle}`}>@{me.user.handle}</Link>.</p><WorkspaceOverview handle={me.user.handle}/></section>{notifications.ok && <section className={styles.card}><h2>Notifications</h2><p>{notifications.data.unreadCount === 0 ? "You’re all caught up." : `${notifications.data.unreadCount} unread update${notifications.data.unreadCount === 1 ? "" : "s"}.`}</p><Link href="/app/notifications">Open notification center</Link></section>}<DashboardResearchLinks/></div>;
  }
  return <div className={styles.main}><p className={styles.eyebrow}>PRIVATE · YOUR ACCOUNT</p><h1>{title}</h1><EmptyWorkspace title={title}/></div>;
}
