"""Coordinator status/layer/ETA logic with lightweight HA interface doubles."""

import importlib
from pathlib import Path
import sys
from types import ModuleType, SimpleNamespace
import unittest
from unittest.mock import AsyncMock, patch


class HomeAssistantError(Exception):
    pass


class CoordinatorDouble:
    """Stand-in for DataUpdateCoordinator[...] that records published data."""

    def __class_getitem__(cls, _item):
        return cls

    def __init__(self, *args, **kwargs):
        self.data = {}

    def async_set_updated_data(self, data):
        self.data = data


def load_coordinator():
    names = (
        "homeassistant", "homeassistant.config_entries", "homeassistant.core",
        "homeassistant.exceptions", "homeassistant.helpers", "homeassistant.helpers.event",
        "homeassistant.helpers.storage", "homeassistant.helpers.update_coordinator",
        "websockets", "websockets.asyncio", "websockets.asyncio.client",
        "aiohttp", "aiohttp.web", "homeassistant.helpers.aiohttp_client",
        "homeassistant.components", "homeassistant.components.http",
        "homeassistant.util", "homeassistant.util.dt",
    )
    modules = {name: ModuleType(name) for name in names}
    modules["homeassistant.config_entries"].ConfigEntry = object
    modules["homeassistant.core"].HomeAssistant = object
    modules["homeassistant.core"].callback = lambda fn: fn
    modules["homeassistant.exceptions"].HomeAssistantError = HomeAssistantError
    modules["homeassistant.helpers.event"].async_track_state_change_event = None
    modules["homeassistant.helpers.event"].async_track_time_interval = None
    modules["homeassistant.helpers.event"].async_call_later = None
    modules["homeassistant.util"].dt = modules["homeassistant.util.dt"]
    modules["homeassistant.helpers.storage"].Store = object
    modules["homeassistant.helpers.update_coordinator"].DataUpdateCoordinator = CoordinatorDouble
    modules["websockets.asyncio.client"].connect = None
    modules["aiohttp"].ClientTimeout = lambda **kwargs: kwargs
    modules["aiohttp"].ClientError = OSError
    modules["homeassistant.helpers.aiohttp_client"].async_get_clientsession = None
    modules["aiohttp"].web = modules["aiohttp.web"]
    modules["homeassistant.components.http"].KEY_HASS = "hass"
    modules["homeassistant.components.http"].HomeAssistantView = object
    package = ModuleType("coordinator_test_package")
    package.__path__ = [str(Path(__file__).parents[1] / "custom_components/creality")]
    modules[package.__name__] = package
    with patch.dict(sys.modules, modules):
        return (importlib.import_module("coordinator_test_package.coordinator"),
                importlib.import_module("coordinator_test_package.timelapse"))


MODULE, TIMELAPSE = load_coordinator()


def make_coordinator(connected=True):
    coord = MODULE.CrealityCoordinator.__new__(MODULE.CrealityCoordinator)
    CoordinatorDouble.__init__(coord)
    coord.host = "printer"
    coord._peak_layer = coord._peak_total_layer = 0
    coord._peak_job = coord._peak_file = coord._terminal_job = None
    coord._paused = False
    coord.live = connected
    coord._fresh = None
    coord.client = SimpleNamespace(connected=connected, send_set_retry=AsyncMock())
    coord.profile = SimpleNamespace(observe=lambda data: None)
    coord.archive = SimpleNamespace(observe=lambda data: None)
    coord.timelapse = TIMELAPSE.TimelapseIndex(coord)
    coord.own_estimate = True
    coord.plan = None
    coord._last_publish = 0.0
    coord._publish_handle = None
    coord.scheduled = []

    def call_later(delay, fn):
        handle = SimpleNamespace(delay=delay, fn=fn, cancelled=False)
        handle.cancel = lambda: setattr(handle, "cancelled", True)
        coord.scheduled.append(handle)
        return handle

    coord.hass = SimpleNamespace(loop=SimpleNamespace(call_later=call_later))
    return coord


