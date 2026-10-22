-- One-time operator bootstrap for the separate Keycloak PostgreSQL 18 DB.
-- Connect as that database's Render owner over TLS. Keep the password prompt
-- hidden and store the resulting value only in the identity service secret store.
\set ON_ERROR_STOP on
\prompt 'Identity database name: ' identity_database

CREATE ROLE keycloak_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION;
\password keycloak_app
SELECT format('REVOKE CONNECT ON DATABASE %I FROM PUBLIC', :'identity_database') \gexec
SELECT format('GRANT CONNECT ON DATABASE %I TO keycloak_app', :'identity_database') \gexec
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT USAGE, CREATE ON SCHEMA public TO keycloak_app;
