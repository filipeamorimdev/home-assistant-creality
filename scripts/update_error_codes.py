#!/usr/bin/env python3
"""Scrape Creality wiki error codes into the shipped SQLite database.

Official sources only (no community forums):
  - K1 Series Error Code Summary (full table: code / popup / explanation / solution)
  - Creality OS Error Code index (letter+number pages: BS/BM/AC/FR/…)
  - CFS Error Code Summary

Lookup key is the numeric part (matches printer ``err.key``). Letter prefixes are
kept in ``code_label`` when known.

Usage:
  python scripts/update_error_codes.py
  python scripts/update_error_codes.py --db path/to/error_codes.sqlite
  python scripts/update_error_codes.py --skip-details
"""

from __future__ import annotations

import argparse
import re
import sqlite3
import sys
import time
from datetime import datetime, timezone
from html.parser import HTMLParser
from pathlib import Path
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_DB = ROOT / "custom_components" / "creality" / "data" / "error_codes.sqlite"

SUMMARY_URL = (
    "https://wiki.creality.com/en/k1-flagship-series/"
    "k1-series-general-documents/error-code-summary"
)
GENERAL_URL = "https://wiki.creality.com/en/printers-general-documents"
CFS_URL = "https://wiki.creality.com/en/cfs/error-code-summary"
DETAIL_BASE = "https://wiki.creality.com/en/printers-general-documents/{slug}"

USER_AGENT = (
    "home-assistant-creality-error-scraper/0.2 "
    "(+https://github.com/filipeamorimdev/home-assistant-creality)"
)

KEY_RE = re.compile(r"Key[：:]\s*(\d+)", re.I)
CODE_LABEL_RE = re.compile(r"\b([A-Z]{1,3})(\d{3,4})\b")
HREF_CODE_RE = re.compile(
    r"/printers-general-documents/((?:[A-Za-z]{1,3})?\d{3,4}(?:-\d{3,4})?)",
    re.I,
)
ONLY_PROMPT_RE = re.compile(r"only\s+prompt", re.I)
AI_PROMPT_RE = re.compile(r"AI\s+detection\s+prompt", re.I)
STORAGE_RE = re.compile(r"storage\s+space", re.I)
HARD_FAULT_RE = re.compile(
    r"paused|stop printing|exception|abnormal|failure|fault|short.?circuit|"
    r"open.?circuit|disconnected|damaged|unable to|homing|thermistor",
    re.I,
)


def fetch(url: str, timeout: float = 40.0) -> str:
    req = Request(url, headers={"User-Agent": USER_AGENT, "Accept": "text/html"})
    with urlopen(req, timeout=timeout) as resp:  # noqa: S310 — intentional wiki fetch
        charset = resp.headers.get_content_charset() or "utf-8"
        return resp.read().decode(charset, errors="replace")


class _HtmlCollector(HTMLParser):
    """Collect table rows, links, and visible text."""

    def __init__(self) -> None:
        super().__init__()
        self._skip = 0
        self._parts: list[str] = []
        self.rows: list[list[str]] = []
        self._row: list[str] | None = None
        self._cell: list[str] | None = None
        self.links: list[str] = []
        self.headings: list[str] = []
        self._in_h = False
        self._h_parts: list[str] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        ad = dict(attrs)
        if tag in ("script", "style", "noscript"):
            self._skip += 1
            return
        if tag == "tr":
            self._row = []
        elif tag in ("td", "th") and self._row is not None:
            self._cell = []
        elif tag == "a" and ad.get("href"):
            self.links.append(ad["href"] or "")
        elif tag in ("h1", "h2", "h3", "h4"):
            self._in_h = True
            self._h_parts = []

    def handle_endtag(self, tag: str) -> None:
        if tag in ("script", "style", "noscript") and self._skip:
            self._skip -= 1
            return
        if tag in ("td", "th") and self._cell is not None and self._row is not None:
            self._row.append(" ".join("".join(self._cell).split()))
            self._cell = None
        elif tag == "tr" and self._row is not None:
            if any(c.strip() for c in self._row):
                self.rows.append(self._row)
            self._row = None
        elif tag in ("h1", "h2", "h3", "h4") and self._in_h:
            self._in_h = False
            text = " ".join("".join(self._h_parts).split())
            if text:
                self.headings.append(text)

    def handle_data(self, data: str) -> None:
        if self._skip:
            return
        if self._cell is not None:
            self._cell.append(data)
        if self._in_h:
            self._h_parts.append(data)
        self._parts.append(data)

    @property
    def text(self) -> str:
        return " ".join("".join(self._parts).split())


