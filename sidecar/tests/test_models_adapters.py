"""로컬 전용 adapter: 허브 이름/URL이 아니라 검증된 경로를 받는다."""

from __future__ import annotations

import hashlib
import json
from pathlib import Path

import pytest

from karaoke_worker.models import (
    ModelRegistry,
    load_beat_this,
    load_demucs_separator,
    load_mms_fa,
    load_whisper_model,
    reset_registry_for_tests,
)

_GIT = "0a363e9161cbc7ed1431c9597a8ceaf0c4f78fcf"


def _sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _artifact(ident: str, dest: str, data: bytes, **extra) -> dict:
    return {
        "id": ident,
        "kind": "file",
        "version": "1",
        "revision": extra.get("revision"),
        "platform": "win32-x64",
        "url": extra.get("url", "https://dl.fbaipublicfiles.com/demucs/x"),
        "size": len(data),
        "sha256": _sha(data),
        "dest": dest,
        "source": extra.get("source", "test"),
        "license": "MIT",
    }


def _write_lock(path: Path, artifacts: list[dict], models: list[dict]) -> Path:
    path.write_text(
        json.dumps(
            {
                "schemaVersion": 1,
                "kind": "models",
                "platform": "win32-x64",
                "artifacts": artifacts,
                "models": models,
            }
        ),
        encoding="utf-8",
    )
    return path


def _place(cache: Path, dest: str, data: bytes) -> Path:
    path = cache / dest
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)
    return path


@pytest.fixture(autouse=True)
def _reset() -> None:
    reset_registry_for_tests()
    yield
    reset_registry_for_tests()


def _block_network(monkeypatch: pytest.MonkeyPatch) -> list[str]:
    hits: list[str] = []

    def boom(*_a, **_k):
        hits.append("net")
        raise RuntimeError("network blocked")

    import urllib.request

    monkeypatch.setattr(urllib.request, "urlopen", boom)
    monkeypatch.setattr(urllib.request, "urlretrieve", boom)
    try:
        import requests

        monkeypatch.setattr(requests, "get", boom)
        monkeypatch.setattr(requests, "request", boom)
    except ImportError:
        pass
    try:
        import huggingface_hub

        monkeypatch.setattr(huggingface_hub, "hf_hub_download", boom)
        monkeypatch.setattr(huggingface_hub, "snapshot_download", boom)
    except ImportError:
        pass
    try:
        import torch.hub

        monkeypatch.setattr(torch.hub, "load_state_dict_from_url", boom)
        monkeypatch.setattr(torch.hub, "download_url_to_file", boom)
        monkeypatch.setattr(torch.hub, "load", boom)
    except ImportError:
        pass
    return hits


def _demucs_lock(tmp_path: Path, cache: Path, *, bag: bool = False) -> ModelRegistry:
    if bag:
        members = [
            (f"htdemucs_ft.{i}", f"models/demucs/{sig}.th", f"th-{i}".encode())
            for i, sig in enumerate(
                ("f7e0c4bc-ba3fe64a", "d12395a8-e57c48e6", "92cfc3b6-ef3bcb9c", "04573f0d-f3cf25b2")
            )
        ]
        artifacts = [_artifact(i, d, b) for i, d, b in members]
        for _i, dest, body in members:
            _place(cache, dest, body)
        models = [
            {
                "id": "htdemucs_ft",
                "loader": "demucs.api.Separator",
                "loaderBinding": {"package": "demucs", "symbol": "Separator", "argument": "model"},
                "revision": "bag:test",
                "license": "MIT",
                "artifactIds": [m[0] for m in members],
                "dependsOn": [m[0] for m in members],
                "configSource": "wheel:demucs:remote/htdemucs_ft.yaml",
            }
        ]
        model_id = "htdemucs_ft"
    else:
        body = b"htdemucs-th"
        artifacts = [_artifact("htdemucs", "models/demucs/955717e8-8726e21a.th", body)]
        _place(cache, artifacts[0]["dest"], body)
        models = [
            {
                "id": "htdemucs",
                "loader": "demucs.api.Separator",
                "loaderBinding": {"package": "demucs", "symbol": "Separator", "argument": "model"},
                "revision": "955717e8-8726e21a",
                "license": "MIT",
                "artifactIds": ["htdemucs"],
                "dependsOn": [],
                "configSource": "wheel:demucs:remote/htdemucs.yaml",
            }
        ]
        model_id = "htdemucs"
    lock = _write_lock(tmp_path / "models.lock.json", artifacts, models)
    return ModelRegistry(lock_path=lock, cache_root=cache), model_id


