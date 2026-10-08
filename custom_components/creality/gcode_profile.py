"""Streaming G-code silhouette builder, independent of Home Assistant.

For every layer, records which X and which Y positions received extrusion.
Projected over Z this gives a front (X-Z) and side (Y-Z) silhouette that
shows real holes and overhangs, at a fixed horizontal resolution.
"""

from __future__ import annotations

import math
from typing import Any

PROFILE_VERSION = 1
BIN_MM = 0.5
# Bitmask bins cover -100 mm .. +900 mm; moves outside are clamped.
_BIN_OFFSET = 200
_BIN_COUNT = 2000
# Fallback layer grouping when the slicer wrote no layer markers.
_Z_BUCKET_MM = 0.01


def _bin(value: float) -> int:
    return min(_BIN_COUNT - 1, max(0, int(math.floor(value / BIN_MM)) + _BIN_OFFSET))


def _mask(lo: float, hi: float) -> int:
    a, b = _bin(lo), _bin(hi)
    return ((1 << (b - a + 1)) - 1) << a


def _arc_extent(x0, y0, x1, y1, i, j, clockwise) -> tuple[float, float, float, float]:
    """Axis-aligned bounds of a G2/G3 arc (start, end and crossed extremes)."""
    cx, cy = x0 + i, y0 + j
    r = math.hypot(i, j)
    a0 = math.atan2(y0 - cy, x0 - cx)
    a1 = math.atan2(y1 - cy, x1 - cx)
    sweep = (a0 - a1) if clockwise else (a1 - a0)
    sweep %= 2 * math.pi
    if sweep < 1e-9:
        sweep = 2 * math.pi  # Same start and end: a full circle.
    xs, ys = [x0, x1], [y0, y1]
    for k in range(4):
        ang = k * math.pi / 2
        delta = ((a0 - ang) if clockwise else (ang - a0)) % (2 * math.pi)
        if delta <= sweep:
            xs.append(cx + r * math.cos(ang))
            ys.append(cy + r * math.sin(ang))
    return min(xs), max(xs), min(ys), max(ys)


def _merge_bands(masks: list[int]) -> list[list[Any]]:
    """Group consecutive layers with identical occupancy: [first, last, mask]."""
    bands: list[list[Any]] = []
    for idx, mask in enumerate(masks):
        if bands and bands[-1][2] == mask:
            bands[-1][1] = idx
        else:
            bands.append([idx, idx, mask])
    return bands


def _spans(mask: int, origin_bin: int) -> list[list[float]]:
    """Occupied runs of a bitmask as [start_mm, end_mm] relative to origin_bin."""
    out = []
    pos = 0
    while mask:
        tz = (mask & -mask).bit_length() - 1
        mask >>= tz
        pos += tz
        run = (~mask & (mask + 1)).bit_length() - 1
        out.append([round((pos - origin_bin) * BIN_MM, 1), round((pos + run - origin_bin) * BIN_MM, 1)])
        mask >>= run
        pos += run
    return out


