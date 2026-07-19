#!/usr/bin/env bash
set -euo pipefail

EXTENSION_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
SUBWAVE_DIR="${SUBWAVE_DIR:-$HOME/subwave}"
TZ="${TZ:-Australia/Sydney}"

say() { printf '\n\033[1;35m%s\033[0m\n' "$*"; }
die() { printf '\nERROR: %s\n' "$*" >&2; exit 1; }

first_network() {
  local container_id="$1"
  docker inspect "$container_id" --format '{{range $name, $cfg := .NetworkSettings.Networks}}{{$name}}{{"\n"}}{{end}}' \
    | sed '/^[[:space:]]*$/d' \
    | head -n1
}

connect_manager_to_caddy_network() {
  local manager_id="$1"
  local caddy_network="$2"
  local controller_network="$3"

  [[ -n "$manager_id" ]] || die "The News Bulletin Manager container did not start."
  [[ -n "$caddy_network" ]] || die "Could not determine Caddy's Docker network."

  if [[ "$caddy_network" != "$controller_network" ]]; then
    # A container can be attached to a second network after Compose creates it.
    # --alias makes the Caddy route stable regardless of the generated container id.
    docker network connect --alias subwave-news-bulletin "$caddy_network" "$manager_id" 2>/dev/null || {
      docker inspect "$manager_id" --format '{{json .NetworkSettings.Networks}}' \
        | grep -Fq "\"$caddy_network\"" \
        || die "Could not attach the manager to Caddy's Docker network: $caddy_network"
    }
  fi
}

command -v docker >/dev/null || die "Docker is not installed."
docker compose version >/dev/null 2>&1 || die "Docker Compose is not available."
command -v python3 >/dev/null || die "Python 3 is not installed."
[[ -d "$SUBWAVE_DIR" ]] || die "SUB/WAVE was not found at $SUBWAVE_DIR."
[[ -f "$SUBWAVE_DIR/docker-compose.yml" || -f "$SUBWAVE_DIR/docker-compose.yaml" || -f "$SUBWAVE_DIR/compose.yml" || -f "$SUBWAVE_DIR/compose.yaml" ]] \
  || die "No SUB/WAVE Compose file was found in $SUBWAVE_DIR."
[[ -f "$SUBWAVE_DIR/.env" ]] || die "No SUB/WAVE .env file was found in $SUBWAVE_DIR."

cd "$SUBWAVE_DIR"
CONTROLLER_ID="$(docker compose ps -q controller)"
CADDY_ID="$(docker compose ps -q caddy)"
[[ -n "$CONTROLLER_ID" ]] || die "The SUB/WAVE controller container is not running."
[[ -n "$CADDY_ID" ]] || die "The SUB/WAVE Caddy container is not running."

# The companion needs to reach the controller, while Caddy needs to reach the
# companion. Most SUB/WAVE installs use one shared network, but custom Compose
# overlays can put those services on different networks. Attach the manager to
# both instead of assuming a shared network exists.
SUBWAVE_CONTROLLER_NETWORK="$(first_network "$CONTROLLER_ID")"
SUBWAVE_CADDY_NETWORK="$(first_network "$CADDY_ID")"
[[ -n "$SUBWAVE_CONTROLLER_NETWORK" ]] || die "Could not detect the controller's Docker network."
[[ -n "$SUBWAVE_CADDY_NETWORK" ]] || die "Could not detect Caddy's Docker network."
SUBWAVE_NETWORK="$SUBWAVE_CONTROLLER_NETWORK"

# Use the running container's actual bind mount. This works with ./state,
# absolute paths, and custom STATE_DIR values without confusing the in-container
# /var/sub-wave path with a host path.
SUBWAVE_STATE_DIR="$(docker inspect "$CONTROLLER_ID" \
  --format '{{range .Mounts}}{{if eq .Destination "/var/sub-wave"}}{{.Source}}{{end}}{{end}}')"
[[ -n "$SUBWAVE_STATE_DIR" ]] || die "Could not detect SUB/WAVE's persistent state mount."

cat > "$EXTENSION_DIR/.env" <<ENVEOF
EXTENSION_DIR=$EXTENSION_DIR
SUBWAVE_DIR=$SUBWAVE_DIR
SUBWAVE_STATE_DIR=$SUBWAVE_STATE_DIR
SUBWAVE_NETWORK=$SUBWAVE_NETWORK
SUBWAVE_CONTROLLER_NETWORK=$SUBWAVE_CONTROLLER_NETWORK
SUBWAVE_CADDY_NETWORK=$SUBWAVE_CADDY_NETWORK
TZ=$TZ
ENVEOF

say "Installing the persistent custom skill"
docker exec "$CONTROLLER_ID" mkdir -p /var/sub-wave/skills/hourly-news-bulletin
docker cp "$EXTENSION_DIR/skill/SKILL.md" "$CONTROLLER_ID:/var/sub-wave/skills/hourly-news-bulletin/SKILL.md"
docker cp "$EXTENSION_DIR/skill/tool.mjs" "$CONTROLLER_ID:/var/sub-wave/skills/hourly-news-bulletin/tool.mjs"

say "Building and starting the standalone News Bulletin Manager"
cd "$EXTENSION_DIR"
COMPOSE_FILE= docker compose --env-file "$EXTENSION_DIR/.env" -f "$EXTENSION_DIR/docker-compose.yml" build news-bulletin-manager
COMPOSE_FILE= docker compose --env-file "$EXTENSION_DIR/.env" -f "$EXTENSION_DIR/docker-compose.yml" up -d --force-recreate news-bulletin-manager
MANAGER_ID="$(COMPOSE_FILE= docker compose --env-file "$EXTENSION_DIR/.env" -f "$EXTENSION_DIR/docker-compose.yml" ps -q news-bulletin-manager)"
connect_manager_to_caddy_network "$MANAGER_ID" "$SUBWAVE_CADDY_NETWORK" "$SUBWAVE_CONTROLLER_NETWORK"

say "Adding the reversible /news-bulletin/ route to SUB/WAVE's edge proxy"
bash "$EXTENSION_DIR/proxy/install_proxy.sh"

say "Rescanning SUB/WAVE skills"
CONTROLLER_ID="$(cd "$SUBWAVE_DIR" && docker compose ps -q controller)"
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

CADDY_PORT="$(grep -E '^[[:space:]]*CADDY_PORT=' "$SUBWAVE_DIR/.env" 2>/dev/null | tail -n1 | cut -d= -f2- | tr -d "\"'" || true)"
CADDY_PORT="${CADDY_PORT:-7700}"

say "Waiting for the manager through SUB/WAVE"
READY=0
for _ in $(seq 1 30); do
  if curl -fsS "http://127.0.0.1:${CADDY_PORT}/news-bulletin/health" >/dev/null 2>&1; then
    READY=1
    break
  fi
  sleep 2
done
[[ "$READY" == "1" ]] || die "The manager started, but /news-bulletin/ did not become reachable. Run ./manage.sh status and docker logs subwave-news-bulletin."

HOST_IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
say "Installed — no SUB/WAVE application source was patched"
printf 'Open this path on the same address you use for SUB/WAVE:\n\n'
printf '  /news-bulletin/\n\n'
printf 'LAN example: http://%s:%s/news-bulletin/\n' "${HOST_IP:-YOUR-SUBWAVE-IP}" "$CADDY_PORT"
printf 'The path also follows any hostname or HTTPS domain already used for SUB/WAVE.\n'
printf 'It uses the same admin username and password.\n'
printf 'Default schedule: news at :01, immediately after the normal hourly announcement.\n'
