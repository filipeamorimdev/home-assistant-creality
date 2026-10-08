"""Button platform for Creality."""

from __future__ import annotations

import asyncio
import logging

from homeassistant.components.button import ButtonEntity
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity_platform import AddEntitiesCallback

from .const import DOMAIN

# Homing may not be reported immediately after the command is accepted.
HOMING_START_TIMEOUT = 5.0
HOMING_FINISH_TIMEOUT = 60.0
from .coordinator import CrealityCoordinator
from .entity import CrealityEntity

_LOGGER = logging.getLogger(__name__)


async def async_setup_entry(
    hass: HomeAssistant, entry: ConfigEntry, async_add_entities: AddEntitiesCallback
) -> None:
    coord: CrealityCoordinator = hass.data[DOMAIN][entry.entry_id]
    async_add_entities(
        [
            HomeButton(coord),
            PauseButton(coord),
            ResumeButton(coord),
            StopButton(coord),
        ]
    )


class HomeButton(CrealityEntity, ButtonEntity):
    _attr_translation_key = "home_xy_then_z"
    _attr_icon = "mdi:home-circle"

    def __init__(self, coordinator: CrealityCoordinator) -> None:
        super().__init__(coordinator, "home_xy_then_z")
        self._lock = asyncio.Lock()

    async def async_press(self) -> None:
        async with self._lock:
            await self.coordinator.async_send_set(autohome="X Y")
            loop = asyncio.get_running_loop()
            # Wait for XY homing to start, then for it to finish, before homing Z.
            started = await self._wait_for(True, loop.time() + HOMING_START_TIMEOUT)
            if started:
                finished = await self._wait_for(False, loop.time() + HOMING_FINISH_TIMEOUT)
                if not finished:
                    _LOGGER.warning("XY homing still in progress after %.0fs; homing Z anyway",
                                    HOMING_FINISH_TIMEOUT)
            else:
                _LOGGER.debug("XY homing state not reported; homing Z")
            await self.coordinator.async_send_set(autohome="Z")

    async def _wait_for(self, homing: bool, deadline: float) -> bool:
        loop = asyncio.get_running_loop()
        while loop.time() < deadline:
            if self.coordinator.is_homing() == homing:
                return True
            await asyncio.sleep(0.25)
        return self.coordinator.is_homing() == homing


class PauseButton(CrealityEntity, ButtonEntity):
    _attr_translation_key = "pause_print"
    _attr_icon = "mdi:pause"

    def __init__(self, coordinator: CrealityCoordinator) -> None:
        super().__init__(coordinator, "pause_print")

    async def async_press(self) -> None:
        await self.coordinator.request_pause()


class ResumeButton(CrealityEntity, ButtonEntity):
    _attr_translation_key = "resume_print"
    _attr_icon = "mdi:play"

    def __init__(self, coordinator: CrealityCoordinator) -> None:
        super().__init__(coordinator, "resume_print")

    async def async_press(self) -> None:
        await self.coordinator.request_resume()


class StopButton(CrealityEntity, ButtonEntity):
    _attr_translation_key = "stop_print"
    _attr_icon = "mdi:stop"

    def __init__(self, coordinator: CrealityCoordinator) -> None:
        super().__init__(coordinator, "stop_print")

    async def async_press(self) -> None:
        await self.coordinator.request_stop()
