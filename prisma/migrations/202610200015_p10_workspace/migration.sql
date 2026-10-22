ALTER TABLE journal_entry
  ADD COLUMN title TEXT NOT NULL DEFAULT '',
  ADD COLUMN thesis TEXT NOT NULL DEFAULT '',
  ADD COLUMN deleted_at TIMESTAMPTZ(6);

CREATE UNIQUE INDEX journal_entry_owner_publication_key
  ON journal_entry(owner_user_id, publication_id)
  WHERE publication_id IS NOT NULL AND deleted_at IS NULL;

ALTER TABLE watchlist
  ADD COLUMN updated_at TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP;

ALTER TABLE saved_layout
  ADD COLUMN updated_at TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP;

CREATE OR REPLACE FUNCTION touch_p10_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = CURRENT_TIMESTAMP;
  RETURN NEW;
END;
$$;

CREATE TRIGGER watchlist_touch_updated_at BEFORE UPDATE ON watchlist
  FOR EACH ROW EXECUTE FUNCTION touch_p10_updated_at();
CREATE TRIGGER saved_layout_touch_updated_at BEFORE UPDATE ON saved_layout
  FOR EACH ROW EXECUTE FUNCTION touch_p10_updated_at();

ALTER TABLE journal_entry ADD CONSTRAINT journal_entry_revision_positive CHECK (revision > 0);
ALTER TABLE journal_entry ADD CONSTRAINT journal_entry_fields_length_check CHECK (
  char_length(title) <= 120 AND char_length(thesis) <= 10000 AND
  (notes IS NULL OR char_length(notes) <= 10000) AND
  (review IS NULL OR (jsonb_typeof(review) = 'string' AND char_length(review #>> '{}') <= 10000)) AND
  cardinality(tags) <= 20
);

ALTER TABLE watchlist ADD CONSTRAINT watchlist_revision_positive CHECK (revision > 0);
ALTER TABLE saved_layout ADD CONSTRAINT saved_layout_revision_positive CHECK (revision > 0);
