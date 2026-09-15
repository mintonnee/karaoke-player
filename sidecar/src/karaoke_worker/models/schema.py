"""L1 lock schema 계약의 Python 포트. ERROR_CODES·해시·canonicalize 규칙을 그대로 따른다."""

from __future__ import annotations

import copy
import hashlib
import json
import posixpath
import re
from typing import Any

SCHEMA_VERSION = 1
SUPPORTED_PLATFORM = "win32-x64"
LOCK_KINDS = ("tools", "python", "models", "wheels")
ARTIFACT_KINDS = ("file", "archive", "wheel", "sdist-build")
ARCHIVE_FORMATS = ("zip", "tar.gz")
CAPABILITIES = ("always", "zip-url-import")

SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
GIT_SHA_RE = re.compile(r"^[0-9a-f]{40}$")

MUTABLE_REVISIONS = frozenset(
    {"main", "master", "latest", "head", "nightly", "stable", "dev", "tip"}
)

ERROR_CODES = {
    "SCHEMA_ERROR": "SCHEMA_ERROR",
    "MISSING_HASH": "MISSING_HASH",
    "DUPLICATE_DEST": "DUPLICATE_DEST",
    "BAD_SIZE": "BAD_SIZE",
    "BAD_PLATFORM": "BAD_PLATFORM",
    "MUTABLE_REVISION": "MUTABLE_REVISION",
    "DISALLOWED_HOST": "DISALLOWED_HOST",
    "UV_LOCK_MISMATCH": "UV_LOCK_MISMATCH",
    "PYTHON_VERSION_MISMATCH": "PYTHON_VERSION_MISMATCH",
    "UNEXPECTED_EXECUTABLE": "UNEXPECTED_EXECUTABLE",
    "PATH_ESCAPE": "PATH_ESCAPE",
    "SYMLINK_REJECTED": "SYMLINK_REJECTED",
    "CASE_COLLISION": "CASE_COLLISION",
    "HASH_MISMATCH": "HASH_MISMATCH",
    "SIZE_MISMATCH": "SIZE_MISMATCH",
}


class LockError(Exception):
    def __init__(self, code: str, message: str, details: dict[str, Any] | None = None) -> None:
        super().__init__(message)
        details = details or {}
        self.code = code
        self.message = message
        self.id = details.get("id")
        self.path = details.get("path")

    def to_json(self) -> dict[str, Any]:
        return {
            "code": self.code,
            "id": self.id,
            "path": self.path,
            "message": self.message,
        }


def sha256_hex(data: bytes | bytearray | memoryview | str) -> str:
    if isinstance(data, str):
        data = data.encode("utf-8")
    return hashlib.sha256(data).hexdigest()


def canonicalize(value: Any) -> Any:
    if value is None or not isinstance(value, (dict, list)):
        return value
    if isinstance(value, list):
        return [canonicalize(item) for item in value]
    out: dict[str, Any] = {}
    for key in sorted(value.keys()):
        item = value[key]
        if item is _UNDEFINED:
            continue
        out[key] = canonicalize(item)
    return out


_UNDEFINED = object()


def canonical_json(value: Any) -> str:
    return json.dumps(canonicalize(value), ensure_ascii=False, separators=(",", ":"))


def digest_canonical(value: Any) -> str:
    return sha256_hex(canonical_json(value))


def _canonicalize_member(member: dict[str, Any]) -> dict[str, Any]:
    files = dict(member)
    path = posixpath.normpath(str(files.get("path", "")).replace("\\", "/")).replace("\\", "/")
    files["path"] = path
    return files


def canonicalize_lock(lock: dict[str, Any]) -> dict[str, Any]:
    copy_lock = copy.deepcopy(lock)
    artifacts = copy_lock.get("artifacts")
    if isinstance(artifacts, list):
        normalized = []
        for artifact in artifacts:
            archive = artifact.get("archive") if isinstance(artifact, dict) else None
            if isinstance(archive, dict) and isinstance(archive.get("files"), list):
                archive["files"] = sorted(
                    [_canonicalize_member(f) for f in archive["files"]],
                    key=lambda f: f.get("path", ""),
                )
            if isinstance(artifact, dict) and isinstance(artifact.get("dest"), str):
                artifact["dest"] = artifact["dest"].replace("\\", "/")
            normalized.append(artifact)
        normalized.sort(key=lambda a: a.get("id", "") if isinstance(a, dict) else "")
        copy_lock["artifacts"] = normalized
    models = copy_lock.get("models")
    if isinstance(models, list):
        copy_lock["models"] = sorted(
            models, key=lambda m: m.get("id", "") if isinstance(m, dict) else ""
        )
        for model in copy_lock["models"]:
            if not isinstance(model, dict):
                continue
            model["artifactIds"] = sorted(list(model.get("artifactIds") or []))
            model["dependsOn"] = sorted(list(model.get("dependsOn") or []))
    local_builds = copy_lock.get("localBuilds")
    if isinstance(local_builds, list):
        copy_lock["localBuilds"] = sorted(
            local_builds, key=lambda b: b.get("id", "") if isinstance(b, dict) else ""
        )
    return canonicalize(copy_lock)


