"""스펙 004 기준 3·4: prepare-pair 디코딩·길이·산출물. Demucs를 쓰지 않는다."""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

import numpy as np
import pytest
import soundfile as sf

from karaoke_worker.prepare_pair import (
    PAIR_LENGTH_DELTA_MS,
    TARGET_SR,
    prepare_pair,
)
from karaoke_worker.protocol import WorkerError

SR = TARGET_SR


def test_mr_only_cli_writes_only_inst(tmp_path: Path) -> None:
    mr = _write_wav(tmp_path / "mr.wav", _tone(SR, channels=1))
    out = tmp_path / "out"
    result = _run_cli(["prepare-pair", "--mr", str(mr), "--out", str(out), "--guide-kind", "none"])
    assert result.returncode == 0, result.stderr
    assert sorted(p.name for p in out.iterdir()) == ["inst.wav"]
    audio, sr = _read_wav(out / "inst.wav")
    assert sr == SR and audio.shape == (SR, 2)
    np.testing.assert_array_equal(audio[:, 0], audio[:, 1])
    _pcm16_equal(audio, np.repeat(_read_wav(mr)[0], 2, axis=1))
    done = [e for e in _jsonl(result.stdout) if e.get("type") == "done"]
    assert done[0]["result"]["guide"] is None
    assert done[0]["result"]["duration"] == 1


def test_mr_only_rejects_extra_guide(tmp_path: Path) -> None:
    mr = _write_wav(tmp_path / "mr.wav", _tone(SR))
    with pytest.raises(WorkerError, match="none must not include"):
        prepare_pair(str(mr), str(mr), str(tmp_path / "out"), "none")


def _tone(n: int, sr: int = SR, freq: float = 440.0, channels: int = 2) -> np.ndarray:
    t = np.arange(n, dtype=np.float64) / sr
    mono = (0.25 * np.sin(2 * np.pi * freq * t)).astype(np.float32)
    if channels == 1:
        return mono
    parts = [mono]
    for i in range(1, channels):
        parts.append((0.25 * np.sin(2 * np.pi * freq * (i + 1) * t)).astype(np.float32))
    return np.stack(parts, axis=1)


def _click_then_tone(n: int, click_at: int = 1000) -> np.ndarray:
    """앞 무음 + 클릭. 시작 시점을 옮기거나 앞 무음을 지우면 클릭 위치가 바뀐다."""
    y = _tone(n, freq=330.0)
    y[:click_at] = 0.0
    y[click_at : click_at + 8] = 0.8
    return y


def _write_wav(path: Path, audio: np.ndarray, sr: int = SR) -> Path:
    sf.write(str(path), audio, sr, subtype="PCM_16")
    return path


def _read_wav(path: Path) -> tuple[np.ndarray, int]:
    data, sr = sf.read(str(path), dtype="float32", always_2d=True)
    return data, int(sr)


def _success_wavs(out: Path, guide_kind: str) -> tuple[np.ndarray, np.ndarray]:
    inst, sr_i = _read_wav(out / "inst.wav")
    name = "guide.wav" if guide_kind == "full_mix" else "vocal.wav"
    guide, sr_g = _read_wav(out / name)
    assert sr_i == SR and sr_g == SR
    assert inst.shape[1] == 2 and guide.shape[1] == 2
    assert inst.shape[0] == guide.shape[0]
    unexpected = "vocal.wav" if guide_kind == "full_mix" else "guide.wav"
    assert not (out / unexpected).exists()
    return inst, guide


def _run_cli(args: list[str]) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [sys.executable, "-m", "karaoke_worker", *args],
        capture_output=True,
        text=True,
        encoding="utf-8",
    )


def _jsonl(stdout: str) -> list[dict]:
    return [json.loads(line) for line in stdout.splitlines() if line.strip()]


def _pcm16_equal(a: np.ndarray, b: np.ndarray, atol: float = 2.0 / 32768.0) -> None:
    n = min(a.shape[0], b.shape[0])
    np.testing.assert_allclose(a[:n], b[:n], atol=atol, rtol=0)


def _try_write_mp3(path: Path, audio: np.ndarray, sr: int) -> bool:
    try:
        sf.write(str(path), audio, sr, format="MP3")
        return path.is_file() and path.stat().st_size > 0
    except Exception:
        return False


def _try_write_m4a(path: Path, wav: Path) -> bool:
    import shutil

    ffmpeg = shutil.which("ffmpeg")
    if ffmpeg is None:
        return False
    proc = subprocess.run(
        [ffmpeg, "-hide_banner", "-loglevel", "error", "-y", "-i", str(wav), "-c:a", "aac", str(path)],
        capture_output=True,
        text=True,
        encoding="utf-8",
    )
    return proc.returncode == 0 and path.is_file() and path.stat().st_size > 0


