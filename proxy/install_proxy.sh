#!/usr/bin/env bash
set -euo pipefail

EXTENSION_DIR="${EXTENSION_DIR:-$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)}"
SUBWAVE_DIR="${SUBWAVE_DIR:-$HOME/subwave}"
RUNTIME_DIR="$EXTENSION_DIR/.runtime"
BASE_CADDYFILE="$RUNTIME_DIR/Caddyfile.base"
CANDIDATE_CADDYFILE="$RUNTIME_DIR/Caddyfile.candidate"
GENERATED_CADDYFILE="$RUNTIME_DIR/Caddyfile"
OVERRIDE_FILE="$RUNTIME_DIR/subwave-news-bulletin.override.yml"
ENV_STATE="$RUNTIME_DIR/compose-file-state.json"
SUBWAVE_ENV="$SUBWAVE_DIR/.env"

say() { printf '\n\033[1;35m%s\033[0m\n' "$*"; }
die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

mkdir -p "$RUNTIME_DIR"
[[ -f "$SUBWAVE_ENV" ]] || die "SUB/WAVE .env not found at $SUBWAVE_ENV"

CADDY_ID="$(cd "$SUBWAVE_DIR" && docker compose ps -q caddy)"
[[ -n "$CADDY_ID" ]] || die "The SUB/WAVE Caddy container is not running."
CADDY_IMAGE_ID="$(docker inspect "$CADDY_ID" --format '{{.Image}}')"
[[ -n "$CADDY_IMAGE_ID" ]] || die "Could not determine the SUB/WAVE Caddy image."

say "Generating the /news-bulletin/ route from the installed SUB/WAVE Caddy image"
docker run --rm --entrypoint cat "$CADDY_IMAGE_ID" /etc/caddy/Caddyfile > "$BASE_CADDYFILE"
python3 "$EXTENSION_DIR/proxy/generate_caddy.py" \
  "$BASE_CADDYFILE" "$CANDIDATE_CADDYFILE" \
  --manager-host subwave-news-bulletin \
  --manager-port 7711 \
  --path /news-bulletin/

docker run --rm \
  --entrypoint caddy \
  -v "$CANDIDATE_CADDYFILE:/etc/caddy/Caddyfile:ro" \
  "$CADDY_IMAGE_ID" \
  validate --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null

if [[ -f "$GENERATED_CADDYFILE" ]]; then
  cp "$GENERATED_CADDYFILE" "$RUNTIME_DIR/Caddyfile.previous"
  cat "$CANDIDATE_CADDYFILE" > "$GENERATED_CADDYFILE"
else
  cp "$CANDIDATE_CADDYFILE" "$GENERATED_CADDYFILE"
fi
printf '%s\n' "$CADDY_IMAGE_ID" > "$RUNTIME_DIR/caddy-image-id"

cat > "$OVERRIDE_FILE" <<YAML
services:
  caddy:
    volumes:
      - "$GENERATED_CADDYFILE:/etc/caddy/Caddyfile:ro"
YAML

python3 "$EXTENSION_DIR/proxy/manage_compose_env.py" install \
  --env "$SUBWAVE_ENV" \
  --override "$OVERRIDE_FILE" \
  --state "$ENV_STATE" \
  --subwave-dir "$SUBWAVE_DIR"

say "Recreating only the SUB/WAVE edge proxy with the reversible overlay"
(
  cd "$SUBWAVE_DIR"
  docker compose up -d --no-deps --force-recreate caddy
)

# Confirm the exact mounted config validates inside the real container too.
CADDY_ID="$(cd "$SUBWAVE_DIR" && docker compose ps -q caddy)"
docker exec "$CADDY_ID" caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null

printf 'The manager is now available at /news-bulletin/ on the normal SUB/WAVE address.\n'
