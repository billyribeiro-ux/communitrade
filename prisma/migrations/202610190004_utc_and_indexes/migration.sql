-- Preserve UTC interpretation while normalizing the remaining naive timestamps.
ALTER TABLE subscription ALTER COLUMN grace_until TYPE TIMESTAMPTZ(6)
  USING CASE WHEN grace_until IS NULL THEN NULL ELSE grace_until AT TIME ZONE 'UTC' END;
ALTER TABLE export_job ALTER COLUMN expires_at TYPE TIMESTAMPTZ(6)
  USING CASE WHEN expires_at IS NULL THEN NULL ELSE expires_at AT TIME ZONE 'UTC' END;

-- Search is limited to frozen publication-version text; query paths still join
-- through publication visibility before presenting any hit.
CREATE INDEX publication_version_public_search_idx ON publication_version USING GIN
  (to_tsvector('english', coalesce(terms->>'title','') || ' ' || coalesce(thesis,'')));

-- Include all unfinished outbox states for claim/retry scans and exclude delivered rows.
DROP INDEX outbox_pending_delivery_idx;
CREATE INDEX outbox_pending_delivery_idx ON outbox_event(status, available_at, created_at)
  WHERE status IN ('pending','processing','failed');
