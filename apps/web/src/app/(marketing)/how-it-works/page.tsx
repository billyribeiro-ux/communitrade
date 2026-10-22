import type { Metadata } from "next"; import { publicMetadata } from "@/lib/site"; import { InfoPage } from "../content";
export const metadata: Metadata = publicMetadata("/how-it-works", "How it works", "Discover, plan, annotate, publish, discuss, report, and review trade ideas.");
export default function Page() { return <InfoPage slug="how-it-works"/>; }
