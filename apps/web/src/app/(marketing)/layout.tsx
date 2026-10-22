import type { ReactNode } from "react";
import { SiteHeader } from "@/components/SiteHeader";
import { SiteFooter } from "@/components/SiteFooter";
import { PreviewBanner } from "@/components/PreviewBanner";
import { isLocalPreview } from "@/lib/preview";
import { getSiteAccountState } from "@/lib/site-account";
import styles from "./marketing.module.css";

export default async function MarketingLayout({ children }: { children: ReactNode }) {
  const accountState = await getSiteAccountState();
  return <div className={styles.site}>{isLocalPreview() && <PreviewBanner />}<SiteHeader accountState={accountState} /><main id="main-content" tabIndex={-1} className={styles.main}>{children}</main><SiteFooter /></div>;
}
