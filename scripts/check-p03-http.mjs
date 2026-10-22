import assert from 'node:assert/strict';

const origin=process.env.WEB_TEST_ORIGIN??'http://localhost:3000';
const publicRoutes=[
  '/','/features','/how-it-works','/pricing','/faq','/about','/contact','/support','/terms','/privacy','/risk-disclosure','/community-guidelines','/accessibility','/status',
  '/ideas','/ideas?symbol=SPY&symbol=QQQ','/login','/signup?plan=pro&interval=year','/auth/callback','/verify-email','/recover-account','/onboarding','/subscribe?plan=pro&interval=year','/subscribe/return?status=success',
];
const protectedRoutes=['/app','/app/feed','/app/feed?asset=Options&asset=Futures','/app/explore','/app/publish','/app/drafts','/app/journal','/app/journal/new','/app/journal/analytics','/app/watchlists','/app/bookmarks','/app/layouts','/app/notifications','/app/profile','/app/settings','/app/settings/security','/app/settings/preferences','/app/settings/privacy','/app/billing','/admin','/admin/reports','/admin/appeals','/admin/corrections','/admin/users','/admin/instruments','/admin/data','/admin/billing','/admin/editorial','/admin/support','/admin/jobs','/admin/audit'];
let checked=0;
const localLinks=new Set();
async function get(path,headers={}) { const response=await fetch(new URL(path,origin),{headers,signal:AbortSignal.timeout(60_000),redirect:'manual'});return {response,text:await response.text()}; }
function count(amount=1){checked+=amount;}
for(const path of publicRoutes){
  const {response,text}=await get(path);
  assert.equal(response.status,200,`${path} response`);
  assert.ok(text.includes('<h1'),`${path} heading`);
  assert.match(response.headers.get('cache-control')??'',/no-store/,`${path} account/marketing response is uncached`);
  assert.match(text,/<meta name="robots" content="noindex, nofollow"/i,`${path} metadata`);
  assert.ok(text.includes('id="main-content"'),`${path} skip target`);
  assert.ok(!text.includes('PRIVATE_SENTINEL'),`${path} private sentinel`);
  for(const match of text.matchAll(/href="(\/[^"<>]*)"/g)){const href=match[1].replaceAll('&amp;','&');if(!href.startsWith('/_next/')&&!href.startsWith('//')&&!href.startsWith('/api/'))localLinks.add(href);}
  count();
}
for(const path of protectedRoutes){
  const {response}=await get(path);
  assert.ok([307,308].includes(response.status),`${path} must redirect unauthenticated requests, got ${response.status}`);
  assert.match(response.headers.get('location')??'',/^\/login\?returnTo=/,`${path} redirects through account sign-in`);
  assert.match(response.headers.get('cache-control')??'',/no-store/,`${path} redirect not cached`);
  count();
}
for(const path of localLinks){
  if(publicRoutes.includes(path)||protectedRoutes.includes(path))continue;
  const {response}=await get(path);
  assert.ok([200,307,308,404].includes(response.status),`local link ${path} returned ${response.status}`);
  count();
}
for(const path of ['/ideas/idea-demo-01/spy-defined-risk-call-spread','/ideas/idea-demo-02/mes-levels-and-invalidation','/u/mayaresearch','/instruments/instrument-demo-spy','/support/requests/support-demo-01','/design-preview']){
  const {response}=await get(path);
  assert.equal(response.status,404,`local synthetic preview unavailable without explicit preview flag: ${path}`);
  count();
}
for(const path of ['/app/unknown','/admin/unknown','/ideas/not-a-record/title','/u/unknown','/instruments/unknown','/support/requests/unknown','/share/ideas/unknown/1.png','/app/journal/unknown','/app/drafts/unknown','/app/reports/unknown']){
  const {response}=await get(path);
  assert.ok(response.status===404||([307,308].includes(response.status)&&/^\/(?:app|admin)\//.test(path)) ,`unknown/private ${path} returned ${response.status}`);
  count();
}
for(const state of ['loading','empty','error','denied']){
  const {response}=await get(`/app/feed?state=${state}`);
  assert.ok([307,308].includes(response.status),`workspace state query cannot expose fixture data (${state})`);
  count();
}
const {text:home}=await get('/');
assert.match(home,/Continue to secure sign in|Create free account|Sign in/i,'marketing entry point is available');
assert.doesNotMatch(home,/PRIVATE_SENTINEL|CSRF_SENTINEL|private\.sentinel@example\.test/i,'marketing HTML contains no account-private markers');
const {text:login}=await get('/login');
assert.match(login,/Continue to secure sign in/,'login has an enabled provider entry action');
assert.doesNotMatch(login,/<button[^>]*disabled/i,'provider login action is not a disabled placeholder');
const {text:recovery}=await get('/recover-account');
assert.match(recovery,/Forgot password/i,'recovery clearly uses provider password reset');
count();
const {text:price}=await get('/pricing');
for(const word of ['1,000','100 instruments','UTC calendar month','raw records','five searches'])assert.ok(price.includes(word),`pricing: ${word}`);
const {text:subscribe}=await get('/subscribe?plan=pro&interval=year&returnTo=%2Fapp%2Fjournal');
assert.match(subscribe,/\$290 \/ year/,'annual intent survives the provider entry screen');
assert.match(subscribe,/Continue to secure registration/,'anonymous Pro choice leads to provider registration');
assert.match(subscribe,/Only reconciled provider state activates Pro/i,'plan intent does not grant access');
count();
const {text:robots}=await get('/robots.txt');assert.match(robots,/Disallow: \//);count();
const {text:sitemap}=await get('/sitemap.xml');assert.ok(!sitemap.includes('<loc>'),'preview sitemap empty');count();

// Optional integration evidence for a dedicated test member. The supplied cookie is
// never echoed. Keep P04_SESSION_TEST_COOKIE_HEADER separate from ordinary smoke runs
// because the session branch deliberately revokes that session at the end.
const cookie=process.env.P04_MEMBER_COOKIE_HEADER;
const handle=process.env.P04_MEMBER_HANDLE;
const privateEmail=process.env.P04_PRIVATE_EMAIL;
if(cookie&&handle){
  const workspace=await get('/app',{Cookie:cookie});
  assert.equal(workspace.response.status,200,'authenticated owner workspace SSR');
  assert.ok(workspace.text.includes(handle),'workspace contains the authenticated member handle');
  const ownerProfile=await get('/app/profile',{Cookie:cookie});
  assert.equal(ownerProfile.response.status,200,'authenticated owner profile SSR');
  assert.ok(ownerProfile.text.includes(handle),'profile editor is populated for the signed-in member');
  const publicProfile=await get(`/u/${encodeURIComponent(handle)}`);
  assert.equal(publicProfile.response.status,200,'public member profile projection');
  assert.ok(publicProfile.text.includes(handle),'public profile exposes its handle');
  assert.match(publicProfile.text,/Joined\s+(January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{4}/,'public profile join date is month/year only');
  for(const tab of ['ideas','updates','reposts']){
    assert.ok(publicProfile.text.includes(`href="/u/${handle}?tab=${tab}"`),`public profile provides ${tab} tab navigation`);
    const selected=await get(`/u/${encodeURIComponent(handle)}?tab=${tab}`);
    assert.equal(selected.response.status,200,`${tab} tab SSR`);
    assert.ok(selected.text.includes(`href="/u/${handle}?tab=${tab}" aria-current="page"`),`${tab} tab is selected in SSR`);
  }
  const publicLinks=[...publicProfile.text.matchAll(/<a\b[^>]*href="https:\/\/[^"]+"[^>]*>/g)].map(match=>match[0]);
  for(const link of publicLinks){const rel=link.match(/\brel="([^"]+)"/)?.[1]?.split(/\s+/)??[];for(const token of ['nofollow','ugc','noopener'])assert.ok(rel.includes(token),`public profile link has rel ${token}`);}
  assert.doesNotMatch(publicProfile.text,/csrfToken|CSRF_SENTINEL|private\.sentinel@example\.test/i,'public profile excludes CSRF/private markers');
  if(privateEmail){assert.ok(!publicProfile.text.includes(privateEmail),'public profile excludes the member email');assert.ok(!home.includes(privateEmail),'marketing page excludes the member email');}
  count(11+publicLinks.length*3);
} else {
  console.log('SKIP optional owner SSR/private-field checks: provide P04_MEMBER_COOKIE_HEADER and P04_MEMBER_HANDLE for a dedicated test member.');
}
const sessionCookie=process.env.P04_SESSION_TEST_COOKIE_HEADER;
if(sessionCookie){
  const appOrigin=process.env.P04_MEMBER_APP_ORIGIN;
  assert.ok(appOrigin,'P04_MEMBER_APP_ORIGIN is required for the destructive dedicated-session revocation check');
  const me=await get('/api/v1/me',{Cookie:sessionCookie});
  assert.equal(me.response.status,200,'dedicated member session starts active');
  const csrfToken=JSON.parse(me.text).csrfToken;
  const sessions=await get('/api/v1/me/sessions?limit=50',{Cookie:sessionCookie});
  assert.equal(sessions.response.status,200,'dedicated member can list its sessions');
  const current=JSON.parse(sessions.text).items.find(item=>item.current);
  assert.ok(current,'current session is listed');
  const revoked=await fetch(new URL(`/api/v1/me/sessions/${encodeURIComponent(current.id)}`,origin),{method:'DELETE',headers:{Cookie:sessionCookie,'X-CSRF-Token':csrfToken,Origin:appOrigin},redirect:'manual'});
  assert.equal(revoked.status,204,'current session revocation succeeds');
  const after=await get('/api/v1/me',{Cookie:sessionCookie});
  assert.equal(after.response.status,401,'revoked cookie can no longer authenticate');
  const workspace=await get('/app',{Cookie:sessionCookie});
  assert.ok([307,308].includes(workspace.response.status),'revoked current cookie is redirected out of workspace');
  count(5);
} else {
  console.log('SKIP current-session revocation check: provide a disposable P04_SESSION_TEST_COOKIE_HEADER and P04_MEMBER_APP_ORIGIN.');
}
console.log(`PASS ${checked} P04/P03 HTTP assertions/routes. This is SSR/HTTP evidence, not browser visual or keyboard acceptance.`);
