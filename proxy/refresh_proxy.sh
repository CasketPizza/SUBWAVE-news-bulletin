#!/usr/bin/env bash
set -euo pipefail

EXTENSION_DIR="${EXTENSION_DIR:-$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)}"
SUBWAVE_DIR="${SUBWAVE_DIR:-$HOME/subwave}"
RUNTIME_DIR="$EXTENSION_DIR/.runtime"
GENERATED_CADDYFILE="$RUNTIME_DIR/Caddyfile"
IMAGE_STATE="$RUNTIME_DIR/caddy-image-id"
FORCE="${1:-}"

mkdir -p "$RUNTIME_DIR"
CADDY_ID="$(cd "$SUBWAVE_DIR" && docker compose ps -q caddy 2>/dev/null || true)"
[[ -n "$CADDY_ID" ]] || exit 0
CADDY_IMAGE_ID="$(docker inspect "$CADDY_ID" --format '{{.Image}}')"
PREVIOUS_IMAGE="$(cat "$IMAGE_STATE" 2>/dev/null || true)"

if [[ "$FORCE" != "--force" && -f "$GENERATED_CADDYFILE" && "$CADDY_IMAGE_ID" == "$PREVIOUS_IMAGE" ]]; then
  exit 0
fi

BASE="$RUNTIME_DIR/Caddyfile.base.refresh"
CANDIDATE="$RUNTIME_DIR/Caddyfile.candidate.refresh"
BACKUP="$RUNTIME_DIR/Caddyfile.before-refresh"

docker run --rm --entrypoint cat "$CADDY_IMAGE_ID" /etc/caddy/Caddyfile > "$BASE"
python3 "$EXTENSION_DIR/proxy/generate_caddy.py" \
  "$BASE" "$CANDIDATE" \
  --manager-host subwave-news-bulletin \
  --manager-port 7711 \
  --path /news-bulletin/

docker run --rm \
  --entrypoint caddy \
  -v "$CANDIDATE:/etc/caddy/Caddyfile:ro" \
  "$CADDY_IMAGE_ID" \
  validate --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null

if [[ -f "$GENERATED_CADDYFILE" ]]; then
  cp "$GENERATED_CADDYFILE" "$BACKUP"
  # Write in-place so Docker's file bind mount keeps seeing the same inode.
  cat "$CANDIDATE" > "$GENERATED_CADDYFILE"
else
  cp "$CANDIDATE" "$GENERATED_CADDYFILE"
fi

if ! docker exec "$CADDY_ID" caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null; then
  if [[ -f "$BACKUP" ]]; then
    cat "$BACKUP" > "$GENERATED_CADDYFILE"
    docker exec "$CADDY_ID" caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null || true
  fi
  echo "Proxy refresh failed; the previous Caddyfile was restored." >&2
  exit 1
fi

printf '%s\n' "$CADDY_IMAGE_ID" > "$IMAGE_STATE"
echo "Proxy route refreshed from the current SUB/WAVE Caddy image."
