import type { Metadata } from "next";
import { SiteFooter, SiteHeader } from "@/components";
import { PreviewBanner } from "@/components/PreviewBanner";
import { isLocalPreview } from "@/lib/preview";
import { getSiteAccountState } from "@/lib/site-account";

export const metadata: Metadata = { robots: { index: false, follow: false } };
export default async function CommunityLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  const accountState = await getSiteAccountState();
  return <>{isLocalPreview() && <PreviewBanner />}<SiteHeader accountState={accountState} />{children}<SiteFooter /></>;
}
