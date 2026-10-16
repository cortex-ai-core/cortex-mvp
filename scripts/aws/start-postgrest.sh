#!/bin/sh
set -eu
: "${CORTEX_DB_HOST:?Database host required}"
: "${CORTEX_DB_PASSWORD:?Database password required}"
# Infrastructure generates an alphanumeric password, so URI encoding is unnecessary.
case "$CORTEX_DB_PASSWORD" in *[!a-zA-Z0-9]*) echo 'Expected an alphanumeric generated database password' >&2; exit 1;; esac
export PGRST_DB_URI="postgresql://cortex_postgrest:${CORTEX_DB_PASSWORD}@${CORTEX_DB_HOST}:5432/cortex?sslmode=verify-full&sslrootcert=/rds-ca.pem"
unset CORTEX_DB_PASSWORD
exec /bin/postgrest
