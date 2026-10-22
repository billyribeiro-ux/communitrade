ALTER TABLE position ADD COLUMN risk_source_version_id UUID REFERENCES publication_version(id) ON DELETE RESTRICT;
ALTER TABLE outcome_snapshot ADD COLUMN publication_version_id UUID REFERENCES publication_version(id) ON DELETE RESTRICT;
CREATE INDEX outcome_snapshot_publication_version_idx ON outcome_snapshot(publication_version_id) WHERE publication_version_id IS NOT NULL;
