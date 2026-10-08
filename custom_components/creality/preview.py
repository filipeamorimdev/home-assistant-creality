"""Job-scoped thumbnail cache, independent of Home Assistant."""

from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable
from datetime import datetime, timezone
from time import monotonic
from typing import Any

PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"
MAX_IMAGE_BYTES = 2 * 1024 * 1024
REFRESH_SECONDS = 30


class PreviewCache:
    """Bound requests and discard responses belonging to a previous job."""

    def __init__(self) -> None:
        self.job: tuple[str, str, str] | None = None
        self.content: bytes | None = None
        self.updated: datetime | None = None
        self.reason = "no_job"
        self._next_fetch = 0.0
        self._lock = asyncio.Lock()

    def sync_job(self, data: dict[str, Any]) -> None:
        """Clear old images immediately when a different job is observed."""
        filename = str(data.get("printFileName") or "").strip()
        job = (filename, str(data.get("printStartTime") or ""),
               str(data.get("printId") or "")) if filename else None
        if job != self.job:
            self.job = job
            self.content = None
            self.updated = None
            self._next_fetch = 0.0
            self.reason = "pending" if job else "no_job"

    async def refresh(self, fetch: Callable[[], Awaitable[bytes]]) -> None:
        """Refresh at most once per interval, including failed requests."""
        async with self._lock:
            if self.job is None or monotonic() < self._next_fetch:
                return
            job = self.job
            self._next_fetch = monotonic() + REFRESH_SECONDS
            try:
                content = await fetch()
                if not content.startswith(PNG_SIGNATURE) or len(content) > MAX_IMAGE_BYTES:
                    raise ValueError("Invalid or oversized PNG")
            except (OSError, TimeoutError, ValueError):
                if job == self.job:
                    self.reason = "fetch_failed"
                return
            if job != self.job:
                return
            if content != self.content:
                self.content = content
                self.updated = datetime.now(timezone.utc)
            self.reason = "ok"
