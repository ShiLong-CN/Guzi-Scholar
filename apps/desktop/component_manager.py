"""Install versioned, application-managed parsing components safely."""

from __future__ import annotations

import hashlib
import json
import os
import platform as platform_module
import re
import shutil
import stat
import subprocess
import sys
import tarfile
import tempfile
import threading
import urllib.request
import uuid
import zipfile
from dataclasses import asdict, dataclass
from pathlib import Path, PurePosixPath
from typing import Any, Callable, Dict, Mapping, Optional
from urllib.parse import urlsplit

from mineru_discovery import MineruCandidate, clear_discovery_cache, discover_mineru


CATALOG_SCHEMA_VERSION = 1
MANIFEST_SCHEMA_VERSION = 1
MAX_ARCHIVE_FILES = 100_000
MAX_MANAGED_VERSIONS = 128
DOWNLOAD_CHUNK_BYTES = 1024 * 1024
SAFE_TOKEN_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")
SHA256_RE = re.compile(r"^[a-f0-9]{64}$")
SIGNATURE_POLICIES = {"developer-id-notarized", "adhoc-sha256"}

# No distributable MinerU artifact has been approved yet. Keep the target and
# requirements explicit without shipping a URL or implying release readiness.
PRODUCTION_COMPONENT_CATALOG: Dict[str, Any] = {
    "schema_version": CATALOG_SCHEMA_VERSION,
    "components": {
        "mineru": {
            "version": "unpublished",
            "model_version": "unpublished",
            "install_help_url": "https://github.com/opendatalab/MinerU/blob/mineru-3.4.5-released/docs/zh/quick_start/index.md",
            "requirements": {
                "platform": "darwin",
                "arch": "arm64",
                "min_os_version": "14.0",
                "min_memory_bytes": 16 * 1024**3,
                "min_free_disk_bytes": 20 * 1024**3,
            },
            "artifacts": {},
        }
    },
}


class ComponentError(RuntimeError):
    def __init__(self, message: str, *, code: str, details: Optional[Mapping[str, Any]] = None) -> None:
        super().__init__(message)
        self.code = code
        self.details = dict(details or {})


class ComponentCancelled(ComponentError):
    def __init__(self, message: str = "组件安装已取消。") -> None:
        super().__init__(message, code="cancelled")


@dataclass(frozen=True)
class SystemInfo:
    platform: str
    arch: str
    os_version: str
    memory_bytes: int
    free_disk_bytes: int


@dataclass(frozen=True)
class ComponentManifest:
    schema_version: int
    component: str
    version: str
    model_version: str
    platform: str
    arch: str
    archive_type: str
    archive_size: int
    installed_size: int
    sha256: str
    url: str
    source: str
    executable: str
    health_check_args: tuple[str, ...]
    min_os_version: str
    min_memory_bytes: int
    min_free_disk_bytes: int
    signing_identity: str
    team_id: str
    signature_policy: str = "developer-id-notarized"
    local_only: bool = False

    @classmethod
    def from_mapping(cls, value: Mapping[str, Any]) -> "ComponentManifest":
        if not isinstance(value, Mapping):
            raise ComponentError("组件清单必须是对象。", code="invalid_manifest")
        required = {
            "schema_version", "component", "version", "model_version", "platform", "arch",
            "archive_type", "archive_size", "installed_size", "sha256", "url", "source",
            "executable", "health_check_args", "min_os_version", "min_memory_bytes", "min_free_disk_bytes",
        }
        missing = sorted(required - set(value))
        if missing:
            raise ComponentError("组件清单缺少字段：" + "、".join(missing), code="invalid_manifest")
        try:
            manifest = cls(
                schema_version=int(value["schema_version"]),
                component=str(value["component"]),
                version=str(value["version"]),
                model_version=str(value["model_version"]),
                platform=_normalize_platform(str(value["platform"])),
                arch=_normalize_arch(str(value["arch"])),
                archive_type=str(value["archive_type"]).lower(),
                archive_size=int(value["archive_size"]),
                installed_size=int(value["installed_size"]),
                sha256=str(value["sha256"]).lower(),
                url=str(value["url"]),
                source=str(value["source"]),
                executable=str(value["executable"]),
                health_check_args=tuple(str(item) for item in value["health_check_args"]),
                min_os_version=str(value["min_os_version"]),
                min_memory_bytes=int(value["min_memory_bytes"]),
                min_free_disk_bytes=int(value["min_free_disk_bytes"]),
                signing_identity=str(value.get("signing_identity") or ""),
                team_id=str(value.get("team_id") or ""),
                signature_policy=str(value.get("signature_policy") or "developer-id-notarized"),
                local_only=value.get("local_only") is True,
            )
        except (TypeError, ValueError) as exc:
            raise ComponentError("组件清单字段类型无效。", code="invalid_manifest") from exc
        manifest.validate()
        return manifest

    def validate(self) -> None:
        if self.schema_version != MANIFEST_SCHEMA_VERSION:
            raise ComponentError("不支持的组件清单版本。", code="invalid_manifest")
        for name, value in {
            "component": self.component,
            "version": self.version,
            "model_version": self.model_version,
            "platform": self.platform,
            "arch": self.arch,
        }.items():
            if not SAFE_TOKEN_RE.fullmatch(value):
                raise ComponentError(f"组件清单的 {name} 无效。", code="invalid_manifest")
        if self.archive_type not in {"zip", "tar.gz"}:
            raise ComponentError("组件压缩格式只能是 zip 或 tar.gz。", code="invalid_manifest")
        if self.archive_size <= 0 or self.installed_size <= 0:
            raise ComponentError("组件大小必须大于零。", code="invalid_manifest")
        if not SHA256_RE.fullmatch(self.sha256):
            raise ComponentError("组件 SHA-256 无效。", code="invalid_manifest")
        if not self.local_only:
            _validate_https_url(self.url)
        if not self.source.strip():
            raise ComponentError("组件来源不能为空。", code="invalid_manifest")
        _safe_relative_path(self.executable, field="executable")
        if not self.health_check_args or self.health_check_args[0] != "--self-test":
            raise ComponentError("组件必须提供固定的离线 --self-test 健康检查。", code="invalid_manifest")
        if len(self.health_check_args) > 8 or any(not value or len(value) > 160 or "\x00" in value for value in self.health_check_args):
            raise ComponentError("组件健康检查参数无效。", code="invalid_manifest")
        if not re.fullmatch(r"\d+(?:\.\d+){0,3}", self.min_os_version):
            raise ComponentError("最低系统版本格式无效。", code="invalid_manifest")
        if self.min_memory_bytes <= 0 or self.min_free_disk_bytes <= 0:
            raise ComponentError("组件系统要求必须大于零。", code="invalid_manifest")
        if self.platform == "darwin":
            if self.signature_policy not in SIGNATURE_POLICIES:
                raise ComponentError("macOS 组件签名策略无效。", code="invalid_manifest")
            if self.signature_policy == "developer-id-notarized" and (
                not self.signing_identity.strip() or not re.fullmatch(r"[A-Z0-9]{10}", self.team_id)
            ):
                raise ComponentError("macOS 组件必须固定签名身份和 Team ID。", code="invalid_manifest")
            if self.signature_policy == "adhoc-sha256" and (self.signing_identity or self.team_id):
                raise ComponentError("ad-hoc 组件不能声明 Developer ID 或 Team ID。", code="invalid_manifest")

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)


class _CombinedCancelEvent:
    def __init__(self, *events: Any) -> None:
        self.events = tuple(event for event in events if event is not None)

    def is_set(self) -> bool:
        return any(bool(event.is_set()) for event in self.events)


ProgressCallback = Callable[[str, float], None]
DownloadCallback = Callable[[ComponentManifest, Path, Callable[[int, int], None], Any], None]
SystemProbe = Callable[[Path], SystemInfo]
SignatureVerifier = Callable[[Path, ComponentManifest], Optional[str]]
ExecutableHealthCheck = Callable[[Path, ComponentManifest], Optional[str]]


