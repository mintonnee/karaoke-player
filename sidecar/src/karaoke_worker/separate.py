"""separate: Demucs 2-stem 분리 (vocals / no_vocals).

torch/demucs import가 무거워서 함수 내부에서 지연 import한다.
"""

import os
from pathlib import Path
from typing import Any

from .protocol import WorkerError, emit_progress, log

DEFAULT_MODEL = os.environ.get("KARAOKE_DEMUCS_MODEL", "htdemucs_ft")
DEFAULT_DEVICE = os.environ.get("KARAOKE_DEVICE", "auto")


def _resolve_device(requested: str) -> str:
    if requested in ("cpu", "cuda", "mps"):
        return requested
    import torch

    if torch.cuda.is_available():
        return "cuda"
    mps = getattr(torch.backends, "mps", None)
    if mps is not None and mps.is_available():
        return "mps"
    return "cpu"


def separate(input_path: str, out_dir: str, model_name: str, device_arg: str) -> dict[str, Any]:
    src = Path(input_path)
    if not src.is_file():
        raise WorkerError("FILE_NOT_FOUND", f"file not found: {input_path}")

    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)

    device = _resolve_device(device_arg)
    log(f"separate: model={model_name} device={device} input={src}")

    emit_progress("separate", 0, f"loading model {model_name}")
    try:
        from demucs.api import Separator, save_audio
    except ImportError as e:
        raise WorkerError("DEMUCS_MISSING", f"demucs import failed: {e}") from e

    last_pct = -1

    def callback(info: dict[str, Any]) -> None:
        nonlocal last_pct
        if info.get("state") != "end":
            return
        models = max(1, int(info.get("models", 1)))
        length = max(1, int(info.get("audio_length", 1)))
        offset = int(info.get("segment_offset", 0))
        idx = int(info.get("model_idx_in_bag", 0))
        pct = int((idx + min(1.0, offset / length)) / models * 100)
        # shifts 반복으로 offset이 되감기면 진행률이 후퇴할 수 있어 단조 증가로 클램프
        if pct > last_pct:
            last_pct = pct
            emit_progress("separate", min(pct, 99))

    try:
        separator = Separator(model=model_name, device=device, callback=callback, progress=False)
    except Exception as e:
        raise WorkerError("MODEL_LOAD_FAILED", f"failed to load model {model_name}: {e}") from e

    try:
        _, stems = separator.separate_audio_file(str(src))
    except Exception as e:
        if type(e).__name__ == "OutOfMemoryError":
            raise WorkerError("CUDA_OOM", str(e)) from e
        raise WorkerError("SEPARATE_FAILED", f"separation failed: {e}") from e

    if "vocals" not in stems:
        raise WorkerError("SEPARATE_FAILED", f"model produced no vocals stem: {list(stems)}")

    vocal = stems["vocals"]
    inst = None
    for name, tensor in stems.items():
        if name == "vocals":
            continue
        inst = tensor if inst is None else inst + tensor
    if inst is None:
        raise WorkerError("SEPARATE_FAILED", "model produced no instrumental stems")

    vocal_path = out / "vocal.wav"
    inst_path = out / "inst.wav"
    save_audio(vocal, str(vocal_path), samplerate=separator.samplerate)
    save_audio(inst, str(inst_path), samplerate=separator.samplerate)
    emit_progress("separate", 100)

    return {"inst": str(inst_path), "vocal": str(vocal_path)}
