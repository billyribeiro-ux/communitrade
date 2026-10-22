ALTER TABLE draft ADD COLUMN attachment_ids JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE draft ADD CONSTRAINT draft_attachment_ids_check CHECK (CASE
  WHEN jsonb_typeof(attachment_ids) = 'array' THEN jsonb_array_length(attachment_ids) <= 3
  ELSE false END);

ALTER TABLE media ADD COLUMN resource_type TEXT;
ALTER TABLE media ADD CONSTRAINT media_resource_type_check CHECK (resource_type IS NULL OR resource_type IN ('draft','publication'));
ALTER TABLE media ADD CONSTRAINT media_draft_attachment_target_check CHECK (
  purpose <> 'publication_attachment' OR resource_type IS DISTINCT FROM 'draft' OR resource_id IS NOT NULL
);
CREATE INDEX media_draft_attachment_idx ON media(owner_user_id, resource_id, created_at)
  WHERE purpose='publication_attachment' AND resource_type='draft';

ALTER TABLE position_event ADD COLUMN details JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE position_event ADD CONSTRAINT position_event_details_object_check CHECK (jsonb_typeof(details) = 'object');
ALTER TABLE position_event DROP CONSTRAINT position_event_type_check;
ALTER TABLE position_event ADD CONSTRAINT position_event_type_check CHECK (type IN ('entry','partial_exit','final_exit','cancel','never_entered','review','resolution','correction','exception'));
ALTER TABLE correction_request ADD COLUMN review_reason TEXT;

CREATE TABLE publication_job (
  id UUID PRIMARY KEY,
  owner_user_id UUID NOT NULL REFERENCES user_account(id) ON DELETE RESTRICT,
  draft_id UUID NOT NULL REFERENCES draft(id) ON DELETE RESTRICT,
  publication_id UUID NOT NULL REFERENCES publication(id) ON DELETE RESTRICT,
  publication_version_id UUID NOT NULL REFERENCES publication_version(id) ON DELETE RESTRICT,
  status TEXT NOT NULL,
  candidate JSONB NOT NULL,
  render_nonce UUID NOT NULL,
  render_nonce_expires_at TIMESTAMPTZ(6) NOT NULL,
  render_claimed_at TIMESTAMPTZ(6),
  snapshot_object_key TEXT,
  snapshot_checksum TEXT,
  snapshot_width INTEGER,
  snapshot_height INTEGER,
  snapshot_mime TEXT,
  failure_code TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT publication_job_status_check CHECK (status IN ('pending','running','succeeded','failed')),
  CONSTRAINT publication_job_candidate_object_check CHECK (jsonb_typeof(candidate)='object'),
  CONSTRAINT publication_job_attempts_check CHECK (attempts >= 0),
  CONSTRAINT publication_job_failure_code_check CHECK (failure_code IS NULL OR length(failure_code) BETWEEN 1 AND 100),
  CONSTRAINT publication_job_snapshot_metadata_check CHECK (
    (snapshot_object_key IS NULL AND snapshot_checksum IS NULL AND snapshot_width IS NULL AND snapshot_height IS NULL AND snapshot_mime IS NULL)
    OR (snapshot_object_key IS NOT NULL AND snapshot_checksum ~ '^[0-9a-f]{64}$' AND snapshot_width=1200 AND snapshot_height=760 AND snapshot_mime='image/webp')
  )
);
CREATE INDEX publication_job_owner_created_idx ON publication_job(owner_user_id, created_at DESC);
CREATE INDEX publication_job_status_created_idx ON publication_job(status, created_at);
CREATE INDEX publication_job_draft_created_idx ON publication_job(draft_id, created_at DESC);

CREATE FUNCTION publication_job_immutable_candidate() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.owner_user_id IS DISTINCT FROM OLD.owner_user_id
    OR NEW.draft_id IS DISTINCT FROM OLD.draft_id OR NEW.publication_id IS DISTINCT FROM OLD.publication_id
    OR NEW.publication_version_id IS DISTINCT FROM OLD.publication_version_id OR NEW.candidate IS DISTINCT FROM OLD.candidate
    OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'publication job candidate is immutable';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER publication_job_candidate_immutable BEFORE UPDATE ON publication_job
  FOR EACH ROW EXECUTE FUNCTION publication_job_immutable_candidate();

CREATE FUNCTION draft_attachments_only_ready_owner_draft() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.attachment_ids IS DISTINCT FROM OLD.attachment_ids AND EXISTS (
    SELECT 1 FROM jsonb_array_elements_text(NEW.attachment_ids) AS attachment(id)
    LEFT JOIN media m ON m.id=attachment.id::uuid AND m.owner_user_id=NEW.owner_user_id
      AND m.purpose='publication_attachment' AND m.resource_type='draft' AND m.resource_id=NEW.id
      AND m.status='ready' AND m.processed_key IS NOT NULL
    WHERE m.id IS NULL
  ) THEN
    RAISE EXCEPTION 'draft attachment must be a ready owned image assigned to this draft';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER draft_attachments_ready_before_update BEFORE UPDATE OF attachment_ids ON draft
  FOR EACH ROW EXECUTE FUNCTION draft_attachments_only_ready_owner_draft();

CREATE FUNCTION publication_attachment_binding_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.purpose='publication_attachment' AND OLD.resource_type='draft' AND NEW.resource_type='publication' THEN
    IF NEW.owner_user_id IS DISTINCT FROM OLD.owner_user_id OR NEW.id IS DISTINCT FROM OLD.id OR NEW.purpose IS DISTINCT FROM OLD.purpose
      OR NEW.status IS DISTINCT FROM 'ready' OR NEW.resource_id IS NULL OR NOT EXISTS (
        SELECT 1 FROM publication p WHERE p.id=NEW.resource_id AND p.author_user_id=NEW.owner_user_id
      ) THEN
      RAISE EXCEPTION 'draft attachment can only bind to its owner publication after processing';
    END IF;
  ELSIF NEW.resource_type IS DISTINCT FROM OLD.resource_type OR NEW.resource_id IS DISTINCT FROM OLD.resource_id THEN
    RAISE EXCEPTION 'media resource binding is immutable';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER media_resource_binding_immutable BEFORE UPDATE OF resource_type,resource_id ON media
  FOR EACH ROW EXECUTE FUNCTION publication_attachment_binding_guard();
