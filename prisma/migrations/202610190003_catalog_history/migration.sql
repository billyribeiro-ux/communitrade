-- P02 catalog/history hardening; additive and forward-only.
ALTER TABLE user_account ADD COLUMN synthetic BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE instrument_metadata_version ALTER COLUMN expiry TYPE TIMESTAMPTZ(6)
  USING CASE WHEN expiry IS NULL THEN NULL ELSE expiry::timestamp AT TIME ZONE 'UTC' END;
ALTER TABLE instrument_metadata_version ADD COLUMN root TEXT;
ALTER TABLE instrument_metadata_version ADD COLUMN contract_month INTEGER;
ALTER TABLE instrument_metadata_version ADD COLUMN contract_year INTEGER;
ALTER TABLE instrument_metadata_version ADD COLUMN option_type TEXT;
ALTER TABLE instrument_metadata_version ADD COLUMN adjusted BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE instrument ADD CONSTRAINT instrument_asset_check CHECK (asset IN ('stock','option','future'));
ALTER TABLE instrument_metadata_version ADD CONSTRAINT metadata_contract_month_check CHECK (contract_month IS NULL OR contract_month BETWEEN 1 AND 12);
ALTER TABLE instrument_metadata_version ADD CONSTRAINT metadata_contract_year_check CHECK (contract_year IS NULL OR contract_year BETWEEN 2000 AND 2200);
ALTER TABLE instrument_metadata_version ADD CONSTRAINT metadata_option_type_check CHECK (option_type IS NULL OR option_type IN ('call','put'));
ALTER TABLE instrument_metadata_version ADD CONSTRAINT metadata_option_contract_complete CHECK (
  (option_type IS NULL AND strike IS NULL) OR (option_type IS NOT NULL AND strike IS NOT NULL AND expiry IS NOT NULL)
);
ALTER TABLE instrument_metadata_version ADD CONSTRAINT metadata_futures_root_valid CHECK (root IS NULL OR root IN ('ES','MES','NQ','MNQ'));
ALTER TABLE instrument_metadata_version ADD CONSTRAINT metadata_futures_contract_complete CHECK (
  root IS NULL OR (contract_month IS NOT NULL AND contract_year IS NOT NULL AND expiry IS NOT NULL)
);

-- Instrument metadata is always versioned by insertion; no row is edited or deleted.
DROP TRIGGER referenced_metadata_immutable ON instrument_metadata_version;
CREATE TRIGGER instrument_metadata_append_only BEFORE UPDATE OR DELETE ON instrument_metadata_version
  FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();

-- Published chart snapshots and a position's initial risk are frozen records.
CREATE OR REPLACE FUNCTION reject_published_chart_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.publication_version_id IS NOT NULL THEN
    RAISE EXCEPTION 'published chart snapshots are immutable' USING ERRCODE='55000';
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER published_chart_immutable BEFORE UPDATE OR DELETE ON chart_state
  FOR EACH ROW EXECUTE FUNCTION reject_published_chart_mutation();
ALTER TABLE position ADD CONSTRAINT position_initial_risk_positive CHECK (initial_risk IS NULL OR initial_risk > 0);
ALTER TABLE position ADD CONSTRAINT entered_position_requires_initial_risk CHECK (
  state NOT IN ('entered','partially_closed','closed','unresolved') OR initial_risk IS NOT NULL
);
CREATE OR REPLACE FUNCTION preserve_frozen_initial_risk() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.state IN ('entered','partially_closed','closed','unresolved') AND
     NEW.initial_risk IS DISTINCT FROM OLD.initial_risk THEN
    RAISE EXCEPTION 'frozen initial risk cannot be changed' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER position_frozen_risk BEFORE UPDATE OF initial_risk ON position
  FOR EACH ROW EXECUTE FUNCTION preserve_frozen_initial_risk();

-- Align publication kind values with the API's canonical domain enum.
ALTER TABLE publication DROP CONSTRAINT publication_kind_check;
ALTER TABLE publication ADD CONSTRAINT publication_kind_check CHECK (kind IN ('trade','education'));
