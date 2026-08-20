from __future__ import annotations

import json
import sys
import tempfile
import threading
import unittest
from pathlib import Path
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from component_manager import ComponentError, ComponentManifest  # noqa: E402
from parsing_providers import (  # noqa: E402
    LocalMineruProvider,
    ParsingProviderRegistry,
    ParsingRequest,
    ProviderError,
    RemoteGuziProvider,
    create_default_registry,
)


class FakeManager:
    def __init__(self, executable: Path, *, state: str = "ready") -> None:
        self.executable = executable
        self.state = state
        self.manifest = ComponentManifest.from_mapping({
            "schema_version": 1,
            "component": "mineru",
            "version": "test-1",
            "model_version": "model-1",
            "platform": "darwin",
            "arch": "arm64",
            "archive_type": "zip",
            "archive_size": 1,
            "installed_size": 1,
            "sha256": "0" * 64,
            "url": "https://components.example.invalid/mineru.zip",
            "source": "unit-test-fixture",
            "executable": "bin/mineru",
            "health_check_args": ["--self-test"],
            "min_os_version": "14.0",
            "min_memory_bytes": 1,
            "min_free_disk_bytes": 1,
            "signing_identity": "Developer ID Application: Test (ABCDE12345)",
            "team_id": "ABCDE12345",
        })

    def manifest_for(self, _component: str):
        return self.manifest

    def component_metadata(self, _component: str):
        return {
            "version": self.manifest.version,
            "model_version": self.manifest.model_version,
            "requirements": {"platform": "darwin", "arch": "arm64"},
        }

    def status(self, _manifest):
        if self.state == "ready":
            return {"state": "ready", "reason_code": "ready", "executable": str(self.executable), "installed_bytes": 1}
        return {"state": self.state, "reason_code": self.state}

    def executable_path(self, _manifest):
        return self.executable

    def target_dir(self, _manifest):
        return self.executable.parent.parent

    def install(self, _manifest, *, progress=None, cancel_event=None):
        if self.state == "failed":
            raise ComponentError("download failed", code="download_failed")
        self.state = "ready"
        return self.status(_manifest)

    def cancel_install(self):
        return True

    def remove(self, _manifest):
        self.state = "not_installed"
        return {"state": "not_installed", "reason_code": "not_installed", "removed": True}


class ParsingProviderTest(unittest.TestCase):
    def test_default_registry_is_json_safe_and_has_no_network_capability(self) -> None:
        with tempfile.TemporaryDirectory(prefix="guzi-provider-registry-") as temp:
            downloader_called = False

            def downloader(*_args):
                nonlocal downloader_called
                downloader_called = True

            registry = create_default_registry(Path(temp), downloader=downloader)
            capabilities = registry.list_capabilities()
            json.dumps(capabilities)
            self.assertEqual([item["id"] for item in capabilities], ["local-mineru", "remote-guzi"])
            self.assertEqual(capabilities[0]["state"], "artifact_unavailable")
            self.assertEqual(capabilities[1]["state"], "disabled")
            self.assertEqual(capabilities[1]["reason_code"], "not_configured")
            self.assertFalse(downloader_called)

    def test_local_run_passes_only_managed_executable_and_cancel_token(self) -> None:
        with tempfile.TemporaryDirectory(prefix="guzi-provider-run-") as temp:
            root = Path(temp)
            executable = root / "components/mineru/test-1/darwin-arm64/bin/mineru"
            executable.parent.mkdir(parents=True)
            executable.write_text("#!/bin/sh\nexit 0\n", encoding="utf-8")
            manager = FakeManager(executable)
            provider = LocalMineruProvider(manager, health_check=lambda _path: None)
            request = ParsingRequest("job-1", root / "source.pdf", root / "output", "paper.pdf", 2)
            cancel = threading.Event()
            manifest = {"engine": {"name": "MinerU local pipeline"}}
            with patch("parsing_providers.process_pdf", return_value=manifest) as process:
                result = provider.run(request, progress=lambda *_args: None, cancel_event=cancel)
            kwargs = process.call_args.kwargs
            self.assertEqual(kwargs["backend_override"], "layout")
            self.assertEqual(kwargs["layout_executable"], executable)
            self.assertEqual(kwargs["layout_runtime_root"], executable.parent.parent)
            self.assertIs(kwargs["cancel_event"], cancel)
            self.assertEqual(result.manifest, manifest)
            self.assertEqual(result.metrics["provider_id"], "local-mineru")

    def test_local_not_ready_and_component_errors_are_structured(self) -> None:
        provider = LocalMineruProvider(FakeManager(Path("/managed/mineru"), state="not_installed"), health_check=lambda _path: None)
        with self.assertRaises(ProviderError) as caught:
            provider.run({"job_id": "x", "source_pdf": "/tmp/a.pdf", "output_dir": "/tmp/out"})
        self.assertEqual(caught.exception.code, "not_installed")
        self.assertEqual(caught.exception.http_status, 428)

        provider = LocalMineruProvider(FakeManager(Path("/managed/mineru"), state="failed"), health_check=lambda _path: None)
        with self.assertRaises(ProviderError) as caught:
            provider.install()
        self.assertEqual(caught.exception.code, "download_failed")
        self.assertEqual(caught.exception.http_status, 502)

    def test_remote_provider_and_unknown_registry_never_submit(self) -> None:
        remote = RemoteGuziProvider()
        registry = ParsingProviderRegistry([remote])
        with self.assertRaises(ProviderError) as caught:
            remote.run({"source_pdf": "/tmp/private.pdf"})
        self.assertEqual(caught.exception.code, "not_configured")
        with self.assertRaises(ProviderError) as missing:
            registry.get("missing")
        self.assertEqual(missing.exception.http_status, 404)


if __name__ == "__main__":
    unittest.main()
