"""pronounce: 일본어 가사 줄을 한글 발음 힌트(통용 표기)로 변환.

한자→가나는 align의 pyopenjtalk g2p를 재사용하고, 가나→한글은 통용 표기 규칙
(츠/쟈/츄 계열, ン→ㄴ받침, ッ→ㅅ받침, 장음 생략)으로 변환한다.
외래어 표기법(쓰/자/추)이 아닌 노래방/팬덤 통용 표기를 따른다.
"""

import json
import re
from pathlib import Path
from typing import Any

from .align import _to_kana
from .protocol import WorkerError, emit_progress

# 가나 또는 한자가 있는 줄만 변환 대상 (영어 줄 등은 힌트 없음)
_JA_RE = re.compile(r"[ぁ-ゟ゠-ヿ一-鿿々〆]")

_HANGUL_BASE = 0xAC00
_HANGUL_COUNT = 11172
_JONG_NIEUN = 4  # ㄴ 받침 (ン)
_JONG_SIOS = 19  # ㅅ 받침 (ッ)

# 요음·외래어 조합은 두 글자 우선 매칭
_DIGRAPHS = {
    "キャ": "캬", "キュ": "큐", "キョ": "쿄",
    "ギャ": "갸", "ギュ": "규", "ギョ": "교",
    "シャ": "샤", "シュ": "슈", "ショ": "쇼",
    "ジャ": "쟈", "ジュ": "쥬", "ジョ": "죠",
    "チャ": "챠", "チュ": "츄", "チョ": "쵸",
    "ヂャ": "쟈", "ヂュ": "쥬", "ヂョ": "죠",
    "ニャ": "냐", "ニュ": "뉴", "ニョ": "뇨",
    "ヒャ": "햐", "ヒュ": "휴", "ヒョ": "효",
    "ビャ": "뱌", "ビュ": "뷰", "ビョ": "뵤",
    "ピャ": "퍄", "ピュ": "퓨", "ピョ": "표",
    "ミャ": "먀", "ミュ": "뮤", "ミョ": "묘",
    "リャ": "랴", "リュ": "류", "リョ": "료",
    "ファ": "파", "フィ": "피", "フェ": "페", "フォ": "포", "フュ": "퓨",
    "ヴァ": "바", "ヴィ": "비", "ヴェ": "베", "ヴォ": "보",
    "ウィ": "위", "ウェ": "웨", "ウォ": "워",
    "ティ": "티", "トゥ": "투", "テュ": "튜",
    "ディ": "디", "ドゥ": "두", "デュ": "듀",
    "シェ": "셰", "ジェ": "제", "チェ": "체", "イェ": "예",
    "ツァ": "차", "ツィ": "치", "ツェ": "체", "ツォ": "초",
}

_MONOGRAPHS = {
    "ア": "아", "イ": "이", "ウ": "우", "エ": "에", "オ": "오",
    "カ": "카", "キ": "키", "ク": "쿠", "ケ": "케", "コ": "코",
    "ガ": "가", "ギ": "기", "グ": "구", "ゲ": "게", "ゴ": "고",
    "サ": "사", "シ": "시", "ス": "스", "セ": "세", "ソ": "소",
    "ザ": "자", "ジ": "지", "ズ": "즈", "ゼ": "제", "ゾ": "조",
    "タ": "타", "チ": "치", "ツ": "츠", "テ": "테", "ト": "토",
    "ダ": "다", "ヂ": "지", "ヅ": "즈", "デ": "데", "ド": "도",
    "ナ": "나", "ニ": "니", "ヌ": "누", "ネ": "네", "ノ": "노",
    "ハ": "하", "ヒ": "히", "フ": "후", "ヘ": "헤", "ホ": "호",
    "バ": "바", "ビ": "비", "ブ": "부", "ベ": "베", "ボ": "보",
    "パ": "파", "ピ": "피", "プ": "푸", "ペ": "페", "ポ": "포",
    "マ": "마", "ミ": "미", "ム": "무", "メ": "메", "モ": "모",
    "ヤ": "야", "ユ": "유", "ヨ": "요",
    "ラ": "라", "リ": "리", "ル": "루", "レ": "레", "ロ": "로",
    "ワ": "와", "ヰ": "이", "ヱ": "에", "ヲ": "오",
    "ヴ": "부",
    # 단독으로 남은 소문자 모음은 본래 모음으로
    "ァ": "아", "ィ": "이", "ゥ": "우", "ェ": "에", "ォ": "오",
    "ャ": "야", "ュ": "유", "ョ": "요",
}


def _hira_to_kata(text: str) -> str:
    return "".join(chr(ord(c) + 0x60) if "ぁ" <= c <= "ゖ" else c for c in text)


def _attach_batchim(out: list[str], jong: int, fallback: str) -> None:
    """직전 한글 음절(받침 없음)에 종성을 붙인다. 불가능하면 fallback을 덧붙인다."""
    if out:
        last = out[-1]
        code = ord(last[-1]) - _HANGUL_BASE
        if 0 <= code < _HANGUL_COUNT and code % 28 == 0:
            out[-1] = last[:-1] + chr(_HANGUL_BASE + code + jong)
            return
    if fallback:
        out.append(fallback)


def kana_to_hangul(kana: str) -> str:
    """가나 문자열을 통용 표기 한글로 변환한다. ASCII는 유지, 그 외 미지 문자는 버린다."""
    text = _hira_to_kata(kana)
    out: list[str] = []
    i = 0
    while i < len(text):
        pair = text[i : i + 2]
        if pair in _DIGRAPHS:
            out.append(_DIGRAPHS[pair])
            i += 2
            continue
        ch = text[i]
        if ch == "ー":
            pass  # 장음은 통용 표기에서 생략 (ラーメン→라멘)
        elif ch == "ッ":
            _attach_batchim(out, _JONG_SIOS, fallback="")
        elif ch == "ン":
            _attach_batchim(out, _JONG_NIEUN, fallback="응")
        elif ch in _MONOGRAPHS:
            out.append(_MONOGRAPHS[ch])
        elif ch.isascii():
            out.append(ch)
        i += 1
    return "".join(out).strip()


def pronounce(lyrics_path: str, out_path: str) -> dict[str, Any]:
    """가사 파일(한 줄 = 표시 한 줄)을 읽어 줄별 힌트 JSON을 out_path에 쓴다.

    입력 줄과 1:1 대응을 유지해야 하므로 전처리 없이 줄 그대로 처리한다.
    text 필드는 이후 가사가 바뀌었을 때 렌더러가 스테일 힌트를 걸러내는 기준.
    """
    src = Path(lyrics_path)
    if not src.is_file():
        raise WorkerError("FILE_NOT_FOUND", f"lyrics file not found: {lyrics_path}")

    lines = [line.rstrip("\r") for line in src.read_text(encoding="utf-8").split("\n")]
    emit_progress("pronounce", 0, "converting")
    entries: list[dict[str, str]] = []
    for line in lines:
        hint = kana_to_hangul(_to_kana(line)) if _JA_RE.search(line) else ""
        entries.append({"text": line, "hint": hint})

    out = Path(out_path)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(entries, ensure_ascii=False), encoding="utf-8")
    emit_progress("pronounce", 100)
    return {"out": str(out), "lines": entries}
