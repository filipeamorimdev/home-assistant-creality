"""End-to-end setup of the integration in a real HA core with a fake printer socket."""

from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from homeassistant.config_entries import ConfigEntryState
from homeassistant.const import STATE_UNAVAILABLE
from homeassistant.core import HomeAssistant
from homeassistant.data_entry_flow import FlowResultType
from homeassistant.exceptions import HomeAssistantError
from homeassistant.helpers import entity_registry as er
from pytest_homeassistant_custom_component.common import MockConfigEntry

DOMAIN = "creality"

FRAME = {
    "state": 1,
    "deviceState": 1,
    "printFileName": "/usr/data/printer_data/gcodes/part_PLA_1h30m.gcode",
    "printStartTime": 1789990474,
    "printProgress": 40,
    "printJobTime": 1200,
    "printLeftTime": 1800,
    "layer": 100,
    "TotalLayer": 250,
    "nozzleTemp": "210.5",
    "targetNozzleTemp": 210,
    "bedTemp0": "60.1",
    "targetBedTemp0": 60,
    "maxNozzleTemp": 280,
    "maxBedTemp": 100,
    "curFeedratePct": 100,
    "curFlowratePct": 95,
    "modelFanPct": 50,
    "lightSw": 1,
    "curPosition": "X:111.69 Y:130.97 Z:1.92",
    "model": "F005",
}


class FakeClient:
    def __init__(self, host, on_message, on_connection_change=None):
        self.host = host
        self.on_message = on_message
        self.on_connection_change = on_connection_change
        self.connected = False
        # Like the real client: report the connection once started.
        self.start = AsyncMock(side_effect=self._connect)
        self.stop = AsyncMock()
        self.wait_connected = AsyncMock(return_value=True)
        self.send_set_retry = AsyncMock()

    async def _connect(self):
        if not self.connected:
            self.connected = True
            if self.on_connection_change:
                self.on_connection_change()


@pytest.fixture
def fake_client():
    clients = []

    def factory(*args, **kwargs):
        client = FakeClient(*args, **kwargs)
        clients.append(client)
        return client

    with patch("custom_components.creality.coordinator.CrealityWsClient", side_effect=factory):
        yield clients


@pytest.fixture
def frontend_stub(hass: HomeAssistant):
    """Skip the real frontend/http servers; only record the card registration."""
    hass.config.components.update({"frontend", "http"})
    hass.http = MagicMock()
    hass.http.async_register_static_paths = AsyncMock()
    with patch("homeassistant.components.frontend.add_extra_js_url") as add_js:
        yield add_js


def entity_id(hass, domain, entry, suffix):
    return er.async_get(hass).async_get_entity_id(domain, DOMAIN, f"{entry.entry_id}_{suffix}")


async def setup_entry(hass, **options):
    entry = MockConfigEntry(domain=DOMAIN, title="Ender", unique_id="10.0.0.24",
                            data={"host": "10.0.0.24", "name": "Ender"},
                            options={"camera_mode": "auto", **options})
    entry.add_to_hass(hass)
    assert await hass.config_entries.async_setup(entry.entry_id)
    await hass.async_block_till_done()
    return entry


