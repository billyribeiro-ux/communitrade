'use server';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { intentQuery, parsePlanIntent } from '@/lib/navigation';
export async function savePlanIntent(form: FormData) {
  const intent = parsePlanIntent({ plan: form.get('plan'), interval: form.get('interval'), returnTo: form.get('returnTo') });
  const screen = form.get('screen') === 'login' ? 'login' : 'signup';
  const jar = await cookies();
  jar.set('tc_plan_intent', JSON.stringify(intent), { httpOnly: true, secure: process.env.RELEASE_MODE === 'production', sameSite: 'lax', path: '/', maxAge: 1800 });
  // This cookie carries navigation preferences only. It cannot authenticate or grant Pro.
  redirect(`/${screen}?${intentQuery(intent)}&intent=saved`);
}
