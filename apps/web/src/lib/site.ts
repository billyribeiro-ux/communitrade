import type { Metadata } from 'next';
import { isLocalPreview } from './preview';

export const site = Object.freeze({
  name: 'Trading Community',
  url: process.env.PUBLIC_SITE_URL ?? 'http://localhost:3000',
  description: 'Stock, options, and futures trade ideas with inspectable history, discussion, and a private research journal.',
});
export function publicMetadata(path: string, title: string, description: string): Metadata {
  return {
    title, description, alternates: { canonical: path },
    openGraph: { title, description, url: path, siteName: site.name, type: 'website' },
    twitter: { card: 'summary', title, description },
    robots: { index: !isLocalPreview() && process.env.RELEASE_MODE === 'production', follow: !isLocalPreview() && process.env.RELEASE_MODE === 'production' },
  };
}
export const privateMetadata: Metadata = { robots: { index: false, follow: false } };