def parse_html(html: str) -> _HtmlCollector:
    p = _HtmlCollector()
    p.feed(html)
    p.close()
    return p


def clean(text: str) -> str:
    t = re.sub(r"<[^>]+>", " ", text or "")
    t = t.replace("¶", " ").replace("&nbsp;", " ")
    t = re.sub(r"^[\s\"'>\|：:\-]+", "", t)
    t = " ".join(t.split())
    # Drop leading code echo e.g. "BS0508 : message"
    t = re.sub(r"^[A-Z]{0,3}\d{3,4}\s*[:：]\s*", "", t)
    return t.strip(" /").strip()


def extract_category(popup: str) -> str:
    p = popup or ""
    if AI_PROMPT_RE.search(p):
        return "AI detection prompt"
    if ONLY_PROMPT_RE.search(p):
        return "only prompt"
    if re.search(r"\bError\b", p):
        return "Error"
    if p in ("", "/"):
        return ""
    # First line / clause before Key：
    m = re.match(r"^([^K][^：:]{0,80}?)\s*Key[：:]", p)
    if m:
        return clean(m.group(1))
    return ""


def extract_title(popup: str, explanation: str, code: int) -> str:
    p = clean(popup)
    if p and p != "/":
        # Strip "Error ，Key：508，" prefix → keep human message
        m = KEY_RE.search(p)
        if m:
            after = KEY_RE.sub("", p).strip(" ，,:-")
            # drop leading category words
            after = re.sub(
                r"^(Error|AI detection prompt|only prompt)\s*[，,:\-]*\s*",
                "",
                after,
                flags=re.I,
            )
            return clean(after) or p
        return p
    return clean(explanation) or f"Error key {code}"


def infer_severity(category: str, title: str, explanation: str, solution: str = "") -> str:
    blob = f"{category} {title} {explanation} {solution}"
    if ONLY_PROMPT_RE.search(blob) or AI_PROMPT_RE.search(blob):
        return "warning"
    if STORAGE_RE.search(blob):
        return "warning"
    # Soft AI / calibration fallbacks that continue printing with defaults
    if re.search(r"printing with default values|does not support", blob, re.I):
        return "warning"
    if category.strip().lower() in ("error",) or re.search(r"\bError\b", category):
        return "error"
    if HARD_FAULT_RE.search(blob) and not AI_PROMPT_RE.search(blob):
        # System restart prompts / heater / leveling / motor → error
        if re.search(
            r"thermistor|short.?circuit|open.?circuit|homing|motor drive|"
            r"system error|connection (abnormal|failure)|stop printing|printing paused",
            blob,
            re.I,
        ):
            return "error"
    if category.strip().lower() in ("", "/"):
        if HARD_FAULT_RE.search(blob):
            return "error"
        return "unknown"
    return "warning"


def empty_row(key: int, code_label: str = "") -> dict[str, Any]:
    return {
        "key": key,
        "code_label": code_label or f"BS{key:04d}",
        "title": "",
        "explanation": "",
        "solution": "",
        "category": "",
        "severity": "unknown",
        "source_url": "",
    }


def merge_row(dst: dict[str, Any], src: dict[str, Any], *, prefer_src_label: bool = False) -> None:
    """Merge src into dst, keeping the richer fields."""
    for field in ("title", "explanation", "solution", "category"):
        cur = dst.get(field) or ""
        new = src.get(field) or ""
        if len(new) > len(cur):
            dst[field] = new
        elif not cur and new:
            dst[field] = new
    if prefer_src_label and src.get("code_label"):
        dst["code_label"] = src["code_label"]
    elif not dst.get("code_label") and src.get("code_label"):
        dst["code_label"] = src["code_label"]
    if src.get("source_url") and (
        not dst.get("source_url")
        or ("/printers-general-documents/" in src["source_url"] and "error-code-summary" in (dst.get("source_url") or ""))
    ):
        # Prefer dedicated detail pages over summary URLs
        if "/printers-general-documents/" in src["source_url"] and not src["source_url"].rstrip("/").endswith(
            "printers-general-documents"
        ):
            dst["source_url"] = src["source_url"]
        elif not dst.get("source_url"):
            dst["source_url"] = src["source_url"]
    dst["severity"] = infer_severity(
        dst.get("category", ""),
        dst.get("title", ""),
        dst.get("explanation", ""),
        dst.get("solution", ""),
    )


