from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from scripts.dedupe_library import apply_migration, discover


class DedupeLibraryTest(unittest.TestCase):
    def _write_job(self, root: Path, job_id: str, *, created_at: str, engine: str, annotation_id: str, cache_key: str) -> None:
        job = root / "jobs" / job_id
        (job / "content" / "english").mkdir(parents=True)
        (job / "content" / "annotations").mkdir(parents=True)
        (job / "content" / "chinese").mkdir(parents=True)
        (job / "content" / "notes").mkdir(parents=True)
        (job / "source.pdf").write_bytes(b"same-pdf")
        (job / "document.html").write_text("<html>reader</html>", encoding="utf-8")
        (job / "content" / "english" / "blocks.json").write_text(json.dumps({"version": 1, "blocks": [{"block_id": "block-1", "text": "A paragraph"}]}), encoding="utf-8")
        manifest = {
            "job_id": job_id,
            "created_at": created_at,
            "source": {"filename": "Paper.pdf", "bytes": 8},
            "engine": {"name": engine},
            "validation": {"status": "PASS" if "MinerU" in engine else "REVIEW"},
        }
        (job / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
        annotations = [{"id": annotation_id, "kind": "highlight", "quote": "A quote", "block_id": "block-1", "note": "note", "created_at": created_at}]
        (job / "annotations.json").write_text(json.dumps(annotations), encoding="utf-8")
        (job / "translations.json").write_text(json.dumps({"version": 1, "entries": {cache_key: {"cache_key": cache_key, "block_id": "block-1", "source_text": "A", "translated_text": "甲", "updated_at": created_at}}}), encoding="utf-8")
        (job / "notes.md").write_text("# Note", encoding="utf-8")

    def test_same_pdf_is_merged_and_archived_recoverably(self) -> None:
        with tempfile.TemporaryDirectory(prefix="my-scholar-dedupe-") as temporary:
            root = Path(temporary)
            self._write_job(root, "a" * 16, created_at="2026-01-01T00:00:00+00:00", engine="OpenDataLoader PDF CLI", annotation_id="old", cache_key="old-key")
            self._write_job(root, "b" * 16, created_at="2026-01-02T00:00:00+00:00", engine="MinerU cached layout sidecar", annotation_id="new", cache_key="new-key")
            item = {
                "folder_ids": [],
                "values": {"reading_status": "未开始", "importance": 0},
                "progress": {"percent": 0, "page": 1, "scroll_top": 0},
                "deleted_at": None,
                "created_at": "2026-01-01T00:00:00+00:00",
                "updated_at": "2026-01-01T00:00:00+00:00",
                "metadata": {"fields": {"title": "Paper"}},
            }
            library = {"version": 4, "folders": [], "properties": [], "display": {}, "items": {"a" * 16: item, "b" * 16: dict(item)}}
            (root / "library.json").write_text(json.dumps(library), encoding="utf-8")
            discovered, groups = discover(root)
            self.assertEqual(len(groups), 1)
            self.assertEqual(groups[0]["canonical"]["job_id"], "b" * 16)
            backup = root / "backup"
            report = apply_migration(root, discovered, groups, backup)
            self.assertEqual(report["groups"][0]["canonical"], "b" * 16)
            saved = json.loads((root / "library.json").read_text())
            self.assertEqual(set(saved["items"]), {"b" * 16})
            self.assertTrue((root / "jobs" / ".duplicates" / ("a" * 16) / "source.pdf").is_file())
            merged_annotations = json.loads((root / "jobs" / ("b" * 16) / "annotations.json").read_text())
            self.assertEqual(len(merged_annotations), 1)
            merged_translations = json.loads((root / "jobs" / ("b" * 16) / "translations.json").read_text())
            self.assertEqual(set(merged_translations["entries"]), {"old-key", "new-key"})
            _, remaining_groups = discover(root)
            self.assertEqual(remaining_groups, [])


if __name__ == "__main__":
    unittest.main()
