#!/usr/bin/env bash
set -euo pipefail

EXTENSION_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
SUBWAVE_DIR="${SUBWAVE_DIR:-$HOME/subwave}"
MANAGER_PORT="${MANAGER_PORT:-7711}"
TZ="${TZ:-Australia/Sydney}"

say() { printf '\n\033[1;35m%s\033[0m\n' "$*"; }
die() { printf '\nERROR: %s\n' "$*" >&2; exit 1; }

command -v docker >/dev/null || die "Docker is not installed."
docker compose version >/dev/null 2>&1 || die "Docker Compose is not available."
[[ -d "$SUBWAVE_DIR" ]] || die "SUB/WAVE was not found at $SUBWAVE_DIR."
[[ -f "$SUBWAVE_DIR/docker-compose.yml" ]] || die "No docker-compose.yml was found in $SUBWAVE_DIR."
[[ -f "$SUBWAVE_DIR/.env" ]] || die "No SUB/WAVE .env file was found in $SUBWAVE_DIR."

cd "$SUBWAVE_DIR"
CONTROLLER_ID="$(docker compose ps -q controller)"
[[ -n "$CONTROLLER_ID" ]] || die "The SUB/WAVE controller container is not running."

SUBWAVE_NETWORK="$(docker inspect "$CONTROLLER_ID" \
  --format '{{range $name, $cfg := .NetworkSettings.Networks}}{{$name}}{{"\n"}}{{end}}' \
  | head -n1)"
[[ -n "$SUBWAVE_NETWORK" ]] || die "Could not detect the SUB/WAVE Docker network."

# Use the running container's actual bind mount. This works whether the operator
# used ./state, an absolute path, or a custom STATE_DIR in compose.
SUBWAVE_STATE_DIR="$(docker inspect "$CONTROLLER_ID" \
  --format '{{range .Mounts}}{{if eq .Destination "/var/sub-wave"}}{{.Source}}{{end}}{{end}}')"
[[ -n "$SUBWAVE_STATE_DIR" ]] || die "Could not detect SUB/WAVE's persistent state mount."

cat > "$EXTENSION_DIR/.env" <<ENVEOF
EXTENSION_DIR=$EXTENSION_DIR
SUBWAVE_DIR=$SUBWAVE_DIR
SUBWAVE_STATE_DIR=$SUBWAVE_STATE_DIR
SUBWAVE_NETWORK=$SUBWAVE_NETWORK
MANAGER_PORT=$MANAGER_PORT
TZ=$TZ
ENVEOF

say "Installing the persistent custom skill"
docker exec "$CONTROLLER_ID" mkdir -p /var/sub-wave/skills/hourly-news-bulletin
docker cp "$EXTENSION_DIR/skill/SKILL.md" "$CONTROLLER_ID:/var/sub-wave/skills/hourly-news-bulletin/SKILL.md"
docker cp "$EXTENSION_DIR/skill/tool.mjs" "$CONTROLLER_ID:/var/sub-wave/skills/hourly-news-bulletin/tool.mjs"

say "Building and starting the standalone News Bulletin Manager"
cd "$EXTENSION_DIR"
docker compose --env-file "$EXTENSION_DIR/.env" build news-bulletin-manager
docker compose --env-file "$EXTENSION_DIR/.env" up -d news-bulletin-manager

say "Rescanning SUB/WAVE skills"
docker exec -i "$CONTROLLER_ID" node - <<'NODE' || true
(async () => {
  const auth = 'Basic ' + Buffer.from(`${process.env.ADMIN_USER || ''}:${process.env.ADMIN_PASS || ''}`).toString('base64');
  const response = await fetch('http://127.0.0.1:7701/dj/skills/rescan', {
    method: 'POST',
    headers: { Authorization: auth },
  });
  console.log(await response.text());
})().catch(console.error);
NODE

say "Waiting for the manager"
for _ in $(seq 1 30); do
  if curl -fsS "http://127.0.0.1:${MANAGER_PORT}/health" >/dev/null 2>&1; then
    break
  fi
  sleep 2
done

HOST_IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
say "Installed — SUB/WAVE itself was not patched"
printf 'Open the manager at: http://%s:%s\n' "${HOST_IP:-YOUR-SUBWAVE-IP}" "$MANAGER_PORT"
printf 'It uses the same login as the SUB/WAVE admin page.\n'
printf 'Default schedule: news at :01, immediately after the normal hourly announcement.\n'
