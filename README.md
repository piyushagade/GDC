# GatorByte Device Console (GDC)

GatorByte GDC is an Electron-based desktop application designed for serial monitoring, real-time logging, diagnostics, and calibration of GatorByte hardware devices. It supports both a clean graphical interface (GUI Mode) and a developer terminal console (Command Mode).

---

## Key Features

- **GUI Mode**:
  - Live **Readings** panel displaying real-time sensor metrics (EC, RTD Temperature).
  - **Calibration Wizard** with step-by-step instructions, stability checks, target reference presets, and verification testing.
  - **RTC Syncing** to retrieve and configure device datetime settings.
  - **Configuration Editor** for modifying GatorByte key-value profiles.
  - **Storage Explorer** to list, download, and format on-device storage.
- **Command Mode**:
  - Color-coded TX/RX serial logging stream terminal.
  - Command input console with autocomplete suggestions for commands and payloads.
- **Smart Connection Toggling**:
  - A quick layout toggle button in the topbar to switch between GUI-only and Command Mode.
  - Automatic button locking and visual pulsing connection alerts when the device is disconnected.
  - Self-healing port re-connection.

---

## Installation & Setup

### Prerequisites
- **Node.js** (v16 or higher)
- **npm** (comes bundled with Node.js)

### Development Setup
1. Clone the repository to your local machine.
2. Open terminal in the project root directory and install dependencies:
   ```bash
   npm install
   ```
3. Run the application in development mode:
   ```bash
   npm start
   ```

---

## Packaging the Software

You can package GatorByte GDC into a standalone executable package for Windows and Linux.

- **Package for Windows (x64)**:
  ```bash
  npm run package-win
  ```
  *Produces output in:* `dist/win-unpacked/`

- **Package for Linux (x64)**:
  ```bash
  npm run package-linux
  ```
  *Produces output in:* `dist/linux-unpacked/`

- **Package for All Platforms**:
  ```bash
  npm run package-all
  ```

---

## Running the Packaged Software

### Windows
1. Locate the packaged folder in `dist/win-unpacked/`.
2. Double-click `GatorByteGDC.exe` to launch the application.

### Linux
1. Locate the packaged folder in `dist/linux-unpacked/`.
2. Grant executable permissions to the binary:
   ```bash
   chmod +x GatorByteGDC
   ```
3. Launch the application:
   ```bash
   ./GatorByteGDC
   ```

> [!NOTE]  
> **Serial Port Permissions (Linux)**: If the application cannot detect or connect to COM ports, you may need to add your user account to the serial dialout group:
> ```bash
> sudo usermod -a -G dialout $USER
> ```
> *Please restart or log out and log back in to apply group changes.*
