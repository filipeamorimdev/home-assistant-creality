# Home Assistant Creality KE Firmware Integration

> This is an **unofficial**, community-built integration made as a weekend project. It is not made, endorsed or supported by Creality (Shenzhen Creality 3D Technology Co., Ltd.). The Creality name is a trademark of its owner and is used only to identify the printers this integration works with.

Home Assistant integration for Creality LAN printers (Ender 3 V3 KE / K1-class firmware). It talks to the printer directly over your network on WebSocket port **9999**: no Creality Cloud, no account, no extra add-on.

![Creality card in action](docs/images/creality-card.gif)

![Creality card during a print](docs/images/card.png)

## Highlights

- **Its own dashboard card.** A bundled command center with live camera, progress, temperatures and controls in one view. It is served by the integration and registered automatically; no separate frontend plugin or manual resource.
- **Local only.** Everything runs on your LAN. Creality Cloud is never contacted.
- **Printer power control.** Link a smart plug and the card switches to a compact offline view with a **Turn on printer** button while the printer is off.
- **Cost and energy per print.** Pick a power or energy sensor and the card measures each print's energy from recorder history, subtracts the room's baseline for whole-room meters, and saves the print to history with material and electricity costs.
- **G-code silhouette.** A front or side view of the real object, built from the job's G-code and filled up to the current layer.
- **Timelapses.** Play or download the printer's timelapse when a job ends, or save every timelapse automatically to a folder or NAS share.
- **WebRTC camera** for K1C / K2 and newer firmware through Home Assistant's built-in go2rtc; MJPEG for the KE.
- **Readable errors.** Printer error codes are translated using a database built from the official Creality wiki and shown as a [banner on the card](docs/guide.md#banners).

> [!NOTE]
> You still need a slicer (Creality Print, OrcaSlicer, …) to slice the model and send it to the printer, or start the job from the printer's screen. This integration monitors and controls jobs once they are running; it cannot upload G-code or start prints yet.

## Quick start

1. Copy `custom_components/creality` into your Home Assistant `config/custom_components/` folder and restart Home Assistant.
2. Settings → Devices & services → **Add Integration** → **Creality**, and enter the printer's IP address.
3. Edit a dashboard → **Add card** → **Creality Printer**. The editor finds the printer's entities by itself.

### Example

A card with power control and cost tracking (entity IDs are illustrative; the editor fills them in for you):

```yaml
type: custom:creality-card
title: Ender 3 V3 KE
status: sensor.ender_3_v3_ke_print_status
camera: camera.ender_3_v3_ke_printer_camera
printer_switch: switch.printer_plug
print_energy: sensor.printer_plug_power
```

While the plug is off, the card shrinks to a power-on button and the print history with each job's energy and cost:

![Card with the printer switched off](docs/images/card-offline.png)

When a print ends, **Save to history** asks for the filament price per kg and the electricity price per kWh (remembered for the next print) and stores the job's total cost. An automation can use the integration's entities like any others, for example to notify when a print ends:

```yaml
triggers:
  - trigger: state
    entity_id: sensor.ender_3_v3_ke_print_status
    to: completed
actions:
  - action: notify.notify
    data:
      message: "Print finished: {{ states('sensor.ender_3_v3_ke_current_object') }}"
```

## Documentation

- [Setup and reference guide](docs/guide.md): entities, options, card layout, camera modes, timelapse saving, energy measurement, time estimates and limitations
- [CHANGELOG.md](CHANGELOG.md): changes and upgrade notes

## How this differs from similar projects

Several Home Assistant integrations exist for Creality printers. This project offers:

- **Advanced energy tracking**: per-print energy measurement with room-baseline subtraction for whole-room power meters, saved to print history with material and electricity costs
- **G-code silhouette**: 2D front/side view of the actual object being printed, filled up to the current layer, built from the job's real G-code
- **Comprehensive print history**: saves completed prints with costs, thumbnails, and timelapse access
- **Automatic timelapse saving**: optional auto-save every finished print's timelapse to a folder or NAS share

## License

MIT license.
