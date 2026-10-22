import type { NextConfig } from "next";


const nextConfig: NextConfig = {
  logging: { incomingRequests: false },
  experimental: { useTypeScriptCli: true },
  ...(process.env.RELEASE_MODE === 'production' ? {} : { allowedDevOrigins: ['web'] }),
  transpilePackages: ["@trading/ui"],
  async headers() {
    return [
      { source: '/:path*', headers: [
      { key: 'X-Content-Type-Options', value: 'nosniff' },
      { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
      { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
      { key: 'X-Frame-Options', value: 'DENY' },
      ...(process.env.RELEASE_MODE==='production'&&process.env.HSTS_ENABLED==='true'?[{key:'Strict-Transport-Security',value:'max-age=31536000; includeSubDomains'}]:[]),
      ...(process.env.RELEASE_MODE === 'production' ? [] : [{ key: 'X-Robots-Tag', value: 'noindex, nofollow' }]),
      ] },
      // Keep signed worker-only page URLs out of referers and caches after the generic policy applies.
      { source: '/internal/publication-snapshots/:path*', headers: [
        { key: 'Cache-Control', value: 'no-store, max-age=0' },
        { key: 'Referrer-Policy', value: 'no-referrer' },
        { key: 'X-Robots-Tag', value: 'noindex, nofollow, noarchive' },
      ] },
      { source: '/digest/unsubscribe', headers: [
        { key: 'Cache-Control', value: 'private, no-store, max-age=0' },
        { key: 'Referrer-Policy', value: 'no-referrer' },
        { key: 'X-Robots-Tag', value: 'noindex, nofollow, noarchive' },
      ] },
    ];
  },
  // The route handler signs trusted ingress and preserves raw provider bytes.
};

export default nextConfig;
