"""align: torchaudio MMS_FA(1130개 언어 MMS 정렬 모델)로 가사 줄 단위 forced alignment.

스펙 §3의 ctc-forced-aligner는 pybind11 소스 빌드가 필요해(이 머신엔 MSVC 없음)
같은 MMS 모델을 내장한 torchaudio.pipelines.MMS_FA로 대체한다 (§7 결정 기록 참조).
"""

import math
import re
from pathlib import Path
from typing import Any

from .protocol import WorkerError, emit_progress, log

# 정렬용 로마자에서 허용할 문자 (MMS_FA 사전은 소문자 라틴)
_LATIN_RE = re.compile(r"[^a-z']")
_STRUCTURE_LINE_RE = re.compile(r"^\s*[\[\(][^\]\)]*[\]\)]\s*$")
_REPEAT_TAIL_RE = re.compile(r"[\(（]?[x×](\d)[\)）]?\s*$", re.IGNORECASE)
_EMISSION_WINDOW_SEC = 30
# 정렬은 실제 발성 시점을 잡지만 가사 표시는 조금 일찍 나오는 게 관례.
# LRCLIB 수동 싱크와 비교(2026-09-01, 폭망)해 보정값 0.3초를 얻었다.
_DISPLAY_LEAD_IN_SEC = 0.3


def preprocess_lines(raw: str) -> list[str]:
    """§4.4 전처리: 구조 표기 줄 제거, (x2) 전개, 빈 줄 제거. 표시용 원문을 유지한다."""
    lines: list[str] = []
    for raw_line in raw.splitlines():
        line = raw_line.strip()
        if not line:
            continue
        if _STRUCTURE_LINE_RE.match(line) and not _REPEAT_TAIL_RE.search(line):
            continue  # [Chorus], (間奏) 같은 구조 표기
        repeat = 1
        m = _REPEAT_TAIL_RE.search(line)
        if m:
            repeat = max(1, int(m.group(1)))
            line = line[: m.start()].strip()
            if not line:
                continue
        lines.extend([line] * repeat)
    return lines


def _to_kana(text: str) -> str:
    try:
        import pyopenjtalk
    except ImportError as e:
        raise WorkerError(
            "JA_NOT_AVAILABLE",
            "pyopenjtalk가 설치되지 않았습니다. `uv sync --extra ja`로 설치하세요.",
        ) from e
    return pyopenjtalk.g2p(text, kana=True)


def _romanize_words(lines: list[str], lang: str) -> tuple[list[list[str]], list[int]]:
    """줄별 정렬용 로마자 단어 목록과, 각 줄의 단어 수를 반환한다."""
    from uroman import Uroman

    ur = Uroman()

    words_per_line: list[list[str]] = []
    for line in lines:
        source = _to_kana(line) if lang == "ja" else line
        words: list[str] = []
        for token in source.split():
            romanized = str(ur.romanize_string(token)).lower()
            cleaned = _LATIN_RE.sub("", romanized)
            if cleaned:
                words.append(cleaned)
        if lang == "ja" and not words and source:
            # 가나 문자열에 공백이 없으면 줄 전체를 한 단어로
            romanized = _LATIN_RE.sub("", str(ur.romanize_string(source)).lower())
            if romanized:
                words = [romanized]
        words_per_line.append(words)
    return words_per_line, [len(w) for w in words_per_line]


def _load_waveform(path: Path, target_sr: int) -> "Any":
    import torch
    import torchaudio

    waveform, sr = torchaudio.load(str(path))
    waveform = waveform.mean(dim=0, keepdim=True)  # mono
    if sr != target_sr:
        waveform = torchaudio.functional.resample(waveform, sr, target_sr)
    return waveform


def _generate_emission(model: "Any", waveform: "Any", sample_rate: int, device: str) -> "Any":
    """긴 곡의 어텐션 메모리 폭발을 피하기 위해 창 단위로 나눠 emission을 이어 붙인다."""
    import torch

    window = _EMISSION_WINDOW_SEC * sample_rate
    chunks = []
    total = waveform.size(1)
    with torch.inference_mode():
        for start in range(0, total, window):
            chunk = waveform[:, start : start + window].to(device)
            emission, _ = model(chunk)
            chunks.append(emission.cpu())
            emit_progress("align", int(min(start + window, total) / total * 60))
    return torch.cat(chunks, dim=1)


