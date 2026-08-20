#!/usr/bin/env python3
"""Merge historical duplicate PDF imports into one recoverable library entry.

The upload API already de-duplicates new files.  This command is for older
data created before that guard existed.  It only groups jobs whose source PDF
bytes have the same SHA-256 digest, keeps the best reader artifact, merges
library metadata and reader-side annotations/translations, then moves the
other job directories into ``data/jobs/.duplicates`` instead of deleting
them.

Run a preview first::

    python3 scripts/dedupe_library.py

Apply after reviewing the report::

    python3 scripts/dedupe_library.py --apply
"""

from __future__ import annotations

import argparse
import copy
import hashlib
import json
import os
import re
import shutil
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, Iterable, List, Tuple


PROJECT_ROOT = Path(__file__).resolve().parents[1]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from bibliography import BIBLIOGRAPHIC_FIELDS, INTEGER_FIELDS, LIST_FIELDS, empty_bibliographic_metadata  # noqa: E402


JOB_ID_RE = re.compile(r"^[a-f0-9]{12,40}$")
READING_STATUS_RANK = {"未开始": 0, "阅读中": 1, "已完成": 2}
METADATA_STATUS_RANK = {"not-run": 0, "failed": 1, "needs-review": 2, "local": 3, "retrieving": 3, "complete": 4}


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def read_json(path: Path, default: Any) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8")) if path.is_file() else default
    except (OSError, json.JSONDecodeError):
        return default


