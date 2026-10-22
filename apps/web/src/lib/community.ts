import type { components } from "@trading/contracts";

export type CommunityUser = components["schemas"]["UserSummary"];
export type CommunityPublication = components["schemas"]["PublicationSummary"] & {
  author: components["schemas"]["UserSummary"] & { bio?: string };
  viewer?: { helpful: boolean; bookmarked: boolean; reposted: boolean; repostId: string | null; commentary: string | null };
  repost?: { id: string; author: components["schemas"]["UserSummary"]; commentary: string; createdAt: string };
};
export type CommunityPage = components["schemas"]["PublicationPage"];
export type CommunityRepost = components["schemas"]["Repost"] & { publication?: CommunityPublication };
export type CommunityRepostPage = { items: CommunityRepost[]; nextCursor: string | null };
export type CommunityComment = components["schemas"]["Comment"] & {
  rootId?: string;
  replyToAuthorHandle?: string | null;
  mentions?: Array<{ id: string; handle: string; displayName: string }>;
};
export type CommentPage = { items: CommunityComment[]; nextCursor: string | null };
export type CommunityState = {
  helpfulCount: number;
  commentCount: number;
  viewer: { helpful: boolean; bookmarked: boolean; reposted: boolean; repostId: string | null; commentary: string | null } | null;
};
export type Viewer = { id: string; handle: string; displayName: string; avatarUrl: string | null; pro?: boolean; csrfToken: string };

export function publicationActionPath(publicationId: string, action: 'helpful' | 'bookmark') {
  return `/publications/${publicationId}/${action === 'helpful' ? 'reaction' : 'bookmark'}`;
}

export class CommunityError extends Error {
  readonly status: number;
  constructor(status: number, message: string) { super(message); this.status=status; }
}

/** Browser requests use same-origin cookies and never retain community data. */
export async function communityRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set("Accept", "application/json");
  if (init.body !== undefined) headers.set("Content-Type", "application/json");
  const response = await fetch(`/api/v1${path}`, {
    ...init,
    headers,
    credentials: "same-origin",
    cache: "no-store",
    redirect: "error",
    signal: init.signal ?? AbortSignal.timeout(20_000),
  });
  if (response.status === 204) return undefined as T;
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    const detail = typeof data?.detail === "string" ? data.detail : typeof data?.title === "string" ? data.title : "This community action could not be completed.";
    const message = response.status === 401 ? "Your session expired. Sign in again to continue." : response.status === 409 ? "This record changed. Reload it and try again." : detail;
    throw new CommunityError(response.status, message);
  }
  return data as T;
}

export function commentHeaders(viewer: Viewer, idempotent = false, revision?: number, key?: string): HeadersInit {
  return {
    "X-CSRF-Token": viewer.csrfToken,
    ...(idempotent ? { "Idempotency-Key": key ?? crypto.randomUUID() } : {}),
    ...(revision !== undefined ? { "If-Match": `"${revision}"` } : {}),
  };
}

export type IdempotencyAttempt = { payload: string; key: string };
export function idempotencyAttempt(previous: IdempotencyAttempt | null, payload: string, makeKey: () => string = () => crypto.randomUUID()): IdempotencyAttempt {
  return previous?.payload === payload ? previous : { payload, key: makeKey() };
}

export function communityDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return "Recently";
  return new Intl.DateTimeFormat('en-US', { dateStyle: "medium", timeStyle: "short", timeZone:'UTC' }).format(date)+' UTC';
}

/** Flatten replies to their original root while keeping replyToId untouched for writes. */
export function flattenComments(items: CommunityComment[]) {
  const byId = new Map(items.map(item => [item.id, item]));
  const roots = new Map<string, { root: CommunityComment; replies: CommunityComment[] }>();
  for (const item of items) {
    let rootId = item.rootId ?? null;
    let ancestor: CommunityComment | undefined = item;
    const visited = new Set<string>([item.id]);
    while (!rootId && ancestor?.replyToId && !visited.has(ancestor.replyToId)) {
      visited.add(ancestor.replyToId);
      const parent = byId.get(ancestor.replyToId);
      if (!parent) { rootId = ancestor.replyToId; break; }
      if (parent.rootId) { rootId = parent.rootId; break; }
      ancestor = parent;
      if (!ancestor.replyToId) rootId = ancestor.id;
    }
    rootId ??= item.id;
    const root = byId.get(rootId) ?? item;
    if (!roots.has(root.id)) roots.set(root.id, { root, replies: [] });
    if (root.id !== item.id) roots.get(root.id)!.replies.push(item);
  }
  return [...roots.values()];
}

export function withCommunityQuery(path: string, values: Record<string, string | undefined>) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) if (value) params.set(key, value);
  const query = params.toString();
  return query ? `${path}?${query}` : path;
}