def align(vocal_path: str, lyrics_path: str, lang: str, out_lrc: str) -> dict[str, Any]:
    vocal = Path(vocal_path)
    if not vocal.is_file():
        raise WorkerError("FILE_NOT_FOUND", f"vocal file not found: {vocal_path}")
    lyrics_file = Path(lyrics_path)
    if not lyrics_file.is_file():
        raise WorkerError("FILE_NOT_FOUND", f"lyrics file not found: {lyrics_path}")

    display_lines = preprocess_lines(lyrics_file.read_text(encoding="utf-8"))
    if not display_lines:
        raise WorkerError("EMPTY_LYRICS", "no usable lyric lines after preprocessing")

    emit_progress("align", 0, "loading MMS_FA model")
    import torch
    import torchaudio
    import torchaudio.functional as F

    from .separate import _resolve_device

    device = _resolve_device("auto")
    bundle = torchaudio.pipelines.MMS_FA
    model = bundle.get_model(with_star=False).to(device)
    dictionary = bundle.get_dict(star=None)
    sample_rate = bundle.sample_rate

    words_per_line, word_counts = _romanize_words(display_lines, lang)
    flat_words = [w for words in words_per_line for w in words]
    if not flat_words:
        raise WorkerError("EMPTY_LYRICS", "no alignable text after romanization")

    waveform = _load_waveform(vocal, sample_rate)
    emission = _generate_emission(model, waveform, sample_rate, device)
    emit_progress("align", 70, "aligning")

    tokenized = [dictionary[c] for word in flat_words for c in word if c in dictionary]
    char_counts = [sum(1 for c in word if c in dictionary) for word in flat_words]

    targets = torch.tensor([tokenized], dtype=torch.int32)
    aligned_tokens, scores = F.forced_align(emission, targets, blank=0)
    token_spans = F.merge_tokens(aligned_tokens[0], scores[0])

    seconds_per_frame = waveform.size(1) / emission.size(1) / sample_rate

    # 토큰 span을 단어 → 줄로 되감는다
    word_starts: list[float] = []
    word_scores: list[float] = []
    span_idx = 0
    for count in char_counts:
        if count == 0:
            word_starts.append(word_starts[-1] if word_starts else 0.0)
            word_scores.append(0.0)
            continue
        spans = token_spans[span_idx : span_idx + count]
        span_idx += count
        word_starts.append(spans[0].start * seconds_per_frame)
        # merge_tokens의 score는 로그 확률. exp(평균) = 토큰 확률 기하평균(0..1)으로 변환.
        # 가창은 발화보다 확률이 전반적으로 낮아 UI 경고 임계값은 0.1을 쓴다 (§4.4).
        word_scores.append(math.exp(sum(s.score for s in spans) / len(spans)))

    lines_out: list[dict[str, Any]] = []
    cursor = 0
    for text, count in zip(display_lines, word_counts):
        if count == 0:
            log(f"line has no alignable text, skipped: {text}")
            continue
        starts = word_starts[cursor : cursor + count]
        confs = word_scores[cursor : cursor + count]
        cursor += count
        lines_out.append(
            {
                "t": round(max(0.0, starts[0] - _DISPLAY_LEAD_IN_SEC), 3),
                "text": text,
                "conf": round(sum(confs) / len(confs), 3),
            }
        )

    # 드물게 정렬이 시간 역행하면 단조 증가로 보정
    for i in range(1, len(lines_out)):
        if lines_out[i]["t"] < lines_out[i - 1]["t"]:
            lines_out[i]["t"] = lines_out[i - 1]["t"]

    lrc_path = Path(out_lrc)
    lrc_path.parent.mkdir(parents=True, exist_ok=True)
    lrc_path.write_text(_format_lrc(lines_out), encoding="utf-8")
    emit_progress("align", 100)

    return {"lrc": str(lrc_path), "lines": lines_out}


def _format_lrc(lines: list[dict[str, Any]]) -> str:
    out = []
    for line in lines:
        t = float(line["t"])
        minutes = int(t // 60)
        seconds = t - minutes * 60
        out.append(f"[{minutes:02d}:{seconds:05.2f}] {line['text']}")
    return "\n".join(out) + "\n"
