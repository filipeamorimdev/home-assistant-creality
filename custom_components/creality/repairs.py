"""Repair flows for the Creality integration."""

from __future__ import annotations

from typing import Any

import voluptuous as vol
from homeassistant.components.repairs import ConfirmRepairFlow, RepairsFlow
from homeassistant.core import HomeAssistant
from homeassistant.data_entry_flow import FlowResult
from homeassistant.helpers import issue_registry as ir

from .legacy_card import LEGACY_ISSUE_ID, async_remove_legacy_resources


class LegacyCardResourceRepairFlow(RepairsFlow):
    """Remove leftover standalone-card dashboard resources after confirmation."""

    def __init__(self, data: dict[str, Any] | None) -> None:
        raw = str((data or {}).get("resource_ids") or "")
        self._resource_ids = [item for item in raw.split(",") if item]

    async def async_step_init(self, user_input: dict[str, str] | None = None) -> FlowResult:
        return await self.async_step_confirm()

    async def async_step_confirm(self, user_input: dict[str, str] | None = None) -> FlowResult:
        if user_input is not None:
            await async_remove_legacy_resources(self.hass, self._resource_ids)
            return self.async_create_entry(data={})
        issue = ir.async_get(self.hass).async_get_issue(self.handler, self.issue_id)
        return self.async_show_form(
            step_id="confirm",
            data_schema=vol.Schema({}),
            description_placeholders=issue.translation_placeholders if issue else None,
        )


async def async_create_fix_flow(
    hass: HomeAssistant, issue_id: str, data: dict[str, Any] | None
) -> RepairsFlow:
    if issue_id == LEGACY_ISSUE_ID:
        return LegacyCardResourceRepairFlow(data)
    return ConfirmRepairFlow()
