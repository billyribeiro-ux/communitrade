-- Billing truth stays provider scoped. Operations are durable before provider writes.
ALTER TABLE subscription
  DROP CONSTRAINT IF EXISTS subscription_provider_subscription_id_key,
  ADD COLUMN plan varchar(32),
  ADD COLUMN interval varchar(16),
  ADD COLUMN current_period_start timestamptz(6),
  ADD COLUMN current_period_end timestamptz(6),
  ADD COLUMN cancel_at_period_end boolean NOT NULL DEFAULT false,
  ADD COLUMN canceled_at timestamptz(6),
  ADD COLUMN provider_account varchar(200) NOT NULL DEFAULT 'default',
  ADD COLUMN last_reconciled_at timestamptz(6),
  ADD COLUMN reason varchar(500),
  ADD CONSTRAINT subscription_mode_check CHECK (mode IN ('test','live')),
  ADD CONSTRAINT subscription_interval_check CHECK (interval IS NULL OR interval IN ('monthly','annual')),
  ADD CONSTRAINT subscription_plan_check CHECK (plan IS NULL OR plan IN ('pro_month','pro_year')),
  ADD CONSTRAINT subscription_status_check CHECK (length(provider_status) BETWEEN 1 AND 100);
DROP INDEX IF EXISTS subscription_provider_subscription_id_key;
CREATE UNIQUE INDEX subscription_provider_scope_idx ON subscription(provider_account,mode,provider_subscription_id);
CREATE INDEX subscription_user_current_idx ON subscription(user_id,last_reconciled_at DESC NULLS LAST);

ALTER TABLE billing_event
  ADD COLUMN event_type varchar(120),
  ADD COLUMN object_status varchar(100),
  ADD COLUMN provider_customer_id varchar(255),
  ADD COLUMN provider_subscription_id varchar(255),
  ADD COLUMN provider_invoice_id varchar(255),
  ADD COLUMN payment_id varchar(255),
  ADD COLUMN created_at timestamptz(6) NOT NULL DEFAULT now(),
  ADD COLUMN reconciled_at timestamptz(6),
  ADD COLUMN reason varchar(500),
  ADD COLUMN attempts integer NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 5),
  ADD COLUMN next_attempt_at timestamptz(6) NOT NULL DEFAULT now(),
  ADD CONSTRAINT billing_event_mode_check CHECK (mode IN ('test','live')),
  ADD CONSTRAINT billing_event_status_check CHECK (reconciliation_status IN ('received','processing','reconciled','ignored','failed'));
CREATE INDEX billing_event_pending_idx ON billing_event(created_at) WHERE reconciliation_status IN ('received','processing','failed');

CREATE TABLE billing_invoice (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES user_account(id) ON DELETE RESTRICT,
  provider_account varchar(200) NOT NULL,
  mode varchar(8) NOT NULL CHECK (mode IN ('test','live')),
  provider_invoice_id varchar(255) NOT NULL,
  provider_subscription_id varchar(255),
  status varchar(100) NOT NULL,
  amount_due integer NOT NULL CHECK (amount_due >= 0),
  amount_paid integer NOT NULL CHECK (amount_paid >= 0),
  currency varchar(3) NOT NULL,
  created_at timestamptz(6) NOT NULL,
  period_start timestamptz(6),
  period_end timestamptz(6),
  hosted_invoice_url text,
  payment_id varchar(255),
  UNIQUE(provider_account,mode,provider_invoice_id)
);
CREATE INDEX billing_invoice_owner_created_idx ON billing_invoice(user_id,created_at DESC,id DESC);
CREATE INDEX billing_invoice_provider_payment_idx ON billing_invoice(provider_account,mode,payment_id) WHERE payment_id IS NOT NULL;