async def test_setup_entities_controls_and_offline(hass, fake_client, frontend_stub):
    entry = await setup_entry(hass)
    assert entry.state is ConfigEntryState.LOADED
    frontend_stub.assert_called_once()
    client = fake_client[0]
    coordinator = hass.data[DOMAIN][entry.entry_id]

    coordinator._on_message(dict(FRAME))
    await hass.async_block_till_done()

    status = hass.states.get(entity_id(hass, "sensor", entry, "print_status"))
    assert status.state == "printing"
    eta_id = entity_id(hass, "sensor", entry, "print_time_left_estimated")
    # The integration's own estimate is opt-in through a config switch.
    assert hass.states.get(eta_id).state == STATE_UNAVAILABLE
    own = entity_id(hass, "switch", entry, "own_estimate")
    assert hass.states.get(own).state == "off"
    await hass.services.async_call("switch", "turn_on", {"entity_id": own}, blocking=True)
    eta = hass.states.get(eta_id)
    # Fixed at the job's start from the filename hint (1h30m), with its finish time.
    assert eta.state == "5400"
    assert eta.attributes["expected_finish"]
    nozzle_target = hass.states.get(entity_id(hass, "number", entry, "nozzle_target"))
    assert float(nozzle_target.attributes["max"]) == 280  # limit read after setup
    flow = hass.states.get(entity_id(hass, "number", entry, "flow_tuning"))
    assert float(flow.state) == 95
    # Positions change with nearly every frame: registered but disabled by default.
    pos_x = er.async_get(hass).async_get(entity_id(hass, "sensor", entry, "position_x"))
    assert pos_x.disabled_by is er.RegistryEntryDisabler.INTEGRATION

    # Lifetime totals arrive with the history list, which is not merged.
    coordinator._on_message({"totalJob": 50, "historyList": [{"id": 1}]})
    await hass.async_block_till_done()
    assert hass.states.get(entity_id(hass, "sensor", entry, "total_jobs")).state == "50"
    assert "historyList" not in coordinator.data
    # A reconnect may clear the totals until the history list returns: keep the
    # last value (never the one restored at start) so the counter cannot drop.
    coordinator.data.pop("totalJob")
    coordinator._publish()
    await hass.async_block_till_done()
    assert hass.states.get(entity_id(hass, "sensor", entry, "total_jobs")).state == "50"

    # Speed and flow are independent commands.
    await hass.services.async_call("number", "set_value", {
        "entity_id": entity_id(hass, "number", entry, "print_tuning"), "value": 150}, blocking=True)
    client.send_set_retry.assert_awaited_once_with(setFeedratePct=150)
    client.send_set_retry.reset_mock()
    await hass.services.async_call("number", "set_value", {
        "entity_id": flow.entity_id, "value": 105}, blocking=True)
    client.send_set_retry.assert_awaited_once_with(setFlowratePct=105)

    # Command failures reach the caller as HomeAssistantError.
    client.send_set_retry.side_effect = ConnectionError("socket closed")
    with pytest.raises(HomeAssistantError):
        await hass.services.async_call("button", "press", {
            "entity_id": entity_id(hass, "button", entry, "pause_print")}, blocking=True)

    # Disconnect: telemetry goes unavailable, status/online stay meaningful.
    client.connected = False
    coordinator._on_connection_change()
    await hass.async_block_till_done()
    assert hass.states.get(entity_id(hass, "sensor", entry, "nozzle_temperature")).state == STATE_UNAVAILABLE
    assert hass.states.get(entity_id(hass, "sensor", entry, "print_status")).state == "offline"
    assert hass.states.get(entity_id(hass, "binary_sensor", entry, "online")).state == "off"

    assert await hass.config_entries.async_unload(entry.entry_id)
    await hass.async_block_till_done()
    assert entry.state is ConfigEntryState.NOT_LOADED
    client.stop.assert_awaited()


async def test_remove_entry_deletes_stores(hass, fake_client, frontend_stub):
    entry = await setup_entry(hass)
    with patch("custom_components.creality.Store.async_remove", new=AsyncMock()) as remove:
        assert await hass.config_entries.async_remove(entry.entry_id)
        await hass.async_block_till_done()
    assert remove.await_count == 1  # Timelapse auto-save.


async def test_setup_drops_retired_background_energy(hass, fake_client, frontend_stub):
    entry = MockConfigEntry(domain=DOMAIN, title="K2", unique_id="10.0.0.31",
                            data={"host": "10.0.0.31", "name": "K2"},
                            options={"camera_mode": "auto", "energy_sensor": "sensor.plug_power"})
    entry.add_to_hass(hass)
    registry = er.async_get(hass)
    registry.async_get_or_create("sensor", DOMAIN, f"{entry.entry_id}_print_energy", config_entry=entry)
    with patch("custom_components.creality.Store.async_remove", new=AsyncMock()) as remove:
        assert await hass.config_entries.async_setup(entry.entry_id)
        await hass.async_block_till_done()
    assert "energy_sensor" not in entry.options
    assert registry.async_get_entity_id("sensor", DOMAIN, f"{entry.entry_id}_print_energy") is None
    remove.assert_awaited_once()
    result = await hass.config_entries.options.async_init(entry.entry_id)
    assert "energy_sensor" not in result["data_schema"].schema


