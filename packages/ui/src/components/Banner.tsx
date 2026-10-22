import type { ReactNode } from "react";
import styles from "./Banner.module.css";

export type BannerTone = "info" | "success" | "warning" | "error";
export type BannerProps = { children: ReactNode; tone?: BannerTone; persistent?: boolean; onDismiss?: () => void; label?: string };

export function Banner({ children, tone = "info", persistent = false, onDismiss, label }: BannerProps) {
  const role = tone === "error" || persistent ? "alert" : "status";
  return <div aria-label={label} className={`${styles.banner} ${styles[tone]}`} role={role}>
    <div className={styles.message}>{children}</div>
    {onDismiss ? <button aria-label="Dismiss message" className={styles.dismiss} onClick={onDismiss} type="button">×</button> : null}
  </div>;
}
