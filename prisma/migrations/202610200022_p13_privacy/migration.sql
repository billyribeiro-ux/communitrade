-- P13 privacy export and recoverable account erasure.
ALTER TABLE privacy_request
  ADD COLUMN IF NOT EXISTS requested_at timestamptz(6) NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS hold_until timestamptz(6),
  ADD COLUMN IF NOT EXISTS request_reason varchar(500),
  ADD COLUMN IF NOT EXISTS created_at timestamptz(6) NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS stage text NOT NULL DEFAULT 'queued',
  ADD COLUMN IF NOT EXISTS progress jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS claimed_at timestamptz(6),
  ADD COLUMN IF NOT EXISTS claim_token uuid,
  ADD COLUMN IF NOT EXISTS attempts integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS failed_stage text,
  ADD COLUMN IF NOT EXISTS admin_reason text,
  ADD COLUMN IF NOT EXISTS updated_at timestamptz(6) NOT NULL DEFAULT now();
ALTER TABLE privacy_request ADD CONSTRAINT privacy_request_type_check CHECK(type IN ('export','deletion'));
ALTER TABLE privacy_request ADD CONSTRAINT privacy_request_status_check CHECK(status IN ('requested','queued','processing','held','failed','completed','cancelled'));
ALTER TABLE privacy_request ADD CONSTRAINT privacy_request_stage_check CHECK(stage IN ('queued','revoke','inventory','objects','private_data','public_derivatives','identity','complete','held'));
ALTER TABLE privacy_request ADD CONSTRAINT privacy_request_attempts_check CHECK(attempts >= 0);
CREATE INDEX privacy_request_owner_created_idx ON privacy_request(owner_user_id,requested_at DESC,id DESC);
CREATE INDEX privacy_request_work_idx ON privacy_request(status,updated_at) WHERE type='deletion' AND status IN ('queued','processing','failed');
CREATE UNIQUE INDEX privacy_request_active_deletion_idx ON privacy_request(owner_user_id) WHERE type='deletion' AND status NOT IN ('completed','cancelled');

-- Keyed digest only. The stable HMAC key is separately backed up and is never stored here.
CREATE TABLE privacy_deletion_suppression (
  subject_hmac text PRIMARY KEY CHECK(subject_hmac ~ '^[0-9a-f]{64}$'),
  key_version text NOT NULL,
  request_id uuid NOT NULL,
  deleted_at timestamptz(6) NOT NULL DEFAULT now(),
  created_at timestamptz(6) NOT NULL DEFAULT now()
);
CREATE INDEX privacy_deletion_suppression_request_idx ON privacy_deletion_suppression(request_id);

-- External object deletion is performed idempotently; rows remain until the storage confirms deletion.
CREATE TABLE privacy_deletion_object (
  request_id uuid NOT NULL,
  object_kind text NOT NULL CHECK(object_kind IN ('export','quarantine','processed_media','publication_snapshot')),
  object_key text NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','deleting','deleted','failed')),
  attempts integer NOT NULL DEFAULT 0 CHECK(attempts >= 0),
  last_error_code text,
  deleted_at timestamptz(6),
  created_at timestamptz(6) NOT NULL DEFAULT now(),
  updated_at timestamptz(6) NOT NULL DEFAULT now(),
  PRIMARY KEY(request_id,object_kind,object_key)
);
CREATE INDEX privacy_deletion_object_work_idx ON privacy_deletion_object(request_id,status,created_at);

-- Existing P10 export queue supports a full personal archive; content type is selected by kind.
ALTER TABLE export_job DROP CONSTRAINT IF EXISTS export_job_kind_check;
ALTER TABLE export_job ADD CONSTRAINT export_job_kind_check CHECK(kind IN ('personal_raw','journal_analytics','personal_archive'));
ALTER TABLE export_job DROP CONSTRAINT IF EXISTS export_job_object_key_check;
ALTER TABLE export_job ADD CONSTRAINT export_job_object_key_check CHECK (
  object_key IS NULL OR
  (kind='personal_archive' AND (object_key ~ ('^' || id::text || '-a[1-9][0-9]*[.]json$'))) OR
  (kind<>'personal_archive' AND (object_key = id::text || '.csv' OR object_key ~ ('^' || id::text || '-a[1-9][0-9]*[.]csv$')))
);

-- Allow only an in-flight privacy worker to erase immutable position event rows.
-- Publication versions and audit events remain immutable and are never changed by deletion.
DROP TRIGGER position_event_immutable ON position_event;
CREATE FUNCTION guard_position_event_privacy_erasure() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE request_id uuid;
BEGIN
  IF TG_OP='DELETE' THEN
    BEGIN request_id := current_setting('app.privacy_erasure_request',true)::uuid;
    EXCEPTION WHEN invalid_text_representation THEN request_id := NULL; END;
    IF request_id IS NOT NULL AND EXISTS (
      SELECT 1 FROM privacy_request r JOIN position p ON p.owner_user_id=r.owner_user_id
      WHERE r.id=request_id AND r.type='deletion' AND r.status='processing' AND r.stage='private_data' AND p.id=OLD.position_id
    ) THEN RETURN OLD; END IF;
  END IF;
  RAISE EXCEPTION 'position_event is append-only outside an authorized privacy erasure' USING ERRCODE='55000';
