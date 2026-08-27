#!/usr/bin/env bash
#
# Bring the MART stack up inside the Codespace and make the web app reachable.
#
# Runs on every container start, so it must be safe to run repeatedly: any
# process already listening on its port is left alone.
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

LOG_DIR=".devcontainer/logs"
mkdir -p "$LOG_DIR"

say() { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }

if [ "$(id -u)" -eq 0 ]; then ROOT_RUN=(); else ROOT_RUN=(sudo); fi
listening() { (exec 3<>"/dev/tcp/127.0.0.1/$1") >/dev/null 2>&1; }

wait_for() {
  local port="$1" name="$2"
  for _ in $(seq 1 60); do
    listening "$port" && { echo "  $name is up on :$port"; return 0; }
    sleep 1
  done
  echo "  $name did NOT come up on :$port - see $LOG_DIR/$name.log"
  return 1
}

start() {
  local name="$1" port="$2"
  shift 2
  if listening "$port"; then
    echo "  $name already listening on :$port"
    return 0
  fi
  nohup "$@" > "$LOG_DIR/$name.log" 2>&1 < /dev/null &
  disown || true
}

say "PostgreSQL"
"${ROOT_RUN[@]}" service postgresql start >/dev/null 2>&1 || true
for _ in $(seq 1 30); do pg_isready -q && break; sleep 1; done
pg_isready || { echo "PostgreSQL is not running - run: bash .devcontainer/postCreate.sh"; exit 1; }
echo "  postgres is accepting connections"

if [ ! -f .env ]; then
  echo "No .env found - run: bash .devcontainer/postCreate.sh"
  exit 1
fi
set -a; . ./.env; set +a

say "Starting services"
# Synthetic provider data. Refuses to run unless explicitly enabled, and refuses
# to run at all under NODE_ENV=production.
MART_ENABLE_FIXTURES=true start fixture 4900 node scripts/fixture-provider-server.mjs
start api 4000 node apps/api/dist/server.js
start worker 4001 node apps/worker/dist/worker.js
# `next start` resolves .next relative to its working directory, so it has to run
# from apps/web, not the repo root. NODE_ENV is forced to production because this
# is the production server; .env sets development for the API and worker.
start web 3000 bash -c 'cd apps/web && NODE_ENV=production exec ./node_modules/.bin/next start -p 3000'

wait_for 4900 fixture
wait_for 4000 api
wait_for 4001 worker
wait_for 3000 web

say "Health"
curl -s http://localhost:4000/ready || echo "  API readiness check failed"
echo
curl -s http://localhost:4001/ready || echo "  worker readiness check failed"
echo

# ------------------------------------------------------- port visibility ----
# devcontainer.json declares port 3000 as public. Some organisation policies
# override that default, so confirm it and try once to set it explicitly.
say "Public URL"
if [ -n "${CODESPACE_NAME:-}" ]; then
  URL="https://${CODESPACE_NAME}-3000.${GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN:-app.github.dev}"
  if command -v gh >/dev/null 2>&1; then
    gh codespace ports visibility 3000:public -c "$CODESPACE_NAME" >/dev/null 2>&1 \
      && echo "  port 3000 set to PUBLIC" \
      || echo "  could not set visibility from the CLI - open the PORTS tab, right-click port 3000 -> Port Visibility -> Public"
  fi
  echo "  $URL"
else
  echo "  http://localhost:3000 (not running inside a Codespace)"
fi

cat <<'BANNER'

  All data in this environment is SYNTHETIC fixture data. No Meta, AppsFlyer or
  Tenjin credentials are involved and no real provider API is ever contacted.
  The dashboard says so on every page it affects.

  First run:
    1. Create a workspace (password: 12+ chars, upper + lower + a digit)
    2. Create an app
    3. Integrations -> Connect Meta Ads -> any 20+ character string as the token
       -> Discover accounts -> "FIXTURE Ad Account (synthetic)" -> Use for this app
    4. Primary attribution provider -> AppsFlyer -> confirm
    5. Connect AppsFlyer -> any 20+ character string -> App id: id_FIXTURE_APP
       -> Validate and add app -> Use for this app
    6. Initial historical sync -> wait ~10s -> Command Center

  Logs: .devcontainer/logs/{fixture,api,worker,web}.log
BANNER
