import type { Metadata } from "next"; import { publicMetadata } from "@/lib/site"; import { InfoPage } from "../content";
export const metadata: Metadata = publicMetadata("/features", "Features", "Explore publishing, discussion, transparent history, and private journal features.");
export default function Page() { return <InfoPage slug="features"/>; }
