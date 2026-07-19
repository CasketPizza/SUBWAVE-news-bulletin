# SUB/WAVE Hourly News Bulletin

A standalone companion for [SUB/WAVE](https://github.com/perminder-klair/subwave).
It adds an hourly multi-source news bulletin without patching, rebuilding, or
replacing any SUB/WAVE application files.

## What it does

- Reads multiple RSS 2.0 or Atom news feeds
- Uses SUB/WAVE's configured primary LLM, with configured fallback support
- Lets the operator follow the current on-air persona or choose a fixed
  SUB/WAVE persona as a dedicated news presenter
- Lets the operator use that presenter's voice or override it with another
  configured TTS engine, voice, speed, provider, and language
- Provides separate editable newsroom instructions for story selection,
  source-material handling, and on-air delivery
- Uploads an intro jingle, a background news bed, and an outro jingle
- Mixes the voice over the background bed with adjustable level and fades
- Queues one complete foreground package through SUB/WAVE's existing `say.txt`
  handoff
- Provides a web UI for settings, uploads, run-now testing, updates, and rollback

## Newsroom controls

The manager page includes three prompt fields similar to a SUB/WAVE skill brief:

1. **Story selection instructions** — what deserves inclusion, regional and
   topical priorities, and what to avoid.
2. **Source-material handling** — how to interpret, attribute, and paraphrase
   the RSS headlines and summaries supplied to the LLM.
3. **On-air delivery instructions** — pacing, formality, transitions,
   pronunciation guidance, opening style, and closing style.

Accuracy safeguards remain fixed outside the editable prompt. Custom
instructions cannot tell the model to invent facts, merge unrelated reports,
or turn uncertainty and allegations into established fact.

## Presenter and voice routing

The news presenter can be:

- **Follow current on-air persona** — automatically changes with SUB/WAVE.
- **A fixed SUB/WAVE persona** — useful for a dedicated news host with its own
  personality and configured voice.

Voice routing can then either use that presenter's normal voice or override it
with another engine and voice known to SUB/WAVE. Voice names and IDs can also be
entered manually for compatible engines.

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

A reversible Compose/Caddy overlay routes the companion through the same public
origin as SUB/WAVE:

```text
/news-bulletin/
```

The path automatically follows the user's LAN IP, hostname, HTTPS domain, or
Cloudflare Tunnel address.

## Install

Run these on the Ubuntu machine that already runs SUB/WAVE:

```bash
cd ~
git clone https://github.com/CasketPizza/SUBWAVE-news-bulletin.git
cd SUBWAVE-news-bulletin
chmod +x install.sh manage.sh
./install.sh
```

The installer discovers the actual SUB/WAVE state bind mount and the controller
and Caddy Docker networks from the running containers.

For a non-default SUB/WAVE directory:

```bash
SUBWAVE_DIR=/path/to/subwave ./install.sh
```

When installation completes, open `/news-bulletin/` on the same address already
used for SUB/WAVE, for example:

```text
http://192.168.1.196:7700/news-bulletin/
https://radio.example.com/news-bulletin/
```

The page uses the same HTTP Basic username and password as the SUB/WAVE admin
page.

## First setup

1. Confirm the status panel shows the correct LLM, news presenter, and voice.
2. Choose **Follow current on-air persona** or a fixed news presenter.
3. Keep the presenter's voice or choose a voice override.
4. Edit the three newsroom instruction fields.
5. Add or remove RSS/Atom sources.
6. Upload the intro jingle, background music, and outro jingle.
7. Start with the bed around `-18 dB`.
8. Save and press **Run bulletin now**.

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

The manager calls SUB/WAVE's existing authenticated TTS preview endpoint with
the resolved engine, voice, language, and speed. It therefore supports whichever
TTS engines the installed SUB/WAVE controller already supports, including
custom Piper voices.

## Updating

Open `/news-bulletin/` and use:

```text
Check for updates → Update now
```

The updater changes only this companion repository and container. It preserves
feeds, schedule settings, newsroom instructions, presenter/voice selection,
seen-headline history, and uploaded audio under SUB/WAVE's persistent state.

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

`uninstall` removes the companion container and proxy route while preserving
settings and audio. The custom skill can be removed separately from
**Admin → Skills**.

## Security

The manager uses SUB/WAVE's admin Basic Auth and has the Docker socket mounted so
the UI can update its own container. Protect the public SUB/WAVE admin origin
with the same access controls used for the rest of the station.

## Native skill fallback

The installer adds a normal custom skill named **Hourly multi-source news
bulletin**. Keep it disabled to avoid duplicate autonomous bulletins. Its
SUB/WAVE **Run now** action remains available as a plain spoken fallback. The
companion manager supplies the configurable presenter, newsroom instructions,
intro, background bed, outro, and portable scheduler.