def _normalize_platform(value: str) -> str:
    candidate = str(value or "").strip().lower()
    return {"macos": "darwin", "mac": "darwin", "win32": "windows"}.get(candidate, candidate)


def _normalize_arch(value: str) -> str:
    candidate = str(value or "").strip().lower()
    return {"aarch64": "arm64", "amd64": "x64", "x86_64": "x64"}.get(candidate, candidate)


def _version_tuple(value: str) -> tuple[int, ...]:
    return tuple(int(part) for part in str(value).split("."))


def _validate_https_url(value: str) -> None:
    try:
        parsed = urlsplit(str(value))
    except ValueError as exc:
        raise ComponentError("组件下载地址无效。", code="invalid_manifest") from exc
    if parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password:
        raise ComponentError("组件只能从无内嵌凭据的 HTTPS 地址下载。", code="insecure_download_url")


def _safe_relative_path(value: str, *, field: str = "path") -> PurePosixPath:
    text = str(value or "")
    if not text or "\\" in text or "\x00" in text:
        raise ComponentError(f"组件 {field} 路径无效。", code="unsafe_archive")
    path = PurePosixPath(text)
    if path.is_absolute() or any(part in {"", ".", ".."} for part in path.parts):
        raise ComponentError(f"组件 {field} 路径越界。", code="unsafe_archive")
    return path


def _is_macho_executable(path: Path) -> bool:
    try:
        with path.open("rb") as stream:
            magic = stream.read(4)
    except OSError:
        return False
    return magic in {
        b"\xfe\xed\xfa\xce", b"\xce\xfa\xed\xfe",
        b"\xfe\xed\xfa\xcf", b"\xcf\xfa\xed\xfe",
        b"\xca\xfe\xba\xbe", b"\xbe\xba\xfe\xca",
        b"\xca\xfe\xba\xbf", b"\xbf\xba\xfe\xca",
    }


def _component_runtime_root(executable: Path, manifest: ComponentManifest) -> Path:
    root = Path(executable).resolve()
    for _part in _safe_relative_path(manifest.executable, field="executable").parts:
        root = root.parent
    return root


def _isolated_component_environment(
    runtime_root: Path,
    cache_root: Path,
    temp_root: Path,
    runtime_bin: Optional[Path] = None,
) -> Dict[str, str]:
    environment = dict(os.environ)
    for key in ("CONDA_PREFIX", "PYTHONHOME", "PYTHONPATH", "VIRTUAL_ENV"):
        environment.pop(key, None)
    executable_directory = runtime_bin or runtime_root / "bin"
    environment.update({
        "PATH": f"{executable_directory}:/usr/bin:/bin:/usr/sbin:/sbin",
        "PYTHONNOUSERSITE": "1",
        "HF_HUB_OFFLINE": "1",
        "HF_DATASETS_OFFLINE": "1",
        "TRANSFORMERS_OFFLINE": "1",
        "HF_HOME": str(cache_root / "huggingface"),
        "MODELSCOPE_CACHE": str(cache_root / "modelscope"),
        "XDG_CACHE_HOME": str(cache_root),
        "TMPDIR": str(temp_root),
        "MY_SCHOLAR_MINERU_COMPONENT_ROOT": str(runtime_root),
    })
    return environment


def _memory_bytes() -> int:
    try:
        pages = int(os.sysconf("SC_PHYS_PAGES"))
        page_size = int(os.sysconf("SC_PAGE_SIZE"))
        return max(0, pages * page_size)
    except (AttributeError, OSError, TypeError, ValueError):
        return 0


def default_system_probe(root: Path) -> SystemInfo:
    root = Path(root)
    root.mkdir(parents=True, exist_ok=True)
    if sys.platform == "darwin":
        os_version = platform_module.mac_ver()[0] or "0"
    else:
        os_version = platform_module.release().split("-")[0] or "0"
    return SystemInfo(
        platform=_normalize_platform(sys.platform),
        arch=_normalize_arch(platform_module.machine()),
        os_version=os_version,
        memory_bytes=_memory_bytes(),
        free_disk_bytes=int(shutil.disk_usage(root).free),
    )


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        while True:
            chunk = stream.read(DOWNLOAD_CHUNK_BYTES)
            if not chunk:
                break
            digest.update(chunk)
    return digest.hexdigest()


def _resume_metadata_path(destination: Path) -> Path:
    return destination.with_name(destination.name + ".json")