END;
$$;
CREATE TRIGGER position_event_immutable BEFORE UPDATE OR DELETE ON position_event
  FOR EACH ROW EXECUTE FUNCTION guard_position_event_privacy_erasure();

-- Allow narrowly scoped erasure of personal publication prose/chart content while retaining immutable trade terms and version chronology.
DROP TRIGGER publication_version_immutable ON publication_version;
CREATE FUNCTION guard_publication_version_privacy_redaction() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE request_id uuid;
BEGIN
  IF TG_OP='UPDATE' THEN
    BEGIN request_id := current_setting('app.privacy_erasure_request',true)::uuid;
    EXCEPTION WHEN invalid_text_representation THEN request_id := NULL; END;
    IF request_id IS NOT NULL
      AND NEW.id IS NOT DISTINCT FROM OLD.id
      AND NEW.publication_id IS NOT DISTINCT FROM OLD.publication_id
      AND NEW.sequence IS NOT DISTINCT FROM OLD.sequence
      AND NEW.previous_version_id IS NOT DISTINCT FROM OLD.previous_version_id
      AND NEW.created_at IS NOT DISTINCT FROM OLD.created_at
      AND NEW.terms = (OLD.terms - 'title' - 'plan') || jsonb_build_object('title','Deleted member','plan',
        COALESCE((SELECT jsonb_object_agg(k,v) FROM jsonb_each(CASE WHEN jsonb_typeof(OLD.terms->'plan')='object' THEN OLD.terms->'plan' ELSE '{}'::jsonb END) AS x(k,v)
          WHERE k=ANY(ARRAY['asset','strategy','quantity','entryPrice','initialStopPrice','entryFrom','entryUntil','expiration','multiplier','legs','instrument'])), '{}'::jsonb))
      AND NEW.thesis IS NULL AND NEW.chart IS NULL AND NEW.disclosures='{}'::jsonb
      AND EXISTS (
        SELECT 1 FROM privacy_request r JOIN publication p ON p.author_user_id=r.owner_user_id
        WHERE r.id=request_id AND r.type='deletion' AND r.status='processing' AND r.stage='public_derivatives'
          AND p.id=OLD.publication_id
      ) THEN RETURN NEW;
    END IF;
  END IF;
  RAISE EXCEPTION 'publication_version is immutable outside authorized privacy redaction' USING ERRCODE='55000';
END;
$$;
CREATE TRIGGER publication_version_immutable BEFORE UPDATE OR DELETE ON publication_version
  FOR EACH ROW EXECUTE FUNCTION guard_publication_version_privacy_redaction();

CREATE OR REPLACE FUNCTION reject_published_chart_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE request_id uuid;
BEGIN
  IF OLD.publication_version_id IS NOT NULL THEN
    IF TG_OP='UPDATE' THEN
      BEGIN request_id := current_setting('app.privacy_erasure_request',true)::uuid;
      EXCEPTION WHEN invalid_text_representation THEN request_id := NULL; END;
      IF request_id IS NOT NULL
        AND NEW.id IS NOT DISTINCT FROM OLD.id
        AND NEW.owner_user_id IS NOT DISTINCT FROM OLD.owner_user_id
        AND NEW.draft_id IS NOT DISTINCT FROM OLD.draft_id
        AND NEW.publication_version_id IS NOT DISTINCT FROM OLD.publication_version_id
        AND NEW.schema_version IS NOT DISTINCT FROM OLD.schema_version
        AND NEW.revision IS NOT DISTINCT FROM OLD.revision
        AND NEW.created_at IS NOT DISTINCT FROM OLD.created_at
        AND NEW.state='{"redacted":"privacy_erasure"}'::jsonb
        AND NEW.provenance='{"redacted":"privacy_erasure"}'::jsonb
        AND EXISTS (
          SELECT 1 FROM privacy_request r JOIN publication_version v ON v.id=OLD.publication_version_id
            JOIN publication p ON p.id=v.publication_id
          WHERE r.id=request_id AND r.type='deletion' AND r.status='processing' AND r.stage='public_derivatives'
            AND p.author_user_id=r.owner_user_id
        ) THEN RETURN NEW;
      END IF;
    END IF;
    RAISE EXCEPTION 'published chart snapshots are immutable outside authorized privacy redaction' USING ERRCODE='55000';
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;

-- Preserve moderation case chronology while removing the deleted reporter/appellant identity link.
ALTER TABLE report ALTER COLUMN reporter_user_id DROP NOT NULL;
ALTER TABLE appeal ALTER COLUMN appellant_user_id DROP NOT NULL;
