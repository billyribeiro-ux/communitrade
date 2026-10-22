import Link from "next/link";
import styles from "./SiteFooter.module.css";

const footerLinks = [
  ["About", "/about"], ["Contact", "/contact"], ["Support", "/support"], ["Status", "/status"],
  ["Terms", "/terms"], ["Privacy", "/privacy"], ["Risk disclosure", "/risk-disclosure"],
  ["Community guidelines", "/community-guidelines"], ["Accessibility", "/accessibility"]
] as const;

export function SiteFooter() {
  return <footer className={styles.footer}>
    <div className={styles.inner}>
      <div><Link className={styles.brand} href="/">Trading <span>Community</span></Link><p>Research, discussion, and member reported outcomes.</p></div>
      <nav aria-label="Footer navigation">{footerLinks.map(([label, href]) => <Link href={href} key={href}>{label}</Link>)}</nav>
      <p className={styles.disclosure}>Trading involves risk. Members execute trades separately with their brokers. Execution prices and results are member reported and are not broker verified. Market data may be delayed.</p>
      <small>© {new Date().getFullYear()} Trading Community</small>
    </div>
  </footer>;
}
