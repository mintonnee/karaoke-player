"""스펙 002 기준 1·8: 합성 신호로 analyze의 키·BPM·소요 시간을 검증한다."""

import json
import subprocess
import sys
import time

import numpy as np
import pytest

from karaoke_worker.analyze import (
    ANALYSIS_VERSION,
    analyze,
    estimate_bpm,
    estimate_key,
)

SR = 44100
DURATION = 30.0
BPM = 120.0

# 음이름 → 주파수 (A4=440). C4=60, A3=57.
NOTE_HZ = {n: 440.0 * 2 ** ((n - 69) / 12) for n in range(30, 100)}


# 근음을 강조한 3화음 보이싱 게인(근음, 3음, 5음).
PAD_GAINS = (1.6, 0.7, 0.8)


def _pad(chord_midi: list[int], n: int) -> np.ndarray:
    """지속 화음 패드. 배음은 옥타브(같은 피치 클래스)만 넣어 크로마를 오염시키지 않는다."""
    t = np.arange(n, dtype=np.float64) / SR
    out = np.zeros(n, dtype=np.float64)
    for i, (midi, gain) in enumerate(zip(chord_midi, PAD_GAINS)):
        f = NOTE_HZ[midi]
        phase = 0.37 * i  # 위상 차로 피크 합산을 피한다
        out += gain * np.sin(2 * np.pi * f * t + phase)
        out += 0.4 * gain * np.sin(2 * np.pi * 2 * f * t + phase)
    return out / max(1.0, float(np.abs(out).max()))


def _kick(n_samples: int) -> np.ndarray:
    """45 Hz 감쇠 사인. 키 검출 대역(55 Hz~) 아래라 크로마에 거의 안 들어간다."""
    t = np.arange(n_samples, dtype=np.float64) / SR
    return np.sin(2 * np.pi * 45.0 * t) * np.exp(-18.0 * t)


def _hat(n_samples: int, rng: np.random.Generator) -> np.ndarray:
    """감쇠 노이즈를 4차 차분으로 고역 강조한 하이햇."""
    t = np.arange(n_samples, dtype=np.float64) / SR
    noise = rng.standard_normal(n_samples + 4)
    high = np.diff(noise, n=4)
    return high / 4.0 * np.exp(-60.0 * t)


def _snare(n_samples: int, rng: np.random.Generator) -> np.ndarray:
    t = np.arange(n_samples, dtype=np.float64) / SR
    noise = rng.standard_normal(n_samples + 2)
    high = np.diff(noise, n=2)
    body = np.sin(2 * np.pi * 190.0 * t)
    return (0.7 * high / 2.0 + 0.3 * body) * np.exp(-28.0 * t)


def make_signal(chord_midi: list[int], seed: int = 7) -> np.ndarray:
    """120 BPM 드럼 패턴 + 지속 화음 패드, 30초 44.1 kHz 모노.

    순수 클릭 대신 킥(저주파 감쇠 사인) + 스네어 + 하이햇 패턴을 쓴다.
    Beat This!가 실제 음악의 로그멜 스펙트럼으로 학습돼 있어 클릭보다 안정적이다.
    """
    rng = np.random.default_rng(seed)
    n = int(DURATION * SR)
    y = 0.35 * _pad(chord_midi, n)

    beat = 60.0 / BPM  # 0.5초
    hit_len = int(0.30 * SR)
    for i in range(int(DURATION / beat)):
        pos = int(i * beat * SR)
        end = min(n, pos + hit_len)
        seg = end - pos
        if seg <= 8:
            continue
        y[pos:end] += 0.9 * _kick(seg)
        if i % 4 in (1, 3):
            y[pos:end] += 0.5 * _snare(seg, rng)
        # 8분음표 하이햇
        for half in (0, 1):
            hpos = pos + int(half * beat / 2 * SR)
            hend = min(n, hpos + int(0.06 * SR))
            if hend - hpos > 8:
                y[hpos:hend] += 0.25 * _hat(hend - hpos, rng)

    return (y / max(1.0, float(np.abs(y).max()) / 0.9)).astype(np.float32)


# n_fft 8192(빈 폭 5.4 Hz) 기준 저역은 인접 반음으로 새 나가므로 5옥타브대를 쓴다.
C_MAJOR = [72, 76, 79]  # C5 E5 G5
A_MINOR = [69, 72, 76]  # A4 C5 E5


@pytest.fixture(scope="module")
def sig_major() -> np.ndarray:
    return make_signal(C_MAJOR)


@pytest.fixture(scope="module")
def sig_minor() -> np.ndarray:
    return make_signal(A_MINOR, seed=11)


# --- 테스트 1: 키 (체크포인트 불필요) ---------------------------------------


def test_estimate_key_major(sig_major: np.ndarray) -> None:
    key, conf = estimate_key(sig_major, SR)
    assert key == "C"
    assert 0.0 <= conf <= 1.0


