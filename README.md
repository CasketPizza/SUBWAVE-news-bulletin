# SUB/WAVE Hourly News Bulletin

A standalone companion for [SUB/WAVE](https://github.com/perminder-klair/subwave).
It adds an hourly multi-source news bulletin without patching, rebuilding, or
replacing any SUB/WAVE application files.

## What it does

- Reads multiple RSS 2.0 or Atom news feeds
- Uses SUB/WAVE's active on-air persona
- Uses SUB/WAVE's configured primary LLM, with configured fallback support
- Uses SUB/WAVE's configured TTS engine and voice
- Uploads an intro jingle, a background news bed, and an outro jingle
- Mixes the voice over the background bed with adjustable level and fades
- Queues one complete foreground package through SUB/WAVE's existing `say.txt`
  handoff
- Provides a LAN web UI for settings, uploads, run-now testing, updates, and
  rollback

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
would require changing SUB/WAVE itself.

## What it changes

It writes only persistent operator data:

```text
SUBWAVE_STATE/skills/hourly-news-bulletin/
SUBWAVE_STATE/extensions/hourly-news/
```

It also starts one separate Docker container named:

```text
subwave-news-bulletin
```

It does **not** copy source files into the SUB/WAVE controller, alter the SUB/WAVE
web UI, patch the scheduler, or rebuild any SUB/WAVE image.

## Install

Run these on the Ubuntu machine that already runs SUB/WAVE:

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

When installation completes, open:

```text
http://YOUR-SUBWAVE-IP:7711
```

The page uses the same HTTP Basic username and password as the SUB/WAVE admin
page.

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
providers are:

- Ollama
- OpenAI
- OpenAI-compatible
- Locca
- Anthropic
- Google Gemini
- DeepSeek
- OpenRouter
- Requesty
- Gateway when a compatible base URL is configured

API keys are read from the same environment and persistent `secrets.env` used by
SUB/WAVE. OpenAI-compatible inline keys are read from SUB/WAVE's persistent
settings file. Keys are never shown in the manager UI.

## TTS compatibility

The manager calls SUB/WAVE's existing authenticated TTS preview endpoint with the
active persona's engine, voice, language, and speed. That supports whichever TTS
engines the installed SUB/WAVE controller already supports, including custom
Piper voices.

## Updating in the UI

Open the manager page and use:

```text
Check for updates → Update now
```

The updater changes only this companion repository and companion container. It
preserves feeds, schedule settings, seen-headline history, and all uploaded
audio under SUB/WAVE's persistent state directory.

Use **Roll back** to return to the previously installed companion commit.

## Manual recovery commands

```bash
cd ~/SUBWAVE-news-bulletin
./manage.sh status
./manage.sh update
./manage.sh rollback
./manage.sh restart
./manage.sh uninstall
```

`uninstall` removes the companion container while preserving settings and audio.
The custom skill can be removed separately from **Admin → Skills**.

## Security

The manager is intended for a trusted home LAN. It uses SUB/WAVE's admin Basic
Auth and has the Docker socket mounted so the UI can update its own container.
Do not expose port `7711` publicly without an additional access-control layer.

## Native skill fallback

The installer adds a normal custom skill named **Hourly multi-source news
bulletin**. Keep it disabled to avoid duplicate autonomous bulletins. Its
SUB/WAVE **Run now** action remains available as a plain spoken fallback, but the
separate manager page is what supplies the intro, background bed, outro, and
portable scheduler.
