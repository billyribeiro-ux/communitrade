import Link from "next/link";
import type { Metadata } from "next";
import { cookies } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { AccountActions } from "../AccountActions";
import { savePlanIntent } from "../actions";
import { OnboardingForm } from "../AccountFlow";
import { apiFetch } from "@/lib/server-api";
import { parsePlanIntent, postOnboardingPath, readPlanIntent, safeReturnPath } from "@/lib/navigation";
import { policies } from "@/lib/policies";
import type { BillingSummary } from "@/lib/billing";
import { BillingEntry } from "../BillingEntry";
import { BillingReturnStatus } from "../BillingReturnStatus";
import styles from "./page.module.css";

const routes = {
  login: ["Sign in", "Return to your research workspace."],
  signup: ["Create your account", "Choose a public profile and keep your research in one place."],
  "auth/callback": ["Sign-in result", "Your session is established only after server-side identity validation."],
  "verify-email": ["Verify your email", "A verified email is required before you can participate."],
  "recover-account": ["Recover your account", "Account recovery is handled securely by the identity provider."],
  onboarding: ["Make the workspace yours", "Set up your public profile, interests, and display preferences."],
  subscribe: ["Choose your research workflow", "Free and Pro share the same public credibility standards."],
  "subscribe/return": ["Subscription status", "Paid access appears only after the server reconciles the payment provider event."],
  "account-unavailable": ["Account access unavailable", "This account cannot currently use the requested workspace."],
} as const;
type Route = keyof typeof routes;
type Props = { params: Promise<{ account?: string[] }>; searchParams: Promise<Record<string, string | string[] | undefined>> };
type Me = { user: { handle: string; displayName: string; pro: boolean }; emailVerified: boolean; onboarded: boolean; csrfToken: string };
export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const route = (await params).account?.join("/") as Route;
  return { title: routes[route]?.[0] ?? "Account", robots: { index: false, follow: false } };
}
function first(value: string | string[] | undefined): string | undefined { return Array.isArray(value) ? value[0] : value; }
function providerIntent(plan: "free" | "pro", interval: "month" | "year") { return plan === "free" ? "free" : interval === "year" ? "pro_annual" : "pro_monthly"; }

