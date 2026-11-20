# Room Logger Firmware Changelog

## Stability & Bug Fixes

* **Fixed DHCP IP reset in `onNetworkConnected()`**: Stopped calling `WiFi.config(0,0,0,0)` on every normal DHCP connection (which wiped the active IP lease right before `MDNS.begin()` and `publishStatusToFirebase()`). It now resets to DHCP only when leaving a network that had a static IP applied, and waits briefly for a valid lease.

* **Fixed 10-second WiFi disconnect loop in `wifiMaintenanceTask()`**: Added a `lastZombieReconnectMs` cooldown so the zombie-connection watchdog waits a full 3-interval window after forcing a reconnect instead of disconnecting every 10 seconds.

* **Serialized concurrent TLS/HTTPS calls (`tlsMutex`) & added timeouts**: Prevented multiple tasks from running `WiFiClientSecure` handshakes simultaneously (avoiding \~40–50 KB per-session mbedTLS heap exhaustion), added 10-second connect/read timeouts, and bumped Core 0 task stacks from 8 KB to 10 KB.

* **Fixed cross-core data races**: Added `wifiNetworksMutex` around `wifiNetworks` vector access, `i2cMutex` around DS1307 `Wire` transactions, and guarded `lastConnectedSSID` updates under `wifiMutex` (with a `forceWifiSetupReset` fallback).

* **Fixed Core 1 watchdog starvation & auth lockout rollover**: Added `delay(1)` at the end of `loop()` so IDLE1 is never starved, fixed `otaLockedOut()` to use rollover-safe `millis()` subtraction, and escaped `WiFi.SSID()` in `publishStatusToFirebase()`.

## Removed Features

* **Study time recorder / Ledger sync**: Removed `SUBJECT_NAMES`, `SessionState` button state machine, `SESSION_LOG_FILE`, `eventLogMutex`, `logEvent()`, `recoverStateFromLog()`, `sendLedgerEvents()`, `ledgerUploadTask`, `/sync-code` routes and HTML page, Ledger health card, and Ledger preset/toggle fields.

* **Browser terminal logger (`/terminal`)**: Removed `TeeLog`, `#define Serial terminalLog`, the 200-line RAM ring buffer, `terminalLogMutex`, `WORKER_URL`, `/terminal` routes and HTML page, and terminal NVS settings. USB Serial (`Serial.begin(115200)`) now talks directly to the hardware UART with zero overhead.

* **Legacy power-saving & preset system**: Removed `/power-presets` (20-preset LittleFS manager), `powerPresetsMutex`, manual per-subsystem checkboxes, 5-second LED entry/exit flicker (`serviceLed()`), 5-second post-exit button lockout, and 20-second boot WiFi-off probe.

## New 3-Tier Power Saving System (`/power-saving`)

Replaced the old manual preset/toggle system with four hardware-backed profiles selectable from `/power-saving` (persisted in NVS and reported in `/health` and Firebase `status.json`), with Bluetooth explicitly disabled via `btStop()`:

| Mode | CPU Clock | WiFi Radio & Sleep | TX Power | Sensor Read | Backlog Drain | Status LED | Web UI Reachability | 
| ----- | ----- | ----- | ----- | ----- | ----- | ----- | ----- | 
| **Normal (Off)** | 240 MHz | `WIFI_PS_NONE` | 19.5 dBm | 60 s | 3 s | On | Always (fastest) | 
| **Low Power Saving** | 80 MHz | `WIFI_PS_MIN_MODEM` | 15 dBm | 2 min | 10 s | Off | Always (fast) | 
| **Medium Power Saving** | 80 MHz | `WIFI_PS_MAX_MODEM` | 11 dBm | 5 min | 30 s | Off | Always (slightly higher latency) | 
| **High Power Saving** | 80 MHz | Duty-cycled (`WIFI_OFF` 30 min, wakes 60 s w/ `WIFI_PS_MAX_MODEM`) | 11 dBm | 10 min (queued locally) | 3 s during wake | Off | During 60 s wake windows & 60 s on boot, or press BOOT button to exit immediately | 

## Kept Features

* All remaining admin web pages: `/`, `/wifi`, `/firebase`, `/credentials`, `/power-saving`, and `/health`.

* Auto-joining open WiFi fallback (`connectToAnyOpenNetwork()`) and its `/wifi` toggle.

* DS1307 I2C RTC time sync + NTP drift calibration, LittleFS mount safety + `/filesystem/format`, and offline reading queue (`/pending.txt`).

* Physical BOOT button: single click exits any power-saving mode back to Normal; 1-second hold (or triple-click) in Normal mode enters High Power Saving.