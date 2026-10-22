import type { Metadata } from 'next';
import { SiteHeader } from '@/components/SiteHeader';
import { SiteFooter } from '@/components/SiteFooter';
export const metadata: Metadata = { robots: { index: false, follow: false } };
export default function AccountLayout({children}: {children: React.ReactNode}) {
  return <><SiteHeader /><main id="main-content">{children}</main><SiteFooter /></>;
}
