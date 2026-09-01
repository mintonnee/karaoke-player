"""cover: 오디오 파일 태그에서 앨범 커버 이미지를 추출한다 (mutagen).

지원: ID3 APIC(mp3/wav), FLAC pictures, MP4 covr(m4a).
출력 파일명은 항상 --out 경로 그대로 쓴다 — PNG 바이트여도 확장자를 바꾸지 않는다
(렌더러 <img>는 매직 바이트로 포맷을 판별하므로 문제없다).
"""

from pathlib import Path
from typing import Any

from .protocol import WorkerError


def _first_picture(audio: Any) -> bytes | None:
    # FLAC
    pictures = getattr(audio, "pictures", None)
    if pictures:
        return bytes(pictures[0].data)
    tags = getattr(audio, "tags", None)
    if tags is None:
        return None
    # ID3 (mp3, ID3 태그를 단 wav)
    getall = getattr(tags, "getall", None)
    if getall is not None:
        apics = getall("APIC")
        if apics:
            return bytes(apics[0].data)
    # MP4 (m4a)
    try:
        covers = tags.get("covr")
    except (KeyError, ValueError, TypeError):
        covers = None
    if covers:
        return bytes(covers[0])
    return None


def cover(input_path: str, out_path: str) -> dict[str, Any]:
    src = Path(input_path)
    if not src.is_file():
        raise WorkerError("FILE_NOT_FOUND", f"input file not found: {input_path}")

    from mutagen import File as MutagenFile

    audio = MutagenFile(str(src))
    data = _first_picture(audio) if audio is not None else None
    if not data:
        return {"cover": None}

    out = Path(out_path)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_bytes(data)
    return {"cover": str(out)}