def rows_from_summary(html: str, source_url: str) -> dict[int, dict[str, Any]]:
    parsed = parse_html(html)
    out: dict[int, dict[str, Any]] = {}
    for cells in parsed.rows:
        if not cells:
            continue
        code_cell = cells[0].strip()
        if not re.fullmatch(r"\d{3,4}", code_cell):
            continue  # skip header / junk
        key = int(code_cell)
        popup = cells[1] if len(cells) > 1 else ""
        explanation = cells[2] if len(cells) > 2 else ""
        solution = cells[3] if len(cells) > 3 else ""
        category = extract_category(popup)
        title = extract_title(popup, explanation, key)
        # Prefer BS label when popup mentions Key； else bare number as BS####
        label_m = CODE_LABEL_RE.search(popup)
        code_label = f"{label_m.group(1).upper()}{label_m.group(2)}" if label_m else f"BS{key:04d}"
        out[key] = {
            "key": key,
            "code_label": code_label,
            "title": title[:500],
            "explanation": clean(explanation)[:4000],
            "solution": clean(solution)[:4000],
            "category": category[:200],
            "severity": infer_severity(category, title, explanation, solution),
            "source_url": source_url,
        }
    return out


def rows_from_general_index(html: str) -> dict[int, dict[str, Any]]:
    """Parse Creality OS index headings / links → numeric keys."""
    out: dict[int, dict[str, Any]] = {}
    # Links like /printers-general-documents/BM0111
    for m in HREF_CODE_RE.finditer(html):
        slug = m.group(1)
        # Skip composite weirdness handled separately
        lm = re.fullmatch(r"([A-Za-z]{0,3})(\d{3,4})", slug)
        if not lm:
            continue
        prefix, num = lm.group(1).upper(), int(lm.group(2))
        code_label = f"{prefix}{num:04d}" if prefix else f"BS{num:04d}"
        # Title from nearby text after the link
        start = m.end()
        snippet = re.sub(r"<[^>]+>", " ", html[start : start + 240])
        snippet = " ".join(snippet.split()).lstrip(" ：:.-")
        title = snippet.split(".")[0][:500] if snippet else code_label
        url = DETAIL_BASE.format(slug=slug)
        row = empty_row(num, code_label)
        row["title"] = clean(title)[:500]
        row["source_url"] = url
        row["category"] = _category_from_prefix(prefix)
        row["severity"] = infer_severity(row["category"], row["title"], "", "")
        if num not in out:
            out[num] = row
        else:
            merge_row(out[num], row, prefer_src_label=bool(prefix))
    return out


def _category_from_prefix(prefix: str) -> str:
    mapping = {
        "AC": "AI camera prompt",
        "AL": "AI LiDAR prompt",
        "BS": "System",
        "BM": "Error",
        "CF": "Error",
        "CB": "Error",
        "CL": "Error",
        "CM": "Error",
        "CT": "Error",
        "CX": "Error",
        "CY": "Error",
        "CZ": "Error",
        "CA": "Error",
        "FR": "CFS",
        "FS": "CFS",
        "FB": "CFS",
        "FO": "CFS",
        "FH": "CFS",
        "FM": "CFS",
        "TC": "CFS",
        "TE": "Error",
        "TF": "Error",
        "TR": "CFS",
        "XS": "Error",
    }
    return mapping.get(prefix.upper(), "")


def rows_from_cfs_summary(html: str, source_url: str) -> dict[int, dict[str, Any]]:
    parsed = parse_html(html)
    out: dict[int, dict[str, Any]] = {}
    for cells in parsed.rows:
        joined = " | ".join(cells)
        labels = CODE_LABEL_RE.findall(joined)
        if not labels:
            continue
        prefix, num_s = labels[0]
        key = int(num_s)
        code_label = f"{prefix.upper()}{int(num_s):04d}"
        # Heuristic: last non-empty long cell is troubleshooting
        texts = [clean(c) for c in cells if clean(c) and clean(c) != "/"]
        title = ""
        explanation = ""
        solution = ""
        for t in texts:
            if CODE_LABEL_RE.fullmatch(t):
                continue
            if not title and len(t) > 8:
                title = t
            elif not explanation and t != title:
                explanation = t
            elif t not in (title, explanation):
                solution = t
        row = {
            "key": key,
            "code_label": code_label,
            "title": (title or code_label)[:500],
            "explanation": explanation[:4000],
            "solution": solution[:4000],
            "category": "CFS",
            "severity": infer_severity("CFS", title, explanation, solution),
            "source_url": source_url,
        }
        out[key] = row
    # Also harvest heading-style FR#### mentions
    for m in CODE_LABEL_RE.finditer(parsed.text):
        prefix, num_s = m.group(1), m.group(2)
        if prefix.upper() not in ("FR", "FS", "FB", "FO", "FH", "FM", "TC", "TR"):
            continue
        key = int(num_s)
        if key in out:
            continue
        # Grab following sentence
        after = parsed.text[m.end() : m.end() + 200]
        title = clean(after.split(".")[0])[:500]
        out[key] = {
            "key": key,
            "code_label": f"{prefix.upper()}{key:04d}",
            "title": title or f"{prefix.upper()}{key:04d}",
            "explanation": "",
            "solution": "",
            "category": "CFS",
            "severity": infer_severity("CFS", title, "", ""),
            "source_url": source_url,
        }
    return out