def lock_digest(lock: dict[str, Any]) -> str:
    return digest_canonical(canonicalize_lock(lock))


def is_mutable_revision(revision: Any, opts: dict[str, Any] | None = None) -> bool:
    opts = opts or {}
    require_git_sha = bool(opts.get("requireGitSha"))
    if revision is None or revision == "":
        return require_git_sha
    value = str(revision)
    if value.lower() in MUTABLE_REVISIONS:
        return True
    if require_git_sha:
        return GIT_SHA_RE.match(value) is None
    return False


def posix_dest(rel_path: str) -> str:
    return rel_path.replace("\\", "/")


def _is_int(value: Any) -> bool:
    return type(value) is int  # noqa: E721 — bool은 거부


def validate_archive_member(file: Any, artifact_id: str) -> list[LockError]:
    errors: list[LockError] = []
    if file is None or not isinstance(file, dict):
        errors.append(
            LockError(
                ERROR_CODES["SCHEMA_ERROR"],
                "archive member must be an object",
                {"id": artifact_id},
            )
        )
        return errors
    path = file.get("path") if isinstance(file.get("path"), str) else ""
    if not path or "\\" in path:
        errors.append(
            LockError(
                ERROR_CODES["SCHEMA_ERROR"],
                "archive member path must use / separators",
                {"id": artifact_id, "path": path},
            )
        )
    size = file.get("size")
    if not _is_int(size) or size < 0:
        errors.append(
            LockError(
                ERROR_CODES["BAD_SIZE"],
                f"invalid member size for {path}",
                {"id": artifact_id, "path": path},
            )
        )
    sha = file.get("sha256")
    if not isinstance(sha, str) or not SHA256_RE.match(sha):
        errors.append(
            LockError(
                ERROR_CODES["MISSING_HASH"],
                f"missing member sha256 for {path}",
                {"id": artifact_id, "path": path},
            )
        )
    return errors


def validate_artifact_shape(artifact: Any) -> list[LockError]:
    errors: list[LockError] = []
    if artifact is None or not isinstance(artifact, dict) or isinstance(artifact, list):
        errors.append(LockError(ERROR_CODES["SCHEMA_ERROR"], "artifact must be an object"))
        return errors
    ident = artifact["id"] if isinstance(artifact.get("id"), str) else "<unknown>"

    def fail(code: str, message: str) -> None:
        errors.append(LockError(code, message, {"id": ident}))

    if not isinstance(artifact.get("id"), str) or artifact["id"] == "":
        fail(ERROR_CODES["SCHEMA_ERROR"], "missing logical id")
    if artifact.get("kind") not in ARTIFACT_KINDS:
        fail(ERROR_CODES["SCHEMA_ERROR"], f"invalid kind: {artifact.get('kind')}")
    if not isinstance(artifact.get("version"), str) or artifact["version"] == "":
        fail(ERROR_CODES["SCHEMA_ERROR"], "missing version")
    if artifact.get("platform") != SUPPORTED_PLATFORM:
        fail(ERROR_CODES["BAD_PLATFORM"], f"unsupported platform: {artifact.get('platform')}")
    dest = artifact.get("dest")
    if not isinstance(dest, str) or dest == "":
        fail(ERROR_CODES["SCHEMA_ERROR"], "missing dest")
    elif "\\" in dest:
        fail(ERROR_CODES["SCHEMA_ERROR"], f"dest must use / separators: {dest}")
    if not isinstance(artifact.get("source"), str) or artifact["source"] == "":
        fail(ERROR_CODES["SCHEMA_ERROR"], "missing source")
    if not isinstance(artifact.get("license"), str) or artifact["license"] == "":
        fail(ERROR_CODES["SCHEMA_ERROR"], "missing license")
    if artifact.get("capability") is not None and artifact.get("capability") not in CAPABILITIES:
        fail(ERROR_CODES["SCHEMA_ERROR"], f"invalid capability: {artifact.get('capability')}")

    kind = artifact.get("kind")
    url = artifact.get("url")
    if kind != "sdist-build":
        if not isinstance(url, str) or url == "":
            fail(ERROR_CODES["SCHEMA_ERROR"], "missing url")

    size = artifact.get("size")
    if not _is_int(size) or size < 0:
        fail(ERROR_CODES["BAD_SIZE"], f"invalid size: {size}")

    digest = artifact.get("sha256")
    if digest is None or digest == "" or digest == "missing":
        fail(ERROR_CODES["MISSING_HASH"], "missing sha256")
    elif not isinstance(digest, str) or not SHA256_RE.match(digest):
        fail(ERROR_CODES["MISSING_HASH"], "sha256 must be lowercase 64-char hex")
    elif digest != digest.lower():
        fail(ERROR_CODES["MISSING_HASH"], "sha256 must be lowercase")

    if kind == "archive":
        archive = artifact.get("archive")
        if archive is None or not isinstance(archive, dict) or isinstance(archive, list):
            fail(ERROR_CODES["SCHEMA_ERROR"], "archive metadata required")
        else:
            if archive.get("format") not in ARCHIVE_FORMATS:
                fail(
                    ERROR_CODES["SCHEMA_ERROR"],
                    f"invalid archive format: {archive.get('format')}",
                )
            files = archive.get("files")
            if not isinstance(files, list) or len(files) == 0:
                fail(ERROR_CODES["SCHEMA_ERROR"], "archive files allowlist required")
            else:
                for member in files:
                    errors.extend(validate_archive_member(member, ident))

    if kind == "sdist-build" and artifact.get("userPcBuild") is True:
        fail(ERROR_CODES["SCHEMA_ERROR"], "user PC must not build sdists")

    return errors


