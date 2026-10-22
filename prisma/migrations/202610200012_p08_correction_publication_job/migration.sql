ALTER TABLE correction_request ADD COLUMN publication_job_id UUID REFERENCES publication_job(id) ON DELETE RESTRICT;
CREATE INDEX correction_request_publication_job_idx ON correction_request(publication_job_id) WHERE publication_job_id IS NOT NULL;
