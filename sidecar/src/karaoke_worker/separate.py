"""separate: Demucs 2-stem 분리 (vocals / no_vocals).

torch/demucs import가 무거워서 함수 내부에서 지연 import한다.
"""

import os
from pathlib import Path
from typing import Any

from .protocol import WorkerError, emit_progress, log

DEFAULT_MODEL = os.environ.get("KARAOKE_DEMUCS_MODEL", "htdemucs_ft")
DEFAULT_DEVICE = os.environ.get("KARAOKE_DEVICE", "auto")
# 랜덤 시프트 평균화 횟수. 늘리면 아티팩트가 줄고 처리 시간이 배수로 늘어난다.
# 실청감 비교(2026-08-31)에서 2가 전반 노이즈를 유의미하게 줄여 기본값으로 채택.
DEFAULT_SHIFTS = int(os.environ.get("KARAOKE_DEMUCS_SHIFTS", "2"))

# 파일 경계(t=0) 아티팩트 완화: 첫 세그먼트는 앞쪽 컨텍스트가 없어 지터가 생기므로
# 앞뒤로 무음을 패딩해 분리한 뒤 잘라낸다.
EDGE_PAD_SEC = 1.0


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


def separate(
    input_path: str, out_dir: str, model_name: str, device_arg: str, shifts: int = DEFAULT_SHIFTS
) -> dict[str, Any]:
    src = Path(input_path)
    if not src.is_file():
        raise WorkerError("FILE_NOT_FOUND", f"file not found: {input_path}")

    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)

    device = _resolve_device(device_arg)
    log(f"separate: model={model_name} device={device} shifts={shifts} input={src}")

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
        separator = Separator(
            model=model_name, device=device, shifts=shifts, callback=callback, progress=False
        )
    except Exception as e:
        raise WorkerError("MODEL_LOAD_FAILED", f"failed to load model {model_name}: {e}") from e

    import torch

    try:
        # 공개 API에 로더가 따로 없어 내부 로더를 사용한다 (sphn → ffmpeg 폴백,
        # 모델 샘플레이트/채널로 변환된 텐서 반환). 버전은 uv.lock으로 고정.
        wav = separator._load_audio(str(src))  # noqa: SLF001
    except Exception as e:
        raise WorkerError("LOAD_FAILED", f"failed to load audio: {e}") from e

    pad = int(EDGE_PAD_SEC * separator.samplerate)
    padded = torch.nn.functional.pad(wav, (pad, pad))

    try:
        _, stems = separator.separate_tensor(padded, separator.samplerate)
    except Exception as e:
        if type(e).__name__ == "OutOfMemoryError":
            raise WorkerError("CUDA_OOM", str(e)) from e
        raise WorkerError("SEPARATE_FAILED", f"separation failed: {e}") from e

    stems = {name: tensor[..., pad:-pad] for name, tensor in stems.items()}

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
