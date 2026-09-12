"""prepare-pair: MR·가이드를 44100 Hz stereo PCM WAV로 통일한다.

스템 분리 없이 디코딩·리샘플·끝부분 무음 패딩만 수행한다.
torch/torchaudio는 리샘플 또는 soundfile 실패 시에만 지연 import한다.
"""

from pathlib import Path
from typing import Any

import numpy as np

from .protocol import WorkerError, emit_progress, log

TARGET_SR = 44100
PAIR_LENGTH_DELTA_MS = 100
# 100ms * 44100 / 1000 = 4410 프레임. 이 값 이하는 허용, 초과는 거부.
MAX_DELTA_FRAMES = PAIR_LENGTH_DELTA_MS * TARGET_SR // 1000
_GUIDE_NAMES = {"vocal_only": "vocal.wav", "full_mix": "guide.wav"}


def prepare_pair(mr_path: str, guide_path: str | None, out_dir: str, guide_kind: str) -> dict[str, Any]:
    emit_progress("probe", 0, "checking files")
    mr = Path(mr_path)
    guide = Path(guide_path) if guide_path else None
    if not mr.is_file():
        raise WorkerError("FILE_NOT_FOUND", f"file not found: {mr_path}")
    if guide_kind == "none":
        if guide_path is not None:
            raise WorkerError("INVALID_ARGUMENT", "none must not include a guide file")
        import soundfile as sf

        inst = _prepare_track(mr)
        out = Path(out_dir)
        out.mkdir(parents=True, exist_ok=True)
        inst_path = out / "inst.wav"
        tmp_inst = out / "inst.tmp.wav"
        try:
            sf.write(str(tmp_inst), inst, TARGET_SR, subtype="PCM_16")
            tmp_inst.replace(inst_path)
        except Exception:
            tmp_inst.unlink(missing_ok=True)
            raise
        emit_progress("prepare", 100)
        return {"inst": str(inst_path.resolve()), "guide": None, "duration": len(inst) / TARGET_SR}
    if guide is None or not guide.is_file():
        raise WorkerError("FILE_NOT_FOUND", f"file not found: {guide_path}")
    if guide_kind not in _GUIDE_NAMES:
        raise WorkerError("INVALID_ARGUMENT", f"invalid guide-kind: {guide_kind}")
    emit_progress("probe", 100)

    log(f"prepare-pair: kind={guide_kind} mr={mr} guide={guide}")
    emit_progress("prepare", 0, "decoding")
    inst = _prepare_track(mr)
    guide_audio = _prepare_track(guide)
    inst, guide_audio, duration = _match_length(inst, guide_audio)

    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    inst_path, guide_out = _write_pair(out, inst, guide_audio, _GUIDE_NAMES[guide_kind])
    emit_progress("prepare", 100)
    return {
        "inst": str(inst_path.resolve()),
        "guide": str(guide_out.resolve()),
        "duration": duration,
    }


def _prepare_track(path: Path) -> np.ndarray:
    audio, sr = _load_audio(path)
    if sr <= 0 or audio.size == 0 or audio.shape[0] <= 0:
        raise WorkerError("UNSUPPORTED_FORMAT", f"non-positive duration: {path}")
    channels = int(audio.shape[1])
    if channels < 1 or channels >= 3:
        raise WorkerError(
            "CHANNEL_UNSUPPORTED",
            f"expected mono or stereo, got {channels} channels: {path}",
        )
    if sr != TARGET_SR:
        audio = _resample(audio, sr, TARGET_SR)
        if audio.shape[0] <= 0:
            raise WorkerError("UNSUPPORTED_FORMAT", f"non-positive duration: {path}")
    if channels == 1:
        audio = np.repeat(audio, 2, axis=1)
    return np.ascontiguousarray(audio, dtype=np.float32)


def _load_audio(path: Path) -> tuple[np.ndarray, int]:
    errors: list[str] = []
    try:
        return _load_soundfile(path)
    except WorkerError:
        raise
    except Exception as e:
        errors.append(f"soundfile: {e}")
    try:
        return _load_torchaudio(path)
    except WorkerError:
        raise
    except Exception as e:
        errors.append(f"torchaudio: {e}")
    raise WorkerError(
        "UNSUPPORTED_FORMAT",
        f"failed to decode {path}: {'; '.join(errors)}",
    )


def _load_soundfile(path: Path) -> tuple[np.ndarray, int]:
    import soundfile as sf

    data, sr = sf.read(str(path), dtype="float32", always_2d=True)
    return np.ascontiguousarray(data, dtype=np.float32), int(sr)


def _load_torchaudio(path: Path) -> tuple[np.ndarray, int]:
    import torchaudio

    wav, sr = torchaudio.load(str(path))  # (ch, n)
    if wav.numel() == 0:
        raise WorkerError("UNSUPPORTED_FORMAT", f"empty audio file: {path}")
    data = np.ascontiguousarray(wav.numpy().T, dtype=np.float32)
    return data, int(sr)


def _resample(audio: np.ndarray, orig_sr: int, new_sr: int) -> np.ndarray:
    # CPU 텐서만 사용. CUDA 디바이스를 고르지 않는다.
    import torch
    import torchaudio.functional as F

    wav = torch.from_numpy(np.ascontiguousarray(audio.T))
    wav = F.resample(wav, orig_sr, new_sr)
    return np.ascontiguousarray(wav.numpy().T, dtype=np.float32)


def _match_length(
    inst: np.ndarray, guide: np.ndarray
) -> tuple[np.ndarray, np.ndarray, float]:
    n_mr = int(inst.shape[0])
    n_guide = int(guide.shape[0])
    delta = abs(n_mr - n_guide)
    if delta > MAX_DELTA_FRAMES:
        mr_sec = n_mr / TARGET_SR
        guide_sec = n_guide / TARGET_SR
        delta_ms = delta * 1000.0 / TARGET_SR
        raise WorkerError(
            "LENGTH_MISMATCH",
            f"length delta {delta_ms:.3f}ms exceeds {PAIR_LENGTH_DELTA_MS}ms "
            f"(MR {mr_sec:.6f}s, guide {guide_sec:.6f}s)",
        )
    n = max(n_mr, n_guide)
    if n_mr < n:
        inst = np.pad(inst, ((0, n - n_mr), (0, 0)))
    if n_guide < n:
        guide = np.pad(guide, ((0, n - n_guide), (0, 0)))
    return inst, guide, n / TARGET_SR


def _write_pair(
    out: Path, inst: np.ndarray, guide: np.ndarray, guide_name: str
) -> tuple[Path, Path]:
    import soundfile as sf

    inst_path = out / "inst.wav"
    guide_path = out / guide_name
    tmp_inst = out / "inst.tmp.wav"
    tmp_guide = out / f"{Path(guide_name).stem}.tmp.wav"
    try:
        sf.write(str(tmp_inst), inst, TARGET_SR, subtype="PCM_16")
        sf.write(str(tmp_guide), guide, TARGET_SR, subtype="PCM_16")
        tmp_inst.replace(inst_path)
        tmp_guide.replace(guide_path)
    except Exception:
        tmp_inst.unlink(missing_ok=True)
        tmp_guide.unlink(missing_ok=True)
        inst_path.unlink(missing_ok=True)
        guide_path.unlink(missing_ok=True)
        raise
    return inst_path, guide_path
