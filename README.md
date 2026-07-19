# SUB/WAVE Hourly News Bulletin

A self-hosted news bulletin extension for
[SUB/WAVE](https://github.com/perminder-klair/subwave).

It adds a persistent custom skill plus a separate manager UI for:

- Multiple RSS or Atom news sources
- An intro jingle upload
- Background music behind the generated headlines
- An outro jingle upload
- Background-bed volume and fades
- Run-now testing
- Hourly scheduling
- UI-based extension updates, reapply, and rollback

The bulletin uses **SUB/WAVE's active DJ persona, configured LLM, and configured
TTS voice**. It does not maintain a second Ollama or Piper configuration.

## Default on-air sequence

```text
SUB/WAVE normal hourly announcement
→ intro jingle
→ DJ reads fresh headlines over the uploaded music bed
→ outro jingle
→ normal station music continues
```

The schedule can instead be set to:

- Before the normal hourly announcement
- Replace the normal hourly announcement
- A selected minute each hour
- Manual only

## Install

This is the only terminal setup normally required.

On the Ubuntu VM that runs SUB/WAVE:

```bash
cd ~
git clone https://github.com/CasketPizza/SUBWAVE-news-bulletin.git
cd SUBWAVE-news-bulletin
chmod +x install.sh manage.sh patches/patch_subwave.py
./install.sh
```

The installer expects SUB/WAVE at:

```text
/home/your-user/subwave
```

For a different location:

```bash
SUBWAVE_DIR=/path/to/subwave ./install.sh
```

When it finishes, open:

```text
http://YOUR-SUBWAVE-IP:7711
```

For the setup described during development, that is expected to be:

```text
http://192.168.1.196:7711
```

The browser uses the same username and password as the SUB/WAVE admin page.

## First setup in the UI

1. Open **News sources** and add or remove RSS/Atom URLs.
2. Upload an **Intro jingle**.
3. Upload **Background music**.
4. Upload an **Outro jingle**.
5. Leave the default bed volume around **-18 dB** initially.
6. Press **Save settings**.
7. Press **Run bulletin now** to test the complete package.

Audio uploads are converted to consistent WAV files with FFmpeg. Common audio
formats accepted by FFmpeg, including WAV, MP3, FLAC, OGG and M4A, should work.

## Updating

Use the manager page:

```text
Status & updates → Check for updates → Update now
```

The updater pulls this repository's `main` branch, preserves all settings and
uploaded audio under SUB/WAVE's persistent `state/` directory, reapplies the
compatibility hooks, rebuilds the affected containers, and restarts the manager.

After updating SUB/WAVE itself, open the manager and press:

```text
Reapply after SUB/WAVE update
```

The patcher checks known source anchors and refuses unfamiliar layouts rather
than blindly editing them.

A previous extension version can be restored using **Roll back**.

## What is changed in SUB/WAVE?

The installer makes only two marker-delimited source changes:

1. Adds an admin-only `POST /dj/render-voice` endpoint. It uses SUB/WAVE's own
   persona, LLM and TTS to render a WAV without airing it. The manager then mixes
   the uploaded news bed underneath that voice.
2. Adds a guard to the normal top-of-hour function. It does nothing unless the
   manager is set to **Replace**, in which case the normal hourly announcement is
   suppressed.

The custom skill and all user data live outside the replaceable application
image:

```text
subwave/state/skills/hourly-news-bulletin/
subwave/state/extensions/hourly-news/
```

## Manual management commands

The UI covers normal use. These commands remain available for recovery:

```bash
cd ~/SUBWAVE-news-bulletin
./manage.sh status
./manage.sh update
./manage.sh reapply
./manage.sh rollback
./manage.sh uninstall
```

`uninstall` removes the local SUB/WAVE hooks and custom skill, but deliberately
keeps your settings and uploaded audio.

## Security

The manager is intended for a trusted home LAN. It requires the same HTTP Basic
credentials as the SUB/WAVE admin interface. It mounts the Docker socket so its
Update/Reapply buttons can rebuild and restart the extension and controller.
Do not expose port `7711` publicly without an additional access-control layer.

## Current compatibility

The initial patch targets the current SUB/WAVE source layout as of July 2026.
SUB/WAVE changes quickly; use the manager's **Reapply** button after upstream
updates. When an anchor has changed, reapply stops safely and the manager reports
that a compatible extension update is required.
