"""모델 registry: 등록 ID, 누락, 변조, 미등록 override, single-flight."""

from __future__ import annotations

import hashlib
import json
import os
import threading
import time
from pathlib import Path

import pytest

from karaoke_worker.models import (
    ERROR_CODES,
    ModelError,
    ModelRegistry,
    WaiterCancelled,
    hash_file,
    reset_registry_for_tests,
)
from karaoke_worker.models import registry as registry_mod
from karaoke_worker.protocol import WorkerError
from karaoke_worker.separate import separate

REPO_ROOT = Path(__file__).resolve().parents[2]
LOCK_PATH = REPO_ROOT / "build" / "locks" / "models.lock.json"

DEPLOY_IDS = {
    "htdemucs",
    "htdemucs_ft",
    "hdemucs_mmi",
    "mdx_extra",
    "mdx_extra_q",
    "large-v3-turbo",
    "mms-fa",
    "beat-this-final0",
}

_GIT = "0a363e9161cbc7ed1431c9597a8ceaf0c4f78fcf"


def _sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _artifact(
    ident: str,
    dest: str,
    data: bytes,
    *,
    url: str = "https://dl.fbaipublicfiles.com/demucs/x",
    revision=None,
) -> dict:
    return {
        "id": ident,
        "kind": "file",
        "version": "1",
        "revision": revision,
        "platform": "win32-x64",
        "url": url,
        "size": len(data),
        "sha256": _sha(data),
        "dest": dest,
        "source": "test",
        "license": "MIT",
    }


def _binding(ident: str, artifact_ids: list[str], **extra) -> dict:
    return {
        "id": ident,
        "loader": extra.pop("loader", "test.Loader"),
        "loaderBinding": extra.pop(
            "loaderBinding", {"package": "test", "symbol": "Loader"}
        ),
        "revision": extra.pop("revision", None),
        "license": "MIT",
        "artifactIds": artifact_ids,
        "dependsOn": extra.pop("dependsOn", []),
        **extra,
    }


def _write_lock(path: Path, artifacts: list[dict], models: list[dict]) -> Path:
    payload = {
        "schemaVersion": 1,
        "kind": "models",
        "platform": "win32-x64",
        "artifacts": artifacts,
        "models": models,
    }
    path.write_text(json.dumps(payload), encoding="utf-8")
    return path


def _place(cache: Path, dest: str, data: bytes) -> Path:
    path = cache / dest
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)
    return path


@pytest.fixture(autouse=True)
def _reset_registry() -> None:
    reset_registry_for_tests()
    yield
    reset_registry_for_tests()


def test_real_lock_lists_all_deploy_ids() -> None:
    reg = ModelRegistry(lock_path=LOCK_PATH, cache_root=Path("."))
    ids = set(reg.list_ids())
    assert DEPLOY_IDS <= ids, f"missing {DEPLOY_IDS - ids}"
    for model_id in DEPLOY_IDS:
        assert reg.resolve_id(model_id) == model_id
        binding = reg.get_binding(model_id)
        assert binding["artifactIds"], f"{model_id} must list artifact files"


def test_real_lock_lists_whisper_and_demucs_artifacts() -> None:
    reg = ModelRegistry(lock_path=LOCK_PATH, cache_root=Path("."))
    arts = set(reg.list_artifact_ids())
    assert "whisper-large-v3-turbo-model" in arts
    assert "whisper-large-v3-turbo-config" in arts
    assert "whisper-large-v3-turbo-tokenizer" in arts
    assert "whisper-large-v3-turbo-vocabulary" in arts
    assert "mms-fa-model" in arts
    assert "beat-this-final0" in arts
    assert "htdemucs" in arts
    for member in ("htdemucs_ft.0", "htdemucs_ft.1", "htdemucs_ft.2", "htdemucs_ft.3"):
        assert member in arts


def test_missing_artifact_fails_without_download(tmp_path: Path) -> None:
    data = b"weights"
    art = _artifact("w", "models/w.bin", data)
    lock = _write_lock(
        tmp_path / "models.lock.json",
        [art],
        [_binding("toy", ["w"], loaderBinding={"package": "beat_this.inference", "symbol": "Audio2Beats"})],
    )
    cache = tmp_path / "cache"
    cache.mkdir()
    reg = ModelRegistry(lock_path=lock, cache_root=cache)
    with pytest.raises(ModelError) as excinfo:
        reg.prepare("toy")
    assert excinfo.value.code == "MODEL_NOT_READY"
    assert "auto-download" in excinfo.value.msg


