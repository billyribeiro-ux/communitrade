"use client";

import Link from "next/link";
import { Avatar } from "@trading/ui";
import { ChatCircle, ChartLineUp } from "@phosphor-icons/react";
import type { CommunityPublication, CommunityState, Viewer } from "@/lib/community";
import { AuthorActions, PublicationActions, RepostActions } from "./CommunityActions";
import { ShareMenu } from "@/components/sharing/ShareMenu";
import styles from "./community.module.css";

export function CommunityCard({ item, viewer }: { item: CommunityPublication; viewer: Viewer | null }) {
  const canonical = `/ideas/${item.id}/${item.slug}`;
  const actionState: CommunityState = {
    helpfulCount: item.reactions,
    commentCount: item.comments,
    viewer: item.viewer ?? null,
  };
  const displayAsset = item.instrument?.asset ?? item.asset;
  const instrumentLabel = item.instrument ? `${item.instrument.symbol}${item.instrument.contractMonth ? ` · ${item.instrument.contractMonth}` : ""}` : undefined;
  return <article className={styles.card}>
    {item.repost && <div className={styles.repost}><strong>Reposted by </strong><Link href={`/u/${item.repost.author.handle}`}>{item.repost.author.displayName} · @{item.repost.author.handle}</Link>{item.repost.commentary && <p>{item.repost.commentary}</p>}<RepostActions publicationId={item.id} returnPath={canonical} repostId={item.repost.id} repostAuthorId={item.repost.author.id} viewer={viewer}/></div>}
    <header className={styles.cardHeader}>
      <div className={styles.author}><Avatar name={item.author.displayName} src={item.author.avatarUrl} size="medium"/><span><Link className={styles.authorLink} href={`/u/${item.author.handle}`}>{item.author.displayName} · @{item.author.handle}</Link><br/><span className={styles.meta}>{item.author.pro ? "Pro member · " : ""}<time dateTime={item.publishedAt}>{new Intl.DateTimeFormat('en-US', { dateStyle: "medium", timeZone:'UTC' }).format(new Date(item.publishedAt))} UTC</time></span>{item.author.bio && <small className={styles.meta}>{item.author.bio}</small>}</span></div>
      <AuthorActions handle={item.author.handle} viewer={viewer}/>
      <span className={styles.badge}>Member reported</span>
    </header>
    <div className={styles.badges}>
      {instrumentLabel && <Link className={styles.badge} href={item.instrument ? `/instruments/${item.instrument.id}` : "#"}>{instrumentLabel}</Link>}
      {displayAsset && <span className={styles.badge}>{displayAsset}</span>}
      {item.kind === "education" ? <span className={styles.badge}>Education</span> : item.strategy && <span className={styles.badge}>{item.strategy.replaceAll("_", " ")}</span>}
      {item.kind !== "education" && <span className={styles.badge}>{item.state.replaceAll("_", " ")}</span>}
      {item.repost && <span className={styles.badge}>Original publication</span>}
    </div>
    <h2><Link href={canonical}>{item.title}</Link></h2>
    <p className={styles.excerpt}>{item.excerpt}</p>
    {item.thumbnailUrl && <Link href={canonical} aria-label={`Read ${item.title}`}><img className={styles.snapshot} src={item.thumbnailUrl} alt={`Frozen chart for ${item.title}, published ${item.publishedAt}`} loading="lazy"/></Link>}
    <div className={styles.actions}>
      <Link className={styles.actionButton} href={`${canonical}#discussion-heading`}><ChatCircle size={18}/> {item.comments} comments</Link>
      {item.instrument && <Link className={styles.actionButton} href={`/instruments/${item.instrument.id}`}><ChartLineUp size={18}/> Instrument</Link>}
      <PublicationActions publicationId={item.id} viewer={viewer} state={viewer&&!item.viewer?null:actionState} signInPath={`/login?returnTo=${encodeURIComponent(canonical)}`}/>
      <ShareMenu publicationId={item.id} title={item.title} authorHandle={item.author.handle} viewer={viewer ? { id: viewer.id, csrfToken: viewer.csrfToken } : null}/>
    </div>
  </article>;
}
