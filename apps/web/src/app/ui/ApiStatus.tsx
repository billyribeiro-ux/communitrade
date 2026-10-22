"use client";

import { useEffect, useState } from "react";
import { Status, type StatusTone } from "@trading/ui";
import styles from "./ApiStatus.module.css";

type ApiState = "checking" | "ready" | "starting" | "unavailable";
const messages: Record<ApiState, { label: string; tone: StatusTone }> = {
  checking: { label: "Checking", tone: "neutral" },
  ready: { label: "Ready", tone: "positive" },
  starting: { label: "Starting", tone: "warning" },
  unavailable: { label: "Unavailable", tone: "negative" }
};

async function checkHealth(path: string): Promise<Response> {
  return fetch(`/api/v1/health/${path}`, { cache: "no-store", headers: { accept: "application/json" } });
}

export function ApiStatus() {
  const [state, setState] = useState<ApiState>("checking");
  useEffect(() => {
    let active = true;
    const check = async () => {
      try {
        const live = await checkHealth("live");
        if (!live.ok) throw new Error("live check failed");
        const ready = await checkHealth("ready");
        if (active) setState(ready.ok ? "ready" : "starting");
      } catch {
        if (active) setState("unavailable");
      }
    };
    void check();
    const timer = window.setInterval(() => void check(), 15000);
    return () => { active = false; window.clearInterval(timer); };
  }, []);
  const status = messages[state];
  return <div className={styles.row}><span>API service</span><Status tone={status.tone}>{status.label}</Status></div>;
}
