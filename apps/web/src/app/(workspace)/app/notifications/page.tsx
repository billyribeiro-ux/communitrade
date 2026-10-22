import { redirect } from "next/navigation";
import { apiFetch } from "@/lib/server-api";
import { Notifications, type NotificationPageData } from "../../workspace-ui/Notifications";
import styles from "../../workspace-ui/workspace.module.css";

type Me = { csrfToken: string };
type Props = { searchParams: Promise<{ cursor?: string; unreadOnly?: string }> };

export default async function NotificationsPage({ searchParams }: Props) {
  const [{ cursor, unreadOnly }, me] = await Promise.all([searchParams, apiFetch<Me>("/me")]);
  if (!me.ok) { if (me.response?.status === 401 || me.reason === "missing-session") redirect("/login?returnTo=%2Fapp%2Fnotifications"); return <div className={styles.main}><h1>Notifications</h1><section className={styles.card} role="alert"><h2>Notifications unavailable</h2><p>Your notification data could not be loaded. Try again when the account service is available.</p></section></div>; }
  const params = new URLSearchParams({ limit: "20", ...(cursor ? { cursor } : {}), ...(unreadOnly === "1" ? { unreadOnly: "true" } : {}) });
  const result = await apiFetch<NotificationPageData>(`/notifications?${params}`);
  if (!result.ok) {
    if (result.response?.status === 401) redirect("/login?returnTo=%2Fapp%2Fnotifications");
    return <div className={styles.main}><p className={styles.eyebrow}>PRIVATE · YOUR ACCOUNT</p><h1>Notifications</h1><section className={styles.card} role="alert"><h2>Notifications unavailable</h2><p>The notification service did not return your activity. Refresh to try again. No data was changed.</p></section></div>;
  }
  return <div className={styles.main}><p className={styles.eyebrow}>PRIVATE · YOUR ACCOUNT</p><h1>Notifications</h1><Notifications csrfToken={me.data.csrfToken} initial={result.data} initialUnreadOnly={unreadOnly === "1"}/></div>;
}
