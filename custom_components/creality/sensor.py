"""Sensor platform for Creality."""

from __future__ import annotations

import re
from typing import Any

from homeassistant.components.sensor import (
    RestoreSensor,
    SensorDeviceClass,
    SensorEntity,
    SensorStateClass,
)
from homeassistant.config_entries import ConfigEntry
from homeassistant.const import PERCENTAGE, UnitOfSpeed, UnitOfTemperature, UnitOfTime
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity import EntityCategory
from homeassistant.helpers.entity_platform import AddEntitiesCallback

from .const import DOMAIN
from .coordinator import CrealityCoordinator
from .entity import CrealityEntity
from .timelapse_archive import STATUSES as ARCHIVE_STATUSES


async def async_setup_entry(
    hass: HomeAssistant, entry: ConfigEntry, async_add_entities: AddEntitiesCallback
) -> None:
    coord: CrealityCoordinator = hass.data[DOMAIN][entry.entry_id]
    async_add_entities(
        [
            PrintStatusSensor(coord),
            ProgressSensor(coord),
            ObjectSensor(coord),
            LayerSensor(coord),
            TotalLayersSensor(coord),
            JobTimeSensor(coord),
            TimeLeftSensor(coord),
            OurEtaSensor(coord),
            UsedMaterialSensor(coord),
            FilamentStatusSensor(coord),
            NozzleTempSensor(coord),
            BedTempSensor(coord),
            PositionSensor(coord, "x", "curPosition", "position_x"),
            PositionSensor(coord, "y", "curPosition", "position_y"),
            PositionSensor(coord, "z", "curPosition", "position_z"),
            PrintSpeedSensor(coord),
            RealTimeSpeedSensor(coord),
            RealTimeFlowSensor(coord),
            LifetimeSensor(coord, "total_jobs", "totalJob", None, "mdi:counter"),
            LifetimeSensor(coord, "total_print_time", "totalUsageTime", UnitOfTime.SECONDS, "mdi:timer-outline"),
            LifetimeSensor(coord, "total_filament_used", "totalUsageMaterial", "mm", "mdi:printer-3d-nozzle"),
            ErrorKeySensor(coord),
            ErrorMessageSensor(coord),
        ]
    )
    async_add_entities([TimelapseArchiveSensor(coord)])


class _CSensor(CrealityEntity, SensorEntity):
    def _d(self) -> dict[str, Any]:
        return self.coordinator.data or {}


class PrintStatusSensor(_CSensor):
    _attr_translation_key = "print_status"
    _attr_icon = "mdi:printer-3d"
    _requires_connection = False  # Reports "offline" itself.

    def __init__(self, coordinator: CrealityCoordinator) -> None:
        super().__init__(coordinator, "print_status")

    @property
    def native_value(self) -> str:
        return self._d().get("__print_status") or "unknown"

    @property
    def extra_state_attributes(self) -> dict[str, Any]:
        d = self._d()
        return {
            "connected": self.coordinator.client.connected,
            "state_raw": d.get("state"),
            "device_state": d.get("deviceState"),
            "err": d.get("err"),
            "err_key": d.get("__err_key"),
            "err_severity": d.get("__err_severity"),
            "err_message": d.get("__err_message"),
            "err_solution": d.get("__err_solution"),
            "err_value": d.get("__err_value"),
            "filament_runout": d.get("__filament_runout"),
            "file": d.get("printFileName"),
            "print_start_time": d.get("printStartTime"),
            "print_id": d.get("printId"),
            "paused": self.coordinator.paused_flag(),
        }


class ProgressSensor(_CSensor):
    _attr_translation_key = "print_progress"
    _attr_native_unit_of_measurement = PERCENTAGE
    _attr_state_class = SensorStateClass.MEASUREMENT
    _attr_icon = "mdi:progress-check"

    def __init__(self, coordinator: CrealityCoordinator) -> None:
        super().__init__(coordinator, "print_progress")

    @property
    def native_value(self) -> float | None:
        d = self._d()
        v = d.get("printProgress")
        if v is None:
            v = d.get("dProgress")
        try:
            return float(v)
        except (TypeError, ValueError):
            return None