class StatusTests(unittest.TestCase):
    def test_progress_100_is_not_completion_while_printing(self):
        data = {"state": 1, "printFileName": "a.gcode", "printProgress": 100}
        self.assertEqual(MODULE.map_print_status(data), "printing")
        self.assertEqual(MODULE.map_print_status({**data, "state": 2}), "completed")

    def test_state_zero_with_file(self):
        data = {"state": 0, "printFileName": "a.gcode", "printStartTime": 5, "deviceState": 1}
        self.assertEqual(MODULE.map_print_status(data), "processing")
        self.assertEqual(MODULE.map_print_status({**data, "deviceState": 0}), "idle")
        self.assertEqual(MODULE.map_print_status(data, MODULE.job_key(data)), "idle")
        other = MODULE.job_key({**data, "printStartTime": 4})
        self.assertEqual(MODULE.map_print_status(data, other), "processing")

    def test_slicer_hints(self):
        self.assertEqual(MODULE.slicer_hint_seconds("part_PETG_2h9m.gcode"), 2 * 3600 + 9 * 60)
        self.assertEqual(MODULE.slicer_hint_seconds("part_3h_15m.gcode"), 3 * 3600 + 15 * 60)
        self.assertEqual(MODULE.slicer_hint_seconds("part_4h.gcode"), 4 * 3600)
        self.assertIsNone(MODULE.slicer_hint_seconds("benchy.gcode"))

    def test_initial_estimate(self):
        self.assertEqual(MODULE.initial_estimate_seconds({"printFileName": "p_2h40m.gcode",
                                                          "printLeftTime": 100}), 9600)
        data = {"printFileName": "benchy.gcode", "printJobTime": 60, "printLeftTime": 0}
        self.assertIsNone(MODULE.initial_estimate_seconds(data))  # printer not ready yet
        self.assertEqual(MODULE.initial_estimate_seconds({**data, "printLeftTime": 3540}), 3600)


class PublishTests(unittest.TestCase):
    def test_high_rate_frames_are_throttled_and_flushed(self):
        coord = make_coordinator()
        with patch.object(MODULE.time, "monotonic", return_value=100.0):
            coord._on_message({"state": 1, "printFileName": "a.gcode"})
            self.assertEqual(coord.data["__print_status"], "printing")
            coord._on_message({"nozzleTemp": 200.5, "curPosition": "X:1 Y:2 Z:3"})
            coord._on_message({"nozzleTemp": 201.0})
        self.assertEqual(len(coord.scheduled), 1)  # one pending flush, not one per frame
        self.assertAlmostEqual(coord.scheduled[0].delay, MODULE.PUBLISH_INTERVAL)
        published = []
        coord.async_set_updated_data = published.append
        with patch.object(MODULE.time, "monotonic", return_value=101.0):
            coord.scheduled[0].fn()
        self.assertEqual(published[-1]["nozzleTemp"], 201.0)

    def test_state_changes_publish_immediately(self):
        coord = make_coordinator()
        published = []
        coord.async_set_updated_data = published.append
        with patch.object(MODULE.time, "monotonic", return_value=100.0):
            coord._on_message({"state": 1, "printFileName": "a.gcode"})
            coord._on_message({"nozzleTemp": 200.5})
            coord._on_message({"state": 2, "nozzleTemp": 199.0})
        self.assertEqual([d["__print_status"] for d in published], ["printing", "completed"])
        self.assertTrue(coord.scheduled[0].cancelled)  # flush superseded

    def test_history_list_is_not_merged_but_totals_are(self):
        coord = make_coordinator()
        coord._on_message({"totalJob": 50, "totalUsageTime": 234265,
                           "historyList": [{"id": 1, "filename": "a.gcode"}]})
        self.assertNotIn("historyList", coord.data)
        self.assertEqual(coord.data["totalJob"], 50)

    def test_own_estimate_is_opt_in(self):
        coord = make_coordinator()
        coord.own_estimate = False
        coord._on_message({"state": 1, "printFileName": "a_1h0m.gcode", "printJobTime": 600,
                           "printProgress": 10})
        self.assertIsNone(coord.data["__eta_ours"])
        coord.set_own_estimate(True)
        self.assertEqual(coord.data["__eta_ours"], 3600)


