#!/usr/bin/env bash
#
# One-time Codespace setup: PostgreSQL, dependencies, .env, build, migrations.
#
# Every step is idempotent, so re-running this is safe. In particular it will
# never regenerate MART_CREDENTIAL_KEY for an existing .env: rotating that key
# makes previously stored provider credentials undecryptable.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

DB_NAME="${MART_DB_NAME:-mart}"
DB_USER="${MART_DB_USER:-mart}"
DB_PASSWORD="${MART_DB_PASSWORD:-mart_local_dev}"
FIXTURE_URL="http://localhost:${MART_FIXTURE_PORT:-4900}"

say() { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }

# Codespaces runs as a non-root user with sudo; some devcontainer images run as
# root with no sudo at all. Support both rather than assuming one.
if [ "$(id -u)" -eq 0 ]; then
  ROOT_RUN=()
  PG_RUN=(runuser -u postgres --)
else
  ROOT_RUN=(sudo)
  PG_RUN=(sudo -u postgres)
fi

# --------------------------------------------------------------- postgres ---
say "PostgreSQL"
if ! command -v pg_isready >/dev/null 2>&1; then
  echo "installing postgresql..."
  "${ROOT_RUN[@]}" apt-get update -qq
  "${ROOT_RUN[@]}" env DEBIAN_FRONTEND=noninteractive apt-get install -y -qq postgresql postgresql-contrib >/dev/null
fi

"${ROOT_RUN[@]}" service postgresql start >/dev/null 2>&1 || true
for _ in $(seq 1 30); do
  pg_isready -q && break
  sleep 1
done
pg_isready || { echo "PostgreSQL did not start"; exit 1; }
echo "postgres: $(psql --version)"

# Role and database, both idempotent.
"${PG_RUN[@]}" psql -tAc "SELECT 1 FROM pg_roles WHERE rolname='${DB_USER}'" | grep -q 1 \
  || "${PG_RUN[@]}" psql -qc "CREATE ROLE ${DB_USER} LOGIN SUPERUSER PASSWORD '${DB_PASSWORD}';"
"${PG_RUN[@]}" psql -tAc "SELECT 1 FROM pg_database WHERE datname='${DB_NAME}'" | grep -q 1 \
  || "${PG_RUN[@]}" createdb -O "${DB_USER}" "${DB_NAME}"
echo "database '${DB_NAME}' owned by '${DB_USER}' is ready"

# ----------------------------------------------------------------- .env -----
say "Environment"
if [ -f .env ]; then
  echo ".env already exists - leaving it untouched (the credential key must not be rotated)"
else
  cp .env.example .env

  # Replace a key in place, or append it if .env.example ever drops the line.
  set_env() {
    local key="$1" value="$2"
    if grep -qE "^${key}=" .env; then
      python3 - "$key" "$value" <<'PY'
import re, sys
key, value = sys.argv[1], sys.argv[2]
path = '.env'
text = open(path).read()
text = re.sub(rf'^{re.escape(key)}=.*$', f'{key}={value}', text, count=1, flags=re.M)
open(path, 'w').write(text)
PY
    else
      printf '%s=%s\n' "$key" "$value" >> .env
    fi
  }

  set_env MART_CREDENTIAL_KEY "$(node -e "console.log(require('crypto').randomBytes(32).toString('base64'))")"
  set_env DATABASE_URL "postgres://${DB_USER}:${DB_PASSWORD}@localhost:5432/${DB_NAME}"
  set_env MART_API_INTERNAL_URL "http://localhost:4000"
  set_env COOKIE_SECURE "false"
  set_env LOG_PRETTY "false"

  # No provider credentials exist, so the adapters are pointed at the local
  # fixture server. This is exactly what makes the dashboard's
  # "DEVELOPMENT FIXTURE DATA" banner appear: the banner is derived from these
  # three values, not from a flag anyone has to remember to set.
  set_env META_GRAPH_BASE_URL "$FIXTURE_URL"
  set_env APPSFLYER_BASE_URL "$FIXTURE_URL"
  set_env TENJIN_BASE_URL "$FIXTURE_URL"

  echo ".env written (provider base URLs point at the fixture server)"
fi

# --------------------------------------------------------- dependencies -----
say "Dependencies"
corepack enable >/dev/null 2>&1 || true
corepack prepare --activate >/dev/null 2>&1 || true
pnpm install --frozen-lockfile

# Workspace packages resolve to dist/, so the API and worker cannot start until
# the packages are compiled. The web app is built here too so `next start`
# serves a production build rather than compiling on first request.
say "Build"
pnpm build

# ----------------------------------------------------------- migrations -----
say "Migrations"
pnpm db:migrate

say "Setup complete"
echo "Services start automatically (see .devcontainer/start.sh)."
