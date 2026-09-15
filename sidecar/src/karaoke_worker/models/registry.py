"""모델 lock registry·로컬 파일 검증·single-flight prepare."""

from __future__ import annotations

import hashlib
import json
import os
import re
import secrets
import shutil
import threading
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from ..protocol import WorkerError
from .schema import ERROR_CODES, LockError
from .verify import validate_artifact_runtime, validate_lock_shape, validate_model_bindings

_DRIVE_RE = re.compile(r"^[a-zA-Z]:")
_ENV_LOCK = "KARAOKE_MODELS_LOCK"
_ENV_DIR = "KARAOKE_MODELS_DIR"
_ENV_DEV_LOCK = "KARAOKE_DEV_MODELS_LOCK"
_ENV_DEMUCS = "KARAOKE_DEMUCS_MODEL"
_ENV_WHISPER = "KARAOKE_WHISPER_MODEL"

# 배포 검증 대상이 아닌 실험 모델 전용
EXPERIMENTAL_ENV = _ENV_DEV_LOCK


class ModelError(WorkerError):
    def __init__(
        self,
        code: str,
        msg: str,
        *,
        id: str | None = None,
        path: str | None = None,
    ) -> None:
        super().__init__(code, msg)
        self.id = id
        self.path = path
        self.message = msg


class WaiterCancelled(ModelError):
    def __init__(self, model_id: str) -> None:
        super().__init__("ABORTED", f"prepare cancelled ({model_id})", id=model_id)


@dataclass(frozen=True)
class PreparedModel:
    id: str
    loader: str
    artifacts: dict[str, Path]
    local_repo: Path | None = None
    model_dir: Path | None = None
    checkpoint_path: Path | None = None
    vad_asset: Path | None = None
    config_source: Path | None = None


@dataclass
class _Flight:
    event: threading.Event = field(default_factory=threading.Event)
    waiters: int = 0
    result: PreparedModel | None = None
    error: BaseException | None = None


_singleton_guard = threading.Lock()
_singleton: ModelRegistry | None = None


def hash_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as fh:
        while True:
            chunk = fh.read(1024 * 1024)
            if not chunk:
                break
            digest.update(chunk)
    return digest.hexdigest()


def resolve_inside(root: Path, rel: str, *, id: str | None = None) -> Path:
    details = {"id": id, "path": rel}
    if not isinstance(rel, str) or rel == "" or "\0" in rel:
        raise ModelError(ERROR_CODES["PATH_ESCAPE"], "empty dest path", id=id, path=rel)
    posix = rel.replace("\\", "/")
    if posix.startswith("/") or posix.startswith("//"):
        raise ModelError(ERROR_CODES["PATH_ESCAPE"], f"absolute dest: {posix}", id=id, path=posix)
    if _DRIVE_RE.match(posix) or posix.startswith("\\\\") or "://" in posix:
        raise ModelError(ERROR_CODES["PATH_ESCAPE"], f"drive/UNC dest: {posix}", id=id, path=posix)
    if any(part == ".." for part in posix.split("/")):
        raise ModelError(ERROR_CODES["PATH_ESCAPE"], f"path escape: {posix}", id=id, path=posix)
    root_r = root.resolve()
    resolved = (root_r.joinpath(*posix.split("/"))).resolve()
    try:
        resolved.relative_to(root_r)
    except ValueError as exc:
        raise ModelError(
            ERROR_CODES["PATH_ESCAPE"],
            f"resolved path escaped target: {rel}",
            id=id,
            path=rel,
        ) from exc
    return resolved


def resolve_wheel_asset(spec: str) -> Path:
    """wheel:<package>:<relative> — 패키지 내부 자산. 네트워크 없이 연다."""
    parts = spec.split(":", 2)
    if len(parts) != 3 or parts[0] != "wheel":
        raise ModelError("SCHEMA_ERROR", f"invalid wheel asset spec: {spec}")
    _kind, package, rel = parts
    mod_name = package.replace("-", "_")
    try:
        module = __import__(mod_name)
    except ImportError as exc:
        raise ModelError("MODEL_NOT_READY", f"wheel package missing: {package}") from exc
    root = Path(module.__file__).resolve().parent
    path = (root / rel).resolve()
    try:
        path.relative_to(root)
    except ValueError as exc:
        raise ModelError(ERROR_CODES["PATH_ESCAPE"], f"wheel asset escaped: {spec}") from exc
    if not path.is_file():
        raise ModelError("MODEL_NOT_READY", f"wheel asset missing: {path}", path=str(path))
    return path


