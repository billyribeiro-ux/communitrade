-- Once a denominator is established, a later state change cannot unlock it.
CREATE OR REPLACE FUNCTION preserve_frozen_initial_risk() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.initial_risk IS NOT NULL AND NEW.initial_risk IS DISTINCT FROM OLD.initial_risk THEN
    RAISE EXCEPTION 'frozen initial risk cannot be changed' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END;
$$;
