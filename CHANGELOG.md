## v3.17.0 (2026-11-28) — Tailored Per-Process Verification & Cloud-Learned ETA Predictor (Firmware `3.15.0` / Build `10` + Dashboard `3.17.0`)
- **Tailored Verification for All 19 Processes (`PROCESS_SPECS`)**: Custom step labels, custom timeouts, and real state-level verification per process (`refreshRollup` / `recomputeAnalytics` confirm order received + working without false timeout failures; `reboot` / `formatFs` verify uptime reset; `otaUrl` verifies new `fwBuild`; `setPowerMode`, Wi-Fi, battery/Wi-Fi trackers, and `setStartVoltage` verify live `/status.json` state directly).
- **ESP32 Immediate "Order Received" ACK (`FW_BUILD 10`)**: Extended `isSlowCmd` in `room_logger.ino` to cover `refreshRollup`, `recomputeAnalytics`, `formatFs`, and `setFirebaseConfig` so the ESP32 immediately confirms receipt before starting multi-second work.
- **Per-Process Cloud ETA Learning (`/processTimings.json`)**: Every completed process saves its actual runtime to Firebase `/processTimings/<action>.json` using an EWMA (`α = 0.35`) and displays live predictions on the stepper (`1.4s / ~3.1s`), on action buttons (`Sync on ESP32 (~X.Xs)`, `Refresh Brief (~X.Xs)`), and in a table inside **Saved Data**.

## v3.16.0 (2026-11-28) — Frozen Past-Day Incremental Cache & Adaptive ESP32 Sync ETA Predictor (Firmware `3.14.0` / Build `9` + Dashboard `3.16.0`)
- **Zero Redundant Recomputing**: Past completed calendar days are frozen in `localStorage` (`rl_frozen_daily_cache_v1`) once computed so `aggregateDaily()` skips already-computed days and only computes today's live readings (ESP32 already uses O(1) incremental ring sums). Also unified `{ temp, hum }` property handling in 48h & rollup builders.
- **Adaptive ESP32 Sync ETA (`/perfStats.json`)**: ESP32 (`FW_VERSION "3.14.0"`, `FW_BUILD 9`) records compute + HTTPS upload durations on every rollup sync using an EWMA (α = 0.35) stored in `/perfStats.json` (~320 bytes). The PWA shows the predicted time directly on **Sync on ESP32 (~X.Xs)** and displays the compute/upload breakdown inside **Saved Data**.

## v3.15.0 (2026-11-28) — ESP32 48h Hourly Ring, `Sync on ESP32` Button, Saved Rollup & Brief History Viewer, Pre-OTA Cloud Sync & Clean (Firmware `3.13.0` / Build `8` + Dashboard `3.15.0`)
- **ESP32 48-Hour Hourly Ring (`/hourly_48h.txt` → `/hourly48h.json`)**: ESP32 now maintains a compact ~2.2 KB 48-hour hourly ring buffer on LittleFS alongside `/daily_stats.txt` (~1.2 KB) and pushes `/hourly48h.json` + `/climateRollup.json` hourly.
- **New `Sync on ESP32` Button**: Directly tasks the ESP32 (`refreshRollup` cloud command) to compute and push `/analytics.json`, `/climateRollup.json`, and `/hourly48h.json` to Firebase.
- **New `Saved Data` Contemporary Viewer**: Expandable drawer right inside the Daily Room Brief card with 3 tabs — **Weekly & Monthly Rollup** (side-by-side 7d/30d cards + week-by-week table), **Past Briefs** (archived in Firebase `/dailyBriefHistory.json`, last 14 briefs), and **Raw JSON** inspector.
- **Pre-OTA Cloud Sync & Cleanup**: Before any OTA firmware flash starts in `performOtaFromUrl()`, the ESP32 drains all pending offline readings (`/pending.txt`) and pushes `/analytics.json`, `/climateRollup.json`, and `/hourly48h.json` to Firebase, then cleans temporary LittleFS files.

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