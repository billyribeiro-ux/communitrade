-- Proposed P13 staff moderation additions (not applied; root to merge)
ALTER TABLE report ADD COLUMN assigned_reviewer_user_id UUID REFERENCES user_account(id) ON DELETE RESTRICT;
ALTER TABLE report ADD COLUMN decision TEXT;
ALTER TABLE report ADD CONSTRAINT report_decision_length CHECK (decision IS NULL OR char_length(decision) <= 2000);
CREATE INDEX report_reviewer_status_created_idx ON report(assigned_reviewer_user_id,status,created_at DESC,id DESC);

ALTER TABLE appeal ADD COLUMN assigned_reviewer_user_id UUID REFERENCES user_account(id) ON DELETE RESTRICT;
ALTER TABLE appeal ADD COLUMN review_reason TEXT;
ALTER TABLE appeal ADD CONSTRAINT appeal_review_reason_length CHECK (review_reason IS NULL OR char_length(review_reason) <= 2000);
CREATE INDEX appeal_reviewer_status_created_idx ON appeal(assigned_reviewer_user_id,status,created_at DESC,id DESC);

-- Explicit source state lets moderation hide public profile cards and reposts reversibly.
ALTER TABLE profile ADD COLUMN moderation_hidden_at TIMESTAMPTZ(6);
ALTER TABLE repost ADD COLUMN hidden_at TIMESTAMPTZ(6);
CREATE INDEX repost_hidden_created_idx ON repost(hidden_at,created_at DESC,id DESC) WHERE active;

ALTER TABLE support_ticket ADD COLUMN assigned_staff_user_id uuid REFERENCES user_account(id) ON DELETE RESTRICT;
ALTER TABLE support_ticket ADD COLUMN updated_at timestamptz(6) NOT NULL DEFAULT now();
ALTER TABLE support_message ADD COLUMN from_staff boolean NOT NULL DEFAULT false;
CREATE INDEX support_ticket_staff_status_created_idx ON support_ticket(assigned_staff_user_id,status,created_at DESC,id DESC);
CREATE TABLE support_access_grant (
 id uuid PRIMARY KEY,
 ticket_id uuid NOT NULL REFERENCES support_ticket(id) ON DELETE RESTRICT,
 owner_user_id uuid NOT NULL REFERENCES user_account(id) ON DELETE RESTRICT,
 staff_user_id uuid REFERENCES user_account(id) ON DELETE RESTRICT,
 resource_type text NOT NULL CHECK(resource_type IN ('journal','draft')),
 resource_id uuid NOT NULL,
 purpose text NOT NULL CHECK(char_length(purpose) BETWEEN 1 AND 1000),
 status text NOT NULL DEFAULT 'requested' CHECK(status IN ('requested','approved','revoked')),
 requested_at timestamptz(6) NOT NULL DEFAULT now(),
 approved_at timestamptz(6),
 expires_at timestamptz(6),
 CONSTRAINT support_access_expiry CHECK(status<>'approved' OR (staff_user_id IS NOT NULL AND approved_at IS NOT NULL AND expires_at>approved_at AND expires_at<=approved_at+interval '1 hour'))
);
CREATE INDEX support_access_ticket_idx ON support_access_grant(ticket_id,requested_at,id);