def _can_decode(path: Path) -> bool:
    try:
        _load = __import__("karaoke_worker.prepare_pair", fromlist=["_load_audio"])._load_audio
        _load(path)
        return True
    except WorkerError:
        return False


# --- 정상 경로 ---------------------------------------------------------------


def test_stereo_44100_passthrough(tmp_path: Path) -> None:
    n = SR  # 1s
    mr = _click_then_tone(n)
    guide = _click_then_tone(n, click_at=1500)
    _write_wav(tmp_path / "mr.wav", mr)
    _write_wav(tmp_path / "guide.wav", guide)
    out = tmp_path / "out"
    result = prepare_pair(str(tmp_path / "mr.wav"), str(tmp_path / "guide.wav"), str(out), "vocal_only")

    assert Path(result["inst"]).resolve() == (out / "inst.wav").resolve()
    assert Path(result["guide"]).resolve() == (out / "vocal.wav").resolve()
    assert result["duration"] == pytest.approx(n / SR)
    inst_out, guide_out = _success_wavs(out, "vocal_only")
    assert inst_out.shape[0] == n
    src_mr, _ = _read_wav(tmp_path / "mr.wav")
    src_g, _ = _read_wav(tmp_path / "guide.wav")
    _pcm16_equal(inst_out, src_mr)
    _pcm16_equal(guide_out, src_g)
    # 시작 클릭이 그대로다
    assert int(np.argmax(np.abs(inst_out[:, 0]))) == 1000


def test_full_mix_writes_guide_wav(tmp_path: Path) -> None:
    n = SR // 2
    _write_wav(tmp_path / "mr.wav", _tone(n))
    _write_wav(tmp_path / "g.wav", _tone(n, freq=550.0))
    out = tmp_path / "out"
    result = prepare_pair(str(tmp_path / "mr.wav"), str(tmp_path / "g.wav"), str(out), "full_mix")
    assert Path(result["guide"]).name == "guide.wav"
    _success_wavs(out, "full_mix")


def test_mono_duplicated_to_stereo(tmp_path: Path) -> None:
    n = SR
    mono = _tone(n, channels=1)
    _write_wav(tmp_path / "mr.wav", mono)
    _write_wav(tmp_path / "g.wav", _tone(n, channels=1, freq=660.0))
    out = tmp_path / "out"
    prepare_pair(str(tmp_path / "mr.wav"), str(tmp_path / "g.wav"), str(out), "vocal_only")
    inst, guide = _success_wavs(out, "vocal_only")
    np.testing.assert_allclose(inst[:, 0], inst[:, 1], atol=2.0 / 32768.0)
    np.testing.assert_allclose(guide[:, 0], guide[:, 1], atol=2.0 / 32768.0)
    src, _ = _read_wav(tmp_path / "mr.wav")
    _pcm16_equal(inst[:, 0], src[:, 0])


def test_resample_48000_and_22050_to_44100(tmp_path: Path) -> None:
    dur = 1.0
    mr = _tone(int(dur * 48000), sr=48000)
    guide = _tone(int(dur * 22050), sr=22050, freq=520.0)
    _write_wav(tmp_path / "mr.wav", mr, sr=48000)
    _write_wav(tmp_path / "g.wav", guide, sr=22050)
    out = tmp_path / "out"
    result = prepare_pair(str(tmp_path / "mr.wav"), str(tmp_path / "g.wav"), str(out), "vocal_only")
    inst, guide_out = _success_wavs(out, "vocal_only")
    assert result["duration"] == pytest.approx(inst.shape[0] / SR)
    assert abs(result["duration"] - dur) < 0.02
    # 리샘플만 하고 정규화하지 않는다
    assert float(np.max(np.abs(inst))) < 0.5


def test_flac_roundtrip(tmp_path: Path) -> None:
    n = SR
    audio = _tone(n)
    flac = tmp_path / "mr.flac"
    wav = tmp_path / "g.wav"
    sf.write(str(flac), audio, SR, format="FLAC")
    _write_wav(wav, audio)
    out = tmp_path / "out"
    result = prepare_pair(str(flac), str(wav), str(out), "vocal_only")
    inst, guide = _success_wavs(out, "vocal_only")
    assert inst.shape[0] == guide.shape[0] == n
    assert result["duration"] == pytest.approx(1.0)


def test_mp3_pair_if_codec_available(tmp_path: Path) -> None:
    n = SR * 2
    audio = _tone(n)
    mr = tmp_path / "mr.mp3"
    guide = tmp_path / "g.mp3"
    if not _try_write_mp3(mr, audio, SR) or not _try_write_mp3(guide, _tone(n, freq=500.0), SR):
        pytest.skip("soundfile/libsndfile MP3 encoder unavailable")
    out = tmp_path / "out"
    result = prepare_pair(str(mr), str(guide), str(out), "vocal_only")
    inst, guide_out = _success_wavs(out, "vocal_only")
    assert inst.shape[0] == guide_out.shape[0]
    assert result["duration"] == pytest.approx(inst.shape[0] / SR)
    assert result["duration"] > 0


