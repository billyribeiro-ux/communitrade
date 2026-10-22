-- P13 privacy hardening: project nested plan data to contract-known financial fields.
CREATE OR REPLACE FUNCTION privacy_redacted_publication_terms(source jsonb)
RETURNS jsonb LANGUAGE SQL IMMUTABLE AS $$
  SELECT jsonb_build_object(
    'title','Deleted member',
    'plan',
      jsonb_strip_nulls(jsonb_build_object(
        'asset',source->'plan'->'asset',
        'strategy',source->'plan'->'strategy',
        'quantity',source->'plan'->'quantity',
        'entryPrice',source->'plan'->'entryPrice',
        'initialStopPrice',source->'plan'->'initialStopPrice',
        'entryFrom',source->'plan'->'entryFrom',
        'entryUntil',source->'plan'->'entryUntil',
        'expiration',source->'plan'->'expiration',
        'multiplier',source->'plan'->'multiplier'
      ))
      || CASE WHEN jsonb_typeof(source->'plan'->'legs')='array' THEN jsonb_build_object('legs',COALESCE((
        SELECT jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
          'side',leg->'side','quantity',leg->'quantity','strike',leg->'strike',
          'optionType',leg->'optionType','expiration',leg->'expiration',
          'underlyingId',leg->'underlyingId','multiplier',leg->'multiplier','adjusted',leg->'adjusted'
        ))) FROM jsonb_array_elements(source->'plan'->'legs') AS x(leg) WHERE jsonb_typeof(leg)='object'
      ),'[]'::jsonb)) ELSE '{}'::jsonb END
      || CASE WHEN jsonb_typeof(source->'plan'->'instrument')='object' THEN jsonb_build_object('instrument',jsonb_strip_nulls(jsonb_build_object(
        'asset',source->'plan'->'instrument'->'asset','symbol',source->'plan'->'instrument'->'symbol',
        'multiplier',source->'plan'->'instrument'->'multiplier','tickSize',source->'plan'->'instrument'->'tickSize',
        'metadataVersion',source->'plan'->'instrument'->'metadataVersion','enabled',source->'plan'->'instrument'->'enabled',
        'root',source->'plan'->'instrument'->'root','currency',source->'plan'->'instrument'->'currency',
        'adjusted',source->'plan'->'instrument'->'adjusted'
      ))) ELSE '{}'::jsonb END
  );
$$;

CREATE OR REPLACE FUNCTION guard_publication_version_privacy_redaction() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE request_id uuid;
BEGIN
  IF TG_OP='UPDATE' THEN
    BEGIN request_id := current_setting('app.privacy_erasure_request',true)::uuid;
    EXCEPTION WHEN invalid_text_representation THEN request_id := NULL; END;
    IF request_id IS NOT NULL
      AND NEW.id IS NOT DISTINCT FROM OLD.id
      AND NEW.publication_id IS NOT DISTINCT FROM OLD.publication_id
      AND NEW.sequence IS NOT DISTINCT FROM OLD.sequence
      AND NEW.previous_version_id IS NOT DISTINCT FROM OLD.previous_version_id
      AND NEW.created_at IS NOT DISTINCT FROM OLD.created_at
      AND NEW.terms=privacy_redacted_publication_terms(OLD.terms)
      AND NEW.thesis IS NULL AND NEW.chart IS NULL AND NEW.disclosures='{}'::jsonb
      AND EXISTS (
        SELECT 1 FROM privacy_request r JOIN publication p ON p.author_user_id=r.owner_user_id
        WHERE r.id=request_id AND r.type='deletion' AND r.status='processing' AND r.stage='public_derivatives'
          AND p.id=OLD.publication_id
      ) THEN RETURN NEW; END IF;
  END IF;
  RAISE EXCEPTION 'publication_version is immutable outside authorized privacy redaction' USING ERRCODE='55000';
END;
$$;
