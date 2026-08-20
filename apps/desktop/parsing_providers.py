"""Provider boundary for advanced document layout parsing."""

from __future__ import annotations

import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Dict, Mapping, Optional

from component_manager import (
    ComponentError,
    ComponentManager,
    ComponentManifest,
    PRODUCTION_COMPONENT_CATALOG,
)
from pipeline import process_pdf


ProgressCallback = Callable[[str, float], None]


class ProviderError(RuntimeError):
    def __init__(
        self,
        message: str,
        *,
        code: str,
        details: Optional[Mapping[str, Any]] = None,
        http_status: Optional[int] = None,
    ) -> None:
        super().__init__(message)
        self.code = code
        self.details = dict(details or {})
        self.http_status = int(http_status or _http_status_for(code))
        self.status = self.http_status

    def to_dict(self) -> Dict[str, Any]:
        return {"error": str(self), "code": self.code, "details": dict(self.details)}


def _http_status_for(code: str) -> int:
    if code in {"busy", "cancelled", "provider_disabled", "install_conflict"}:
        return 409
    if code in {
        "artifact_unavailable", "not_installed", "not_configured", "unsupported_platform",
        "incompatible_os", "insufficient_memory", "insufficient_disk", "component_unhealthy",
    }:
        return 428
    if code in {"download_failed"}:
        return 502
    return 422


@dataclass(frozen=True)
class ParsingRequest:
    job_id: str
    source_pdf: Path
    output_dir: Path
    source_name: str
    generation: Optional[int] = None

    @classmethod
    def from_value(cls, value: Any) -> "ParsingRequest":
        if isinstance(value, cls):
            return value
        if not isinstance(value, Mapping):
            raise ProviderError("解析请求格式无效。", code="invalid_request")
        try:
            request = cls(
                job_id=str(value["job_id"]),
                source_pdf=Path(value["source_pdf"]),
                output_dir=Path(value["output_dir"]),
                source_name=str(value.get("source_name") or Path(value["source_pdf"]).name),
                generation=int(value["generation"]) if value.get("generation") is not None else None,
            )
        except (KeyError, TypeError, ValueError) as exc:
            raise ProviderError("解析请求缺少有效字段。", code="invalid_request") from exc
        if not request.job_id or not request.source_name:
            raise ProviderError("解析请求缺少任务标识或文件名。", code="invalid_request")
        return request


@dataclass(frozen=True)
class ParsingResult:
    manifest: Dict[str, Any]
    metrics: Dict[str, Any]


class LocalMineruProvider:
    provider_id = "local-mineru"
    kind = "local"

    def __init__(
        self,
        manager: ComponentManager,
        *,
        health_check: Optional[Callable[[Path], Optional[str]]] = None,
    ) -> None:
        self.manager = manager
        self.health_check = health_check

    def _manifest(self) -> Optional[ComponentManifest]:
        return self.manager.manifest_for("mineru")

    def status(self) -> Dict[str, Any]:
        manifest = self._manifest()
        metadata = self.manager.component_metadata("mineru")
        base = {
            "id": self.provider_id,
            "kind": self.kind,
            "type": self.kind,
            "ready": False,
            "version": str(metadata.get("version") or ""),
            "model_version": str(metadata.get("model_version") or ""),
            "requirements": dict(metadata.get("requirements") or {}),
        }
        if manifest is None:
            return {
                **base,
                "state": "artifact_unavailable",
                "reason_code": "artifact_unavailable",
                "can_install": False,
                "message": "本地版面引擎 artifact 尚未提供。",
            }
        status = self.manager.status(manifest)
        result = {
            **base,
            **status,
            "can_install": status.get("state") in {"not_installed", "update_available", "failed", "cancelled"},
        }
        if status.get("state") == "ready":
            executable = self.manager.executable_path(manifest)
            failure = self.health_check(executable) if self.health_check else self.manager.executable_health_check(executable, manifest)
            if failure:
                return {
                    **result,
                    "state": "component_unhealthy",
                    "reason_code": "component_unhealthy",
                    "message": str(failure),
                    "ready": False,
                }
            result["ready"] = True
        return result

    def capability(self) -> Dict[str, Any]:
        return self.status()

    def install(
        self,
        progress: Optional[ProgressCallback] = None,
        cancel_event: Any = None,
    ) -> Dict[str, Any]:
        manifest = self._manifest()
        if manifest is None:
            raise ProviderError(
                "本地版面引擎 artifact 尚未提供。",
                code="artifact_unavailable",
                details={"provider_id": self.provider_id},
            )
        try:
            self.manager.install(manifest, progress=progress, cancel_event=cancel_event)
        except ComponentError as exc:
            raise _provider_error(exc) from exc
        return self.status()

    def cancel_install(self) -> bool:
        return self.manager.cancel_install()

    def remove(self) -> Dict[str, Any]:
        manifest = self._manifest()
        if manifest is None:
            return {**self.status(), "removed": False}
        try:
            result = self.manager.remove(manifest)
        except ComponentError as exc:
            raise _provider_error(exc) from exc
        return {**self.status(), **result}

    def run(
        self,
        request: Any,
        progress: Optional[ProgressCallback] = None,
        cancel_event: Any = None,
    ) -> ParsingResult:
        parsed = ParsingRequest.from_value(request)
        capability = self.status()
        if not capability.get("ready"):
            code = str(capability.get("reason_code") or capability.get("state") or "not_installed")
            raise ProviderError(
                str(capability.get("message") or "本地版面引擎不可用。"),
                code=code,
                details={"provider": capability},
            )
        manifest = self._manifest()
        if manifest is None:
            raise ProviderError("本地版面引擎 artifact 尚未提供。", code="artifact_unavailable")
        if cancel_event is not None and cancel_event.is_set():
            raise ProviderError("AI 重排已取消。", code="cancelled")
        started = time.perf_counter()
        try:
            result = process_pdf(
                parsed.source_pdf,
                parsed.output_dir,
                job_id=parsed.job_id,
                source_name=parsed.source_name,
                progress=progress,
                backend_override="layout",
                layout_executable=self.manager.executable_path(manifest),
                layout_runtime_root=self.manager.target_dir(manifest),
                cancel_event=cancel_event,
            )
        except Exception as exc:
            if cancel_event is not None and cancel_event.is_set():
                raise ProviderError("AI 重排已取消。", code="cancelled") from exc
            raise
        return ParsingResult(
            manifest=dict(result),
            metrics={
                "provider_id": self.provider_id,
                "component_version": manifest.version,
                "model_version": manifest.model_version,
                "seconds": round(time.perf_counter() - started, 3),
            },
        )


