"""transcribe: faster-whisper로 보컬을 받아쓴다 (가사 텍스트가 전혀 없을 때의 fallback)."""

import os
import sys
from pathlib import Path
from typing import Any

from .protocol import WorkerError, emit_progress, log

DEFAULT_WHISPER_MODEL = os.environ.get("KARAOKE_WHISPER_MODEL", "large-v3-turbo")


def _expose_torch_cuda_dlls() -> None:
    """Windows에서 ctranslate2가 cuDNN을 찾도록 torch 동봉 DLL 경로를 등록한다."""
    if sys.platform != "win32":
        return
    try:
        import torch

        lib_dir = Path(torch.__file__).parent / "lib"
        if lib_dir.is_dir():
            os.add_dll_directory(str(lib_dir))
            os.environ["PATH"] = f"{lib_dir};{os.environ.get('PATH', '')}"
    except Exception as e:  # noqa: BLE001 — cpu fallback이 있으므로 치명적이지 않다
        log(f"could not expose torch cuda dlls: {e}")


def transcribe(vocal_path: str, lang: str, out_txt: str) -> dict[str, Any]:
    vocal = Path(vocal_path)
    if not vocal.is_file():
        raise WorkerError("FILE_NOT_FOUND", f"vocal file not found: {vocal_path}")

    from .models import get_registry, load_whisper_model

    registry = get_registry()
    model_id = registry.resolve_env_whisper()

    _expose_torch_cuda_dlls()
    emit_progress("transcribe", 0, f"loading whisper model {model_id}")
    prepared = registry.prepare(model_id)

    def _load(device: str, compute_type: str):
        cache_key = ("whisper", model_id, device, compute_type)
        cached = registry.get_loaded(cache_key)
        if cached is not None:
            return cached
        loaded = load_whisper_model(
            prepared, device=device, compute_type=compute_type, local_files_only=True
        )
        registry.remember(cache_key, loaded)
        return loaded

    try:
        model = _load("cuda", "float16")
    except Exception as e:  # noqa: BLE001 — GPU 불가 시 CPU로
        log(f"cuda whisper unavailable ({e}), falling back to cpu int8")
        model = _load("cpu", "int8")

    language = None if lang == "auto" else lang
    segments, info = model.transcribe(str(vocal), language=language, vad_filter=True)

    lines: list[str] = []
    duration = max(1.0, info.duration or 1.0)
    for segment in segments:
        text = segment.text.strip()
        if text:
            lines.append(text)
        emit_progress("transcribe", min(99, int(segment.end / duration * 100)))

    if not lines:
        raise WorkerError("NO_SPEECH", "no lyrics could be transcribed from the vocal track")

    out_path = Path(out_txt)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    emit_progress("transcribe", 100)

    return {"txt": str(out_path), "language": info.language}
