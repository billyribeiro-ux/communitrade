-- One-time operator bootstrap for the dedicated application PostgreSQL 18 DB.
-- Connect as the Render database owner over TLS. Password prompts are hidden;
-- never put credentials in this file, shell history, or a logged command line.
\set ON_ERROR_STOP on
\prompt 'Application database name: ' app_database

CREATE ROLE trading_migrator LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION;
CREATE ROLE trading_api LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION;
CREATE ROLE trading_worker LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION;
\password trading_migrator
\password trading_api
\password trading_worker

SELECT format('REVOKE CONNECT ON DATABASE %I FROM PUBLIC', :'app_database') \gexec
SELECT format('GRANT CONNECT ON DATABASE %I TO trading_migrator, trading_api, trading_worker', :'app_database') \gexec
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT USAGE, CREATE ON SCHEMA public TO trading_migrator;
GRANT USAGE ON SCHEMA public TO trading_api, trading_worker;

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO trading_api, trading_worker;
GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO trading_api, trading_worker;
GRANT trading_migrator TO trading_bootstrap;
SET ROLE trading_migrator;
ALTER DEFAULT PRIVILEGES FOR ROLE trading_migrator IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO trading_api, trading_worker;
ALTER DEFAULT PRIVILEGES FOR ROLE trading_migrator IN SCHEMA public
  GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO trading_api, trading_worker;
RESET ROLE;
REVOKE trading_migrator FROM trading_bootstrap;

-- pg-boss 12.38.0 defaults to schema `pgboss`; only the worker owns it.
CREATE SCHEMA pgboss AUTHORIZATION trading_worker;
