"""Number platform for Creality (temps + print tuning)."""

from __future__ import annotations

from homeassistant.components.number import NumberDeviceClass, NumberEntity, NumberMode
from homeassistant.config_entries import ConfigEntry
from homeassistant.const import PERCENTAGE, UnitOfTemperature
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity_platform import AddEntitiesCallback

from .const import DOMAIN
from .coordinator import CrealityCoordinator
from .entity import CrealityEntity


async def async_setup_entry(
    hass: HomeAssistant, entry: ConfigEntry, async_add_entities: AddEntitiesCallback
) -> None:
    coord: CrealityCoordinator = hass.data[DOMAIN][entry.entry_id]
    async_add_entities(
        [
            NozzleTargetNumber(coord),
            BedTargetNumber(coord),
            PrintTuningNumber(coord),
            FlowTuningNumber(coord),
        ]
    )


def _limit(coordinator: CrealityCoordinator, field: str, default: float) -> float:
    """Printer-reported limit; telemetry may arrive after entity creation."""
    try:
        value = float((coordinator.data or {}).get(field) or default)
    except (TypeError, ValueError):
        return default
    return value if value > 0 else default


class NozzleTargetNumber(CrealityEntity, NumberEntity):
    _attr_translation_key = "nozzle_target"
    _attr_device_class = NumberDeviceClass.TEMPERATURE
    _attr_native_unit_of_measurement = UnitOfTemperature.CELSIUS
    _attr_mode = NumberMode.BOX
    _attr_native_min_value = 0
    _attr_native_max_value = 300
    _attr_native_step = 1

    def __init__(self, coordinator: CrealityCoordinator) -> None:
        super().__init__(coordinator, "nozzle_target")

    @property
    def native_max_value(self) -> float:
        return _limit(self.coordinator, "maxNozzleTemp", 300)

    @property
    def native_value(self) -> float | None:
        try:
            return float((self.coordinator.data or {}).get("targetNozzleTemp"))
        except (TypeError, ValueError):
            return None

    async def async_set_native_value(self, value: float) -> None:
        v = int(round(value))
        await self.coordinator.async_send_set(nozzleTempControl=v)


class BedTargetNumber(CrealityEntity, NumberEntity):
    _attr_translation_key = "bed_target"
    _attr_device_class = NumberDeviceClass.TEMPERATURE
    _attr_native_unit_of_measurement = UnitOfTemperature.CELSIUS
    _attr_mode = NumberMode.BOX
    _attr_native_min_value = 0
    _attr_native_max_value = 120
    _attr_native_step = 1

    def __init__(self, coordinator: CrealityCoordinator) -> None:
        super().__init__(coordinator, "bed_target")

    @property
    def native_max_value(self) -> float:
        return _limit(self.coordinator, "maxBedTemp", 120)

    @property
    def native_value(self) -> float | None:
        try:
            return float((self.coordinator.data or {}).get("targetBedTemp0"))
        except (TypeError, ValueError):
            return None

    async def async_set_native_value(self, value: float) -> None:
        v = int(round(value))
        await self.coordinator.async_send_set(bedTempControl={"num": 0, "val": v})


class PrintTuningNumber(CrealityEntity, NumberEntity):
    """Print speed (feed-rate) multiplier. Unique ID kept as ``print_tuning``."""

    _attr_translation_key = "print_tuning"
    _attr_native_unit_of_measurement = PERCENTAGE
    _attr_mode = NumberMode.SLIDER
    _attr_native_min_value = 50
    _attr_native_max_value = 200
    _attr_native_step = 1
    _attr_icon = "mdi:speedometer"

    def __init__(self, coordinator: CrealityCoordinator) -> None:
        super().__init__(coordinator, "print_tuning")

    @property
    def native_value(self) -> float | None:
        d = self.coordinator.data or {}
        v = d.get("curFeedratePct", d.get("feedratePct"))
        try:
            return float(v)
        except (TypeError, ValueError):
            return None

    async def async_set_native_value(self, value: float) -> None:
        # Speed only: changing extrusion flow alongside speed over/under-extrudes.
        await self.coordinator.async_send_set(setFeedratePct=int(round(value)))


class FlowTuningNumber(CrealityEntity, NumberEntity):
    """Extrusion flow-rate multiplier, independent of print speed."""

    _attr_translation_key = "flow_tuning"
    _attr_native_unit_of_measurement = PERCENTAGE
    _attr_mode = NumberMode.SLIDER
    _attr_native_min_value = 50
    _attr_native_max_value = 150
    _attr_native_step = 1
    _attr_icon = "mdi:water-percent"

    def __init__(self, coordinator: CrealityCoordinator) -> None:
        super().__init__(coordinator, "flow_tuning")

    @property
    def native_value(self) -> float | None:
        d = self.coordinator.data or {}
        v = d.get("curFlowratePct", d.get("flowratePct"))
        try:
            return float(v)
        except (TypeError, ValueError):
            return None

    async def async_set_native_value(self, value: float) -> None:
        await self.coordinator.async_send_set(setFlowratePct=int(round(value)))
