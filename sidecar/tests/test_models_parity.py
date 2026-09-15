"""L1 parity fixture: accept/reject reasonCode가 schema.mjs와 같아야 한다."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from karaoke_worker.models import evaluate_parity

REPO_ROOT = Path(__file__).resolve().parents[2]
PARITY = REPO_ROOT / "scripts" / "__tests__" / "runtime-lock" / "fixtures" / "parity"


def _cases(kind: str) -> list[tuple[str, dict]]:
    base = PARITY / kind
    out = []
    for path in sorted(base.glob("*.json")):
        out.append((path.name, json.loads(path.read_text(encoding="utf-8"))))
    return out


_ACCEPT = _cases("accept")
_REJECT = _cases("reject")


@pytest.mark.parametrize(("name", "data"), _ACCEPT, ids=[c[0] for c in _ACCEPT])
def test_parity_accept(name: str, data: dict) -> None:
    errors = evaluate_parity(data)
    assert data["expected"]["accept"] is True
    assert errors == [], "; ".join(f"{e.code}:{e.message}" for e in errors)


@pytest.mark.parametrize(("name", "data"), _REJECT, ids=[c[0] for c in _REJECT])
def test_parity_reject(name: str, data: dict) -> None:
    errors = evaluate_parity(data)
    assert data["expected"]["accept"] is False
    expected = data["expected"]["reasonCode"]
    codes = [e.code for e in errors]
    assert errors, f"expected rejection {expected}"
    assert expected in codes, f"expected {expected} got {codes}"