CREATE TABLE billing_customer (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES user_account(id) ON DELETE RESTRICT,
  provider_account varchar(200) NOT NULL,
  mode varchar(8) NOT NULL CHECK (mode IN ('test','live')),
  provider_customer_id varchar(255) NOT NULL,
  created_at timestamptz(6) NOT NULL DEFAULT now(),
  last_reconciled_at timestamptz(6),
  UNIQUE(provider_account,mode,user_id),
  UNIQUE(provider_account,mode,provider_customer_id)
);
CREATE TABLE billing_refund (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES user_account(id) ON DELETE RESTRICT,
  provider_account varchar(200) NOT NULL,
  mode varchar(8) NOT NULL CHECK (mode IN ('test','live')),
  provider_subscription_id varchar(255) NOT NULL,
  payment_id varchar(255) NOT NULL,
  provider_refund_id varchar(255) NOT NULL,
  amount integer NOT NULL CHECK (amount > 0),
  status varchar(100) NOT NULL,
  reason varchar(2000) NOT NULL,
  created_at timestamptz(6) NOT NULL DEFAULT now(),
  UNIQUE(provider_account,mode,provider_refund_id)
);
CREATE INDEX billing_refund_payment_idx ON billing_refund(provider_account,mode,payment_id);
CREATE TABLE billing_dispute (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES user_account(id) ON DELETE RESTRICT,
  provider_account varchar(200) NOT NULL,
  mode varchar(8) NOT NULL CHECK (mode IN ('test','live')),
  provider_dispute_id varchar(255) NOT NULL,
  provider_subscription_id varchar(255),
  payment_id varchar(255) NOT NULL,
  amount_minor integer NOT NULL CHECK (amount_minor>=0),
  status varchar(100) NOT NULL,
  reason varchar(500),
  created_at timestamptz(6) NOT NULL,
  resolved_at timestamptz(6),
  UNIQUE(provider_account,mode,provider_dispute_id)
);
CREATE INDEX billing_dispute_owner_created_idx ON billing_dispute(user_id,created_at DESC);

CREATE TABLE billing_operation (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES user_account(id) ON DELETE RESTRICT,
  kind varchar(32) NOT NULL CHECK (kind IN ('checkout','portal','cancel','refund','reconcile')),
  idempotency_key varchar(200) NOT NULL,
  request_hash char(64) NOT NULL,
  provider_account varchar(200) NOT NULL,
  mode varchar(8) NOT NULL CHECK (mode IN ('test','live')),
  status varchar(16) NOT NULL CHECK (status IN ('pending','processing','succeeded','uncertain','failed')),
  provider_ref varchar(255),
  result jsonb,
  reason varchar(500),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 100),
  created_at timestamptz(6) NOT NULL DEFAULT now(),
  updated_at timestamptz(6) NOT NULL DEFAULT now(),
  next_attempt_at timestamptz(6) NOT NULL DEFAULT now(),
  UNIQUE(provider_account,mode,user_id,idempotency_key)
);
CREATE INDEX billing_operation_recovery_idx ON billing_operation(status,updated_at) WHERE status IN ('pending','uncertain');
CREATE INDEX billing_operation_owner_idx ON billing_operation(user_id,created_at DESC,id);

