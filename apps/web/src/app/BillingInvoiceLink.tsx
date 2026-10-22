import { createElement, type ReactNode } from "react";
import { trustedInvoiceUrl } from "../lib/billing";

export function BillingInvoiceLink({ url, className, children }: { url: string | null; className?: string | undefined; children: ReactNode }) {
  const safeUrl = trustedInvoiceUrl(url);
  if (!safeUrl) return null;
  return createElement("a", { className, href: safeUrl, target: "_blank", rel: "noopener noreferrer" }, children);
}