def fetch_detail(slug: str) -> dict[str, Any] | None:
    url = DETAIL_BASE.format(slug=slug)
    try:
        html = fetch(url)
    except (HTTPError, URLError, TimeoutError, OSError):
        return None
    parsed = parse_html(html)
    text = parsed.text
    if len(text) < 60:
        return None

    lm = re.fullmatch(r"([A-Za-z]{0,3})(\d{3,4})", slug)
    if not lm:
        return None
    prefix, num = lm.group(1).upper(), int(lm.group(2))
    code_label = f"{prefix}{num:04d}" if prefix else f"BS{num:04d}"

    title = ""
    for h in parsed.headings:
        if str(num) in h or (prefix and prefix in h.upper()):
            title = re.sub(rf"^{prefix}?0*{num}\s*[:：]?\s*", "", h, flags=re.I).strip()
            if title:
                break
    if not title and parsed.headings:
        title = parsed.headings[0]

    why = ""
    how = ""
    wm = re.search(
        r"Why does this prompt appear\??\s*(.+?)(?:How to solve it\??|Troubleshooting|$)",
        text,
        re.I | re.S,
    )
    if wm:
        why = clean(wm.group(1))
    hm = re.search(
        r"How to solve it\??\s*(.+?)(?:Troubleshooting|Applicable model|$)",
        text,
        re.I | re.S,
    )
    if hm:
        how = clean(hm.group(1))
    if not why:
        why = text[:2000]

    category = _category_from_prefix(prefix)
    return {
        "key": num,
        "code_label": code_label,
        "title": clean(title)[:500],
        "explanation": why[:4000],
        "solution": how[:4000],
        "category": category,
        "severity": infer_severity(category, title, why, how),
        "source_url": url,
    }


def collect_detail_slugs(general_html: str, rows: dict[int, dict[str, Any]]) -> list[str]:
    slugs: list[str] = []
    seen: set[str] = set()
    for m in HREF_CODE_RE.finditer(general_html):
        slug = m.group(1)
        if slug.lower() in seen:
            continue
        seen.add(slug.lower())
        slugs.append(slug)
    # Always try BS pages for summary keys that still lack a real solution
    for key, row in rows.items():
        slug = f"BS{key:04d}"
        if slug.lower() not in seen and (not row.get("solution") or row.get("solution") in ("/", "")):
            slugs.append(slug)
            seen.add(slug.lower())
    return slugs


CONTENT_COLUMNS = (
    "key", "code_label", "title", "explanation", "solution", "category", "severity", "source_url",
)


def _content_records(rows: dict[int, dict[str, Any]]) -> list[tuple[Any, ...]]:
    records = []
    for r in sorted(rows.values(), key=lambda x: x["key"]):
        # Final severity pass + forced advisories
        sev = infer_severity(
            r.get("category", ""),
            r.get("title", ""),
            r.get("explanation", ""),
            r.get("solution", ""),
        )
        if r["key"] == 508 or STORAGE_RE.search(r.get("title", "") + r.get("explanation", "")):
            sev = "warning"
        records.append((
            r["key"],
            r.get("code_label", ""),
            r.get("title", ""),
            r.get("explanation", ""),
            r.get("solution", ""),
            r.get("category", ""),
            sev,
            r.get("source_url", ""),
        ))
    return records


