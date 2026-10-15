"""WebSocket commands used by the bundled card."""

from __future__ import annotations

from datetime import timedelta
import os
from typing import Any

import aiohttp

import voluptuous as vol
from homeassistant.components import websocket_api
from homeassistant.components.http.auth import async_sign_path
from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers import entity_registry as er

from .const import CONF_TIMELAPSE_AUTO_SAVE, CONF_TIMELAPSE_FOLDER, DOMAIN
from .timelapse import VIEW_URL, download_name
from .timelapse_archive import check_folder, folder_suggestions

# The card asks again before reusing a URL older than half of this.
TIMELAPSE_URL_EXPIRY = timedelta(hours=1)


@callback
def async_register(hass: HomeAssistant) -> None:
    websocket_api.async_register_command(hass, ws_print_profile)
    websocket_api.async_register_command(hass, ws_timelapse)
    websocket_api.async_register_command(hass, ws_timelapse_settings)
    websocket_api.async_register_command(hass, ws_timelapse_settings_set)
    websocket_api.async_register_command(hass, ws_timelapse_save)


def _coordinator(hass: HomeAssistant, entity_id: str):
    """Coordinator of the printer owning ``entity_id``, None for other entities."""
    entry = er.async_get(hass).async_get(entity_id)
    if not entry or entry.platform != DOMAIN:
        return None
    return hass.data.get(DOMAIN, {}).get(entry.config_entry_id)


@websocket_api.websocket_command(
    {vol.Required("type"): f"{DOMAIN}/print_profile", vol.Required("entity_id"): str}
)
@callback
def ws_print_profile(
    hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict[str, Any]
) -> None:
    """G-code silhouette of the job on the printer owning ``entity_id``."""
    coordinator = _coordinator(hass, msg["entity_id"])
    if coordinator is None:
        connection.send_error(msg["id"], websocket_api.ERR_NOT_FOUND, "Not a Creality printer entity")
        return
    connection.send_result(msg["id"], coordinator.profile.as_dict())


@websocket_api.websocket_command(
    {
        vol.Required("type"): f"{DOMAIN}/timelapse",
        vol.Required("entity_id"): str,
        vol.Required("print_start_time"): vol.Coerce(int),
    }
)
@websocket_api.async_response
async def ws_timelapse(
    hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict[str, Any]
) -> None:
    """Timelapse the printer recorded for a job, with signed playback/download URLs.

    ``status``: ``ready`` | ``missing`` (not in the printer's list) |
    ``unavailable`` (printer did not answer). ``saved_as``: path the archive
    copied it to, when it did.
    """
    coordinator = _coordinator(hass, msg["entity_id"])
    if coordinator is None:
        connection.send_error(msg["id"], websocket_api.ERR_NOT_FOUND, "Not a Creality printer entity")
        return
    archive = coordinator.archive
    saved = archive.saved.get(str(msg["print_start_time"]))
    extra = {"saved_as": os.path.join(archive.folder, saved)} if saved and archive.folder else {}
    try:
        video = await coordinator.timelapse.async_find(msg["print_start_time"])
    except (ConnectionError, TimeoutError):
        connection.send_result(msg["id"], {"status": "unavailable", **extra})
        return
    if video is None:
        connection.send_result(msg["id"], {"status": "missing", **extra})
        return
    path = VIEW_URL.format(entry_id=coordinator.entry.entry_id, name=video["videoname"])

    def sign(url: str) -> str:
        return async_sign_path(
            hass, url, TIMELAPSE_URL_EXPIRY, refresh_token_id=connection.refresh_token_id
        )

    connection.send_result(
        msg["id"],
        {
            "status": "ready",
            "url": sign(path),
            "download_url": sign(f"{path}?download=1"),
            "file": video.get("gcodename"),
            "filename": download_name(video),
            "size": video.get("size"),
            "duration": video.get("duration"),
            "expires_in": int(TIMELAPSE_URL_EXPIRY.total_seconds()),
            **extra,
        },
    )


