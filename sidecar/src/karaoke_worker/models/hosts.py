"""L1 ALLOWED_HOSTS·URL 검사 포트."""

from __future__ import annotations

from urllib.parse import urlparse, urlunparse

from .schema import ERROR_CODES, LockError

ALLOWED_HOSTS = frozenset(
    {
        "github.com",
        "objects.githubusercontent.com",
        "release-assets.githubusercontent.com",
        "github-releases.githubusercontent.com",
        "files.pythonhosted.org",
        "huggingface.co",
        "cas-bridge.xethub.hf.co",
        "cdn-lfs.huggingface.co",
        "download.pytorch.org",
        "download-r2.pytorch.org",
        "dl.fbaipublicfiles.com",
        "cloud.cp.jku.at",
    }
)


def redact_url(url: str) -> str:
    try:
        parsed = urlparse(url)
        if parsed.scheme == "" or parsed.netloc == "":
            return "<invalid-url>"
        host = parsed.hostname or ""
        netloc = host
        if parsed.port:
            netloc = f"{host}:{parsed.port}"
        return urlunparse((parsed.scheme, netloc, parsed.path, "", "", ""))
    except Exception:
        return "<invalid-url>"


def parse_https_url(url: str) -> tuple[str, object]:
    try:
        parsed = urlparse(url)
    except Exception:
        raise LockError(ERROR_CODES["DISALLOWED_HOST"], f"invalid url: {redact_url(url)}") from None
    if parsed.scheme == "" or parsed.netloc == "":
        raise LockError(ERROR_CODES["DISALLOWED_HOST"], f"invalid url: {redact_url(url)}")
    if parsed.scheme != "https":
        raise LockError(
            ERROR_CODES["DISALLOWED_HOST"],
            f"non-HTTPS url: {redact_url(url)}",
            {"path": parsed.hostname},
        )
    host = (parsed.hostname or "").lower()
    return host, parsed


def assert_allowed_url(url: str, details: dict | None = None) -> str:
    details = details or {}
    host, _parsed = parse_https_url(url)
    if host not in ALLOWED_HOSTS:
        raise LockError(
            ERROR_CODES["DISALLOWED_HOST"],
            f"disallowed host: {host}",
            {"id": details.get("id"), "path": host},
        )
    return host


def is_huggingface_url(url: str) -> bool:
    try:
        host, _parsed = parse_https_url(url)
        return host == "huggingface.co" or host.endswith(".huggingface.co") or host.endswith(".hf.co")
    except LockError:
        return False
