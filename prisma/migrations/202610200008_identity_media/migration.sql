-- P04: additive identity replay/consent evidence and bounded upload lifecycle.
CREATE TABLE oidc_logout_replay (
 issuer TEXT NOT NULL,
 jti TEXT NOT NULL,
 expires_at TIMESTAMPTZ(6) NOT NULL,
 PRIMARY KEY(issuer,jti)
);
CREATE INDEX oidc_logout_replay_expiry_idx ON oidc_logout_replay(expires_at);
CREATE TABLE policy_acceptance (
 id UUID PRIMARY KEY,
 user_id UUID NOT NULL REFERENCES user_account(id) ON DELETE RESTRICT,
 policy_slug TEXT NOT NULL,
 version TEXT NOT NULL,
 accepted_at TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
 UNIQUE(user_id,policy_slug,version)
);
ALTER TABLE media
 ADD COLUMN declared_mime TEXT,
 ADD COLUMN byte_size INTEGER,
 ADD COLUMN expires_at TIMESTAMPTZ(6),
 ADD COLUMN failure_code TEXT,
 ADD COLUMN updated_at TIMESTAMPTZ(6) NOT NULL DEFAULT now();
ALTER TABLE media ADD CONSTRAINT media_upload_byte_bound CHECK (byte_size IS NULL OR byte_size BETWEEN 1 AND 2097152);
ALTER TABLE media ADD CONSTRAINT media_declared_mime_allowlist CHECK (declared_mime IS NULL OR declared_mime IN ('image/png','image/jpeg','image/webp'));
CREATE INDEX media_owner_status_idx ON media(owner_user_id,status);
CREATE INDEX media_expiry_idx ON media(expires_at);
CREATE INDEX app_session_provider_sid_idx ON app_session(provider_session_id);
