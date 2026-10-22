import { cloneElement, type ReactElement, type ReactNode } from "react";
import styles from "./FormField.module.css";

type ControlProps = { id?: string; required?: boolean; maxLength?: number; "aria-describedby"?: string; "aria-invalid"?: boolean };
export type FormFieldProps = {
  id: string;
  label: string;
  children: ReactElement<ControlProps>;
  help?: ReactNode;
  error?: string;
  required?: boolean;
  maxLength?: number;
  characterCount?: number;
};

export function FormField({ id, label, children, help, error, required = false, maxLength, characterCount }: FormFieldProps) {
  const helpId = help ? `${id}-help` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  const countId = maxLength !== undefined && characterCount !== undefined ? `${id}-count` : undefined;
  const describedBy = [helpId, errorId, countId, children.props["aria-describedby"]].filter(Boolean).join(" ") || undefined;
  const control = cloneElement(children, {
    id,
    required,
    ...(maxLength === undefined ? {} : { maxLength }),
    ...(describedBy ? { "aria-describedby": describedBy } : {}),
    ...(error ? { "aria-invalid": true } : children.props["aria-invalid"] === undefined ? {} : { "aria-invalid": children.props["aria-invalid"] })
  });
  return <div className={styles.field}>
    <label className={styles.label} htmlFor={id}>{label}{required ? <span aria-hidden="true" className={styles.required}> *</span> : null}</label>
    {control}
    <div className={styles.meta}>
      {help ? <span id={helpId}>{help}</span> : null}
      {error ? <span className={styles.error} id={errorId} role="alert">{error}</span> : null}
      {countId ? <span className={styles.count} id={countId}>{characterCount} / {maxLength} characters</span> : null}
    </div>
  </div>;
}
