"""Creality Home Assistant integration (MIT, clean-room)."""

from __future__ import annotations

import logging
from pathlib import Path

from homeassistant.components import frontend
from homeassistant.components.http import StaticPathConfig
from homeassistant.config_entries import ConfigEntry
from homeassistant.const import Platform
from homeassistant.core import HomeAssistant
from homeassistant.helpers import config_validation as cv
from homeassistant.helpers import entity_registry as er

from homeassistant.helpers.start import async_at_started
from homeassistant.helpers.storage import Store

from . import errors, websocket
from .const import CARD_URL, CARD_VERSION, CONF_HOST, DOMAIN, LIVE_OPTIONS
from .coordinator import CrealityCoordinator
from .legacy_card import async_check_legacy_resources
from .timelapse import TimelapseView
from .timelapse_archive import archive_store_key

_LOGGER = logging.getLogger(__name__)

# Options key of the retired background print-energy tracking.
_LEGACY_ENERGY_OPTION = "energy_sensor"

FRONTEND_FILE = Path(__file__).parent / "frontend" / "creality-card.js"

# Config entries only; async_setup exists just to serve the bundled card.
CONFIG_SCHEMA = cv.config_entry_only_config_schema(DOMAIN)

PLATFORMS: list[Platform] = [
    Platform.SENSOR,
    Platform.BUTTON,
    Platform.NUMBER,
    Platform.FAN,
    Platform.LIGHT,
    Platform.SWITCH,
    Platform.BINARY_SENSOR,
    Platform.CAMERA,
    Platform.IMAGE,
]


async def async_setup(hass: HomeAssistant, config: dict) -> bool:
    """Serve and automatically load the bundled Lovelace card."""
    if DOMAIN not in hass.data:
        hass.data[DOMAIN] = {}
        await hass.http.async_register_static_paths(
            [StaticPathConfig(CARD_URL, str(FRONTEND_FILE), False)]
        )
        frontend.add_extra_js_url(hass, f"{CARD_URL}?v={CARD_VERSION}")
        websocket.async_register(hass)
        hass.http.register_view(TimelapseView())
        # Dashboard resources are loaded by then; flag leftovers of the old card.
        async_at_started(hass, async_check_legacy_resources)
    return True


async def _async_drop_background_energy(hass: HomeAssistant, entry: ConfigEntry) -> None:
    """Remove the retired background print-energy option, sensor and store."""
    if _LEGACY_ENERGY_OPTION in entry.options:
        options = {k: v for k, v in entry.options.items() if k != _LEGACY_ENERGY_OPTION}
        hass.config_entries.async_update_entry(entry, options=options)
    registry = er.async_get(hass)
    if stale := registry.async_get_entity_id("sensor", DOMAIN, f"{entry.entry_id}_print_energy"):
        registry.async_remove(stale)
        await Store(hass, 1, f"{DOMAIN}.{entry.entry_id}.energy").async_remove()


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    host = entry.data[CONF_HOST]
    await _async_drop_background_energy(hass, entry)
    # Read the error-code DB off the event loop before telemetry starts arriving.
    await hass.async_add_executor_job(errors.preload)
    coordinator = CrealityCoordinator(hass, entry, host)
    coordinator.setup_options = _reload_options(entry)
    hass.data.setdefault(DOMAIN, {})[entry.entry_id] = coordinator

    try:
        await coordinator.async_start()
        await coordinator.async_config_entry_first_refresh()
        await hass.config_entries.async_forward_entry_setups(entry, PLATFORMS)
    except Exception:
        await coordinator.async_shutdown()
        hass.data[DOMAIN].pop(entry.entry_id, None)
        raise
    entry.async_on_unload(entry.add_update_listener(_async_update_listener))
    return True


async def async_unload_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    unload_ok = await hass.config_entries.async_unload_platforms(entry, PLATFORMS)
    if not unload_ok:
        return False
    coordinator: CrealityCoordinator | None = hass.data.get(DOMAIN, {}).pop(entry.entry_id, None)
    if coordinator:
        await coordinator.async_shutdown()
    return unload_ok


async def async_remove_entry(hass: HomeAssistant, entry: ConfigEntry) -> None:
    """Delete per-entry persisted data when the printer is removed."""
    await Store(hass, 1, archive_store_key(entry.entry_id)).async_remove()


def _reload_options(entry: ConfigEntry) -> dict:
    return {key: value for key, value in entry.options.items() if key not in LIVE_OPTIONS}


async def _async_update_listener(hass: HomeAssistant, entry: ConfigEntry) -> None:
    coordinator = hass.data.get(DOMAIN, {}).get(entry.entry_id)
    # Timelapse saving settings (also changed from the card) apply live.
    if coordinator is not None and coordinator.setup_options == _reload_options(entry):
        coordinator.archive.async_configure()
        return
    await hass.config_entries.async_reload(entry.entry_id)
