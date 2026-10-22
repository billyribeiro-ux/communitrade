import { ImageResponse } from "next/og";
import { createElement } from "react";
import { isLocalPreview } from "@/lib/preview";

const shares: Record<string,{title:string;symbol:string}> = {
  "idea-demo-01": { title:"Defined-risk SPY scenario into a scheduled catalyst", symbol:"SPY · OPTIONS" },
  "idea-demo-02": { title:"Mapping MES levels without assuming a breakout", symbol:"MES · FUTURES" },
  "idea-demo-03": { title:"AAPL share scenario and risk", symbol:"AAPL · STOCKS" }
};
export async function GET(_request: Request,{params}:{params:Promise<{id:string;version:string}>}) {
  const {id,version}=await params;
  const headers = { "Cache-Control":"private, no-store", "X-Robots-Tag":"noindex, nofollow" };
  if(!isLocalPreview()) return new Response("Not found",{status:404,headers});
  const item=shares[id];
  if(!item || version!=="1") return new Response("Not found",{status:404,headers});
  const style = { width:"100%", height:"100%", display:"flex", flexDirection:"column", justifyContent:"space-between", padding:54, background:"#0B0D10", color:"#F3F5F7", fontFamily:"Arial" };
  const label = { display:"flex", fontSize:22, color:"#A8B3C2" };
  const content = { display:"flex", flexDirection:"column", gap:20 };
  const accent = { display:"flex", fontSize:22, color:"#8AB4FF" };
  const title = { display:"flex", fontSize:48, fontWeight:700, lineHeight:1.2 };
  const foot = { display:"flex", fontSize:18, color:"#F5C96A" };
  const tree = createElement("div", { style },
    createElement("div", { style: label }, "TRADING COMMUNITY · SYNTHETIC PREVIEW"),
    createElement("div", { style: content },
      createElement("div", { style: accent }, item.symbol),
      createElement("div", { style: title }, item.title),
      createElement("div", { style: label }, "Member-reported example · not verified · no live data")
    ),
    createElement("div", { style: foot }, `Illustrative share card · version ${version}`)
  );
  return new ImageResponse(tree, { width:1200, height:630, headers });
}
