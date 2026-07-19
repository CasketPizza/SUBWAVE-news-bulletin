#!/usr/bin/env python3
"""Safely add/remove the companion Caddy overlay from SUB/WAVE's COMPOSE_FILE."""

from __future__ import annotations

import argparse
import json
import os
import re
from pathlib import Path

COMPOSE_RE = re.compile(r"^(?P<prefix>\s*(?:export\s+)?)COMPOSE_FILE\s*=\s*(?P<value>.*)$")


def unquote(value: str) -> str:
    value = value.strip()
    if len(value) >= 2 and value[0] == value[-1] and value[0] in {'"', "'"}:
        return value[1:-1]
    return value


def active_compose_line(lines: list[str]) -> tuple[int | None, str | None]:
    found: tuple[int | None, str | None] = (None, None)
    for index, line in enumerate(lines):
        stripped = line.lstrip()
        if stripped.startswith("#"):
            continue
        match = COMPOSE_RE.match(line.rstrip("\n"))
        if match:
            found = (index, unquote(match.group("value")))
    return found


def default_files(subwave_dir: Path) -> list[str]:
    candidates = ["compose.yaml", "compose.yml", "docker-compose.yml", "docker-compose.yaml"]
    base = next((name for name in candidates if (subwave_dir / name).is_file()), None)
    if not base:
        raise SystemExit(f"No Compose file found in {subwave_dir}")

    overrides: dict[str, list[str]] = {
        "compose.yaml": ["compose.override.yaml", "compose.override.yml"],
        "compose.yml": ["compose.override.yml", "compose.override.yaml"],
        "docker-compose.yml": ["docker-compose.override.yml", "docker-compose.override.yaml"],
        "docker-compose.yaml": ["docker-compose.override.yaml", "docker-compose.override.yml"],
    }
    result = [base]
    for name in overrides[base]:
        if (subwave_dir / name).is_file():
            result.append(name)
            break
    return result


def split_files(value: str) -> list[str]:
    # This extension targets Linux-hosted SUB/WAVE, where ':' is Compose's path
    # separator. Empty entries are ignored.
    return [part for part in value.split(":") if part]


def atomic_write(path: Path, text: str) -> None:
    tmp = path.with_name(f".{path.name}.tmp-{os.getpid()}")
    tmp.write_text(text, encoding="utf-8")
    os.replace(tmp, path)


def install(env_path: Path, override: Path, state_path: Path, subwave_dir: Path) -> None:
    lines = env_path.read_text(encoding="utf-8").splitlines(keepends=True)
    index, previous = active_compose_line(lines)
    previous_files = split_files(previous) if previous else default_files(subwave_dir)
    override_text = str(override.resolve())

    installed_files = list(previous_files)
    if override_text not in installed_files:
        installed_files.append(override_text)
    installed_value = ":".join(installed_files)

    if not state_path.exists():
        state_path.parent.mkdir(parents=True, exist_ok=True)
        state_path.write_text(
            json.dumps(
                {
                    "hadLine": index is not None,
                    "previousValue": previous,
                    "installedValue": installed_value,
                    "override": override_text,
                },
                indent=2,
            )
            + "\n",
            encoding="utf-8",
        )

    replacement = f'COMPOSE_FILE="{installed_value}"\n'
    if index is None:
        if lines and not lines[-1].endswith("\n"):
            lines[-1] += "\n"
        lines.append("\n# Added by SUB/WAVE Hourly News Bulletin\n")
        lines.append(replacement)
    else:
        lines[index] = replacement
    atomic_write(env_path, "".join(lines))


def uninstall(env_path: Path, override: Path, state_path: Path) -> None:
    if not env_path.exists():
        return
    lines = env_path.read_text(encoding="utf-8").splitlines(keepends=True)
    index, current = active_compose_line(lines)
    if index is None or current is None:
        return

    override_text = str(override.resolve())
    current_files = split_files(current)
    if override_text not in current_files:
        return

    state = {}
    try:
        state = json.loads(state_path.read_text(encoding="utf-8"))
    except Exception:
        pass

    installed_value = state.get("installedValue")
    previous_value = state.get("previousValue")
    had_line = bool(state.get("hadLine"))

    if current == installed_value:
        if had_line and previous_value is not None:
            lines[index] = f'COMPOSE_FILE="{previous_value}"\n'
        else:
            lines.pop(index)
            # Remove the adjacent marker comment and spare blank line when they
            # are still exactly where the installer put them.
            if index - 1 >= 0 and "Added by SUB/WAVE Hourly News Bulletin" in lines[index - 1]:
                lines.pop(index - 1)
                if index - 2 >= 0 and not lines[index - 2].strip():
                    lines.pop(index - 2)
    else:
        # The operator changed COMPOSE_FILE after installation. Preserve those
        # changes and remove only this extension's overlay entry.
        remaining = [item for item in current_files if item != override_text]
        if remaining:
            lines[index] = f'COMPOSE_FILE="{":".join(remaining)}"\n'
        else:
            lines.pop(index)

    atomic_write(env_path, "".join(lines))


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("action", choices=["install", "uninstall"])
    parser.add_argument("--env", required=True, type=Path)
    parser.add_argument("--override", required=True, type=Path)
    parser.add_argument("--state", required=True, type=Path)
    parser.add_argument("--subwave-dir", type=Path)
    args = parser.parse_args()

    if args.action == "install":
        if not args.subwave_dir:
            parser.error("--subwave-dir is required for install")
        install(args.env, args.override, args.state, args.subwave_dir)
    else:
        uninstall(args.env, args.override, args.state)


if __name__ == "__main__":
    main()