def _discover_lock_path() -> Path:
    env = os.environ.get(_ENV_LOCK)
    if env:
        return Path(env)
    here = Path(__file__).resolve()
    for parent in here.parents:
        candidate = parent / "build" / "locks" / "models.lock.json"
        if candidate.is_file():
            return candidate
    raise ModelError("MODEL_LOCK_MISSING", f"{_ENV_LOCK} is not set and default lock was not found")


def _is_forbidden_override(name: str) -> bool:
    if name == "":
        return True
    if "://" in name:
        return True
    if "\\" in name or name.startswith("/") or name.startswith("./") or name.startswith("../"):
        return True
    if len(name) >= 2 and name[1] == ":":
        return True
    if any(part == ".." for part in name.replace("\\", "/").split("/")):
        return True
    return False


def _link_or_copy(src: Path, dest: Path) -> None:
    dest.parent.mkdir(parents=True, exist_ok=True)
    try:
        os.link(src, dest)
    except OSError:
        shutil.copy2(src, dest)


def _atomic_replace_dir(tmp: Path, dest: Path) -> None:
    dest.parent.mkdir(parents=True, exist_ok=True)
    try:
        tmp.replace(dest)
        return
    except OSError:
        pass
    if dest.exists():
        shutil.rmtree(dest, ignore_errors=True)
    tmp.replace(dest)