class ObjectSensor(_CSensor):
    _attr_translation_key = "current_object"
    _attr_icon = "mdi:file"

    def __init__(self, coordinator: CrealityCoordinator) -> None:
        super().__init__(coordinator, "current_object")

    @property
    def native_value(self) -> str | None:
        name = self._d().get("printFileName") or self._d().get("current_object") or ""
        if not name:
            return None
        s = str(name)
        i = max(s.rfind("/"), s.rfind("\\"))
        return s[i + 1 :] if i >= 0 else s


class LayerSensor(_CSensor):
    _attr_translation_key = "working_layer"
    _attr_state_class = SensorStateClass.MEASUREMENT
    _attr_icon = "mdi:layers-triple"

    def __init__(self, coordinator: CrealityCoordinator) -> None:
        super().__init__(coordinator, "working_layer")

    @property
    def native_value(self) -> int | None:
        v = self._d().get("__layer")
        try:
            return int(v)
        except (TypeError, ValueError):
            return None


class TotalLayersSensor(_CSensor):
    _attr_translation_key = "total_layers"
    _attr_state_class = SensorStateClass.MEASUREMENT
    _attr_icon = "mdi:layers-triple"

    def __init__(self, coordinator: CrealityCoordinator) -> None:
        super().__init__(coordinator, "total_layers")

    @property
    def native_value(self) -> int | None:
        v = self._d().get("__total_layer")
        try:
            return int(v)
        except (TypeError, ValueError):
            return None


class JobTimeSensor(_CSensor):
    _attr_translation_key = "print_job_time"
    _attr_device_class = SensorDeviceClass.DURATION
    _attr_native_unit_of_measurement = UnitOfTime.SECONDS
    _attr_state_class = SensorStateClass.MEASUREMENT
    _attr_icon = "mdi:timer"

    def __init__(self, coordinator: CrealityCoordinator) -> None:
        super().__init__(coordinator, "print_job_time")

    @property
    def native_value(self) -> int | None:
        try:
            return int(float(self._d().get("printJobTime")))
        except (TypeError, ValueError):
            return None


class TimeLeftSensor(_CSensor):
    _attr_translation_key = "print_time_left"
    _attr_device_class = SensorDeviceClass.DURATION
    _attr_native_unit_of_measurement = UnitOfTime.SECONDS
    _attr_state_class = SensorStateClass.MEASUREMENT
    _attr_icon = "mdi:timer-sand"

    def __init__(self, coordinator: CrealityCoordinator) -> None:
        super().__init__(coordinator, "print_time_left")

    @property
    def native_value(self) -> int | None:
        try:
            return int(float(self._d().get("printLeftTime")))
        except (TypeError, ValueError):
            return None


class OurEtaSensor(_CSensor):
    _attr_translation_key = "print_time_left_estimated"
    _attr_device_class = SensorDeviceClass.DURATION
    _attr_native_unit_of_measurement = UnitOfTime.SECONDS
    _attr_state_class = SensorStateClass.MEASUREMENT
    _attr_icon = "mdi:timer-check"

    def __init__(self, coordinator: CrealityCoordinator) -> None:
        super().__init__(coordinator, "print_time_left_estimated")

    @property
    def available(self) -> bool:
        # Opt-in through the "Own time estimate" switch.
        return self.coordinator.own_estimate and super().available

    @property
    def native_value(self) -> int | None:
        v = self._d().get("__eta_ours")
        return int(v) if isinstance(v, int) else None


class UsedMaterialSensor(_CSensor):
    _attr_translation_key = "used_material_length"
    _attr_native_unit_of_measurement = "mm"
    _attr_state_class = SensorStateClass.MEASUREMENT
    _attr_icon = "mdi:counter"

    def __init__(self, coordinator: CrealityCoordinator) -> None:
        super().__init__(coordinator, "used_material_length")

    @property
    def native_value(self) -> float | None:
        try:
            return float(self._d().get("usedMaterialLength"))
        except (TypeError, ValueError):
            return None