def test_demucs_adapter_uses_local_repo(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    cache = tmp_path / "cache"
    reg, model_id = _demucs_lock(tmp_path, cache)
    prepared = reg.prepare(model_id)
    captured: dict = {}

    class FakeSeparator:
        def __init__(self, model, repo=None, **kwargs):
            captured["model"] = model
            captured["repo"] = repo
            captured["kwargs"] = kwargs

    monkeypatch.setattr("demucs.api.Separator", FakeSeparator)
    hits = _block_network(monkeypatch)
    load_demucs_separator(prepared, device="cpu", progress=False)
    assert hits == []
    assert captured["model"] == "htdemucs"
    assert captured["repo"] is not None
    repo = Path(captured["repo"])
    assert repo.is_dir()
    assert (repo / "htdemucs.yaml").is_file()
    assert (repo / "955717e8-8726e21a.th").is_file()
    assert str(captured["repo"]).startswith(str(cache))


def test_demucs_bag_includes_all_members(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    cache = tmp_path / "cache"
    reg, model_id = _demucs_lock(tmp_path, cache, bag=True)
    prepared = reg.prepare(model_id)
    captured: dict = {}

    class FakeSeparator:
        def __init__(self, model, repo=None, **kwargs):
            captured["model"] = model
            captured["repo"] = repo

    monkeypatch.setattr("demucs.api.Separator", FakeSeparator)
    _block_network(monkeypatch)
    load_demucs_separator(prepared, device="cpu", progress=False)
    assert captured["model"] == "htdemucs_ft"
    repo = Path(captured["repo"])
    for name in (
        "f7e0c4bc-ba3fe64a.th",
        "d12395a8-e57c48e6.th",
        "92cfc3b6-ef3bcb9c.th",
        "04573f0d-f3cf25b2.th",
        "htdemucs_ft.yaml",
    ):
        assert (repo / name).is_file(), name


def test_whisper_adapter_uses_local_dir(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    cache = tmp_path / "cache"
    files = {
        "config": b"{}",
        "tokenizer": b"tok",
        "vocabulary": b"{}",
        "preprocessor": b"{}",
        "model": b"bin",
    }
    dests = {
        "config": "models/whisper-large-v3-turbo/config.json",
        "tokenizer": "models/whisper-large-v3-turbo/tokenizer.json",
        "vocabulary": "models/whisper-large-v3-turbo/vocabulary.json",
        "preprocessor": "models/whisper-large-v3-turbo/preprocessor_config.json",
        "model": "models/whisper-large-v3-turbo/model.bin",
    }
    artifacts = [
        _artifact(
            name,
            dests[name],
            body,
            url=f"https://huggingface.co/x/y/resolve/{_GIT}/{Path(dests[name]).name}",
            revision=_GIT,
        )
        for name, body in files.items()
    ]
    for name, body in files.items():
        _place(cache, dests[name], body)
    lock = _write_lock(
        tmp_path / "models.lock.json",
        artifacts,
        [
            {
                "id": "large-v3-turbo",
                "loader": "faster_whisper.WhisperModel",
                "loaderBinding": {"package": "faster_whisper", "symbol": "WhisperModel"},
                "revision": _GIT,
                "repo": "x/y",
                "license": "MIT",
                "artifactIds": [a["id"] for a in artifacts],
                "dependsOn": [],
                "vadAsset": "wheel:faster-whisper:assets/silero_vad_v6.onnx",
            }
        ],
    )
    reg = ModelRegistry(lock_path=lock, cache_root=cache)
    prepared = reg.prepare("large-v3-turbo")
    captured: dict = {}

    class FakeWhisper:
        def __init__(self, model_size_or_path, **kwargs):
            captured["path"] = model_size_or_path
            captured["kwargs"] = kwargs

    monkeypatch.setattr("faster_whisper.WhisperModel", FakeWhisper)
    hits = _block_network(monkeypatch)
    load_whisper_model(prepared, device="cpu", compute_type="int8")
    assert hits == []
    path = Path(captured["path"])
    assert path.is_dir()
    assert path == prepared.model_dir
    assert captured["kwargs"].get("local_files_only") is True
    assert captured["path"] != "large-v3-turbo"


def test_beat_this_adapter_uses_file_path(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    cache = tmp_path / "cache"
    body = b"ckpt"
    art = _artifact("beat-this-final0", "models/beat-this/final0.ckpt", body)
    _place(cache, art["dest"], body)
    lock = _write_lock(
        tmp_path / "models.lock.json",
        [art],
        [
            {
                "id": "beat-this-final0",
                "loader": "beat_this.inference.Audio2Beats",
                "loaderBinding": {
                    "package": "beat_this.inference",
                    "symbol": "Audio2Beats",
                    "argument": "checkpoint_path",
                },
                "revision": None,
                "license": "MIT",
                "artifactIds": ["beat-this-final0"],
                "dependsOn": [],
            }
        ],
    )
    reg = ModelRegistry(lock_path=lock, cache_root=cache)
    prepared = reg.prepare("beat-this-final0")
    captured: dict = {}

    class FakeA2B:
        def __init__(self, checkpoint_path="final0", device="cpu", float16=False, dbn=False):
            captured["checkpoint_path"] = checkpoint_path
            captured["device"] = device

    monkeypatch.setattr("beat_this.inference.Audio2Beats", FakeA2B)
    hits = _block_network(monkeypatch)
    load_beat_this(prepared, device="cpu", dbn=False)
    assert hits == []
    assert captured["checkpoint_path"] != "final0"
    assert Path(captured["checkpoint_path"]).is_file()
    assert Path(captured["checkpoint_path"]) == prepared.checkpoint_path


def test_mms_adapter_loads_local_pt(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    cache = tmp_path / "cache"
    body = b"pt-bytes"
    art = _artifact("mms-fa-model", "models/mms-fa/model.pt", body)
    _place(cache, art["dest"], body)
    lock = _write_lock(
        tmp_path / "models.lock.json",
        [art],
        [
            {
                "id": "mms-fa",
                "loader": "torchaudio.pipelines.MMS_FA",
                "loaderBinding": {"package": "torchaudio.pipelines", "symbol": "MMS_FA"},
                "revision": None,
                "license": "CC-BY-NC-4.0",
                "artifactIds": ["mms-fa-model"],
                "dependsOn": [],
                "dictionarySource": "torchaudio.pipelines.MMS_FA.get_dict",
            }
        ],
    )
    reg = ModelRegistry(lock_path=lock, cache_root=cache)
    prepared = reg.prepare("mms-fa")
    loads: list[str] = []
    get_model_calls: list[str] = []

    def fake_load(path, *args, **kwargs):
        loads.append(str(path))
        return {}

    class FakeModule:
        def load_state_dict(self, *_a, **_k):
            return None

        def eval(self):
            return self

    import torch

    monkeypatch.setattr(torch, "load", fake_load)
    import torchaudio.pipelines

    monkeypatch.setattr(
        torchaudio.pipelines.MMS_FA,
        "get_model",
        lambda *a, **k: get_model_calls.append("get_model") or FakeModule(),
    )
    import torchaudio.pipelines._wav2vec2.utils as wav_utils

    monkeypatch.setattr(wav_utils, "_get_model", lambda *_a, **_k: FakeModule())
    monkeypatch.setattr(wav_utils, "_remove_aux_axes", lambda *_a, **_k: None)
    monkeypatch.setattr(wav_utils, "_extend_model", lambda module, **_k: module)
    hits = _block_network(monkeypatch)
    model, dictionary, sample_rate = load_mms_fa(prepared, with_star=False)
    assert hits == []
    assert get_model_calls == []
    assert loads == [str(prepared.checkpoint_path)]
    assert Path(loads[0]).is_file()
    assert isinstance(dictionary, dict)
    assert sample_rate == 16000
    assert model is not None


def test_missing_bag_member_fails(tmp_path: Path) -> None:
    cache = tmp_path / "cache"
    members = [
        ("htdemucs_ft.0", "models/demucs/f7e0c4bc-ba3fe64a.th", b"a"),
        ("htdemucs_ft.1", "models/demucs/d12395a8-e57c48e6.th", b"b"),
        ("htdemucs_ft.2", "models/demucs/92cfc3b6-ef3bcb9c.th", b"c"),
        ("htdemucs_ft.3", "models/demucs/04573f0d-f3cf25b2.th", b"d"),
    ]
    artifacts = [_artifact(i, d, b) for i, d, b in members]
    for ident, dest, body in members[:3]:
        _place(cache, dest, body)
    lock = _write_lock(
        tmp_path / "models.lock.json",
        artifacts,
        [
            {
                "id": "htdemucs_ft",
                "loader": "demucs.api.Separator",
                "loaderBinding": {"package": "demucs", "symbol": "Separator"},
                "revision": "bag:test",
                "license": "MIT",
                "artifactIds": [m[0] for m in members],
                "dependsOn": [m[0] for m in members],
                "configSource": "wheel:demucs:remote/htdemucs_ft.yaml",
            }
        ],
    )
    from karaoke_worker.models import ModelError

    reg = ModelRegistry(lock_path=lock, cache_root=cache)
    with pytest.raises(ModelError) as excinfo:
        reg.prepare("htdemucs_ft")
    assert excinfo.value.code == "MODEL_NOT_READY"
    assert excinfo.value.id == "htdemucs_ft.3"
