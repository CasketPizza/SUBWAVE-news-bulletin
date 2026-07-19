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

say() { printf '\n\033[1;35m%s\033[0m\n' "$*"; }
die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

compose() {
  COMPOSE_FILE= docker compose --env-file "$EXTENSION_DIR/.env" -f "$EXTENSION_DIR/docker-compose.yml" "$@"
}

controller_id() {
  (cd "$SUBWAVE_DIR" && docker compose ps -q controller)
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

update_worker() {
  mkdir -p "$DATA_DIR"
  git config --global --add safe.directory "$EXTENSION_DIR" >/dev/null 2>&1 || true
  current="$(git -C "$EXTENSION_DIR" rev-parse HEAD)"
  printf '%s\n' "$current" > "$DATA_DIR/previous-version"
  git -C "$EXTENSION_DIR" fetch --prune origin main
  git -C "$EXTENSION_DIR" reset --hard origin/main
  install_skill_files
  compose build news-bulletin-manager
  compose up -d --force-recreate news-bulletin-manager
  install_proxy
  sleep 3
  rescan_skill
}

rollback_worker() {
  [[ -f "$DATA_DIR/previous-version" ]] || die "No previous version is recorded."
  target="$(tr -d '\r\n' < "$DATA_DIR/previous-version")"
  [[ -n "$target" ]] || die "The previous-version file is empty."
  git config --global --add safe.directory "$EXTENSION_DIR" >/dev/null 2>&1 || true
  current="$(git -C "$EXTENSION_DIR" rev-parse HEAD)"
  git -C "$EXTENSION_DIR" reset --hard "$target"
  printf '%s\n' "$current" > "$DATA_DIR/previous-version"
  install_skill_files
  compose build news-bulletin-manager
  compose up -d --force-recreate news-bulletin-manager
  install_proxy
  sleep 3
  rescan_skill
}

case "${1:-status}" in
  status)
    compose ps
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
    compose up -d --force-recreate news-bulletin-manager
    refresh_proxy
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
    echo "Usage: ./manage.sh {status|update|rollback|restart|refresh-proxy|uninstall}"
    exit 2
    ;;
esac
