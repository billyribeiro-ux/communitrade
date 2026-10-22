import { notFound } from "next/navigation";
import { verifyPublicationRenderToken } from "@trading/media/snapshot-token";
import PublicationSnapshotRenderer from "@/components/charts/PublicationSnapshotRenderer";
import { projectPublicationRenderCandidate, validatePublicationRenderCandidate, type PublicationRenderCandidate } from "@/lib/publication-render-candidate";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const fetchCache = "force-no-store";
export const metadata = { robots: { index: false, follow: false }, referrer: "no-referrer" as const };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export default async function PublicationSnapshotPage({
  params,
  searchParams,
}: {
  params: Promise<{ jobId: string }>;
  searchParams: Promise<{ token?: string }>;
}) {
  const [{ jobId }, { token }] = await Promise.all([params, searchParams]);
  if (!UUID.test(jobId) || !token || token.length > 2048) notFound();
  const secret = process.env.PUBLICATION_RENDER_HMAC_SECRET;
  const apiOrigin = process.env.API_INTERNAL_URL;
  if (!secret || !apiOrigin) notFound();

  try {
    const claims = verifyPublicationRenderToken(secret, token);
    if (claims.jobId !== jobId) notFound();
    const apiUrl = new URL(`/api/v1/internal/publication-snapshot-jobs/${jobId}/claim`, apiOrigin);
    const response = await fetch(apiUrl, {
      method: "POST",
      headers: { accept: "application/json", "x-publication-render-token": token },
      cache: "no-store",
      redirect: "manual",
    });
    if (!response.ok) {console.warn(JSON.stringify({event:'snapshot.claim.unavailable',status:response.status}));notFound();}
    const payload: unknown = await response.json();
    if (!payload || typeof payload !== "object" || !("candidate" in payload)
        || !validatePublicationRenderCandidate(payload.candidate)) {console.warn(JSON.stringify({event:'snapshot.candidate.invalid'}));notFound();}
    const candidate: PublicationRenderCandidate = payload.candidate;
    if (candidate.jobId !== jobId || candidate.publicationVersionId !== claims.publicationVersionId) notFound();

    // Keep attachment storage references, author's prose, and any unrecognized API fields out of the browser payload.
    const browserCandidate = projectPublicationRenderCandidate(candidate);
    return <PublicationSnapshotRenderer candidate={browserCandidate} />;
  } catch {
    notFound();
  }
}
