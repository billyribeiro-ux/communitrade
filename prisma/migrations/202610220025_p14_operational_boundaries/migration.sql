-- Shared replay protection across API replicas. No address, cookie or payload is retained.
CREATE TABLE trusted_ingress_nonce (
  nonce varchar(128) PRIMARY KEY,
  expires_at timestamptz(6) NOT NULL
);
CREATE INDEX trusted_ingress_nonce_expiry_idx ON trusted_ingress_nonce(expires_at);

CREATE TABLE email_webhook_event (
  provider varchar(20) NOT NULL,
  event_id varchar(200) NOT NULL,
  payload_hash char(64) NOT NULL,
  event_type varchar(80) NOT NULL,
  received_at timestamptz(6) NOT NULL DEFAULT now(),
  PRIMARY KEY(provider,event_id)
);
CREATE INDEX email_webhook_event_retention_idx ON email_webhook_event(received_at);

-- Includes anonymous support recipients without retaining a new plaintext address.
CREATE TABLE email_address_suppression (
  email_hash char(64) PRIMARY KEY,
  reason varchar(80) NOT NULL CHECK(reason IN ('provider_hard_bounce','provider_complaint')),
  suppressed_at timestamptz(6) NOT NULL DEFAULT now()
);
