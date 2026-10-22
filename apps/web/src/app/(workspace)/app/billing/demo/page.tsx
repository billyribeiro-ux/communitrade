import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { apiFetch } from "@/lib/server-api";
import { BillingDemoPanel, type BillingDemoSession } from "@/app/BillingDemoPanel";
import { AppUnavailable } from "@/app/billing-unavailable";

export const metadata: Metadata = { title: "Demo billing portal · Trading Community", robots: { index: false, follow: false } };
type Me = { emailVerified: boolean; onboarded: boolean; csrfToken: string };
export default async function DemoBillingPortalPage({ searchParams }: { searchParams: Promise<{ session?: string }> }) {
  const { session } = await searchParams;
  if (!session || session.length > 200) notFound();
  const me = await apiFetch<Me>("/me");
  if (!me.ok) { if (me.reason === "missing-session" || me.response?.status === 401) redirect(`/login?returnTo=${encodeURIComponent(`/app/billing/demo?session=${session}`)}`); return <AppUnavailable title="Demo billing unavailable"/>; }
  const result = await apiFetch<BillingDemoSession>(`/billing/demo/${encodeURIComponent(session)}`);
  if (!result.ok) { if (result.response?.status === 404 || result.response?.status === 403) notFound(); return <AppUnavailable title="Demo billing status unavailable"/>; }
  if (result.data.kind !== "portal") notFound();
  return <BillingDemoPanel csrfToken={me.data.csrfToken} session={result.data}/>;
}
