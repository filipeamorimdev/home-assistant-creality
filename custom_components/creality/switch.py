"""Switch platform for Creality integration settings."""

from __future__ import annotations

from homeassistant.components.switch import SwitchEntity
from homeassistant.config_entries import ConfigEntry
from homeassistant.const import STATE_ON
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity import EntityCategory
from homeassistant.helpers.entity_platform import AddEntitiesCallback
from homeassistant.helpers.restore_state import RestoreEntity

from .const import DOMAIN
from .coordinator import CrealityCoordinator
from .entity import CrealityEntity


async def async_setup_entry(
    hass: HomeAssistant, entry: ConfigEntry, async_add_entities: AddEntitiesCallback
) -> None:
    coord: CrealityCoordinator = hass.data[DOMAIN][entry.entry_id]
    async_add_entities([OwnEstimateSwitch(coord)])


class OwnEstimateSwitch(CrealityEntity, RestoreEntity, SwitchEntity):
    """Opt-in for the integration's own time-left estimate (off by default).

    While off, the estimated time-left sensor is unavailable and the card shows
    only the real job time and the printer's (Creality) estimate.
    """

    _attr_translation_key = "own_estimate"
    _attr_entity_category = EntityCategory.CONFIG
    _attr_icon = "mdi:timer-check"
    _requires_connection = False  # Integration setting, not printer state.

    def __init__(self, coordinator: CrealityCoordinator) -> None:
        super().__init__(coordinator, "own_estimate")

    async def async_added_to_hass(self) -> None:
        await super().async_added_to_hass()
        last = await self.async_get_last_state()
        self.coordinator.set_own_estimate(last is not None and last.state == STATE_ON)

    @property
    def is_on(self) -> bool:
        return self.coordinator.own_estimate

    async def async_turn_on(self, **kwargs) -> None:
        self.coordinator.set_own_estimate(True)

    async def async_turn_off(self, **kwargs) -> None:
        self.coordinator.set_own_estimate(False)
