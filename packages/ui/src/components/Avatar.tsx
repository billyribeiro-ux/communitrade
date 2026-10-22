"use client";
import { useState, type ImgHTMLAttributes } from "react";
import styles from "./Avatar.module.css";

export type AvatarProps = Omit<ImgHTMLAttributes<HTMLImageElement>, "alt" | "src"> & {
  name: string;
  src?: string | null;
  size?: "small" | "medium" | "large";
};

function initials(name: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const first = parts[0]?.[0];
  const last = parts.length > 1 ? parts.at(-1)?.[0] : undefined;
  return (parts.length > 1 ? `${first ?? "?"}${last ?? "?"}` : parts[0]?.slice(0, 2) ?? "?").toLocaleUpperCase();
}

export function Avatar({ name, src, size = "medium", className, onError, ...props }: AvatarProps) {
  const [failedSource, setFailedSource] = useState<string | null>(null);
  const classes = [styles.avatar, styles[size], className].filter(Boolean).join(" ");
  return src && src !== failedSource
    ? <img {...props} className={classes} src={src} alt={`${name || "Member"} avatar`} onError={event=>{setFailedSource(src);onError?.(event);}} />
    : <span aria-label={`${name} avatar`} className={`${classes} ${styles.fallback}`} role="img" {...props}>{initials(name)}</span>;
}
