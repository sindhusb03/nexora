#!/bin/sh
# Creates the API's runtime login. It is not a superuser, cannot bypass RLS, owns nothing, and does not
# inherit privileges: the API drops to nexora_app inside each transaction. The migration job grants
# nexora_app membership to this role (NEXORA_API_LOGIN_ROLE).
set -eu
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
  -v api_password="$NEXORA_API_DB_PASSWORD" <<'SQL'
SELECT format('CREATE ROLE nexora_api LOGIN NOINHERIT NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE PASSWORD %L', :'api_password')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nexora_api')
\gexec
SQL
