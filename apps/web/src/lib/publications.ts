import type { components } from "@trading/contracts";
export type Publication = components["schemas"]["Publication"];
export type PublicationJob = components["schemas"]["PublicationJob"];
export type Position = components["schemas"]["Position"];
export type PositionEvent = components["schemas"]["PositionEvent"];
export type Performance = components["schemas"]["Performance"];
export type Correction = components["schemas"]["Correction"];
export type Media = components["schemas"]["Media"];
export type TradePlan = components["schemas"]["TradePlan"];
export const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export class PublicationError extends Error { constructor(readonly status: number, message: string) { super(message); } }
export async function publicationRequest<T>(path: string, init: RequestInit = {}): Promise<{data:T; etag:string|null}> {
  const response = await fetch(`/api/v1${path}`, {...init, credentials: "same-origin", cache: "no-store", redirect: "error", signal: init.signal ?? AbortSignal.timeout(30_000), headers: {Accept: "application/json", ...init.headers}});
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new PublicationError(response.status, response.status === 401 ? "Your session expired. Sign in again to continue." : response.status === 409 ? "The saved record changed or this action is no longer available. Reload the current record before retrying." : typeof data?.detail === "string" ? data.detail + (Array.isArray(data.errors) ? " " + data.errors.slice(0,8).map((issue:unknown)=>issue&&typeof issue==="object"&&"message" in issue&&typeof issue.message==="string"?issue.message.slice(0,300):"").filter(Boolean).join(" ") : "") : typeof data?.title === "string" ? data.title : "This request could not be completed. Your entered values remain here.");
  return {data: data as T, etag: response.headers.get("ETag")};
}
export function writeHeaders(token: string, key?: string, revision?: number) {
  return {"Content-Type": "application/json", "X-CSRF-Token": token, ...(key ? {"Idempotency-Key": key} : {}), ...(revision !== undefined ? {"If-Match": `"${revision}"`} : {})};
}
