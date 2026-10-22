import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { apiFetch } from "@/lib/server-api";
import { BillingDemoPanel, type BillingDemoSession } from "@/app/BillingDemoPanel";
import { AppUnavailable } from "@/app/billing-unavailable";

export const metadata: Metadata = { title: "Demo checkout · Trading Community", robots: { index: false, follow: false } };
type Me = { emailVerified: boolean; onboarded: boolean; csrfToken: string };
export default async function DemoCheckoutPage({ searchParams }: { searchParams: Promise<{ session?: string }> }) {
  const { session } = await searchParams;
  if (!session || session.length > 200) notFound();
  const me = await apiFetch<Me>("/me");
  if (!me.ok) { if (me.reason === "missing-session" || me.response?.status === 401) redirect(`/login?returnTo=${encodeURIComponent(`/subscribe/demo?session=${session}`)}`); return <AppUnavailable title="Demo checkout unavailable"/>; }
  if (!me.data.emailVerified) redirect(`/verify-email?returnTo=${encodeURIComponent(`/subscribe/demo?session=${session}`)}`);
  if (!me.data.onboarded) redirect("/onboarding?intent=pro_monthly&returnTo=%2Fsubscribe%2Freturn");
  const result = await apiFetch<BillingDemoSession>(`/billing/demo/${encodeURIComponent(session)}`);
  if (!result.ok) { if (result.response?.status === 404 || result.response?.status === 403) notFound(); return <AppUnavailable title="Demo checkout status unavailable"/>; }
  if (result.data.kind !== "checkout") notFound();
  return <BillingDemoPanel csrfToken={me.data.csrfToken} session={result.data}/>;
}
