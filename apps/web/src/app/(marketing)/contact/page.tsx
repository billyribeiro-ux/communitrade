import type { Metadata } from "next"; import { publicMetadata } from "@/lib/site"; import { InfoPage } from "../content";
export const metadata: Metadata = publicMetadata("/contact", "Contact", "Send a product support request and receive a request reference.");
export default function Page() { return <InfoPage slug="contact"/>; }
