"""Fan platform for Creality."""

from __future__ import annotations

from homeassistant.components.fan import FanEntity, FanEntityFeature
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity_platform import AddEntitiesCallback

from .const import DOMAIN, FAN_CASE, FAN_MODEL, FAN_SIDE
from .coordinator import CrealityCoordinator
from .entity import CrealityEntity


async def async_setup_entry(
    hass: HomeAssistant, entry: ConfigEntry, async_add_entities: AddEntitiesCallback
) -> None:
    coord: CrealityCoordinator = hass.data[DOMAIN][entry.entry_id]
    async_add_entities(
        [
            CrealityFan(coord, "model_fan", "modelFanPct", FAN_MODEL),
            CrealityFan(coord, "case_fan", "caseFanPct", FAN_CASE),
            CrealityFan(coord, "side_fan", "auxiliaryFanPct", FAN_SIDE),
        ]
    )


class CrealityFan(CrealityEntity, FanEntity):
    _attr_supported_features = FanEntityFeature.SET_SPEED | FanEntityFeature.TURN_ON | FanEntityFeature.TURN_OFF
    _attr_percentage_step = 1

    def __init__(
        self, coordinator: CrealityCoordinator, uid: str, read_field: str, channel: int
    ) -> None:
        super().__init__(coordinator, uid)
        self._attr_translation_key = uid
        self._read_field = read_field
        self._channel = channel

    @property
    def percentage(self) -> int | None:
        v = (self.coordinator.data or {}).get(self._read_field)
        try:
            return int(round(float(v)))
        except (TypeError, ValueError):
            return 0

    @property
    def is_on(self) -> bool:
        return (self.percentage or 0) > 0

    async def async_set_percentage(self, percentage: int) -> None:
        pct = max(0, min(100, int(percentage)))
        s_val = int(round(255 * (pct / 100.0)))
        await self.coordinator.async_send_set(gcodeCmd=f"M106 P{self._channel} S{s_val}")

    async def async_turn_on(self, percentage: int | None = None, **kwargs) -> None:
        await self.async_set_percentage(100 if percentage is None else percentage)

    async def async_turn_off(self, **kwargs) -> None:
        await self.async_set_percentage(0)
