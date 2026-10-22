-- Notification fanout uses the durable queue and needs an explicit queued state.
ALTER TABLE outbox_event DROP CONSTRAINT IF EXISTS outbox_status_check;
ALTER TABLE outbox_event ADD CONSTRAINT outbox_status_check
  CHECK (status IN ('pending','queued','processing','delivered','failed'));

ALTER TABLE notification
  ADD COLUMN text varchar(500) NOT NULL DEFAULT '',
  ADD COLUMN source_id uuid,
  ADD COLUMN event_count integer NOT NULL DEFAULT 1,
  ADD COLUMN last_activity_at timestamptz(6) NOT NULL DEFAULT now(),
  ADD CONSTRAINT notification_event_count_check CHECK (event_count > 0);

CREATE INDEX notification_owner_created_idx ON notification(owner_user_id, created_at DESC, id DESC);
CREATE INDEX notification_owner_unread_idx ON notification(owner_user_id, created_at DESC, id DESC) WHERE read_at IS NULL;

CREATE TABLE saved_search (
  id uuid PRIMARY KEY,
  owner_user_id uuid NOT NULL REFERENCES user_account(id) ON DELETE RESTRICT,
  name varchar(80) NOT NULL,
  filters jsonb NOT NULL,
  revision integer NOT NULL DEFAULT 1,
  created_at timestamptz(6) NOT NULL DEFAULT now(),
  updated_at timestamptz(6) NOT NULL DEFAULT now(),
  CONSTRAINT saved_search_name_check CHECK (length(btrim(name)) BETWEEN 1 AND 80),
  CONSTRAINT saved_search_revision_check CHECK (revision > 0),
  CONSTRAINT saved_search_filters_check CHECK (
    jsonb_typeof(filters) = 'object'
    AND (filters - ARRAY['q','asset','strategy','status','author','instrumentId']) = '{}'::jsonb
  )
);
CREATE UNIQUE INDEX saved_search_owner_name_idx ON saved_search(owner_user_id, lower(name));
CREATE INDEX saved_search_owner_created_idx ON saved_search(owner_user_id, created_at DESC, id DESC);

CREATE TABLE digest_suppression (
  owner_user_id uuid PRIMARY KEY REFERENCES user_account(id) ON DELETE RESTRICT,
  suppressed_at timestamptz(6),
  updated_at timestamptz(6) NOT NULL DEFAULT now()
);

CREATE TABLE email_suppression (
  owner_user_id uuid PRIMARY KEY REFERENCES user_account(id) ON DELETE RESTRICT,
  suppressed_at timestamptz(6) NOT NULL DEFAULT now(),
  reason varchar(80) NOT NULL,
  updated_at timestamptz(6) NOT NULL DEFAULT now(),
  CONSTRAINT email_suppression_reason_check CHECK (reason ~ '^[a-z][a-z0-9_]{0,79}$')
);

ALTER TABLE side_effect_delivery
  ADD COLUMN status varchar(16) NOT NULL DEFAULT 'pending',
  ADD COLUMN payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN max_attempts integer NOT NULL DEFAULT 5,
  ADD COLUMN next_attempt_at timestamptz(6) NOT NULL DEFAULT now(),
  ADD COLUMN first_attempt_at timestamptz(6),
  ADD COLUMN last_attempt_at timestamptz(6),
  ADD COLUMN claimed_at timestamptz(6),
  ADD COLUMN completed_at timestamptz(6),
  ADD COLUMN last_error_code varchar(100),
  ADD COLUMN owner_user_id uuid,
  ADD COLUMN category varchar(40),
  ADD COLUMN queue_job_id text,
  ADD COLUMN updated_at timestamptz(6) NOT NULL DEFAULT now(),
  ADD CONSTRAINT side_effect_delivery_status_check CHECK (status IN ('pending','queued','processing','succeeded','failed','suppressed','uncertain')),
  ADD CONSTRAINT side_effect_delivery_attempts_check CHECK (attempts >= 0 AND max_attempts BETWEEN 1 AND 10),
  ADD CONSTRAINT side_effect_delivery_error_check CHECK (last_error_code IS NULL OR last_error_code ~ '^[A-Z][A-Z0-9_]{1,99}$');
CREATE INDEX side_effect_delivery_ready_idx ON side_effect_delivery(channel, status, next_attempt_at);
CREATE INDEX side_effect_delivery_owner_idx ON side_effect_delivery(owner_user_id, created_at DESC);

CREATE TABLE product_event (
  id uuid PRIMARY KEY,
  owner_user_id uuid NOT NULL REFERENCES user_account(id) ON DELETE RESTRICT,
  event_name varchar(80) NOT NULL,
  source_key varchar(128) NOT NULL,
  properties jsonb NOT NULL DEFAULT '{}'::jsonb,
  consent_version varchar(64) NOT NULL,
  created_at timestamptz(6) NOT NULL DEFAULT now(),
  CONSTRAINT product_event_name_check CHECK (event_name IN ('activation','return','publication','review','report','conversion','churn')),
  CONSTRAINT product_event_source_key_check CHECK (source_key ~ '^[0-9a-f]{64}$'),
  CONSTRAINT product_event_properties_check CHECK (
    jsonb_typeof(properties) = 'object'
    AND (properties - ARRAY['asset','strategy','plan','surface']) = '{}'::jsonb
    AND octet_length(properties::text) <= 1024
  )
);
CREATE UNIQUE INDEX product_event_owner_source_idx ON product_event(owner_user_id, event_name, source_key);
CREATE INDEX product_event_created_idx ON product_event(created_at);
CREATE INDEX product_event_name_created_idx ON product_event(event_name, created_at);
