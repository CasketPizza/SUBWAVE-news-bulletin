# SUB/WAVE Hourly News Bulletin

## v0.5.16 full-package queue protection

- Fixes the remaining mid-bulletin cutoff at the actual playout boundary. The
  previous release restored pending songs after a short crossfade-settle timer;
  this release keeps every song completely outside `dj_queue` for the entire
  verified bulletin package.
- Adds a protected silent tail longer than the configured station crossfade. The
  bulletin exits using the normal station crossfade, so the following song fades
  in only over silence after the final spoken word. This remains safe even if
  Liquidsoap drops the per-request crossfade annotation and falls back to the
  global setting.
- Continuously removes newly preloaded songs while the bulletin is on air. The
  initial queue isolation can no longer be undone by SUB/WAVE refilling
  `dj_queue` during the report.
- Persists held-song state to `state/extensions/hourly-news/held-queue.json`.
  Manager or container restarts therefore cannot restore songs early or lose the
  queue while a bulletin is protected.
- Performs exactly one skip, immediately before the bulletin starts. There is no
  timer-based restore during speech and no skip at the end. Held songs are put
  back only after the complete package, silent tail, and safety window have
  elapsed; the autonomous playlist can begin the first post-bulletin song
  naturally.
- Changes timeout/error recovery after the handover skip: even when metadata
  confirmation fails, songs stay held under a conservative on-disk guard instead
  of being restored into the live bulletin.

## v0.5.15 isolated one-skip handover

- Delays the single handover skip until the exact final bulletin package is fully
  resolved and prepared in Liquidsoap. No skip is sent during script generation,
  TTS rendering, audio assembly, or URI resolution.
- Isolates the bulletin as the only pending `dj_queue` item at the instant of the
  skip. Songs that were already queued, plus any songs SUB/WAVE added while the
  bulletin was preparing, are held aside until the bulletin is confirmed on air.
- Keeps every song out of `dj_queue` for the complete configured incoming
  crossfade plus a safety margin after the bulletin first appears on air. Pending
  songs are restored only after the one-shot skip/cross is fully settled, then
  resume naturally after report EOF; the companion never skips at the end.
- Adds an on-air playback lock for the complete verified package duration plus a
  short decoder grace period. Scheduled or manual duplicate runs cannot issue a
  second companion skip while the newscaster is speaking.
- Shows **Bulletin on air — protected** in the status panel while that lock is
  active.

## v0.5.14 complete-report TTS and playout

- Removes the **Maximum spoken length** setting and its prompt-level time target.
  The story-count control remains, but every story the LLM returns must finish as
  complete on-air copy.
- Fixes the persistent mid-story cutoff caused by SUB/WAVE's admin TTS preview
  endpoint accepting arbitrary text while internally retaining only its first 200
  characters. Long stories are now split at sentence or phrase boundaries into
  safe chunks, rendered completely, and rejoined before the normal inter-story
  pauses are added.
- Removes the companion's hidden 600-token Ollama clamp and instead honours the
  configured, still-bounded SUB/WAVE output-token budget.
- Verifies every generated TTS clip and the duration of the final combined
  intro/news/outro WAV before it can be queued. Diagnostics report story, chunk
  and final-package durations.
- Marks the bulletin programme item with a zero-duration exit crossfade. Music
  resumes only when the single verified package reaches EOF, preventing the next
  song from consuming the end of the report.

## v0.5.13 progressive interest examples

- Shows the interest tuner in batches of 16 articles instead of rendering the
  entire feed pool at once.
- Adds a **Load more** control at the true bottom of the scrollable article list,
  including a visible count of how many matching articles are currently shown.
- Preserves the operator's scroll position and article ratings while more
  examples are revealed.
- Resets to the first batch when search, source, or rating filters change so a
  filtered result never opens halfway through its list.
- Expands the interest-browser pool to as many as 120 deduplicated articles while
  retaining four-feed concurrency and fetching the pool only when the tuner is
  opened or manually refreshed.

## v0.5.12 audience interest tuning

- Adds a **Tune news interests** popup with More like this, Less like this and
  Neutral ratings for recent articles from the configured feeds.
- Generates a concise, editable audience-interest profile through SUB/WAVE's
  configured LLM and uses it only as a soft story-selection tie-breaker.
- Retains bounded positive and negative examples without treating any clicked
  article as a request to air that particular story.
- Supplies complete RSS/Atom summaries where available and omits incomplete
  teaser fragments rather than feeding the model text cut off mid-sentence.

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
- Uploads an intro jingle, a background news bed, and an outro jingle
- Mixes the voice over the background bed with adjustable level and fades
- Inserts a configurable, real silence gap between separately rendered stories
- Still produces a recap when every live headline has already aired; if feeds are
  temporarily unavailable, it can use the last successful headline cache
- Waits until the complete package is prepared, sends exactly one isolated handover
  skip, keeps all pending and newly preloaded songs outside Liquidsoap for the full
  report, and restores them only after the protected package has finished
- Provides a web UI for settings, uploads, run-now testing, updates, and rollback
- Includes progressive audience-interest tuning with recent feed examples and a
  Load more control for deeper preference training

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
