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
from homeassistant.exceptions import HomeAssistantError
from homeassistant.helpers import entity_registry as er

from .const import CONF_TIMELAPSE_AUTO_SAVE, CONF_TIMELAPSE_FOLDER, DOMAIN
from .gcode_archive import PrintAgainError
from .timelapse import SAVED_VIEW_URL, VIEW_URL, download_name, find_video
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
    websocket_api.async_register_command(hass, ws_gcode_files)
    websocket_api.async_register_command(hass, ws_print_again)


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
    """Timelapse of a job, with signed playback/download URLs.

    ``status``: ``ready`` | ``missing`` (not in the printer's list) |
    ``unavailable`` (printer did not answer). A copy found in the timelapse
    folder is served instead of the printer's (``source: "folder"``), also
    while the printer is off; local files can be seeked.
    ``saved_as``: that copy's path, only while it exists on disk.
    """
    coordinator = _coordinator(hass, msg["entity_id"])
    if coordinator is None:
        connection.send_error(msg["id"], websocket_api.ERR_NOT_FOUND, "Not a Creality printer entity")
        return
    start = msg["print_start_time"]
    entry_id = coordinator.entry.entry_id

    def sign(url: str) -> str:
        return async_sign_path(
            hass, url, TIMELAPSE_URL_EXPIRY, refresh_token_id=connection.refresh_token_id
        )

    saved = await coordinator.archive.async_find_saved(start)
    if saved:
        try:
            size = (await hass.async_add_executor_job(os.stat, saved)).st_size
        except OSError:
            size = None
        # Printer details (duration, G-code) only from the cached list: no network wait.
        video = find_video(coordinator.timelapse.entries, start) or {}
        path = SAVED_VIEW_URL.format(entry_id=entry_id, start=start)
        connection.send_result(
            msg["id"],
            {
                "status": "ready",
                "source": "folder",
                "url": sign(path),
                "download_url": sign(f"{path}?download=1"),
                "file": video.get("gcodename"),
                "filename": os.path.basename(saved),
                "size": size,
                "duration": video.get("duration"),
                "expires_in": int(TIMELAPSE_URL_EXPIRY.total_seconds()),
                "saved_as": saved,
            },
        )
        return
    try:
        video = await coordinator.timelapse.async_find(start)
    except (ConnectionError, TimeoutError):
        connection.send_result(msg["id"], {"status": "unavailable"})
        return
    if video is None:
        connection.send_result(msg["id"], {"status": "missing"})
        return
    path = VIEW_URL.format(entry_id=entry_id, name=video["videoname"])
    connection.send_result(
        msg["id"],
        {
            "status": "ready",
            "source": "printer",
            "url": sign(path),
            "download_url": sign(f"{path}?download=1"),
            "file": video.get("gcodename"),
            "filename": download_name(video),
            "size": video.get("size"),
            "duration": video.get("duration"),
            "expires_in": int(TIMELAPSE_URL_EXPIRY.total_seconds()),
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


@websocket_api.websocket_command(
    {vol.Required("type"): f"{DOMAIN}/gcode_files", vol.Required("entity_id"): str}
)
@websocket_api.async_response
async def ws_gcode_files(
    hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict[str, Any]
) -> None:
    """Jobs that can be printed again.

    ``saved``: start ids of jobs with a G-code copy in the folder; ``printer``:
    file names on the printer, or None while it does not answer.
    """
    coordinator = _coordinator(hass, msg["entity_id"])
    if coordinator is None:
        connection.send_error(msg["id"], websocket_api.ERR_NOT_FOUND, "Not a Creality printer entity")
        return
    printer = None
    if coordinator.client.connected:
        try:
            printer = [entry["name"] for entry in await coordinator.gcode.files.async_list()]
        except (ConnectionError, TimeoutError):
            printer = None
    connection.send_result(msg["id"], {"saved": await coordinator.gcode.async_saved_jobs(), "printer": printer})


_PRINT_AGAIN_ERRORS = {
    "offline": "The printer is not connected.",
    "busy": "The printer is busy with another job.",
    "no_gcode": "The G-code of this print is neither on the printer nor saved in the folder.",
    "upload_failed": "Couldn't copy the saved G-code to the printer.",
}


@websocket_api.websocket_command(
    {
        vol.Required("type"): f"{DOMAIN}/print_again",
        vol.Required("entity_id"): str,
        vol.Optional("print_start_time"): vol.Any(None, vol.Coerce(int)),
        vol.Optional("file"): vol.Any(None, str),
    }
)
@websocket_api.async_response
async def ws_print_again(
    hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict[str, Any]
) -> None:
    """Start a saved print again (from the printer's file or the folder copy)."""
    coordinator = _coordinator(hass, msg["entity_id"])
    if coordinator is None:
        connection.send_error(msg["id"], websocket_api.ERR_NOT_FOUND, "Not a Creality printer entity")
        return
    try:
        result = await coordinator.gcode.async_print_again(msg.get("print_start_time"), msg.get("file"))
    except PrintAgainError as err:
        reason = err.args[0]
        detail = f" ({err.args[1]})" if len(err.args) > 1 else ""
        connection.send_error(msg["id"], reason, _PRINT_AGAIN_ERRORS.get(reason, reason) + detail)
        return
    except (OSError, HomeAssistantError) as err:
        connection.send_error(msg["id"], "failed", str(err) or type(err).__name__)
        return
    connection.send_result(msg["id"], result)