async def test_options_require_custom_camera_url(hass, fake_client, frontend_stub):
    entry = await setup_entry(hass)
    result = await hass.config_entries.options.async_init(entry.entry_id)
    assert result["type"] is FlowResultType.FORM
    result = await hass.config_entries.options.async_configure(
        result["flow_id"], {"camera_mode": "custom", "custom_camera_url": " "})
    assert result["type"] is FlowResultType.FORM
    assert result["errors"] == {"custom_camera_url": "custom_url_required"}
    result = await hass.config_entries.options.async_configure(
        result["flow_id"], {"camera_mode": "custom", "custom_camera_url": "rtsp://x"})
    assert result["errors"] == {"custom_camera_url": "invalid_camera_url"}
    result = await hass.config_entries.options.async_configure(
        result["flow_id"], {"camera_mode": "custom", "custom_camera_url": " http://cam/snap "})
    assert result["type"] is FlowResultType.CREATE_ENTRY
    assert entry.options["custom_camera_url"] == "http://cam/snap"
    await hass.async_block_till_done()  # options reload the entry; finish with the fake socket
    assert entry.state is ConfigEntryState.LOADED


async def test_camera_snapshot_reads_complete_frame_from_chunks(hass, fake_client, frontend_stub):
    from custom_components.creality.camera import _read_first_jpeg

    frame = b"\xff\xd8" + b"x" * 100_000 + b"\xff\xd9"
    multipart = b"--boundary\r\nContent-Type: image/jpeg\r\n\r\n" + frame + b"\r\n--boundary"

    class Content:
        async def iter_chunked(self, size):
            for i in range(0, len(multipart), 4096):
                yield multipart[i : i + 4096]

    assert await _read_first_jpeg(MagicMock(content=Content())) == frame


async def test_webrtc_camera_uses_go2rtc_creality_source(hass, fake_client, frontend_stub):
    from homeassistant.components.camera import (
        CameraEntityFeature,
        async_get_stream_source,
        get_camera_from_entity_id,
    )

    entry = MockConfigEntry(domain=DOMAIN, title="K2", unique_id="10.0.0.30",
                            data={"host": "10.0.0.30", "name": "K2"},
                            options={"camera_mode": "webrtc"})
    entry.add_to_hass(hass)
    assert await hass.config_entries.async_setup(entry.entry_id)
    await hass.async_block_till_done()
    camera_id = entity_id(hass, "camera", entry, "printer_camera")
    camera = get_camera_from_entity_id(hass, camera_id)

    assert await async_get_stream_source(hass, camera_id) == (
        "webrtc:http://10.0.0.30:8000/call/webrtc_local#format=creality"
    )
    # Without go2rtc, HA's HLS worker cannot open the source: do not advertise streaming.
    assert CameraEntityFeature.STREAM not in camera.supported_features
    assert camera.use_stream_for_stills is False

    hass.config.components.add("go2rtc")
    assert CameraEntityFeature.STREAM in camera.supported_features
    assert camera.use_stream_for_stills is True
    camera.async_write_ha_state()
    await hass.async_block_till_done()
    state = hass.states.get(camera_id)
    assert state.attributes["supported_features"] & CameraEntityFeature.STREAM


async def test_mjpeg_camera_has_no_stream_source(hass, fake_client, frontend_stub):
    from homeassistant.components.camera import CameraEntityFeature, get_camera_from_entity_id

    entry = await setup_entry(hass)
    hass.config.components.add("go2rtc")
    camera = get_camera_from_entity_id(hass, entity_id(hass, "camera", entry, "printer_camera"))
    assert await camera.stream_source() is None
    assert CameraEntityFeature.STREAM not in camera.supported_features
    # Auto mode switches to WebRTC once the printer reports support.
    hass.data[DOMAIN][entry.entry_id]._on_message({"webrtcSupport": 1})
    assert (await camera.stream_source()).endswith("#format=creality")
    assert CameraEntityFeature.STREAM in camera.supported_features


class FakeResources:
    """Minimal stand-in for Lovelace's resource storage collection."""

    def __init__(self, items):
        self.items = {item["id"]: dict(item) for item in items}
        self.loaded = False
        self.deleted = []

    async def async_load(self):
        self.loaded = True

    def async_items(self):
        return list(self.items.values())

    async def async_delete_item(self, item_id):
        self.deleted.append(item_id)
        del self.items[item_id]


