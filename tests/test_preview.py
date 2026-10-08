"""Thumbnail lifecycle tests without requiring a Home Assistant installation."""

import asyncio
import importlib.util
from pathlib import Path
import unittest
from unittest.mock import AsyncMock, patch

SPEC = importlib.util.spec_from_file_location(
    "creality_preview", Path(__file__).parents[1] / "custom_components/creality/preview.py"
)
preview = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(preview)
PNG = preview.PNG_SIGNATURE + b"test-image"
JOB = {"printFileName": "test.gcode", "printStartTime": 100, "state": 1}


class PreviewTests(unittest.IsolatedAsyncioTestCase):
    async def test_fetch_cache_and_content_timestamp(self):
        cache = preview.PreviewCache()
        cache.sync_job(JOB)
        fetch = AsyncMock(return_value=PNG)
        with patch.object(preview, "monotonic", return_value=100):
            await asyncio.gather(cache.refresh(fetch), cache.refresh(fetch))
        self.assertEqual(fetch.await_count, 1)
        self.assertEqual(cache.content, PNG)
        timestamp = cache.updated
        self.assertIsNotNone(timestamp.tzinfo)
        with patch.object(preview, "monotonic", return_value=131):
            await cache.refresh(fetch)
        self.assertEqual(cache.updated, timestamp)
        fetch.return_value = PNG + b"new"
        with patch.object(preview, "monotonic", return_value=162):
            await cache.refresh(fetch)
        self.assertEqual(cache.content, PNG + b"new")
        self.assertGreaterEqual(cache.updated, timestamp)

    async def test_same_filename_new_start_clears_old_preview(self):
        cache = preview.PreviewCache()
        cache.sync_job(JOB)
        await cache.refresh(AsyncMock(return_value=PNG))
        cache.sync_job({**JOB, "printStartTime": 200})
        self.assertIsNone(cache.content)
        self.assertIsNone(cache.updated)
        await cache.refresh(AsyncMock(side_effect=OSError("offline")))
        self.assertIsNone(cache.content)
        self.assertEqual(cache.reason, "fetch_failed")

    async def test_no_job_and_clear_filename(self):
        cache = preview.PreviewCache()
        fetch = AsyncMock(return_value=PNG)
        await cache.refresh(fetch)
        fetch.assert_not_awaited()
        cache.sync_job(JOB)
        await cache.refresh(fetch)
        cache.sync_job({})
        self.assertIsNone(cache.content)
        self.assertEqual(cache.reason, "no_job")

    async def test_pause_and_finish_keep_same_job(self):
        cache = preview.PreviewCache()
        cache.sync_job(JOB)
        await cache.refresh(AsyncMock(return_value=PNG))
        for state in (5, 2):
            cache.sync_job({**JOB, "state": state})
            self.assertEqual(cache.content, PNG)

    async def test_invalid_and_oversize_responses_are_throttled(self):
        for data in (b"", b"<html>404</html>", PNG + bytes(preview.MAX_IMAGE_BYTES)):
            cache = preview.PreviewCache()
            cache.sync_job(JOB)
            fetch = AsyncMock(return_value=data)
            await cache.refresh(fetch)
            await cache.refresh(fetch)
            self.assertIsNone(cache.content)
            self.assertEqual(cache.reason, "fetch_failed")
            self.assertEqual(fetch.await_count, 1)

    async def test_changed_job_discards_inflight_response(self):
        cache = preview.PreviewCache()
        cache.sync_job(JOB)
        async def fetch():
            cache.sync_job({**JOB, "printFileName": "other.gcode"})
            return PNG
        await cache.refresh(fetch)
        self.assertIsNone(cache.content)
        self.assertEqual(cache.reason, "pending")

    async def test_same_job_failure_keeps_cached_image(self):
        cache = preview.PreviewCache()
        cache.sync_job(JOB)
        with patch.object(preview, "monotonic", return_value=100):
            await cache.refresh(AsyncMock(return_value=PNG))
        with patch.object(preview, "monotonic", return_value=131):
            await cache.refresh(AsyncMock(side_effect=TimeoutError))
        self.assertEqual(cache.content, PNG)
        self.assertEqual(cache.reason, "fetch_failed")


if __name__ == "__main__":
    unittest.main()
