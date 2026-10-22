import type { Metadata } from "next"; import { publicMetadata } from "@/lib/site"; import { getPolicy } from "@/lib/policies"; import { InfoPage } from "../content";
const policy = getPolicy("community-guidelines");
export const metadata: Metadata = publicMetadata("/community-guidelines", `${policy.title} · Draft`, "Draft community standards. Moderation and appeal terms are pending review.");
export default function Page() { return <InfoPage slug="community-guidelines"/>; }
