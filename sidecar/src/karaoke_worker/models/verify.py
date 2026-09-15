"""아티팩트 런타임 검증과 L1 parity evaluate."""

from __future__ import annotations

from typing import Any

from .hosts import assert_allowed_url, is_huggingface_url
from .schema import (
    ERROR_CODES,
    GIT_SHA_RE,
    LockError,
    is_mutable_revision,
    validate_artifact_shape,
    validate_lock_shape,
)


def validate_artifact_runtime(artifact: dict[str, Any], lock_kind: str = "models") -> list[LockError]:
    errors: list[LockError] = []
    url = artifact.get("url")
    if url:
        try:
            assert_allowed_url(url, {"id": artifact.get("id")})
        except LockError as err:
            errors.append(err)
        if is_huggingface_url(url):
            if is_mutable_revision(artifact.get("revision"), {"requireGitSha": True}):
                errors.append(
                    LockError(
                        ERROR_CODES["MUTABLE_REVISION"],
                        f"HF artifact requires immutable git SHA: {artifact.get('id')}",
                        {"id": artifact.get("id")},
                    )
                )
    if (
        lock_kind == "models"
        and artifact.get("revision")
        and is_mutable_revision(artifact.get("revision"), {"requireGitSha": True})
    ):
        errors.append(
            LockError(
                ERROR_CODES["MUTABLE_REVISION"],
                f"mutable revision: {artifact.get('revision')}",
                {"id": artifact.get("id")},
            )
        )
    return errors


def validate_model_bindings(lock: dict[str, Any]) -> list[LockError]:
    errors: list[LockError] = []
    if lock.get("kind") != "models":
        return errors
    for model in lock.get("models") or []:
        if not isinstance(model, dict):
            continue
        ident = model.get("id")
        if is_mutable_revision(model.get("revision"), {"requireGitSha": bool(model.get("repo"))}):
            errors.append(
                LockError(
                    ERROR_CODES["MUTABLE_REVISION"],
                    f"mutable revision for model {ident}: {model.get('revision')}",
                    {"id": ident},
                )
            )
        if model.get("repo") and model.get("revision") and not GIT_SHA_RE.match(str(model.get("revision"))):
            errors.append(
                LockError(
                    ERROR_CODES["MUTABLE_REVISION"],
                    f"HF revision must be full git SHA: {ident}",
                    {"id": ident},
                )
            )
    return errors


def evaluate_parity(data: dict[str, Any]) -> list[LockError]:
    """L1 parity.test.mjs evaluate()와 동일."""
    if data.get("lock") is not None:
        return validate_lock_shape(data["lock"])
    shape = validate_artifact_shape(data["entry"])
    runtime = validate_artifact_runtime(data["entry"], "models")
    return [*shape, *runtime]
