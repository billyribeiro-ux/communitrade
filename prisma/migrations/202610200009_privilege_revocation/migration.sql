-- Privilege changes invalidate every outstanding opaque session, even if a future
-- caller omits the application helper. A new login re-derives roles from SQL.
CREATE FUNCTION revoke_sessions_on_role_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP <> 'INSERT' THEN UPDATE app_session SET revoked_at=now() WHERE user_id=OLD.user_id AND revoked_at IS NULL; END IF;
 IF TG_OP <> 'DELETE' THEN UPDATE app_session SET revoked_at=now() WHERE user_id=NEW.user_id AND revoked_at IS NULL; END IF;
 RETURN NULL;
END $$;
CREATE TRIGGER role_change_revoke_sessions AFTER INSERT OR UPDATE OR DELETE ON role_grant FOR EACH ROW EXECUTE FUNCTION revoke_sessions_on_role_change();
CREATE FUNCTION revoke_sessions_on_account_security_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF OLD.status IS DISTINCT FROM NEW.status OR OLD.email IS DISTINCT FROM NEW.email OR (OLD.email_verified AND NOT NEW.email_verified) THEN
  UPDATE app_session SET revoked_at=now() WHERE user_id=NEW.id AND revoked_at IS NULL;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER account_security_change_revoke_sessions AFTER UPDATE ON user_account FOR EACH ROW EXECUTE FUNCTION revoke_sessions_on_account_security_change();