export default async function AccountPage({ params, searchParams }: Props) {
  const route = (await params).account?.join("/") as Route;
  if (!routes[route]) notFound();
  const [query, jar] = await Promise.all([searchParams, cookies()]);
  const stored = readPlanIntent(jar.get("tc_plan_intent")?.value);
  const transactionIntent = first(query.intent);
  const transactionPlan = transactionIntent === "pro_monthly" || transactionIntent === "pro_annual" ? "pro" : transactionIntent === "free" ? "free" : undefined;
  const transactionInterval = transactionIntent === "pro_annual" ? "year" : transactionIntent === "pro_monthly" ? "month" : undefined;
  const intent = parsePlanIntent({ plan: first(query.plan) ?? transactionPlan ?? stored?.plan, interval: first(query.interval) ?? transactionInterval ?? stored?.interval, returnTo: first(query.returnTo) ?? stored?.returnTo });
  const apiIntent = providerIntent(intent.plan, intent.interval);
  const afterOnboarding = postOnboardingPath(intent);
  const meResult = await apiFetch<Me>("/me");
  const me = meResult.ok ? meResult.data : undefined;
  if (route === "onboarding" && me?.onboarded) redirect(afterOnboarding);
  const subscription = route === "subscribe" && me ? await apiFetch<BillingSummary>("/billing/subscription") : null;
  const alreadyPro = me?.user.pro === true || (subscription?.ok && subscription.data.plan === "pro");
  if (route === "subscribe" && alreadyPro) redirect("/app/billing");
  if (route === "subscribe" && me && !me.emailVerified) redirect(`/verify-email?returnTo=${encodeURIComponent(`/subscribe?plan=${intent.plan}&interval=${intent.interval}`)}`);
  if (route === "subscribe" && me?.emailVerified && !me.onboarded) redirect(`/onboarding?intent=${apiIntent}&returnTo=${encodeURIComponent(`/subscribe?plan=${intent.plan}&interval=${intent.interval}`)}`);
  const [title, description] = routes[route];
  return <div className={styles.wrap}>
    <p className={styles.eyebrow}>Account · Secure identity</p><h1>{title}</h1><p className={styles.intro}>{description}</p>
    <div className={styles.grid}><section className={styles.card} aria-labelledby="account-action"><h2 id="account-action">{route === "onboarding" ? "Profile setup" : title}</h2>
      {route === "account-unavailable" ? <><div className={styles.notice} role="status">Your session may need verification or staff review. Sign in again or contact support if you believe this is an error.</div><AccountActions screen="login" returnTo="/app" intent={apiIntent}/><Link href="/contact">Contact support</Link></> : route === "onboarding" ? me ? me.emailVerified ? <><p>Signed in as {me.user.displayName} (@{me.user.handle}).</p><div className={styles.notice}>The linked policy text is an engineering draft and has no effective date or approval. Review it before accepting; final legal terms remain a launch gate.</div><ul>{policies.map(policy=><li key={policy.slug}><Link href={`/${policy.slug}`}>{policy.title}</Link> · {policy.version} · {policy.status}</li>)}</ul><OnboardingForm csrfToken={me.csrfToken} termsVersion={policies.find(policy => policy.slug === "terms")?.version ?? ""} nextPath={afterOnboarding} /></> : <><div className={styles.notice} role="status">Verify your email before completing setup. Return here after using the provider's verification email.</div><Link href={`/verify-email?returnTo=${encodeURIComponent(`/onboarding?intent=${apiIntent}&returnTo=${intent.returnTo}`)}`}>Continue to email verification</Link></> : <><div className={styles.notice} role="status">Sign in to continue onboarding. You will return here after the identity provider completes its checks.</div><AccountActions screen="login" returnTo="/onboarding" intent={apiIntent}/></> : route === "subscribe" ? <>
        <p>Your plan selection is {intent.interval === "year" ? "$290 per year" : "$29 per month"}, before applicable taxes. Review the current terms during account setup. Only reconciled provider state activates Pro.</p>
        {me ? subscription?.ok ? <BillingEntry csrfToken={me.csrfToken} termsVersion={policies.find(policy => policy.slug === "terms")?.version ?? ""} interval={intent.interval === "year" ? "annual" : "monthly"} verified={me.emailVerified} ready={me.onboarded}/> : <div className={styles.notice} role="alert">Billing status could not be checked. Refresh this page before starting checkout.</div> : <><p>Sign in or create an account to continue this selection.</p>{(["signup", "login"] as const).map(screen => <form action={savePlanIntent} key={screen}><input type="hidden" name="plan" value="pro"/><input type="hidden" name="interval" value={intent.interval}/><input type="hidden" name="returnTo" value="/subscribe"/><input type="hidden" name="screen" value={screen}/><button className={styles.button} type="submit">{screen === "signup" ? "Continue to secure registration" : "Continue to secure sign in"}</button></form>)}</>}
      </> : route === "subscribe/return" ? <>
        <BillingReturnStatus signedIn={Boolean(me)} initial={me ? await apiFetch<BillingSummary>("/billing/subscription").then(result => result.ok ? result.data : null) : null}/>
      </> : route === "auth/callback" ? <>
        <div className={styles.notice} role="status">No validated identity result is available for this page. The identity provider returns through the server callback.</div><Link href={`/login?returnTo=${encodeURIComponent(intent.returnTo)}`}>Return to sign in</Link>
      </> : route === "verify-email" ? <>
        {me ? <><p>Signed in as {me.emailVerified ? "a verified member" : "an unverified member"}.</p><AccountActions screen="login" verified={me.emailVerified} returnTo={me.onboarded ? "/app" : "/onboarding"} intent={apiIntent}/><a href="/api/v1/auth/account">Open identity provider account and verification options</a></> : <><p>Continue through the identity provider to finish or resend email verification.</p><AccountActions screen="login" returnTo="/verify-email" intent={apiIntent}/></>}
      </> : <>
        <AccountActions screen={route === "signup" ? "signup" : route === "recover-account" ? "recover" : "login"} returnTo={intent.returnTo} intent={apiIntent}/>
        {route === "signup" && <p>Creating an account does not collect a password on this site. The provider will send a verification message.</p>}
        {route === "recover-account" && <p>The provider gives the same recovery flow whether or not an account exists.</p>}
      </>}
      <div className={styles.links}><Link href={`/login?returnTo=${encodeURIComponent(intent.returnTo)}`}>Sign in</Link><Link href={`/signup?returnTo=${encodeURIComponent(intent.returnTo)}`}>Create account</Link><Link href="/recover-account">Recover access</Link></div>
    </section><aside className={styles.card}><h2>Your plan choice</h2><dl className={styles.summary}><dt>Plan</dt><dd>{intent.plan === "pro" ? "Pro" : "Free"}</dd><dt>Price</dt><dd>{intent.plan === "free" ? "$0" : intent.interval === "year" ? "$290 / year" : "$29 / month"}</dd><dt>After sign in</dt><dd>{safeReturnPath(intent.returnTo)}</dd></dl><p>A plan choice cannot grant paid benefits. Only reconciled billing data on your account determines access.</p><Link href="/pricing">Compare all limits</Link><p>Execution and outcomes are member-reported, without brokerage verification.</p></aside></div>
  </div>;
}
