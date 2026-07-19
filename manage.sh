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
  docker compose --env-file "$EXTENSION_DIR/.env" -f "$EXTENSION_DIR/docker-compose.yml" "$@"
}

install_skill_files() {
  mkdir -p "$SUBWAVE_STATE_DIR/skills/hourly-news-bulletin"
  cp "$EXTENSION_DIR/skill/SKILL.md" "$SUBWAVE_STATE_DIR/skills/hourly-news-bulletin/SKILL.md"
  cp "$EXTENSION_DIR/skill/tool.mjs" "$SUBWAVE_STATE_DIR/skills/hourly-news-bulletin/tool.mjs"
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
}

case "${1:-status}" in
  status)
    compose ps
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
    ;;
  uninstall)
    say "Stopping and removing the companion container"
    compose down
    printf 'Settings and uploaded audio were kept in: %s\n' "$DATA_DIR"
    printf 'The SUB/WAVE skill was kept. Remove it from Admin → Skills when desired.\n'
    ;;
  *)
    echo "Usage: ./manage.sh {status|update|rollback|restart|uninstall}"
    exit 2
    ;;
esac
