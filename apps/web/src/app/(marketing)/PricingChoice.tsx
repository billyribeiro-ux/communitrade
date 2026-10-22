"use client";
import { useState } from "react";
import Link from "next/link";
import styles from "./marketing.module.css";
import type { SiteAccountState } from "@/components/SiteHeader";
import { savePlanIntent } from "../(account)/actions";

export function PricingChoice({ accountState = "anonymous" }: { accountState?: SiteAccountState }) {
  const [interval, setInterval] = useState<"month" | "year">("month");
  const annual = interval === "year";
  return <section className={styles.priceCards} aria-label="Plan prices">
    <article className={styles.price}><p className={styles.eyebrow}>Free</p><strong>$0</strong><p>Core community, delayed data, charts, and private journal.</p>{accountState === "anonymous" ? <form action={savePlanIntent}><input type="hidden" name="plan" value="free"/><input type="hidden" name="interval" value="month"/><input type="hidden" name="returnTo" value="/app"/><input type="hidden" name="screen" value="signup"/><button className={styles.buttonSecondary} type="submit">Create free account</button></form> : <Link className={styles.buttonSecondary} href="/app">Open workspace</Link>}</article>
    <article className={styles.price}>
      <div className={styles.toggle} role="group" aria-label="Pro billing interval"><button type="button" aria-pressed={!annual} onClick={() => setInterval("month")}>Monthly</button><button type="button" aria-pressed={annual} onClick={() => setInterval("year")}>Annual</button></div>
      <p className={styles.eyebrow}>Pro</p><strong>{annual ? "$290" : "$29"}<span className={styles.pricePeriod}>{annual ? "/year" : "/month"}</span></strong><p>Before applicable taxes{annual ? ". Charged annually." : "."}</p>{accountState === "anonymous" ? <form action={savePlanIntent}><input type="hidden" name="plan" value="pro"/><input type="hidden" name="interval" value={interval}/><input type="hidden" name="returnTo" value={`/subscribe?plan=pro&interval=${interval}`}/><input type="hidden" name="screen" value="signup"/><button className={styles.button} type="submit">Choose {annual ? "annual" : "monthly"}</button></form> : <Link className={styles.button} href="/app/billing">{accountState === "pro" ? "Manage Pro plan" : "View billing options"}</Link>}
    </article>
  </section>;
}
