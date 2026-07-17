# GatorByte GDC - Project Context

## Project Overview
GatorByte GDC (GatorByte Device Console) is an Electron-based desktop application designed for serial monitoring, logging, and diagnostics of GatorByte hardware devices. It implements a custom binary communication protocol for structured data exchange.

## Core Architecture
- **Framework**: Electron (v40.2.1)
- **UI**: HTML5, Vanilla CSS, jQuery (v4.0.0), FontAwesome 6.4.0
- **Communication**: Node.js `serialport`, `@serialport/parser-delimiter`, and `cobs`.

## Communication Protocol
The app uses an atomic packet structure wrapped in **COBS (Consistent Overhead Byte Stuffing)** for reliable framing.
- **Header Structure**:
  - `Type` (1 byte): CMD (0x01), MSG (0x02), HEARTBEAT (0x0B), etc.
  - `PayloadType` (1 byte): STRING (0x07), JSON (0x08), etc.
  - `CmdLength` (2 bytes, LE): Length of command string.
  - `PayloadLength` (2 bytes, LE): Length of payload.
  - `AckRequested` (1 byte): 0x01 if ACK is expected.
- **Asymmetry**:
  - **TX (App to Device)**: Uses a 7-byte header (including `AckRequested`).
  - **RX (Device to App)**: Uses a 6-byte header (type, payloadType, cmdLen, pLen).
- **Framing**: Packets end with a null byte `[0]`.
- **Default Baud Rate**: 115200

## Key Features
- **Serial Monitoring**: Real-time logging of TX/RX traffic with color-coding.
- **Custom Commands**: Support for specialized GatorByte commands like `ec:calibrate`, `rtd:calibrate`, `time:sync`.
- **Autocomplete**: Context-aware autocomplete for both commands and payloads (e.g., dynamic timestamp for `time:sync`).
- **Heartbeat**: 5-second interval heartbeat to monitor device health.
- **Auto-reconnect**: Attempts to restore connection every 5 seconds if lost.

## Directory Structure
- `main.js`: Electron main process (window management, shortcuts).
- `renderer.js`: UI logic, serial handling, and protocol implementation.
- `index.html`: Application structure and styles.
- `assets/`: Images and external scripts (like `moment.js`).

## Development Guidelines
- **Protocol Integrity**: Never change the 6/7 byte header asymmetry without verifying device-side compatibility.
- **Security**: Be aware that `nodeIntegration` is enabled and `contextIsolation` is disabled in the current configuration.
- **UI States**: Maintain visual feedback for connection status (taskbar badge, icon changes, pulsating port selector).
- **LocalStorage**: Use for persisting command history and port selections.
