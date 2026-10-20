#!/usr/bin/env bash
# Runs once, on the postgres container's first start (an empty data volume), as the superuser.
# One Postgres, three databases, three roles — each role owns only its own database:
#   stream   the platform (stream.* + site.*); its schema is applied by install/migrate.sh
#   synapse  the homeserver; Synapse refuses a database whose collation is not C
#   mas      the sign-in service
# Passwords come from the bundle's .env through the container environment, and psql reads them from
# its own environment (\getenv) — never its command line, which every process can read.
set -euo pipefail
: "${STREAM_DB_PASSWORD:?}" "${SYNAPSE_DB_PASSWORD:?}" "${MAS_DB_PASSWORD:?}"
export STREAM_DB_PASSWORD SYNAPSE_DB_PASSWORD MAS_DB_PASSWORD

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname postgres <<'SQL'
\getenv stream_pw STREAM_DB_PASSWORD
\getenv synapse_pw SYNAPSE_DB_PASSWORD
\getenv mas_pw MAS_DB_PASSWORD
CREATE ROLE stream  LOGIN PASSWORD :'stream_pw';
CREATE ROLE synapse LOGIN PASSWORD :'synapse_pw';
CREATE ROLE mas     LOGIN PASSWORD :'mas_pw';
CREATE DATABASE stream  OWNER stream;
CREATE DATABASE synapse OWNER synapse TEMPLATE template0 ENCODING 'UTF8' LC_COLLATE 'C' LC_CTYPE 'C';
CREATE DATABASE mas     OWNER mas;
REVOKE ALL ON DATABASE stream  FROM PUBLIC;
REVOKE ALL ON DATABASE synapse FROM PUBLIC;
REVOKE ALL ON DATABASE mas     FROM PUBLIC;
SQL
