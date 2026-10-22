import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { AppShell } from "@/components/AppShell";
import { apiFetch } from "@/lib/server-api";
import { adminAccess } from "@/lib/admin-access";
import styles from "../workspace-ui/workspace.module.css";

export const metadata: Metadata = { title: { default: "Staff · Trading Community", template: "%s · Staff · Trading Community" }, robots: { index: false, follow: false } };
type Me = { user: { handle: string; displayName: string; avatarUrl: string | null; pro: boolean }; emailVerified: boolean; onboarded: boolean; roles: string[]; security?: { mfaVerified: boolean; mfaRecent: boolean }; csrfToken: string };
function AccountServiceUnavailable() { return <main className={styles.main}><p className={styles.eyebrow}>STAFF WORKSPACE</p><h1>Account service unavailable</h1><section className={styles.card}><p>Your staff role could not be checked right now. No staff or private data was loaded. Try again when the account service is available.</p><a href="/admin">Retry</a></section></main>; }
function StepUpRequired() { return <main className={styles.main}><p className={styles.eyebrow}>STAFF SECURITY</p><h1>Verify your staff session</h1><section className={styles.card} role="status"><p>Verify multi-factor authentication with your identity provider before opening staff tools.</p><a href="/api/v1/auth/step-up">Continue to secure verification</a></section></main>; }
export default async function StaffLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  const result = await apiFetch<Me>("/me");
  if (!result.ok) { if (result.response?.status === 403) redirect("/account-unavailable"); if (result.reason === "missing-session" || result.response?.status === 401) redirect("/login?returnTo=%2Fadmin"); return <AccountServiceUnavailable/>; }
  const me = result.data;
  if (!me.emailVerified) redirect("/verify-email?returnTo=%2Fadmin");
  const access = adminAccess(me);
  if (access === "not-staff") notFound();
  if (access === "mfa-required") return <StepUpRequired/>;
  const staffRole = me.roles.includes("admin") ? "admin" : "moderator";
  return <AppShell staff staffRole={staffRole} member={me.user} csrfToken={me.csrfToken}>{access === "step-up-needed" && <section className={styles.notice} role="status"><div><h2>Recent MFA needed for sensitive actions</h2><p>Your staff role and multi-factor verification are confirmed. This session needs a fresh check before a sensitive action.</p><a href="/api/v1/auth/step-up">Complete secure step-up</a></div></section>}{children}</AppShell>;
}
