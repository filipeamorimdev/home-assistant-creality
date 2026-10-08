"""Error-code DB lookups are cached instead of reopening SQLite per frame."""

import importlib.util
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location(
    "creality_errors", Path(__file__).parents[1] / "custom_components/creality/errors.py"
)
errors = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = errors  # dataclasses resolve annotations via sys.modules
SPEC.loader.exec_module(errors)


class ErrorLookupTests(unittest.TestCase):
    def setUp(self):
        errors._CACHE = None

    def test_db_is_opened_once(self):
        with patch.object(errors, "_connect", wraps=errors._connect) as connect:
            first = errors.lookup_error(508)
            errors.lookup_error(508)
            errors.lookup_error("508")
            errors.is_fatal_error(508)
        self.assertEqual(connect.call_count, 1)
        self.assertIsNotNone(first)
        self.assertEqual(first.severity, "warning")
        self.assertFalse(errors.is_fatal_error(508))

    def test_unknown_and_zero_keys(self):
        self.assertIsNone(errors.lookup_error(0))
        self.assertIsNone(errors.lookup_error("not-a-key"))
        self.assertIsNone(errors.lookup_error(999999999))

    def test_missing_db_degrades_to_no_info(self):
        with patch.object(errors, "_DB_PATH", Path("/nonexistent/error_codes.sqlite")):
            self.assertIsNone(errors.lookup_error(508))


if __name__ == "__main__":
    unittest.main()
