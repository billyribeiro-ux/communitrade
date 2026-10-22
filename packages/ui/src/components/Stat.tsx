import type { ReactNode } from "react";
import styles from "./Stat.module.css";

export type StatProps = { label: string; value: ReactNode; denominator?: ReactNode; period?: string; explanation?: string };
export function Stat({ label, value, denominator, period, explanation }: StatProps) {
  return <div className={styles.stat}>
    <span className={styles.label}>{label}</span>
    <strong className={styles.value}>{value}{denominator !== undefined ? <span className={styles.denominator}> / {denominator}</span> : null}</strong>
    {period ? <span className={styles.period}>{period}</span> : null}
    {explanation ? <p className={styles.explanation}>{explanation}</p> : null}
  </div>;
}
