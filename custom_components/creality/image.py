"""Current-job thumbnail served through Home Assistant's image proxy."""

from __future__ import annotations

from typing import Any

import aiohttp
from homeassistant.components.image import ImageEntity
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers.aiohttp_client import async_get_clientsession
from homeassistant.helpers.entity_platform import AddEntitiesCallback

from .const import DOMAIN
from .coordinator import CrealityCoordinator
from .entity import CrealityEntity
from .preview import MAX_IMAGE_BYTES, PreviewCache


async def async_setup_entry(
    hass: HomeAssistant, entry: ConfigEntry, async_add_entities: AddEntitiesCallback
) -> None:
    """Register the preview even on firmware without thumbnail support."""
    async_add_entities([CrealityPrintPreview(hass.data[DOMAIN][entry.entry_id])], True)


class CrealityPrintPreview(CrealityEntity, ImageEntity):
    """Fetch the fixed current-print PNG verified on the LAN printer."""

    _attr_translation_key = "current_print_preview"
    _attr_content_type = "image/png"

    def __init__(self, coordinator: CrealityCoordinator) -> None:
        CrealityEntity.__init__(self, coordinator, "current_print_preview")
        ImageEntity.__init__(self, coordinator.hass)
        self._preview = PreviewCache()
        self._url = f"http://{coordinator.host}/downloads/original/current_print_image.png"

    @property
    def should_poll(self) -> bool:
        """Override CoordinatorEntity: the thumbnail has its own HTTP source."""
        return True

    @property
    def available(self) -> bool:
        return super().available and self._preview.content is not None

    @property
    def extra_state_attributes(self) -> dict[str, Any]:
        return {"preview_reason": self._preview.reason}

    @callback
    def _handle_coordinator_update(self) -> None:
        self._preview.sync_job(self.coordinator.data or {})
        self._attr_image_last_updated = self._preview.updated
        super()._handle_coordinator_update()

    async def _fetch(self) -> bytes:
        session = async_get_clientsession(self.coordinator.hass)
        try:
            async with session.get(
                self._url, timeout=aiohttp.ClientTimeout(total=5), allow_redirects=False
            ) as response:
                if response.status != 200:
                    raise ValueError(f"Thumbnail HTTP {response.status}")
                # Bound streamed responses too; do not trust Content-Length.
                data = bytearray()
                async for chunk in response.content.iter_chunked(64 * 1024):
                    data.extend(chunk)
                    if len(data) > MAX_IMAGE_BYTES:
                        raise ValueError("Thumbnail too large")
                return bytes(data)
        except aiohttp.ClientError as err:
            raise OSError("Thumbnail request failed") from err

    async def async_update(self) -> None:
        """Poll independently of browser requests, including while paused."""
        self._preview.sync_job(self.coordinator.data or {})
        await self._preview.refresh(self._fetch)
        self._attr_image_last_updated = self._preview.updated

    async def async_image(self) -> bytes | None:
        await self.async_update()
        self.async_write_ha_state()
        return self._preview.content
