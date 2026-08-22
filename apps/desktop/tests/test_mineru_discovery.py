from __future__ import annotations

import stat
import sys
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from mineru_discovery import clear_discovery_cache, discover_mineru, discover_mineru_candidates, scan_mineru  # noqa: E402


def write_mineru(path: Path, *, interpreter: str = sys.executable) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        f"#!{interpreter}\n"
        "import sys\n"
        "print('mineru, version test-1.0' if '--version' in sys.argv else 'Usage: mineru')\n",
        encoding="utf-8",
    )
    path.chmod(path.stat().st_mode | stat.S_IXUSR)


class MineruDiscoveryTest(unittest.TestCase):
    def tearDown(self) -> None:
        clear_discovery_cache()

    def test_shared_apps_desktop_layout_discovers_workspace_toolchain(self) -> None:
        with tempfile.TemporaryDirectory(prefix="guzi-mineru-discovery-") as temp:
            workspace = Path(temp)
            project = workspace / "guzi-scholar" / "apps" / "desktop"
            executable = workspace / "pdf-tools" / "envs" / "mineru" / "bin" / "mineru"
            project.mkdir(parents=True)
            write_mineru(executable)
            candidate, failure = discover_mineru(project_root=project, env={})
            self.assertIsNone(failure)
            self.assertEqual(candidate.executable, executable.resolve())
            self.assertEqual(candidate.source, "development-toolchain")
            self.assertEqual(candidate.version, "mineru, version test-1.0")

    def test_packaged_mode_requires_an_explicit_user_selection(self) -> None:
        with tempfile.TemporaryDirectory(prefix="guzi-mineru-packaged-") as temp:
            executable = Path(temp) / "mineru"
            write_mineru(executable)
            candidate, failure = discover_mineru(
                project_root=Path(temp),
                env={"MY_SCHOLAR_PACKAGED": "1", "PATH": str(executable.parent)},
            )
            self.assertIsNone(candidate)
            self.assertEqual(failure, "未选择外部版面引擎")
            selected, failure = discover_mineru(explicit_path=executable, env={"MY_SCHOLAR_PACKAGED": "1"})
            self.assertIsNone(failure)
            self.assertEqual(selected.executable, executable.resolve())

    def test_stale_shebang_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory(prefix="guzi-mineru-stale-") as temp:
            executable = Path(temp) / "mineru"
            write_mineru(executable, interpreter="/definitely/missing/mineru-python")
            candidate, failure = discover_mineru(explicit_path=executable)
            self.assertIsNone(candidate)
            self.assertIn("启动解释器不存在", failure)

    def test_explicit_packaged_scan_finds_workspace_toolchain(self) -> None:
        with tempfile.TemporaryDirectory(prefix="guzi-mineru-explicit-scan-") as temp:
            home = Path(temp)
            executable = home / "Desktop/Workspace/Scholar/pdf-tools/envs/mineru/bin/mineru"
            write_mineru(executable)
            result = scan_mineru(
                env={"MY_SCHOLAR_PACKAGED": "1", "PATH": ""},
                explicit_scan=True,
                home=home,
                system_roots=(),
            )
            self.assertEqual(result.state, "found")
            self.assertEqual(result.candidates[0].executable, executable.resolve())
            self.assertEqual(result.candidates[0].source, "user-search")
            self.assertEqual(result.to_dict()["candidate_count"], 1)

    def test_default_packaged_candidate_discovery_does_not_scan(self) -> None:
        with tempfile.TemporaryDirectory(prefix="guzi-mineru-default-packaged-") as temp:
            home = Path(temp)
            executable = home / "Desktop/Workspace/Scholar/pdf-tools/envs/mineru/bin/mineru"
            write_mineru(executable)
            candidates, diagnostics = discover_mineru_candidates(
                env={"MY_SCHOLAR_PACKAGED": "1", "PATH": ""},
                home=home,
                system_roots=(),
            )
            self.assertEqual(candidates, [])
            self.assertEqual(diagnostics, [])

    def test_automatic_discovery_uses_ttl_cache_and_explicit_invalidation(self) -> None:
        with tempfile.TemporaryDirectory(prefix="guzi-mineru-cache-") as temp:
            project = Path(temp) / "project"
            executable = project / "pdf-tools/envs/mineru/bin/mineru"
            project.mkdir(parents=True)
            write_mineru(executable)
            clock_value = [100.0]
            clock = lambda: clock_value[0]
            clear_discovery_cache()
            from unittest.mock import patch

            with patch("mineru_discovery.scan_mineru", wraps=scan_mineru) as scan:
                first, first_failure = discover_mineru(project_root=project, env={}, cache_ttl_seconds=10, clock=clock)
                second, second_failure = discover_mineru(project_root=project, env={}, cache_ttl_seconds=10, clock=clock)
                self.assertIsNone(first_failure)
                self.assertIsNone(second_failure)
                self.assertEqual(first.executable, second.executable)
                self.assertEqual(scan.call_count, 1)

                clock_value[0] += 11
                discover_mineru(project_root=project, env={}, cache_ttl_seconds=10, clock=clock)
                self.assertEqual(scan.call_count, 2)

                clear_discovery_cache()
                discover_mineru(project_root=project, env={}, cache_ttl_seconds=10, clock=clock)
                self.assertEqual(scan.call_count, 3)

    def test_explicit_scan_reports_multiple_path_and_known_environment_candidates(self) -> None:
        with tempfile.TemporaryDirectory(prefix="guzi-mineru-multiple-") as temp:
            home = Path(temp)
            path_executable = home / "path-bin/mineru"
            conda_executable = home / ".conda/envs/papers/bin/mineru"
            write_mineru(path_executable)
            write_mineru(conda_executable)
            result = scan_mineru(
                env={"MY_SCHOLAR_PACKAGED": "1", "PATH": str(path_executable.parent)},
                explicit_scan=True,
                home=home,
                scan_roots=(),
                system_roots=(),
            )
            self.assertEqual(result.state, "multiple")
            self.assertEqual(len(result.candidates), 2)
            self.assertEqual({candidate.source for candidate in result.candidates}, {"path", "known-environment"})

    def test_explicit_scan_does_not_follow_directory_or_executable_symlinks(self) -> None:
        with tempfile.TemporaryDirectory(prefix="guzi-mineru-symlink-") as temp:
            home = Path(temp)
            outside = home / "outside"
            linked_executable = outside / "env/bin/mineru"
            write_mineru(linked_executable)
            desktop = home / "Desktop"
            desktop.mkdir()
            (desktop / "linked-env").symlink_to(outside / "env", target_is_directory=True)
            direct = home / "path-bin/mineru"
            direct.parent.mkdir()
            direct.symlink_to(linked_executable)
            result = scan_mineru(
                env={"MY_SCHOLAR_PACKAGED": "1", "PATH": str(direct.parent)},
                explicit_scan=True,
                home=home,
                system_roots=(),
            )
            self.assertEqual(result.state, "not_found")
            self.assertTrue(any("符号链接" in item["reason"] for item in result.diagnostics))

    def test_explicit_scan_honors_directory_candidate_and_time_limits(self) -> None:
        with tempfile.TemporaryDirectory(prefix="guzi-mineru-limits-") as temp:
            home = Path(temp)
            first = home / "Desktop/a/bin/mineru"
            second = home / "Desktop/b/bin/mineru"
            write_mineru(first)
            write_mineru(second)
            limited = scan_mineru(
                env={"MY_SCHOLAR_PACKAGED": "1", "PATH": ""},
                explicit_scan=True,
                home=home,
                system_roots=(),
                max_candidates=1,
            )
            self.assertEqual(limited.state, "found")
            self.assertTrue(limited.truncated)

            directory_limited = scan_mineru(
                env={"MY_SCHOLAR_PACKAGED": "1", "PATH": ""},
                explicit_scan=True,
                home=home,
                system_roots=(),
                max_directories=1,
            )
            self.assertEqual(directory_limited.state, "not_found")
            self.assertTrue(directory_limited.truncated)

            timed_out = scan_mineru(
                env={"MY_SCHOLAR_PACKAGED": "1", "PATH": ""},
                explicit_scan=True,
                home=home,
                system_roots=(),
                timeout_seconds=0,
            )
            self.assertEqual(timed_out.state, "not_found")
            self.assertTrue(timed_out.timed_out)
            self.assertTrue(timed_out.truncated)

    def test_validation_uses_a_fresh_budget_after_enumeration_times_out(self) -> None:
        with tempfile.TemporaryDirectory(prefix="guzi-mineru-validation-budget-") as temp:
            home = Path(temp)
            executable = home / "path-bin/mineru"
            write_mineru(executable)
            result = scan_mineru(
                env={"MY_SCHOLAR_PACKAGED": "1", "PATH": str(executable.parent)},
                explicit_scan=True,
                home=home,
                system_roots=(),
                timeout_seconds=0,
                validation_timeout_seconds=3,
            )
            self.assertEqual(result.state, "found")
            self.assertEqual(result.candidates[0].version, "mineru, version test-1.0")
            self.assertTrue(result.timed_out)

    def test_scan_prunes_dependency_trees_but_keeps_virtual_environments(self) -> None:
        with tempfile.TemporaryDirectory(prefix="guzi-mineru-pruning-") as temp:
            home = Path(temp)
            project = home / "Desktop/Workspace/project"
            ignored = project / "node_modules/tool/bin/mineru"
            valid = project / ".venv/bin/mineru"
            write_mineru(ignored)
            write_mineru(valid)
            for index in range(20):
                (project / ".venv/lib/python/site-packages" / f"package-{index}" / "nested").mkdir(parents=True)
            result = scan_mineru(
                env={"MY_SCHOLAR_PACKAGED": "1", "PATH": ""},
                explicit_scan=True,
                home=home,
                system_roots=(),
                max_directories=8,
            )
            self.assertEqual(result.state, "found")
            self.assertEqual(result.candidates[0].executable, valid.resolve())
            self.assertNotIn(ignored.resolve(), {candidate.executable for candidate in result.candidates})

    def test_focused_workspace_root_is_scanned_before_wide_desktop(self) -> None:
        with tempfile.TemporaryDirectory(prefix="guzi-mineru-priority-") as temp:
            home = Path(temp)
            desktop = home / "Desktop"
            for index in range(20):
                (desktop / f"archive-{index:02d}" / "nested").mkdir(parents=True)
            executable = desktop / "Workspace/Scholar/pdf-tools/envs/mineru/bin/mineru"
            write_mineru(executable)
            result = scan_mineru(
                env={"MY_SCHOLAR_PACKAGED": "1", "PATH": ""},
                explicit_scan=True,
                home=home,
                system_roots=(),
                max_directories=7,
            )
            self.assertEqual(result.state, "found")
            self.assertEqual(result.candidates[0].executable, executable.resolve())
            self.assertTrue(result.truncated)


if __name__ == "__main__":
    unittest.main()
