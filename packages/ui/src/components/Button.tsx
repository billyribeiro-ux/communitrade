import { useId, type ButtonHTMLAttributes, type ReactNode } from "react";
import styles from "./Button.module.css";

export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  children: ReactNode;
  variant?: "primary" | "secondary" | "text" | "destructive";
  busy?: boolean;
  busyLabel?: string;
  disabledReason?: string;
};

export function Button({ children, className, disabled, type = "button", variant = "secondary", busy = false, busyLabel = "Working…", disabledReason, "aria-describedby": describedBy, ...props }: ButtonProps) {
  const classes = [styles.button, styles[variant], className].filter(Boolean).join(" ");
  const unavailable = disabled || busy;
  const reasonId = useId();
  const ariaDescribedBy = [describedBy, unavailable && disabledReason ? reasonId : null].filter(Boolean).join(" ") || undefined;
  return <span className={styles.wrapper}>
    <button aria-busy={busy || undefined} aria-describedby={ariaDescribedBy} className={classes} disabled={unavailable} type={type} {...props}>
      {busy ? <><span aria-hidden="true" className={styles.spinner} />{busyLabel}</> : children}
    </button>
    {unavailable && disabledReason ? <span className={styles.reason} id={reasonId} role="status">{disabledReason}</span> : null}
  </span>;
}
