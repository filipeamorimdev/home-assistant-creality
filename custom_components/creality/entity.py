"""Base entity for Creality."""

from __future__ import annotations

from homeassistant.helpers.device_registry import DeviceInfo
from homeassistant.helpers.update_coordinator import CoordinatorEntity

from .const import DOMAIN, MANUFACTURER
from .coordinator import CrealityCoordinator


class CrealityEntity(CoordinatorEntity[CrealityCoordinator]):
    """Entity tied to a Creality coordinator."""

    _attr_has_entity_name = True
    # Entities that stay meaningful while the printer is unreachable (connection
    # state, the "offline" status) set this to False.
    _requires_connection = True

    def __init__(self, coordinator: CrealityCoordinator, unique_id_suffix: str) -> None:
        super().__init__(coordinator)
        self._attr_unique_id = f"{coordinator.entry.entry_id}_{unique_id_suffix}"
        self._suffix = unique_id_suffix

    @property
    def available(self) -> bool:
        """Report unavailable instead of stale telemetry while disconnected.

        After a reconnect the merged state still holds pre-disconnect values
        until the printer sends a fresh frame, so wait for that too.
        """
        if not super().available:
            return False
        if not self._requires_connection:
            return True
        return self.coordinator.client.connected and self.coordinator.live

    @property
    def device_info(self) -> DeviceInfo:
        d = self.coordinator.data or {}
        model = d.get("model") or "Creality"
        name = self.coordinator.entry.data.get("name") or d.get("hostname") or "Creality Printer"
        return DeviceInfo(
            identifiers={(DOMAIN, self.coordinator.entry.entry_id)},
            name=name,
            manufacturer=MANUFACTURER,
            model=str(model),
            sw_version=_sw_version(d.get("modelVersion")),
            configuration_url=f"http://{self.coordinator.host}/",
        )


def _sw_version(raw: object) -> str | None:
    if not raw:
        return None
    s = str(raw)
    return s[:120] if s else None
