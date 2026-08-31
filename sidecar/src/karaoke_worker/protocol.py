"""§4.2 사이드카 프로토콜: stdout 한 줄 = JSON 하나. stderr는 로그 전용."""

import json
import sys
from typing import Any


class WorkerError(Exception):
    """emit_error로 보고되는 예상된 실패."""

    def __init__(self, code: str, msg: str):
        super().__init__(msg)
        self.code = code
        self.msg = msg


def _emit(obj: dict[str, Any]) -> None:
    print(json.dumps(obj, ensure_ascii=False), flush=True)


def emit_progress(stage: str, pct: int, msg: str = "") -> None:
    _emit({"type": "progress", "stage": stage, "pct": pct, "msg": msg})


def emit_done(result: dict[str, Any]) -> None:
    _emit({"type": "done", "result": result})


def emit_error(code: str, msg: str) -> None:
    _emit({"type": "error", "code": code, "msg": msg})


def log(msg: str) -> None:
    print(msg, file=sys.stderr, flush=True)
