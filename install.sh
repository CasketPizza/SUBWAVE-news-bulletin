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
command -v python3 >/dev/null || die "Python 3 is not installed."
[[ -d "$SUBWAVE_DIR" ]] || die "SUB/WAVE was not found at $SUBWAVE_DIR. Run with SUBWAVE_DIR=/your/path ./install.sh"
[[ -f "$SUBWAVE_DIR/docker-compose.yml" ]] || die "No docker-compose.yml was found in $SUBWAVE_DIR."
[[ -f "$SUBWAVE_DIR/.env" ]] || die "No SUB/WAVE .env file was found in $SUBWAVE_DIR."

cd "$SUBWAVE_DIR"
CONTROLLER_ID="$(docker compose ps -q controller)"
[[ -n "$CONTROLLER_ID" ]] || die "The SUB/WAVE controller container is not running."

SUBWAVE_NETWORK="$(docker inspect "$CONTROLLER_ID" \
  --format '{{range $name, $cfg := .NetworkSettings.Networks}}{{$name}}{{"\n"}}{{end}}' \
  | head -n1)"
[[ -n "$SUBWAVE_NETWORK" ]] || die "Could not detect the SUB/WAVE Docker network."

STATE_SETTING="$(grep -E '^[[:space:]]*STATE_DIR=' "$SUBWAVE_DIR/.env" 2>/dev/null | tail -n1 | cut -d= -f2- | tr -d '"' | tr -d "'" || true)"
if [[ -z "$STATE_SETTING" ]]; then
  SUBWAVE_STATE_DIR="$SUBWAVE_DIR/state"
elif [[ "$STATE_SETTING" = /* ]]; then
  SUBWAVE_STATE_DIR="$STATE_SETTING"
else
  SUBWAVE_STATE_DIR="$SUBWAVE_DIR/$STATE_SETTING"
fi
mkdir -p "$SUBWAVE_STATE_DIR/extensions/hourly-news" "$SUBWAVE_STATE_DIR/skills/hourly-news-bulletin"

cat > "$EXTENSION_DIR/.env" <<ENVEOF
EXTENSION_DIR=$EXTENSION_DIR
SUBWAVE_DIR=$SUBWAVE_DIR
SUBWAVE_STATE_DIR=$SUBWAVE_STATE_DIR
SUBWAVE_NETWORK=$SUBWAVE_NETWORK
MANAGER_PORT=$MANAGER_PORT
TZ=$TZ
HOST_UID=$(id -u)
HOST_GID=$(id -g)
ENVEOF

say "Installing the persistent custom skill"
cp "$EXTENSION_DIR/skill/SKILL.md" "$SUBWAVE_STATE_DIR/skills/hourly-news-bulletin/SKILL.md"
cp "$EXTENSION_DIR/skill/tool.mjs" "$SUBWAVE_STATE_DIR/skills/hourly-news-bulletin/tool.mjs"

say "Applying the two small SUB/WAVE hooks"
python3 "$EXTENSION_DIR/patches/patch_subwave.py" apply --subwave-dir "$SUBWAVE_DIR"

say "Rebuilding the SUB/WAVE controller"
cd "$SUBWAVE_DIR"
docker compose build controller
docker compose up -d --no-deps controller

say "Building and starting the Hourly News Manager"
cd "$EXTENSION_DIR"
docker compose build news-bulletin-manager
docker compose up -d news-bulletin-manager

say "Rescanning SUB/WAVE skills"
sleep 4
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

HOST_IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
say "Installed"
printf 'Open the manager at: http://%s:%s\n' "${HOST_IP:-YOUR-SUBWAVE-IP}" "$MANAGER_PORT"
printf 'It uses the same browser login as the SUB/WAVE admin page.\n'
printf '\nThe default schedule is: normal hourly announcement, then the news bulletin.\n'
