import type { MetadataRoute } from 'next';
import { site } from '@/lib/site';
export default function robots():MetadataRoute.Robots {
  return process.env.RELEASE_MODE==='production'
    ? {rules:{userAgent:'*',allow:'/',disallow:['/app','/admin','/login','/signup','/auth','/subscribe','/support/requests']},sitemap:new URL('/sitemap.xml',site.url).href}
    : {rules:{userAgent:'*',disallow:'/'}};
}