def test_estimate_key_minor(sig_minor: np.ndarray) -> None:
    key, conf = estimate_key(sig_minor, SR)
    assert key == "Am"
    assert 0.0 <= conf <= 1.0


def test_estimate_key_silence() -> None:
    key, conf = estimate_key(np.zeros(SR * 5, dtype=np.float32), SR)
    assert key is None
    assert conf == 0.0


# --- 테스트 2: BPM (final0 체크포인트 필요) ----------------------------------


def test_estimate_bpm_120(sig_major: np.ndarray) -> None:
    try:
        bpm, conf = estimate_bpm(sig_major, SR, "cpu")
    except Exception as e:  # pragma: no cover - 네트워크 실패 진단용
        pytest.fail(
            "estimate_bpm failed. final0 체크포인트를 내려받지 못했을 수 있다 "
            f"(torch.hub 캐시 확인): {e!r}"
        )
    assert bpm is not None
    assert 119.0 <= bpm <= 121.0
    assert 0.0 <= conf <= 1.0


# --- 테스트 3: end-to-end ----------------------------------------------------


def _write_wav(path, y: np.ndarray) -> str:
    import soundfile as sf

    sf.write(str(path), y, SR, subtype="PCM_16")
    return str(path)


@pytest.fixture(scope="module")
def wav_major(tmp_path_factory, sig_major: np.ndarray) -> str:
    return _write_wav(tmp_path_factory.mktemp("analyze") / "inst.wav", sig_major)


def test_analyze_end_to_end(wav_major: str) -> None:
    result = analyze(wav_major, "cpu")

    assert set(result) == {"bpm", "bpm_conf", "key", "key_conf", "version"}
    assert result["version"] == ANALYSIS_VERSION

    assert isinstance(result["bpm"], float)
    assert 119.0 <= result["bpm"] <= 121.0
    assert isinstance(result["bpm_conf"], float)
    assert 0.0 <= result["bpm_conf"] <= 1.0

    assert result["key"] == "C"
    assert isinstance(result["key_conf"], float)
    assert 0.0 <= result["key_conf"] <= 1.0

    # JSON 직렬화 가능해야 프로토콜에 실린다
    json.dumps(result)


def test_analyze_missing_file(tmp_path) -> None:
    from karaoke_worker.protocol import WorkerError

    with pytest.raises(WorkerError) as excinfo:
        analyze(str(tmp_path / "nope.wav"), "cpu")
    assert excinfo.value.code == "FILE_NOT_FOUND"


def test_analyze_unsupported_format(tmp_path) -> None:
    from karaoke_worker.protocol import WorkerError

    broken = tmp_path / "broken.wav"
    broken.write_bytes(b"not a wav file")
    with pytest.raises(WorkerError) as excinfo:
        analyze(str(broken), "cpu")
    assert excinfo.value.code == "UNSUPPORTED_FORMAT"


# --- 기준 4: 체크포인트 다운로드 실패 격리 ------------------------------------


def test_analyze_without_checkpoint(monkeypatch, wav_major: str) -> None:
    """체크포인트를 못 받으면 bpm만 null이고 key는 정상, 예외는 나가지 않는다."""
    import beat_this.inference as bt

    def fail(*args, **kwargs):
        raise ValueError(("Could not load the checkpoint given the provided name", "final0"))

    monkeypatch.setattr(bt, "load_checkpoint", fail)

    result = analyze(wav_major, "cpu")
    assert result["bpm"] is None
    assert result["bpm_conf"] is None
    assert result["key"] == "C"
    assert isinstance(result["key_conf"], float)


# --- 테스트 4: 소요 시간 상한 (기준 8 비례) -----------------------------------

# 기준 8은 5분 곡 CPU 30초. 30초 신호는 1/10이므로 3초면 충분하나
# 모델 로드/첫 실행 오버헤드를 감안해 20초로 둔다.
ANALYZE_BUDGET_SEC = 20.0


def test_analyze_cpu_within_budget(wav_major: str) -> None:
    started = time.perf_counter()
    analyze(wav_major, "cpu")
    elapsed = time.perf_counter() - started
    assert elapsed < ANALYZE_BUDGET_SEC, f"analyze took {elapsed:.2f}s"


# --- CLI: stdout은 JSON 줄만 -------------------------------------------------


def test_cli_emits_single_json_line(wav_major: str) -> None:
    proc = subprocess.run(
        [sys.executable, "-m", "karaoke_worker.cli", "analyze", "--input", wav_major,
         "--device", "cpu", "--json"],
        capture_output=True,
        text=True,
        encoding="utf-8",
    )
    assert proc.returncode == 0, proc.stderr
    lines = [line for line in proc.stdout.splitlines() if line.strip()]
    events = [json.loads(line) for line in lines]
    assert all(e["type"] in ("progress", "done") for e in events)
    done = [e for e in events if e["type"] == "done"]
    assert len(done) == 1
    assert done[0]["result"]["version"] == ANALYSIS_VERSION
    assert "analyze: total=" in proc.stderr
