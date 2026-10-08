"""Light platform for Creality chamber LED."""

from __future__ import annotations

from homeassistant.components.light import ColorMode, LightEntity
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity_platform import AddEntitiesCallback

from .const import DOMAIN
from .coordinator import CrealityCoordinator
from .entity import CrealityEntity


async def async_setup_entry(
    hass: HomeAssistant, entry: ConfigEntry, async_add_entities: AddEntitiesCallback
) -> None:
    coord: CrealityCoordinator = hass.data[DOMAIN][entry.entry_id]
    async_add_entities([PrinterLight(coord)])


class PrinterLight(CrealityEntity, LightEntity):
    _attr_translation_key = "light"
    _attr_color_mode = ColorMode.ONOFF
    _attr_supported_color_modes = {ColorMode.ONOFF}

    def __init__(self, coordinator: CrealityCoordinator) -> None:
        super().__init__(coordinator, "light")

    @property
    def is_on(self) -> bool:
        try:
            return int((self.coordinator.data or {}).get("lightSw") or 0) == 1
        except (TypeError, ValueError):
            return False

    async def async_turn_on(self, **kwargs) -> None:
        await self.coordinator.async_send_set(lightSw=1)

    async def async_turn_off(self, **kwargs) -> None:
        await self.coordinator.async_send_set(lightSw=0)
