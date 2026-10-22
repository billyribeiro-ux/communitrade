import type { Metadata } from "next"; import { publicMetadata } from "@/lib/site"; import { InfoPage } from "../content";
export const metadata: Metadata = publicMetadata("/status", "Service status", "Current availability of the product preview and planned services.");
export default function Page() { return <InfoPage slug="status"/>; }
