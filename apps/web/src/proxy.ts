import {randomBytes} from 'node:crypto';
import {NextRequest,NextResponse} from 'next/server';

/** Each document gets its own nonce. Inbound CSP/nonce values are never trusted. */
export function proxy(request:NextRequest){
  if(process.env.NODE_ENV!=='production')return NextResponse.next();
  const nonce=randomBytes(24).toString('base64');
  const policy=["default-src 'self'",`script-src 'self' 'nonce-${nonce}' 'strict-dynamic'`,
    `style-src 'self' 'nonce-${nonce}'`,"style-src-attr 'unsafe-inline'","img-src 'self' blob: data:",
    "font-src 'self'","connect-src 'self'","object-src 'none'","base-uri 'self'","form-action 'self'","frame-ancestors 'none'",
    ...(process.env.RELEASE_MODE==='production'?["upgrade-insecure-requests"]:[])].join('; ');
  const headers=new Headers(request.headers);headers.set('x-nonce',nonce);headers.set('Content-Security-Policy',policy);
  const response=NextResponse.next({request:{headers}});response.headers.set('Content-Security-Policy',policy);
  response.headers.set('X-Frame-Options','DENY');return response;
}
export const config={matcher:['/((?!api/|_next/static|_next/image|favicon.ico).*)']};
