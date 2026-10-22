import type { Metadata } from "next"; import { publicMetadata } from "@/lib/site"; import { InfoPage } from "../content";
export const metadata: Metadata = publicMetadata("/risk-disclosure", "Risk disclosure", "Trading risks, member-reported outcomes, delayed data, and service limitations.");
export default function Page() { return <InfoPage slug="risk-disclosure"/>; }
