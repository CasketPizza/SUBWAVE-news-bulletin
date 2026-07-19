#!/usr/bin/env bash
set -euo pipefail

EXTENSION_DIR="${EXTENSION_DIR:-$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)}"
SUBWAVE_DIR="${SUBWAVE_DIR:-$HOME/subwave}"
RUNTIME_DIR="$EXTENSION_DIR/.runtime"
OVERRIDE_FILE="$RUNTIME_DIR/subwave-news-bulletin.override.yml"
ENV_STATE="$RUNTIME_DIR/compose-file-state.json"
SUBWAVE_ENV="$SUBWAVE_DIR/.env"

python3 "$EXTENSION_DIR/proxy/manage_compose_env.py" uninstall \
  --env "$SUBWAVE_ENV" \
  --override "$OVERRIDE_FILE" \
  --state "$ENV_STATE"

(
  cd "$SUBWAVE_DIR"
  docker compose up -d --no-deps --force-recreate caddy
)

echo "Removed the /news-bulletin/ proxy overlay and restored SUB/WAVE's normal Caddy configuration."
