import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { AppShell } from "@/components/AppShell";
import { apiFetch } from "@/lib/server-api";
import styles from "../workspace-ui/workspace.module.css";

export const metadata: Metadata = { title: { default: "Workspace · Trading Community", template: "%s · Trading Community" }, robots: { index: false, follow: false } };
type Me = { user: { handle: string; displayName: string; avatarUrl: string | null; pro: boolean }; emailVerified: boolean; onboarded: boolean; roles: string[]; csrfToken: string };
type NotificationSummary = { unreadCount: number };
function AccountServiceUnavailable() { return <main className={styles.main}><p className={styles.eyebrow}>MEMBER WORKSPACE</p><h1>Account service unavailable</h1><section className={styles.card}><p>Your session could not be checked right now. No private workspace data was loaded. Try again when the account service is available.</p><a href="/app">Retry</a></section></main>; }
export default async function MemberLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  const result = await apiFetch<Me>("/me");
  if (!result.ok) { if (result.response?.status === 403) redirect("/account-unavailable"); if (result.reason === "missing-session" || result.response?.status === 401) redirect("/login?returnTo=%2Fapp"); return <AccountServiceUnavailable/>; }
  const me = result.data;
  if (!me.emailVerified) redirect("/verify-email?returnTo=%2Fapp");
  if (!me.onboarded) redirect("/onboarding");
  const notifications = await apiFetch<NotificationSummary>("/notifications?limit=1");
  const member = { ...me.user, ...(notifications.ok ? { unreadNotifications: notifications.data.unreadCount } : {}) };
  return <AppShell member={member} csrfToken={me.csrfToken}>{children}</AppShell>;
}