def test_weight_tamper_detected(tmp_path: Path) -> None:
    data = b"weights-ok"
    art = _artifact("w", "models/w.bin", data)
    lock = _write_lock(
        tmp_path / "models.lock.json",
        [art],
        [_binding("toy", ["w"], loaderBinding={"package": "beat_this.inference", "symbol": "X"})],
    )
    cache = tmp_path / "cache"
    path = _place(cache, art["dest"], data)
    reg = ModelRegistry(lock_path=lock, cache_root=cache)
    prepared = reg.prepare("toy")
    assert prepared.checkpoint_path == path
    path.write_bytes(data[:-1] + b"X")
    with pytest.raises(ModelError) as excinfo:
        reg.prepare("toy")
    assert excinfo.value.code == ERROR_CODES["HASH_MISMATCH"]


def test_whisper_config_tamper_detected(tmp_path: Path) -> None:
    files = {
        "config": (b'{"ok": true}', "models/whisper/config.json"),
        "tokenizer": (b'{"tok": 1}', "models/whisper/tokenizer.json"),
        "vocab": (b'{"a": 0}', "models/whisper/vocabulary.json"),
        "pre": (b'{"p": 1}', "models/whisper/preprocessor_config.json"),
        "model": (b"BIN", "models/whisper/model.bin"),
    }
    hf = "https://huggingface.co/mobiuslabsgmbh/faster-whisper-large-v3-turbo/resolve/" + _GIT
    artifacts = [
        _artifact(
            key,
            dest,
            body,
            url=f"{hf}/{Path(dest).name}",
            revision=_GIT,
        )
        for key, (body, dest) in files.items()
    ]
    lock = _write_lock(
        tmp_path / "models.lock.json",
        artifacts,
        [
            _binding(
                "large-v3-turbo",
                [a["id"] for a in artifacts],
                loader="faster_whisper.WhisperModel",
                loaderBinding={"package": "faster_whisper", "symbol": "WhisperModel"},
                revision=_GIT,
                repo="mobiuslabsgmbh/faster-whisper-large-v3-turbo",
                vadAsset="wheel:faster-whisper:assets/silero_vad_v6.onnx",
            )
        ],
    )
    cache = tmp_path / "cache"
    for _key, (body, dest) in files.items():
        _place(cache, dest, body)
    reg = ModelRegistry(lock_path=lock, cache_root=cache)
    prepared = reg.prepare("large-v3-turbo")
    assert prepared.model_dir is not None
    config = cache / "models/whisper/config.json"
    original = files["config"][0]
    config.write_bytes(original[:-1] + b"X")
    with pytest.raises(ModelError) as excinfo:
        reg.prepare("large-v3-turbo")
    assert excinfo.value.code == ERROR_CODES["HASH_MISMATCH"]
    assert excinfo.value.id == "config"


def test_whisper_tokenizer_tamper_detected(tmp_path: Path) -> None:
    cfg, tok, weights = b"cfg", b"tok", b"bin"
    artifacts = [
        _artifact(
            "cfg",
            "models/whisper/config.json",
            cfg,
            url=f"https://huggingface.co/x/y/resolve/{_GIT}/config.json",
            revision=_GIT,
        ),
        _artifact(
            "tok",
            "models/whisper/tokenizer.json",
            tok,
            url=f"https://huggingface.co/x/y/resolve/{_GIT}/tokenizer.json",
            revision=_GIT,
        ),
        _artifact(
            "bin",
            "models/whisper/model.bin",
            weights,
            url=f"https://huggingface.co/x/y/resolve/{_GIT}/model.bin",
            revision=_GIT,
        ),
    ]
    lock = _write_lock(
        tmp_path / "models.lock.json",
        artifacts,
        [
            _binding(
                "large-v3-turbo",
                ["cfg", "tok", "bin"],
                loaderBinding={"package": "faster_whisper", "symbol": "WhisperModel"},
                revision=_GIT,
                repo="x/y",
            )
        ],
    )
    cache = tmp_path / "cache"
    _place(cache, "models/whisper/config.json", cfg)
    tok_path = _place(cache, "models/whisper/tokenizer.json", tok)
    _place(cache, "models/whisper/model.bin", weights)
    reg = ModelRegistry(lock_path=lock, cache_root=cache)
    reg.prepare("large-v3-turbo")
    tok_path.write_bytes(tok[:-1] + b"!")
    with pytest.raises(ModelError) as excinfo:
        reg.prepare("large-v3-turbo")
    assert excinfo.value.code == ERROR_CODES["HASH_MISMATCH"]
    assert excinfo.value.id == "tok"