class FilamentStatusSensor(_CSensor):
    _attr_translation_key = "filament_status"
    _attr_icon = "mdi:printer-3d-nozzle-alert"

    def __init__(self, coordinator: CrealityCoordinator) -> None:
        super().__init__(coordinator, "filament_status")

    @property
    def native_value(self) -> str:
        return "runout" if self._d().get("__filament_runout") else "normal"


class NozzleTempSensor(_CSensor):
    _attr_translation_key = "nozzle_temperature"
    _attr_device_class = SensorDeviceClass.TEMPERATURE
    _attr_native_unit_of_measurement = UnitOfTemperature.CELSIUS
    _attr_state_class = SensorStateClass.MEASUREMENT

    def __init__(self, coordinator: CrealityCoordinator) -> None:
        super().__init__(coordinator, "nozzle_temperature")

    @property
    def native_value(self) -> float | None:
        try:
            return float(self._d().get("nozzleTemp"))
        except (TypeError, ValueError):
            return None


class BedTempSensor(_CSensor):
    _attr_translation_key = "bed_temperature"
    _attr_device_class = SensorDeviceClass.TEMPERATURE
    _attr_native_unit_of_measurement = UnitOfTemperature.CELSIUS
    _attr_state_class = SensorStateClass.MEASUREMENT

    def __init__(self, coordinator: CrealityCoordinator) -> None:
        super().__init__(coordinator, "bed_temperature")

    @property
    def native_value(self) -> float | None:
        try:
            return float(self._d().get("bedTemp0"))
        except (TypeError, ValueError):
            return None


class PrintSpeedSensor(_CSensor):
    _attr_translation_key = "print_speed"
    _attr_native_unit_of_measurement = PERCENTAGE
    _attr_state_class = SensorStateClass.MEASUREMENT
    _attr_icon = "mdi:speedometer"

    def __init__(self, coordinator: CrealityCoordinator) -> None:
        super().__init__(coordinator, "print_speed")

    @property
    def native_value(self) -> float | None:
        d = self._d()
        v = d.get("curFeedratePct", d.get("feedratePct"))
        try:
            return float(v)
        except (TypeError, ValueError):
            return None


class PositionSensor(_CSensor):
    # Toolhead position changes with almost every frame (~10k states/hour each
    # while printing at the 1 s publish limit's worst case), so opt-in only.
    _attr_entity_registry_enabled_default = False
    _attr_state_class = SensorStateClass.MEASUREMENT
    _attr_native_unit_of_measurement = "mm"
    _attr_icon = "mdi:axis-arrow"

    def __init__(self, coordinator: CrealityCoordinator, axis: str, field: str, uid: str) -> None:
        super().__init__(coordinator, uid)
        self._field = field
        self._attr_translation_key = f"position_{axis}"
        # e.g. X:111.69 Y:130.97 Z:1.92
        self._pattern = re.compile(rf"{axis.upper()}:\s*(-?\d+(?:\.\d+)?)")

    @property
    def native_value(self) -> float | None:
        raw = self._d().get(self._field) or ""
        m = self._pattern.search(str(raw))
        if not m:
            return None
        return float(m.group(1))


class RealTimeSpeedSensor(_CSensor):
    """Actual toolhead speed (``realTimeSpeed``), unlike the feed-rate multiplier."""

    _attr_translation_key = "toolhead_speed"
    _attr_device_class = SensorDeviceClass.SPEED
    _attr_native_unit_of_measurement = UnitOfSpeed.MILLIMETERS_PER_SECOND
    _attr_state_class = SensorStateClass.MEASUREMENT
    _attr_entity_registry_enabled_default = False
    _attr_icon = "mdi:speedometer"

    def __init__(self, coordinator: CrealityCoordinator) -> None:
        super().__init__(coordinator, "toolhead_speed")

    @property
    def native_value(self) -> float | None:
        try:
            return float(self._d().get("realTimeSpeed"))
        except (TypeError, ValueError):
            return None


