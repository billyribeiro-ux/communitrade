#!/bin/bash
set -euo pipefail

: "${APP_DB_NAME:?APP_DB_NAME is required}"
: "${APP_DB_USER:?APP_DB_USER is required}"
: "${APP_DB_PASSWORD:?APP_DB_PASSWORD is required}"
: "${IDENTITY_DB_NAME:?IDENTITY_DB_NAME is required}"
: "${IDENTITY_DB_USER:?IDENTITY_DB_USER is required}"
: "${IDENTITY_DB_PASSWORD:?IDENTITY_DB_PASSWORD is required}"

psql --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
  --set=app_db_name="$APP_DB_NAME" \
  --set=app_db_user="$APP_DB_USER" \
  --set=app_db_password="$APP_DB_PASSWORD" \
  --set=identity_db_name="$IDENTITY_DB_NAME" \
  --set=identity_db_user="$IDENTITY_DB_USER" \
  --set=identity_db_password="$IDENTITY_DB_PASSWORD" \
  --set=ON_ERROR_STOP=1 <<'SQL'
SELECT format('CREATE ROLE %I LOGIN PASSWORD %L', :'app_db_user', :'app_db_password')
WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = :'app_db_user')
\gexec

SELECT format('CREATE DATABASE %I OWNER %I', :'app_db_name', :'app_db_user')
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = :'app_db_name')
\gexec

SELECT format('CREATE ROLE %I LOGIN PASSWORD %L', :'identity_db_user', :'identity_db_password')
WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = :'identity_db_user')
\gexec

SELECT format('CREATE DATABASE %I OWNER %I', :'identity_db_name', :'identity_db_user')
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = :'identity_db_name')
\gexec
SQL