class FakeYamlResources:
    loaded = True

    def __init__(self, items):
        self.items = items

    def async_items(self):
        return self.items


def test_legacy_url_matching():
    from custom_components.creality.legacy_card import is_legacy_card_url

    assert is_legacy_card_url("/local/creality/card.js?v=0.0.3")
    assert is_legacy_card_url("/hacsfiles/home-assistant-creality-card/creality-card.js?hacstag=1")
    assert is_legacy_card_url("/local/community/creality-card/creality-card.js")
    assert not is_legacy_card_url("/creality/creality-card.js?v=0.1.12")  # bundled
    assert not is_legacy_card_url("/hacsfiles/frigate-hass-card/frigate-hass-card.js")
    assert not is_legacy_card_url("")


async def test_legacy_card_resource_repair_removes_old_resources(hass, fake_client, frontend_stub):
    from types import SimpleNamespace

    from homeassistant.helpers import issue_registry as ir

    from custom_components.creality import repairs
    from custom_components.creality.legacy_card import (
        LEGACY_ISSUE_ID,
        async_check_legacy_resources,
    )

    resources = FakeResources([
        {"id": "old", "url": "/local/creality/card.js?v=0.0.3", "type": "module"},
        {"id": "other", "url": "/hacsfiles/mushroom/mushroom.js", "type": "module"},
    ])
    hass.data["lovelace"] = SimpleNamespace(resource_mode="storage", resources=resources)
    await setup_entry(hass)  # async_setup schedules the check once HA has started
    await hass.async_block_till_done()

    issue = ir.async_get(hass).async_get_issue(DOMAIN, LEGACY_ISSUE_ID)
    assert issue is not None and issue.is_fixable
    assert issue.translation_placeholders == {"urls": "/local/creality/card.js?v=0.0.3"}

    flow = await repairs.async_create_fix_flow(hass, LEGACY_ISSUE_ID, issue.data)
    flow.hass, flow.handler, flow.issue_id = hass, DOMAIN, LEGACY_ISSUE_ID
    result = await flow.async_step_init()
    assert result["type"] is FlowResultType.FORM
    assert result["description_placeholders"]["urls"] == "/local/creality/card.js?v=0.0.3"
    result = await flow.async_step_confirm({})
    assert result["type"] is FlowResultType.CREATE_ENTRY
    assert resources.deleted == ["old"]

    await async_check_legacy_resources(hass)
    assert ir.async_get(hass).async_get_issue(DOMAIN, LEGACY_ISSUE_ID) is None


async def test_legacy_card_resource_in_yaml_mode_is_not_fixable(hass):
    from types import SimpleNamespace

    from homeassistant.helpers import issue_registry as ir

    from custom_components.creality.legacy_card import (
        LEGACY_ISSUE_ID,
        LEGACY_ISSUE_YAML_ID,
        async_check_legacy_resources,
    )

    hass.data["lovelace"] = SimpleNamespace(
        resource_mode="yaml",
        resources=FakeYamlResources([{"url": "/local/creality/card.js", "type": "module"}]),
    )
    await async_check_legacy_resources(hass)
    registry = ir.async_get(hass)
    issue = registry.async_get_issue(DOMAIN, LEGACY_ISSUE_YAML_ID)
    assert issue is not None and not issue.is_fixable
    assert registry.async_get_issue(DOMAIN, LEGACY_ISSUE_ID) is None
    hass.data["lovelace"].resources.items = []
    await async_check_legacy_resources(hass)
    assert registry.async_get_issue(DOMAIN, LEGACY_ISSUE_YAML_ID) is None


