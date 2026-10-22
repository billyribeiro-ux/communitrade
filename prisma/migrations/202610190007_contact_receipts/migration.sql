-- P03 public contact intake; private details never appear in public record lookup.
ALTER TABLE support_ticket
  ADD COLUMN requester_email TEXT,
  ADD COLUMN subject TEXT,
  ADD COLUMN consent_version TEXT,
  ADD COLUMN consent_at TIMESTAMPTZ(6);
ALTER TABLE support_ticket ADD CONSTRAINT support_contact_lengths CHECK (
  (requester_email IS NULL OR length(requester_email) <= 254) AND
  (subject IS NULL OR length(subject) BETWEEN 1 AND 120) AND
  ((consent_version IS NULL AND consent_at IS NULL) OR (consent_version IS NOT NULL AND consent_at IS NOT NULL))
);
CREATE INDEX support_ticket_requester_created_idx ON support_ticket(requester_user_id, created_at);
