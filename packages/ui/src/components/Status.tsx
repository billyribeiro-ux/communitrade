import type { ReactNode } from "react";
import styles from "./Status.module.css";

export type StatusTone = "neutral" | "positive" | "warning" | "negative";
export type StatusProps = { children: ReactNode; tone?: StatusTone; label?: string };

export function Status({ children, tone = "neutral", label }: StatusProps) {
  return <span className={`${styles.status} ${styles[tone]}`}>
    <span aria-hidden="true" className={styles.dot} />
    {label ? <span className={styles.label}>{label}</span> : null}{children}
  </span>;
}
