import type { Metadata } from "next"; import { publicMetadata } from "@/lib/site"; import { PricingPage } from "../content";
export const metadata: Metadata = publicMetadata("/pricing", "Pricing", "Compare Free and Pro, including prices, quotas, and workflow features.");
export default PricingPage;
