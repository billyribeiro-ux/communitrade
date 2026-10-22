-- Mutable comment edits use optimistic revision checks; positions record their last mutation time.
ALTER TABLE comment ADD COLUMN revision INTEGER NOT NULL DEFAULT 1;
ALTER TABLE comment ADD CONSTRAINT comment_revision_positive CHECK (revision > 0);
ALTER TABLE position ADD COLUMN updated_at TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP;
