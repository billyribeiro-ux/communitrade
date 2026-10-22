-- CreateTable
CREATE TABLE "user_account" (
    "id" UUID NOT NULL,
    "oidc_issuer" TEXT NOT NULL,
    "oidc_subject" TEXT NOT NULL,
    "email" TEXT,
    "email_verified" BOOLEAN NOT NULL DEFAULT false,
    "status" TEXT NOT NULL DEFAULT 'active',
    "onboarding_version" TEXT,
    "declaration_version" TEXT,
    "policy_version" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "user_account_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "profile" (
    "user_id" UUID NOT NULL,
    "handle" TEXT NOT NULL,
    "normalized_handle" TEXT NOT NULL,
    "display_name" TEXT NOT NULL,
    "bio" TEXT,
    "interests" JSONB,
    "links" JSONB,
    "avatar_media_id" UUID,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "profile_pkey" PRIMARY KEY ("user_id")
);

-- CreateTable
CREATE TABLE "draft" (
    "id" UUID NOT NULL,
    "owner_user_id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "title" TEXT,
    "thesis" TEXT,
    "plan" JSONB NOT NULL DEFAULT '{}',
    "revision" INTEGER NOT NULL DEFAULT 1,
    "chart_revision" INTEGER NOT NULL DEFAULT 0,
    "deleted_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "draft_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "quota_bucket" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "metric" TEXT NOT NULL,
    "month_start" TIMESTAMPTZ(6) NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 0,
    "reserved_count" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "quota_bucket_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "idempotency_record" (
    "id" UUID NOT NULL,
    "actor_key" TEXT NOT NULL,
    "route" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "request_hash" TEXT NOT NULL,
    "response_status" INTEGER,
    "response_body" JSONB,
    "resource_id" UUID,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "user_id" UUID,

    CONSTRAINT "idempotency_record_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "outbox_event" (
    "id" UUID NOT NULL,
    "event_type" TEXT NOT NULL,
    "aggregate_type" TEXT NOT NULL,
    "aggregate_id" UUID NOT NULL,
    "revision" INTEGER NOT NULL,
    "payload" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "available_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "delivered_at" TIMESTAMPTZ(6),

    CONSTRAINT "outbox_event_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "handle_history" (
    "id" UUID NOT NULL,
    "old_handle" TEXT NOT NULL,
    "user_id" UUID NOT NULL,
    "changed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "redirect_expires_at" TIMESTAMPTZ(6),

    CONSTRAINT "handle_history_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "role_grant" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "role" TEXT NOT NULL,
    "grantor_user_id" UUID NOT NULL,
    "reason" TEXT NOT NULL,
    "granted_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "role_grant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "app_session" (
    "id" UUID NOT NULL,
    "token_hash" TEXT NOT NULL,
    "user_id" UUID NOT NULL,
    "issued_at" TIMESTAMPTZ(6) NOT NULL,
    "last_seen_at" TIMESTAMPTZ(6) NOT NULL,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "revoked_at" TIMESTAMPTZ(6),
    "provider_session_id" TEXT,
    "mfa_at" TIMESTAMPTZ(6),
    "assurance" TEXT,

    CONSTRAINT "app_session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "auth_transaction" (
    "id" UUID NOT NULL,
    "state_hash" TEXT NOT NULL,
    "nonce_hash" TEXT NOT NULL,
    "pkce_verifier_encrypted" TEXT NOT NULL,
    "return_intent" TEXT NOT NULL,
    "used_at" TIMESTAMPTZ(6),
    "expires_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "auth_transaction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "instrument" (
    "id" UUID NOT NULL,
    "asset" TEXT NOT NULL,
    "vendor" TEXT NOT NULL,
    "vendor_id" TEXT NOT NULL,
    "underlying_id" UUID,
    "venue" TEXT NOT NULL,
    "currency" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "instrument_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "instrument_metadata_version" (
    "id" UUID NOT NULL,
    "instrument_id" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "multiplier" DECIMAL(28,10) NOT NULL,
    "tick_size" DECIMAL(28,10) NOT NULL,
    "strike" DECIMAL(28,10),
    "expiry" DATE,
    "session" JSONB,
    "adjustment" JSONB,
    "source_id" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "instrument_metadata_version_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "data_capability" (
    "id" UUID NOT NULL,
    "supplier" TEXT NOT NULL,
    "agreement_id" TEXT NOT NULL,
    "dataset" TEXT NOT NULL,
    "audience" TEXT NOT NULL,
    "purpose" TEXT NOT NULL,
    "effective_at" TIMESTAMPTZ(6) NOT NULL,
    "revoked_at" TIMESTAMPTZ(6),
    "flags" JSONB NOT NULL,

    CONSTRAINT "data_capability_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "chart_state" (
    "id" UUID NOT NULL,
    "owner_user_id" UUID,
    "draft_id" UUID,
    "publication_version_id" UUID,
    "schema_version" INTEGER NOT NULL,
    "state" JSONB NOT NULL,
    "provenance" JSONB NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "chart_state_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "publication" (
    "id" UUID NOT NULL,
    "author_user_id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "original_version_id" UUID,
    "current_version_id" UUID,
    "visibility" TEXT NOT NULL,
    "published_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "publication_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "publication_version" (
    "id" UUID NOT NULL,
    "publication_id" UUID NOT NULL,
    "sequence" INTEGER NOT NULL,
    "previous_version_id" UUID,
    "terms" JSONB NOT NULL,
    "thesis" TEXT,
    "chart" JSONB,
    "disclosures" JSONB,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "publication_version_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "correction_request" (
    "id" UUID NOT NULL,
    "author_user_id" UUID NOT NULL,
    "publication_id" UUID NOT NULL,
    "source_version_id" UUID NOT NULL,
    "reason" TEXT NOT NULL,
    "proposal" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'requested',
    "reviewer_user_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "correction_request_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "position" (
    "id" UUID NOT NULL,
    "owner_user_id" UUID NOT NULL,
    "public_publication_id" UUID,
    "private_journal_entry_id" UUID,
    "state" TEXT NOT NULL,
    "plan" JSONB NOT NULL,
    "instrument_id" UUID NOT NULL,
    "metadata_version_id" UUID NOT NULL,
    "remaining_quantity" INTEGER NOT NULL,
    "initial_risk" DECIMAL(28,10),
    "calculation_version" TEXT NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "position_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "position_leg" (
    "id" UUID NOT NULL,
    "position_id" UUID NOT NULL,
    "instrument_id" UUID NOT NULL,
    "metadata_version_id" UUID NOT NULL,
    "side" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,

    CONSTRAINT "position_leg_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "position_event" (
    "id" UUID NOT NULL,
    "position_id" UUID NOT NULL,
    "type" TEXT NOT NULL,
    "received_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "claimed_at" TIMESTAMPTZ(6),
    "quantity" INTEGER,
    "price" DECIMAL(28,10),
    "costs" DECIMAL(28,10),
    "reason" TEXT,
    "supersedes_id" UUID,

    CONSTRAINT "position_event_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "outcome_snapshot" (
    "id" UUID NOT NULL,
    "position_id" UUID NOT NULL,
    "source_event_cutoff" TIMESTAMPTZ(6) NOT NULL,
    "calculation_version" TEXT NOT NULL,
    "eligibility" TEXT NOT NULL,
    "exclusions" JSONB,
    "net" DECIMAL(28,10),
    "r_multiple" DECIMAL(28,10),
    "cost_coverage" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "outcome_snapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "comment" (
    "id" UUID NOT NULL,
    "publication_id" UUID NOT NULL,
    "author_user_id" UUID NOT NULL,
    "reply_to_id" UUID,
    "root_id" UUID,
    "body" TEXT NOT NULL,
    "tag" TEXT,
    "edited_at" TIMESTAMPTZ(6),
    "deleted_at" TIMESTAMPTZ(6),
    "hidden_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "comment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reaction" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "publication_id" UUID NOT NULL,
    "type" TEXT NOT NULL DEFAULT 'helpful',

    CONSTRAINT "reaction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "follow" (
    "id" UUID NOT NULL,
    "follower_user_id" UUID NOT NULL,
    "target_user_id" UUID,
    "instrument_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "follow_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bookmark" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "publication_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "bookmark_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mute" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "author_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "mute_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "repost" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "publication_id" UUID NOT NULL,
    "commentary" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "repost_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "journal_entry" (
    "id" UUID NOT NULL,
    "owner_user_id" UUID NOT NULL,
    "publication_id" UUID,
    "position_id" UUID,
    "notes" TEXT,
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "review" JSONB,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "journal_entry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "watchlist" (
    "id" UUID NOT NULL,
    "owner_user_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "watchlist_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "watchlist_item" (
    "id" UUID NOT NULL,
    "list_id" UUID NOT NULL,
    "instrument_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "watchlist_item_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "saved_layout" (
    "id" UUID NOT NULL,
    "owner_user_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "template" JSONB NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "saved_layout_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notification" (
    "id" UUID NOT NULL,
    "owner_user_id" UUID NOT NULL,
    "category" TEXT NOT NULL,
    "aggregation_key" TEXT NOT NULL,
    "internal_url" TEXT NOT NULL,
    "read_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "preference" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "settings" JSONB NOT NULL,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "preference_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "subscription" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "provider_customer_id" TEXT,
    "provider_subscription_id" TEXT,
    "mode" TEXT NOT NULL,
    "provider_status" TEXT NOT NULL,
    "provider_version" TEXT NOT NULL,
    "paid_through" TIMESTAMPTZ(6),
    "grace_until" TIMESTAMP(3),

    CONSTRAINT "subscription_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "subscription_entitlement" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "plan" TEXT NOT NULL,
    "limits" JSONB NOT NULL,
    "valid_from" TIMESTAMPTZ(6) NOT NULL,
    "valid_until" TIMESTAMPTZ(6),

    CONSTRAINT "subscription_entitlement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "billing_event" (
    "id" UUID NOT NULL,
    "provider_account" TEXT NOT NULL,
    "mode" TEXT NOT NULL,
    "event_id" TEXT NOT NULL,
    "signature_verified_at" TIMESTAMPTZ(6) NOT NULL,
    "reconciliation_status" TEXT NOT NULL,

    CONSTRAINT "billing_event_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "media" (
    "id" UUID NOT NULL,
    "owner_user_id" UUID NOT NULL,
    "purpose" TEXT NOT NULL,
    "resource_id" UUID,
    "version" INTEGER NOT NULL,
    "quarantine_key" TEXT NOT NULL,
    "processed_key" TEXT,
    "dimensions" JSONB,
    "checksum" TEXT,
    "status" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "media_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "export_job" (
    "id" UUID NOT NULL,
    "owner_user_id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "filters" JSONB NOT NULL,
    "status" TEXT NOT NULL,
    "object_key" TEXT,
    "expires_at" TIMESTAMP(3),

    CONSTRAINT "export_job_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "support_ticket" (
    "id" UUID NOT NULL,
    "requester_user_id" UUID,
    "category" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "visibility" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "support_ticket_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "support_message" (
    "id" UUID NOT NULL,
    "ticket_id" UUID NOT NULL,
    "author_user_id" UUID,
    "body" TEXT NOT NULL,
    "visibility" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "support_message_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "privacy_request" (
    "id" UUID NOT NULL,
    "owner_user_id" UUID NOT NULL,
    "type" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "hold_reason" TEXT,
    "due_at" TIMESTAMPTZ(6),
    "completed_at" TIMESTAMPTZ(6),

    CONSTRAINT "privacy_request_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "report" (
    "id" UUID NOT NULL,
    "reporter_user_id" UUID NOT NULL,
    "resource_type" TEXT NOT NULL,
    "resource_id" UUID NOT NULL,
    "reason" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "report_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "moderation_action" (
    "id" UUID NOT NULL,
    "report_id" UUID NOT NULL,
    "reviewer_user_id" UUID NOT NULL,
    "action" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "moderation_action_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "appeal" (
    "id" UUID NOT NULL,
    "report_id" UUID NOT NULL,
    "appellant_user_id" UUID NOT NULL,
    "status" TEXT NOT NULL,
    "reviewer_user_id" UUID,
    "reason" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "appeal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "editorial_selection" (
    "id" UUID NOT NULL,
    "publication_id" UUID NOT NULL,
    "selector_user_id" UUID NOT NULL,
    "reason" TEXT NOT NULL,
    "active_from" TIMESTAMPTZ(6) NOT NULL,
    "active_until" TIMESTAMPTZ(6),

    CONSTRAINT "editorial_selection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_event" (
    "id" UUID NOT NULL,
    "actor" TEXT NOT NULL,
    "resource_type" TEXT NOT NULL,
    "resource_id" UUID,
    "action" TEXT NOT NULL,
    "reason" TEXT,
    "request_id" TEXT,
    "metadata" JSONB,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_event_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "side_effect_delivery" (
    "id" UUID NOT NULL,
    "channel" TEXT NOT NULL,
    "business_delivery_key" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "provider_reference" TEXT,
    "result" JSONB,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "side_effect_delivery_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rate_limit_bucket" (
    "id" UUID NOT NULL,
    "principal_hash" TEXT NOT NULL,
    "route" TEXT NOT NULL,
    "window_start" TIMESTAMPTZ(6) NOT NULL,
    "counter" INTEGER NOT NULL DEFAULT 0,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "rate_limit_bucket_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "user_account_email_key" ON "user_account"("email");

-- CreateIndex
CREATE UNIQUE INDEX "user_account_oidc_issuer_oidc_subject_key" ON "user_account"("oidc_issuer", "oidc_subject");

-- CreateIndex
CREATE UNIQUE INDEX "profile_handle_key" ON "profile"("handle");

-- CreateIndex
CREATE UNIQUE INDEX "profile_normalized_handle_key" ON "profile"("normalized_handle");

-- CreateIndex
CREATE INDEX "draft_owner_user_id_updated_at_idx" ON "draft"("owner_user_id", "updated_at");

-- CreateIndex
CREATE UNIQUE INDEX "quota_bucket_user_id_metric_month_start_key" ON "quota_bucket"("user_id", "metric", "month_start");

-- CreateIndex
CREATE INDEX "idempotency_record_expires_at_idx" ON "idempotency_record"("expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "idempotency_record_actor_key_route_key_key" ON "idempotency_record"("actor_key", "route", "key");

-- CreateIndex
CREATE INDEX "outbox_event_status_available_at_idx" ON "outbox_event"("status", "available_at");

-- CreateIndex
CREATE UNIQUE INDEX "outbox_event_event_type_aggregate_type_aggregate_id_revisio_key" ON "outbox_event"("event_type", "aggregate_type", "aggregate_id", "revision");

-- CreateIndex
CREATE UNIQUE INDEX "handle_history_old_handle_key" ON "handle_history"("old_handle");

-- CreateIndex
CREATE UNIQUE INDEX "role_grant_user_id_role_key" ON "role_grant"("user_id", "role");

-- CreateIndex
CREATE UNIQUE INDEX "app_session_token_hash_key" ON "app_session"("token_hash");

-- CreateIndex
CREATE INDEX "app_session_user_id_expires_at_idx" ON "app_session"("user_id", "expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "auth_transaction_state_hash_key" ON "auth_transaction"("state_hash");

-- CreateIndex
CREATE INDEX "auth_transaction_expires_at_idx" ON "auth_transaction"("expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "instrument_vendor_vendor_id_key" ON "instrument"("vendor", "vendor_id");

-- CreateIndex
CREATE UNIQUE INDEX "instrument_metadata_version_instrument_id_version_key" ON "instrument_metadata_version"("instrument_id", "version");

-- CreateIndex
CREATE INDEX "publication_visibility_published_at_id_idx" ON "publication"("visibility", "published_at", "id");

-- CreateIndex
CREATE INDEX "publication_author_user_id_published_at_idx" ON "publication"("author_user_id", "published_at");

-- CreateIndex
CREATE UNIQUE INDEX "publication_version_publication_id_sequence_key" ON "publication_version"("publication_id", "sequence");

-- CreateIndex
CREATE INDEX "position_owner_user_id_state_idx" ON "position"("owner_user_id", "state");

-- CreateIndex
CREATE INDEX "position_event_position_id_received_at_id_idx" ON "position_event"("position_id", "received_at", "id");

-- CreateIndex
CREATE INDEX "comment_publication_id_created_at_id_idx" ON "comment"("publication_id", "created_at", "id");

-- CreateIndex
CREATE UNIQUE INDEX "reaction_user_id_publication_id_key" ON "reaction"("user_id", "publication_id");

-- CreateIndex
CREATE UNIQUE INDEX "bookmark_user_id_publication_id_key" ON "bookmark"("user_id", "publication_id");

-- CreateIndex
CREATE UNIQUE INDEX "mute_user_id_author_id_key" ON "mute"("user_id", "author_id");

-- CreateIndex
CREATE INDEX "journal_entry_owner_user_id_created_at_idx" ON "journal_entry"("owner_user_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "watchlist_item_list_id_instrument_id_key" ON "watchlist_item"("list_id", "instrument_id");

-- CreateIndex
CREATE UNIQUE INDEX "notification_owner_user_id_aggregation_key_key" ON "notification"("owner_user_id", "aggregation_key");

-- CreateIndex
CREATE UNIQUE INDEX "preference_user_id_key" ON "preference"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "subscription_provider_subscription_id_key" ON "subscription"("provider_subscription_id");

-- CreateIndex
CREATE INDEX "subscription_user_id_idx" ON "subscription"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "subscription_entitlement_user_id_key" ON "subscription_entitlement"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "billing_event_provider_account_mode_event_id_key" ON "billing_event"("provider_account", "mode", "event_id");

-- CreateIndex
CREATE INDEX "report_status_created_at_idx" ON "report"("status", "created_at");

-- CreateIndex
CREATE INDEX "audit_event_created_at_idx" ON "audit_event"("created_at");

-- CreateIndex
CREATE UNIQUE INDEX "side_effect_delivery_channel_business_delivery_key_key" ON "side_effect_delivery"("channel", "business_delivery_key");

-- CreateIndex
CREATE INDEX "rate_limit_bucket_expires_at_idx" ON "rate_limit_bucket"("expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "rate_limit_bucket_principal_hash_route_window_start_key" ON "rate_limit_bucket"("principal_hash", "route", "window_start");

-- AddForeignKey
ALTER TABLE "profile" ADD CONSTRAINT "profile_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user_account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "draft" ADD CONSTRAINT "draft_owner_user_id_fkey" FOREIGN KEY ("owner_user_id") REFERENCES "user_account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quota_bucket" ADD CONSTRAINT "quota_bucket_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user_account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "idempotency_record" ADD CONSTRAINT "idempotency_record_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user_account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app_session" ADD CONSTRAINT "app_session_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user_account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "journal_entry" ADD CONSTRAINT "journal_entry_owner_user_id_fkey" FOREIGN KEY ("owner_user_id") REFERENCES "user_account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "watchlist" ADD CONSTRAINT "watchlist_owner_user_id_fkey" FOREIGN KEY ("owner_user_id") REFERENCES "user_account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "saved_layout" ADD CONSTRAINT "saved_layout_owner_user_id_fkey" FOREIGN KEY ("owner_user_id") REFERENCES "user_account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification" ADD CONSTRAINT "notification_owner_user_id_fkey" FOREIGN KEY ("owner_user_id") REFERENCES "user_account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Domain invariants that Prisma cannot represent.
ALTER TABLE user_account ADD CONSTRAINT user_account_status_check
  CHECK (status IN ('active', 'suspended', 'deleting', 'deleted'));
ALTER TABLE quota_bucket ADD CONSTRAINT quota_bucket_counts_nonnegative
  CHECK (count >= 0 AND reserved_count >= 0);
ALTER TABLE idempotency_record ADD CONSTRAINT idempotency_response_status_check
  CHECK (response_status IS NULL OR response_status BETWEEN 100 AND 599);
ALTER TABLE draft ADD CONSTRAINT draft_revision_positive CHECK (revision > 0 AND chart_revision >= 0);
ALTER TABLE position ADD CONSTRAINT position_public_or_private_source_check
  CHECK (num_nonnulls(public_publication_id, private_journal_entry_id) <= 1);
ALTER TABLE position ADD CONSTRAINT position_quantity_check
  CHECK (remaining_quantity BETWEEN 0 AND 1000000 AND revision > 0);
ALTER TABLE position ADD CONSTRAINT position_initial_risk_nonnegative
  CHECK (initial_risk IS NULL OR initial_risk >= 0);
ALTER TABLE position_leg ADD CONSTRAINT position_leg_quantity_check
  CHECK (quantity BETWEEN 1 AND 1000000 AND side IN ('long','short'));
ALTER TABLE position_event ADD CONSTRAINT position_event_values_check
  CHECK ((quantity IS NULL OR quantity BETWEEN 1 AND 1000000) AND
         (price IS NULL OR price >= 0) AND (costs IS NULL OR costs >= 0));
ALTER TABLE instrument_metadata_version ADD CONSTRAINT metadata_positive_values
  CHECK (multiplier > 0 AND tick_size > 0 AND (strike IS NULL OR strike >= 0));
ALTER TABLE outbox_event ADD CONSTRAINT outbox_attempts_nonnegative CHECK (attempts >= 0);
ALTER TABLE rate_limit_bucket ADD CONSTRAINT rate_limit_counter_nonnegative CHECK (counter >= 0);
ALTER TABLE repost ADD CONSTRAINT repost_commentary_length CHECK (commentary IS NULL OR char_length(commentary) <= 500);
CREATE UNIQUE INDEX repost_active_user_publication_key ON repost(user_id, publication_id) WHERE active;
CREATE INDEX publication_version_publication_sequence_idx ON publication_version(publication_id, sequence DESC);
CREATE INDEX position_unresolved_idx ON position(owner_user_id, created_at) WHERE state = 'unresolved';
CREATE INDEX position_event_position_received_idx ON position_event(position_id, received_at, id);
CREATE INDEX outbox_pending_delivery_idx ON outbox_event(available_at, created_at) WHERE status IN ('pending','failed');

-- Explicit ownership FKs keep private records inside the owning account boundary.
ALTER TABLE chart_state ADD CONSTRAINT chart_state_owner_user_id_fkey FOREIGN KEY(owner_user_id) REFERENCES user_account(id) ON DELETE RESTRICT;
ALTER TABLE position ADD CONSTRAINT position_owner_user_id_fkey FOREIGN KEY(owner_user_id) REFERENCES user_account(id) ON DELETE RESTRICT;
ALTER TABLE media ADD CONSTRAINT media_owner_user_id_fkey FOREIGN KEY(owner_user_id) REFERENCES user_account(id) ON DELETE RESTRICT;
ALTER TABLE export_job ADD CONSTRAINT export_job_owner_user_id_fkey FOREIGN KEY(owner_user_id) REFERENCES user_account(id) ON DELETE RESTRICT;
ALTER TABLE privacy_request ADD CONSTRAINT privacy_request_owner_user_id_fkey FOREIGN KEY(owner_user_id) REFERENCES user_account(id) ON DELETE RESTRICT;
ALTER TABLE subscription ADD CONSTRAINT subscription_user_id_fkey FOREIGN KEY(user_id) REFERENCES user_account(id) ON DELETE RESTRICT;
ALTER TABLE subscription_entitlement ADD CONSTRAINT entitlement_user_id_fkey FOREIGN KEY(user_id) REFERENCES user_account(id) ON DELETE RESTRICT;
ALTER TABLE preference ADD CONSTRAINT preference_user_id_fkey FOREIGN KEY(user_id) REFERENCES user_account(id) ON DELETE RESTRICT;
ALTER TABLE position_leg ADD CONSTRAINT position_leg_position_id_fkey FOREIGN KEY(position_id) REFERENCES position(id) ON DELETE RESTRICT;
ALTER TABLE position_event ADD CONSTRAINT position_event_position_id_fkey FOREIGN KEY(position_id) REFERENCES position(id) ON DELETE RESTRICT;
ALTER TABLE outcome_snapshot ADD CONSTRAINT outcome_snapshot_position_id_fkey FOREIGN KEY(position_id) REFERENCES position(id) ON DELETE RESTRICT;
ALTER TABLE watchlist_item ADD CONSTRAINT watchlist_item_list_id_fkey FOREIGN KEY(list_id) REFERENCES watchlist(id) ON DELETE CASCADE;
ALTER TABLE watchlist_item ADD CONSTRAINT watchlist_item_instrument_id_fkey FOREIGN KEY(instrument_id) REFERENCES instrument(id) ON DELETE RESTRICT;
ALTER TABLE publication_version ADD CONSTRAINT publication_version_publication_id_fkey FOREIGN KEY(publication_id) REFERENCES publication(id) ON DELETE RESTRICT;
ALTER TABLE publication_version ADD CONSTRAINT publication_version_previous_id_fkey FOREIGN KEY(previous_version_id) REFERENCES publication_version(id) ON DELETE RESTRICT;
ALTER TABLE publication ADD CONSTRAINT publication_current_version_fkey FOREIGN KEY(current_version_id) REFERENCES publication_version(id) ON DELETE RESTRICT;
ALTER TABLE comment ADD CONSTRAINT comment_publication_id_fkey FOREIGN KEY(publication_id) REFERENCES publication(id) ON DELETE RESTRICT;
ALTER TABLE reaction ADD CONSTRAINT reaction_publication_id_fkey FOREIGN KEY(publication_id) REFERENCES publication(id) ON DELETE RESTRICT;
ALTER TABLE bookmark ADD CONSTRAINT bookmark_publication_id_fkey FOREIGN KEY(publication_id) REFERENCES publication(id) ON DELETE RESTRICT;
ALTER TABLE repost ADD CONSTRAINT repost_publication_id_fkey FOREIGN KEY(publication_id) REFERENCES publication(id) ON DELETE RESTRICT;
ALTER TABLE instrument_metadata_version ADD CONSTRAINT metadata_instrument_id_fkey FOREIGN KEY(instrument_id) REFERENCES instrument(id) ON DELETE RESTRICT;

CREATE OR REPLACE FUNCTION reject_history_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% rows are append-only', TG_TABLE_NAME USING ERRCODE = '55000';
END;
$$;
CREATE TRIGGER publication_version_immutable BEFORE UPDATE OR DELETE ON publication_version
  FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
CREATE TRIGGER position_event_immutable BEFORE UPDATE OR DELETE ON position_event
  FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
CREATE TRIGGER audit_event_immutable BEFORE UPDATE OR DELETE ON audit_event
  FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();

CREATE OR REPLACE FUNCTION enforce_comment_thread_publication() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.reply_to_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM comment parent
     WHERE parent.id = NEW.reply_to_id AND parent.publication_id = NEW.publication_id
  ) THEN
    RAISE EXCEPTION 'reply target must belong to the same publication' USING ERRCODE = '23514';
  END IF;
  IF NEW.root_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM comment root
     WHERE root.id = NEW.root_id AND root.publication_id = NEW.publication_id
  ) THEN
    RAISE EXCEPTION 'thread root must belong to the same publication' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER comment_same_publication_thread BEFORE INSERT OR UPDATE OF publication_id, reply_to_id, root_id ON comment
  FOR EACH ROW EXECUTE FUNCTION enforce_comment_thread_publication();

-- Freeze the chart and terms once referenced by a committed publication version.
ALTER TABLE publication_version ADD CONSTRAINT publication_version_sequence_positive CHECK (sequence > 0);
ALTER TABLE publication_version ADD CONSTRAINT publication_version_terms_object CHECK (jsonb_typeof(terms) = 'object');
ALTER TABLE outbox_event ADD CONSTRAINT outbox_status_check CHECK (status IN ('pending','processing','delivered','failed'));
ALTER TABLE handle_history ADD CONSTRAINT handle_history_user_id_fkey FOREIGN KEY(user_id) REFERENCES user_account(id) ON DELETE RESTRICT;
ALTER TABLE role_grant ADD CONSTRAINT role_grant_user_id_fkey FOREIGN KEY(user_id) REFERENCES user_account(id) ON DELETE RESTRICT;
ALTER TABLE role_grant ADD CONSTRAINT role_grant_grantor_user_id_fkey FOREIGN KEY(grantor_user_id) REFERENCES user_account(id) ON DELETE RESTRICT;
ALTER TABLE publication ADD CONSTRAINT publication_author_user_id_fkey FOREIGN KEY(author_user_id) REFERENCES user_account(id) ON DELETE RESTRICT;
ALTER TABLE correction_request ADD CONSTRAINT correction_request_author_user_id_fkey FOREIGN KEY(author_user_id) REFERENCES user_account(id) ON DELETE RESTRICT;
ALTER TABLE correction_request ADD CONSTRAINT correction_request_source_version_fkey FOREIGN KEY(source_version_id) REFERENCES publication_version(id) ON DELETE RESTRICT;
ALTER TABLE position ADD CONSTRAINT position_metadata_version_fkey FOREIGN KEY(metadata_version_id) REFERENCES instrument_metadata_version(id) ON DELETE RESTRICT;
ALTER TABLE position ADD CONSTRAINT position_publication_fkey FOREIGN KEY(public_publication_id) REFERENCES publication(id) ON DELETE RESTRICT;
ALTER TABLE position ADD CONSTRAINT position_journal_entry_fkey FOREIGN KEY(private_journal_entry_id) REFERENCES journal_entry(id) ON DELETE RESTRICT;
ALTER TABLE position_leg ADD CONSTRAINT position_leg_instrument_fkey FOREIGN KEY(instrument_id) REFERENCES instrument(id) ON DELETE RESTRICT;
ALTER TABLE position_leg ADD CONSTRAINT position_leg_metadata_version_fkey FOREIGN KEY(metadata_version_id) REFERENCES instrument_metadata_version(id) ON DELETE RESTRICT;
ALTER TABLE journal_entry ADD CONSTRAINT journal_entry_publication_fkey FOREIGN KEY(publication_id) REFERENCES publication(id) ON DELETE RESTRICT;
ALTER TABLE journal_entry ADD CONSTRAINT journal_entry_position_fkey FOREIGN KEY(position_id) REFERENCES position(id) ON DELETE RESTRICT;
ALTER TABLE media ADD CONSTRAINT media_processed_key_check CHECK (status <> 'ready' OR processed_key IS NOT NULL);
ALTER TABLE support_ticket ADD CONSTRAINT support_ticket_requester_fkey FOREIGN KEY(requester_user_id) REFERENCES user_account(id) ON DELETE RESTRICT;
ALTER TABLE support_message ADD CONSTRAINT support_message_ticket_fkey FOREIGN KEY(ticket_id) REFERENCES support_ticket(id) ON DELETE RESTRICT;
ALTER TABLE support_message ADD CONSTRAINT support_message_author_fkey FOREIGN KEY(author_user_id) REFERENCES user_account(id) ON DELETE RESTRICT;
ALTER TABLE report ADD CONSTRAINT report_reporter_user_id_fkey FOREIGN KEY(reporter_user_id) REFERENCES user_account(id) ON DELETE RESTRICT;
ALTER TABLE moderation_action ADD CONSTRAINT moderation_action_report_fkey FOREIGN KEY(report_id) REFERENCES report(id) ON DELETE RESTRICT;
ALTER TABLE appeal ADD CONSTRAINT appeal_report_fkey FOREIGN KEY(report_id) REFERENCES report(id) ON DELETE RESTRICT;
ALTER TABLE editorial_selection ADD CONSTRAINT editorial_selection_publication_fkey FOREIGN KEY(publication_id) REFERENCES publication(id) ON DELETE RESTRICT;

-- Composite references ensure version identity is scoped to its canonical record.
ALTER TABLE instrument_metadata_version ADD CONSTRAINT metadata_id_instrument_unique UNIQUE(id, instrument_id);
ALTER TABLE position ADD CONSTRAINT position_instrument_id_fkey FOREIGN KEY(instrument_id) REFERENCES instrument(id) ON DELETE RESTRICT;
ALTER TABLE position_leg ADD CONSTRAINT position_leg_metadata_instrument_fkey FOREIGN KEY(metadata_version_id,instrument_id) REFERENCES instrument_metadata_version(id,instrument_id) ON DELETE RESTRICT;
ALTER TABLE position ADD CONSTRAINT position_metadata_instrument_fkey FOREIGN KEY(metadata_version_id,instrument_id) REFERENCES instrument_metadata_version(id,instrument_id) ON DELETE RESTRICT;
ALTER TABLE publication_version ADD CONSTRAINT publication_version_id_publication_unique UNIQUE(id,publication_id);
ALTER TABLE publication ADD CONSTRAINT publication_current_version_same_publication_fkey FOREIGN KEY(current_version_id,id) REFERENCES publication_version(id,publication_id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE publication ADD CONSTRAINT publication_original_version_same_publication_fkey FOREIGN KEY(original_version_id,id) REFERENCES publication_version(id,publication_id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE publication_version ADD CONSTRAINT publication_previous_version_same_publication_fkey FOREIGN KEY(previous_version_id,publication_id) REFERENCES publication_version(id,publication_id) ON DELETE RESTRICT;
ALTER TABLE position_event ADD CONSTRAINT position_event_id_position_unique UNIQUE(id,position_id);
ALTER TABLE position_event ADD CONSTRAINT position_event_supersedes_same_position_fkey FOREIGN KEY(supersedes_id,position_id) REFERENCES position_event(id,position_id) ON DELETE RESTRICT;
ALTER TABLE chart_state ADD CONSTRAINT chart_state_draft_id_fkey FOREIGN KEY(draft_id) REFERENCES draft(id) ON DELETE RESTRICT;
ALTER TABLE chart_state ADD CONSTRAINT chart_state_publication_version_fkey FOREIGN KEY(publication_version_id) REFERENCES publication_version(id) ON DELETE RESTRICT;
ALTER TABLE chart_state ADD CONSTRAINT chart_state_draft_or_publication_check CHECK (num_nonnulls(draft_id,publication_version_id) = 1);
ALTER TABLE publication_version ADD CONSTRAINT publication_version_chart_object_check CHECK (chart IS NULL OR jsonb_typeof(chart) = 'object');

CREATE OR REPLACE FUNCTION enforce_chart_state_owner() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.draft_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM draft d WHERE d.id=NEW.draft_id AND d.owner_user_id=NEW.owner_user_id
  ) THEN RAISE EXCEPTION 'chart state owner must own draft' USING ERRCODE='23514'; END IF;
  IF NEW.publication_version_id IS NOT NULL AND NEW.owner_user_id IS NOT NULL THEN
    RAISE EXCEPTION 'published chart state cannot carry a private owner' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER chart_state_owner_match BEFORE INSERT OR UPDATE ON chart_state
  FOR EACH ROW EXECUTE FUNCTION enforce_chart_state_owner();

CREATE OR REPLACE FUNCTION enforce_position_owner_source() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF num_nonnulls(NEW.public_publication_id,NEW.private_journal_entry_id) <> 1 THEN
    RAISE EXCEPTION 'position must have exactly one public or private source' USING ERRCODE='23514';
  END IF;
  IF NEW.public_publication_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM publication p WHERE p.id=NEW.public_publication_id AND p.author_user_id=NEW.owner_user_id
  ) THEN RAISE EXCEPTION 'position owner must author public source' USING ERRCODE='23514'; END IF;
  IF NEW.private_journal_entry_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM journal_entry j WHERE j.id=NEW.private_journal_entry_id AND j.owner_user_id=NEW.owner_user_id
  ) THEN RAISE EXCEPTION 'position owner must own private journal source' USING ERRCODE='23514'; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM instrument_metadata_version m WHERE m.id=NEW.metadata_version_id AND m.instrument_id=NEW.instrument_id
  ) THEN RAISE EXCEPTION 'position metadata version must belong to instrument' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER position_owner_source_match BEFORE INSERT OR UPDATE ON position
  FOR EACH ROW EXECUTE FUNCTION enforce_position_owner_source();

CREATE OR REPLACE FUNCTION enforce_metadata_immutable_when_referenced() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM position p WHERE p.metadata_version_id=OLD.id)
     OR EXISTS (SELECT 1 FROM position_leg l WHERE l.metadata_version_id=OLD.id) THEN
    RAISE EXCEPTION 'referenced instrument metadata versions are immutable' USING ERRCODE='55000';
  END IF;
  RETURN OLD;
END;
$$;
CREATE TRIGGER referenced_metadata_immutable BEFORE UPDATE OR DELETE ON instrument_metadata_version
  FOR EACH ROW EXECUTE FUNCTION enforce_metadata_immutable_when_referenced();
ALTER TABLE comment ADD CONSTRAINT comment_author_user_id_fkey FOREIGN KEY(author_user_id) REFERENCES user_account(id) ON DELETE RESTRICT;
ALTER TABLE comment ADD CONSTRAINT comment_reply_to_fkey FOREIGN KEY(reply_to_id) REFERENCES comment(id) ON DELETE RESTRICT;
ALTER TABLE comment ADD CONSTRAINT comment_root_fkey FOREIGN KEY(root_id) REFERENCES comment(id) ON DELETE RESTRICT;
ALTER TABLE reaction ADD CONSTRAINT reaction_user_id_fkey FOREIGN KEY(user_id) REFERENCES user_account(id) ON DELETE RESTRICT;
ALTER TABLE bookmark ADD CONSTRAINT bookmark_user_id_fkey FOREIGN KEY(user_id) REFERENCES user_account(id) ON DELETE RESTRICT;
ALTER TABLE follow ADD CONSTRAINT follow_follower_user_id_fkey FOREIGN KEY(follower_user_id) REFERENCES user_account(id) ON DELETE RESTRICT;
ALTER TABLE follow ADD CONSTRAINT follow_target_user_id_fkey FOREIGN KEY(target_user_id) REFERENCES user_account(id) ON DELETE RESTRICT;
ALTER TABLE follow ADD CONSTRAINT follow_instrument_id_fkey FOREIGN KEY(instrument_id) REFERENCES instrument(id) ON DELETE RESTRICT;
ALTER TABLE mute ADD CONSTRAINT mute_user_id_fkey FOREIGN KEY(user_id) REFERENCES user_account(id) ON DELETE RESTRICT;
ALTER TABLE mute ADD CONSTRAINT mute_author_id_fkey FOREIGN KEY(author_id) REFERENCES user_account(id) ON DELETE RESTRICT;
ALTER TABLE repost ADD CONSTRAINT repost_user_id_fkey FOREIGN KEY(user_id) REFERENCES user_account(id) ON DELETE RESTRICT;
ALTER TABLE moderation_action ADD CONSTRAINT moderation_action_reviewer_user_id_fkey FOREIGN KEY(reviewer_user_id) REFERENCES user_account(id) ON DELETE RESTRICT;
ALTER TABLE appeal ADD CONSTRAINT appeal_appellant_user_id_fkey FOREIGN KEY(appellant_user_id) REFERENCES user_account(id) ON DELETE RESTRICT;
ALTER TABLE appeal ADD CONSTRAINT appeal_reviewer_user_id_fkey FOREIGN KEY(reviewer_user_id) REFERENCES user_account(id) ON DELETE RESTRICT;
ALTER TABLE editorial_selection ADD CONSTRAINT editorial_selector_user_id_fkey FOREIGN KEY(selector_user_id) REFERENCES user_account(id) ON DELETE RESTRICT;
ALTER TABLE correction_request ADD CONSTRAINT correction_reviewer_user_id_fkey FOREIGN KEY(reviewer_user_id) REFERENCES user_account(id) ON DELETE RESTRICT;
ALTER TABLE instrument ADD CONSTRAINT instrument_underlying_id_fkey FOREIGN KEY(underlying_id) REFERENCES instrument(id) ON DELETE RESTRICT;
ALTER TABLE follow ADD CONSTRAINT follow_exactly_one_target_check CHECK (num_nonnulls(target_user_id,instrument_id)=1);
ALTER TABLE follow ADD CONSTRAINT follow_no_self_check CHECK (target_user_id IS NULL OR follower_user_id <> target_user_id);
ALTER TABLE mute ADD CONSTRAINT mute_no_self_check CHECK (user_id <> author_id);
ALTER TABLE reaction ADD CONSTRAINT reaction_type_check CHECK (type='helpful');
ALTER TABLE position ADD CONSTRAINT position_state_check CHECK (state IN ('pending','entered','partially_closed','closed','canceled','never_entered','unresolved'));
ALTER TABLE position ADD CONSTRAINT position_plan_object_check CHECK (jsonb_typeof(plan)='object');
ALTER TABLE publication ADD CONSTRAINT publication_visibility_check CHECK (visibility IN ('private','public','hidden','removed'));
ALTER TABLE publication ADD CONSTRAINT publication_kind_check CHECK (kind IN ('trade_idea','educational'));
ALTER TABLE position_event ADD CONSTRAINT position_event_type_check CHECK (type IN ('entry','partial_exit','final_exit','cancel','never_entered','review','resolution','correction'));
ALTER TABLE position_event ADD CONSTRAINT position_event_future_bound_check CHECK (claimed_at IS NULL OR claimed_at <= received_at + interval '60 seconds');

CREATE OR REPLACE FUNCTION prevent_self_repost() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM publication p WHERE p.id=NEW.publication_id AND p.author_user_id=NEW.user_id) THEN
    RAISE EXCEPTION 'authors cannot repost their own publication' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER repost_no_self BEFORE INSERT OR UPDATE OF publication_id,user_id ON repost
  FOR EACH ROW EXECUTE FUNCTION prevent_self_repost();

CREATE OR REPLACE FUNCTION keep_referenced_owners_stable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.owner_user_id IS DISTINCT FROM OLD.owner_user_id THEN
    IF TG_TABLE_NAME='draft' AND EXISTS (SELECT 1 FROM chart_state c WHERE c.draft_id=OLD.id) THEN
      RAISE EXCEPTION 'draft owner cannot change after chart state exists' USING ERRCODE='55000';
    END IF;
    IF TG_TABLE_NAME='journal_entry' AND EXISTS (SELECT 1 FROM position p WHERE p.private_journal_entry_id=OLD.id) THEN
      RAISE EXCEPTION 'journal owner cannot change after position exists' USING ERRCODE='55000';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER draft_owner_stable BEFORE UPDATE OF owner_user_id ON draft
  FOR EACH ROW EXECUTE FUNCTION keep_referenced_owners_stable();
CREATE TRIGGER journal_owner_stable BEFORE UPDATE OF owner_user_id ON journal_entry
  FOR EACH ROW EXECUTE FUNCTION keep_referenced_owners_stable();
