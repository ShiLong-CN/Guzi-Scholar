"""Locate optional PDF toolchains across development and packaged layouts."""

from __future__ import annotations

import os
from pathlib import Path
from typing import Iterable, Mapping


def _unique_paths(paths: Iterable[Path]) -> list[Path]:
    seen: set[str] = set()
    result: list[Path] = []
    for path in paths:
        normalized = Path(path).expanduser().resolve()
        key = str(normalized)
        if key in seen:
            continue
        seen.add(key)
        result.append(normalized)
    return result


def toolchain_roots(
    project_root: Path,
    *,
    env: Mapping[str, str] | None = None,
) -> list[Path]:
    """Return roots for explicit, legacy, migrated, and packaged layouts."""
    values = os.environ if env is None else env
    project_root = Path(project_root).expanduser().resolve()
    configured = str(values.get("MY_SCHOLAR_TOOLCHAIN_ROOT", "")).strip()
    roots: list[Path] = []
    if configured:
        roots.append(Path(configured))
    roots.extend(
        [
            project_root.parent,
            project_root.parent.parent,
            project_root,
        ]
    )
    return _unique_paths(roots)


def tool_path_candidates(
    project_root: Path,
    tool_name: str,
    *parts: str,
    env: Mapping[str, str] | None = None,
) -> list[Path]:
    candidates: list[Path] = []
    for root in toolchain_roots(project_root, env=env):
        tool_root = root if root.name == tool_name else root / tool_name
        candidates.append(tool_root.joinpath(*parts))
    return _unique_paths(candidates)