def write_json_atomic(path: Path, payload: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    temporary.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    temporary.replace(path)


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def normalized_text(value: Any) -> str:
    return " ".join(str(value or "").split())


def timestamp(value: Any) -> str:
    return str(value or "")


def _source_path(job_dir: Path) -> Path | None:
    for name in ("source.pdf", "upload.pdf"):
        candidate = job_dir / name
        if candidate.is_file():
            return candidate
    return None


def _entries(path: Path) -> List[Dict[str, Any]]:
    data = read_json(path, {})
    if isinstance(data, dict) and isinstance(data.get("entries"), dict):
        values = data["entries"].values()
    elif isinstance(data, list):
        values = data
    else:
        values = []
    return [copy.deepcopy(item) for item in values if isinstance(item, dict)]


def _annotation_signature(item: Dict[str, Any]) -> Tuple[Any, ...]:
    return (
        str(item.get("kind") or "highlight"),
        str(item.get("block_id") or item.get("source_block_id") or ""),
        normalized_text(item.get("quote")),
        item.get("page"),
        item.get("start"),
        item.get("end"),
        str(item.get("surface") or ""),
    )


def _annotation_priority(item: Dict[str, Any]) -> Tuple[int, int, str]:
    # A user-created note is more authoritative than a generated suggestion;
    # within the same class, retain the latest non-empty version.
    manual = 0 if str(item.get("source") or "") == "ai" else 1
    noted = 1 if normalized_text(item.get("note")) else 0
    return manual, noted, timestamp(item.get("created_at"))


def merge_annotations(job_dirs: Iterable[Path]) -> Tuple[List[Dict[str, Any]], Dict[str, int]]:
    merged: Dict[Tuple[Any, ...], Dict[str, Any]] = {}
    input_count = 0
    for job_dir in job_dirs:
        for item in _entries(job_dir / "annotations.json"):
            input_count += 1
            key = _annotation_signature(item)
            current = merged.get(key)
            if current is None:
                merged[key] = item
                continue
            notes = [normalized_text(current.get("note")), normalized_text(item.get("note"))]
            notes = [note for index, note in enumerate(notes) if note and note not in notes[:index]]
            chosen = item if _annotation_priority(item) > _annotation_priority(current) else current
            chosen = copy.deepcopy(chosen)
            if notes:
                chosen["note"] = "\n\n".join(notes)
            # Preserve an AI suggestion marker when the equivalent text also
            # has a user annotation, without rendering two highlights.
            if current.get("source") == "ai" or item.get("source") == "ai":
                chosen.setdefault("merged_sources", [])
                chosen["merged_sources"] = sorted(set(chosen["merged_sources"] + ["ai"]))
            merged[key] = chosen
    result = sorted(merged.values(), key=lambda item: (timestamp(item.get("created_at")), str(item.get("id") or "")))
    return result, {"input": input_count, "output": len(result), "deduplicated": input_count - len(result)}


def _translation_key(item: Dict[str, Any]) -> str:
    return str(item.get("cache_key") or "").strip()


def merge_translations(job_dirs: Iterable[Path]) -> Tuple[List[Dict[str, Any]], Dict[str, int]]:
    merged: Dict[str, Dict[str, Any]] = {}
    input_count = 0
    conflicts = 0
    for job_dir in job_dirs:
        for item in _entries(job_dir / "translations.json"):
            key = _translation_key(item)
            if not key:
                continue
            input_count += 1
            current = merged.get(key)
            if current is None:
                merged[key] = item
                continue
            current_text = normalized_text(current.get("translated_text") or current.get("translation"))
            incoming_text = normalized_text(item.get("translated_text") or item.get("translation"))
            if current_text != incoming_text:
                conflicts += 1
                variants = current.setdefault("merged_variants", [])
                if incoming_text and incoming_text not in [normalized_text(v) for v in variants]:
                    variants.append(incoming_text)
            # Translation records are caches; the latest completed value wins.
            if timestamp(item.get("updated_at")) >= timestamp(current.get("updated_at")):
                chosen = copy.deepcopy(item)
                existing_variants = current.get("merged_variants", [])
                if existing_variants:
                    chosen["merged_variants"] = existing_variants
                merged[key] = chosen
    result = sorted(merged.values(), key=lambda item: (str(item.get("block_id") or ""), _translation_key(item)))
    return result, {"input": input_count, "output": len(result), "conflicts": conflicts}


def merge_notes(job_dirs: Iterable[Path]) -> str:
    sections: List[str] = []
    for job_dir in job_dirs:
        path = job_dir / "notes.md"
        if not path.is_file():
            continue
        try:
            content = path.read_text(encoding="utf-8").strip()
        except OSError:
            continue
        if content and content not in sections:
            sections.append(content)
    return "\n\n---\n\n".join(sections)


def _field_value_score(field: str, value: Any) -> Tuple[int, int]:
    if value in (None, "", []):
        return (0, 0)
    if field in LIST_FIELDS:
        return (2, len(value) if isinstance(value, list) else 1)
    if field == "abstract":
        return (2, len(normalized_text(value)))
    return (1, len(normalized_text(value)))


def _metadata(raw: Any) -> Dict[str, Any]:
    result = empty_bibliographic_metadata()
    if not isinstance(raw, dict):
        return result
    fields = raw.get("fields") if isinstance(raw.get("fields"), dict) else {}
    for field in BIBLIOGRAPHIC_FIELDS:
        value = fields.get(field)
        if field in LIST_FIELDS:
            values = value if isinstance(value, list) else []
            result["fields"][field] = [normalized_text(item)[:500] for item in values if normalized_text(item)][:100]
        elif field in INTEGER_FIELDS:
            try:
                result["fields"][field] = int(value) if value not in (None, "") else None
            except (TypeError, ValueError):
                result["fields"][field] = None
        else:
            result["fields"][field] = str(value or "")[:12000 if field == "abstract" else 2000]
    if isinstance(raw.get("sources"), dict):
        result["sources"] = copy.deepcopy(raw["sources"])
    result["locked_fields"] = [str(item) for item in raw.get("locked_fields", []) if str(item) in BIBLIOGRAPHIC_FIELDS] if isinstance(raw.get("locked_fields"), list) else []
    result["candidates"] = copy.deepcopy(raw.get("candidates", [])[:5]) if isinstance(raw.get("candidates"), list) else []
    status = str(raw.get("status") or "not-run")
    result["status"] = status if status in METADATA_STATUS_RANK else "not-run"
    result["retrieved_at"] = str(raw.get("retrieved_at") or "") or None
    result["error"] = str(raw.get("error") or "")[:500]
    return result


def merge_metadata(items: Iterable[Dict[str, Any]]) -> Dict[str, Any]:
    candidates = [_metadata(item.get("metadata")) for item in items]
    result = empty_bibliographic_metadata()
    for field in BIBLIOGRAPHIC_FIELDS:
        values = [candidate["fields"].get(field) for candidate in candidates]
        if field in LIST_FIELDS:
            if field == "authors":
                # Older OpenDataLoader records stored the complete author
                # line as one semicolon-delimited string. Prefer a structured
                # extraction when one exists instead of re-introducing that
                # whole line as a ninth pseudo-author.
                structured = [value for value in values if isinstance(value, list) and len(value) > 1]
                if structured:
                    result["fields"][field] = max(structured, key=lambda item: len(item))[:100]
                    continue
            merged: List[str] = []
            # Prefer the most structured list first, then retain any names
            # that only appeared in an older extraction.
            for value in sorted(values, key=lambda item: _field_value_score(field, item), reverse=True):
                for entry in value if isinstance(value, list) else []:
                    entry = normalized_text(entry)
                    if entry and entry not in merged:
                        merged.append(entry[:500])
            result["fields"][field] = merged[:100]
            continue
        value = max(values, key=lambda item: _field_value_score(field, item)) if values else None
        result["fields"][field] = value
    for candidate in candidates:
        for key, value in candidate.get("sources", {}).items():
            if key not in result["sources"] or float(value.get("confidence", 0)) >= float(result["sources"].get(key, {}).get("confidence", 0)):
                result["sources"][key] = copy.deepcopy(value)
        result["locked_fields"] = sorted(set(result["locked_fields"]) | set(candidate.get("locked_fields", [])))
        for candidate_item in candidate.get("candidates", []):
            if candidate_item not in result["candidates"]:
                result["candidates"].append(copy.deepcopy(candidate_item))
    result["candidates"] = result["candidates"][:5]
    result["status"] = max((candidate.get("status", "not-run") for candidate in candidates), key=lambda item: METADATA_STATUS_RANK.get(item, 0), default="not-run")
    retrieved = [candidate.get("retrieved_at") for candidate in candidates if candidate.get("retrieved_at")]
    result["retrieved_at"] = max(retrieved) if retrieved else None
    errors = [candidate.get("error") for candidate in candidates if candidate.get("error")]
    result["error"] = errors[-1][:500] if errors else ""
    return result


def _merge_values(items: Iterable[Dict[str, Any]]) -> Dict[str, Any]:
    all_values = [item.get("values") if isinstance(item.get("values"), dict) else {} for item in items]
    keys = {key for values in all_values for key in values}
    result: Dict[str, Any] = {}
    for key in keys:
        values = [values.get(key) for values in all_values if key in values]
        if key == "reading_status":
            result[key] = max((str(value) for value in values), key=lambda value: READING_STATUS_RANK.get(value, 0), default="未开始")
        elif key == "importance":
            numbers = [int(value) for value in values if isinstance(value, (int, float)) and not isinstance(value, bool)]
            result[key] = max(numbers, default=0)
        elif any(isinstance(value, list) for value in values):
            result[key] = list(dict.fromkeys(item for value in values if isinstance(value, list) for item in value))
        else:
            nonempty = [value for value in values if value not in (None, "")]
            result[key] = nonempty[-1] if nonempty else (values[-1] if values else "")
    return result


def _merge_progress(items: Iterable[Dict[str, Any]]) -> Dict[str, Any]:
    progress_items = [item.get("progress") for item in items if isinstance(item.get("progress"), dict)]
    if not progress_items:
        return {"percent": 0, "page": 1, "scroll_top": 0}
    chosen = max(progress_items, key=lambda item: (float(item.get("percent", 0) or 0), timestamp(item.get("updated_at"))))
    return copy.deepcopy(chosen)


def merge_library_items(canonical_id: str, items: Dict[str, Dict[str, Any]], ordered_ids: List[str]) -> Dict[str, Any]:
    sources = [items[job_id] for job_id in ordered_ids if isinstance(items.get(job_id), dict)]
    result = copy.deepcopy(items[canonical_id])
    result["folder_ids"] = list(dict.fromkeys(folder for item in sources for folder in item.get("folder_ids", []) if folder))
    result["values"] = _merge_values(sources)
    result["progress"] = _merge_progress(sources)
    result["metadata"] = merge_metadata(sources)
    result["created_at"] = min((timestamp(item.get("created_at")) for item in sources if item.get("created_at")), default=result.get("created_at"))
    result["updated_at"] = max((timestamp(item.get("updated_at")) for item in sources if item.get("updated_at")), default=result.get("updated_at"))
    result["job_updated_at"] = max((timestamp(item.get("job_updated_at")) for item in sources if item.get("job_updated_at")), default=result.get("job_updated_at"))
    # Keep the canonical trash state unless it is absent and every duplicate
    # was explicitly trashed. This avoids resurrecting a user-hidden paper.
    if result.get("deleted_at") is None:
        deleted = [item.get("deleted_at") for item in sources if item.get("deleted_at")]
        if deleted and all(item.get("deleted_at") for item in sources):
            result["deleted_at"] = max(deleted)
    return result


def _job_info(job_dir: Path) -> Dict[str, Any] | None:
    manifest = read_json(job_dir / "manifest.json", {})
    if not isinstance(manifest, dict):
        return None
    source = manifest.get("source") if isinstance(manifest.get("source"), dict) else {}
    source_path = _source_path(job_dir)
    if source_path is None:
        return None
    digest = str(source.get("sha256") or "").strip().lower() or sha256_file(source_path)
    return {"job_id": job_dir.name, "dir": job_dir, "manifest": manifest, "source_filename": str(source.get("filename") or "document.pdf"), "source_bytes": source_path.stat().st_size, "sha256": digest, "created_at": timestamp(manifest.get("created_at"))}


def _quality_key(info: Dict[str, Any]) -> Tuple[Any, ...]:
    manifest = info["manifest"]
    engine = str((manifest.get("engine") or {}).get("name") or "").lower() if isinstance(manifest.get("engine"), dict) else ""
    validation = manifest.get("validation") if isinstance(manifest.get("validation"), dict) else {}
    english = read_json(info["dir"] / "content" / "english" / "blocks.json", {})
    block_count = len(english.get("blocks", [])) if isinstance(english, dict) and isinstance(english.get("blocks"), list) else 0
    return (
        1 if "mineru" in engine else 0,
        1 if str(validation.get("status") or "") == "PASS" else 0,
        block_count,
        (info["dir"] / "document.html").stat().st_size if (info["dir"] / "document.html").is_file() else 0,
        1 if (info["dir"] / "ai-highlights.json").is_file() else 0,
        1 if (info["dir"] / "ai-review.json").is_file() else 0,
        info["created_at"],
        info["job_id"],
    )


def _merge_ai_json(canonical_dir: Path, job_dirs: Iterable[Path]) -> None:
    highlights: Dict[Tuple[str, str, str], Dict[str, Any]] = {}
    review_candidates: List[Dict[str, Any]] = []
    for job_dir in job_dirs:
        result = read_json(job_dir / "ai-highlights.json", {})
        if isinstance(result, dict):
            for item in result.get("highlights", []) if isinstance(result.get("highlights"), list) else []:
                if not isinstance(item, dict):
                    continue
                key = (str(item.get("block_id") or ""), normalized_text(item.get("quote")), str(item.get("category") or ""))
                highlights.setdefault(key, copy.deepcopy(item))
        review = read_json(job_dir / "ai-review.json", {})
        if isinstance(review, dict) and review.get("status"):
            review_candidates.append(review)
    if highlights:
        canonical_result = read_json(canonical_dir / "ai-highlights.json", {})
        result = copy.deepcopy(canonical_result) if isinstance(canonical_result, dict) else {"status": "completed", "model": None}
        result["highlights"] = sorted(highlights.values(), key=lambda item: (str(item.get("block_id") or ""), normalized_text(item.get("quote"))))
        write_json_atomic(canonical_dir / "ai-highlights.json", result)
    if review_candidates:
        chosen = max(review_candidates, key=lambda item: (1 if item.get("status") == "completed" else 0, timestamp(item.get("reviewed_at"))))
        if chosen.get("status") == "completed":
            write_json_atomic(canonical_dir / "ai-review.json", chosen)


def _write_merged_reader_artifacts(canonical_dir: Path, job_dirs: List[Path]) -> Dict[str, Dict[str, int]]:
    annotations, annotation_stats = merge_annotations(job_dirs)
    translations, translation_stats = merge_translations(job_dirs)
    notes = merge_notes(job_dirs)
    write_json_atomic(canonical_dir / "annotations.json", annotations)
    write_json_atomic(canonical_dir / "content" / "annotations" / "annotations.json", annotations)
    write_json_atomic(canonical_dir / "translations.json", {"version": 1, "entries": {str(item["cache_key"]): item for item in translations}})
    write_json_atomic(canonical_dir / "content" / "chinese" / "blocks.json", {"version": 1, "blocks": translations})
    if notes or (canonical_dir / "notes.md").is_file():
        (canonical_dir / "notes.md").write_text(notes, encoding="utf-8")
        (canonical_dir / "content" / "notes" / "notes.md").parent.mkdir(parents=True, exist_ok=True)
        (canonical_dir / "content" / "notes" / "notes.md").write_text(notes, encoding="utf-8")
    _merge_ai_json(canonical_dir, job_dirs)
    return {"annotations": annotation_stats, "translations": translation_stats}


def _backup(data_root: Path, backup_dir: Path) -> None:
    if backup_dir.exists():
        raise RuntimeError(f"备份目录已存在，为避免覆盖请换一个路径：{backup_dir}")
    backup_dir.mkdir(parents=True, exist_ok=False)
    if (data_root / "library.json").is_file():
        shutil.copy2(data_root / "library.json", backup_dir / "library.json")
    if (data_root / "library.json.bak").is_file():
        shutil.copy2(data_root / "library.json.bak", backup_dir / "library.json.bak")
    shutil.copytree(data_root / "jobs", backup_dir / "jobs")


def discover(data_root: Path) -> Tuple[Dict[str, Any], List[Dict[str, Any]]]:
    library_path = data_root / "library.json"
    library = read_json(library_path, {})
    if not isinstance(library, dict) or not isinstance(library.get("items"), dict):
        raise RuntimeError(f"无法读取文献库索引：{library_path}")
    jobs_root = data_root / "jobs"
    infos = [_job_info(path) for path in jobs_root.iterdir() if path.is_dir() and JOB_ID_RE.fullmatch(path.name)] if jobs_root.is_dir() else []
    infos = [info for info in infos if info]
    groups: Dict[str, List[Dict[str, Any]]] = {}
    for info in infos:
        groups.setdefault(info["sha256"], []).append(info)
    duplicate_groups = []
    for digest, group in sorted(groups.items()):
        if len(group) < 2:
            continue
        ordered = sorted(group, key=_quality_key, reverse=True)
        duplicate_groups.append({"sha256": digest, "infos": ordered, "canonical": ordered[0]})
    return library, duplicate_groups


def apply_migration(data_root: Path, library: Dict[str, Any], groups: List[Dict[str, Any]], backup_dir: Path) -> Dict[str, Any]:
    _backup(data_root, backup_dir)
    jobs_root = data_root / "jobs"
    archive_root = jobs_root / ".duplicates"
    archive_root.mkdir(parents=True, exist_ok=True)
    items = library["items"]
    report_groups: List[Dict[str, Any]] = []

    def _persist() -> Dict[str, Any]:
        """Write the index and manifest for everything merged so far.

        Directory moves are not transactional, so persisting per group keeps
        library.json and merge-manifest.json consistent with the filesystem
        even when a later group fails; archived ids for one (sha256,
        canonical) pair are unioned across partial runs.
        """
        write_json_atomic(data_root / "library.json", library)
        manifest_path = archive_root / "merge-manifest.json"
        previous = read_json(manifest_path, {})
        previous_groups = previous.get("groups", []) if isinstance(previous, dict) and isinstance(previous.get("groups"), list) else []
        merged_groups: Dict[Tuple[str, str], Dict[str, Any]] = {}
        for entry in [*previous_groups, *report_groups]:
            if not isinstance(entry, dict):
                continue
            key = (str(entry.get("sha256")), str(entry.get("canonical")))
            current = merged_groups.get(key)
            if current is None:
                merged_groups[key] = copy.deepcopy(entry)
                continue
            archived_union = list(dict.fromkeys([*current.get("archived", []), *entry.get("archived", [])]))
            current.update(copy.deepcopy(entry))
            current["archived"] = archived_union
        report = {"version": 1, "migrated_at": utc_now(), "groups": list(merged_groups.values()), "backup_dir": str(backup_dir)}
        write_json_atomic(manifest_path, report)
        return report

    report: Dict[str, Any] = {"version": 1, "migrated_at": utc_now(), "groups": [], "backup_dir": str(backup_dir)}
    for group in groups:
        infos = group["infos"]
        canonical = group["canonical"]
        canonical_id = canonical["job_id"]
        try:
            ids = [info["job_id"] for info in infos]
            present_ids = [job_id for job_id in ids if isinstance(items.get(job_id), dict)]
            if canonical_id not in items:
                # A completed job without an index is still a valid canonical
                # artifact; synthesize the minimal item and let the server enrich it.
                items[canonical_id] = {"values": {"reading_status": "未开始", "importance": 0, "research_topic": [], "venue": ""}, "folder_ids": [], "metadata": empty_bibliographic_metadata(), "progress": {"percent": 0, "page": 1, "scroll_top": 0}, "deleted_at": None, "created_at": canonical["created_at"], "updated_at": canonical["created_at"], "job_updated_at": canonical["created_at"]}
                present_ids.append(canonical_id)
            if not present_ids:
                present_ids = [canonical_id]
            merged_item = merge_library_items(canonical_id, items, present_ids)
            items[canonical_id] = merged_item
            for duplicate_id in ids:
                if duplicate_id != canonical_id:
                    items.pop(duplicate_id, None)
            artifact_dirs = [info["dir"] for info in infos]
            stats = _write_merged_reader_artifacts(canonical["dir"], artifact_dirs)
            archived: List[str] = []
            report_groups.append({"sha256": group["sha256"], "canonical": canonical_id, "archived": archived, "source_filename": canonical["source_filename"], "artifacts": stats})
            for info in infos:
                duplicate_id = info["job_id"]
                if duplicate_id == canonical_id:
                    continue
                target = archive_root / duplicate_id
                if target.exists():
                    raise RuntimeError(f"归档目标已存在，迁移已停止以避免覆盖：{target}")
                shutil.move(str(info["dir"]), str(target))
                archived.append(duplicate_id)
        finally:
            report = _persist()
    return report


def main() -> int:
    parser = argparse.ArgumentParser(description="合并历史重复文献导入")
    parser.add_argument("--data-root", type=Path, default=PROJECT_ROOT / "data")
    parser.add_argument("--apply", action="store_true", help="执行迁移；默认仅预览")
    parser.add_argument("--backup-dir", type=Path, default=None, help="迁移前备份目录（仅 --apply）")
    args = parser.parse_args()
    data_root = args.data_root.expanduser().resolve()
    library, groups = discover(data_root)
    if not groups:
        print(json.dumps({"duplicate_groups": 0, "message": "没有发现同 SHA-256 的重复文献。"}, ensure_ascii=False, indent=2))
        return 0
    preview = []
    for group in groups:
        preview.append({"sha256": group["sha256"], "canonical": group["canonical"]["job_id"], "jobs": [info["job_id"] for info in group["infos"]], "source_filename": group["canonical"]["source_filename"]})
    if not args.apply:
        print(json.dumps({"duplicate_groups": len(groups), "groups": preview, "next": "使用 --apply 执行，并将重复目录归档到 data/jobs/.duplicates。"}, ensure_ascii=False, indent=2))
        return 0
    backup_dir = (args.backup_dir or data_root.parent / ".backups" / f"dedupe-{datetime.now().strftime('%Y%m%d-%H%M%S')}").expanduser().resolve()
    report = apply_migration(data_root, library, groups, backup_dir)
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