async def test_print_profile_downloaded_once_per_job(hass, fake_client, frontend_stub, aioclient_mock):
    from custom_components.creality.websocket import ws_print_profile

    url = "http://10.0.0.24/downloads/gcode/part_PLA_1h30m.gcode"
    aioclient_mock.clear_requests()
    aioclient_mock.get(url, content=b"M83\n;LAYER_CHANGE\n;Z:0.2\nG1 X0 Y0\nG1 X10 Y5 E1\n")
    entry = await setup_entry(hass)
    coordinator = hass.data[DOMAIN][entry.entry_id]
    connection = MagicMock()
    status_id = entity_id(hass, "sensor", entry, "print_status")

    coordinator._on_message(dict(FRAME))
    coordinator._on_message({"layer": 101})  # Same job: no second download.
    await hass.async_block_till_done(wait_background_tasks=True)
    assert aioclient_mock.call_count == 1

    ws_print_profile(hass, connection, {"id": 1, "type": "creality/print_profile", "entity_id": status_id})
    result = connection.send_result.call_args.args[1]
    assert result["status"] == "ready"
    assert result["file"] == FRAME["printFileName"]
    assert result["profile"]["layers"] == 1
    assert result["profile"]["x"]["size"] == 10.5

    # USB jobs are not served over HTTP; the profile is reported unavailable.
    coordinator._on_message({"printFileName": "/mnt/exUDISK/part.gcode", "printStartTime": 2})
    await hass.async_block_till_done()
    ws_print_profile(hass, connection, {"id": 2, "type": "creality/print_profile", "entity_id": status_id})
    assert connection.send_result.call_args.args[1]["status"] == "unavailable"
    assert aioclient_mock.call_count == 1

    ws_print_profile(hass, connection, {"id": 3, "type": "creality/print_profile", "entity_id": "sensor.other"})
    connection.send_error.assert_called_once()


TIMELAPSES = [
    {"id": FRAME["printStartTime"], "videoname": f"{FRAME['printStartTime']}.mp4",
     "gcodename": "part_PLA_1h30m.gcode", "size": 11, "duration": 9},
]


