# SUB/WAVE Hourly News Bulletin

## v0.5.12 audience-interest tuning

- Adds a **Tune news interests** popup that loads up to 60 recent items from the
  configured RSS and Atom sources, with source, search and rating filters.
- Lets the operator mark examples as **More like this**, **Less like this**, or
  neutral. These examples never force a particular article into a bulletin.
- Uses SUB/WAVE's configured primary LLM, with fallback support, to turn the
  examples into a short editable audience-interest profile. The profile is a
  soft tie-breaker only: consequence, freshness, major local/world importance,
  and avoiding repetition remain higher priorities.
- Stores at most 50 positive and 50 negative examples, while using only the most
  recent 25 of each when regenerating the compact profile.
- Gives both the interest-profile generator and bulletin writer clean RSS/Atom
  summaries for context. It prefers richer feed content where available and
  keeps only complete sentences; incomplete teaser fragments and mid-sentence
  truncation are omitted rather than handed to the LLM or displayed as fact.
- Adds manual profile editing, article refresh, profile reset, saved-example
  counts, and cached article-browser fallback when every live feed is unavailable.

## v0.5.11 authentication and cache recovery

- Serves the lightweight manager shell and its static assets without requiring
  authentication, while keeping every API, upload, audio-preview, update and
  rollback action protected by SUB/WAVE's admin Basic Auth.
- Detects HTTP 401/403 responses and upstream HTML login pages, then shows a
  clear **Re-authenticate** screen instead of leaving a blank or half-loaded UI.
- Adds a protected `/reauth` navigation endpoint that reliably triggers the
  browser's Basic-Auth prompt and returns to `/news-bulletin/` afterwards.
- Adds a startup manager/authentication watchdog and a manual retry control.
- Disables browser caching for all companion responses and versions `app.js` and
  `styles.css` from the installed `VERSION`, preventing old assets from surviving
  an update or reinstall.

## v0.5.10 stability fixes

- Keeps only a small recent-actions log: at most 120 lines from a capped 128 KiB file.
- Reads only the tail of the log instead of loading the entire file into memory.
- Disables live log polling by default; it runs every five seconds only while
  **Enable live debugging** is checked and the page is visible.
- Prevents overlapping log and status requests and slows ordinary status refreshes
  to every 30 seconds.
- Adds **Refresh once** and **Clear** controls for diagnostics.
- Caps the companion at 1.5 CPU cores, 768 MiB RAM and 128 processes, and rotates
  Docker's own container logs.
- Gives FFmpeg and FFprobe hard timeouts so a stuck audio conversion cannot run
  indefinitely. Updater helper containers also receive conservative limits.


## v0.5.9 fixes and interface improvements

- Repairs update detection by marking the mounted checkout as a safe Git directory,
  comparing both the remote `main` commit and its uncached `VERSION` file, and
  reducing the passive update-check cache to one minute.
- Refreshes the Recent log every two seconds while the browser tab is visible and
  pauses polling while the page is hidden. The panel stays pinned to the newest
  line when the operator is already at the bottom.
- Keeps **Save settings** floating above the page so it remains available while
  editing any section.
- Uploads intro, bed, and outro audio immediately after a file is selected. The
  converted asset is used at once and its original file name is stored and shown
  in the UI instead of the generic “Uploaded and ready” label.

## v0.5.8 fixes

- Fixes the v0.5.7 prepared-request detector incorrectly excluding the resolver
  RID from inspection. On this Liquidsoap build, the `annotate:` request keeps
  the same RID when it becomes the prepared `dj_queue` item; there is not always
  a separate child RID.
- Inspects the resolver RID together with every visible request, requires the
  exact `news-package-*.wav` to be present in `dj_queue` and no longer resolving,
  then sends one handover skip and confirms `now-playing.json`.
- Keeps the modification-time cleanup fix and thought-process filtering.

## v0.5.7 fixes

- Fixes the final programme-handover race: a resolver trace ending in `Pushed`
  does not yet mean the playable child request is ready inside `dj_queue`.
- Waits for a non-resolving child request whose metadata points to the exact new
  `news-package-*.wav`, then restores pending songs behind it and sends one skip.
- Confirms the shared `now-playing.json` changed to `Hourly News Bulletin` before
  reporting success. It never sends a second skip when confirmation fails.
- Keeps the v0.5.6 modification-time cleanup fix and v0.5.5 thought-process
  filtering.

## v0.5.6 fixes

