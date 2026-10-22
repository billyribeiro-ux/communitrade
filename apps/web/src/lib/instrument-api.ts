import { apiFetch, publicApiFetch } from "@/lib/server-api";
import { queryString, type InstrumentPage } from "@/lib/instruments";

// Keep server cookie access out of the client-safe instrument types/formatters.
export async function searchInstruments(q = "", asset = "", cursor = "") {
  return publicApiFetch<InstrumentPage>(`/instruments${queryString({ q, asset, cursor, limit: "20" })}`);
}

export async function searchMemberInstruments(q = "", asset = "", cursor = "") {
  return apiFetch<InstrumentPage>(`/instruments${queryString({ q, asset, cursor, limit: "20" })}`);
}
