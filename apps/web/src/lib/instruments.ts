import type { components } from "@trading/contracts";
export { instrumentFailure } from "@/lib/instrument-errors";
export { getExpirationStatus } from "@/lib/instrument-dates";

export type DataMeta = components["schemas"]["DataMeta"];
export type Instrument = components["schemas"]["Instrument"] & {
  synthetic?: boolean; contractYear?: number; lastTradingDate?: string;
  versions?: Array<{ metadataVersion: number; sourceId?: string }>;
};
export type InstrumentPage = Omit<components["schemas"]["InstrumentPage"], "items"> & { items: Instrument[]; envelope?: DataMeta };
export type InstrumentDetail = Instrument;
export type Quote = components["schemas"]["Quote"];
export type ValidateOptionStrategyRequest = components["schemas"]["ValidateOptionStrategyRequest"];
export type ValidateOptionStrategyResponse = components["schemas"]["ValidateOptionStrategyResponse"];

export function queryString(values: Record<string, string | undefined>) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) if (value) query.set(key, value);
  const suffix = query.toString();
  return suffix ? `?${suffix}` : "";
}
export function formatAsOf(value: string | null | undefined) {
  if (!value) return "No timestamp supplied";
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? "Timestamp unavailable" : date.toLocaleString(undefined, { timeZone: "UTC", timeZoneName: "short" });
}
export function formatDateUTC(value: string | null | undefined) {
  if (!value) return "Date unavailable";
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? "Date unavailable" : date.toLocaleDateString(undefined, { timeZone: "UTC", year: "numeric", month: "short", day: "numeric" });
}
