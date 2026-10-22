import styles from "./QuotaMeter.module.css";

export type QuotaMeterProps = { label: string; current: number; limit: number; resetTimezone?: string; upgradeHref?: string; upgradeLabel?: string };
export function QuotaMeter({ label, current, limit, resetTimezone, upgradeHref, upgradeLabel = "View plans" }: QuotaMeterProps) {
  const safeLimit = Math.max(0, limit);
  const safeCurrent = Math.max(0, current);
  const now = safeLimit > 0 ? Math.min(safeCurrent, safeLimit) : safeCurrent;
  const valueText = safeLimit > 0 ? `${safeCurrent} of ${safeLimit}` : `${safeCurrent} used`;
  const percent = safeLimit > 0 ? Math.min(100, (safeCurrent / safeLimit) * 100) : 0;
  return <section className={styles.quota} aria-label={label}>
    <div className={styles.heading}><strong>{label}</strong><span>{valueText}</span></div>
    {safeLimit > 0 ? <div aria-label={`${label}: ${valueText}`} aria-valuemax={safeLimit} aria-valuemin={0} aria-valuenow={now} className={styles.track} role="meter"><span className={styles.fill} style={{ width: `${percent}%` }} /></div> : null}
    <div className={styles.footer}>{resetTimezone ? <span>Resets in {resetTimezone}</span> : <span>Current usage</span>}{upgradeHref ? <a href={upgradeHref}>{upgradeLabel}</a> : null}</div>
  </section>;
}