def validate_lock_shape(lock: Any) -> list[LockError]:
    errors: list[LockError] = []
    if lock is None or not isinstance(lock, dict) or isinstance(lock, list):
        return [LockError(ERROR_CODES["SCHEMA_ERROR"], "lock must be an object")]
    if lock.get("schemaVersion") != SCHEMA_VERSION:
        errors.append(
            LockError(
                ERROR_CODES["SCHEMA_ERROR"],
                f"unsupported schemaVersion: {lock.get('schemaVersion')}",
            )
        )
    if lock.get("kind") not in LOCK_KINDS:
        errors.append(
            LockError(ERROR_CODES["SCHEMA_ERROR"], f"invalid lock kind: {lock.get('kind')}")
        )
    if lock.get("platform") != SUPPORTED_PLATFORM:
        errors.append(
            LockError(
                ERROR_CODES["BAD_PLATFORM"],
                f"unsupported lock platform: {lock.get('platform')}",
            )
        )
    artifacts = lock.get("artifacts")
    if not isinstance(artifacts, list):
        errors.append(LockError(ERROR_CODES["SCHEMA_ERROR"], "artifacts must be an array"))
        return errors

    dests: dict[str, str] = {}
    ids: set[str] = set()
    for artifact in artifacts:
        errors.extend(validate_artifact_shape(artifact))
        if not isinstance(artifact, dict):
            continue
        ident = artifact.get("id")
        if ident in ids:
            errors.append(
                LockError(
                    ERROR_CODES["SCHEMA_ERROR"],
                    f"duplicate artifact id: {ident}",
                    {"id": ident},
                )
            )
        ids.add(ident)
        dests_to_check = [artifact.get("dest")]
        archive = artifact.get("archive")
        if isinstance(archive, dict) and isinstance(archive.get("files"), list):
            for member in archive["files"]:
                if isinstance(member, dict) and member.get("dest"):
                    dests_to_check.append(member["dest"])
        for dest in dests_to_check:
            if not dest:
                continue
            key = str(dest).replace("\\", "/").lower()
            prev = dests.get(key)
            if prev and prev != ident:
                errors.append(
                    LockError(
                        ERROR_CODES["DUPLICATE_DEST"],
                        f"conflicting dest {dest} ({prev} vs {ident})",
                        {"id": ident, "path": dest},
                    )
                )
            else:
                dests[key] = ident

    if lock.get("kind") == "wheels":
        digest = lock.get("uvLockDigest")
        if not isinstance(digest, str) or not digest.startswith("sha256:"):
            errors.append(
                LockError(
                    ERROR_CODES["SCHEMA_ERROR"],
                    "wheels.lock requires uvLockDigest sha256:...",
                )
            )
    if lock.get("kind") == "python" and (
        lock.get("python") is None or not isinstance(lock.get("python"), dict)
    ):
        errors.append(
            LockError(ERROR_CODES["SCHEMA_ERROR"], "python.lock requires python metadata")
        )
    if lock.get("kind") == "models" and not isinstance(lock.get("models"), list):
        errors.append(
            LockError(ERROR_CODES["SCHEMA_ERROR"], "models.lock requires models bindings")
        )
    return errors


def format_errors(errors: list[LockError]) -> str:
    lines = []
    for err in errors:
        prefix = f"{err.id}: " if err.id else ""
        lines.append(f"{err.code} {prefix}{err.message}")
    return "\n".join(lines)
