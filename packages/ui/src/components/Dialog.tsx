"use client";

import { useEffect, useId, useRef, type ReactNode } from "react";
import styles from "./Dialog.module.css";

export type DialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  children: ReactNode;
  closeLabel?: string;
  dismissible?: boolean;
};

export function Dialog({ open, onOpenChange, title, description, children, closeLabel = "Close", dismissible = true }: DialogProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const titleId = `dialog-title-${useId()}`;
  const descriptionId = description ? `${titleId}-description` : undefined;
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (open && !el.open) {
      returnFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      el.showModal();
    }
    if (!open && el.open) {
      el.close();
      returnFocusRef.current?.focus();
    }
  }, [open]);
  return <dialog aria-describedby={descriptionId} aria-labelledby={titleId} className={styles.dialog} onCancel={(event) => { event.preventDefault(); if (dismissible) onOpenChange(false); }} onClose={() => onOpenChange(false)} onClick={(event) => { if (dismissible && event.target === ref.current) onOpenChange(false); }} ref={ref}>
    <div className={styles.content}>
      <header className={styles.header}><div><h2 id={titleId}>{title}</h2>{description ? <p id={descriptionId}>{description}</p> : null}</div>{dismissible ? <button aria-label={closeLabel} className={styles.close} onClick={() => onOpenChange(false)} type="button">×</button> : null}</header>
      <div>{children}</div>
    </div>
  </dialog>;
}
