"""G-code silhouette parser tests; no Home Assistant required."""

import importlib.util
from pathlib import Path
import unittest

_SPEC = importlib.util.spec_from_file_location(
    "gcode_profile", Path(__file__).parents[1] / "custom_components/creality/gcode_profile.py"
)
gp = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(gp)


def profile(text: str, chunk: int = 7):
    """Parse in tiny chunks so lines straddle feed() boundaries."""
    parser = gp.GcodeProfiler()
    data = text.encode()
    for i in range(0, len(data), chunk):
        parser.feed(data[i : i + chunk])
    return parser.result()


def spans(result, axis, layer):
    for first, last, runs in result[axis]["bands"]:
        if first <= layer <= last:
            return runs
    raise AssertionError(f"layer {layer} missing")


ORCA = """\
;TYPE:Custom
G90
M82
G1 X0 Y0 E5 ; purge line in start G-code is ignored
;LAYER_CHANGE
;Z:0.2
;HEIGHT:0.2
;TYPE:Skirt
G1 X-20 Y-20 E6
G1 X60 Y-20 E7
;TYPE:Outer wall
G0 X10 Y10
G1 X20 Y10 E8
G0 X30 Y10
G1 X40 Y20 E9
;LAYER_CHANGE
;Z:0.4
;HEIGHT:0.2
G0 X10 Y10
G1 X40 Y10 E10
G1 X40 Y10 E10.5 ; prime in place, no XY extent
G1 X50 Y10 E10.4 ; absolute E going backwards is a retract, not extrusion
G92 E0
G0 X10 Y10
G1 X10 Y30 E1
;TYPE:Custom
G1 X100 Y100 E2 ; end G-code
"""


class GcodeProfileTests(unittest.TestCase):
    def test_marker_layers_skip_skirt_custom_and_retracts(self):
        result = profile(ORCA)
        self.assertEqual(result["version"], 1)
        self.assertEqual(result["layers"], 2)
        self.assertEqual(result["z"], [0.2, 0.4])
        self.assertEqual(result["x"]["min"], 10.0)
        self.assertEqual(result["x"]["size"], 30.5)
        # Layer 1 has a gap between x=20 and x=30 (a hole in the front view).
        self.assertEqual(spans(result, "x", 0), [[0.0, 10.5], [20.0, 30.5]])
        self.assertEqual(spans(result, "x", 1), [[0.0, 30.5]])
        self.assertEqual(result["y"]["min"], 10.0)
        self.assertEqual(spans(result, "y", 1), [[0.0, 20.5]])

    def test_identical_layers_merge_into_bands(self):
        layer = ";LAYER_CHANGE\n;Z:{z}\nG1 X0 Y0\nG1 X10 Y5 E{e}\n"
        text = "M82\n" + "".join(layer.format(z=round(0.2 * (i + 1), 1), e=i + 1) for i in range(5))
        result = profile(text)
        self.assertEqual(result["layers"], 5)
        self.assertEqual(result["x"]["bands"], [[0, 4, [[0.0, 10.5]]]])

    def test_cura_markers_take_z_from_moves_and_relative_extrusion(self):
        text = """M83
;LAYER:0
G1 Z0.3
G1 X0 Y0 E-1
G1 X10 Y0 E0.5
;LAYER:1
G1 Z0.5
G1 X10 Y10 E0.5
"""
        result = profile(text)
        self.assertEqual(result["z"], [0.3, 0.5])
        self.assertEqual(spans(result, "x", 0), [[0.0, 10.5]])
        self.assertEqual(spans(result, "y", 1), [[0.0, 10.5]])

    def test_interleaved_support_layers_fill_their_height(self):
        # Independent support layer height: support layers sit between object
        # layers, so each layer is thicker than the gap to the one below it.
        text = """M83
;LAYER_CHANGE
;Z:0.2
;HEIGHT:0.2
;TYPE:Outer wall
G1 X0 Y0
G1 X10 Y0 E1
;LAYER_CHANGE
;Z:0.4
;HEIGHT:0.2
G1 X0 Y0
G1 X10 Y0 E1
;LAYER_CHANGE
;Z:0.45
;HEIGHT:0.05
;TYPE:Support
;HEIGHT:0.2
G1 X20 Y0
G1 X25 Y0 E1
;LAYER_CHANGE
;Z:0.6
;HEIGHT:0.15
;TYPE:Outer wall
;HEIGHT:0.2
G1 X0 Y0
G1 X10 Y0 E1
;LAYER_CHANGE
;Z:0.65
;HEIGHT:0.05
;TYPE:Support
;HEIGHT:0.2
G1 X20 Y0
G1 X25 Y0 E1
"""
        result = profile(text)
        self.assertEqual(result["z"], [0.2, 0.4, 0.45, 0.6, 0.65])
        both = [[0.0, 10.5], [20.0, 25.5]]
        self.assertEqual(spans(result, "x", 0), [[0.0, 10.5]])
        # 0.2-0.4, 0.4-0.45 and 0.45-0.6 each hold object and support.
        for layer in (1, 2, 3):
            self.assertEqual(spans(result, "x", layer), both)
        self.assertEqual(spans(result, "x", 4), [[20.0, 25.5]])

    def test_without_markers_groups_by_extruding_z(self):
        text = "M83\nG1 Z0.2\nG1 X0 Y0\nG1 X5 Y0 E1\nG1 Z0.6 ; hop\nG1 X0 Y0\nG1 Z0.4\nG1 X5 Y5 E1\n"
        result = profile(text)
        self.assertEqual(result["z"], [0.2, 0.4])

    def test_arc_extent_includes_crossed_extremes(self):
        # Counter-clockwise half circle from (10,0) to (-10,0) about the origin
        # passes through y=10; the chord alone would have no Y extent.
        text = "M83\n;LAYER_CHANGE\n;Z:0.2\nG1 X10 Y0\nG3 X-10 Y0 I-10 J0 E1\n"
        result = profile(text)
        self.assertEqual(result["y"]["size"], 10.5)
        self.assertEqual(result["x"]["size"], 20.5)

    def test_no_extrusion_returns_none(self):
        self.assertIsNone(profile("G28\nG1 X10 Y10\n;LAYER_CHANGE\n;Z:0.2\nG0 X5\n"))


if __name__ == "__main__":
    unittest.main()
