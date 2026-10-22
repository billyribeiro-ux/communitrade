import type { Metadata } from "next"; import { publicMetadata } from "@/lib/site"; import { FAQPage } from "../content";
export const metadata: Metadata = publicMetadata("/faq", "Frequently asked questions", "Answers about data delays, member-reported outcomes, supported strategies, privacy, and launch boundaries.");
export default FAQPage;
