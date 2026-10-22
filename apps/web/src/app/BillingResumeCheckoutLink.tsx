import { createElement } from "react";
import { trustedBillingRedirect } from "../lib/billing";

export function BillingResumeCheckoutLink({ url, appOrigin, className }: { url: string | null; appOrigin: string; className?: string | undefined }) {
  if (!url) return null;
  const safeUrl = trustedBillingRedirect(url, appOrigin, ["checkout.stripe.com"], "/subscribe/demo");
  if (!safeUrl) return createElement("p", { role: "status" }, "A pending checkout is recorded, but its destination could not be verified. Contact billing support before starting another checkout.");
  return createElement("a", { className, href: safeUrl }, "Continue pending checkout");
}
