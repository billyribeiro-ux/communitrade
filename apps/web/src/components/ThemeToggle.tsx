"use client";

import { useEffect, useState } from "react";
import { Moon, Sun, Desktop } from "@phosphor-icons/react";
import styles from "./ThemeToggle.module.css";

export type ThemeChoice = "dark" | "light" | "system";
const KEY = "trading-community-theme";

function applyTheme(theme: ThemeChoice) {
  document.documentElement.dataset.theme = theme;
  try { document.cookie = `${KEY}=${theme}; Path=/; Max-Age=31536000; SameSite=Lax`; } catch { /* Theme remains available without persistence. */ }
}

export function setThemeChoice(theme: ThemeChoice) {
  try { window.localStorage.setItem(KEY, theme); } catch { /* The theme remains available for this session. */ }
  applyTheme(theme);
  window.dispatchEvent(new Event("trading-community-theme-change"));
}

export function ThemeToggle() {
  const [theme, setTheme] = useState<ThemeChoice>("system");
  useEffect(() => {
    let saved: string | null = null;
    try { saved = window.localStorage.getItem(KEY); } catch { /* Storage can be disabled by browser policy. */ }
    const fromDocument = document.documentElement.dataset.theme;
    const value: ThemeChoice = saved === "light" || saved === "dark" || saved === "system"
      ? saved
      : fromDocument === "light" || fromDocument === "dark" ? fromDocument : "system";
    setTheme(value);
    applyTheme(value);
    const synchronize = () => { const current = document.documentElement.dataset.theme; setTheme(current === 'dark' || current === 'light' ? current : 'system'); };
    window.addEventListener('trading-community-theme-change', synchronize);
    return () => window.removeEventListener('trading-community-theme-change', synchronize);
  }, []);
  function change(value: ThemeChoice) {
    setTheme(value);
    setThemeChoice(value);
  }
  return <fieldset className={styles.toggle} aria-label="Color theme">
    <legend>Theme</legend>
    <button aria-label="Use system theme" aria-pressed={theme === "system"} onClick={() => change("system")} type="button"><Desktop aria-hidden="true" size={17} /></button>
    <button aria-label="Use light theme" aria-pressed={theme === "light"} onClick={() => change("light")} type="button"><Sun aria-hidden="true" size={17} /></button>
    <button aria-label="Use dark theme" aria-pressed={theme === "dark"} onClick={() => change("dark")} type="button"><Moon aria-hidden="true" size={17} /></button>
  </fieldset>;
}
