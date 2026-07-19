# SUB/WAVE Hourly News Bulletin

A standalone companion for [SUB/WAVE](https://github.com/perminder-klair/subwave).
It adds an hourly multi-source news bulletin without patching, rebuilding, or
replacing SUB/WAVE application code.

## Normal address

The manager is mounted below the same address already used for SUB/WAVE:

```text
/news-bulletin/
```

Examples:

```text
http://192.168.1.196:7700/news-bulletin/
http://subwave:7700/news-bulletin/
https://radio.example.com/news-bulletin/
```

Nothing is hard-coded to one IP. Changing the station's LAN address, hostname,
or public domain changes the full URL automatically because only the relative
path is stored.

The custom skill also displays this instruction near the top of its brief:

```text
ADVANCED CONFIGURATION: Open /news-bulletin/ on the same address you use for SUB/WAVE.
```

SUB/WAVE currently renders custom-skill briefs as plain text, so the path is
visible in the skill editor but is not a clickable custom button.

## What it does

- Reads multiple RSS 2.0 or Atom news feeds
- Uses SUB/WAVE's active on-air persona
- Uses SUB/WAVE's configured primary LLM, with configured fallback support
- Uses SUB/WAVE's configured TTS engine and voice
- Uploads an intro jingle, a background news bed, and an outro jingle
- Mixes the voice over the background bed with adjustable level and fades
- Queues one complete foreground package through SUB/WAVE's existing `say.txt`
  handoff
- Provides settings, uploads, run-now testing, updates, and rollback

## Default on-air sequence

```text
SUB/WAVE normal hourly announcement at :00
→ complete news package queues at :01
→ intro jingle
→ headlines over the uploaded background bed
→ outro jingle
→ normal station audio continues
```

The schedule may instead be set to:

- Before the hourly announcement, at `:59`
- A selected minute each hour
- Manual only

There is no “replace the native hourly announcement” option because doing that
would require changing SUB/WAVE's scheduler.

## What it changes

It writes persistent operator data to:

```text
SUBWAVE_STATE/skills/hourly-news-bulletin/
SUBWAVE_STATE/extensions/hourly-news/
```

It starts one separate Docker container:

```text
subwave-news-bulletin
```

To place the manager on the normal SUB/WAVE address, it also installs a small,
reversible Docker Compose overlay for the existing Caddy service. The overlay:

- Mounts a generated Caddyfile at `/etc/caddy/Caddyfile`
- Adds only the `/news-bulletin/` reverse-proxy route
- Is generated from the Caddyfile inside the currently installed SUB/WAVE Caddy
  image, rather than shipping a frozen copy
- Is recorded in SUB/WAVE's `.env` through `COMPOSE_FILE`
- Preserves any existing `docker-compose.override.yml`
- Is removed cleanly by `./manage.sh uninstall`

No SUB/WAVE TypeScript, JavaScript, scheduler, controller, web, Liquidsoap, or
image source is edited. SUB/WAVE's own Caddy image explicitly supports replacing
`/etc/caddy/Caddyfile` with an operator mount.

The manager checks for a changed SUB/WAVE Caddy image every five minutes. When it
finds one, it regenerates the overlay from that image and hot-reloads Caddy, so
upstream proxy changes are retained.

## Install

Run these commands on the Ubuntu machine that already runs SUB/WAVE:

```bash
cd ~
git clone https://github.com/CasketPizza/SUBWAVE-news-bulletin.git
cd SUBWAVE-news-bulletin
chmod +x install.sh manage.sh
./install.sh
```

The installer discovers the actual SUB/WAVE state bind mount from the running
controller container, so it works with `./state`, an absolute state path, or a
custom Compose configuration.

For a non-default SUB/WAVE directory:

```bash
SUBWAVE_DIR=/path/to/subwave ./install.sh
```

When installation completes, open `/news-bulletin/` on the same address used for
SUB/WAVE. The page uses the same HTTP Basic username and password as the
SUB/WAVE admin page.

## First setup

1. Confirm the status panel shows the correct persona, LLM, and voice.
2. Add or remove RSS/Atom sources.
3. Upload the intro jingle.
4. Upload the background music.
5. Upload the outro jingle.
6. Start with the bed around `-18 dB`.
7. Save.
8. Press **Run bulletin now**.

Uploads are converted to stereo 44.1 kHz WAV with FFmpeg. WAV, MP3, FLAC, OGG,
M4A, and other FFmpeg-readable audio formats are accepted.

## LLM compatibility

The companion follows SUB/WAVE's saved provider/model settings. Supported
providers include Ollama, OpenAI, OpenAI-compatible, Locca, Anthropic, Google
Gemini, DeepSeek, OpenRouter, Requesty, and compatible Gateway endpoints.

API keys are read from the same environment and persistent `secrets.env` used by
SUB/WAVE. OpenAI-compatible inline keys are read from SUB/WAVE's persistent
settings file. Keys are never shown in the manager UI.

## TTS compatibility

The manager calls SUB/WAVE's existing authenticated TTS preview endpoint with the
active persona's engine, voice, language, and speed. That supports whichever TTS
engines the installed SUB/WAVE controller already supports, including custom
Piper voices.

## Updating

Use the manager page:

```text
Check for updates → Update now
```

The updater changes only this companion repository, companion container, skill
files, and its reversible Caddy overlay. It preserves feeds, schedule settings,
seen-headline history, and uploaded audio under SUB/WAVE's persistent state.

Use **Roll back** to return to the previously installed companion commit.

## Manual recovery commands

```bash
cd ~/SUBWAVE-news-bulletin
./manage.sh status
./manage.sh update
./manage.sh rollback
./manage.sh restart
./manage.sh refresh-proxy
./manage.sh uninstall
```

`uninstall` removes the `/news-bulletin/` Caddy route, restores the previous
Compose file list, and removes the companion container. Settings and audio are
kept. The custom skill can be removed separately from **Admin → Skills**.

## Security

The manager uses SUB/WAVE's admin Basic Auth. Because it is now on the same
origin, any Cloudflare Tunnel or reverse proxy that exposes the complete SUB/WAVE
host also exposes `/news-bulletin/`. Protect the admin surface with Cloudflare
Access or another access-control layer when the station is internet-facing.

## Native skill fallback

The installer adds a normal custom skill named **Hourly multi-source news
bulletin**. Keep it disabled to avoid duplicate autonomous bulletins. Its
SUB/WAVE **Run now** action remains available as a plain spoken fallback; the
manager page supplies the intro, background bed, outro, and portable scheduler.