async def test_timelapse_lookup_and_proxy(hass, fake_client, frontend_stub, aioclient_mock, aiohttp_client, socket_enabled, tmp_path):
    from aiohttp import web
    from homeassistant.components.http import KEY_HASS
    from custom_components.creality.timelapse import SAVED_VIEW_URL, VIEW_URL, SavedTimelapseView, TimelapseView
    from custom_components.creality.timelapse_archive import archive_name
    from custom_components.creality.websocket import ws_timelapse

    entry = await setup_entry(hass)
    coordinator = hass.data[DOMAIN][entry.entry_id]
    client = fake_client[0]
    client.send_json = AsyncMock(
        side_effect=lambda payload: coordinator._on_message({"elapseVideoList": TIMELAPSES})
    )
    status_id = entity_id(hass, "sensor", entry, "print_status")
    connection = MagicMock(refresh_token_id="refresh-token")

    async def lookup(msg_id, start):
        ws_timelapse(hass, connection, {"id": msg_id, "type": "creality/timelapse",
                                        "entity_id": status_id, "print_start_time": start})
        await hass.async_block_till_done(wait_background_tasks=True)
        assert not connection.async_handle_exception.called, connection.async_handle_exception.call_args
        return connection.send_result.call_args.args[1]

    result = await lookup(1, FRAME["printStartTime"])
    assert result["status"] == "ready"
    assert result["file"] == "part_PLA_1h30m.gcode"
    assert result["filename"] == "part_PLA_1h30m-timelapse.mp4"
    path = VIEW_URL.format(entry_id=entry.entry_id, name=TIMELAPSES[0]["videoname"])
    assert result["url"].startswith(f"{path}?authSig=")
    assert result["download_url"].startswith(f"{path}?download=1&authSig=")
    assert "elapseVideoList" not in coordinator.data

    assert result["source"] == "printer"
    assert "saved_as" not in result
    assert (await lookup(2, 42))["status"] == "missing"
    # A record whose file is gone from the folder is not reported.
    coordinator.archive.folder = str(tmp_path)
    coordinator.archive.saved["42"] = "2026-10-12_162514_part.mp4"
    assert (await lookup(21, 42)) == {"status": "missing"}
    coordinator.archive.saved.clear()
    coordinator.timelapse._fetched_at = None
    client.send_json = AsyncMock(side_effect=ConnectionError("closed"))
    assert (await lookup(3, FRAME["printStartTime"])) == {"status": "unavailable"}

    # A copy on disk is served from the folder, also while the printer is offline,
    # found by the recorded name or by the job's start-time prefix.
    stamp = archive_name({"id": FRAME["printStartTime"]})[:-4]
    (tmp_path / f"{stamp}_part.mp4.part").write_bytes(b"partial")
    (tmp_path / f"{stamp}_part.mp4").write_bytes(b"saved-video")
    result = await lookup(4, FRAME["printStartTime"])
    saved_path = SAVED_VIEW_URL.format(entry_id=entry.entry_id, start=FRAME["printStartTime"])
    assert result["status"] == "ready" and result["source"] == "folder"
    assert result["saved_as"] == str(tmp_path / f"{stamp}_part.mp4")
    assert result["filename"] == f"{stamp}_part.mp4"
    assert result["size"] == 11
    assert result["url"].startswith(f"{saved_path}?authSig=")
    assert result["download_url"].startswith(f"{saved_path}?download=1&authSig=")

    # The view streams listed videos from the printer and forwards Range requests.
    coordinator.timelapse.entries = TIMELAPSES
    video_url = f"http://10.0.0.24/downloads/video/{TIMELAPSES[0]['videoname']}"
    aioclient_mock.get(video_url, content=b"mp4-content",
                       headers={"Content-Length": "11", "Accept-Ranges": "bytes"})
    view = TimelapseView()
    app = web.Application()
    app[KEY_HASS] = hass
    app.router.add_get(VIEW_URL, lambda request: view.get(request, **request.match_info))
    http = await aiohttp_client(app)
    resp = await http.get(f"{path}?download=1", headers={"Range": "bytes=0-"})
    assert resp.status == 200
    assert await resp.read() == b"mp4-content"
    assert resp.headers["Content-Type"] == "video/mp4"
    assert resp.headers["Content-Disposition"].startswith('attachment; filename="part_PLA_1h30m-timelapse.mp4"')
    assert aioclient_mock.mock_calls[-1][3] == {"Range": "bytes=0-"}
    resp = await http.get(path)
    assert resp.headers["Content-Disposition"].startswith("inline;")
    # Files the printer did not list are never fetched.
    calls = aioclient_mock.call_count
    resp = await http.get(VIEW_URL.format(entry_id=entry.entry_id, name="7.mp4"))
    assert resp.status == 502  # Not listed; the list refresh fails (printer offline).
    assert (await http.get(VIEW_URL.format(entry_id="nope", name="7.mp4"))).status == 404
    assert (await http.get(VIEW_URL.format(entry_id=entry.entry_id, name="x.txt"))).status == 404
    assert aioclient_mock.call_count == calls

    # The folder copy is served with Range support; other names never are.
    saved_view = SavedTimelapseView()
    app = web.Application()
    app[KEY_HASS] = hass
    app.router.add_get(SAVED_VIEW_URL, lambda request: saved_view.get(request, **request.match_info))
    http = await aiohttp_client(app)
    resp = await http.get(f"{saved_path}?download=1", headers={"Range": "bytes=0-4"})
    assert resp.status == 206
    assert await resp.read() == b"saved"
    assert resp.headers["Content-Type"] == "video/mp4"
    assert resp.headers["Content-Disposition"].startswith(f'attachment; filename="{stamp}_part.mp4"')
    assert (await http.get(SAVED_VIEW_URL.format(entry_id=entry.entry_id, start=42))).status == 404
    assert (await http.get(SAVED_VIEW_URL.format(entry_id="nope", start=FRAME["printStartTime"]))).status == 404
    (tmp_path / f"{stamp}_part.mp4").unlink()
    assert (await http.get(saved_path)).status == 404


def test_timelapse_archive_name():
    from homeassistant.util import dt as dt_util
    from custom_components.creality.timelapse_archive import archive_name

    stamp = dt_util.as_local(dt_util.utc_from_timestamp(1789990474)).strftime("%Y-%m-%d_%H%M%S")
    assert archive_name(TIMELAPSES[0]) == f"{stamp}_part_PLA_1h30m.mp4"
    # Share-hostile characters are replaced; no G-code name keeps the timestamp only.
    assert archive_name({"id": 1789990474, "gcodename": "/x/a:b?c.gcode"}) == f"{stamp}_a_b_c.mp4"
    assert archive_name({"id": 1789990474}) == f"{stamp}.mp4"


