import { cookies } from "next/headers";
import { usesLocalSessionCookie } from "@/lib/runtime-policy";
import {trustedServiceIngressHeaders} from '@/lib/server/ingress';

/** Server-only API access. The origin is deployment configuration, never a request value. */
const API_ORIGIN = process.env.API_INTERNAL_URL ?? "http://localhost:3001";
const localRuntime = usesLocalSessionCookie(process.env.RELEASE_MODE, process.env.NODE_ENV);
const SESSION_COOKIE = localRuntime ? "tc_session_dev" : "__Host-tc_session";

export type ApiResult<T> = { ok: true; data: T; response: Response } | { ok: false; response?: Response; reason: "missing-session" | "unavailable" };

export async function apiFetch<T>(path: string, init: RequestInit = {}): Promise<ApiResult<T>> {
  const jar = await cookies();
  const session = jar.get(SESSION_COOKIE)?.value;
  if (!session || !/^[-A-Za-z0-9._~]+$/.test(session)) return { ok: false, reason: "missing-session" };
  const headers = new Headers(init.headers);
  headers.set("Cookie", `${SESSION_COOKIE}=${session}`);
  headers.set("Accept", "application/json");
  const url=new URL(`/api/v1${path}`,API_ORIGIN);
  if(!localRuntime){
    const body=typeof init.body==='string'?Buffer.from(init.body):init.body instanceof Uint8Array?init.body:undefined;
    if(init.body!==undefined&&!body)throw new Error('Unsupported server API body.');
    trustedServiceIngressHeaders(init.method??'GET',`${url.pathname}${url.search}`,body).forEach((value,key)=>headers.set(key,value));
  }
  try {
    const response = await fetch(url, { ...init, headers, cache: "no-store", redirect: "manual",signal:init.signal??AbortSignal.timeout(15000) });
    if (!response.ok) return { ok: false, response, reason: "unavailable" };
    return { ok: true, data: await response.json() as T, response };
  } catch {
    return { ok: false, reason: "unavailable" };
  }
}

export async function publicApiFetch<T>(path: string, options: { signal?: AbortSignal } = {}): Promise<ApiResult<T>> {
  try {
    const url=new URL(`/api/v1${path}`,API_ORIGIN),headers=new Headers({Accept:'application/json'});
    if(!localRuntime)trustedServiceIngressHeaders('GET',`${url.pathname}${url.search}`).forEach((value,key)=>headers.set(key,value));
    const response = await fetch(url, { ...options, headers, cache: "no-store", redirect: "manual",signal:options.signal??AbortSignal.timeout(15000) });
    if (!response.ok) return { ok: false, response, reason: "unavailable" };
    return { ok: true, data: await response.json() as T, response };
  } catch { return { ok: false, reason: "unavailable" }; }
}

/** Public source access with optional personal state; invalid supplied sessions are not downgraded. */
export async function optionalApiFetch<T>(path: string): Promise<ApiResult<T>> {
  const jar = await cookies();
  return jar.has(SESSION_COOKIE) ? apiFetch<T>(path) : publicApiFetch<T>(path);
}

export function apiUrl(path: string): URL { return new URL(`/api/v1${path}`, API_ORIGIN); }
