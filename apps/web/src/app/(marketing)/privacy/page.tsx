import type { Metadata } from "next"; import { publicMetadata } from "@/lib/site"; import { getPolicy } from "@/lib/policies"; import { InfoPage } from "../content";
const policy = getPolicy("privacy");
export const metadata: Metadata = publicMetadata("/privacy", `${policy.title} · Draft`, "Draft privacy notice. Data inventory and legal review are pending.");
export default function Page() { return <InfoPage slug="privacy"/>; }