def test_unregistered_and_url_override_rejected(tmp_path: Path) -> None:
    art = _artifact("w", "models/w.bin", b"x")
    lock = _write_lock(
        tmp_path / "models.lock.json",
        [art],
        [_binding("htdemucs_ft", ["w"], loaderBinding={"package": "demucs", "symbol": "Separator"})],
    )
    reg = ModelRegistry(lock_path=lock, cache_root=tmp_path / "cache")
    with pytest.raises(ModelError) as excinfo:
        reg.resolve_id("not-a-model")
    assert excinfo.value.code == "UNREGISTERED_MODEL"
    with pytest.raises(ModelError) as excinfo:
        reg.resolve_id("https://huggingface.co/evil/model")
    assert excinfo.value.code == "UNREGISTERED_MODEL"
    with pytest.raises(ModelError) as excinfo:
        reg.resolve_id(r"C:\weights\model.th")
    assert excinfo.value.code == "UNREGISTERED_MODEL"
    with pytest.raises(ModelError) as excinfo:
        reg.resolve_id("../models/htdemucs_ft")
    assert excinfo.value.code == "UNREGISTERED_MODEL"


def test_env_override_must_be_registered(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    art = _artifact("w", "models/w.bin", b"x")
    lock = _write_lock(
        tmp_path / "models.lock.json",
        [art],
        [_binding("htdemucs_ft", ["w"])],
    )
    monkeypatch.setenv("KARAOKE_MODELS_LOCK", str(lock))
    monkeypatch.setenv("KARAOKE_MODELS_DIR", str(tmp_path / "cache"))
    monkeypatch.setenv("KARAOKE_DEMUCS_MODEL", "https://evil.example/m.th")
    reset_registry_for_tests()
    wav = tmp_path / "a.wav"
    wav.write_bytes(b"x")
    with pytest.raises(WorkerError) as excinfo:
        separate(str(wav), str(tmp_path / "out"), os.environ["KARAOKE_DEMUCS_MODEL"], "cpu")
    assert excinfo.value.code == "UNREGISTERED_MODEL"


def test_experimental_not_in_deploy_list(tmp_path: Path) -> None:
    prod = _artifact("w", "models/w.bin", b"prod")
    dev = _artifact("e", "models/e.bin", b"dev")
    prod_lock = _write_lock(
        tmp_path / "prod.lock.json",
        [prod],
        [_binding("htdemucs", ["w"])],
    )
    dev_lock = _write_lock(
        tmp_path / "dev.lock.json",
        [dev],
        [_binding("exp-demucs", ["e"])],
    )
    cache = tmp_path / "cache"
    _place(cache, prod["dest"], b"prod")
    _place(cache, dev["dest"], b"dev")
    reg = ModelRegistry(lock_path=prod_lock, cache_root=cache, experimental_lock_path=dev_lock)
    assert "exp-demucs" not in reg.list_ids()
    assert "htdemucs" in reg.list_ids()
    with pytest.raises(ModelError) as excinfo:
        reg.prepare("exp-demucs")
    assert excinfo.value.code == "UNREGISTERED_MODEL"
    prepared = reg.prepare_experimental("exp-demucs")
    assert prepared.id == "exp-demucs"


def test_size_mismatch_detected(tmp_path: Path) -> None:
    data = b"abc"
    art = _artifact("w", "models/w.bin", data)
    lock = _write_lock(
        tmp_path / "models.lock.json",
        [art],
        [_binding("toy", ["w"], loaderBinding={"package": "beat_this.inference", "symbol": "X"})],
    )
    cache = tmp_path / "cache"
    _place(cache, art["dest"], data + b"xx")
    reg = ModelRegistry(lock_path=lock, cache_root=cache)
    with pytest.raises(ModelError) as excinfo:
        reg.prepare("toy")
    assert excinfo.value.code == ERROR_CODES["SIZE_MISMATCH"]


def test_single_flight_hashes_once(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    data = b"shared-weights"
    art = _artifact("w", "models/w.bin", data)
    lock = _write_lock(
        tmp_path / "models.lock.json",
        [art],
        [_binding("toy", ["w"], loaderBinding={"package": "beat_this.inference", "symbol": "X"})],
    )
    cache = tmp_path / "cache"
    _place(cache, art["dest"], data)
    calls: list[Path] = []
    orig = registry_mod.hash_file

    def slow_hash(path: Path) -> str:
        calls.append(path)
        time.sleep(0.15)
        return orig(path)

    monkeypatch.setattr(registry_mod, "hash_file", slow_hash)
    reg = ModelRegistry(lock_path=lock, cache_root=cache)
    results: list[object] = []
    errors: list[BaseException] = []

    def worker() -> None:
        try:
            results.append(reg.prepare("toy"))
        except BaseException as exc:  # noqa: BLE001
            errors.append(exc)

    threads = [threading.Thread(target=worker) for _ in range(3)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert errors == []
    assert len(results) == 3
    assert len(calls) == 1


def test_cancel_is_per_waiter(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    data = b"shared-weights"
    art = _artifact("w", "models/w.bin", data)
    lock = _write_lock(
        tmp_path / "models.lock.json",
        [art],
        [_binding("toy", ["w"], loaderBinding={"package": "beat_this.inference", "symbol": "X"})],
    )
    cache = tmp_path / "cache"
    _place(cache, art["dest"], data)
    orig = registry_mod.hash_file
    started = threading.Event()

    def slow_hash(path: Path) -> str:
        started.set()
        time.sleep(0.25)
        return orig(path)

    monkeypatch.setattr(registry_mod, "hash_file", slow_hash)
    reg = ModelRegistry(lock_path=lock, cache_root=cache)
    cancel = threading.Event()
    cancelled: list[BaseException] = []
    kept: list[object] = []

    def waiter_cancel() -> None:
        try:
            reg.prepare("toy", cancel=cancel)
        except BaseException as exc:  # noqa: BLE001
            cancelled.append(exc)

    def waiter_keep() -> None:
        kept.append(reg.prepare("toy"))

    t1 = threading.Thread(target=waiter_cancel)
    t2 = threading.Thread(target=waiter_keep)
    t1.start()
    assert started.wait(timeout=2)
    cancel.set()
    t2.start()
    t1.join()
    t2.join()
    assert cancelled and isinstance(cancelled[0], WaiterCancelled)
    assert len(kept) == 1


def test_incomplete_tmp_repo_not_ready(tmp_path: Path) -> None:
    data = b"ckpt"
    art = _artifact("htdemucs", "models/demucs/955717e8-deadbeef.th", data)
    lock = _write_lock(
        tmp_path / "models.lock.json",
        [art],
        [
            _binding(
                "htdemucs",
                ["htdemucs"],
                loaderBinding={"package": "demucs", "symbol": "Separator"},
                configSource="wheel:demucs:remote/htdemucs.yaml",
            )
        ],
    )
    cache = tmp_path / "cache"
    _place(cache, art["dest"], data)
    incomplete = cache / ".repos" / ".htdemucs.1.tmp"
    incomplete.mkdir(parents=True)
    (incomplete / "partial.th").write_bytes(b"nope")
    reg = ModelRegistry(lock_path=lock, cache_root=cache)
    prepared = reg.prepare("htdemucs")
    assert prepared.local_repo is not None
    assert prepared.local_repo.is_dir()
    assert (prepared.local_repo / "htdemucs.yaml").is_file()
    assert not (prepared.local_repo / "partial.th").exists()
    assert hash_file(prepared.local_repo / "955717e8-deadbeef.th") == _sha(data)