class ModelRegistry:
    def __init__(
        self,
        lock_path: str | Path | None = None,
        cache_root: str | Path | None = None,
        *,
        experimental_lock_path: str | Path | None = None,
    ) -> None:
        self.lock_path = Path(lock_path) if lock_path is not None else _discover_lock_path()
        env_dir = os.environ.get(_ENV_DIR)
        if cache_root is not None:
            self.cache_root: Path | None = Path(cache_root)
        elif env_dir:
            self.cache_root = Path(env_dir)
        else:
            self.cache_root = None
        env_dev = experimental_lock_path or os.environ.get(_ENV_DEV_LOCK)
        self.experimental_lock_path = Path(env_dev) if env_dev else None

        self._lock_data = self._load_lock(self.lock_path)
        self._artifacts: dict[str, dict[str, Any]] = {
            a["id"]: a for a in self._lock_data.get("artifacts") or []
        }
        self._bindings: dict[str, dict[str, Any]] = {
            m["id"]: m for m in self._lock_data.get("models") or []
        }
        self._experimental_bindings: dict[str, dict[str, Any]] = {}
        self._experimental_artifacts: dict[str, dict[str, Any]] = {}
        if self.experimental_lock_path and self.experimental_lock_path.is_file():
            dev = self._load_lock(self.experimental_lock_path, experimental=True)
            self._experimental_artifacts = {a["id"]: a for a in dev.get("artifacts") or []}
            self._experimental_bindings = {m["id"]: m for m in dev.get("models") or []}

        self._guard = threading.Lock()
        self._flights: dict[str, _Flight] = {}
        self._digest_flights: dict[str, _Flight] = {}
        self._loaded: dict[Any, Any] = {}

    def _load_lock(self, path: Path, *, experimental: bool = False) -> dict[str, Any]:
        if not path.is_file():
            raise ModelError("MODEL_LOCK_MISSING", f"lock file not found: {path}", path=str(path))
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except json.JSONDecodeError as exc:
            raise ModelError(ERROR_CODES["SCHEMA_ERROR"], f"invalid lock json: {path}") from exc
        errors = validate_lock_shape(data)
        if data.get("kind") == "models":
            for artifact in data.get("artifacts") or []:
                if isinstance(artifact, dict):
                    errors.extend(validate_artifact_runtime(artifact, "models"))
            errors.extend(validate_model_bindings(data))
        if errors:
            first = errors[0]
            raise ModelError(first.code, first.message, id=first.id, path=first.path)
        return data

    def list_ids(self) -> list[str]:
        """배포 검증 대상 모델 ID. 실험 모델은 포함하지 않는다."""
        return sorted(self._bindings.keys())

    def list_artifact_ids(self) -> list[str]:
        return sorted(self._artifacts.keys())

    def get_binding(self, model_id: str) -> dict[str, Any]:
        binding = self._bindings.get(model_id)
        if binding is None:
            raise ModelError("UNREGISTERED_MODEL", f"unregistered model id: {model_id}", id=model_id)
        return binding

    def resolve_id(self, name: str, *, allow_experimental: bool = False) -> str:
        if not isinstance(name, str) or name.strip() == "":
            raise ModelError("UNREGISTERED_MODEL", "empty model id")
        ident = name.strip()
        if _is_forbidden_override(ident):
            raise ModelError(
                "UNREGISTERED_MODEL",
                f"model override must be a registered id, not a url/path: {ident}",
                id=ident,
            )
        if ident in self._bindings:
            return ident
        if allow_experimental and ident in self._experimental_bindings:
            return ident
        raise ModelError("UNREGISTERED_MODEL", f"unregistered model id: {ident}", id=ident)

    def resolve_env_demucs(self, override: str | None = None) -> str:
        name = override if override is not None else os.environ.get(_ENV_DEMUCS, "htdemucs_ft")
        return self.resolve_id(name)

    def resolve_env_whisper(self, override: str | None = None) -> str:
        name = override if override is not None else os.environ.get(_ENV_WHISPER, "large-v3-turbo")
        return self.resolve_id(name)

    def get_loaded(self, key: Any) -> Any | None:
        return self._loaded.get(key)

    def remember(self, key: Any, obj: Any) -> None:
        self._loaded[key] = obj

    def prepare(
        self,
        model_id: str,
        *,
        cancel: threading.Event | None = None,
        experimental: bool = False,
    ) -> PreparedModel:
        resolved = self.resolve_id(model_id, allow_experimental=experimental)
        if experimental:
            if resolved not in self._experimental_bindings:
                raise ModelError(
                    "UNREGISTERED_MODEL",
                    f"experimental model not in {_ENV_DEV_LOCK}: {resolved}",
                    id=resolved,
                )
            return self._prepare_single_flight(f"dev:{resolved}", lambda: self._prepare_impl(resolved, experimental=True), cancel)
        return self._prepare_single_flight(resolved, lambda: self._prepare_impl(resolved, experimental=False), cancel)

    def prepare_experimental(self, model_id: str, *, cancel: threading.Event | None = None) -> PreparedModel:
        """개발 전용. list_ids()/배포 검증에 포함하지 않는다."""
        if not self.experimental_lock_path:
            raise ModelError(
                "UNREGISTERED_MODEL",
                f"{_ENV_DEV_LOCK} is not set; experimental models are not part of deploy verification",
                id=model_id,
            )
        return self.prepare(model_id, cancel=cancel, experimental=True)

    def _prepare_single_flight(
        self,
        key: str,
        impl,
        cancel: threading.Event | None,
    ) -> PreparedModel:
        with self._guard:
            flight = self._flights.get(key)
            owner = False
            if flight is None:
                flight = _Flight()
                self._flights[key] = flight
                owner = True
            flight.waiters += 1
        if owner:
            try:
                flight.result = impl()
            except BaseException as exc:  # noqa: BLE001 — waiter에게 그대로 전달
                flight.error = exc
            finally:
                flight.event.set()
        while not flight.event.wait(timeout=0.05):
            if cancel is not None and cancel.is_set():
                with self._guard:
                    flight.waiters -= 1
                    if flight.waiters == 0 and self._flights.get(key) is flight:
                        self._flights.pop(key, None)
                raise WaiterCancelled(key)
        with self._guard:
            flight.waiters -= 1
            if flight.waiters == 0 and self._flights.get(key) is flight:
                self._flights.pop(key, None)
        if cancel is not None and cancel.is_set():
            raise WaiterCancelled(key)
        if flight.error is not None:
            raise flight.error
        assert flight.result is not None
        return flight.result

    def _prepare_impl(self, model_id: str, *, experimental: bool) -> PreparedModel:
        if self.cache_root is None:
            raise ModelError(
                "MODEL_NOT_READY",
                f"{_ENV_DIR} is not set; verified model files are required before load",
                id=model_id,
            )
        if experimental:
            binding = self._experimental_bindings[model_id]
            artifacts_by_id = self._experimental_artifacts
        else:
            binding = self._bindings[model_id]
            artifacts_by_id = self._artifacts
        artifact_ids = list(binding.get("artifactIds") or [])
        if not artifact_ids:
            raise ModelError(
                "MODEL_NOT_READY",
                f"model {model_id} has no artifacts; id/alias alone is not enough",
                id=model_id,
            )
        verified: dict[str, Path] = {}
        for aid in artifact_ids:
            artifact = artifacts_by_id.get(aid)
            if artifact is None:
                raise ModelError("MODEL_NOT_READY", f"artifact {aid} not in lock", id=aid)
            verified[aid] = self._verify_artifact(artifact)
        loader = str(binding.get("loader") or "")
        package = (binding.get("loaderBinding") or {}).get("package", "")
        local_repo = None
        model_dir = None
        checkpoint_path = None
        vad_asset = None
        config_source = None
        if package == "demucs":
            config_spec = binding.get("configSource")
            if not config_spec:
                raise ModelError("MODEL_NOT_READY", f"demucs model {model_id} missing configSource", id=model_id)
            config_source = resolve_wheel_asset(str(config_spec))
            local_repo = self._assemble_demucs_repo(model_id, verified, config_source)
        elif package == "faster_whisper":
            parents = {path.parent for path in verified.values()}
            if len(parents) != 1:
                raise ModelError("MODEL_NOT_READY", f"whisper files must share a directory: {model_id}", id=model_id)
            model_dir = next(iter(parents))
            vad_spec = binding.get("vadAsset")
            if vad_spec:
                vad_asset = resolve_wheel_asset(str(vad_spec))
        elif package in ("beat_this.inference", "torchaudio.pipelines"):
            checkpoint_path = next(iter(verified.values()))
        return PreparedModel(
            id=model_id,
            loader=loader,
            artifacts=verified,
            local_repo=local_repo,
            model_dir=model_dir,
            checkpoint_path=checkpoint_path,
            vad_asset=vad_asset,
            config_source=config_source,
        )

    def _verify_artifact(self, artifact: dict[str, Any]) -> Path:
        digest = artifact.get("sha256")
        ident = artifact.get("id")
        if not isinstance(digest, str) or digest == "":
            raise ModelError(ERROR_CODES["MISSING_HASH"], f"missing sha256 for {ident}", id=ident)

        def impl() -> Path:
            assert self.cache_root is not None
            path = resolve_inside(self.cache_root, artifact["dest"], id=ident)
            if not path.is_file():
                raise ModelError(
                    "MODEL_NOT_READY",
                    f"missing artifact {ident} at {path}; auto-download is disabled",
                    id=ident,
                    path=str(path),
                )
            size = path.stat().st_size
            expected_size = artifact.get("size")
            if size != expected_size:
                raise ModelError(
                    ERROR_CODES["SIZE_MISMATCH"],
                    f"size mismatch for {ident}: {size} != {expected_size}",
                    id=ident,
                    path=str(path),
                )
            actual = hash_file(path)
            if actual != digest:
                raise ModelError(
                    ERROR_CODES["HASH_MISMATCH"],
                    f"sha256 mismatch for {ident}",
                    id=ident,
                    path=str(path),
                )
            return path

        return self._digest_single_flight(f"{digest}:{artifact.get('dest')}", impl)

    def _digest_single_flight(self, digest: str, impl) -> Path:
        with self._guard:
            flight = self._digest_flights.get(digest)
            owner = False
            if flight is None:
                flight = _Flight()
                self._digest_flights[digest] = flight
                owner = True
            flight.waiters += 1
        if owner:
            try:
                flight.result = impl()  # type: ignore[assignment]
            except BaseException as exc:  # noqa: BLE001
                flight.error = exc
            finally:
                flight.event.set()
        flight.event.wait()
        with self._guard:
            flight.waiters -= 1
            if flight.waiters == 0 and self._digest_flights.get(digest) is flight:
                self._digest_flights.pop(digest, None)
        if flight.error is not None:
            raise flight.error
        return flight.result  # type: ignore[return-value]

    def _assemble_demucs_repo(self, model_id: str, files: dict[str, Path], yaml_src: Path) -> Path:
        assert self.cache_root is not None
        yaml_name = yaml_src.name
        th_names = {path.name for path in files.values()}
        repo = self.cache_root / ".repos" / model_id
        if _demucs_repo_complete(repo, yaml_name, th_names):
            return repo
        tmp = self.cache_root / ".repos" / f".{model_id}.{os.getpid()}.{secrets.token_hex(4)}.tmp"
        if tmp.exists():
            shutil.rmtree(tmp, ignore_errors=True)
        tmp.mkdir(parents=True)
        try:
            for path in files.values():
                _link_or_copy(path, tmp / path.name)
            dest_yaml = tmp / yaml_name
            tmp_yaml = tmp / f".{yaml_name}.{secrets.token_hex(4)}"
            shutil.copy2(yaml_src, tmp_yaml)
            tmp_yaml.replace(dest_yaml)
            if not _demucs_repo_complete(tmp, yaml_name, th_names):
                raise ModelError("MODEL_NOT_READY", f"incomplete demucs repo for {model_id}", id=model_id)
            _atomic_replace_dir(tmp, repo)
        except Exception:
            shutil.rmtree(tmp, ignore_errors=True)
            raise
        if not _demucs_repo_complete(repo, yaml_name, th_names):
            raise ModelError("MODEL_NOT_READY", f"incomplete demucs repo for {model_id}", id=model_id)
        return repo


def _demucs_repo_complete(repo: Path, yaml_name: str, th_names: set[str]) -> bool:
    if not repo.is_dir():
        return False
    if not (repo / yaml_name).is_file():
        return False
    for name in th_names:
        if not (repo / name).is_file():
            return False
    return True


def get_registry() -> ModelRegistry:
    global _singleton
    with _singleton_guard:
        if _singleton is None:
            _singleton = ModelRegistry()
        return _singleton


def reset_registry_for_tests() -> None:
    global _singleton
    with _singleton_guard:
        _singleton = None
