"""Config flow for Creality."""

from __future__ import annotations

import asyncio
import json
import logging
from typing import Any
from urllib.request import Request, urlopen

import voluptuous as vol
from homeassistant import config_entries
from homeassistant.core import HomeAssistant, callback
from homeassistant.data_entry_flow import FlowResult
from homeassistant.helpers import selector

from .const import (
    CAM_MODE_AUTO,
    CAM_MODE_CUSTOM,
    CAM_MODE_MJPEG,
    CAM_MODE_WEBRTC,
    CONF_CAMERA_MODE,
    CONF_CUSTOM_CAMERA_URL,
    CONF_HOST,
    CONF_NAME,
    CONF_TIMELAPSE_AUTO_SAVE,
    CONF_TIMELAPSE_FOLDER,
    DEFAULT_CAMERA_MODE,
    DEFAULT_NAME,
    DOMAIN,
    INFO_URL,
    WS_URL,
)
from .timelapse_archive import check_folder

_LOGGER = logging.getLogger(__name__)

STEP_USER = vol.Schema(
    {
        vol.Required(CONF_HOST): str,
        vol.Optional(CONF_NAME, default=DEFAULT_NAME): str,
        vol.Optional(CONF_TIMELAPSE_FOLDER): str,
        vol.Optional(CONF_TIMELAPSE_AUTO_SAVE, default=True): bool,
    }
)


async def _probe_host(hass: HomeAssistant, host: str) -> dict[str, Any]:
    """Return printer info dict; raise on failure."""
    host = host.strip().split("/")[0].split(":")[0]

    def _http_info() -> dict[str, Any]:
        url = INFO_URL.format(host=host)
        req = Request(url, headers={"User-Agent": "home-assistant-creality/0.1"})
        with urlopen(req, timeout=5) as resp:  # noqa: S310
            return json.loads(resp.read().decode("utf-8", errors="replace"))

    info: dict[str, Any] = {}
    try:
        info = await hass.async_add_executor_job(_http_info)
    except Exception as exc:  # noqa: BLE001
        _LOGGER.debug("HTTP /info failed for %s: %s", host, exc)

    # Confirm WebSocket briefly
    from websockets.asyncio.client import connect as ws_connect

    url = WS_URL.format(host=host)

    async def _ws_ok() -> bool:
        async with ws_connect(url, open_timeout=6, ping_interval=None) as ws:
            await ws.send(json.dumps({"method": "get", "params": {"ReqPrinterPara": 1}}))
            try:
                await asyncio.wait_for(ws.recv(), timeout=4)
            except asyncio.TimeoutError:
                pass
            return True

    try:
        await _ws_ok()
    except Exception as exc:  # noqa: BLE001
        raise ConnectionError(f"WebSocket to {host}:9999 failed: {exc}") from exc

    info["host"] = host
    return info


class CrealityConfigFlow(config_entries.ConfigFlow, domain=DOMAIN):
    """Handle a config flow for Creality."""

    VERSION = 1

    async def async_step_user(self, user_input: dict[str, Any] | None = None) -> FlowResult:
        errors: dict[str, str] = {}
        if user_input is not None:
            host = user_input[CONF_HOST].strip()
            folder, folder_error = await self.hass.async_add_executor_job(
                check_folder, self.hass, user_input.get(CONF_TIMELAPSE_FOLDER)
            )
            try:
                info = await _probe_host(self.hass, host)
            except ConnectionError:
                errors["base"] = "cannot_connect"
            except Exception:  # noqa: BLE001
                errors["base"] = "cannot_connect"
            if folder_error:
                errors[CONF_TIMELAPSE_FOLDER] = folder_error
            if not errors:
                host = info["host"]
                await self.async_set_unique_id(host.lower())
                self._abort_if_unique_id_configured()
                name = user_input.get(CONF_NAME) or info.get("model") or DEFAULT_NAME
                return self.async_create_entry(
                    title=str(name),
                    data={CONF_HOST: host, CONF_NAME: str(name)},
                    options={
                        CONF_CAMERA_MODE: DEFAULT_CAMERA_MODE,
                        CONF_TIMELAPSE_FOLDER: folder,
                        CONF_TIMELAPSE_AUTO_SAVE: user_input.get(CONF_TIMELAPSE_AUTO_SAVE, True),
                    },
                )

        schema = self.add_suggested_values_to_schema(STEP_USER, user_input) if user_input else STEP_USER
        return self.async_show_form(step_id="user", data_schema=schema, errors=errors)

    @staticmethod
    @callback
    def async_get_options_flow(config_entry: config_entries.ConfigEntry):
        return CrealityOptionsFlow()


class CrealityOptionsFlow(config_entries.OptionsFlow):
    async def async_step_init(self, user_input: dict[str, Any] | None = None) -> FlowResult:
        errors = {}
        if user_input is not None:
            custom_url = (user_input.get(CONF_CUSTOM_CAMERA_URL) or "").strip()
            if user_input.get(CONF_CAMERA_MODE) == CAM_MODE_CUSTOM and not custom_url:
                errors[CONF_CUSTOM_CAMERA_URL] = "custom_url_required"
            elif custom_url and not custom_url.lower().startswith(("http://", "https://")):
                errors[CONF_CUSTOM_CAMERA_URL] = "invalid_camera_url"
            folder, folder_error = await self.hass.async_add_executor_job(
                check_folder, self.hass, user_input.get(CONF_TIMELAPSE_FOLDER)
            )
            if folder_error:
                errors[CONF_TIMELAPSE_FOLDER] = folder_error
            if not errors:
                return self.async_create_entry(
                    title="",
                    data={**user_input, CONF_CUSTOM_CAMERA_URL: custom_url, CONF_TIMELAPSE_FOLDER: folder},
                )

        opts = self.config_entry.options
        schema = vol.Schema(
            {
                vol.Required(
                    CONF_CAMERA_MODE,
                    default=opts.get(CONF_CAMERA_MODE, DEFAULT_CAMERA_MODE),
                ): selector.SelectSelector(
                    selector.SelectSelectorConfig(
                        options=[
                            CAM_MODE_AUTO,
                            CAM_MODE_MJPEG,
                            CAM_MODE_WEBRTC,
                            CAM_MODE_CUSTOM,
                        ],
                        mode=selector.SelectSelectorMode.DROPDOWN,
                    )
                ),
                vol.Optional(
                    CONF_CUSTOM_CAMERA_URL,
                    default=opts.get(CONF_CUSTOM_CAMERA_URL, ""),
                ): str,
                vol.Optional(
                    CONF_TIMELAPSE_FOLDER,
                    description={"suggested_value": opts.get(CONF_TIMELAPSE_FOLDER)},
                ): str,
                vol.Optional(
                    CONF_TIMELAPSE_AUTO_SAVE,
                    default=opts.get(CONF_TIMELAPSE_AUTO_SAVE, True),
                ): bool,
            }
        )
        return self.async_show_form(step_id="init", data_schema=schema, errors=errors)
