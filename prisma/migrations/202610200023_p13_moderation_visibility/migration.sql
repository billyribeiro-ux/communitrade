-- Preserve whether an unavailable publication was hidden by staff, owner, or erasure.
-- A staff restore may only undo its own moderation state.
ALTER TABLE publication DROP CONSTRAINT publication_visibility_check;
ALTER TABLE publication ADD CONSTRAINT publication_visibility_check CHECK (visibility IN ('private','public','hidden','removed','moderation_hidden'));
