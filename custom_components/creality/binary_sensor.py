"""Binary sensors for Creality."""

from __future__ import annotations

from homeassistant.components.binary_sensor import (
    BinarySensorDeviceClass,
    BinarySensorEntity,
)
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
    async_add_entities([FilamentRunoutBinary(coord), PrinterOnlineBinary(coord)])


class FilamentRunoutBinary(CrealityEntity, BinarySensorEntity):
    _attr_translation_key = "filament_runout"
    _attr_device_class = BinarySensorDeviceClass.PROBLEM
    _attr_icon = "mdi:printer-3d-nozzle-alert"

    def __init__(self, coordinator: CrealityCoordinator) -> None:
        super().__init__(coordinator, "filament_runout")

    @property
    def is_on(self) -> bool:
        return bool((self.coordinator.data or {}).get("__filament_runout"))


class PrinterOnlineBinary(CrealityEntity, BinarySensorEntity):
    _attr_translation_key = "online"
    _attr_device_class = BinarySensorDeviceClass.CONNECTIVITY
    _requires_connection = False  # Reports the connection itself.

    def __init__(self, coordinator: CrealityCoordinator) -> None:
        super().__init__(coordinator, "online")

    @property
    def is_on(self) -> bool:
        return self.coordinator.client.connected
