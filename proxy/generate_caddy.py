#!/usr/bin/env python3
"""Insert the standalone news companion route into a stock SUB/WAVE Caddyfile."""

from __future__ import annotations

import argparse
import re
from pathlib import Path

BEGIN = "\t# BEGIN SUB/WAVE NEWS BULLETIN"
END = "\t# END SUB/WAVE NEWS BULLETIN"


def remove_existing(text: str) -> str:
    pattern = re.compile(
        rf"\n?[ \t]*# BEGIN SUB/WAVE NEWS BULLETIN\n[\s\S]*?"
        rf"[ \t]*# END SUB/WAVE NEWS BULLETIN\n?",
        re.MULTILINE,
    )
    return pattern.sub("\n", text)


def route_block(manager_host: str, manager_port: int, path: str) -> str:
    prefix = "/" + path.strip("/")
    return f"""
{BEGIN}
\t# Standalone companion route. The prefix is stripped before proxying, so the
\t# manager can also run directly at / inside its own container.
\thandle {prefix} {{
\t\tredir {prefix}/ 308
\t}}
\thandle_path {prefix}/* {{
\t\treverse_proxy {manager_host}:{manager_port}
\t}}
{END}

"""


def inject(text: str, block: str) -> str:
    clean = remove_existing(text)

    comment_anchor = "\t# Everything else → Next.js web UI"
    index = clean.find(comment_anchor)
    if index >= 0:
        before = clean[:index].rstrip()
        after = clean[index:].lstrip("\n")
        return f"{before}\n\n{block.strip("\n")}\n\n{after}"

    # Backstop for future Caddyfile comment changes: place the route immediately
    # before the catch-all handle that proxies to the web service.
    catch_all = re.search(
        r"(?m)^[ \t]*handle\s*\{\s*\n[ \t]*reverse_proxy\s+web:7700\b",
        clean,
    )
    if catch_all:
        before = clean[: catch_all.start()].rstrip()
        after = clean[catch_all.start() :].lstrip("\n")
        return f"{before}\n\n{block.strip("\n")}\n\n{after}"

    raise SystemExit(
        "Could not find SUB/WAVE's web catch-all in the current Caddyfile; "
        "the companion refused to overwrite an unfamiliar proxy layout."
    )


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("source", type=Path)
    parser.add_argument("destination", type=Path)
    parser.add_argument("--manager-host", default="subwave-news-bulletin")
    parser.add_argument("--manager-port", type=int, default=7711)
    parser.add_argument("--path", default="/news-bulletin/")
    args = parser.parse_args()

    source = args.source.read_text(encoding="utf-8")
    result = inject(
        source,
        route_block(args.manager_host, args.manager_port, args.path),
    )
    args.destination.parent.mkdir(parents=True, exist_ok=True)
    args.destination.write_text(result, encoding="utf-8")


if __name__ == "__main__":
    main()
