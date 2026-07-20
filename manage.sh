#!/usr/bin/env bash
set -euo pipefail

EXTENSION_DIR="${EXTENSION_DIR:-$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)}"
_PRESET_SUBWAVE_STATE_DIR="${SUBWAVE_STATE_DIR:-}"
_PRESET_DATA_DIR="${DATA_DIR:-}"
if [[ -f "$EXTENSION_DIR/.env" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "$EXTENSION_DIR/.env"
  set +a
fi

SUBWAVE_DIR="${SUBWAVE_DIR:-$HOME/subwave}"
if [[ -n "$_PRESET_SUBWAVE_STATE_DIR" ]]; then SUBWAVE_STATE_DIR="$_PRESET_SUBWAVE_STATE_DIR"; fi
SUBWAVE_STATE_DIR="${SUBWAVE_STATE_DIR:-$SUBWAVE_DIR/state}"
if [[ -n "$_PRESET_DATA_DIR" ]]; then DATA_DIR="$_PRESET_DATA_DIR"; fi
DATA_DIR="${DATA_DIR:-$SUBWAVE_STATE_DIR/extensions/hourly-news}"
SUBWAVE_CONTROLLER_NETWORK="${SUBWAVE_CONTROLLER_NETWORK:-${SUBWAVE_NETWORK:-}}"
SUBWAVE_CADDY_NETWORK="${SUBWAVE_CADDY_NETWORK:-${SUBWAVE_NETWORK:-}}"

say() { printf '\n\033[1;35m%s\033[0m\n' "$*"; }
die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

compose() {
  COMPOSE_FILE= docker compose --env-file "$EXTENSION_DIR/.env" -f "$EXTENSION_DIR/docker-compose.yml" "$@"
}

container_networks() {
  local container_id="$1"
  docker inspect "$container_id" --format '{{range $name, $cfg := .NetworkSettings.Networks}}{{$name}}{{"\n"}}{{end}}' \
    | sed '/^[[:space:]]*$/d'
}

first_network() {
  container_networks "$1" | head -n1
}

shared_network() {
  local first_id="$1"
  local second_id="$2"
  local second_networks
  second_networks="$(container_networks "$second_id")"
  while IFS= read -r network; do
    [[ -n "$network" ]] || continue
    if printf '%s\n' "$second_networks" | grep -Fxq "$network"; then
      printf '%s\n' "$network"
      return 0
    fi
  done < <(container_networks "$first_id")
  return 1
}

controller_id() {
  (cd "$SUBWAVE_DIR" && docker compose ps -q controller)
}

broadcast_id() {
  (cd "$SUBWAVE_DIR" && docker compose ps -q broadcast)
}

caddy_id() {
  (cd "$SUBWAVE_DIR" && docker compose ps -q caddy)
}

set_env_key() {
  local key="$1"
  local value="$2"
  local file="$EXTENSION_DIR/.env"
  local tmp="${file}.tmp.$$"
  awk -v key="$key" -v value="$value" '
    BEGIN { done=0 }
    index($0, key "=") == 1 { print key "=" value; done=1; next }
    { print }
    END { if (!done) print key "=" value }
  ' "$file" > "$tmp"
  mv "$tmp" "$file"
}

refresh_detected_networks() {
  local cid bid edge_id audio_network caddy_network detected_state_dir
  cid="$(controller_id)"
  bid="$(broadcast_id)"
  edge_id="$(caddy_id)"
  [[ -n "$cid" ]] || die "The SUB/WAVE controller container is not running."
  [[ -n "$bid" ]] || die "The SUB/WAVE broadcast container is not running."
  [[ -n "$edge_id" ]] || die "The SUB/WAVE Caddy container is not running."

  audio_network="$(shared_network "$cid" "$bid" || true)"
  caddy_network="$(first_network "$edge_id")"
  [[ -n "$audio_network" ]] || die "Could not detect a network shared by SUB/WAVE's controller and broadcast services."
  [[ -n "$caddy_network" ]] || die "Could not detect Caddy's Docker network."
  detected_state_dir="$(docker inspect "$cid" --format '{{range .Mounts}}{{if eq .Destination "/var/sub-wave"}}{{.Source}}{{end}}{{end}}')"
  [[ -n "$detected_state_dir" ]] || die "Could not detect SUB/WAVE's persistent state mount."

  SUBWAVE_STATE_DIR="$detected_state_dir"
  SUBWAVE_AUDIO_NETWORK="$audio_network"
  SUBWAVE_CONTROLLER_NETWORK="$audio_network"
  SUBWAVE_NETWORK="$audio_network"
  SUBWAVE_CADDY_NETWORK="$caddy_network"
  export SUBWAVE_STATE_DIR SUBWAVE_AUDIO_NETWORK SUBWAVE_CONTROLLER_NETWORK SUBWAVE_NETWORK SUBWAVE_CADDY_NETWORK

  # Always recover the actual host-side state path from the running controller.
  # This prevents a container path such as /var/sub-wave from being persisted as
  # a Docker host bind source during UI updates.
  set_env_key SUBWAVE_STATE_DIR "$SUBWAVE_STATE_DIR"
  set_env_key SUBWAVE_AUDIO_NETWORK "$SUBWAVE_AUDIO_NETWORK"
  set_env_key SUBWAVE_CONTROLLER_NETWORK "$SUBWAVE_CONTROLLER_NETWORK"
  set_env_key SUBWAVE_NETWORK "$SUBWAVE_NETWORK"
  set_env_key SUBWAVE_CADDY_NETWORK "$SUBWAVE_CADDY_NETWORK"
}

ensure_runtime_networks() {
  local id
  id="$(compose ps -q news-bulletin-manager)"
  [[ -n "$id" ]] || die "The News Bulletin Manager container is not running."
  [[ -n "$SUBWAVE_AUDIO_NETWORK" ]] || die "SUBWAVE_AUDIO_NETWORK is missing from $EXTENSION_DIR/.env"
  [[ -n "$SUBWAVE_CADDY_NETWORK" ]] || die "SUBWAVE_CADDY_NETWORK is missing from $EXTENSION_DIR/.env"

  # Compose normally creates the manager on the audio network. Keep this explicit
  # for upgrades from older releases whose .env pointed at a controller-only
  # network. The alias is harmless when the network is already attached.
  docker network connect --alias subwave-news-bulletin "$SUBWAVE_AUDIO_NETWORK" "$id" 2>/dev/null || {
    docker inspect "$id" --format '{{json .NetworkSettings.Networks}}' \
      | grep -Fq "\"$SUBWAVE_AUDIO_NETWORK\"" \
      || die "Could not attach the manager to SUB/WAVE's controller/broadcast network: $SUBWAVE_AUDIO_NETWORK"
  }

  if [[ "$SUBWAVE_CADDY_NETWORK" != "$SUBWAVE_AUDIO_NETWORK" ]]; then
    docker network connect --alias subwave-news-bulletin "$SUBWAVE_CADDY_NETWORK" "$id" 2>/dev/null || {
      docker inspect "$id" --format '{{json .NetworkSettings.Networks}}' \
        | grep -Fq "\"$SUBWAVE_CADDY_NETWORK\"" \
        || die "Could not attach the manager to Caddy's network: $SUBWAVE_CADDY_NETWORK"
    }
  fi
}

install_skill_files() {
  local id
  id="$(controller_id)"
  [[ -n "$id" ]] || die "The SUB/WAVE controller container is not running."
  docker exec "$id" mkdir -p /var/sub-wave/skills/hourly-news-bulletin
  docker cp "$EXTENSION_DIR/skill/SKILL.md" "$id:/var/sub-wave/skills/hourly-news-bulletin/SKILL.md"
  docker cp "$EXTENSION_DIR/skill/tool.mjs" "$id:/var/sub-wave/skills/hourly-news-bulletin/tool.mjs"
}

rescan_skill() {
  local id
  id="$(controller_id)"
  [[ -n "$id" ]] || return 0
  docker exec -i "$id" node - <<'NODE' || true
(async () => {
  const auth = 'Basic ' + Buffer.from(`${process.env.ADMIN_USER || ''}:${process.env.ADMIN_PASS || ''}`).toString('base64');
  const response = await fetch('http://127.0.0.1:7701/dj/skills/rescan', {
    method: 'POST',
    headers: { Authorization: auth },
  });
  console.log(await response.text());
})().catch(console.error);
NODE
}

install_proxy() {
  bash "$EXTENSION_DIR/proxy/install_proxy.sh"
}

refresh_proxy() {
  bash "$EXTENSION_DIR/proxy/refresh_proxy.sh" --force
}

remove_proxy() {
  bash "$EXTENSION_DIR/proxy/remove_proxy.sh"
}

restore_checkout_owner() {
  [[ "${HOST_REPO_UID:-}" =~ ^[0-9]+$ ]] || return 0
  [[ "${HOST_REPO_GID:-}" =~ ^[0-9]+$ ]] || return 0
  chown -R "$HOST_REPO_UID:$HOST_REPO_GID" "$EXTENSION_DIR" 2>/dev/null || true
}

update_worker() {
  trap restore_checkout_owner EXIT
  mkdir -p "$DATA_DIR"
  git config --global --add safe.directory "$EXTENSION_DIR" >/dev/null 2>&1 || true
  current="$(git -C "$EXTENSION_DIR" rev-parse HEAD)"
  printf '%s\n' "$current" > "$DATA_DIR/previous-version"
  git -C "$EXTENSION_DIR" fetch --prune origin main
  git -C "$EXTENSION_DIR" reset --hard origin/main
  install_skill_files
  refresh_detected_networks
  compose build news-bulletin-manager
  compose up -d --force-recreate news-bulletin-manager
  ensure_runtime_networks
  install_proxy
  sleep 3
  rescan_skill
}

rollback_worker() {
  trap restore_checkout_owner EXIT
  [[ -f "$DATA_DIR/previous-version" ]] || die "No previous version is recorded."
  target="$(tr -d '\r\n' < "$DATA_DIR/previous-version")"
  [[ -n "$target" ]] || die "The previous-version file is empty."
  git config --global --add safe.directory "$EXTENSION_DIR" >/dev/null 2>&1 || true
  current="$(git -C "$EXTENSION_DIR" rev-parse HEAD)"
  git -C "$EXTENSION_DIR" reset --hard "$target"
  printf '%s\n' "$current" > "$DATA_DIR/previous-version"
  install_skill_files
  refresh_detected_networks
  compose build news-bulletin-manager
  compose up -d --force-recreate news-bulletin-manager
  ensure_runtime_networks
  install_proxy
  sleep 3
  rescan_skill
}

case "${1:-status}" in
  status)
    compose ps
    printf '\nContainer networks:\n'
    id="$(compose ps -q news-bulletin-manager)"
    if [[ -n "$id" ]]; then
      docker inspect "$id" --format '{{range $name, $cfg := .NetworkSettings.Networks}}  - {{$name}}{{"\n"}}{{end}}'
    fi
    printf '\nProxy route:\n'
    curl -fsS "http://127.0.0.1:${CADDY_PORT:-7700}/news-bulletin/health" 2>/dev/null \
      || printf 'not reachable through local Caddy\n'
    printf '\n'
    ;;
  update|update-worker)
    say "Updating the News Bulletin companion"
    update_worker
    ;;
  rollback|rollback-worker)
    say "Rolling back the News Bulletin companion"
    rollback_worker
    ;;
  restart)
    refresh_detected_networks
    compose up -d --force-recreate news-bulletin-manager
    ensure_runtime_networks
    refresh_proxy
    ;;
  ensure-network)
    refresh_detected_networks
    ensure_runtime_networks
    ;;
  refresh-proxy)
    say "Refreshing the /news-bulletin/ route from the current SUB/WAVE Caddy image"
    refresh_proxy
    ;;
  uninstall)
    say "Removing the /news-bulletin/ route"
    remove_proxy
    say "Stopping and removing the companion container"
    compose down
    printf 'Settings and uploaded audio were kept in: %s\n' "$DATA_DIR"
    printf 'The SUB/WAVE skill was kept. Remove it from Admin → Skills when desired.\n'
    ;;
  *)
    echo "Usage: ./manage.sh {status|update|rollback|restart|ensure-network|refresh-proxy|uninstall}"
    exit 2
    ;;
esac