async def test_config_flow_validates_timelapse_folder(hass, fake_client, frontend_stub, tmp_path):
    hass.config.allowlist_external_dirs = {str(tmp_path)}
    probe = AsyncMock(return_value={"host": "10.0.0.24", "model": "F005"})
    with patch("custom_components.creality.config_flow._probe_host", probe):
        result = await hass.config_entries.flow.async_init(DOMAIN, context={"source": "user"})
        for folder, error in (("relative/dir", "folder_not_absolute"), ("/etc/creality", "folder_not_allowed")):
            result = await hass.config_entries.flow.async_configure(
                result["flow_id"], {"host": "10.0.0.24", "name": "Ender", "timelapse_folder": folder})
            assert result["type"] is FlowResultType.FORM
            assert result["errors"] == {"timelapse_folder": error}
        folder = tmp_path / "timelapses"
        result = await hass.config_entries.flow.async_configure(
            result["flow_id"], {"host": "10.0.0.24", "name": "Ender", "timelapse_folder": f" {folder}/ "})
        assert result["type"] is FlowResultType.CREATE_ENTRY
        await hass.async_block_till_done()
    assert result["result"].options["timelapse_folder"] == str(folder)
    assert folder.is_dir()  # Created by validation.

    # Options can change or clear it.
    entry = result["result"]
    result = await hass.config_entries.options.async_init(entry.entry_id)
    result = await hass.config_entries.options.async_configure(
        result["flow_id"], {"camera_mode": "auto", "timelapse_folder": "nas"})
    assert result["errors"] == {"timelapse_folder": "folder_not_absolute"}
    result = await hass.config_entries.options.async_configure(
        result["flow_id"], {"camera_mode": "auto", "timelapse_auto_save": False})
    assert result["type"] is FlowResultType.CREATE_ENTRY
    assert entry.options["timelapse_folder"] == ""
    await hass.async_block_till_done()
    assert hass.states.get(entity_id(hass, "sensor", entry, "timelapse_archive")).state == "off"


async def test_timelapse_saved_to_folder_after_finish(hass, fake_client, frontend_stub, aioclient_mock, tmp_path):
    from custom_components.creality.timelapse_archive import archive_name

    hass.config.allowlist_external_dirs = {str(tmp_path)}
    entry = await setup_entry(hass, timelapse_folder=str(tmp_path))
    coordinator = hass.data[DOMAIN][entry.entry_id]
    client = fake_client[0]
    listed = []
    client.send_json = AsyncMock(
        side_effect=lambda payload: coordinator._on_message({"elapseVideoList": list(listed)})
    )
    video_url = f"http://10.0.0.24/downloads/video/{TIMELAPSES[0]['videoname']}"
    aioclient_mock.get(video_url, content=b"mp4-content")
    sensor_id = entity_id(hass, "sensor", entry, "timelapse_archive")
    assert hass.states.get(sensor_id).state == "idle"

    coordinator._on_message(dict(FRAME))
    coordinator._on_message({"state": 2})
    await hass.async_block_till_done(wait_background_tasks=True)
    # The printer has not rendered the video yet: keep waiting.
    assert hass.states.get(sensor_id).state == "waiting"
    assert not list(tmp_path.iterdir())

    listed.extend(TIMELAPSES)
    coordinator.timelapse._fetched_at = None
    coordinator.archive._kick()
    await hass.async_block_till_done(wait_background_tasks=True)
    saved = tmp_path / archive_name(TIMELAPSES[0])
    assert saved.read_bytes() == b"mp4-content"
    assert [p.name for p in tmp_path.iterdir()] == [saved.name]  # No .part left behind.
    state = hass.states.get(sensor_id)
    assert state.state == "saved"
    assert state.attributes["last_file"] == str(saved)
    assert state.attributes["pending"] == 0

    # The same job reported again (reconnect, restart) is not copied twice.
    calls = aioclient_mock.call_count
    coordinator._on_message({"state": 0})
    coordinator._on_message({"state": 2})
    await hass.async_block_till_done(wait_background_tasks=True)
    assert aioclient_mock.call_count == calls

    # A short download is discarded and retried, never kept as the video.
    saved.unlink()
    coordinator._on_message({"state": 1, "printStartTime": 1789999999})
    coordinator._on_message({"state": 2})
    listed[:] = [{**TIMELAPSES[0], "id": 1789999999, "videoname": "1789999999.mp4", "size": 99}]
    coordinator.timelapse._fetched_at = None
    aioclient_mock.get("http://10.0.0.24/downloads/video/1789999999.mp4", content=b"short")
    coordinator.archive._kick()
    await hass.async_block_till_done(wait_background_tasks=True)
    state = hass.states.get(sensor_id)
    assert state.state == "failed"
    assert "incomplete" in state.attributes["last_error"]
    assert state.attributes["pending"] == 1
    assert not list(tmp_path.iterdir())

    assert await hass.config_entries.async_unload(entry.entry_id)
    await hass.async_block_till_done()


