"""karaoke_worker CLI 엔트리포인트.

사용법: karaoke_worker <cmd> --json
S0에서는 probe만 구현한다. separate/align/transcribe는 해당 슬라이스에서 추가.
"""

import argparse
import sys

from .probe import probe
from .protocol import WorkerError, emit_done, emit_error, log


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="karaoke_worker")
    sub = parser.add_subparsers(dest="command", required=True)

    probe_parser = sub.add_parser("probe", help="extract audio metadata")
    probe_parser.add_argument("--input", required=True)
    probe_parser.add_argument("--json", action="store_true", default=True)

    separate_parser = sub.add_parser("separate", help="demucs 2-stem separation")
    separate_parser.add_argument("--input", required=True)
    separate_parser.add_argument("--out", required=True)
    separate_parser.add_argument("--model", default=None)
    separate_parser.add_argument("--device", default=None)
    separate_parser.add_argument("--shifts", type=int, default=None)
    separate_parser.add_argument("--json", action="store_true", default=True)

    align_parser = sub.add_parser("align", help="forced-align lyrics to vocal track")
    align_parser.add_argument("--vocal", required=True)
    align_parser.add_argument("--lyrics", required=True)
    align_parser.add_argument("--lang", choices=["ja", "ko", "en"], required=True)
    align_parser.add_argument("--out", required=True)
    align_parser.add_argument("--json", action="store_true", default=True)

    transcribe_parser = sub.add_parser("transcribe", help="transcribe vocal with faster-whisper")
    transcribe_parser.add_argument("--vocal", required=True)
    transcribe_parser.add_argument("--lang", default="auto")
    transcribe_parser.add_argument("--out", required=True)
    transcribe_parser.add_argument("--json", action="store_true", default=True)

    pronounce_parser = sub.add_parser("pronounce", help="hangul pronunciation hints for ja lyrics")
    pronounce_parser.add_argument("--lyrics", required=True)
    pronounce_parser.add_argument("--out", required=True)
    pronounce_parser.add_argument("--json", action="store_true", default=True)

    cover_parser = sub.add_parser("cover", help="extract embedded album art")
    cover_parser.add_argument("--input", required=True)
    cover_parser.add_argument("--out", required=True)
    cover_parser.add_argument("--json", action="store_true", default=True)

    return parser


def _force_utf8_streams() -> None:
    # Windows에서 stdout이 파이프면 로케일 인코딩(cp949)이 기본이라
    # JSONL의 비ASCII 문자가 깨진다. 프로토콜은 항상 UTF-8로 고정한다.
    for stream in (sys.stdout, sys.stderr):
        reconfigure = getattr(stream, "reconfigure", None)
        if reconfigure is not None:
            reconfigure(encoding="utf-8", errors="replace")


def main() -> None:
    _force_utf8_streams()
    args = build_parser().parse_args()
    try:
        if args.command == "probe":
            emit_done(probe(args.input))
        elif args.command == "separate":
            from .separate import DEFAULT_DEVICE, DEFAULT_MODEL, DEFAULT_SHIFTS, separate

            emit_done(
                separate(
                    args.input,
                    args.out,
                    args.model or DEFAULT_MODEL,
                    args.device or DEFAULT_DEVICE,
                    args.shifts if args.shifts is not None else DEFAULT_SHIFTS,
                )
            )
        elif args.command == "align":
            from .align import align

            emit_done(align(args.vocal, args.lyrics, args.lang, args.out))
        elif args.command == "transcribe":
            from .transcribe import transcribe

            emit_done(transcribe(args.vocal, args.lang, args.out))
        elif args.command == "pronounce":
            from .pronounce import pronounce

            emit_done(pronounce(args.lyrics, args.out))
        elif args.command == "cover":
            from .cover import cover

            emit_done(cover(args.input, args.out))
    except WorkerError as e:
        emit_error(e.code, e.msg)
        sys.exit(1)
    except Exception as e:  # noqa: BLE001 — 프로토콜상 마지막 방어선
        log(f"unhandled exception: {e!r}")
        emit_error("INTERNAL", str(e))
        sys.exit(1)


if __name__ == "__main__":
    main()