class CoordinatorTests(unittest.IsolatedAsyncioTestCase):
    def test_stopped_job_returning_to_state_zero_stays_idle(self):
        coord = make_coordinator()
        job = {"printFileName": "a.gcode", "printStartTime": 5, "deviceState": 1}
        coord._on_message({**job, "state": 1})
        self.assertEqual(coord.data["__print_status"], "printing")
        coord._on_message({"state": 4})
        self.assertEqual(coord.data["__print_status"], "stopped")
        coord._on_message({"state": 0})
        self.assertEqual(coord.data["__print_status"], "idle")
        # Resuming a paused job still reports processing during 5 -> 0 -> 1.
        coord._on_message({"state": 1, "printStartTime": 6})
        coord._on_message({"state": 5})
        coord._on_message({"state": 0})
        self.assertEqual(coord.data["__print_status"], "processing")

    def test_layer_peaks_latch_after_finish_and_reset_for_next_job(self):
        coord = make_coordinator()
        coord._on_message({"state": 1, "printFileName": "big.gcode", "printStartTime": 1,
                           "layer": 700, "TotalLayer": 730})
        coord._on_message({"state": 2, "layer": 0, "TotalLayer": 0})
        self.assertEqual((coord.data["__layer"], coord.data["__total_layer"]), (700, 730))
        # A new job preparing must not show the previous job's layers.
        coord._on_message({"state": 0, "deviceState": 1, "printFileName": "small.gcode",
                           "printStartTime": 2})
        self.assertEqual((coord.data["__layer"], coord.data["__total_layer"]), (0, 0))
        coord._on_message({"state": 1, "layer": 10, "TotalLayer": 50})
        coord._on_message({"state": 2, "layer": 0, "TotalLayer": 0})
        self.assertEqual((coord.data["__layer"], coord.data["__total_layer"]), (10, 50))

    def test_storage_warning_is_described_but_not_an_error(self):
        coord = make_coordinator()
        coord._on_message({"state": 0, "deviceState": 0,
                           "err": {"errcode": 212, "key": 508, "value": "90%"}})
        self.assertNotEqual(coord.data["__print_status"], "error")
        self.assertEqual(coord.data["__err_key"], 508)
        self.assertEqual(coord.data["__err_severity"], "warning")
        self.assertIn("%s", coord.data["__err_message"])
        self.assertEqual(coord.data["__err_value"], "90%")
        self.assertTrue(coord.data["__err_solution"])
        coord._on_message({"err": {"errcode": 0, "key": 0, "value": ""}})
        self.assertEqual((coord.data["__err_key"], coord.data["__err_value"]), (0, ""))

    def test_own_estimate_is_fixed_for_the_job(self):
        coord = make_coordinator()
        job = {"printFileName": "benchy.gcode", "printStartTime": 5}
        with patch.object(MODULE.time, "time", return_value=10_000.0):
            coord._on_message({**job, "state": 1, "printJobTime": 30, "printLeftTime": 0})
            self.assertIsNone(coord.data["__eta_ours"])  # no printer estimate yet
            coord._on_message({"printJobTime": 60, "printLeftTime": 3540, "printProgress": 1})
        self.assertEqual(coord.data["__eta_ours"], 3600)
        self.assertEqual(coord.data["__eta_ours_finish"], 10_000.0 - 60 + 3600)
        # Later printer estimates and progress do not move it.
        with patch.object(MODULE.time, "time", return_value=12_000.0):
            coord._on_message({"printJobTime": 2000, "printLeftTime": 4000, "printProgress": 30})
        self.assertEqual((coord.data["__eta_ours"], coord.data["__eta_ours_finish"]), (3600, 13_540.0))
        coord._on_message({"state": 2})
        self.assertEqual(coord.data["__eta_ours"], 3600)  # still shown on the finished job
        coord._on_message({"state": 0, "deviceState": 0})
        self.assertIsNone(coord.data["__eta_ours"])
        # A new job gets its own estimate.
        coord._on_message({"state": 1, "printFileName": "b_1h0m.gcode", "printStartTime": 6,
                           "printJobTime": 0})
        self.assertEqual(coord.data["__eta_ours"], 3600)
        self.assertEqual(coord.plan["job"], MODULE.job_key(coord.data))

    def test_restored_own_estimate_is_kept_for_the_same_job(self):
        coord = make_coordinator()
        job = {"printFileName": "benchy.gcode", "printStartTime": 5}
        coord.restore_plan({"job": MODULE.job_key(job), "total": 3000, "finish": 99.0})
        coord._on_message({**job, "state": 1, "printJobTime": 1200, "printLeftTime": 4000})
        self.assertEqual((coord.data["__eta_ours"], coord.data["__eta_ours_finish"]), (3000, 99.0))
        coord = make_coordinator()
        coord.restore_plan({"job": "old.gcode|1|", "total": 3000, "finish": 99.0})
        coord._on_message({**job, "state": 1, "printJobTime": 1200, "printLeftTime": 4000})
        self.assertEqual(coord.data["__eta_ours"], 5200)

    def test_offline_status(self):
        coord = make_coordinator(connected=False)
        coord._on_message({"state": 1, "printFileName": "a.gcode"})
        self.assertEqual(coord.data["__print_status"], "offline")

    def reconnect(self, coord):
        coord.client.connected = False
        coord._on_connection_change()
        coord.client.connected = True
        coord._on_connection_change()

    def test_reconnect_without_job_clears_stale_telemetry(self):
        coord = make_coordinator()
        coord._on_message({"state": 1, "printFileName": "a.gcode", "printStartTime": 1,
                           "nozzleTemp": "140", "layer": 5, "TotalLayer": 10})
        self.reconnect(coord)
        self.assertFalse(coord.live)
        self.assertEqual(coord.data["__print_status"], "offline")
        coord._on_message({"nozzleTemp": "25"})
        self.assertFalse(coord.live)  # no state yet: still waiting
        coord._on_message({"state": 0, "deviceState": 0})
        self.assertTrue(coord.live)
        self.assertEqual(coord.data["nozzleTemp"], "25")
        self.assertNotIn("printFileName", coord.data)
        self.assertEqual(coord.data["__layer"], 0)
        self.assertEqual(coord.data["__peak_total_layer"], 0)
        self.assertEqual(coord.data["__print_status"], "idle")

    def test_reconnect_keeps_paused_job(self):
        coord = make_coordinator()
        coord._on_message({"state": 1, "printFileName": "a.gcode", "printStartTime": 1,
                           "layer": 5, "TotalLayer": 10})
        coord._on_message({"state": 5})
        self.reconnect(coord)
        coord._on_message({"state": 5, "nozzleTemp": "150"})
        self.assertTrue(coord.live)
        self.assertEqual(coord.data["printFileName"], "a.gcode")
        self.assertEqual(coord.data["__peak_layer"], 5)
        self.assertEqual(coord.data["__print_status"], "paused")

    async def test_send_errors_become_home_assistant_errors(self):
        coord = make_coordinator()
        coord.client.send_set_retry.side_effect = ConnectionError("gone")
        with self.assertRaises(HomeAssistantError):
            await coord.async_send_set(pause=1)
        coord.client.connected = False
        coord.client.start = AsyncMock()
        coord.client.wait_connected = AsyncMock(return_value=False)
        with self.assertRaises(HomeAssistantError):
            await coord.request_stop()

    def test_homing_accepts_numeric_strings(self):
        coord = make_coordinator()
        coord.data = {"deviceState": "7"}
        self.assertTrue(coord.is_homing())
        coord.data = {"deviceState": 1}
        self.assertFalse(coord.is_homing())


