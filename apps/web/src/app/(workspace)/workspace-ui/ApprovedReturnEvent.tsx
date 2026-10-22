"use client";

import { useEffect } from "react";
const CONSENT_VERSION = "2026-10-20.v1";
export function ApprovedReturnEvent({ csrfToken, analyticsConsent, consentVersion }: { csrfToken: string; analyticsConsent: boolean; consentVersion?: string | null }) {
  useEffect(() => {
    if (!analyticsConsent || consentVersion !== CONSENT_VERSION) return;
    const key = `tc-product-return-${new Date().toISOString().slice(0, 10)}`;
    let sourceKey: string;
    try {
      sourceKey = sessionStorage.getItem(key) ?? crypto.randomUUID();
      sessionStorage.setItem(key, sourceKey);
    } catch { sourceKey = crypto.randomUUID(); }
    void fetch("/api/v1/product-events", { method: "POST", credentials: "same-origin", cache: "no-store", headers: { "Content-Type": "application/json", "X-CSRF-Token": csrfToken }, body: JSON.stringify({ name: "return", sourceKey, properties: { surface: "dashboard" } }) }).catch(() => undefined);
  }, [analyticsConsent, consentVersion, csrfToken]);
  return null;
}