class GcodeProfiler:
    """Feed G-code bytes incrementally, then call ``result()``."""

    def __init__(self) -> None:
        self._tail = b""
        self.x = self.y = self.z = self.e = 0.0
        self.abs_xy = True
        self.abs_e = True
        self.skip = False  # Skirt and custom start/end G-code.
        # Marker-based layers: [z, xmask, ymask, z_from_comment]
        self.layers: list[list[Any]] = []
        self._pending_z: float | None = None
        # Fallback, used only when the file has no layer markers.
        self.z_layers: dict[float, list[int]] = {}

    def feed(self, data: bytes) -> None:
        buf = self._tail + data
        lines = buf.split(b"\n")
        self._tail = lines.pop()
        for raw in lines:
            self._line(raw.decode("ascii", "ignore").strip())

    def _comment(self, text: str) -> None:
        if text.startswith(("LAYER_CHANGE", "LAYER:")):
            self.layers.append([None, 0, 0, False])
        elif text.startswith("Z:") and self.layers:
            try:
                self.layers[-1][0] = float(text[2:])
                self.layers[-1][3] = True
            except ValueError:
                pass
        elif text.startswith("TYPE:"):
            kind = text[5:].strip().lower()
            self.skip = "skirt" in kind or kind == "custom"

    def _line(self, line: str) -> None:
        if not line:
            return
        if line[0] == ";":
            self._comment(line[1:].lstrip())
            return
        code, _, _ = line.partition(";")
        words = code.split()
        if not words:
            return
        cmd = words[0].upper()
        if cmd in ("G0", "G1", "G2", "G3"):
            self._move(cmd, words[1:])
        elif cmd == "G90":
            self.abs_xy = self.abs_e = True
        elif cmd == "G91":
            self.abs_xy = self.abs_e = False
        elif cmd == "M82":
            self.abs_e = True
        elif cmd == "M83":
            self.abs_e = False
        elif cmd == "G92":
            for word in words[1:]:
                try:
                    val = float(word[1:])
                except ValueError:
                    continue
                axis = word[0].upper()
                if axis == "E":
                    self.e = val
                elif axis == "X":
                    self.x = val
                elif axis == "Y":
                    self.y = val
                elif axis == "Z":
                    self.z = val

    def _move(self, cmd: str, words: list[str]) -> None:
        vals: dict[str, float] = {}
        for word in words:
            try:
                vals[word[0].upper()] = float(word[1:])
            except (ValueError, IndexError):
                continue
        x0, y0 = self.x, self.y
        if self.abs_xy:
            x1, y1 = vals.get("X", x0), vals.get("Y", y0)
            self.z = vals.get("Z", self.z)
        else:
            x1, y1 = x0 + vals.get("X", 0.0), y0 + vals.get("Y", 0.0)
            self.z += vals.get("Z", 0.0)
        extruding = False
        if "E" in vals:
            if self.abs_e:
                extruding = vals["E"] > self.e + 1e-6
                self.e = vals["E"]
            else:
                extruding = vals["E"] > 1e-6
        self.x, self.y = x1, y1
        if not extruding or self.skip or (x1 == x0 and y1 == y0 and cmd in ("G0", "G1")):
            return
        if cmd in ("G2", "G3") and ("I" in vals or "J" in vals):
            lox, hix, loy, hiy = _arc_extent(
                x0, y0, x1, y1, vals.get("I", 0.0), vals.get("J", 0.0), cmd == "G2")
        else:
            lox, hix, loy, hiy = min(x0, x1), max(x0, x1), min(y0, y1), max(y0, y1)
        xm, ym = _mask(lox, hix), _mask(loy, hiy)
        if self.layers:
            layer = self.layers[-1]
            layer[1] |= xm
            layer[2] |= ym
            if not layer[3]:
                # Cura-style markers carry no Z: use the highest extruding Z.
                layer[0] = self.z if layer[0] is None else max(layer[0], self.z)
        else:
            key = round(round(self.z / _Z_BUCKET_MM) * _Z_BUCKET_MM, 3)
            slot = self.z_layers.setdefault(key, [0, 0])
            slot[0] |= xm
            slot[1] |= ym

    def result(self) -> dict[str, Any] | None:
        """Compact profile, or None when the file contained no extrusion."""
        if self._tail:
            self._line(self._tail.decode("ascii", "ignore").strip())
            self._tail = b""
        if any(layer[1] for layer in self.layers):
            # Drop empty markers (e.g. a trailing marker in end G-code).
            rows = [(layer[0] or 0.0, layer[1], layer[2]) for layer in self.layers if layer[1]]
        else:
            rows = [(z, m[0], m[1]) for z, m in sorted(self.z_layers.items()) if m[0]]
        if not rows:
            return None
        zs: list[float] = []
        for z, _, _ in rows:
            # Z must be non-decreasing for drawing; markers without Z inherit.
            zs.append(round(max(z, zs[-1] if zs else 0.0), 3))
        xmask = ymask = 0
        for _, xm, ym in rows:
            xmask |= xm
            ymask |= ym
        x_lo = (xmask & -xmask).bit_length() - 1
        y_lo = (ymask & -ymask).bit_length() - 1
        x_hi, y_hi = xmask.bit_length(), ymask.bit_length()

        def axis(index: int, lo: int, hi: int) -> dict[str, Any]:
            return {
                "min": round((lo - _BIN_OFFSET) * BIN_MM, 1),
                "size": round((hi - lo) * BIN_MM, 1),
                "bands": [[a, b, _spans(m, lo)] for a, b, m in _merge_bands([r[index] for r in rows])],
            }

        return {
            "version": PROFILE_VERSION,
            "layers": len(rows),
            "z": zs,
            "x": axis(1, x_lo, x_hi),
            "y": axis(2, y_lo, y_hi),
        }
