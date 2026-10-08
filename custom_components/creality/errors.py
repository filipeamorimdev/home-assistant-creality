"""Load and query the shipped Creality error-code SQLite database."""

from __future__ import annotations

import logging
import sqlite3
from dataclasses import dataclass
from pathlib import Path
from typing import Any

_LOGGER = logging.getLogger(__name__)

_DB_PATH = Path(__file__).parent / "data" / "error_codes.sqlite"

# Keys known to be non-fatal even if wiki category says Error
_FORCE_WARNING_KEYS = frozenset({508})


@dataclass(frozen=True)
class ErrorInfo:
    key: int
    code_label: str
    title: str
    explanation: str
    solution: str
    category: str
    severity: str
    source_url: str

    @property
    def message(self) -> str:
        return self.title or self.explanation or f"Error key {self.key}"


def db_path() -> Path:
    return _DB_PATH


def _connect() -> sqlite3.Connection | None:
    if not _DB_PATH.is_file():
        _LOGGER.debug("Error code DB missing at %s", _DB_PATH)
        return None
    try:
        conn = sqlite3.connect(f"file:{_DB_PATH}?mode=ro", uri=True)
        conn.row_factory = sqlite3.Row
        return conn
    except sqlite3.Error as exc:
        _LOGGER.warning("Failed to open error code DB: %s", exc)
        return None


# The shipped DB is read-only and small: load it once instead of opening the
# file on every telemetry frame (which would block HA's event loop).
_CACHE: dict[int, ErrorInfo] | None = None


def _row_to_info(row: sqlite3.Row) -> ErrorInfo:
    k = int(row["key"])
    severity = row["severity"] or "unknown"
    if k in _FORCE_WARNING_KEYS:
        severity = "warning"
    return ErrorInfo(
        key=k,
        code_label=row["code_label"] or "",
        title=row["title"] or "",
        explanation=row["explanation"] or "",
        solution=row["solution"] or "",
        category=row["category"] or "",
        severity=severity,
        source_url=row["source_url"] or "",
    )


def _load_all() -> dict[int, ErrorInfo]:
    conn = _connect()
    if conn is None:
        return {}
    try:
        rows = conn.execute(
            "SELECT key, code_label, title, explanation, solution, category, severity, source_url "
            "FROM error_codes"
        ).fetchall()
    except sqlite3.Error as exc:
        _LOGGER.warning("Error code DB could not be read: %s", exc)
        return {}
    finally:
        conn.close()
    table: dict[int, ErrorInfo] = {}
    for row in rows:
        try:
            info = _row_to_info(row)
        except (TypeError, ValueError):
            continue
        table[info.key] = info
    return table


def preload() -> None:
    """Load the DB into memory; call from an executor during setup."""
    global _CACHE
    if _CACHE is None:
        _CACHE = _load_all()


def lookup_error(key: Any) -> ErrorInfo | None:
    """Return wiki-backed info for an err.key value, or None."""
    try:
        k = int(key)
    except (TypeError, ValueError):
        return None
    if k == 0:
        return None
    if _CACHE is None:
        preload()  # Fallback for callers that skipped setup (tests, scripts).
    return (_CACHE or {}).get(k)


def is_fatal_error(key: Any) -> bool:
    """True only when the code is known and severity is error."""
    info = lookup_error(key)
    if info is None:
        return False
    return info.severity == "error"
