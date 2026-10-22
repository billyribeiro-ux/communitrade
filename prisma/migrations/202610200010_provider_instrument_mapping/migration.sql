CREATE TABLE provider_instrument_mapping (
  id UUID PRIMARY KEY,
  instrument_id UUID NOT NULL,
  metadata_version INTEGER NOT NULL,
  supplier TEXT NOT NULL,
  dataset TEXT NOT NULL,
  raw_symbol TEXT NOT NULL,
  effective_at TIMESTAMPTZ(6) NOT NULL,
  revoked_at TIMESTAMPTZ(6),
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT provider_instrument_mapping_raw_symbol_check CHECK (length(raw_symbol) BETWEEN 1 AND 100),
  CONSTRAINT provider_instrument_mapping_version_positive CHECK (metadata_version > 0),
  CONSTRAINT provider_instrument_mapping_times_check CHECK (revoked_at IS NULL OR revoked_at > effective_at),
  CONSTRAINT provider_instrument_mapping_metadata_fkey FOREIGN KEY (instrument_id, metadata_version)
    REFERENCES instrument_metadata_version(instrument_id, version) ON DELETE RESTRICT
);
CREATE INDEX provider_instrument_mapping_instrument_supplier_effective_idx
  ON provider_instrument_mapping(instrument_id, supplier, effective_at DESC);
CREATE UNIQUE INDEX provider_instrument_mapping_current_unique
  ON provider_instrument_mapping(instrument_id, supplier, dataset, metadata_version)
  WHERE revoked_at IS NULL;
CREATE FUNCTION provider_instrument_mapping_revoke_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.instrument_id IS DISTINCT FROM OLD.instrument_id
    OR NEW.metadata_version IS DISTINCT FROM OLD.metadata_version OR NEW.supplier IS DISTINCT FROM OLD.supplier
    OR NEW.dataset IS DISTINCT FROM OLD.dataset OR NEW.raw_symbol IS DISTINCT FROM OLD.raw_symbol
    OR NEW.effective_at IS DISTINCT FROM OLD.effective_at OR NEW.created_at IS DISTINCT FROM OLD.created_at
    OR OLD.revoked_at IS NOT NULL OR NEW.revoked_at IS NULL OR NEW.revoked_at < OLD.effective_at THEN
    RAISE EXCEPTION 'provider instrument mappings are immutable except for one revocation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER provider_instrument_mapping_immutable
  BEFORE UPDATE OR DELETE ON provider_instrument_mapping
  FOR EACH ROW EXECUTE FUNCTION provider_instrument_mapping_revoke_only();