def write_db(db_path: Path, rows: dict[int, dict[str, Any]]) -> int:
    """Write rows, leaving the file untouched when the content is unchanged.

    Any SQLite write bumps the file header, so rewriting identical content would
    make the daily workflow commit a "changed" DB every day. Rows whose content is
    unchanged also keep their previous ``updated_at``.
    """
    db_path.parent.mkdir(parents=True, exist_ok=True)
    now = datetime.now(timezone.utc).isoformat()
    records = _content_records(rows)
    existing: dict[int, tuple[tuple[Any, ...], str]] = {}
    if db_path.is_file():
        conn = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
        try:
            for row in conn.execute(
                f"SELECT {', '.join(CONTENT_COLUMNS)}, updated_at FROM error_codes"
            ):
                existing[row[0]] = (tuple(row[:-1]), row[-1])
        except sqlite3.Error:
            existing = {}
        finally:
            conn.close()
    if existing and {r[0]: r for r in records} == {k: v[0] for k, v in existing.items()}:
        print("  error-code content unchanged; database not rewritten")
        return len(records)

    conn = sqlite3.connect(db_path)
    try:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS error_codes (
                key INTEGER PRIMARY KEY,
                code_label TEXT,
                title TEXT,
                explanation TEXT,
                solution TEXT,
                category TEXT,
                severity TEXT,
                source_url TEXT,
                updated_at TEXT
            )
            """
        )
        conn.execute("DELETE FROM error_codes")
        for record in records:
            previous = existing.get(record[0])
            updated_at = previous[1] if previous and previous[0] == record else now
            conn.execute(
                """
                INSERT INTO error_codes
                (key, code_label, title, explanation, solution, category, severity, source_url, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (*record, updated_at),
            )
        conn.commit()
    finally:
        conn.close()
    return len(records)


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Update error_codes.sqlite from Creality wiki")
    ap.add_argument("--db", type=Path, default=DEFAULT_DB)
    ap.add_argument("--skip-details", action="store_true")
    ap.add_argument("--max-details", type=int, default=150)
    ap.add_argument("--delay", type=float, default=0.15, help="Delay between detail fetches")
    args = ap.parse_args(argv)

    print(f"Fetching K1 summary: {SUMMARY_URL}")
    try:
        summary_html = fetch(SUMMARY_URL)
    except Exception as exc:  # noqa: BLE001
        print(f"ERROR: summary fetch failed: {exc}", file=sys.stderr)
        return 1
    rows = rows_from_summary(summary_html, SUMMARY_URL)
    print(f"  keys from K1 summary table: {len(rows)}")

    print(f"Fetching Creality OS index: {GENERAL_URL}")
    general_html = ""
    try:
        general_html = fetch(GENERAL_URL)
        general_rows = rows_from_general_index(general_html)
        print(f"  keys from general index: {len(general_rows)}")
        for key, row in general_rows.items():
            if key in rows:
                merge_row(rows[key], row, prefer_src_label=True)
            else:
                rows[key] = row
        print(f"  keys after merge: {len(rows)}")
    except Exception as exc:  # noqa: BLE001
        print(f"  WARN: general index failed: {exc}")

    print(f"Fetching CFS summary: {CFS_URL}")
    try:
        cfs_html = fetch(CFS_URL)
        cfs_rows = rows_from_cfs_summary(cfs_html, CFS_URL)
        print(f"  keys from CFS summary: {len(cfs_rows)}")
        for key, row in cfs_rows.items():
            if key in rows:
                merge_row(rows[key], row, prefer_src_label=True)
            else:
                rows[key] = row
        print(f"  keys after CFS merge: {len(rows)}")
    except Exception as exc:  # noqa: BLE001
        print(f"  WARN: CFS summary failed: {exc}")

    if not args.skip_details and general_html:
        slugs = collect_detail_slugs(general_html, rows)[: args.max_details]
        print(f"Fetching up to {len(slugs)} detail pages…")
        ok = 0
        for i, slug in enumerate(slugs, 1):
            detail = fetch_detail(slug)
            if args.delay:
                time.sleep(args.delay)
            if not detail:
                continue
            ok += 1
            key = detail["key"]
            if key in rows:
                merge_row(rows[key], detail, prefer_src_label=True)
            else:
                rows[key] = detail
            if i % 20 == 0 or ok <= 3:
                print(f"  [{i}/{len(slugs)}] {detail['code_label']}")
        print(f"  detail pages with content: {ok}/{len(slugs)}")

    if 508 in rows:
        rows[508]["severity"] = "warning"
        rows[508]["category"] = rows[508].get("category") or "System"

    n = write_db(args.db, rows)
    # Stats
    conn = sqlite3.connect(args.db)
    try:
        sev = dict(conn.execute("SELECT severity, COUNT(*) FROM error_codes GROUP BY severity"))
        with_sol = conn.execute(
            "SELECT COUNT(*) FROM error_codes WHERE length(trim(solution)) > 2"
        ).fetchone()[0]
        with_cat = conn.execute(
            "SELECT COUNT(*) FROM error_codes WHERE length(trim(category)) > 0"
        ).fetchone()[0]
    finally:
        conn.close()
    print(f"Wrote {n} rows → {args.db}")
    print(f"  severity={sev} with_solution={with_sol} with_category={with_cat}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
