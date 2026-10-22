import {getPublicSitemap} from '@/lib/public-sitemap';
export const dynamic='force-dynamic';
const headers={'Content-Type':'application/xml; charset=utf-8','Cache-Control':'no-store, max-age=0'};
function xml(value:string){return value.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');}
export async function GET(_request:Request,{params}:{params:Promise<{shard:string}>}){
 const {shard}=await params;if(!/^(?:[0-9]|1[0-5])\.xml$/.test(shard))return new Response('Not found',{status:404,headers});
 const entries=await getPublicSitemap(Number(shard.slice(0,-4)));
 const urls=entries.map(entry=>`<url><loc>${xml(entry.url)}</loc>${entry.lastModified?`<lastmod>${xml(new Date(entry.lastModified).toISOString())}</lastmod>`:''}</url>`).join('');
 return new Response(`<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls}</urlset>`,{headers});
}
