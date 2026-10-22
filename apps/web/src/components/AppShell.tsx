"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { ChartBar, Compass, House, Notebook, MagnifyingGlass, PlusCircle, UserCircle, UsersThree, Flag, GearSix, DotsThree } from "@phosphor-icons/react";
import type { Icon as PhosphorIcon } from "@phosphor-icons/react";
import { useState, type ReactNode } from "react";
import { Avatar, Dialog } from "@trading/ui";
import { PreviewBanner } from "./PreviewBanner";
import { ThemeToggle } from "./ThemeToggle";
import { SignOutButton } from "@/app/(account)/AccountActions";
import styles from "./AppShell.module.css";

type AppShellProps = { children: ReactNode; staff?: boolean; staffRole?: "admin" | "moderator"; member?: { handle: string; displayName: string; avatarUrl: string | null; pro: boolean; unreadNotifications?: number }; csrfToken?: string };
const memberLinks: { href: string; label: string; icon: PhosphorIcon }[] = [
  { href: "/app", label: "Dashboard", icon: House }, { href: "/app/feed", label: "Feed", icon: UsersThree },
  { href: "/app/explore", label: "Explore", icon: Compass }, { href: "/app/publish", label: "Publish an idea", icon: PlusCircle },
  { href: "/app/drafts", label: "Drafts", icon: Notebook }, { href: "/app/journal", label: "Journal", icon: Notebook },
  { href: "/app/journal/new", label: "New journal entry", icon: PlusCircle }, { href: "/app/journal/analytics", label: "Journal analytics", icon: ChartBar },
  { href: "/app/watchlists", label: "Watchlists", icon: ChartBar }, { href: "/app/bookmarks", label: "Bookmarks", icon: MagnifyingGlass },
  { href: "/app/layouts", label: "Saved layouts", icon: ChartBar }, { href: "/app/notifications", label: "Notifications", icon: Flag }, { href: "/app/reports", label: "Your reports", icon: Flag }, { href: "/app/support", label: "Support requests", icon: Flag },
  { href: "/app/profile", label: "Profile", icon: UserCircle }, { href: "/app/billing", label: "Plan and billing", icon: GearSix },
  { href: "/app/settings", label: "Settings", icon: GearSix }, { href: "/app/settings/security", label: "Security settings", icon: GearSix },
  { href: "/app/settings/preferences", label: "Preferences", icon: GearSix }, { href: "/app/settings/privacy", label: "Privacy settings", icon: GearSix }
];
const staffLinks = [
  { href: "/admin", label: "Overview" }, { href: "/admin/reports", label: "Reports" }, { href: "/admin/appeals", label: "Appeals" },
  { href: "/admin/corrections", label: "Corrections" }, { href: "/admin/users", label: "Users" }, { href: "/admin/instruments", label: "Instruments" },
  { href: "/admin/data", label: "Data status" }, { href: "/admin/billing", label: "Billing" }, { href: "/admin/editorial", label: "Editorial" }, { href: "/admin/support", label: "Support" },
  { href: "/admin/jobs", label: "Jobs" }, { href: "/admin/audit", label: "Audit" }, { href: "/admin/privacy", label: "Privacy requests" }
];

export function AppShell({ children, staff = false, staffRole = "admin", member, csrfToken }: AppShellProps) {
  const pathname = usePathname();
  const [moreOpen, setMoreOpen] = useState(false);
  const visibleStaffLinks = staffRole === "moderator" ? staffLinks.filter(({ href }) => ["/admin", "/admin/reports", "/admin/appeals", "/admin/corrections", "/admin/audit"].includes(href)) : staffLinks;
  const items: { href: string; label: string; icon: PhosphorIcon }[] = staff ? visibleStaffLinks.map(({ href, label }) => ({ href, label, icon: Flag })) : memberLinks;
  const mobileItems = items.slice(0, 5);
  const currentItem = items.filter(({ href }) => pathname === href || (href !== (staff ? "/admin" : "/app") && pathname.startsWith(`${href}/`))).sort((a, b) => b.href.length - a.href.length)[0];
  return <div className={styles.root}>
    <PreviewBanner />
    <header className={styles.topbar}><Link aria-label="Trading Community dashboard" className={styles.brand} href="/app">TC<span>Trading Community</span></Link><span className={styles.section}>{staff ? "Staff workspace" : "Member workspace"}</span><div className={styles.topActions}><ThemeToggle /><Link className={styles.account} href="/app/profile"><Avatar name={member?.displayName ?? "Member"} {...(member?.avatarUrl === undefined ? {} : { src: member.avatarUrl })} size="small" /><span>{member?.displayName ?? "My account"}</span></Link>{csrfToken && <div className={styles.logout}><SignOutButton csrfToken={csrfToken}/></div>}</div></header>
    <a className="skip-link" href="#main-content">Skip to content</a>
    <div className={styles.layout}>
      <aside aria-label={staff ? "Staff navigation" : "Workspace navigation"} className={styles.sidebar}>
        <nav>{items.map((item) => {
          const Icon = item.icon;
          const active = currentItem?.href === item.href;
          return <Link aria-current={active ? "page" : undefined} href={item.href} key={item.href}><Icon aria-hidden="true" size={19} /><span>{item.label}</span>{!staff && item.href === "/app/notifications" && (member?.unreadNotifications ?? 0) > 0 && <span className={styles.badge}>{member!.unreadNotifications! > 99 ? "99+" : member!.unreadNotifications}</span>}</Link>;
        })}</nav>
        {!staff ? <Link className={styles.staffLink} href="/admin">Staff tools</Link> : <Link className={styles.staffLink} href="/app">Member workspace</Link>}
      </aside>
      <main className={styles.main} id="main-content" tabIndex={-1}>{children}</main>
    </div>
    <nav aria-label="Primary workspace navigation" className={styles.bottomNav}>{mobileItems.slice(0, 4).map(({ href, label, icon: Icon }) => <Link aria-current={currentItem?.href === href ? "page" : undefined} href={href} key={href}><Icon aria-hidden="true" size={20} /><span>{label === "Publish an idea" ? "Publish" : label}</span></Link>)}<button aria-expanded={moreOpen} onClick={() => setMoreOpen(true)} type="button"><DotsThree aria-hidden="true" size={20} /><span>More</span></button></nav>
    <Dialog description={`More ${staff ? "staff" : "workspace"} pages`} onOpenChange={setMoreOpen} open={moreOpen} title="More pages">
      <nav aria-label="More workspace pages" className={styles.moreLinks}>{items.slice(4).map(({ href, label, icon: Icon }) => <Link href={href} key={href} onClick={() => setMoreOpen(false)}><Icon aria-hidden="true" size={19} />{label}</Link>)}</nav>
    </Dialog>
  </div>;
}