- Fixes a generated-audio cleanup race that could delete the just-created
  `news-package-*.wav` immediately after it was queued but before Liquidsoap
  opened the resolved child request.
- Sorts generated audio by filesystem modification time instead of filename.
  Mixed prefixes such as `story-`, `silence-`, `narration-`, and
  `news-package-` are therefore retained in true newest-first order.
- Keeps the v0.5.5 thought-process filtering and structured-output safeguards.

## v0.5.5 fixes

- Prevents community Qwen GGUF models from putting their planning or thought
  process on air when their chat template ignores Ollama's `think: false` flag.
- Adds `/no_think`, discards Ollama's separate hidden-thinking field, strips
  explicit `<think>`, `<analysis>`, and `<reasoning>` blocks, and extracts the
  actual structured story JSON when reasoning appears before it.
- Rejects untagged model-planning language before TTS and retries once with a
  stricter correction. If the retry is still contaminated, no audio is made or
  queued.
- Keeps the v0.5.4 Liquidsoap resolver-RID handover fix.

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
- Builds an editable soft audience-interest profile from operator-rated recent
  articles without forcing any particular example into a bulletin
- Uploads an intro jingle, a background news bed, and an outro jingle
- Mixes the voice over the background bed with adjustable level and fades
- Inserts a configurable, real silence gap between separately rendered stories
- Still produces a recap when every live headline has already aired; if feeds are
  temporarily unavailable, it can use the last successful headline cache
- Ends the current song, inserts the complete bulletin as the next main programme
  item, preserves pending song order, and starts the following song after the outro
- Provides a web UI for settings, uploads, run-now testing, updates, and rollback

## Newsroom controls

The manager page includes three prompt fields similar to a SUB/WAVE skill brief, plus an optional audience-interest profile:

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
→ at :01, the current song is ended using SUB/WAVE's normal skip transition
→ intro jingle
→ clearly separated headlines over the uploaded background bed
→ outro jingle
→ the next queued or automatic song starts
```

The schedule may instead be set to:

- Before the hourly announcement, at `:59`
- A selected minute each hour
- Manual only

There is no “replace the native hourly announcement” option because doing that
would require changing SUB/WAVE itself.


## Headline freshness and recap behaviour

A scheduled bulletin is not cancelled merely because all current feed items have
already appeared in an earlier bulletin. The manager uses this order:

1. Unseen items from the live feeds.
2. A measured recap of the current live feed items when there are no unseen items.
3. The most recently cached feed items when every configured feed is temporarily
   unavailable.

Recap and cached runs explicitly tell the LLM not to describe the stories as
breaking or newly arrived. A first-ever run still needs at least one successful
feed fetch because there is no cache yet.

## Story separation and programme handover

Each story is synthesized as its own speech clip. The manager joins those clips
with a configurable silence gap, defaulting to 2.25 seconds, so unrelated reports
do not run together. When a model ignores the requested story markers, the
manager retries the script once with a stricter format instruction.

In the default programme-item mode, the manager temporarily moves pending
Liquidsoap queue entries, inserts the complete intro/news/outro WAV first, restores
the pending entries in their original order, and waits for Liquidsoap to prepare
the bulletin request before calling SUB/WAVE's admin-only track-skip endpoint.
It then confirms the bulletin request itself reached the playing state. When
Liquidsoap had already prefetched an automatic song, the manager clears that
single prefetched hop rather than silently claiming the bulletin aired. The current
song therefore hands over to the bulletin and the next queued or automatic song
follows it. A short silent tail ensures the next track does not overlap the final
spoken word or audible end of the outro. The incoming handover itself follows
SUB/WAVE's normal skip/crossfade behaviour.

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

The installer discovers the actual SUB/WAVE state bind mount, the Docker network
shared by the controller and broadcast services, and Caddy's edge network from
the running containers.

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
7. Set the story gap; `2.25 seconds` is the default for an obvious story change.
8. Keep **End the current song and air the bulletin as a standalone programme item** enabled.
9. Start with the bed around `-18 dB`.
10. Save and press **Run bulletin now**.

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
seen-headline history, and uploaded audio under SUB/WAVE's persistent state. The
update check compares the installed checkout with the repository's remote
`main` commit and uncached `VERSION` file. Background checks are cached for one
minute; pressing **Check for updates** forces a fresh comparison.
Updater and rollback workers also restore the checkout's original owner after a
root-run Docker build, so later manual commands remain writable by the VM user.

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
