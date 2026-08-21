from __future__ import annotations

import hashlib
import io
import json
import os
import sys
import tempfile
import threading
import unittest
import urllib.request
import zipfile
from pathlib import Path
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from component_manager import (  # noqa: E402
    ComponentCancelled,
    ComponentError,
    ComponentManager,
    ComponentManifest,
    PRODUCTION_COMPONENT_CATALOG,
    SystemInfo,
    _HTTPSOnlyRedirectHandler,
    _default_downloader,
    _default_executable_health_check,
    _default_signature_verifier,
    _resume_metadata_path,
)


TEAM_ID = "ABCDE12345"
SIGNING_IDENTITY = f"Developer ID Application: Guzi Scholar Test ({TEAM_ID})"
FAKE_URL = "https://components.example.invalid/mineru.zip"
FAKE_MACHO = b"\xcf\xfa\xed\xfe" + b"guzi-test-macho"


def make_zip(path: Path, members: dict[str, bytes]) -> None:
    with zipfile.ZipFile(path, "w", compression=zipfile.ZIP_DEFLATED) as bundle:
        for name, body in members.items():
            info = zipfile.ZipInfo(name)
            info.external_attr = 0o755 << 16 if name == "bin/mineru" else 0o644 << 16
            bundle.writestr(info, body)


def manifest_mapping(archive: Path, **overrides: object) -> dict[str, object]:
    base: dict[str, object] = {
        "schema_version": 1,
        "component": "mineru",
        "version": "test-1.0.0",
        "model_version": "test-model-1",
        "platform": "darwin",
        "arch": "arm64",
        "archive_type": "zip",
        "archive_size": archive.stat().st_size,
        "installed_size": 1024 * 1024,
        "sha256": hashlib.sha256(archive.read_bytes()).hexdigest(),
        "url": FAKE_URL,
        "source": "unit-test-fixture",
        "executable": "bin/mineru",
        "health_check_args": ["--self-test"],
        "min_os_version": "14.0",
        "min_memory_bytes": 16 * 1024**3,
        "min_free_disk_bytes": 20 * 1024**3,
        "signing_identity": SIGNING_IDENTITY,
        "team_id": TEAM_ID,
    }
    base.update(overrides)
    return base


def catalog_for(mapping: dict[str, object]) -> dict[str, object]:
    requirements = {
        key: mapping[key]
        for key in ("platform", "arch", "min_os_version", "min_memory_bytes", "min_free_disk_bytes")
    }
    artifact = {
        key: value for key, value in mapping.items()
        if key not in {
            "schema_version", "component", "version", "model_version", "platform", "arch",
            "min_os_version", "min_memory_bytes", "min_free_disk_bytes",
        }
    }
    return {
        "schema_version": 1,
        "components": {
            "mineru": {
                "version": mapping["version"],
                "model_version": mapping["model_version"],
                "requirements": requirements,
                "artifacts": {"darwin-arm64": artifact},
            }
        },
    }


def healthy_system(_root: Path) -> SystemInfo:
    return SystemInfo("darwin", "arm64", "15.0", 32 * 1024**3, 100 * 1024**3)


class FakeResponse:
    def __init__(self, body: bytes, *, status: int, headers: dict[str, str]) -> None:
        self.stream = io.BytesIO(body)
        self.status = status
        self.headers = headers

    def __enter__(self) -> "FakeResponse":
        return self

    def __exit__(self, *_args: object) -> None:
        return None

    def read(self, size: int = -1) -> bytes:
        return self.stream.read(size)

    def geturl(self) -> str:
        return FAKE_URL

    def getcode(self) -> int:
        return self.status


class ComponentManagerTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory(prefix="guzi-components-")
        self.root = Path(self.temp.name)
        self.archive = self.root / "mineru.zip"
        make_zip(self.archive, {"bin/mineru": FAKE_MACHO, "models/model.bin": b"model"})
        self.mapping = manifest_mapping(self.archive)

    def tearDown(self) -> None:
        self.temp.cleanup()

    def manager(self, *, downloader=None, mapping=None, system_probe=healthy_system, signature_verifier=None, health=None) -> ComponentManager:
        selected = dict(mapping or self.mapping)
        return ComponentManager(
            self.root / "components",
            catalog=catalog_for(selected),
            downloader=downloader,
            system_probe=system_probe,
            signature_verifier=signature_verifier or (lambda _path, _manifest: None),
            executable_health_check=health or (lambda _path, _manifest: None),
        )

    def copy_downloader(self, manifest, destination, on_bytes, cancel_event) -> None:
        data = self.archive.read_bytes()
        destination.write_bytes(data)
        on_bytes(len(data), manifest.archive_size)

    def test_production_catalog_has_no_download_artifact(self) -> None:
        component = PRODUCTION_COMPONENT_CATALOG["components"]["mineru"]
        self.assertEqual(component["artifacts"], {})
        self.assertTrue(component["install_help_url"].startswith("https://"))

    def test_production_manager_discovers_a_receipt_backed_local_component(self) -> None:
        installed = self.manager(downloader=self.copy_downloader)
        installed_manifest = installed.manifest_for("mineru")
        installed.install(installed_manifest)

        discovered = ComponentManager(
            self.root / "components",
            catalog=PRODUCTION_COMPONENT_CATALOG,
            system_probe=healthy_system,
            signature_verifier=lambda _path, _manifest: None,
            executable_health_check=lambda _path, _manifest: None,
        )
        with patch("component_manager.sys.platform", "darwin"), patch(
            "component_manager.platform_module.machine", return_value="arm64"
        ):
            manifest = discovered.manifest_for("mineru")
            self.assertIsNotNone(manifest)
            self.assertTrue(manifest.local_only)
            self.assertEqual(discovered.status(manifest)["state"], "ready")
            self.assertEqual(discovered.discovery_status("mineru")["state"], "found")

    def test_import_existing_component_copies_without_deleting_source(self) -> None:
        source_root = self.root / "source-components"
        source_manager = ComponentManager(
            source_root,
            catalog=catalog_for(self.mapping),
            downloader=self.copy_downloader,
            system_probe=healthy_system,
            signature_verifier=lambda _path, _manifest: None,
            executable_health_check=lambda _path, _manifest: None,
        )
        source_manifest = source_manager.manifest_for("mineru")
        source_manager.install(source_manifest)
        source = source_manager.target_dir(source_manifest)

        destination = ComponentManager(
            self.root / "destination-components",
            catalog=PRODUCTION_COMPONENT_CATALOG,
            system_probe=healthy_system,
            signature_verifier=lambda _path, _manifest: None,
            executable_health_check=lambda _path, _manifest: None,
        )
        with patch("component_manager.sys.platform", "darwin"), patch(
            "component_manager.platform_module.machine", return_value="arm64"
        ):
            imported = destination.import_existing("mineru", source)
        manifest = destination.manifest_for("mineru")
        self.assertTrue(manifest.local_only)
        self.assertEqual(imported["state"], "ready")
        self.assertTrue(destination.target_dir(manifest).is_dir())
        self.assertTrue(source.is_dir())

    def test_external_component_pointer_revalidates_and_never_deletes_the_environment(self) -> None:
        executable = self.root / "external-mineru/bin/mineru"
        executable.parent.mkdir(parents=True)
        executable.write_text(
            f"#!{sys.executable}\nimport sys\nprint('mineru test' if '--version' in sys.argv else 'Usage: mineru')\n",
            encoding="utf-8",
        )
        executable.chmod(0o755)
        manager = ComponentManager(self.root / "external-components", catalog=PRODUCTION_COMPONENT_CATALOG)
        configured = manager.configure_external("mineru", executable)
        self.assertEqual(configured.executable, executable.resolve())
        self.assertEqual(manager.external_candidate("mineru").executable, executable.resolve())
        candidate, status = manager.external_candidate_status("mineru")
        self.assertEqual(candidate.executable, executable.resolve())
        self.assertEqual(status["state"], "ready")
        executable.write_text(executable.read_text(encoding="utf-8") + "# changed\n", encoding="utf-8")
        self.assertIsNone(manager.external_candidate("mineru"))
        candidate, status = manager.external_candidate_status("mineru")
        self.assertIsNone(candidate)
        self.assertEqual(status["state"], "external_changed")
        self.assertTrue(manager.clear_external("mineru"))
        self.assertTrue(executable.is_file())

    def test_manifest_rejects_insecure_url_and_missing_darwin_signing_identity(self) -> None:
        with self.assertRaisesRegex(ComponentError, "HTTPS"):
            ComponentManifest.from_mapping({**self.mapping, "url": "http://example.invalid/mineru.zip"})
        with self.assertRaisesRegex(ComponentError, "签名身份"):
            ComponentManifest.from_mapping({**self.mapping, "signing_identity": "", "team_id": ""})
        adhoc = ComponentManifest.from_mapping({
            **self.mapping,
            "signature_policy": "adhoc-sha256",
            "signing_identity": "",
            "team_id": "",
        })
        self.assertEqual(adhoc.signature_policy, "adhoc-sha256")
        with self.assertRaisesRegex(ComponentError, "不能声明"):
            ComponentManifest.from_mapping({**self.mapping, "signature_policy": "adhoc-sha256"})
        with self.assertRaisesRegex(ComponentError, "签名策略"):
            ComponentManifest.from_mapping({**self.mapping, "signature_policy": "disabled"})
        with self.assertRaisesRegex(ComponentError, "--self-test"):
            ComponentManifest.from_mapping({**self.mapping, "health_check_args": ["--help"]})

    def test_macos_install_rejects_a_script_launcher_even_when_other_checks_are_mocked(self) -> None:
        make_zip(self.archive, {"bin/mineru": b"#!/usr/bin/env python3\n"})
        mapping = manifest_mapping(self.archive)
        manager = self.manager(downloader=self.copy_downloader, mapping=mapping)
        manifest = manager.manifest_for("mineru")
        with self.assertRaisesRegex(ComponentError, "Mach-O") as raised:
            manager.install(manifest)
        self.assertEqual(raised.exception.code, "non_self_contained_executable")
        self.assertFalse(manager.target_dir(manifest).exists())

    def test_default_health_check_uses_the_offline_self_test_contract(self) -> None:
        manifest = ComponentManifest.from_mapping(self.mapping)
        executable = self.root / "managed/bin/mineru"
        executable.parent.mkdir(parents=True)
        executable.write_bytes(FAKE_MACHO)
        completed = type("Completed", (), {"returncode": 7})()
        with patch("component_manager.subprocess.run", return_value=completed) as run:
            failure = _default_executable_health_check(executable, manifest)
        self.assertEqual(failure, "健康检查退出码 7")
        resolved = executable.resolve()
        self.assertEqual(run.call_args.args[0], [str(resolved), "--self-test"])
        self.assertEqual(run.call_args.kwargs["cwd"], str(resolved.parent.parent))
        self.assertEqual(run.call_args.kwargs["env"]["PATH"], f"{resolved.parent.parent}/bin:/usr/bin:/bin:/usr/sbin:/sbin")
        self.assertEqual(run.call_args.kwargs["env"]["HF_HUB_OFFLINE"], "1")

    def test_default_signature_check_requires_arm64_identity_and_notarization(self) -> None:
        manifest = ComponentManifest.from_mapping(self.mapping)
        successful = [
            type("Completed", (), {"returncode": 0, "stdout": "Mach-O 64-bit executable arm64"})(),
            type("Completed", (), {"returncode": 0, "stdout": ""})(),
            type("Completed", (), {
                "returncode": 0,
                "stdout": f"Authority={SIGNING_IDENTITY}\nTeamIdentifier={TEAM_ID}\n",
            })(),
            type("Completed", (), {"returncode": 0, "stdout": "accepted"})(),
        ]
        with patch("component_manager.Path.is_file", return_value=True), patch(
            "component_manager.subprocess.run", side_effect=successful
        ) as run:
            self.assertIsNone(_default_signature_verifier(Path("/managed/bin/mineru"), manifest))
        self.assertEqual(run.call_args_list[0].args[0][:2], ["/usr/bin/file", "-b"])
        self.assertEqual(run.call_args_list[-1].args[0][:4], ["/usr/sbin/spctl", "--assess", "--type", "execute"])

    def test_preview_signature_policy_accepts_only_verified_adhoc_code(self) -> None:
        manifest = ComponentManifest.from_mapping({
            **self.mapping,
            "signature_policy": "adhoc-sha256",
            "signing_identity": "",
            "team_id": "",
        })
        successful = [
            type("Completed", (), {"returncode": 0, "stdout": "Mach-O 64-bit executable arm64"})(),
            type("Completed", (), {"returncode": 0, "stdout": ""})(),
            type("Completed", (), {
                "returncode": 0,
                "stdout": "Signature=adhoc\nTeamIdentifier=not set\n",
            })(),
        ]
        with patch("component_manager.Path.is_file", return_value=True), patch(
            "component_manager.subprocess.run", side_effect=successful
        ) as run:
            self.assertIsNone(_default_signature_verifier(Path("/managed/bin/mineru"), manifest))
        self.assertEqual(len(run.call_args_list), 3)
        self.assertFalse(any(call.args[0][0] == "/usr/sbin/spctl" for call in run.call_args_list))

    def test_platform_memory_and_disk_preflight_are_distinct(self) -> None:
        cases = [
            (SystemInfo("windows", "x64", "15.0", 32 * 1024**3, 100 * 1024**3), "unsupported_platform"),
            (SystemInfo("darwin", "arm64", "13.6", 32 * 1024**3, 100 * 1024**3), "incompatible_os"),
            (SystemInfo("darwin", "arm64", "15.0", 8 * 1024**3, 100 * 1024**3), "insufficient_memory"),
            (SystemInfo("darwin", "arm64", "15.0", 32 * 1024**3, 1024), "insufficient_disk"),
        ]
        for info, expected in cases:
            with self.subTest(expected=expected):
                manager = self.manager(system_probe=lambda _root, value=info: value)
                manifest = manager.manifest_for("mineru")
                self.assertIsNotNone(manifest)
                self.assertEqual(manager.status(manifest)["reason_code"], expected)

    def test_install_verifies_in_staging_then_atomically_publishes_and_removes(self) -> None:
        verification_paths: list[Path] = []

        def verifier(path: Path, _manifest: ComponentManifest) -> None:
            verification_paths.append(path)
            self.assertIn(".staging-", str(path))
            self.assertFalse(manager.target_dir(manifest).exists())
            return None

        manager = self.manager(downloader=self.copy_downloader, signature_verifier=verifier)
        manifest = manager.manifest_for("mineru")
        target = manager.target_dir(manifest)
        progress: list[tuple[str, float]] = []
        result = manager.install(manifest, progress=lambda stage, value: progress.append((stage, value)))
        self.assertEqual(result["state"], "ready")
        self.assertTrue(manager.executable_path(manifest).is_file())
        self.assertEqual(target, (self.root / "components/mineru/test-1.0.0/darwin-arm64").resolve())
        self.assertTrue(verification_paths)
        self.assertEqual(progress[-1], ("安装完成", 1.0))
        self.assertFalse(list((self.root / "components").rglob("*.part")))
        self.assertFalse(list((self.root / "components").rglob(".staging-*")))
        removed = manager.remove(manifest)
        self.assertTrue(removed["removed"])
        self.assertFalse(target.exists())

    def test_cancel_and_checksum_failure_clean_partial_and_staging_and_retain_outcome(self) -> None:
        cancel = threading.Event()

        def cancelled_download(manifest, destination, on_bytes, _cancel_event) -> None:
            body = self.archive.read_bytes()[:8]
            destination.write_bytes(body)
            on_bytes(len(body), manifest.archive_size)
            cancel.set()

        manager = self.manager(downloader=cancelled_download)
        manifest = manager.manifest_for("mineru")
        with self.assertRaises(ComponentCancelled):
            manager.install(manifest, cancel_event=cancel)
        self.assertEqual(manager.status(manifest)["state"], "cancelled")
        self.assertFalse(manager._download_part(manifest).exists())

        bad = {**self.mapping, "sha256": "0" * 64}
        manager = self.manager(downloader=self.copy_downloader, mapping=bad)
        manifest = manager.manifest_for("mineru")
        with self.assertRaisesRegex(ComponentError, "SHA-256"):
            manager.install(manifest)
        self.assertEqual(manager.status(manifest)["reason_code"], "checksum_mismatch")
        self.assertFalse(manager.target_dir(manifest).exists())

        manager = self.manager(
            downloader=self.copy_downloader,
            mapping=self.mapping,
            health=lambda _path: "runtime failed",
        )
        manifest = manager.manifest_for("mineru")
        with self.assertRaisesRegex(ComponentError, "健康检查失败"):
            manager.install(manifest)
        self.assertFalse(manager.target_dir(manifest).exists())
        self.assertFalse(manager._download_part(manifest).exists())

    def test_network_failure_retains_one_bounded_partial_for_retry(self) -> None:
        data = self.archive.read_bytes()
        calls = 0

        def resumable_download(manifest, destination, on_bytes, _cancel_event) -> None:
            nonlocal calls
            calls += 1
            if calls == 1:
                destination.write_bytes(data[:10])
                on_bytes(10, manifest.archive_size)
                raise ComponentError("temporary network failure", code="download_failed")
            self.assertEqual(destination.read_bytes(), data[:10])
            with destination.open("ab") as output:
                output.write(data[10:])
            on_bytes(len(data), manifest.archive_size)

        manager = self.manager(downloader=resumable_download)
        manifest = manager.manifest_for("mineru")
        with self.assertRaisesRegex(ComponentError, "temporary"):
            manager.install(manifest)
        self.assertEqual(manager.status(manifest)["state"], "failed")
        self.assertEqual(manager._download_part(manifest).stat().st_size, 10)
        self.assertTrue(_resume_metadata_path(manager._download_part(manifest)).is_file())
        self.assertEqual(manager.install(manifest)["state"], "ready")
        self.assertEqual(calls, 2)
        self.assertFalse(manager._download_part(manifest).exists())

    def test_update_status_publish_cleanup_and_remove_cover_receipt_backed_versions(self) -> None:
        first = self.manager(downloader=self.copy_downloader)
        first_manifest = first.manifest_for("mineru")
        first.install(first_manifest)
        first_target = first.target_dir(first_manifest)

        second_mapping = {
            **self.mapping,
            "version": "test-2.0.0",
            "model_version": "test-model-2",
        }
        second = self.manager(downloader=self.copy_downloader, mapping=second_mapping)
        second_manifest = second.manifest_for("mineru")
        status = second.status(second_manifest)
        self.assertEqual(status["state"], "update_available")
        self.assertEqual(status["installed_version"], "test-1.0.0")
        self.assertTrue(status["update_available"])

        installed = second.install(second_manifest)
        self.assertEqual(installed["removed_versions"], ["test-1.0.0"])
        self.assertFalse(first_target.exists())
        self.assertEqual(second.status(second_manifest)["installed_version"], "test-2.0.0")

        second.remove(second_manifest)
        first.install(first_manifest)
        removed_by_new_catalog = second.remove(second_manifest)
        self.assertEqual(removed_by_new_catalog["removed_versions"], ["test-1.0.0"])
        self.assertFalse(first_target.exists())

    def test_update_cleanup_failure_is_reported_and_retried_by_status(self) -> None:
        first = self.manager(downloader=self.copy_downloader)
        first_manifest = first.manifest_for("mineru")
        first.install(first_manifest)
        first_target = first.target_dir(first_manifest)
        second = self.manager(
            downloader=self.copy_downloader,
            mapping={**self.mapping, "version": "test-2.0.0", "model_version": "test-model-2"},
        )
        second_manifest = second.manifest_for("mineru")
        with patch("component_manager.shutil.rmtree", side_effect=OSError("busy")):
            installed = second.install(second_manifest)
            self.assertEqual(installed["cleanup_pending_versions"], ["test-1.0.0"])
            status = second.status(second_manifest)
            self.assertTrue(status["cleanup_pending"])
            self.assertGreater(status["cleanup_pending_bytes"], 0)
        recovered = second.status(second_manifest)
        self.assertFalse(recovered["cleanup_pending"])
        self.assertFalse(first_target.exists())

    def test_default_downloader_uses_range_and_safely_restarts_when_ignored(self) -> None:
        manifest = ComponentManifest.from_mapping({
            **self.mapping,
            "archive_size": 6,
            "installed_size": 64,
            "sha256": hashlib.sha256(b"abcdef").hexdigest(),
        })
        destination = self.root / "resume.part"
        destination.write_bytes(b"abc")
        _resume_metadata_path(destination).write_text(json.dumps({
            "url": manifest.url, "sha256": manifest.sha256, "archive_size": 6, "etag": '"v1"',
        }), encoding="utf-8")
        requests = []

        def resumed(request, timeout=0):
            requests.append(request)
            return FakeResponse(b"def", status=206, headers={"Content-Range": "bytes 3-5/6", "ETag": '"v1"'})

        with patch("component_manager._open_https", side_effect=resumed):
            _default_downloader(manifest, destination, lambda *_args: None, threading.Event())
        self.assertEqual(destination.read_bytes(), b"abcdef")
        self.assertEqual(requests[0].get_header("Range"), "bytes=3-")
        self.assertEqual(requests[0].get_header("If-range"), '"v1"')

        destination.write_bytes(b"abc")
        with patch("component_manager._open_https", return_value=FakeResponse(b"abcdef", status=200, headers={})):
            _default_downloader(manifest, destination, lambda *_args: None, threading.Event())
        self.assertEqual(destination.read_bytes(), b"abcdef")

    def test_https_redirect_handler_rejects_downgrade_before_following(self) -> None:
        handler = _HTTPSOnlyRedirectHandler()
        request = urllib.request.Request(FAKE_URL)
        with self.assertRaisesRegex(ComponentError, "HTTPS"):
            handler.redirect_request(request, None, 302, "Found", {}, "http://example.invalid/mineru.zip")

    def test_unsafe_archive_and_signature_failure_never_publish(self) -> None:
        make_zip(self.archive, {"../escaped": b"unsafe", "bin/mineru": FAKE_MACHO})
        mapping = manifest_mapping(self.archive)
        manager = self.manager(downloader=self.copy_downloader, mapping=mapping)
        manifest = manager.manifest_for("mineru")
        with self.assertRaisesRegex(ComponentError, "路径越界"):
            manager.install(manifest)
        self.assertFalse((self.root / "escaped").exists())
        self.assertFalse(manager.target_dir(manifest).exists())

        make_zip(self.archive, {"bin/mineru": FAKE_MACHO})
        mapping = manifest_mapping(self.archive)
        manager = self.manager(
            downloader=self.copy_downloader,
            mapping=mapping,
            signature_verifier=lambda _path, _manifest: "wrong team",
        )
        manifest = manager.manifest_for("mineru")
        with self.assertRaisesRegex(ComponentError, "签名验证失败"):
            manager.install(manifest)
        self.assertFalse(manager.target_dir(manifest).exists())

    def test_remove_rejects_symlink_target(self) -> None:
        manager = self.manager(downloader=self.copy_downloader)
        manifest = manager.manifest_for("mineru")
        target = manager.target_dir(manifest)
        outside = self.root / "outside"
        outside.mkdir()
        target.parent.mkdir(parents=True)
        os.symlink(outside, target)
        with self.assertRaisesRegex(ComponentError, "符号链接"):
            manager.remove(manifest)
        self.assertTrue(outside.is_dir())
        target.unlink()
        target.mkdir()
        (target / "user-file.txt").write_text("not managed", encoding="utf-8")
        with self.assertRaisesRegex(ComponentError, "安装凭据"):
            manager.remove(manifest)
        self.assertTrue((target / "user-file.txt").is_file())

    def test_remove_wraps_atomic_rename_failure_and_keeps_component_ready(self) -> None:
        manager = self.manager(downloader=self.copy_downloader)
        manifest = manager.manifest_for("mineru")
        manager.install(manifest)
        target = manager.target_dir(manifest)
        with patch("component_manager.os.replace", side_effect=OSError("rename failed")):
            with self.assertRaisesRegex(ComponentError, "卸载失败") as raised:
                manager.remove(manifest)
        self.assertEqual(raised.exception.code, "remove_failed")
        self.assertTrue(target.is_dir())
        self.assertEqual(manager.status(manifest)["state"], "ready")

    def test_remove_atomically_renames_and_recovers_stale_trash(self) -> None:
        manager = self.manager(downloader=self.copy_downloader)
        manifest = manager.manifest_for("mineru")
        manager.install(manifest)
        target = manager.target_dir(manifest)
        with patch("component_manager.shutil.rmtree", side_effect=OSError("busy")):
            with self.assertRaisesRegex(ComponentError, "临时卸载目录"):
                manager.remove(manifest)
            self.assertFalse(target.exists())
            failed = manager.status(manifest)
            self.assertEqual(failed["state"], "failed")
            self.assertEqual(failed["reason_code"], "remove_cleanup_failed")
            self.assertTrue(failed["cleanup_pending"])
            trash = list(target.parent.glob(".trash-darwin-arm64-*"))
            self.assertEqual(len(trash), 1)
            self.assertTrue((trash[0] / "component.json").is_file())

        self.assertFalse(manager.status(manifest)["cleanup_pending"])
        result = manager.remove(manifest)
        self.assertFalse(result["removed"])
        self.assertEqual(result["cleaned_stale"], 0)
        self.assertFalse(trash[0].exists())


if __name__ == "__main__":
    unittest.main()