def test_m4a_pair_if_codec_available(tmp_path: Path) -> None:
    n = SR
    wav_mr = _write_wav(tmp_path / "src_mr.wav", _tone(n))
    wav_g = _write_wav(tmp_path / "src_g.wav", _tone(n, freq=500.0))
    m4a_mr = tmp_path / "mr.m4a"
    m4a_g = tmp_path / "g.m4a"
    if not _try_write_m4a(m4a_mr, wav_mr) or not _try_write_m4a(m4a_g, wav_g):
        pytest.skip("ffmpeg unavailable; cannot generate m4a without network/encoder")
    if not _can_decode(m4a_mr) or not _can_decode(m4a_g):
        pytest.skip("m4a/aac decoder not in sidecar bundle (soundfile/torchaudio)")
    out = tmp_path / "out"
    result = prepare_pair(str(m4a_mr), str(m4a_g), str(out), "full_mix")
    inst, guide = _success_wavs(out, "full_mix")
    assert inst.shape[0] == guide.shape[0]
    assert result["duration"] > 0


# --- 거부 경로 ---------------------------------------------------------------


def test_corrupt_file_errors_and_writes_no_wav(tmp_path: Path) -> None:
    n = SR
    _write_wav(tmp_path / "mr.wav", _tone(n))
    broken = tmp_path / "broken.wav"
    broken.write_bytes(b"not a wav file")
    out = tmp_path / "out"
    out.mkdir()
    with pytest.raises(WorkerError) as excinfo:
        prepare_pair(str(tmp_path / "mr.wav"), str(broken), str(out), "vocal_only")
    assert excinfo.value.code == "UNSUPPORTED_FORMAT"
    assert not (out / "inst.wav").exists()
    assert not (out / "vocal.wav").exists()
    assert not (out / "guide.wav").exists()
    # 확장자만 바꿔 성공 처리하지 않는다
    assert list(out.glob("*.wav")) == []


def test_missing_file(tmp_path: Path) -> None:
    _write_wav(tmp_path / "mr.wav", _tone(SR))
    with pytest.raises(WorkerError) as excinfo:
        prepare_pair(str(tmp_path / "mr.wav"), str(tmp_path / "nope.wav"), str(tmp_path / "out"), "vocal_only")
    assert excinfo.value.code == "FILE_NOT_FOUND"


def test_three_channels_rejected(tmp_path: Path) -> None:
    n = SR
    stereo = _tone(n, channels=2)
    triple = _tone(n, channels=3)
    _write_wav(tmp_path / "mr.wav", stereo)
    _write_wav(tmp_path / "g.wav", triple)
    out = tmp_path / "out"
    with pytest.raises(WorkerError) as excinfo:
        prepare_pair(str(tmp_path / "mr.wav"), str(tmp_path / "g.wav"), str(out), "vocal_only")
    assert excinfo.value.code == "CHANNEL_UNSUPPORTED"
    assert "3" in excinfo.value.msg
    assert not (tmp_path / "out" / "inst.wav").exists()


@pytest.mark.parametrize(
    ("delta_ms", "allowed"),
    [(99, True), (100, True), (101, False)],
)
def test_length_delta_boundary(tmp_path: Path, delta_ms: int, allowed: bool) -> None:
    n_short = SR  # 1s
    extra = int(round(delta_ms * SR / 1000))
    n_long = n_short + extra
    short = _click_then_tone(n_short)
    long = _click_then_tone(n_long, click_at=1000)
    _write_wav(tmp_path / "short.wav", short)
    _write_wav(tmp_path / "long.wav", long)
    out = tmp_path / "out"

    if not allowed:
        with pytest.raises(WorkerError) as excinfo:
            prepare_pair(str(tmp_path / "short.wav"), str(tmp_path / "long.wav"), str(out), "vocal_only")
        assert excinfo.value.code == "LENGTH_MISMATCH"
        msg = excinfo.value.msg
        assert f"{PAIR_LENGTH_DELTA_MS}ms" in msg
        assert "MR " in msg and "guide " in msg
        assert f"{n_short / SR:.6f}s" in msg
        assert f"{n_long / SR:.6f}s" in msg
        assert not (out / "inst.wav").exists()
        return

    result = prepare_pair(str(tmp_path / "short.wav"), str(tmp_path / "long.wav"), str(out), "vocal_only")
    inst, guide = _success_wavs(out, "vocal_only")
    assert inst.shape[0] == guide.shape[0] == n_long
    assert result["duration"] == pytest.approx(n_long / SR)
    src_short, _ = _read_wav(tmp_path / "short.wav")
    src_long, _ = _read_wav(tmp_path / "long.wav")
    # 긴 파일의 앞 N 샘플은 그대로 (시작 시각 이동 없음)
    _pcm16_equal(guide, src_long)
    _pcm16_equal(inst[:n_short], src_short)
    # 패딩은 뒤쪽 무음
    assert np.max(np.abs(inst[n_short:])) == 0.0
    assert int(np.argmax(np.abs(inst[:, 0]))) == 1000
    assert int(np.argmax(np.abs(guide[:, 0]))) == 1000


