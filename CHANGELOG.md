# Changelog

All notable changes to this project will be documented in this file.

## [0.1.0] - 2026-10-19

Initial public release of the Home Assistant Creality KE Firmware integration.

### Features

- **Integration**: Local WebSocket connection to Creality K1/KE-firmware printers (port 9999)
- **Sensors**: Print status, progress, temperatures (nozzle/bed), layers, print time, material usage, filament status, error codes with wiki-backed messages
- **Controls**: Pause, resume, stop, home, temperature targets, speed/flow multipliers, fans, chamber light
- **Camera**: MJPEG for KE; WebRTC through Home Assistant's go2rtc for K1C/K2 and newer firmware; custom URL support
- **Dashboard card**: Bundled `custom:creality-card` with visual editor, auto-discovered entities, G-code silhouette, layer overlay on thumbnails, completion banner
- **Energy tracking**: Per-print energy measurement from smart plug sensors with room-baseline subtraction for whole-room meters
- **Print history**: Save completed prints with material and electricity costs, thumbnails
- **Timelapses**: Play/download printer timelapses; optional auto-save to folder or NAS share
- **G-code profile**: 2D silhouette of the print job filled to the current layer (front/side views)
- **Print preview**: Current print thumbnail image with approximate layer overlay
- **Power control**: Optional smart-plug integration with compact offline card view
- **Error database**: Shipped SQLite database scraped from official Creality wiki for human-readable error messages
- **Time estimates**: Optional integration-based time estimate alongside printer's own estimate

### Supported Printers

- Ender 3 V3 KE
- K1, K1 Max, K1C
- K2 Plus (expected)
- Other printers with K1/KE-class firmware

### Limitations

- No G-code upload or start print support (planned for v1.1)
- No Creality Cloud integration (by design; local-only)
- G-code profiles require printer's download endpoint (not available for USB prints)
- CFS-specific features not supported
