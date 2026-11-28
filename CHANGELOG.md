## v3.14.0 (2026-11-28) — Hourly Weekly/Monthly Firebase Rollup (`/climateRollup.json`) + Gemini Context (Firmware `3.12.0` / Build `7` + Dashboard `3.14.0`)
- **Pre-Compiled Low-Res Weekly & Monthly Rollup (`/climateRollup.json`)**: Stores compact 7-day (`weekly`), 30-day (`monthly`), week-by-week (`weeklyBuckets`), and 30-day daily (`daily30d`) summaries (temp, RH, AH, Enthalpy, Feels Like, comfort %, mold-risk days, volatility) in Firebase so Gemini briefs have instant multi-week context without scanning raw logs.
- **Hourly Auto-Sync (ESP32 Online / PWA Fallback)**: ESP32 (`FW_VERSION "3.12.0"`, `FW_BUILD 7`) publishes `/climateRollup.json` once every hour while online; when the ESP32 is offline (or hasn't updated in >1h), any open PWA automatically computes and syncs `/climateRollup.json` on an hourly cadence.
- **Gemini Integration**: Daily Room Brief now receives `weeklyAndMonthlyRollup` alongside the 48-hour high-res indoor curve and live outdoor weather/AQI.

## v3.13.2 (2026-11-28) — 48-Hour Room Context, Live Outdoor Weather/AQI Comparison & Deeper AI Brief (Dashboard-Only)
- **Full 48-Hour (2-Day) Indoor Context**: Gemini now receives hourly buckets across the last 48 hours plus a day-by-day Yesterday vs Today breakdown (min/avg/max temp & humidity, swings, Feels Like, AH, Enthalpy, comfort compliance %, outside-comfort reasons, and mold-risk hours >60% / >65% RH).
- **Live Outdoor Weather & Air Quality Comparison**: Automatically uses your `lat,lon` from the Graphs tab (or browser geolocation) to pull live + 48h outdoor weather from Open-Meteo Forecast and live PM2.5/PM10/US-AQI from Open-Meteo Air Quality, computing exact indoor-vs-outdoor temperature, humidity, absolute humidity, and enthalpy deltas.
- **Richer Multi-Paragraph Briefing**: Expanded prompt and `maxOutputTokens` (400 → 900) so Gemini generates two full paragraphs (48h room story + indoor-vs-outdoor/seasonal/anomaly analysis) plus 3–4 concrete action tips.
- **Firmware untouched**: `room_logger/room_logger.ino` remains at `FW_VERSION "3.11.0"` / `FW_BUILD 6` (no ESP32 reflash needed).

## v3.13.1 (2026-11-28) — Gemini 3.5 Flash-Lite Migration & Auto-Fallback (Dashboard-Only)
- **Fixed HTTP 404 on retired `gemini-2.5-flash`**: Migrated Daily Room Brief to `gemini-3.5-flash-lite` with automatic 404 fallback through `gemini-3.8-flash` and `gemini-3.1-flash-lite`, plus dynamic `/v1beta/models` auto-discovery if all defaults are ever retired.
- **Fixed Gemini 3.x breaking API change**: Removed unsupported `temperature` sampling parameter from `generationConfig` and filtered out `thought: true` parts when extracting response text.
- **Dynamic Model Badge**: Remembers the active working model in `localStorage` (`rl_gemini_model_v1`) and displays it on the Daily Room Brief pill.
- **Firmware untouched**: `room_logger/room_logger.ino` remains at `FW_VERSION "3.11.0"` / `FW_BUILD 6` (no ESP32 reflash needed).

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