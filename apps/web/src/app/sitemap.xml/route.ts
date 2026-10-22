import {site} from '@/lib/site';
import {assertReleaseReady} from '@/lib/policies';
export const dynamic='force-dynamic';
function xml(value:string){return value.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');}
export async function GET(){
  const headers={'Content-Type':'application/xml; charset=utf-8','Cache-Control':'no-store, max-age=0'};
  if(process.env.RELEASE_MODE!=='production')return new Response('<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"></urlset>',{headers});
  assertReleaseReady();
  const entries=Array.from({length:16},(_,id)=>`<sitemap><loc>${xml(new URL(`/sitemaps/${id}.xml`,site.url).href)}</loc></sitemap>`).join('');
  return new Response(`<?xml version="1.0" encoding="UTF-8"?><sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${entries}</sitemapindex>`,{headers});
}
