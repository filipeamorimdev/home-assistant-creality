"""Find dashboard resources left over from the deprecated standalone card.

The integration serves its own ``creality-card`` (see ``CARD_URL``). An old
``/local/creality/card.js`` or HACS ``creality-card.js`` resource registers the
same custom element, and whichever loads first wins, so users could keep
seeing an outdated card. We raise a Repairs issue for such resources; in
storage mode the fix flow removes them after the user confirms.
"""

from __future__ import annotations

import logging
from typing import Any
from urllib.parse import urlsplit

from homeassistant.core import HomeAssistant
from homeassistant.helpers import issue_registry as ir

from .const import CARD_URL, DOMAIN

_LOGGER = logging.getLogger(__name__)

LEGACY_ISSUE_ID = "legacy_card_resource"
LEGACY_ISSUE_YAML_ID = "legacy_card_resource_yaml"
LOVELACE_DOMAIN = "lovelace"


def is_legacy_card_url(url: str) -> bool:
    """True for resource URLs of the standalone card (never the bundled one)."""
    path = urlsplit(str(url or "")).path.lower()
    if not path or path == CARD_URL:
        return False
    return (
        path.endswith("/creality-card.js")
        or path.endswith("/creality/card.js")
        or "/home-assistant-creality-card/" in path
    )


def _resources(hass: HomeAssistant) -> Any | None:
    data = hass.data.get(LOVELACE_DOMAIN)
    if data is None:
        return None
    if isinstance(data, dict):  # Older HA stored a plain dict.
        return data.get("resources")
    return getattr(data, "resources", None)


def _is_storage(resources: Any) -> bool:
    return callable(getattr(resources, "async_delete_item", None))


async def _async_items(resources: Any) -> list[dict[str, Any]]:
    if not getattr(resources, "loaded", True):
        await resources.async_load()
        resources.loaded = True
    return list(resources.async_items() or [])


async def async_check_legacy_resources(hass: HomeAssistant) -> None:
    """Create or clear the Repairs issue for leftover standalone-card resources."""
    resources = _resources(hass)
    legacy: list[dict[str, Any]] = []
    if resources is not None:
        try:
            legacy = [item for item in await _async_items(resources)
                      if is_legacy_card_url(item.get("url", ""))]
        except Exception as err:  # noqa: BLE001 - never block setup on a dashboard check
            _LOGGER.debug("Could not inspect dashboard resources: %s", err)
            return

    storage = resources is not None and _is_storage(resources)
    keep = (LEGACY_ISSUE_ID if storage else LEGACY_ISSUE_YAML_ID) if legacy else None
    for issue_id in (LEGACY_ISSUE_ID, LEGACY_ISSUE_YAML_ID):
        if issue_id != keep:
            ir.async_delete_issue(hass, DOMAIN, issue_id)
    if not keep:
        return

    urls = ", ".join(str(item.get("url")) for item in legacy)
    ir.async_create_issue(
        hass,
        DOMAIN,
        keep,
        is_fixable=storage,
        is_persistent=False,
        severity=ir.IssueSeverity.WARNING,
        translation_key=keep,
        translation_placeholders={"urls": urls},
        data={"resource_ids": ",".join(str(item["id"]) for item in legacy if item.get("id"))},
    )


async def async_remove_legacy_resources(hass: HomeAssistant, resource_ids: list[str]) -> int:
    """Delete the given resources if they are still legacy card resources."""
    resources = _resources(hass)
    if resources is None or not _is_storage(resources):
        return 0
    removed = 0
    for item in await _async_items(resources):
        if item.get("id") in resource_ids and is_legacy_card_url(item.get("url", "")):
            await resources.async_delete_item(item["id"])
            removed += 1
    return removed