def test_does_not_peak_normalize(tmp_path: Path) -> None:
    n = SR
    quiet = np.full((n, 2), 0.01, dtype=np.float32)
    _write_wav(tmp_path / "mr.wav", quiet)
    _write_wav(tmp_path / "g.wav", quiet)
    out = tmp_path / "out"
    prepare_pair(str(tmp_path / "mr.wav"), str(tmp_path / "g.wav"), str(out), "vocal_only")
    inst, _ = _success_wavs(out, "vocal_only")
    peak = float(np.max(np.abs(inst)))
    assert 0.005 < peak < 0.03


# --- Demucs 미사용 -----------------------------------------------------------


def test_prepare_pair_module_does_not_reference_demucs() -> None:
    src = Path(__import__("karaoke_worker.prepare_pair", fromlist=["prepare_pair"]).__file__).read_text(
        encoding="utf-8"
    )
    lower = src.lower()
    assert "import demucs" not in src
    assert "from demucs" not in src
    assert "demucs.api" not in src
    assert "separator" not in lower
    assert "torch.hub" not in src
    assert "huggingface" not in lower


def test_prepare_pair_does_not_import_demucs(tmp_path: Path) -> None:
    for name in list(sys.modules):
        if name == "demucs" or name.startswith("demucs."):
            del sys.modules[name]

    n = SR // 4
    _write_wav(tmp_path / "mr.wav", _tone(n))
    _write_wav(tmp_path / "g.wav", _tone(n, freq=500.0))
    prepare_pair(str(tmp_path / "mr.wav"), str(tmp_path / "g.wav"), str(tmp_path / "out"), "vocal_only")

    leftover = [name for name in sys.modules if name == "demucs" or name.startswith("demucs.")]
    assert leftover == []


# --- CLI ---------------------------------------------------------------------


def test_cli_emits_probe_prepare_and_done_jsonl(tmp_path: Path) -> None:
    n = SR // 2
    mr = _write_wav(tmp_path / "mr.wav", _tone(n))
    guide = _write_wav(tmp_path / "g.wav", _tone(n, freq=480.0))
    out = tmp_path / "out"
    proc = _run_cli(
        [
            "prepare-pair",
            "--mr",
            str(mr),
            "--guide",
            str(guide),
            "--out",
            str(out),
            "--guide-kind",
            "vocal_only",
            "--json",
        ]
    )
    assert proc.returncode == 0, proc.stderr
    events = _jsonl(proc.stdout)
    assert events, proc.stdout
    assert all(e["type"] in ("progress", "done") for e in events)
    stages = [e["stage"] for e in events if e["type"] == "progress"]
    assert "probe" in stages
    assert "prepare" in stages
    done = [e for e in events if e["type"] == "done"]
    assert len(done) == 1
    result = done[0]["result"]
    assert Path(result["inst"]).name == "inst.wav"
    assert Path(result["guide"]).name == "vocal.wav"
    assert result["duration"] == pytest.approx(n / SR)
    assert (out / "inst.wav").is_file()
    assert (out / "vocal.wav").is_file()


def test_cli_length_mismatch_jsonl(tmp_path: Path) -> None:
    extra = int(round(101 * SR / 1000))
    _write_wav(tmp_path / "mr.wav", _tone(SR))
    _write_wav(tmp_path / "g.wav", _tone(SR + extra))
    proc = _run_cli(
        [
            "prepare-pair",
            "--mr",
            str(tmp_path / "mr.wav"),
            "--guide",
            str(tmp_path / "g.wav"),
            "--out",
            str(tmp_path / "out"),
            "--guide-kind",
            "full_mix",
            "--json",
        ]
    )
    assert proc.returncode == 1
    events = _jsonl(proc.stdout)
    errors = [e for e in events if e["type"] == "error"]
    assert len(errors) == 1
    assert errors[0]["code"] == "LENGTH_MISMATCH"
    assert f"{PAIR_LENGTH_DELTA_MS}ms" in errors[0]["msg"]
