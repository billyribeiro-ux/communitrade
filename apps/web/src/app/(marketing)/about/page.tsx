import type { Metadata } from "next"; import { publicMetadata } from "@/lib/site"; import { InfoPage } from "../content";
export const metadata: Metadata = publicMetadata("/about", "About Trading Community", "The product concept and preview status.");
export default function Page() { return <InfoPage slug="about"/>; }
