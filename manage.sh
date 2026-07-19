#!/usr/bin/env bash
set -euo pipefail

EXTENSION_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
if [[ -f "$EXTENSION_DIR/.env" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "$EXTENSION_DIR/.env"
  set +a
fi
SUBWAVE_DIR="${SUBWAVE_DIR:-$HOME/subwave}"
SUBWAVE_STATE_DIR="${SUBWAVE_STATE_DIR:-$SUBWAVE_DIR/state}"
DATA_DIR="$SUBWAVE_STATE_DIR/extensions/hourly-news"
HOST_UID="${HOST_UID:-$(id -u)}"
HOST_GID="${HOST_GID:-$(id -g)}"

say() { printf '\n\033[1;35m%s\033[0m\n' "$*"; }
die() { echo "ERROR: $*" >&2; exit 1; }

rescan() {
  local id
  id="$(cd "$SUBWAVE_DIR" && docker compose ps -q controller)"
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

reapply() {
  say "Reapplying the Hourly News extension"
  mkdir -p "$SUBWAVE_STATE_DIR/skills/hourly-news-bulletin" "$DATA_DIR"
  cp "$EXTENSION_DIR/skill/tool.mjs" "$SUBWAVE_STATE_DIR/skills/hourly-news-bulletin/tool.mjs"
  if [[ ! -f "$SUBWAVE_STATE_DIR/skills/hourly-news-bulletin/SKILL.md" ]]; then
    cp "$EXTENSION_DIR/skill/SKILL.md" "$SUBWAVE_STATE_DIR/skills/hourly-news-bulletin/SKILL.md"
  fi

  python3 "$EXTENSION_DIR/patches/patch_subwave.py" apply --subwave-dir "$SUBWAVE_DIR"
  (
    cd "$SUBWAVE_DIR"
    docker compose build controller
    docker compose up -d --no-deps controller
  )
  sleep 4
  rescan
  say "Reapply complete"
}

update_internal() {
  mkdir -p "$DATA_DIR"
  git config --global --add safe.directory "$EXTENSION_DIR" >/dev/null 2>&1 || true
  local current latest
  current="$(git -C "$EXTENSION_DIR" rev-parse HEAD)"
  say "Checking GitHub for an extension update"
  git -C "$EXTENSION_DIR" fetch origin main
  latest="$(git -C "$EXTENSION_DIR" rev-parse origin/main)"
  if [[ "$current" == "$latest" ]]; then
    say "Already up to date"
    exit 0
  fi
  printf '%s\n' "$current" > "$DATA_DIR/previous-version"
  git -C "$EXTENSION_DIR" reset --hard origin/main
  chown -R "$HOST_UID:$HOST_GID" "$EXTENSION_DIR" 2>/dev/null || true
  reapply
  (
    cd "$EXTENSION_DIR"
    docker compose build news-bulletin-manager
    docker compose up -d news-bulletin-manager
  )
}

rollback() {
  local previous="$DATA_DIR/previous-version"
  [[ -f "$previous" ]] || die "No previous extension version has been saved."
  git config --global --add safe.directory "$EXTENSION_DIR" >/dev/null 2>&1 || true
  local target current
  target="$(cat "$previous")"
  current="$(git -C "$EXTENSION_DIR" rev-parse HEAD)"
  printf '%s\n' "$current" > "$DATA_DIR/previous-version"
  git -C "$EXTENSION_DIR" reset --hard "$target"
  chown -R "$HOST_UID:$HOST_GID" "$EXTENSION_DIR" 2>/dev/null || true
  reapply
  (
    cd "$EXTENSION_DIR"
    docker compose build news-bulletin-manager
    docker compose up -d news-bulletin-manager
  )
}

status() {
  echo "Extension version: $(cat "$EXTENSION_DIR/VERSION" 2>/dev/null || echo unknown)"
  python3 "$EXTENSION_DIR/patches/patch_subwave.py" check --subwave-dir "$SUBWAVE_DIR" || true
  (cd "$EXTENSION_DIR" && docker compose ps)
}

uninstall() {
  say "Stopping the manager"
  (cd "$EXTENSION_DIR" && docker compose down) || true
  rm -f "$DATA_DIR/suppress-hourly"
  say "Removing SUB/WAVE hooks"
  python3 "$EXTENSION_DIR/patches/patch_subwave.py" remove --subwave-dir "$SUBWAVE_DIR"
  (
    cd "$SUBWAVE_DIR"
    docker compose build controller
    docker compose up -d --no-deps controller
  )
  rm -rf "$SUBWAVE_STATE_DIR/skills/hourly-news-bulletin"
  say "Removed. Your uploaded audio and settings remain in $DATA_DIR"
}

case "${1:-}" in
  reapply) reapply ;;
  update|update-internal) update_internal ;;
  rollback) rollback ;;
  status) status ;;
  uninstall) uninstall ;;
  *) echo "Usage: $0 {status|update|reapply|rollback|uninstall}"; exit 2 ;;
esac
