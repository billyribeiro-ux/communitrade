import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { apiFetch } from "@/lib/server-api";
import styles from "../../workspace-ui/workspace.module.css";
import { DraftSetup } from "./DraftSetup";

type Me = { csrfToken: string };
export const metadata: Metadata = { title: "Set up a draft", robots: { index: false, follow: false } };

export default async function PublishSetupPage() {
  const result = await apiFetch<Me>("/me");
  if (!result.ok && (result.reason === "missing-session" || result.response?.status === 401)) redirect(`/login?returnTo=${encodeURIComponent("/app/publish")}`);
  if (!result.ok) return <main className={styles.main}><p className={styles.eyebrow}>PRIVATE · YOUR ACCOUNT</p><h1>Set up a draft</h1><section className={styles.notice} role="alert"><div><h2>Account service unavailable</h2><p>Your account could not be checked, so no draft was created. Refresh to try again.</p></div></section></main>;
  return <main className={styles.main}>
    <p className={styles.eyebrow}>PRIVATE · YOUR ACCOUNT</p>
    <h1>Set up a draft</h1>
    <p className={styles.intro}>Choose a draft type, asset, and current permitted instrument. The next step opens your private chart editor.</p>
    <DraftSetup csrfToken={result.data.csrfToken}/>
  </main>;
}
