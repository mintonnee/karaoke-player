"""analyze: 반주 스템(inst.wav)에서 BPM과 조성을 추정한다.

BPM은 Beat This!(신경망 비트 트래커), 키는 크로마 + Bellman-Budge 프로파일 템플릿.
BPM 실행 오류는 작업 실패로 전달한다. 비트 미검출과 키 추정 실패는 빈 값을 허용한다.
torch/beat_this import가 무거워서 함수 내부에서 지연 import한다.
"""

import time
from pathlib import Path
from typing import Any

import numpy as np

from .protocol import WorkerError, emit_progress, log
from .separate import DEFAULT_DEVICE, _resolve_device

# 알고리즘 버전. 추정 방식을 바꾸면 올린다 (스펙 002 §1 결정 기록).
# 1 = Krumhansl-Kessler·55–2000 Hz·접기 상한 200, 2 = Bellman-Budge·110–2000 Hz·접기 상한 170.
# 3 = 모델 준비/추론 실패를 성공으로 저장하지 않음. 기존 실패 결과를 백필한다.
ANALYSIS_VERSION = 3

# 조성 표기는 샤프 통일 12음 + 단조 'm' 접미.
PITCH_NAMES = ("C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B")

# Bellman-Budge 조성 프로파일 (인덱스 0 = 으뜸음). 실곡 13곡 대조에서 Krumhansl-Kessler(5곡)보다
# 12곡을 맞혀 채택했다 (스펙 002 §4.5 정확도 대조). KK는 배음이 섞인 크로마에서 딸림조로 쏠린다.
PROFILE_MAJOR = np.array(
    [16.80, 0.86, 12.95, 1.41, 13.49, 11.93, 1.25, 20.28, 1.80, 8.04, 0.62, 10.57],
    dtype=np.float64,
)
PROFILE_MINOR = np.array(
    [18.16, 0.69, 12.99, 13.34, 1.07, 11.15, 1.38, 21.07, 7.49, 1.53, 0.92, 10.21],
    dtype=np.float64,
)

# 키 추정 STFT 파라미터. 킥·베이스 기음이 몰린 110 Hz 아래와 고역 심벌을 대역 제한으로 걷어낸다.
KEY_N_FFT = 8192
KEY_HOP = 4096
KEY_FMIN = 110.0
KEY_FMAX = 2000.0

# BPM 접기 범위. 벗어나면 절반/두 배로 접는다. 상한 170은 "느린 쪽을 기본"으로 두는
# songbpm 관례를 따른 값이다 (스펙 002 §1 결정 기록 v2).
BPM_MIN = 60.0
BPM_MAX = 170.0
MIN_BEATS = 4


def load_mono(input_path: str) -> tuple[np.ndarray, int]:
    """wav를 float32 모노로 읽는다."""
    src = Path(input_path)
    if not src.is_file():
        raise WorkerError("FILE_NOT_FOUND", f"file not found: {input_path}")

    import soundfile as sf

    try:
        data, sr = sf.read(str(src), dtype="float32", always_2d=True)
    except Exception as e:
        raise WorkerError("UNSUPPORTED_FORMAT", f"failed to read audio: {e}") from e

    if data.size == 0 or sr <= 0:
        raise WorkerError("UNSUPPORTED_FORMAT", f"empty audio file: {input_path}")

    return np.ascontiguousarray(data.mean(axis=1), dtype=np.float32), int(sr)


def _pearson(a: np.ndarray, b: np.ndarray) -> float:
    a = a - a.mean()
    b = b - b.mean()
    da = float(np.sqrt((a * a).sum()))
    db = float(np.sqrt((b * b).sum()))
    if da < 1e-12 or db < 1e-12:
        return 0.0
    return float((a * b).sum() / (da * db))


