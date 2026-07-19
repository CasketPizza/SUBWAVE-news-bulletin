#!/usr/bin/env python3
"""Apply/remove the two small SUB/WAVE hooks required by the manager.

1. POST /dj/render-voice: use SUB/WAVE's active persona, LLM and TTS to render
   a script to a shared-state audio file without airing it.
2. A replace-mode guard in hourlyCheck(): suppress the normal hourly announcement
   only while the manager's suppress-hourly flag exists.

The patch is marker-based and idempotent. It refuses unfamiliar source layouts
instead of guessing.
"""

from pathlib import Path
import argparse
import sys

DJ_START = "// SUBWAVE NEWS BULLETIN PATCH: RENDER VOICE START"
DJ_END = "// SUBWAVE NEWS BULLETIN PATCH: RENDER VOICE END"
SCHED_START = "// SUBWAVE NEWS BULLETIN PATCH: HOURLY GUARD START"
SCHED_END = "// SUBWAVE NEWS BULLETIN PATCH: HOURLY GUARD END"

RENDER_BLOCK = r'''
// SUBWAVE NEWS BULLETIN PATCH: RENDER VOICE START
// Render a persona-styled line with the station's configured LLM + TTS, but do
// not send it to Liquidsoap. The companion manager mixes the returned WAV with
// its news bed and queues the completed package itself.
router.post('/dj/render-voice', requireAdmin, async (req, res) => {
  const text = (typeof req.body?.text === 'string' ? req.body.text : '').trim().slice(0, 12000);
  if (!text) return res.status(400).json({ error: 'text is required' });

  const kind = SAY_KINDS.includes(req.body?.kind) ? req.body.kind : 'dj-speak';
  const mode = req.body?.mode === 'raw' ? 'raw' : 'styled';

  try {
    let spoken = text;
    if (mode === 'styled') {
      spoken = await dj.generateAdLib({
        instruction: text,
        context: await getFullContext(),
        recap: queue.getDjRecap(),
        recentOpeners: queue.getRecentOpeners(),
      });
    }
    const wavPath = await speak(spoken, { kind });
    res.json({ ok: true, mode, kind, spoken, wavPath });
  } catch (err) {
    queue.log('error', `/dj/render-voice failed: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});
// SUBWAVE NEWS BULLETIN PATCH: RENDER VOICE END

'''

SCHED_BLOCK = r'''  // SUBWAVE NEWS BULLETIN PATCH: HOURLY GUARD START
  // Replace mode is opt-in and controlled by a persistent flag owned by the
  // companion manager. Every other mode leaves SUB/WAVE's hourly check intact.
  if (existsSync(`${config.stateDir}/extensions/hourly-news/suppress-hourly`)) {
    queue.log('scheduler', 'Hourly announcement suppressed by Hourly News Bulletin replace mode');
    return;
  }
  // SUBWAVE NEWS BULLETIN PATCH: HOURLY GUARD END
'''


def replace_once(text: str, old: str, new: str, label: str) -> str:
    count = text.count(old)
    if count != 1:
        raise RuntimeError(f"expected one {label} anchor, found {count}")
    return text.replace(old, new, 1)


def remove_marked(text: str, start: str, end: str) -> str:
    a = text.find(start)
    if a < 0:
        return text
    b = text.find(end, a)
    if b < 0:
        raise RuntimeError(f"found {start!r} without matching end marker")
    b += len(end)
    while b < len(text) and text[b] in "\r\n":
        b += 1
    return text[:a] + text[b:]


def apply(root: Path) -> None:
    dj_path = root / "controller/src/routes/dj.ts"
    scheduler_path = root / "controller/src/broadcast/scheduler.ts"
    if not dj_path.exists() or not scheduler_path.exists():
        raise RuntimeError("SUB/WAVE source files were not found; is SUBWAVE_DIR correct?")

    dj = dj_path.read_text(encoding="utf-8")
    scheduler = scheduler_path.read_text(encoding="utf-8")

    if DJ_START not in dj:
        if "import { speak } from '../audio/tts.js';" not in dj:
            dj = replace_once(
                dj,
                "import { getFullContext } from '../context.js';\n",
                "import { getFullContext } from '../context.js';\nimport { speak } from '../audio/tts.js';\n",
                "dj import",
            )
        anchor = "// ---------------------------------------------------------------------------\n// POST /dj/say"
        if anchor not in dj:
            raise RuntimeError("SUB/WAVE /dj/say anchor changed; patch not applied")
        dj = dj.replace(anchor, RENDER_BLOCK + anchor, 1)

    if SCHED_START not in scheduler:
        if "import { existsSync } from 'node:fs';" not in scheduler:
            scheduler = replace_once(
                scheduler,
                "import cron from 'node-cron';\n",
                "import cron from 'node-cron';\nimport { existsSync } from 'node:fs';\n",
                "scheduler import",
            )
        anchor = "async function hourlyCheck() {\n"
        if anchor not in scheduler:
            raise RuntimeError("SUB/WAVE hourlyCheck anchor changed; patch not applied")
        scheduler = scheduler.replace(anchor, anchor + SCHED_BLOCK, 1)

    dj_path.write_text(dj, encoding="utf-8")
    scheduler_path.write_text(scheduler, encoding="utf-8")
    print("SUB/WAVE news hooks applied.")


def remove(root: Path) -> None:
    dj_path = root / "controller/src/routes/dj.ts"
    scheduler_path = root / "controller/src/broadcast/scheduler.ts"
    dj = dj_path.read_text(encoding="utf-8")
    scheduler = scheduler_path.read_text(encoding="utf-8")

    dj = remove_marked(dj, DJ_START, DJ_END)
    scheduler = remove_marked(scheduler, SCHED_START, SCHED_END)

    dj = dj.replace("import { speak } from '../audio/tts.js';\n", "")
    scheduler = scheduler.replace("import { existsSync } from 'node:fs';\n", "")

    dj_path.write_text(dj, encoding="utf-8")
    scheduler_path.write_text(scheduler, encoding="utf-8")
    print("SUB/WAVE news hooks removed.")


def check(root: Path) -> int:
    try:
        dj = (root / "controller/src/routes/dj.ts").read_text(encoding="utf-8")
        scheduler = (root / "controller/src/broadcast/scheduler.ts").read_text(encoding="utf-8")
    except OSError as exc:
        print(f"not installed: {exc}")
        return 1
    ok = DJ_START in dj and DJ_END in dj and SCHED_START in scheduler and SCHED_END in scheduler
    print("installed" if ok else "not installed")
    return 0 if ok else 1


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("action", choices=["apply", "remove", "check"])
    parser.add_argument("--subwave-dir", required=True)
    args = parser.parse_args()
    root = Path(args.subwave_dir).expanduser().resolve()
    try:
        if args.action == "apply":
            apply(root)
            return 0
        if args.action == "remove":
            remove(root)
            return 0
        return check(root)
    except Exception as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
