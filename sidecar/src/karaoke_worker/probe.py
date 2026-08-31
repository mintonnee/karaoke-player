"""probe: mutagen으로 오디오 메타데이터를 추출한다."""

from pathlib import Path
from typing import Any

from mutagen import File as MutagenFile

from .protocol import WorkerError


def _first_tag(audio: Any, key: str) -> str | None:
    if audio.tags is None:
        return None
    values = audio.tags.get(key)
    if not values:
        return None
    value = values[0] if isinstance(values, list) else values
    text = str(value).strip()
    return text or None


def probe(input_path: str) -> dict[str, Any]:
    path = Path(input_path)
    if not path.is_file():
        raise WorkerError("FILE_NOT_FOUND", f"file not found: {input_path}")

    audio = MutagenFile(path, easy=True)
    if audio is None or audio.info is None:
        raise WorkerError("UNSUPPORTED_FORMAT", f"unsupported or corrupt audio file: {input_path}")

    result: dict[str, Any] = {
        "duration": float(audio.info.length),
        "sample_rate": int(getattr(audio.info, "sample_rate", 0)),
        "channels": int(getattr(audio.info, "channels", 0)),
    }
    for key in ("title", "artist", "album"):
        value = _first_tag(audio, key)
        if value is not None:
            result[key] = value
    return result
