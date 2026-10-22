import type { MetadataRoute } from 'next';
import { site } from '@/lib/site';
import { assertReleaseReady } from '@/lib/policies';
import { publicApiFetch } from '@/lib/server-api';
import { collectDiscoveryEntries, type DiscoveryPage } from '@/lib/sitemap-entries';
export async function getPublicSitemap(shard:number):Promise<MetadataRoute.Sitemap> {
  if(process.env.RELEASE_MODE!=='production') return [];
  assertReleaseReady();
  if(!Number.isInteger(shard)||shard<0||shard>15)throw new Error('Unknown discovery shard.');
  const entries=await collectDiscoveryEntries(async cursor=>{
    const result=await publicApiFetch<DiscoveryPage>(`/discovery/sitemap?${new URLSearchParams({shard:String(shard),limit:'200',...(cursor?{cursor}:{})})}`);
    if(!result.ok)throw new Error('Public discovery authorization is unavailable.');
    return result.data;
  });
  const marketing=shard===0?['', '/features','/how-it-works','/pricing','/faq','/about','/contact','/support','/terms','/privacy','/risk-disclosure','/community-guidelines','/accessibility','/status'].map(path=>({url:new URL(path||'/',site.url).href})):[];
  return [...marketing,...entries.map(entry=>({url:new URL(entry.path,site.url).href,lastModified:entry.lastModified}))];
}
