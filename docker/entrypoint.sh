#!/bin/sh
#
# Supply MART_CREDENTIAL_KEY without committing one.
#
# Provider credentials are encrypted with this key, so it has to be stable
# across restarts - rotating it makes every stored credential undecryptable. It
# also must not live in the repository. So it is generated once into a named
# volume and read from there afterwards.
#
# The migration service runs first and creates the key; the API and the worker
# only ever read it, which is why there is no lock here.
set -eu

KEY_DIR="${MART_KEY_DIR:-/run/mart}"
KEY_FILE="$KEY_DIR/credential.key"

# The directory only exists where the key volume is mounted, which is exactly
# the set of services that need a key. The web service has no business holding
# one, and skips this entirely.
if [ -z "${MART_CREDENTIAL_KEY:-}" ] && [ -d "$KEY_DIR" ]; then
  if [ ! -s "$KEY_FILE" ]; then
    node -e "process.stdout.write(require('crypto').randomBytes(32).toString('base64'))" > "$KEY_FILE"
    chmod 600 "$KEY_FILE"
    echo "mart: generated a local credential key in the key volume" >&2
  fi
  MART_CREDENTIAL_KEY="$(cat "$KEY_FILE")"
  export MART_CREDENTIAL_KEY
fi

exec "$@"