class RemoteGuziProvider:
    provider_id = "remote-guzi"
    kind = "remote"

    def status(self) -> Dict[str, Any]:
        return {
            "id": self.provider_id,
            "kind": self.kind,
            "type": self.kind,
            "state": "disabled",
            "reason_code": "not_configured",
            "ready": False,
            "configured": False,
            "can_install": False,
            "message": "谷子在线解析服务尚未提供。",
        }

    def capability(self) -> Dict[str, Any]:
        return self.status()

    def install(self, progress: Optional[ProgressCallback] = None, cancel_event: Any = None) -> Dict[str, Any]:
        raise ProviderError("远程解析服务不支持本地安装。", code="provider_disabled")

    def cancel_install(self) -> bool:
        return False

    def remove(self) -> Dict[str, Any]:
        raise ProviderError("远程解析服务未配置。", code="not_configured")

    def run(
        self,
        request: Any,
        progress: Optional[ProgressCallback] = None,
        cancel_event: Any = None,
    ) -> ParsingResult:
        raise ProviderError("谷子在线解析服务尚未提供。", code="not_configured")


class ParsingProviderRegistry:
    def __init__(self, providers: list[Any]) -> None:
        self._providers = {provider.provider_id: provider for provider in providers}

    def get(self, provider_id: str) -> Any:
        provider = self._providers.get(str(provider_id or ""))
        if provider is None:
            raise ProviderError("解析服务不存在。", code="provider_not_found", http_status=404)
        return provider

    def list_capabilities(self) -> list[Dict[str, Any]]:
        return [provider.status() for provider in self._providers.values()]


def _provider_error(error: ComponentError) -> ProviderError:
    return ProviderError(str(error), code=error.code, details=error.details)


def create_default_registry(
    components_root: Path,
    *,
    catalog: Optional[Mapping[str, Any]] = None,
    downloader: Any = None,
    system_probe: Any = None,
    health_check: Optional[Callable[[Path], Optional[str]]] = None,
    signature_verifier: Any = None,
) -> ParsingProviderRegistry:
    component_health_check = (lambda path, _manifest: health_check(path)) if health_check else None
    manager = ComponentManager(
        components_root,
        catalog=catalog if catalog is not None else PRODUCTION_COMPONENT_CATALOG,
        downloader=downloader,
        system_probe=system_probe,
        signature_verifier=signature_verifier,
        executable_health_check=component_health_check,
    )
    return ParsingProviderRegistry([
        LocalMineruProvider(manager, health_check=health_check),
        RemoteGuziProvider(),
    ])


__all__ = [
    "LocalMineruProvider",
    "ParsingProviderRegistry",
    "ParsingRequest",
    "ParsingResult",
    "ProviderError",
    "RemoteGuziProvider",
    "create_default_registry",
]
