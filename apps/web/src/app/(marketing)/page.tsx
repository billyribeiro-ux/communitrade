import type { Metadata } from "next";
import { publicMetadata } from "@/lib/site";
import { HomePage } from "./content";
export const metadata: Metadata = publicMetadata("/", "Trade ideas with a history you can inspect", "Publish stock, options, and futures plans, discuss the reasoning, and review member-reported outcomes.");
export default HomePage;
