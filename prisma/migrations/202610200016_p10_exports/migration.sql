ALTER TABLE export_job
  ALTER COLUMN expires_at TYPE TIMESTAMPTZ(6)
    USING CASE WHEN expires_at IS NULL THEN NULL ELSE expires_at AT TIME ZONE 'UTC' END,
  ADD COLUMN created_at TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  ADD COLUMN updated_at TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN claimed_at TIMESTAMPTZ(6),
  ADD COLUMN byte_size BIGINT,
  ADD COLUMN checksum TEXT,
  ADD COLUMN failure_code TEXT;

ALTER TABLE export_job
  ADD CONSTRAINT export_job_kind_check CHECK (kind IN ('personal_raw', 'journal_analytics', 'personal_archive')),
  ADD CONSTRAINT export_job_status_check CHECK (status IN ('pending', 'running', 'succeeded', 'failed', 'expired')),
  ADD CONSTRAINT export_job_attempts_check CHECK (attempts >= 0),
  ADD CONSTRAINT export_job_byte_size_check CHECK (byte_size IS NULL OR byte_size > 0),
  ADD CONSTRAINT export_job_checksum_check CHECK (checksum IS NULL OR checksum ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT export_job_object_key_check CHECK (object_key IS NULL OR object_key = id::text || '.csv');

CREATE INDEX export_job_owner_created_idx ON export_job(owner_user_id, created_at DESC, id DESC);
CREATE INDEX export_job_status_updated_idx ON export_job(status, updated_at);
CREATE INDEX export_job_expiry_idx ON export_job(expires_at) WHERE expires_at IS NOT NULL;
