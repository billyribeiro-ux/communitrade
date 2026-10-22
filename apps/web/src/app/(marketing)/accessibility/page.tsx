import type { Metadata } from "next"; import { publicMetadata } from "@/lib/site"; import { getPolicy } from "@/lib/policies"; import { InfoPage } from "../content";
const policy = getPolicy("accessibility");
export const metadata: Metadata = publicMetadata("/accessibility", policy.title, "Accessibility approach and preview status.");
export default function Page() { return <InfoPage slug="accessibility"/>; }
