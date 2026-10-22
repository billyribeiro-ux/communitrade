import type { Metadata } from "next"; import { publicMetadata } from "@/lib/site"; import { getPolicy } from "@/lib/policies"; import { InfoPage } from "../content";
const policy = getPolicy("terms");
export const metadata: Metadata = publicMetadata("/terms", `${policy.title} · Draft`, "Draft terms of use. Legal and operator approval is pending.");
export default function Page() { return <InfoPage slug="terms"/>; }