CREATE TABLE fake_billing_customer (
  id uuid PRIMARY KEY, provider_account_id varchar(200) NOT NULL, mode varchar(8) NOT NULL CHECK(mode IN ('test','live')),
  user_id uuid NOT NULL REFERENCES user_account(id) ON DELETE RESTRICT, customer_id varchar(255) NOT NULL, email varchar(320),
  UNIQUE(provider_account_id,mode,user_id), UNIQUE(provider_account_id,mode,customer_id)
);
CREATE TABLE fake_billing_checkout (
  id uuid PRIMARY KEY, provider_account_id varchar(200) NOT NULL, mode varchar(8) NOT NULL CHECK(mode IN ('test','live')),
  session_id varchar(255) NOT NULL, user_id uuid NOT NULL REFERENCES user_account(id) ON DELETE RESTRICT,
  customer_id varchar(255) NOT NULL, plan varchar(32) CHECK(plan IS NULL OR plan IN ('pro_month','pro_year')),
  kind varchar(16) NOT NULL DEFAULT 'checkout' CHECK(kind IN ('checkout','portal')),
  status varchar(32) NOT NULL, url text NOT NULL, success_url text NOT NULL, cancel_url text NOT NULL,
  expires_at timestamptz(6) NOT NULL, idempotency_key varchar(255) NOT NULL,
  UNIQUE(provider_account_id,mode,session_id), UNIQUE(provider_account_id,mode,idempotency_key)
);
CREATE TABLE fake_billing_subscription (
  id uuid PRIMARY KEY, provider_account_id varchar(200) NOT NULL, mode varchar(8) NOT NULL CHECK(mode IN ('test','live')),
  subscription_id varchar(255) NOT NULL, customer_id varchar(255) NOT NULL,
  user_id uuid NOT NULL REFERENCES user_account(id) ON DELETE RESTRICT, plan varchar(32) CHECK(plan IS NULL OR plan IN ('pro_month','pro_year')),
  status varchar(100) NOT NULL, current_period_start timestamptz(6), current_period_end timestamptz(6), first_failure_at timestamptz(6), cancel_at_period_end boolean NOT NULL DEFAULT false,
  canceled_at timestamptz(6), latest_payment_id varchar(255), reason varchar(500),
  created_at timestamptz(6) NOT NULL DEFAULT now(), updated_at timestamptz(6) NOT NULL DEFAULT now(),
  UNIQUE(provider_account_id,mode,subscription_id)
);
CREATE INDEX fake_billing_subscription_customer_idx ON fake_billing_subscription(provider_account_id,mode,customer_id);
CREATE TABLE fake_billing_invoice (
  id uuid PRIMARY KEY, provider_account_id varchar(200) NOT NULL, mode varchar(8) NOT NULL CHECK(mode IN ('test','live')),
  invoice_id varchar(255) NOT NULL, customer_id varchar(255) NOT NULL, subscription_id varchar(255),
  status varchar(100) NOT NULL, amount_due integer NOT NULL CHECK(amount_due>=0), amount_paid integer NOT NULL CHECK(amount_paid>=0),
  currency varchar(3) NOT NULL, hosted_invoice_url text, payment_id varchar(255), period_start timestamptz(6), period_end timestamptz(6), created_at timestamptz(6) NOT NULL DEFAULT now(),
  UNIQUE(provider_account_id,mode,invoice_id)
);
CREATE TABLE fake_billing_refund (
  id uuid PRIMARY KEY, provider_account_id varchar(200) NOT NULL, mode varchar(8) NOT NULL CHECK(mode IN ('test','live')),
  refund_id varchar(255) NOT NULL, payment_id varchar(255) NOT NULL, amount integer NOT NULL CHECK(amount>0),
  status varchar(100) NOT NULL, reason varchar(100) NOT NULL, idempotency_key varchar(255) NOT NULL, created_at timestamptz(6) NOT NULL DEFAULT now(),
  UNIQUE(provider_account_id,mode,refund_id), UNIQUE(provider_account_id,mode,idempotency_key)
);
CREATE TABLE fake_billing_operation (
  id uuid PRIMARY KEY, provider_account_id varchar(200) NOT NULL, mode varchar(8) NOT NULL CHECK(mode IN ('test','live')),
  idempotency_key varchar(255) NOT NULL, operation varchar(32) NOT NULL, request_hash char(64) NOT NULL,
  result jsonb, status varchar(16) NOT NULL, UNIQUE(provider_account_id,mode,idempotency_key)
);
CREATE TABLE fake_billing_event (
  id uuid PRIMARY KEY, provider_account_id varchar(200) NOT NULL, mode varchar(8) NOT NULL CHECK(mode IN ('test','live')),
  event_id varchar(255) NOT NULL, event_type varchar(120) NOT NULL, created_at timestamptz(6) NOT NULL,
  customer_id varchar(255), subscription_id varchar(255), payment_id varchar(255), payload jsonb NOT NULL DEFAULT '{}', signature text,
  UNIQUE(provider_account_id,mode,event_id)
);
CREATE TABLE fake_billing_dispute (
  id uuid PRIMARY KEY, provider_account_id varchar(200) NOT NULL, mode varchar(8) NOT NULL CHECK(mode IN ('test','live')),
  dispute_id varchar(255) NOT NULL, subscription_id varchar(255), payment_id varchar(255) NOT NULL, amount_minor integer NOT NULL CHECK(amount_minor>=0),
  status varchar(100) NOT NULL, reason varchar(500), created_at timestamptz(6) NOT NULL, resolved_at timestamptz(6),
  UNIQUE(provider_account_id,mode,dispute_id)
);

-- One row per user already exists from P02. Entitlement reads are scoped to the configured account/mode.
ALTER TABLE subscription_entitlement
  ADD COLUMN provider_account varchar(200) NOT NULL DEFAULT 'default',
  ADD COLUMN provider_mode varchar(8) NOT NULL DEFAULT 'test' CHECK (provider_mode IN ('test','live'));
-- Bound every Pro grant to a provider period or grace deadline.
CREATE OR REPLACE FUNCTION billing_entitlement_consistency() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.plan='pro' AND NEW.provider_account<>'default' AND NEW.valid_until IS NULL THEN
    RAISE EXCEPTION 'pro entitlement requires a bounded validity window' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER subscription_entitlement_bounded
  BEFORE INSERT OR UPDATE ON subscription_entitlement
  FOR EACH ROW EXECUTE FUNCTION billing_entitlement_consistency();