if __name__ == "__main__":
    unittest.main()


VIDEOS = [
    {"id": 1789985709, "videoname": "1789985709.mp4", "gcodename": "Shiny A_PETG_30m.gcode", "size": 5811324},
    {"id": "1789748374", "videoname": "1789748374.mp4", "gcodename": "micro m_PETG_2h9m.gcode"},
    {"id": 1, "videoname": "../../etc/passwd"},
]


class TimelapseTests(unittest.IsolatedAsyncioTestCase):
    def test_find_video_matches_print_start_time(self):
        self.assertEqual(TIMELAPSE.find_video(VIDEOS, "1789985709")["size"], 5811324)
        self.assertEqual(TIMELAPSE.find_video(VIDEOS, 1789748374)["videoname"], "1789748374.mp4")
        self.assertIsNone(TIMELAPSE.find_video(VIDEOS, 42))
        self.assertIsNone(TIMELAPSE.find_video(VIDEOS, None))
        # Entries whose file name could escape the video directory are never offered.
        self.assertIsNone(TIMELAPSE.find_video(VIDEOS, 1))

    def test_download_name_uses_gcode_stem(self):
        self.assertEqual(TIMELAPSE.download_name(VIDEOS[0]), "Shiny A_PETG_30m-timelapse.mp4")
        self.assertEqual(TIMELAPSE.download_name({"videoname": "5.mp4"}), "5.mp4")

    async def test_list_is_requested_and_kept_out_of_telemetry(self):
        coord = make_coordinator()
        coord._enrich = lambda data: data
        sent = []

        async def send_json(payload):
            sent.append(payload)
            coord._on_message({"elapseVideoList": VIDEOS, "nozzleTemp": "200"})

        coord.client.send_json = send_json
        self.assertEqual(await coord.timelapse.async_find(1789985709), VIDEOS[0])
        self.assertEqual(sent, [TIMELAPSE.LIST_REQUEST])
        self.assertNotIn("elapseVideoList", coord.data)
        self.assertEqual(coord.data["nozzleTemp"], "200")
        # A fresh list is reused rather than asking the printer again.
        await coord.timelapse.async_list()
        self.assertEqual(len(sent), 1)
        self.assertEqual(coord.timelapse.video("1789748374.mp4"), VIDEOS[1])

    async def test_list_only_frame_does_not_publish(self):
        coord = make_coordinator()
        coord.data = {"state": 1}
        coord._on_message({"elapseVideoList": []})
        self.assertEqual(coord.data, {"state": 1})
        self.assertEqual(coord.timelapse.entries, [])

    async def test_list_send_failure_and_timeout(self):
        coord = make_coordinator()
        coord.client.send_json = AsyncMock(side_effect=OSError("closed"))
        with self.assertRaises(ConnectionError):
            await coord.timelapse.async_list()
        coord.client.send_json = AsyncMock()
        with patch.object(TIMELAPSE, "LIST_TIMEOUT", 0.01), self.assertRaises(TimeoutError):
            await coord.timelapse.async_list()
        # The unanswered request is dropped: the next call asks the printer again.
        with patch.object(TIMELAPSE, "LIST_TIMEOUT", 0.01), self.assertRaises(TimeoutError):
            await coord.timelapse.async_list()
        self.assertEqual(coord.client.send_json.await_count, 2)