def _chroma(y: np.ndarray, sr: int) -> np.ndarray | None:
    """STFT 크기 스펙트럼을 12 피치 클래스로 접어 로그 압축 후 시간 평균한다."""
    import torch

    if y.size < KEY_N_FFT:
        return None

    signal = torch.from_numpy(np.asarray(y, dtype=np.float32))
    window = torch.hann_window(KEY_N_FFT)
    spec = torch.stft(
        signal,
        n_fft=KEY_N_FFT,
        hop_length=KEY_HOP,
        window=window,
        center=True,
        return_complex=True,
    )
    mag = spec.abs().numpy().astype(np.float64)  # (freq, frame)

    freqs = np.arange(KEY_N_FFT // 2 + 1, dtype=np.float64) * sr / KEY_N_FFT
    band = (freqs >= KEY_FMIN) & (freqs <= KEY_FMAX)
    if not band.any():
        return None

    mag = mag[band]
    pcs = (np.round(69 + 12 * np.log2(freqs[band] / 440.0)).astype(np.int64)) % 12

    # (12, Fb) 원-핫 행렬로 접는다.
    fold = np.zeros((12, pcs.size), dtype=np.float64)
    fold[pcs, np.arange(pcs.size)] = 1.0

    chroma = np.log1p(fold @ mag)  # (12, frame)
    vec = chroma.mean(axis=1)
    peak = float(vec.max())
    if peak < 1e-9:
        return None
    return vec / peak


def estimate_key(y: np.ndarray, sr: int) -> tuple[str | None, float]:
    """파형에서 조성을 추정한다. 체크포인트가 필요 없는 순수 함수."""
    vec = _chroma(y, sr)
    if vec is None:
        return None, 0.0

    scored: list[tuple[float, str]] = []
    for root in range(12):
        scored.append((_pearson(vec, np.roll(PROFILE_MAJOR, root)), PITCH_NAMES[root]))
        scored.append((_pearson(vec, np.roll(PROFILE_MINOR, root)), PITCH_NAMES[root] + "m"))
    scored.sort(key=lambda item: item[0], reverse=True)

    best, name = scored[0]
    second = scored[1][0]
    if best <= 0.0:
        return None, 0.0

    conf = float(np.clip((best - second) / max(abs(best), 1e-9), 0.0, 1.0))
    return name, conf


def estimate_bpm(y: np.ndarray, sr: int, device: str) -> tuple[float | None, float]:
    """Beat This!로 비트 시각을 뽑아 중앙 간격에서 BPM을 구한다."""
    from .models import get_registry, load_beat_this

    registry = get_registry()
    cache_key = ("beat-this-final0", device)
    audio2beats = registry.get_loaded(cache_key)
    if audio2beats is None:
        prepared = registry.prepare("beat-this-final0")
        audio2beats = load_beat_this(prepared, device=device, dbn=False)
        registry.remember(cache_key, audio2beats)
    beats, _downbeats = audio2beats(np.asarray(y, dtype=np.float32), sr)

    beats = np.asarray(beats, dtype=np.float64).ravel()
    if beats.size < MIN_BEATS:
        return None, 0.0

    ibi = np.diff(beats)
    ibi = ibi[ibi > 0]
    if ibi.size < MIN_BEATS - 1:
        return None, 0.0

    median = float(np.median(ibi))
    if median <= 0 or not np.isfinite(median):
        return None, 0.0

    bpm = 60.0 / median
    if not np.isfinite(bpm) or bpm <= 0:
        return None, 0.0
    # 절반/두 배 템포 접기. 무한 루프 방지를 위해 횟수를 제한한다.
    for _ in range(8):
        if bpm > BPM_MAX:
            bpm /= 2.0
        elif bpm < BPM_MIN:
            bpm *= 2.0
        else:
            break

    conf = float(np.clip(1.0 - 4.0 * float(np.std(ibi)) / median, 0.0, 1.0))
    return round(bpm, 1), conf


def analyze(input_path: str, device_arg: str = DEFAULT_DEVICE) -> dict[str, Any]:
    """inst.wav에서 BPM·조성을 추정해 done.result dict를 만든다."""
    emit_progress("analyze", 0, "loading audio")
    t0 = time.perf_counter()
    y, sr = load_mono(input_path)
    t_load = time.perf_counter() - t0
    log(f"analyze: input={input_path} sr={sr} samples={y.size} load={t_load:.2f}s")

    device = _resolve_device(device_arg)
    log(f"analyze: device={device}")

    emit_progress("analyze", 30, "estimating bpm")
    t1 = time.perf_counter()
    bpm: float | None = None
    bpm_conf = 0.0
    try:
        bpm, bpm_conf = estimate_bpm(y, sr, device)
    except WorkerError:
        raise
    except Exception as e:  # noqa: BLE001 — 실행 실패와 정상적인 비트 미검출을 구분한다
        log(f"analyze: bpm estimation failed: {e!r}")
        raise WorkerError("BPM_ANALYSIS_FAILED", f"BPM estimation failed: {e}") from e
    t_bpm = time.perf_counter() - t1
    log(f"analyze: bpm={bpm} conf={bpm_conf:.3f} elapsed={t_bpm:.2f}s")

    emit_progress("analyze", 70, "estimating key")
    t2 = time.perf_counter()
    key: str | None = None
    key_conf = 0.0
    try:
        key, key_conf = estimate_key(y, sr)
    except Exception as e:  # noqa: BLE001 — 키 실패도 독립
        log(f"analyze: key estimation failed: {e!r}")
    t_key = time.perf_counter() - t2
    log(f"analyze: key={key} conf={key_conf:.3f} elapsed={t_key:.2f}s")

    emit_progress("analyze", 100)
    log(f"analyze: total={time.perf_counter() - t0:.2f}s")

    return {
        "bpm": bpm,
        "bpm_conf": round(bpm_conf, 4) if bpm is not None else None,
        "key": key,
        "key_conf": round(key_conf, 4) if key is not None else None,
        "version": ANALYSIS_VERSION,
    }