async def test_timelapse_settings_and_save_from_card(hass, fake_client, frontend_stub, aioclient_mock, tmp_path, hass_admin_user):
    from custom_components.creality.timelapse_archive import archive_name
    from custom_components.creality.websocket import (
        ws_timelapse_save, ws_timelapse_settings, ws_timelapse_settings_set)

    share = tmp_path / "nas"
    share.mkdir()
    hass.config.media_dirs = {"local": str(tmp_path)}
    hass.config.allowlist_external_dirs = {str(tmp_path)}
    entry = await setup_entry(hass)
    coordinator = hass.data[DOMAIN][entry.entry_id]
    client = fake_client[0]
    client.send_json = AsyncMock(
        side_effect=lambda payload: coordinator._on_message({"elapseVideoList": TIMELAPSES})
    )
    status_id = entity_id(hass, "sensor", entry, "print_status")
    sensor_id = entity_id(hass, "sensor", entry, "timelapse_archive")
    connection = MagicMock(user=hass_admin_user)

    async def call(handler, **msg):
        connection.reset_mock()
        handler(hass, connection, {"id": 1, "entity_id": status_id, **msg})
        await hass.async_block_till_done(wait_background_tasks=True)
        if connection.send_error.called:
            return connection.send_error.call_args.args[1]
        return connection.send_result.call_args.args[1]

    settings = await call(ws_timelapse_settings, type="creality/timelapse_settings")
    assert settings["folder"] == "" and settings["can_edit"] is True
    assert settings["suggestions"] == [str(tmp_path), str(share)]  # Mounted shares sit under /media.
    assert hass.states.get(sensor_id).state == "off"
    assert await call(ws_timelapse_save, type="creality/timelapse_save",
                      print_start_time=FRAME["printStartTime"]) == "no_folder"

    base = {"type": "creality/timelapse_settings/set"}
    assert await call(ws_timelapse_settings_set, **base, folder="", auto_save=True) == "folder_required"
    assert await call(ws_timelapse_settings_set, **base, folder="/etc/x", auto_save=False) == "folder_not_allowed"
    client.start.reset_mock()
    settings = await call(ws_timelapse_settings_set, **base, folder=str(share), auto_save=False)
    assert settings["folder"] == str(share) and settings["auto_save"] is False
    assert entry.options["timelapse_folder"] == str(share)
    assert entry.options["timelapse_auto_save"] is False
    client.start.assert_not_called()  # Applied live: the printer connection was not reloaded.
    assert hass.states.get(sensor_id).state == "idle"

    # Auto-save off: a finished job is not copied by itself...
    coordinator._on_message(dict(FRAME))
    coordinator._on_message({"state": 2})
    await hass.async_block_till_done(wait_background_tasks=True)
    assert not list(share.iterdir())
    # ...but the card's button saves it on demand.
    aioclient_mock.get(f"http://10.0.0.24/downloads/video/{TIMELAPSES[0]['videoname']}", content=b"mp4-content")
    result = await call(ws_timelapse_save, type="creality/timelapse_save", print_start_time=FRAME["printStartTime"])
    saved = share / archive_name(TIMELAPSES[0])
    assert result == {"path": str(saved), "filename": saved.name}
    assert saved.read_bytes() == b"mp4-content"
    assert hass.states.get(sensor_id).state == "saved"
    assert await call(ws_timelapse_save, type="creality/timelapse_save", print_start_time=42) == "missing"

    assert await hass.config_entries.async_unload(entry.entry_id)
    await hass.async_block_till_done()
