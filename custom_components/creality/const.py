"""Constants for the Creality integration."""

from __future__ import annotations

DOMAIN = "creality"

# Bundled Lovelace card. Bump CARD_VERSION whenever the frontend changes so
# Home Assistant browsers receive a fresh URL instead of a cached script.
CARD_URL = "/creality/creality-card.js"
CARD_VERSION = "0.1.50"

CONF_HOST = "host"
CONF_NAME = "name"
CONF_CAMERA_MODE = "camera_mode"
CONF_CUSTOM_CAMERA_URL = "custom_camera_url"
CONF_TIMELAPSE_FOLDER = "timelapse_folder"
CONF_TIMELAPSE_AUTO_SAVE = "timelapse_auto_save"
# Options the integration applies live, without reloading the printer connection.
LIVE_OPTIONS = (CONF_TIMELAPSE_FOLDER, CONF_TIMELAPSE_AUTO_SAVE)

DEFAULT_NAME = "Creality Printer"
DEFAULT_CAMERA_MODE = "auto"

WS_PORT = 9999
HTTP_PORT = 80
MJPEG_PORT = 8080
WEBRTC_PORT = 8000

WS_URL = "ws://{host}:" + str(WS_PORT)
MJPEG_URL = "http://{host}:" + str(MJPEG_PORT) + "/?action=stream"
MJPEG_SNAPSHOT_URL = "http://{host}:" + str(MJPEG_PORT) + "/?action=snapshot"
WEBRTC_URL = "http://{host}:" + str(WEBRTC_PORT) + "/call/webrtc_local"
INFO_URL = "http://{host}/info"

CAM_MODE_AUTO = "auto"
CAM_MODE_MJPEG = "mjpeg"
CAM_MODE_WEBRTC = "webrtc"
CAM_MODE_CUSTOM = "custom"

# Keepalive / reconnect
HEARTBEAT_OK = "ok"
GET_PARA_SEC = 5.0
PROBE_SILENCE_SEC = 10.0
STALE_AFTER_SEC = 20.0
RETRY_MIN = 1.0
RETRY_MAX = 60.0
STABLE_SESSION_SEC = 30.0

MANUFACTURER = "Creality"

# Print state codes from printer telemetry
STATE_IDLE = 0
STATE_PRINTING = 1
STATE_FINISHED = 2
STATE_STOPPED = 4
STATE_PAUSED = 5

# deviceState busy-homing observed as 7 in reference protocol notes
DEVICE_HOMING = 7

# Fan M106 channels
FAN_MODEL = 0
FAN_CASE = 1
FAN_SIDE = 2
