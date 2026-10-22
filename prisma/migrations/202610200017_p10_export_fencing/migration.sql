ALTER TABLE export_job DROP CONSTRAINT export_job_object_key_check;
ALTER TABLE export_job ADD CONSTRAINT export_job_object_key_check
  CHECK (object_key IS NULL OR object_key = id::text || '.csv' OR object_key ~ ('^' || id::text || '-a[1-9][0-9]*[.]csv$'));
