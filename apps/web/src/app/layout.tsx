import type { Metadata } from 'next';
import { cookies } from 'next/headers';
import { site } from '@/lib/site';
import { assertReleaseReady } from '@/lib/policies';
import './globals.css';
export const metadata: Metadata = {
  metadataBase: new URL(site.url), title:{ default:site.name, template:`%s | ${site.name}` }, description:site.description,
  robots:{index:process.env.RELEASE_MODE==='production',follow:process.env.RELEASE_MODE==='production'},
};
export default async function RootLayout({children}:Readonly<{children:React.ReactNode}>){
  assertReleaseReady();
  const preference=(await cookies()).get('trading-community-theme')?.value;
  const theme=preference==='light'||preference==='dark'?preference:'system';
  return <html lang="en" data-theme={theme}><body><a className="skip-link" href="#main-content">Skip to content</a>{children}</body></html>;
}