class RealTimeFlowSensor(_CSensor):
    """Volumetric extrusion rate (``realTimeFlow``)."""

    _attr_translation_key = "extrusion_flow"
    _attr_native_unit_of_measurement = "mm³/s"
    _attr_state_class = SensorStateClass.MEASUREMENT
    _attr_entity_registry_enabled_default = False
    _attr_icon = "mdi:water-outline"

    def __init__(self, coordinator: CrealityCoordinator) -> None:
        super().__init__(coordinator, "extrusion_flow")

    @property
    def native_value(self) -> float | None:
        try:
            return float(self._d().get("realTimeFlow"))
        except (TypeError, ValueError):
            return None


class LifetimeSensor(CrealityEntity, RestoreSensor):
    """Printer lifetime counter; restored because the printer only reports it
    with the history list (on connect and after each job)."""

    _attr_entity_category = EntityCategory.DIAGNOSTIC
    _attr_state_class = SensorStateClass.TOTAL_INCREASING
    _requires_connection = False

    def __init__(self, coordinator: CrealityCoordinator, uid: str, field: str,
                 unit: str | None, icon: str) -> None:
        super().__init__(coordinator, uid)
        self._attr_translation_key = uid
        self._field = field
        self._attr_native_unit_of_measurement = unit
        self._attr_icon = icon
        if unit == UnitOfTime.SECONDS:
            self._attr_device_class = SensorDeviceClass.DURATION
        # Last value seen (restored at start): the printer only resends totals
        # with the history list, and a reconnect may clear them meanwhile.
        self._last: float | None = None

    async def async_added_to_hass(self) -> None:
        await super().async_added_to_hass()
        last = await self.async_get_last_sensor_data()
        if last is not None and isinstance(last.native_value, (int, float)):
            self._last = float(last.native_value)

    @property
    def native_value(self) -> float | int | None:
        try:
            value = float((self.coordinator.data or {}).get(self._field))
        except (TypeError, ValueError):
            value = None
        if value is not None:
            self._last = value
        value = self._last
        if value is None:
            return None
        return int(value) if value.is_integer() else value


class ErrorKeySensor(_CSensor):
    _attr_translation_key = "error_key"
    _attr_entity_category = EntityCategory.DIAGNOSTIC
    _attr_icon = "mdi:alert-circle"

    def __init__(self, coordinator: CrealityCoordinator) -> None:
        super().__init__(coordinator, "error_key")

    @property
    def native_value(self) -> int:
        try:
            return int(self._d().get("__err_key") or 0)
        except (TypeError, ValueError):
            return 0


class ErrorMessageSensor(_CSensor):
    _attr_translation_key = "error_message"
    _attr_entity_category = EntityCategory.DIAGNOSTIC
    _attr_icon = "mdi:message-alert"

    def __init__(self, coordinator: CrealityCoordinator) -> None:
        super().__init__(coordinator, "error_message")

    @property
    def native_value(self) -> str:
        return self._d().get("__err_message") or ""

    @property
    def extra_state_attributes(self) -> dict[str, Any]:
        return {
            "severity": self._d().get("__err_severity"),
            "key": self._d().get("__err_key"),
        }


class TimelapseArchiveSensor(_CSensor):
    """Saving of timelapses to the configured folder; ``off`` without one."""

    _attr_translation_key = "timelapse_archive"
    _attr_entity_category = EntityCategory.DIAGNOSTIC
    _attr_device_class = SensorDeviceClass.ENUM
    _attr_options = ARCHIVE_STATUSES
    _attr_icon = "mdi:filmstrip-box-multiple"
    _requires_connection = False  # Saved files and queued jobs outlive disconnects.

    def __init__(self, coordinator: CrealityCoordinator) -> None:
        super().__init__(coordinator, "timelapse_archive")

    @property
    def native_value(self) -> str:
        return self.coordinator.archive.status

    @property
    def extra_state_attributes(self) -> dict[str, Any]:
        return self.coordinator.archive.as_attributes()
