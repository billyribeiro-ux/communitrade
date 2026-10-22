"use client";

import Link from "next/link";
import { List } from "@phosphor-icons/react";
import { useState } from "react";
import { Dialog } from "@trading/ui";
import { ThemeToggle } from "./ThemeToggle";
import styles from "./SiteHeader.module.css";

export type SiteAccountState = "anonymous" | "member" | "pro";
type SiteHeaderProps = { accountState?: SiteAccountState };
const links = [["Features", "/features"], ["Instrument lookup", "/instruments"], ["How it works", "/how-it-works"], ["Pricing", "/pricing"], ["FAQ", "/faq"]] as const;

function NavLinks({ close }: { close?: () => void }) {
  return <>{links.map(([label, href]) => <Link href={href} key={href} {...(close ? { onClick: close } : {})}>{label}</Link>)}</>;
}

export function SiteHeader({ accountState = "anonymous" }: SiteHeaderProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const loggedIn = accountState !== "anonymous";
  return <>
    <header className={styles.header}>
      <Link aria-label="Trading Community home" className={styles.brand} href="/">Trading <span>Community</span></Link>
      <nav aria-label="Main navigation" className={styles.desktopNav}><NavLinks /></nav>
      <div className={styles.actions}><ThemeToggle /><Link className={styles.login} href={loggedIn ? "/app" : "/login"}>{loggedIn ? "Workspace" : "Log in"}</Link><Link className={styles.cta} href={loggedIn ? "/app" : "/signup"}>{accountState === "pro" ? "Open workspace" : loggedIn ? "Go to workspace" : "Create free account"}</Link></div>
      <button aria-label={menuOpen ? "Close navigation" : "Open navigation"} className={styles.menuButton} onClick={() => setMenuOpen(true)} type="button"><List aria-hidden="true" size={24} /></button>
    </header>
    <Dialog description="Navigate Trading Community" onOpenChange={setMenuOpen} open={menuOpen} title="Menu" closeLabel="Close menu">
      <nav aria-label="Mobile navigation" className={styles.mobileNav}>
        <NavLinks close={() => setMenuOpen(false)} />
        <Link href={loggedIn ? "/app" : "/login"} onClick={() => setMenuOpen(false)}>{loggedIn ? "Workspace" : "Log in"}</Link>
        <Link className={styles.mobileCta} href={loggedIn ? "/app" : "/signup"} onClick={() => setMenuOpen(false)}>{loggedIn ? "Go to workspace" : "Create free account"}</Link>
        <div className={styles.mobileTheme}><span>Color theme</span><ThemeToggle /></div>
      </nav>
    </Dialog>
  </>;
}