def _write_json_atomic(path: Path, value: Mapping[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.{uuid.uuid4().hex}.tmp")
    try:
        with temporary.open("w", encoding="utf-8") as stream:
            json.dump(dict(value), stream, ensure_ascii=False, indent=2)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def _default_signature_verifier(executable: Path, manifest: ComponentManifest) -> Optional[str]:
    if manifest.platform != "darwin":
        return None
    file_tool = Path("/usr/bin/file")
    codesign = Path("/usr/bin/codesign")
    spctl = Path("/usr/sbin/spctl")
    if not file_tool.is_file() or not codesign.is_file():
        return "系统缺少 file 或 codesign，无法验证组件架构与签名"
    if manifest.signature_policy == "developer-id-notarized" and not spctl.is_file():
        return "系统缺少 spctl，无法验证组件公证"
    try:
        architecture = subprocess.run(
            [str(file_tool), "-b", str(executable)],
            stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, encoding="utf-8",
            errors="replace", check=False, timeout=30,
        )
        if architecture.returncode != 0 or manifest.arch not in str(architecture.stdout or "").lower():
            return (architecture.stdout or f"组件不包含 {manifest.arch} 架构").strip()[-500:]
        verified = subprocess.run(
            [str(codesign), "--verify", "--deep", "--strict", "--verbose=2", str(executable)],
            stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, encoding="utf-8",
            errors="replace", check=False, timeout=30,
        )
        if verified.returncode != 0:
            return (verified.stdout or "codesign verify failed").strip()[-500:]
        details = subprocess.run(
            [str(codesign), "-dv", "--verbose=4", str(executable)],
            stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, encoding="utf-8",
            errors="replace", check=False, timeout=30,
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        return str(exc)
    output = details.stdout or ""
    if details.returncode != 0:
        return output.strip()[-500:] or "无法读取组件签名信息"
    if manifest.signature_policy == "adhoc-sha256":
        if "Signature=adhoc" not in output or "TeamIdentifier=not set" not in output:
            return "组件不是无 Team ID 的 ad-hoc 签名"
        return None
    if f"TeamIdentifier={manifest.team_id}" not in output:
        return "组件签名 Team ID 与清单不一致"
    authorities = [line.split("=", 1)[1].strip() for line in output.splitlines() if line.startswith("Authority=")]
    if manifest.signing_identity not in authorities:
        return "组件签名身份与清单不一致"
    try:
        assessment = subprocess.run(
            [str(spctl), "--assess", "--type", "execute", "--verbose=4", str(executable)],
            stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, encoding="utf-8",
            errors="replace", check=False, timeout=30,
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        return str(exc)
    if assessment.returncode != 0:
        return (assessment.stdout or "组件未通过 macOS 公证评估").strip()[-500:]
    return None


def _default_executable_health_check(executable: Path, manifest: ComponentManifest) -> Optional[str]:
    executable = Path(executable).resolve()
    runtime_root = _component_runtime_root(executable, manifest)
    try:
        with tempfile.TemporaryDirectory(prefix=".self-test-", dir=str(runtime_root)) as temp:
            temp_root = Path(temp)
            completed = subprocess.run(
                [str(executable), *manifest.health_check_args], stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                text=True, encoding="utf-8", errors="replace", check=False, timeout=120,
                cwd=str(runtime_root),
                env=_isolated_component_environment(runtime_root, temp_root / "cache", temp_root, executable.parent),
            )
    except (OSError, subprocess.TimeoutExpired) as exc:
        return str(exc)
    if completed.returncode != 0:
        return f"健康检查退出码 {completed.returncode}"
    return None


class _HTTPSOnlyRedirectHandler(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req: Any, fp: Any, code: int, msg: str, headers: Any, newurl: str) -> Any:
        _validate_https_url(newurl)
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def _open_https(request: urllib.request.Request, *, timeout: int) -> Any:
    _validate_https_url(request.full_url)
    opener = urllib.request.build_opener(_HTTPSOnlyRedirectHandler())
    return opener.open(request, timeout=timeout)


def _default_downloader(
    manifest: ComponentManifest,
    destination: Path,
    on_bytes: Callable[[int, int], None],
    cancel_event: Any,
) -> None:
    metadata_path = _resume_metadata_path(destination)
    for attempt in range(2):
        offset = destination.stat().st_size if destination.is_file() else 0
        metadata: Dict[str, Any] = {}
        try:
            if metadata_path.is_file():
                loaded = json.loads(metadata_path.read_text(encoding="utf-8"))
                metadata = dict(loaded) if isinstance(loaded, Mapping) else {}
        except (OSError, json.JSONDecodeError):
            metadata = {}
        headers = {"User-Agent": "Guzi-Scholar-Component-Manager/1"}
        if offset:
            headers["Range"] = f"bytes={offset}-"
            if metadata.get("etag"):
                headers["If-Range"] = str(metadata["etag"])
        request = urllib.request.Request(manifest.url, headers=headers)
        try:
            with _open_https(request, timeout=60) as response:
                _validate_https_url(response.geturl())
                response_status = getattr(response, "status", None)
                status = int(response_status if response_status is not None else response.getcode())
                content_range = str(response.headers.get("Content-Range") or "")
                resumed = offset > 0 and status == 206 and content_range.startswith(f"bytes {offset}-")
                if offset and status == 206 and not resumed:
                    destination.unlink(missing_ok=True)
                    metadata_path.unlink(missing_ok=True)
                    if attempt == 0:
                        continue
                    raise ComponentError("下载源返回了无效的断点范围。", code="download_failed")
                if offset and status != 206:
                    # The source ignored Range or the object changed; restart
                    # from the same verified HTTPS response instead of appending.
                    offset = 0
                mode = "ab" if resumed else "wb"
                downloaded = offset
                etag = str(response.headers.get("ETag") or metadata.get("etag") or "")
                _write_json_atomic(metadata_path, {
                    "url": manifest.url,
                    "sha256": manifest.sha256,
                    "archive_size": manifest.archive_size,
                    "etag": etag,
                })
                with destination.open(mode) as output:
                    while True:
                        if cancel_event.is_set():
                            raise ComponentCancelled()
                        chunk = response.read(DOWNLOAD_CHUNK_BYTES)
                        if not chunk:
                            break
                        output.write(chunk)
                        downloaded += len(chunk)
                        if downloaded > manifest.archive_size:
                            raise ComponentError("组件下载超过清单大小。", code="size_mismatch")
                        on_bytes(downloaded, manifest.archive_size)
                    output.flush()
                    os.fsync(output.fileno())
                return
        except ComponentError:
            raise
        except Exception as exc:
            raise ComponentError(f"组件下载失败：{exc}", code="download_failed") from exc
    raise ComponentError("组件下载无法安全恢复。", code="download_failed")


class ComponentManager:
    def __init__(
        self,
        root: Path,
        *,
        catalog: Optional[Mapping[str, Any]] = None,
        downloader: Optional[DownloadCallback] = None,
        system_probe: Optional[SystemProbe] = None,
        signature_verifier: Optional[SignatureVerifier] = None,
        executable_health_check: Optional[ExecutableHealthCheck] = None,
    ) -> None:
        self.root = Path(root).expanduser().resolve()
        self.root.mkdir(parents=True, exist_ok=True)
        self.catalog = dict(catalog if catalog is not None else PRODUCTION_COMPONENT_CATALOG)
        self.downloader = downloader or _default_downloader
        self.system_probe = system_probe or default_system_probe
        self.signature_verifier = signature_verifier or _default_signature_verifier
        self.executable_health_check = executable_health_check or _default_executable_health_check
        self._lock = threading.RLock()
        self._operation: Optional[Dict[str, Any]] = None
        self._last_outcome: Optional[Dict[str, Any]] = None
        self._validate_catalog()

    def _validate_catalog(self) -> None:
        if int(self.catalog.get("schema_version") or 0) != CATALOG_SCHEMA_VERSION:
            raise ComponentError("不支持的组件目录版本。", code="invalid_catalog")
        components = self.catalog.get("components")
        if not isinstance(components, Mapping):
            raise ComponentError("组件目录缺少 components。", code="invalid_catalog")

    def component_metadata(self, component: str) -> Dict[str, Any]:
        components = self.catalog.get("components")
        raw = components.get(component) if isinstance(components, Mapping) else None
        return dict(raw) if isinstance(raw, Mapping) else {}

    def _manifest_from_receipt(self, component: str, receipt: Mapping[str, Any]) -> ComponentManifest:
        metadata = self.component_metadata(component)
        requirements = metadata.get("requirements") if isinstance(metadata.get("requirements"), Mapping) else {}
        installed_bytes = max(1, int(receipt.get("installed_bytes") or 1))
        archive_sha256 = str(receipt.get("archive_sha256") or "").lower()
        payload = {
            "schema_version": MANIFEST_SCHEMA_VERSION,
            "component": receipt.get("component") or component,
            "version": receipt.get("version"),
            "model_version": receipt.get("model_version"),
            "platform": receipt.get("platform"),
            "arch": receipt.get("arch"),
            "archive_type": receipt.get("archive_type") or "zip",
            "archive_size": max(1, int(receipt.get("archive_size") or installed_bytes)),
            "installed_size": max(installed_bytes + 4 * 1024**2, int(receipt.get("installed_size") or 0), 1),
            "sha256": archive_sha256,
            "url": str(receipt.get("url") or ""),
            "source": receipt.get("source") or "本地导入组件",
            "executable": receipt.get("executable"),
            "health_check_args": receipt.get("health_check_args"),
            "min_os_version": receipt.get("min_os_version") or requirements.get("min_os_version") or "14.0",
            "min_memory_bytes": receipt.get("min_memory_bytes") or requirements.get("min_memory_bytes") or 1,
            "min_free_disk_bytes": receipt.get("min_free_disk_bytes") or requirements.get("min_free_disk_bytes") or 1,
            "signing_identity": receipt.get("signing_identity"),
            "team_id": receipt.get("team_id"),
            "signature_policy": receipt.get("signature_policy") or "developer-id-notarized",
            "local_only": True,
        }
        return ComponentManifest.from_mapping(payload)

    def _discovered_manifests(self, component: str) -> list[ComponentManifest]:
        component_root = self.root / component
        self._assert_managed_path(component_root, self.root)
        if not component_root.is_dir() or component_root.is_symlink():
            return []
        current_platform = _normalize_platform(sys.platform)
        current_arch = _normalize_arch(platform_module.machine())
        discovered: list[ComponentManifest] = []
        for index, version_root in enumerate(sorted(component_root.iterdir(), key=lambda item: item.name)):
            if index >= MAX_MANAGED_VERSIONS:
                break
            if version_root.is_symlink() or not version_root.is_dir() or not SAFE_TOKEN_RE.fullmatch(version_root.name):
                continue
            for target in sorted(version_root.iterdir(), key=lambda item: item.name):
                if target.is_symlink() or not target.is_dir() or target.name != f"{current_platform}-{current_arch}":
                    continue
                try:
                    receipt = json.loads((target / "component.json").read_text(encoding="utf-8"))
                    manifest = self._manifest_from_receipt(component, receipt)
                except (OSError, TypeError, ValueError, json.JSONDecodeError, ComponentError):
                    continue
                if manifest.version != version_root.name or manifest.platform != current_platform or manifest.arch != current_arch:
                    continue
                discovered.append(manifest)
        return sorted(discovered, key=lambda item: item.version)

    def discovery_status(self, component: str) -> Dict[str, Any]:
        manifests = self._discovered_manifests(component)
        return {
            "state": "found" if manifests else "not_found",
            "candidate_count": len(manifests),
            "versions": [manifest.version for manifest in manifests],
        }

    def operation_status(self, component: str) -> Optional[Dict[str, Any]]:
        with self._lock:
            operation = dict(self._operation) if self._operation and self._operation.get("component") == component else None
        if operation:
            operation.pop("cancel_event", None)
        return operation

    def last_outcome(self, component: str) -> Optional[Dict[str, Any]]:
        with self._lock:
            outcome = dict(self._last_outcome) if self._last_outcome and self._last_outcome.get("component") == component else None
        if outcome:
            outcome.pop("component", None)
        return outcome

    def _external_pointer_path(self, component: str) -> Path:
        pointer = self.root / component / "external.json"
        self._assert_managed_path(pointer, self.root)
        return pointer

    def external_candidate_status(
        self,
        component: str,
    ) -> tuple[Optional[MineruCandidate], Optional[Dict[str, Any]]]:
        pointer = self._external_pointer_path(component)
        if not pointer.exists() and not pointer.is_symlink():
            return None, None
        if pointer.is_symlink() or not pointer.is_file():
            return None, {
                "state": "external_invalid",
                "reason_code": "external_invalid",
                "message": "已保存的外部版面引擎记录无效，请重新选择。",
            }
        try:
            data = json.loads(pointer.read_text(encoding="utf-8"))
            if not isinstance(data, Mapping) or data.get("component") != component:
                raise ValueError("component mismatch")
            executable = str(data.get("executable") or "").strip()
            if not executable:
                raise ValueError("missing executable")
        except (OSError, TypeError, ValueError, json.JSONDecodeError):
            return None, {
                "state": "external_invalid",
                "reason_code": "external_invalid",
                "message": "已保存的外部版面引擎记录无法读取，请重新选择。",
            }
        candidate, failure = discover_mineru(explicit_path=executable)
        if not candidate:
            return None, {
                "state": "external_unhealthy",
                "reason_code": "external_unhealthy",
                "path": executable,
                "message": f"已选择的外部版面引擎不可用：{failure or '健康检查失败'}",
            }
        try:
            expected_sha = str(data.get("executable_sha256") or "")
            actual_sha = _sha256(candidate.executable)
        except OSError as exc:
            return None, {
                "state": "external_unhealthy",
                "reason_code": "external_unhealthy",
                "path": executable,
                "message": f"无法校验已选择的外部版面引擎：{exc}",
            }
        if expected_sha != actual_sha:
            return None, {
                "state": "external_changed",
                "reason_code": "external_changed",
                "path": executable,
                "message": "已选择的外部版面引擎发生变化，需要重新确认后才能使用。",
            }
        return candidate, {
            "state": "ready",
            "reason_code": "ready",
            "path": str(candidate.executable),
        }

    def external_candidate(self, component: str) -> Optional[MineruCandidate]:
        candidate, _status = self.external_candidate_status(component)
        return candidate

    def configure_external(self, component: str, executable: Path) -> MineruCandidate:
        candidate, failure = discover_mineru(explicit_path=executable)
        if not candidate:
            raise ComponentError(f"无法复用所选版面引擎：{failure or '健康检查失败'}", code="invalid_external_component")
        pointer = self._external_pointer_path(component)
        _write_json_atomic(pointer, {
            "schema_version": 1,
            "component": component,
            "executable": str(candidate.executable),
            "executable_sha256": _sha256(candidate.executable),
            "source": candidate.source,
            "version": candidate.version,
        })
        clear_discovery_cache()
        return candidate

    def clear_external(self, component: str) -> bool:
        pointer = self._external_pointer_path(component)
        if pointer.is_symlink():
            raise ComponentError("拒绝删除符号链接版面引擎指针。", code="unsafe_install_path")
        existed = pointer.is_file()
        if existed:
            pointer.unlink()
            clear_discovery_cache()
        return existed

    def manifest_for(self, component: str) -> Optional[ComponentManifest]:
        metadata = self.component_metadata(component)
        requirements = metadata.get("requirements")
        artifacts = metadata.get("artifacts")
        if not isinstance(requirements, Mapping) or not isinstance(artifacts, Mapping):
            return None
        key = f"{_normalize_platform(str(requirements.get('platform') or ''))}-{_normalize_arch(str(requirements.get('arch') or ''))}"
        artifact = artifacts.get(key)
        if not isinstance(artifact, Mapping):
            discovered = self._discovered_manifests(component)
            return discovered[-1] if discovered else None
        merged = {
            "schema_version": MANIFEST_SCHEMA_VERSION,
            "component": component,
            "version": metadata.get("version"),
            "model_version": metadata.get("model_version"),
            **dict(requirements),
            **dict(artifact),
        }
        return ComponentManifest.from_mapping(merged)

    def target_dir(self, manifest: ComponentManifest) -> Path:
        manifest.validate()
        return self.root / manifest.component / manifest.version / f"{manifest.platform}-{manifest.arch}"

    def executable_path(self, manifest: ComponentManifest) -> Path:
        target = self.target_dir(manifest)
        relative = _safe_relative_path(manifest.executable, field="executable")
        return target.joinpath(*relative.parts)

    def _download_part(self, manifest: ComponentManifest) -> Path:
        name = f".{manifest.component}-{manifest.version}-{manifest.platform}-{manifest.arch}.part"
        return self.root / ".downloads" / name

    def _assert_managed_path(self, path: Path, parent: Path) -> None:
        absolute = Path(os.path.abspath(path))
        managed = Path(os.path.abspath(parent))
        try:
            relative = absolute.relative_to(managed)
        except ValueError as exc:
            raise ComponentError("组件路径不在受管目录中。", code="unsafe_install_path") from exc
        current = managed
        if current.is_symlink():
            raise ComponentError("组件受管目录不能是符号链接。", code="unsafe_install_path")
        for part in relative.parts[:-1]:
            current = current / part
            if current.is_symlink():
                raise ComponentError("组件路径包含符号链接目录。", code="unsafe_install_path")

    def _remove_generated_path(self, path: Path, parent: Path) -> None:
        self._assert_managed_path(path, parent)
        if path.is_symlink():
            path.unlink(missing_ok=True)
        elif path.is_dir():
            shutil.rmtree(path)
        else:
            path.unlink(missing_ok=True)

    def _cleanup_abandoned(self, manifest: ComponentManifest) -> None:
        part = self._download_part(manifest)
        resume_metadata = _resume_metadata_path(part)
        keep_partial = False
        if part.is_file() and not part.is_symlink() and 0 < part.stat().st_size <= manifest.archive_size:
            try:
                metadata = json.loads(resume_metadata.read_text(encoding="utf-8"))
                keep_partial = isinstance(metadata, Mapping) and all([
                    metadata.get("url") == manifest.url,
                    metadata.get("sha256") == manifest.sha256,
                    int(metadata.get("archive_size") or 0) == manifest.archive_size,
                ])
            except (OSError, ValueError, json.JSONDecodeError):
                keep_partial = False
        if not keep_partial:
            for candidate in (part, resume_metadata):
                if candidate.exists() or candidate.is_symlink():
                    self._remove_generated_path(candidate, self.root / ".downloads")
        version_root = self.target_dir(manifest).parent
        self._assert_managed_path(version_root, self.root)
        if version_root.is_dir() and not version_root.is_symlink():
            pattern = f".staging-{manifest.platform}-{manifest.arch}-*"
            for candidate in version_root.glob(pattern):
                self._remove_generated_path(candidate, version_root)
            self._cleanup_stale_trash(manifest)

    @staticmethod
    def _receipt_identity_matches(
        directory: Path,
        manifest: ComponentManifest,
        *,
        expected_version: Optional[str] = None,
        expected_model_version: Optional[str] = None,
    ) -> bool:
        try:
            receipt = json.loads((directory / "component.json").read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return False
        identity = {
            "component": manifest.component,
            "version": expected_version if expected_version is not None else manifest.version,
            "platform": manifest.platform,
            "arch": manifest.arch,
        }
        if not isinstance(receipt, Mapping) or not all(receipt.get(key) == value for key, value in identity.items()):
            return False
        if expected_model_version is not None and receipt.get("model_version") != expected_model_version:
            return False
        try:
            schema_version = int(receipt.get("schema_version") or 0)
        except (TypeError, ValueError):
            return False
        if schema_version != 1:
            return False
        if not SAFE_TOKEN_RE.fullmatch(str(receipt.get("model_version") or "")):
            return False
        if not SHA256_RE.fullmatch(str(receipt.get("archive_sha256") or "")):
            return False
        if not SHA256_RE.fullmatch(str(receipt.get("executable_sha256") or "")):
            return False
        if receipt.get("health_check_args") != list(manifest.health_check_args):
            return False
        try:
            executable = _safe_relative_path(str(receipt.get("executable") or ""), field="executable")
        except ComponentError:
            return False
        if not directory.joinpath(*executable.parts).is_file():
            return False
        if manifest.platform == "darwin":
            signature_policy = str(receipt.get("signature_policy") or "developer-id-notarized")
            if signature_policy not in SIGNATURE_POLICIES:
                return False
            if signature_policy == "developer-id-notarized" and (
                not str(receipt.get("signing_identity") or "").strip()
                or not re.fullmatch(r"[A-Z0-9]{10}", str(receipt.get("team_id") or ""))
            ):
                return False
        return True

    def _managed_installs(self, manifest: ComponentManifest) -> list[Dict[str, Any]]:
        component_root = self.root / manifest.component
        self._assert_managed_path(component_root, self.root)
        if not component_root.is_dir() or component_root.is_symlink():
            return []
        installs: list[Dict[str, Any]] = []
        for index, version_root in enumerate(component_root.iterdir()):
            if index >= MAX_MANAGED_VERSIONS:
                break
            if version_root.is_symlink() or not version_root.is_dir() or not SAFE_TOKEN_RE.fullmatch(version_root.name):
                continue
            target = version_root / f"{manifest.platform}-{manifest.arch}"
            self._assert_managed_path(target, component_root)
            if target.is_symlink() or not target.is_dir():
                continue
            if not self._receipt_identity_matches(target, manifest, expected_version=version_root.name):
                continue
            try:
                receipt = json.loads((target / "component.json").read_text(encoding="utf-8"))
                installed_bytes = max(0, int(receipt.get("installed_bytes") or 0))
            except (OSError, TypeError, ValueError, json.JSONDecodeError):
                continue
            installs.append({
                "version": version_root.name,
                "model_version": str(receipt.get("model_version") or ""),
                "installed_bytes": installed_bytes,
                "target": target,
            })
        return installs

    def _cleanup_stale_trash(self, manifest: ComponentManifest) -> int:
        version_root = self.target_dir(manifest).parent
        self._assert_managed_path(version_root, self.root)
        if not version_root.is_dir() or version_root.is_symlink():
            return 0
        cleaned = 0
        pattern = f".trash-{manifest.platform}-{manifest.arch}-*"
        for candidate in version_root.glob(pattern):
            self._assert_managed_path(candidate, version_root)
            if candidate.is_symlink() or not candidate.is_dir():
                continue
            if not self._receipt_identity_matches(candidate, manifest, expected_version=version_root.name):
                continue
            shutil.rmtree(candidate)
            cleaned += 1
        return cleaned

    def _cleanup_all_stale_trash(self, manifest: ComponentManifest) -> int:
        component_root = self.root / manifest.component
        self._assert_managed_path(component_root, self.root)
        if not component_root.is_dir() or component_root.is_symlink():
            return 0
        cleaned = 0
        for index, version_root in enumerate(component_root.iterdir()):
            if index >= MAX_MANAGED_VERSIONS:
                break
            if version_root.is_symlink() or not version_root.is_dir() or not SAFE_TOKEN_RE.fullmatch(version_root.name):
                continue
            pattern = f".trash-{manifest.platform}-{manifest.arch}-*"
            for candidate in version_root.glob(pattern):
                self._assert_managed_path(candidate, version_root)
                if candidate.is_symlink() or not candidate.is_dir():
                    continue
                if not self._receipt_identity_matches(candidate, manifest, expected_version=version_root.name):
                    continue
                shutil.rmtree(candidate)
                cleaned += 1
        return cleaned

    def _stale_trash_summary(self, manifest: ComponentManifest) -> Dict[str, Any]:
        component_root = self.root / manifest.component
        self._assert_managed_path(component_root, self.root)
        if not component_root.is_dir() or component_root.is_symlink():
            return {"cleanup_pending": False, "cleanup_pending_bytes": 0}
        count = 0
        byte_count = 0
        for index, version_root in enumerate(component_root.iterdir()):
            if index >= MAX_MANAGED_VERSIONS:
                break
            if version_root.is_symlink() or not version_root.is_dir() or not SAFE_TOKEN_RE.fullmatch(version_root.name):
                continue
            for candidate in version_root.glob(f".trash-{manifest.platform}-{manifest.arch}-*"):
                self._assert_managed_path(candidate, version_root)
                if candidate.is_symlink() or not candidate.is_dir():
                    continue
                if not self._receipt_identity_matches(candidate, manifest, expected_version=version_root.name):
                    continue
                count += 1
                try:
                    receipt = json.loads((candidate / "component.json").read_text(encoding="utf-8"))
                    byte_count += max(0, int(receipt.get("installed_bytes") or 0))
                except (OSError, TypeError, ValueError, json.JSONDecodeError):
                    pass
        return {
            "cleanup_pending": count > 0,
            "cleanup_pending_count": count,
            "cleanup_pending_bytes": byte_count,
        }

    def _retire_obsolete_installs(self, manifest: ComponentManifest) -> Dict[str, list[str]]:
        removed: list[str] = []
        cleanup_pending: list[str] = []
        for install in self._managed_installs(manifest):
            version = str(install["version"])
            if version == manifest.version:
                continue
            target = Path(install["target"])
            version_root = target.parent
            if not self._receipt_identity_matches(target, manifest, expected_version=version):
                continue
            trash = version_root / f".trash-{manifest.platform}-{manifest.arch}-{uuid.uuid4().hex}"
            self._assert_managed_path(trash, version_root)
            try:
                os.replace(target, trash)
                removed.append(version)
            except OSError:
                cleanup_pending.append(version)
                continue
            try:
                shutil.rmtree(trash)
            except OSError:
                cleanup_pending.append(version)
            try:
                version_root.rmdir()
            except OSError:
                pass
        return {
            "removed_versions": sorted(set(removed)),
            "cleanup_pending_versions": sorted(set(cleanup_pending)),
        }

    def _system_failure(self, manifest: ComponentManifest, *, check_disk: bool) -> Optional[ComponentError]:
        info = self.system_probe(self.root)
        if info.platform != manifest.platform or info.arch != manifest.arch:
            return ComponentError(
                f"当前平台 {info.platform}-{info.arch} 不支持此组件。",
                code="unsupported_platform",
                details={"required": f"{manifest.platform}-{manifest.arch}", "actual": f"{info.platform}-{info.arch}"},
            )
        try:
            if _version_tuple(info.os_version) < _version_tuple(manifest.min_os_version):
                return ComponentError(
                    f"需要 macOS {manifest.min_os_version} 或更高版本。",
                    code="incompatible_os",
                    details={"required": manifest.min_os_version, "actual": info.os_version},
                )
        except ValueError:
            return ComponentError("无法确认当前系统版本。", code="incompatible_os")
        if info.memory_bytes < manifest.min_memory_bytes:
            return ComponentError(
                "内存不足，无法安装或运行版面引擎。",
                code="insufficient_memory",
                details={"required_bytes": manifest.min_memory_bytes, "available_bytes": info.memory_bytes},
            )
        required_disk = max(
            manifest.min_free_disk_bytes,
            manifest.archive_size + manifest.installed_size,
        )
        if check_disk and info.free_disk_bytes < required_disk:
            return ComponentError(
                "磁盘空间不足，无法安装版面引擎。",
                code="insufficient_disk",
                details={"required_bytes": required_disk, "available_bytes": info.free_disk_bytes},
            )
        return None

    def _installed_status(self, manifest: ComponentManifest, *, target: Optional[Path] = None) -> Optional[Dict[str, Any]]:
        managed_target = target is None
        target = self.target_dir(manifest) if target is None else Path(target).expanduser().resolve()
        if managed_target:
            try:
                self._assert_managed_path(target, self.root)
            except ComponentError as exc:
                return {"state": "corrupt", "reason_code": exc.code}
        if target.is_symlink():
            return {"state": "corrupt", "reason_code": "unsafe_install_path"}
        receipt_path = target / "component.json"
        executable = target.joinpath(*_safe_relative_path(manifest.executable, field="executable").parts)
        if target.exists() and not target.is_dir():
            return {"state": "corrupt", "reason_code": "install_path_conflict"}
        if not target.is_dir():
            return None
        if not receipt_path.is_file():
            return {"state": "corrupt", "reason_code": "invalid_receipt"}
        if not executable.is_file():
            return {"state": "corrupt", "reason_code": "missing_executable"}
        current = target
        while current != target.parent:
            if current.is_symlink():
                return {"state": "corrupt", "reason_code": "unsafe_install_path"}
            current = current.parent
        try:
            receipt = json.loads(receipt_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return {"state": "corrupt", "reason_code": "invalid_receipt"}
        expected = {
            "component": manifest.component,
            "version": manifest.version,
            "model_version": manifest.model_version,
            "platform": manifest.platform,
            "arch": manifest.arch,
            "archive_sha256": manifest.sha256,
            "executable": manifest.executable,
            "health_check_args": list(manifest.health_check_args),
            "signing_identity": manifest.signing_identity,
            "team_id": manifest.team_id,
        }
        if any(receipt.get(key) != value for key, value in expected.items()):
            return {"state": "corrupt", "reason_code": "receipt_mismatch"}
        if str(receipt.get("signature_policy") or "developer-id-notarized") != manifest.signature_policy:
            return {"state": "corrupt", "reason_code": "receipt_mismatch"}
        current = executable
        while current != target:
            if current.is_symlink():
                return {"state": "corrupt", "reason_code": "unsafe_install_path"}
            current = current.parent
        executable_sha256 = str(receipt.get("executable_sha256") or "")
        if not SHA256_RE.fullmatch(executable_sha256) or _sha256(executable) != executable_sha256:
            return {"state": "corrupt", "reason_code": "executable_checksum_mismatch"}
        return {
            "state": "ready",
            "reason_code": "ready",
            "installed_bytes": max(0, int(receipt.get("installed_bytes") or 0)),
            "executable": str(executable),
        }

    def status(self, manifest: ComponentManifest) -> Dict[str, Any]:
        with self._lock:
            operation = dict(self._operation) if self._operation else None
        if operation and operation.get("component") == manifest.component:
            operation.pop("cancel_event", None)
            return operation
        try:
            self._cleanup_all_stale_trash(manifest)
        except OSError:
            pass
        cleanup_summary = self._stale_trash_summary(manifest)
        managed_installs = self._managed_installs(manifest)
        installed_versions = sorted({str(item["version"]) for item in managed_installs})
        older_versions = [version for version in installed_versions if version != manifest.version]
        installed_summary = {
            "installed_version": installed_versions[-1] if installed_versions else None,
            "installed_versions": installed_versions,
            "target_version": manifest.version,
            "update_available": bool(installed_versions and manifest.version not in installed_versions),
            "installed_bytes": sum(int(item["installed_bytes"]) for item in managed_installs) + int(cleanup_summary["cleanup_pending_bytes"]),
            "managed_bytes": sum(int(item["installed_bytes"]) for item in managed_installs),
            **cleanup_summary,
        }
        installed = self._installed_status(manifest)
        if installed:
            if installed["state"] == "ready":
                failure = self._system_failure(manifest, check_disk=False)
                if failure:
                    return {
                        **installed_summary,
                        "state": failure.code,
                        "reason_code": failure.code,
                        "details": failure.details,
                    }
                return {
                    **installed_summary,
                    **installed,
                    "installed_version": manifest.version,
                    "target_version": manifest.version,
                    "update_available": False,
                    "obsolete_versions": older_versions,
                }
            return {**installed_summary, **installed}
        with self._lock:
            outcome = dict(self._last_outcome) if self._last_outcome else None
        if outcome and outcome.get("component") == manifest.component:
            outcome.pop("component", None)
            return {**installed_summary, **outcome}
        failure = self._system_failure(manifest, check_disk=True)
        if failure:
            return {
                **installed_summary,
                "state": failure.code,
                "reason_code": failure.code,
                "details": failure.details,
            }
        if installed_versions:
            return {
                **installed_summary,
                "state": "update_available",
                "reason_code": "update_available",
            }
        return {**installed_summary, "state": "not_installed", "reason_code": "not_installed"}

    def _set_operation(self, **fields: Any) -> None:
        with self._lock:
            if self._operation is not None:
                raise ComponentError("组件操作正在进行中。", code="busy")
            self._last_outcome = None
            self._operation = dict(fields)

    def _update_operation(self, **fields: Any) -> None:
        with self._lock:
            if self._operation is not None:
                self._operation.update(fields)

    def _clear_operation(self) -> None:
        with self._lock:
            self._operation = None

    def _record_outcome(self, outcome: Mapping[str, Any]) -> None:
        with self._lock:
            self._last_outcome = dict(outcome)

    def cancel_install(self) -> bool:
        with self._lock:
            operation = self._operation
            if not operation or operation.get("state") != "installing":
                return False
            cancel_event = operation.get("cancel_event")
            if cancel_event is None:
                return False
            cancel_event.set()
            operation["state"] = "cancelling"
            operation["stage"] = "正在取消安装"
            return True

    def import_existing(self, component: str, source: Path, *, progress: Optional[ProgressCallback] = None) -> Dict[str, Any]:
        def remember_failure(error: ComponentError) -> ComponentError:
            self._record_outcome({
                "component": component,
                "state": "failed",
                "reason_code": error.code,
                "error": str(error),
                "details": dict(error.details),
            })
            return error

        source = Path(source).expanduser()
        if not source.is_dir() or source.is_symlink():
            raise remember_failure(ComponentError("请选择包含 component.json 的本地版面引擎目录。", code="invalid_local_component"))
        try:
            receipt = json.loads((source / "component.json").read_text(encoding="utf-8"))
            manifest = self._manifest_from_receipt(component, receipt)
        except (OSError, TypeError, ValueError, json.JSONDecodeError) as exc:
            raise remember_failure(ComponentError("本地版面引擎缺少有效的 component.json。", code="invalid_local_component")) from exc
        except ComponentError as exc:
            raise remember_failure(ComponentError(f"本地版面引擎凭据无效：{exc}", code="invalid_local_component")) from exc
        if manifest.component != component:
            raise remember_failure(ComponentError("所选目录不是目标版面引擎。", code="invalid_local_component"))
        current_platform = _normalize_platform(sys.platform)
        current_arch = _normalize_arch(platform_module.machine())
        if manifest.platform != current_platform or manifest.arch != current_arch:
            raise remember_failure(ComponentError(
                "所选版面引擎与当前设备架构不匹配。",
                code="unsupported_arch",
                details={"required": f"{current_platform}-{current_arch}", "actual": f"{manifest.platform}-{manifest.arch}"},
            ))
        failure = self._system_failure(manifest, check_disk=True)
        if failure:
            raise remember_failure(failure)
        source_status = self._installed_status(manifest, target=source)
        if not source_status or source_status.get("state") != "ready":
            raise remember_failure(ComponentError("所选版面引擎未通过完整性检查或健康检查。", code="invalid_local_component"))
        source_executable = source.joinpath(*_safe_relative_path(manifest.executable, field="executable").parts)
        signature_failure = self.signature_verifier(source_executable, manifest)
        if signature_failure:
            raise remember_failure(ComponentError(f"本地版面引擎签名验证失败：{signature_failure}", code="signature_verification_failed"))
        health_failure = self.executable_health_check(source_executable, manifest)
        if health_failure:
            raise remember_failure(ComponentError(f"本地版面引擎健康检查失败：{health_failure}", code="component_unhealthy"))

        target = self.target_dir(manifest)
        if source.resolve() == target.resolve():
            return self.status(manifest)
        self._set_operation(component=component, state="importing", stage="正在复制已有版面引擎", progress=0.0)
        version_root = target.parent
        staging = version_root / f".staging-import-{manifest.platform}-{manifest.arch}-{uuid.uuid4().hex}"
        published = False
        try:
            self._assert_managed_path(target, self.root)
            self._assert_managed_path(staging, self.root)
            if target.exists() or target.is_symlink():
                existing = self._installed_status(manifest)
                if existing and existing.get("state") == "ready":
                    return self.status(manifest)
                raise remember_failure(ComponentError("目标组件目录已存在但未通过校验。", code="install_conflict"))
            version_root.mkdir(parents=True, exist_ok=True)
            staging.mkdir(parents=False, exist_ok=False)
            total_bytes = 0
            for current, directories, files in os.walk(source, topdown=True, followlinks=False):
                current_path = Path(current)
                directories[:] = sorted(directories)
                files[:] = sorted(files)
                if any((current_path / name).is_symlink() for name in directories + files):
                    raise remember_failure(ComponentError("本地版面引擎不能包含符号链接。", code="unsafe_install_path"))
                relative = current_path.relative_to(source)
                destination = staging / relative
                destination.mkdir(parents=True, exist_ok=True)
                for name in files:
                    source_file = current_path / name
                    total_bytes += max(0, int(source_file.stat().st_size))
                    if total_bytes > manifest.installed_size:
                        raise remember_failure(ComponentError("本地版面引擎超过清单声明的大小。", code="archive_limits_exceeded"))
                    shutil.copy2(source_file, destination / name)
                if progress:
                    progress("复制已有版面引擎", min(0.9, total_bytes / max(1, manifest.installed_size)))
            os.replace(staging, target)
            published = True
            result = self._installed_status(manifest)
            if not result or result.get("state") != "ready":
                raise remember_failure(ComponentError("本地版面引擎导入后校验失败。", code="publish_verification_failed"))
            target_executable = target.joinpath(*_safe_relative_path(manifest.executable, field="executable").parts)
            target_signature_failure = self.signature_verifier(target_executable, manifest)
            if target_signature_failure:
                raise remember_failure(ComponentError(f"本地版面引擎导入后签名验证失败：{target_signature_failure}", code="signature_verification_failed"))
            target_health_failure = self.executable_health_check(target_executable, manifest)
            if target_health_failure:
                raise remember_failure(ComponentError(f"本地版面引擎导入后健康检查失败：{target_health_failure}", code="component_unhealthy"))
            self._record_outcome({"component": component, "state": "completed", "reason_code": "ready"})
            if progress:
                progress("导入完成", 1.0)
            self._clear_operation()
            return self.status(manifest)
        except ComponentError as exc:
            remember_failure(exc)
            if published and target.is_dir() and not target.is_symlink():
                shutil.rmtree(target)
            raise
        finally:
            if staging.exists() or staging.is_symlink():
                self._remove_generated_path(staging, version_root)
            self._clear_operation()

    def install(
        self,
        manifest: ComponentManifest,
        *,
        progress: Optional[ProgressCallback] = None,
        cancel_event: Any = None,
    ) -> Dict[str, Any]:
        manifest.validate()
        if manifest.local_only:
            raise ComponentError("该组件只能从已验证的本地目录导入。", code="not_installable")
        installed = self._installed_status(manifest)
        if installed and installed.get("state") == "ready":
            return self.status(manifest)
        failure = self._system_failure(manifest, check_disk=True)
        if failure:
            raise failure
        internal_cancel = threading.Event()
        combined_cancel = _CombinedCancelEvent(internal_cancel, cancel_event)
        self._set_operation(
            component=manifest.component,
            state="installing",
            stage="准备下载",
            progress=0.0,
            cancel_event=internal_cancel,
        )
        target = self.target_dir(manifest)
        version_root = target.parent
        part = self._download_part(manifest)
        resume_metadata = _resume_metadata_path(part)
        staging = version_root / f".staging-{manifest.platform}-{manifest.arch}-{uuid.uuid4().hex}"
        keep_partial = False
        published = False

        def report(stage: str, fraction: float) -> None:
            bounded = max(0.0, min(1.0, float(fraction)))
            self._update_operation(stage=stage, progress=bounded)
            if progress:
                progress(stage, bounded)

        try:
            self._cleanup_abandoned(manifest)
            self._assert_managed_path(part, self.root)
            self._assert_managed_path(version_root, self.root)
            part.parent.mkdir(parents=True, exist_ok=True)
            version_root.mkdir(parents=True, exist_ok=True)
            self._assert_managed_path(part, self.root)
            self._assert_managed_path(staging, self.root)
            if target.exists() or target.is_symlink():
                raise ComponentError("目标组件目录已存在但未通过校验。", code="install_conflict")

            def on_bytes(downloaded: int, total: int) -> None:
                if combined_cancel.is_set():
                    raise ComponentCancelled()
                denominator = max(1, total or manifest.archive_size)
                report("下载版面引擎", min(0.78, 0.78 * downloaded / denominator))

            resume_record: Dict[str, Any] = {
                "url": manifest.url,
                "sha256": manifest.sha256,
                "archive_size": manifest.archive_size,
                "etag": "",
            }
            try:
                previous_resume = json.loads(resume_metadata.read_text(encoding="utf-8"))
                if isinstance(previous_resume, Mapping) and previous_resume.get("etag"):
                    resume_record["etag"] = str(previous_resume["etag"])
            except (OSError, json.JSONDecodeError):
                pass
            _write_json_atomic(resume_metadata, resume_record)
            if not part.is_file() or part.stat().st_size != manifest.archive_size:
                self.downloader(manifest, part, on_bytes, combined_cancel)
            else:
                on_bytes(manifest.archive_size, manifest.archive_size)
            if combined_cancel.is_set():
                raise ComponentCancelled()
            if not part.is_file() or part.stat().st_size < manifest.archive_size:
                raise ComponentError("组件下载尚未完成，可在重试时继续。", code="download_failed")
            if part.stat().st_size > manifest.archive_size:
                raise ComponentError("组件下载大小与清单不一致。", code="size_mismatch")
            report("校验组件", 0.82)
            if _sha256(part) != manifest.sha256:
                raise ComponentError("组件 SHA-256 校验失败。", code="checksum_mismatch")
            if combined_cancel.is_set():
                raise ComponentCancelled()
            staging.mkdir(parents=False, exist_ok=False)
            report("解压组件", 0.88)
            installed_bytes = self._extract_archive(part, staging, manifest, combined_cancel)
            executable = staging.joinpath(*_safe_relative_path(manifest.executable, field="executable").parts)
            if not executable.is_file() or executable.is_symlink():
                raise ComponentError("组件未包含清单指定的可执行文件。", code="missing_executable")
            if manifest.platform == "darwin" and not _is_macho_executable(executable):
                raise ComponentError("macOS 版面引擎必须提供自包含的 Mach-O 可执行文件。", code="non_self_contained_executable")
            executable.chmod(executable.stat().st_mode | stat.S_IXUSR)
            try:
                signature_failure = self.signature_verifier(executable, manifest)
            except Exception as exc:
                raise ComponentError(f"组件签名验证失败：{exc}", code="signature_verification_failed") from exc
            if signature_failure:
                raise ComponentError(
                    f"组件签名验证失败：{signature_failure}",
                    code="signature_verification_failed",
                )
            try:
                health_failure = self.executable_health_check(executable, manifest)
            except Exception as exc:
                raise ComponentError(f"组件健康检查失败：{exc}", code="component_unhealthy") from exc
            if health_failure:
                raise ComponentError(f"组件健康检查失败：{health_failure}", code="component_unhealthy")
            executable_sha256 = _sha256(executable)
            receipt = {
                "schema_version": 1,
                "component": manifest.component,
                "version": manifest.version,
                "model_version": manifest.model_version,
                "platform": manifest.platform,
                "arch": manifest.arch,
                "archive_sha256": manifest.sha256,
                "executable": manifest.executable,
                "health_check_args": list(manifest.health_check_args),
                "executable_sha256": executable_sha256,
                "installed_bytes": installed_bytes,
                "source": manifest.source,
                "signing_identity": manifest.signing_identity,
                "team_id": manifest.team_id,
                "signature_policy": manifest.signature_policy,
            }
            receipt_path = staging / "component.json"
            receipt_path.write_text(json.dumps(receipt, ensure_ascii=False, indent=2), encoding="utf-8")
            if combined_cancel.is_set():
                raise ComponentCancelled()
            report("发布组件", 0.96)
            os.replace(staging, target)
            published = True
            try:
                directory_fd = os.open(version_root, os.O_RDONLY)
                try:
                    os.fsync(directory_fd)
                finally:
                    os.close(directory_fd)
            except OSError:
                pass
            report("安装完成", 1.0)
            result = self._installed_status(manifest)
            if not result or result.get("state") != "ready":
                raise ComponentError("组件发布后校验失败。", code="publish_verification_failed")
            obsolete = self._retire_obsolete_installs(manifest)
            self._record_outcome({"component": manifest.component, "state": "completed", "reason_code": "ready"})
            return {**result, **obsolete}
        except ComponentError as exc:
            keep_partial = (
                exc.code == "download_failed"
                and part.is_file()
                and not part.is_symlink()
                and 0 < part.stat().st_size < manifest.archive_size
                and resume_metadata.is_file()
            )
            state = "cancelled" if exc.code == "cancelled" else "failed"
            self._record_outcome({
                "component": manifest.component,
                "state": state,
                "reason_code": exc.code,
                "error": str(exc),
                "details": dict(exc.details),
            })
            if published and target.is_dir() and not target.is_symlink():
                shutil.rmtree(target)
            raise
        except Exception as exc:
            wrapped = ComponentError(f"组件安装失败：{exc}", code="install_failed")
            self._record_outcome({
                "component": manifest.component,
                "state": "failed",
                "reason_code": wrapped.code,
                "error": str(wrapped),
                "details": {},
            })
            if published and target.is_dir() and not target.is_symlink():
                shutil.rmtree(target)
            raise wrapped from exc
        finally:
            if not keep_partial:
                for candidate in (part, resume_metadata):
                    if candidate.exists() or candidate.is_symlink():
                        self._remove_generated_path(candidate, self.root / ".downloads")
            if staging.exists() or staging.is_symlink():
                self._remove_generated_path(staging, version_root)
            self._clear_operation()

    def _extract_archive(
        self,
        archive: Path,
        staging: Path,
        manifest: ComponentManifest,
        cancel_event: Any,
    ) -> int:
        total_bytes = 0
        file_count = 0

        def destination(name: str) -> Path:
            relative = _safe_relative_path(name, field="archive")
            return staging.joinpath(*relative.parts)

        def account(size: int) -> None:
            nonlocal total_bytes, file_count
            file_count += 1
            total_bytes += max(0, int(size))
            if file_count > MAX_ARCHIVE_FILES or total_bytes > manifest.installed_size:
                raise ComponentError("组件解压内容超过清单限制。", code="archive_limits_exceeded")
            if cancel_event.is_set():
                raise ComponentCancelled()

        def copy_stream(source: Any, output: Any) -> None:
            while True:
                if cancel_event.is_set():
                    raise ComponentCancelled()
                chunk = source.read(DOWNLOAD_CHUNK_BYTES)
                if not chunk:
                    return
                output.write(chunk)

        if manifest.archive_type == "zip":
            try:
                with zipfile.ZipFile(archive) as bundle:
                    for info in bundle.infolist():
                        account(0 if info.is_dir() else info.file_size)
                        mode = (info.external_attr >> 16) & 0xFFFF
                        if stat.S_ISLNK(mode):
                            raise ComponentError("组件压缩包不能包含符号链接。", code="unsafe_archive")
                        target = destination(info.filename.rstrip("/"))
                        if info.is_dir():
                            target.mkdir(parents=True, exist_ok=True)
                            continue
                        target.parent.mkdir(parents=True, exist_ok=True)
                        with bundle.open(info) as source, target.open("xb") as output:
                            copy_stream(source, output)
                        if mode:
                            target.chmod(mode & 0o777)
            except (zipfile.BadZipFile, OSError) as exc:
                raise ComponentError(f"组件 ZIP 解压失败：{exc}", code="invalid_archive") from exc
        else:
            try:
                with tarfile.open(archive, mode="r:gz") as bundle:
                    for member in bundle:
                        if member.issym() or member.islnk() or member.isdev():
                            raise ComponentError("组件压缩包不能包含链接或设备文件。", code="unsafe_archive")
                        if not member.isdir() and not member.isfile():
                            raise ComponentError("组件压缩包包含不支持的条目。", code="unsafe_archive")
                        account(0 if member.isdir() else member.size)
                        target = destination(member.name.rstrip("/"))
                        if member.isdir():
                            target.mkdir(parents=True, exist_ok=True)
                            continue
                        source = bundle.extractfile(member)
                        if source is None:
                            raise ComponentError("组件压缩包条目无法读取。", code="invalid_archive")
                        target.parent.mkdir(parents=True, exist_ok=True)
                        with source, target.open("xb") as output:
                            copy_stream(source, output)
                        target.chmod(member.mode & 0o777)
            except (tarfile.TarError, OSError) as exc:
                raise ComponentError(f"组件 TAR 解压失败：{exc}", code="invalid_archive") from exc
        return total_bytes

    def remove(self, manifest: ComponentManifest) -> Dict[str, Any]:
        manifest.validate()
        self._set_operation(
            component=manifest.component,
            state="removing",
            stage="正在删除组件",
            progress=0.0,
        )
        try:
            current_target = self.target_dir(manifest)
            component_root = current_target.parent.parent
            self._assert_managed_path(current_target, component_root)
            cleaned_stale = self._cleanup_all_stale_trash(manifest)
            if current_target.is_symlink():
                raise ComponentError("拒绝删除符号链接组件目录。", code="unsafe_install_path")
            if current_target.is_dir() and not self._receipt_identity_matches(current_target, manifest):
                raise ComponentError("拒绝删除没有匹配安装凭据的目录。", code="unmanaged_component")
            installs = self._managed_installs(manifest)
            removed_versions: list[str] = []
            for install in installs:
                target = Path(install["target"])
                version = str(install["version"])
                version_root = target.parent
                trash = version_root / f".trash-{manifest.platform}-{manifest.arch}-{uuid.uuid4().hex}"
                self._assert_managed_path(trash, version_root)
                os.replace(target, trash)
                removed_versions.append(version)
                try:
                    shutil.rmtree(trash)
                except OSError as exc:
                    message = "组件已移出使用路径，但临时卸载目录清理失败。"
                    self._record_outcome({
                        "component": manifest.component,
                        "state": "failed",
                        "reason_code": "remove_cleanup_failed",
                        "error": message,
                        "details": {"cleanup_pending": True},
                    })
                    raise ComponentError(
                        message,
                        code="remove_cleanup_failed",
                        details={"cleanup_pending": True},
                    ) from exc
                try:
                    version_root.rmdir()
                except OSError:
                    pass
            for directory in (component_root,):
                try:
                    directory.rmdir()
                except OSError:
                    pass
            self._record_outcome({
                "component": manifest.component,
                "state": "not_installed",
                "reason_code": "not_installed",
            })
            return {
                "state": "not_installed",
                "reason_code": "not_installed",
                "removed": bool(removed_versions),
                "removed_versions": sorted(removed_versions),
                "cleaned_stale": cleaned_stale,
            }
        except ComponentError:
            raise
        except OSError as exc:
            message = "组件卸载失败，未删除任何未确认的目录。"
            self._record_outcome({
                "component": manifest.component,
                "state": "failed",
                "reason_code": "remove_failed",
                "error": message,
                "details": {},
            })
            raise ComponentError(message, code="remove_failed") from exc
        finally:
            self._clear_operation()
