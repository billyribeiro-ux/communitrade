import Link from "next/link";
import styles from "./(workspace)/workspace-ui/workspace.module.css";
export function AppUnavailable({ title }: { title: string }) { return <main className={styles.main}><p className={styles.eyebrow}>BILLING STATUS</p><h1>{title}</h1><section className={styles.card} role="alert"><p>The account billing service could not return an authorized result. No plan change was assumed.</p><Link href="/app/billing">Return to billing</Link></section></main>; }
