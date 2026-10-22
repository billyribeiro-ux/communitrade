import { validateChartState, type components } from "@trading/contracts";

export type Draft = components["schemas"]["Draft"];
export type ChartState = components["schemas"]["ChartState"];
export type ChartDocument = components["schemas"]["ChartDocument"];
export class DraftRequestError extends Error {
  constructor(readonly status: number, message?: string) {
    super(message ?? (status === 409 ? "This draft changed in another session. Reload the saved version before continuing." : status === 401 ? "Your session expired. Sign in again to continue." : status === 403 ? "Current permissions do not allow this change." : "The draft service could not complete this request. Your local changes remain here."));
  }
}
async function responseError(response: Response): Promise<never> {
    const problem = await response.json().catch(() => null) as {code?: string} | null;
    const messages: Record<string, string> = {
      PLAN_TARGET_GAP: "Linked targets must start at target 1 and remain numbered in order. Correct the targets, then retry saving.",
      DUPLICATE_INDICATOR_PERIOD: "Each EMA period can appear only once. Correct the indicators, then retry saving.",
      CHART_REFERENCE_UNAVAILABLE: "The saved reference metadata is no longer current. Start a new draft using the current reference.",
      CHART_PROVENANCE_MISMATCH: "The chart source does not match the selected reference. Reload the saved draft before continuing.",
    };
    throw new DraftRequestError(response.status, response.status === 422 ? messages[problem?.code ?? ""] ?? "Chart validation failed. Check drawing values, numbered targets, reference metadata and view settings, then retry saving." : undefined);
}
export async function draftRequest<T>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(`/api/v1/drafts/${path}`, { ...options, credentials: "same-origin", cache: "no-store", redirect: "error", signal: options.signal ?? AbortSignal.timeout(20_000), headers: { Accept: "application/json", ...options.headers } });
  if (!response.ok) return responseError(response);
  return await response.json() as T;
}
export function parseChartDocument(value: unknown): ChartDocument {
  if (!value || typeof value !== "object" || !("revision" in value) || !Number.isSafeInteger(value.revision) || Number(value.revision) < 0 || !("state" in value) || !validateChartState(value.state)) throw new Error("The saved chart response is invalid. Your local chart has been preserved.");
  return value as ChartDocument;
}
export async function saveChart(id: string, token: string, state: ChartState, revision: number, signal: AbortSignal): Promise<ChartDocument> {
  if (!validateChartState(state)) throw new Error("The chart contains an invalid field. Correct it before saving.");
  const response = await fetch(`/api/v1/drafts/${id}/chart`, { method: "PUT", credentials: "same-origin", cache: "no-store", redirect: "error", signal: AbortSignal.any([signal, AbortSignal.timeout(20_000)]), headers: { Accept: "application/json", "Content-Type": "application/json", "X-CSRF-Token": token, "If-Match": `"${revision}"` }, body: JSON.stringify(state) });
  if (!response.ok) return responseError(response);
  const document = parseChartDocument(await response.json());
  if (document.revision <= revision || response.headers.get("ETag") !== `"${document.revision}"`) throw new Error("The chart save acknowledgement is invalid. Reload the saved version before retrying.");
  return document;
}
