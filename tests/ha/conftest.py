"""Fixtures for tests that run against a real Home Assistant core.

Requires Python 3.13+ and ``pip install pytest-homeassistant-custom-component``;
run with ``pytest tests/ha``. This directory has no ``__init__.py`` so the
stdlib ``unittest discover`` run (no HA installed) skips it.
"""

from pathlib import Path

import pytest

REPO_COMPONENTS = str(Path(__file__).parents[2] / "custom_components")

pytest_plugins = "pytest_homeassistant_custom_component"


@pytest.fixture(autouse=True)
def auto_enable_custom_integrations(enable_custom_integrations):
    """Expose this repo's integration next to the plugin's testing components.

    The plugin's ``hass`` fixture imports its own ``custom_components`` package,
    so extend that package's search path rather than relying on ``sys.path``.
    """
    import custom_components

    if REPO_COMPONENTS not in custom_components.__path__:
        custom_components.__path__.append(REPO_COMPONENTS)
    yield


@pytest.fixture(autouse=True)
def printer_gcode_http(aioclient_mock):
    """Telemetry frames name a G-code file; keep its profile download offline."""
    for host in ("10.0.0.24", "10.0.0.30"):
        aioclient_mock.get(f"http://{host}/downloads/gcode/part_PLA_1h30m.gcode", status=404)
    return aioclient_mock
