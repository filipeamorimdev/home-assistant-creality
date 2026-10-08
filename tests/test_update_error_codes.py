"""The daily scraper must not rewrite the DB when the wiki content is unchanged."""

import importlib.util
from pathlib import Path
import sqlite3
import sys
import tempfile
import unittest

SPEC = importlib.util.spec_from_file_location(
    "update_error_codes", Path(__file__).parents[1] / "scripts/update_error_codes.py"
)
scraper = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = scraper
SPEC.loader.exec_module(scraper)

ROWS = {
    101: {"key": 101, "code_label": "E0101", "title": "Nozzle heating failed", "explanation": "x",
          "solution": "Check heater", "category": "Error", "source_url": "https://wiki/1"},
    508: {"key": 508, "code_label": "E0508", "title": "Storage almost full", "explanation": "y",
          "solution": "Delete files", "category": "System", "source_url": "https://wiki/2"},
}


class WriteDbTests(unittest.TestCase):
    def test_unchanged_content_leaves_file_untouched(self):
        with tempfile.TemporaryDirectory() as tmp:
            db = Path(tmp) / "codes.sqlite"
            self.assertEqual(scraper.write_db(db, ROWS), 2)
            before = db.read_bytes()
            self.assertEqual(scraper.write_db(db, {k: dict(v) for k, v in ROWS.items()}), 2)
            self.assertEqual(db.read_bytes(), before)

    def test_changed_row_only_updates_its_timestamp(self):
        with tempfile.TemporaryDirectory() as tmp:
            db = Path(tmp) / "codes.sqlite"
            scraper.write_db(db, ROWS)
            conn = sqlite3.connect(db)
            conn.execute("UPDATE error_codes SET updated_at = 'old'")
            conn.commit()
            conn.close()
            changed = {k: dict(v) for k, v in ROWS.items()}
            changed[101]["solution"] = "Replace heater cartridge"
            scraper.write_db(db, changed)
            conn = sqlite3.connect(db)
            stamps = dict(conn.execute("SELECT key, updated_at FROM error_codes"))
            conn.close()
            self.assertEqual(stamps[508], "old")
            self.assertNotEqual(stamps[101], "old")


if __name__ == "__main__":
    unittest.main()
