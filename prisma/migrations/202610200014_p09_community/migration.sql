-- P09 community interactions: retain prior comment revisions and resolve mentions
-- to existing public handles at write time.
ALTER TABLE report ADD COLUMN detail TEXT;
ALTER TABLE report ADD CONSTRAINT report_detail_length CHECK (detail IS NULL OR char_length(detail) <= 2000);

CREATE TABLE comment_edit_history (
  id UUID PRIMARY KEY,
  comment_id UUID NOT NULL REFERENCES comment(id) ON DELETE RESTRICT,
  revision INTEGER NOT NULL,
  body TEXT NOT NULL,
  tag TEXT,
  changed_at TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT comment_edit_history_revision_positive CHECK (revision > 0),
  CONSTRAINT comment_edit_history_body_length CHECK (char_length(body) <= 2000),
  CONSTRAINT comment_edit_history_tag_check CHECK (tag IS NULL OR tag IN ('question','counterargument','alternative','risk')),
  CONSTRAINT comment_edit_history_comment_revision_key UNIQUE (comment_id, revision)
);
CREATE INDEX comment_edit_history_comment_changed_idx ON comment_edit_history(comment_id, changed_at DESC, revision DESC);

CREATE TABLE comment_mention (
  id UUID PRIMARY KEY,
  comment_id UUID NOT NULL REFERENCES comment(id) ON DELETE RESTRICT,
  mentioned_user_id UUID NOT NULL REFERENCES user_account(id) ON DELETE RESTRICT,
  handle TEXT NOT NULL,
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT comment_mention_handle_check CHECK (handle ~ '^[a-z0-9_]{3,30}$'),
  CONSTRAINT comment_mention_comment_user_key UNIQUE (comment_id, mentioned_user_id)
);
CREATE INDEX comment_mention_user_created_idx ON comment_mention(mentioned_user_id, created_at DESC);

-- Follow's polymorphic target is exactly one user or instrument. Partial unique
-- indexes make repeated/concurrent PUTs idempotent for each target kind.
CREATE UNIQUE INDEX follow_author_target_key ON follow(follower_user_id, target_user_id) WHERE target_user_id IS NOT NULL;
CREATE UNIQUE INDEX follow_instrument_target_key ON follow(follower_user_id, instrument_id) WHERE instrument_id IS NOT NULL;
CREATE INDEX follow_author_lookup_idx ON follow(target_user_id, follower_user_id) WHERE target_user_id IS NOT NULL;
CREATE INDEX follow_instrument_lookup_idx ON follow(instrument_id, follower_user_id) WHERE instrument_id IS NOT NULL;
CREATE INDEX repost_profile_lookup_idx ON repost(user_id, created_at DESC, id DESC) WHERE active;
CREATE INDEX publication_version_public_text_search_idx ON publication_version
  USING GIN (to_tsvector('simple', COALESCE(terms->>'title','') || ' ' || COALESCE(thesis,'')));
CREATE INDEX profile_public_text_search_idx ON profile
  USING GIN (to_tsvector('simple', COALESCE(display_name,'') || ' ' || COALESCE(handle,'')));