async def _settings(hass: HomeAssistant, connection: websocket_api.ActiveConnection, coordinator) -> dict[str, Any]:
    archive = coordinator.archive
    return {
        "folder": archive.folder or "",
        "auto_save": archive.auto_save,
        "can_edit": connection.user.is_admin,
        "suggestions": await hass.async_add_executor_job(folder_suggestions, hass),
        **{key: value for key, value in archive.as_attributes().items() if key not in ("folder", "auto_save")},
        "status": archive.status,
    }


@websocket_api.websocket_command(
    {vol.Required("type"): f"{DOMAIN}/timelapse_settings", vol.Required("entity_id"): str}
)
@websocket_api.async_response
async def ws_timelapse_settings(
    hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict[str, Any]
) -> None:
    """Timelapse folder, auto-save flag and folders to choose from."""
    coordinator = _coordinator(hass, msg["entity_id"])
    if coordinator is None:
        connection.send_error(msg["id"], websocket_api.ERR_NOT_FOUND, "Not a Creality printer entity")
        return
    connection.send_result(msg["id"], await _settings(hass, connection, coordinator))


@websocket_api.websocket_command(
    {
        vol.Required("type"): f"{DOMAIN}/timelapse_settings/set",
        vol.Required("entity_id"): str,
        vol.Required("folder"): str,
        vol.Required("auto_save"): bool,
    }
)
@websocket_api.require_admin
@websocket_api.async_response
async def ws_timelapse_settings_set(
    hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict[str, Any]
) -> None:
    """Store the folder and auto-save flag in the integration options (applied live)."""
    coordinator = _coordinator(hass, msg["entity_id"])
    if coordinator is None:
        connection.send_error(msg["id"], websocket_api.ERR_NOT_FOUND, "Not a Creality printer entity")
        return
    folder, error = await hass.async_add_executor_job(check_folder, hass, msg["folder"])
    if not error and msg["auto_save"] and not folder:
        error = "folder_required"
    if error:
        connection.send_error(msg["id"], error, _FOLDER_ERRORS[error])
        return
    entry = coordinator.entry
    hass.config_entries.async_update_entry(
        entry,
        options={**entry.options, CONF_TIMELAPSE_FOLDER: folder, CONF_TIMELAPSE_AUTO_SAVE: msg["auto_save"]},
    )
    # The update listener applies the change; make sure it ran before answering.
    coordinator.archive.async_configure()
    connection.send_result(msg["id"], await _settings(hass, connection, coordinator))


_FOLDER_ERRORS = {
    "folder_not_absolute": "Enter an absolute path, for example /media/nas/timelapses.",
    "folder_not_allowed": "Home Assistant may not write there. Use a folder under /media or one in allowlist_external_dirs.",
    "folder_not_writable": "The folder could not be created or is not writable. Is the share mounted?",
    "folder_required": "Choose a folder to save timelapses automatically.",
}


@websocket_api.websocket_command(
    {
        vol.Required("type"): f"{DOMAIN}/timelapse_save",
        vol.Required("entity_id"): str,
        vol.Required("print_start_time"): vol.Coerce(int),
    }
)
@websocket_api.async_response
async def ws_timelapse_save(
    hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict[str, Any]
) -> None:
    """Copy a job's timelapse into the configured folder now."""
    coordinator = _coordinator(hass, msg["entity_id"])
    if coordinator is None:
        connection.send_error(msg["id"], websocket_api.ERR_NOT_FOUND, "Not a Creality printer entity")
        return
    try:
        path = await coordinator.archive.async_save_now(msg["print_start_time"])
    except LookupError as err:
        reason = str(err.args[0]) if err.args else "missing"
        text = "No folder is set for timelapses." if reason == "no_folder" else "The printer has no timelapse for this print."
        connection.send_error(msg["id"], reason, text)
        return
    except (ConnectionError, TimeoutError, OSError, ValueError, aiohttp.ClientError) as err:
        connection.send_error(msg["id"], "save_failed", str(err) or type(err).__name__)
        return
    connection.send_result(msg["id"], {"path": path, "filename": os.path.basename(path)})
