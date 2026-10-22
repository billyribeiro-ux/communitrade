import { apiFetch } from "@/lib/server-api";
import type { SiteAccountState } from "@/components/SiteHeader";

type Me = { user: { pro: boolean }; entitlement?: { plan?: string } };
export async function getSiteAccountState(): Promise<SiteAccountState> {
  const result = await apiFetch<Me>("/me");
  if (!result.ok) return "anonymous";
  return result.data.user.pro || result.data.entitlement?.plan === "pro" ? "pro" : "member";
}
