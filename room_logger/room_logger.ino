#include <WiFi.h>
#include <esp_wifi.h>
#include <WiFiMulti.h>
#include <WiFiClientSecure.h>
#include <ESPmDNS.h>
#include <DHT.h>
#include <WebServer.h>
#include <HTTPClient.h>
#include <Update.h>
#include <LittleFS.h>
#include <Preferences.h>
#include <Wire.h>
#include <time.h>
#include <sys/time.h>
#include <string.h>
#include <vector>
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"
#include "secrets.h"

Preferences syncCodePrefs;

// Guards currentSyncCode/currentFirebaseHost/currentFirebaseAuth against a
// real cross-core race: sendLedgerEvents() (ledgerUploadTask, core 0) reads
// currentSyncCode, and putReading() (sensorUploadTask, core 0) reads
// currentFirebaseHost/currentFirebaseAuth, while the /sync-code and
// /firebase POST handlers (core 1) can reassign those same Strings at any
// time. Unlike the plain bool/int globals read unguarded elsewhere in this
// file (see ledAvailableForStatus()'s comment on why those are fine), a
// String is a heap-backed object -- reassigning one while another core is
// mid-read (copying its buffer pointer, appending to it, etc.) is undefined
// behavior, not a benign one-tick glitch. Exactly the same class of risk
// powerPresetsMutex already exists to prevent for the powerPresets vector;
// it just never got applied here. Created in setup(), before either
// background task starts.
SemaphoreHandle_t settingsMutex;

// Same idea as currentSyncCode above, for the login shared by every
// protected page (/sync-code, /wifi, /credentials). Starts from
// the secrets.h defaults, then setup() overwrites them with whatever was
// last saved via the /credentials page, if anything was. Stored in the same
// "roomlogger" Preferences namespace as the sync code -- see
// loadOtaCredentials()/saveOtaCredentials() further down.
String currentOtaUser = OTA_USERNAME_DEFAULT;
String currentOtaPass = OTA_PASSWORD_DEFAULT;

// Same idea again, for the Firebase host + auth token. Starts from the
// secrets.h defaults, then setup() overwrites them with whatever was last
// saved via the /firebase page, if anything was. See
// loadFirebaseSettings()/saveFirebaseSettings() further down.
String currentFirebaseHost = FIREBASE_HOST_DEFAULT;
String currentFirebaseAuth = FIREBASE_AUTH_DEFAULT;

// Derived from the array itself rather than trusted from WIFI_NETWORK_COUNT in
// secrets.h -- a manually-maintained count can drift out of sync with the
// array and read past its end. This assumes WIFI_NETWORKS is declared as a
// plain array (e.g. "WifiNetwork WIFI_NETWORKS[] = {...};"), which is the
// standard pattern and matches how the rest of this file already indexes it.
// Only used once, to seed the very first boot -- see loadWifiNetworksFromDisk().
const int WIFI_SEED_NETWORK_COUNT = sizeof(WIFI_NETWORKS) / sizeof(WIFI_NETWORKS[0]);

// ---------------- Live, editable WiFi network list ----------------
// This -- not WIFI_NETWORKS in secrets.h -- is what the device actually
// connects with from the first boot onward. It's loaded from (and saved to)
// LittleFS by loadWifiNetworksFromDisk()/saveWifiNetworksToDisk() further
// down, and managed from a phone at the /wifi page. Same String-based
// approach as currentSyncCode above, for the same reason: it has to be
// editable at runtime, which a const array from secrets.h can't be.
struct WifiEntry {
  String ssid;
  String password;
  IPAddress staticIP;
  IPAddress gateway;
  IPAddress subnet;
  IPAddress dns;
};
std::vector<WifiEntry> wifiNetworks;
// Optional preferred SSID (persisted in NVS, editable on /wifi). Whenever the
// board is connected to a DIFFERENT network, wifiMaintenanceTask scans every
// PREFERRED_WIFI_SCAN_INTERVAL_MS and switches over if this SSID appears with
// RSSI >= PREFERRED_WIFI_MIN_RSSI. Guarded by wifiNetworksMutex.
String preferredWifiSsid = "";
// Last OTA .bin URL used on /update (persisted in NVS for one-tap re-flashing).
String currentOtaBinUrl = "";
const unsigned long PREFERRED_WIFI_SCAN_INTERVAL_MS = 60000UL;
const int32_t       PREFERRED_WIFI_MIN_RSSI         = -82;

// Result of an add/update, so the /wifi POST handler can tell the person
// (and decide) whether a restart is actually needed:
//  - a brand-new SSID can be handed straight to wifiMulti.addAP() live, no
//    restart needed -- WiFiMulti supports adding entries at any time.
//  - editing an EXISTING SSID (new password and/or IP settings) can't be
//    applied live -- WiFiMulti has no way to update or remove an AP entry
//    it already has, so the stale one would linger until reboot regardless.
// (Declared up here, rather than next to addOrUpdateWifiNetwork() below,
// because arduino-cli auto-generates that function's forward declaration
// and inserts it before the sketch's first function definition -- if this
// enum were declared later in the file, that auto-generated prototype
// would reference WifiSaveResult before it existed and fail to compile.)
enum WifiSaveResult { WIFI_SAVE_INVALID, WIFI_SAVE_LIMIT_REACHED, WIFI_SAVE_ADDED, WIFI_SAVE_UPDATED };

// Four built-in power modes, selectable from /power-saving or the BOOT button.
enum PowerMode {
  POWER_NORMAL = 0, // 240 MHz, WiFi PS off,      19.5 dBm, read 60s,  LED on
  POWER_LOW    = 1, //  80 MHz, WiFi min modem PS, 15 dBm,   read 120s, LED off
  POWER_MEDIUM = 2, //  80 MHz, WiFi max modem PS, 11 dBm,   read 300s, LED off
  POWER_HIGH   = 3  //  80 MHz, WiFi duty-cycled (off 30m, 60s sync/admin window), read 600s, LED off
};

// Explicit forward declarations so ArduinoDroid never misses custom-enum prototypes.
const char* powerModeName(PowerMode mode);
const char* powerModeLabel(PowerMode mode);
void applyWifiRadioProfileLocked(PowerMode mode);
void applyPowerMode(PowerMode newMode, bool publishStatus);
String buildHealthStatusJson();
WifiSaveResult addOrUpdateWifiNetwork(const String& ssid, const String& password,
                                      const String& ipStr, const String& gwStr,
                                      const String& snStr, const String& dnsStr);
bool removeWifiNetworkByIndex(int index, String& outRemovedSsid);
bool savePreferredWifi(const String& ssid);
bool performOtaFromUrl(const String& url, String& errOut);
bool publishStatusToFirebase();
String jsonEscape(const String& s);
bool isValidSsid(const String& ssid);
bool checkInternetReachable();

// Hard cap on how many networks /wifi will let you save. LittleFS and the
// device's RAM could handle a lot more than this, but a page rendering
// hundreds of rows stops being usable from a phone long before that -- this
// is "many, generously," not "unlimited."
const int MAX_WIFI_NETWORKS = 25;

const char* WIFI_CONFIG_FILE     = "/wifi_networks.txt";
const char* WIFI_CONFIG_TMP_FILE = "/wifi_networks.tmp";

// Onboard BOOT button, active LOW -- confirm this matches what you actually
// wire the button to; unlike LED_PIN below, nothing in the existing sketch
// already told me this one.
#define BUTTON_PIN 0

#define DHTPIN   27
#define DHTTYPE  DHT22

// DS1307 RTC module, over I2C. These are the ESP32's default I2C pins --
// also what's silkscreened "21"/"22" on most DevKitV1 boards -- so wiring
// is just VCC/GND/SDA/SCL, nothing else. See the DS1307 section below.
#define RTC_SDA_PIN 21
#define RTC_SCL_PIN 22

DHT dht(DHTPIN, DHTTYPE);
WebServer server(80);
WiFiMulti wifiMulti;

// Guards every call that actually MUTATES live WiFi state -- wifiMulti.run(),
// connectToAnyOpenNetwork(), wifiMulti.addAP() (a brand-new network saved via
// /wifi), and the WiFi.mode() flip in enterPowerSaving()/exitPowerSaving().
// Needed because the periodic reconnect check used to live inline in loop()
// (core 1) -- now it runs on its own background task (wifiMaintenanceTask,
// core 0; see its comment for why) so it can no longer block the button/HTTP
// server the way it used to. That means it can now run at the same time as
// the handful of other places that touch live WiFi state from core 1 (an
// admin adding a network, or a power-saving entry/exit) -- this lock keeps
// those from stepping on each other. Read-only status calls (WiFi.status(),
// WiFi.SSID(), WiFi.localIP(), WiFi.RSSI(), used all over this file to build
// pages/JSON) are NOT guarded by this -- they're safe to call from any core
// without one. Created in setup(), before either background task starts.
SemaphoreHandle_t wifiMutex;
// Serializes outbound WiFiClientSecure/mbedTLS calls across Core 0 tasks and
// Core 1 HTTP handlers so at most one TLS session allocates heap (~40-50 KB)
// at a time.
SemaphoreHandle_t tlsMutex;
// Guards wifiNetworks (std::vector<WifiEntry>) against concurrent mutation on
// Core 1 (/wifi handlers) and iteration on Core 0 (onNetworkConnected()).
SemaphoreHandle_t wifiNetworksMutex;
// Guards Wire (I2C) transactions between Core 1 (retryRtcIfNeeded()) and
// Core 0 (syncTimeSources()).
SemaphoreHandle_t i2cMutex;

const char* QUEUE_FILE     = "/pending.txt";
const char* QUEUE_TMP_FILE = "/pending.tmp";

// Lets some browsers/OSes reach the device at http://roomlogger.local/
// without needing to know its IP -- works fine on iOS and most desktops,
// but Android's mDNS support is inconsistent and this hostname often just
// won't resolve from a phone's own browser. The dashboard's Device row
// (built from status.json's reported IP, not this hostname) is the
// reliable way in from a phone. Change this if you run more than one of
// these devices (each needs a unique hostname).
const char* MDNS_HOSTNAME  = "roomlogger";

const unsigned long READ_UPLOAD_INTERVAL_MS = 60000;        // read + upload once per minute
const unsigned long WIFI_CHECK_INTERVAL_MS  = 10000;        // check/retry WiFi every 10s
const unsigned long STATUS_REPUBLISH_INTERVAL_MS = 45000;   // heartbeat re-publish of status.json (with lastSeen epoch) for live ONLINE/OFFLINE detection
const unsigned long DRAIN_INTERVAL_MS       = 3000;         // try to flush queued readings every 3s when online
const unsigned long HIGH_POWER_SLEEP_MS       = 1800000UL;    // 30 min WiFi-off interval in High Power Saving
const unsigned long HIGH_POWER_WAKE_WINDOW_MS = 60000UL;      // 60 s WiFi-on sync & web-UI window in High Power Saving
const int           DRAIN_BATCH_SIZE        = 5;            // upload at most this many queued readings per attempt
const unsigned long MIN_VALID_EPOCH         = 1600000000UL; // sanity floor for "is the system clock actually set" (RTC or NTP)
const size_t        MAX_QUEUE_BYTES         = 500000;       // ~500 KB safety cap (~15+ days at 1/min inside 640 KB LittleFS)
// ---------------- Button timing (ms) ----------------
const unsigned long DEBOUNCE_MS            = 50;
const unsigned long LONG_PRESS_MS          = 1000; // hold-to-power-save

// %WIFI_ROWS% is filled in server-side (see the GET /wifi handler) with
// buildWifiRowsHtml() before this is sent.
const char* wifiPage = R"rawliteral(
<!DOCTYPE html><html><head><meta charset='utf-8'>
<meta name='viewport' content='width=device-width, initial-scale=1'>
<style>
  body { font-family: sans-serif; max-width: 460px; margin: 40px auto; padding: 0 16px; }
  #status { margin-top:14px; font-weight:bold; min-height:1.2em; }
  .ok   { color:#2e7d32; }
  .fail { color:#c62828; }
  .busy { color:#555; }
  input[type=text], input[type=password] { width:100%; box-sizing:border-box; padding:8px; font-size:16px; margin-top:6px; }
  input[type=submit] { margin-top:14px; }
  ul#wifi-list { list-style:none; padding:0; margin:14px 0; }
  li.wifi-row { display:flex; align-items:center; justify-content:space-between; gap:10px;
                border:1px solid #ddd; border-radius:6px; padding:10px 12px; margin-bottom:8px; }
  .wifi-name { font-weight:bold; }
  .wifi-meta { color:#666; font-size:0.9em; margin-top:2px; }
  .remove-btn { background:#c62828; color:#fff; border:none; border-radius:4px; padding:6px 10px; flex-shrink:0; }
  details { margin-top:10px; }
  summary { cursor:pointer; color:#555; }
  .ip-grid input { margin-top:8px; }
  hr { margin:24px 0; border:none; border-top:1px solid #ddd; }
  .conn-box { border:1px solid #ddd; border-radius:6px; padding:10px 12px; margin:14px 0 0 0;
              background:#fafafa; font-size:0.95em; }
  .saved-tag { color:#2e7d32; font-weight:bold; }
  .open-tag  { color:#c62828; font-weight:bold; }
  .switch-row { display:flex; align-items:center; gap:8px; font-weight:normal; cursor:pointer; }
  .switch-row input { width:auto; margin:0; }
  .switch-note { color:#666; font-size:0.9em; margin:6px 0 0 0; }
</style>
</head><body>
<nav>
  <a href='/firebase'>Firebase</a> &middot;
  <a href='/credentials'>Dashboard login</a> &middot;
  <a href='/power-saving'>Power saving</a> &middot;
  <a href='/update'>OTA update</a> &middot;
  <a href='/health'>Device health</a>
</nav>
<h2>WiFi Networks</h2>
<div id='conn-status' class='conn-box'>Checking connection...</div>
<ul id='wifi-list'>%WIFI_ROWS%</ul>

<hr>
<h3>Preferred WiFi (auto-switch)</h3>
<form id='prefForm'>
  <label for='prefSsid'>If this saved network appears in range, switch to it even while connected to another WiFi</label>
  <select id='prefSsid' name='ssid' style='width:100%;padding:8px;font-size:16px;margin-top:6px;'>
    %PREFERRED_OPTIONS%
  </select>
  <input type='submit' value='Save preferred WiFi'>
</form>

<hr>
<h3>Connect to free WiFi</h3>
<label class='switch-row'>
  <input type='checkbox' id='openFallbackToggle'>
  Automatically join an open (password-free) network if none of the ones above are in range
</label>
<div class='switch-note'>
  Off means the board just stays disconnected in that situation instead -- safer anywhere an open
  network nearby might not be one you control.
</div>

<hr>
<h3>Add a network</h3>
<form id='addForm'>
  <label for='ssid'>Network name (SSID)</label>
  <input type='text' id='ssid' name='ssid' autocomplete='off' autocapitalize='off' maxlength='32' required>

  <label for='password'>Password (leave blank for an open network)</label>
  <input type='password' id='password' name='password' autocomplete='off' minlength='8' maxlength='63'>

  <details>
    <summary>Advanced: static IP (optional)</summary>
    <div class='ip-grid'>
      <label for='ip'>Device IP</label>
      <input type='text' id='ip' name='ip' placeholder='e.g. 192.168.1.50' autocomplete='off'>
      <label for='gateway'>Gateway</label>
      <input type='text' id='gateway' name='gateway' placeholder='e.g. 192.168.1.1' autocomplete='off'>
      <label for='subnet'>Subnet mask</label>
      <input type='text' id='subnet' name='subnet' placeholder='e.g. 255.255.255.0' autocomplete='off'>
      <label for='dns'>DNS (optional, defaults to gateway)</label>
      <input type='text' id='dns' name='dns' placeholder='optional' autocomplete='off'>
    </div>
  </details>

  <input type='submit' value='Save network'>
</form>
<div id='status'></div>
<script>
// Small helper so an SSID containing HTML-special characters can't do
// anything unexpected when dropped into innerHTML below -- same reasoning
// as htmlEscape() on the device side, just needed client-side too since
// this box is filled in by JS rather than rendered at page-load time.
function escapeHtml(s) {
  var div = document.createElement('div');
  div.textContent = s;
  return div.innerHTML;
}

function refreshConnStatus() {
  var box = document.getElementById('conn-status');
  var xhr = new XMLHttpRequest();
  xhr.open('GET', '/wifi/status?_=' + Date.now(), true);
  xhr.timeout = 4000;
  xhr.addEventListener('load', function () {
    if (xhr.status !== 200) { box.textContent = 'Could not check connection status.'; return; }
    var d;
    try { d = JSON.parse(xhr.responseText); } catch (err) { return; }

    document.getElementById('openFallbackToggle').checked = !!d.openFallbackEnabled;

    if (!d.connected) {
      box.innerHTML = '<strong>Not connected</strong> to any WiFi right now.';
      return;
    }
    var tag = d.isSaved
      ? '<span class="saved-tag">one of your saved networks</span>'
      : '<span class="open-tag">an open network \u2014 not password protected</span>';
    box.innerHTML = 'Connected to <strong>' + escapeHtml(d.ssid) + '</strong> (' + tag + ')' +
      ' &middot; ' + escapeHtml(d.ip) + ' &middot; signal ' + d.rssi + ' dBm';
  });
  xhr.addEventListener('error', function () { box.textContent = 'Could not check connection status.'; });
  xhr.addEventListener('timeout', function () { box.textContent = 'Could not check connection status.'; });
  xhr.send();
}
refreshConnStatus();
setInterval(refreshConnStatus, 8000);

document.getElementById('prefForm').addEventListener('submit', function (e) {
  e.preventDefault();
  var sel = document.getElementById('prefSsid');
  var btn = e.target.querySelector('input[type=submit]');
  var status = document.getElementById('status');
  sel.disabled = true; btn.disabled = true;
  status.className = 'busy'; status.textContent = 'Saving preferred WiFi...';

  var xhr = new XMLHttpRequest();
  xhr.open('POST', '/wifi/preferred', true);
  xhr.timeout = 8000;
  xhr.setRequestHeader('Content-Type', 'application/x-www-form-urlencoded');
  xhr.addEventListener('load', function () {
    var ok = xhr.status === 200;
    status.className = ok ? 'ok' : 'fail';
    status.textContent = xhr.responseText || ('Failed (HTTP ' + xhr.status + ').');
    if (ok) { setTimeout(function () { window.location.reload(); }, 700); }
    else { sel.disabled = false; btn.disabled = false; }
  });
  xhr.addEventListener('error', function () {
    status.className = 'fail'; status.textContent = 'Connection lost -- NOT saved.';
    sel.disabled = false; btn.disabled = false;
  });
  xhr.addEventListener('timeout', function () {
    status.className = 'fail'; status.textContent = 'Request timed out -- NOT saved.';
    sel.disabled = false; btn.disabled = false;
  });
  xhr.send('ssid=' + encodeURIComponent(sel.value));
});

document.getElementById('openFallbackToggle').addEventListener('change', function () {
  var checkbox = this;
  var status = document.getElementById('status');
  checkbox.disabled = true;
  status.className = 'busy';
  status.textContent = 'Saving...';

  var xhr = new XMLHttpRequest();
  xhr.open('POST', '/wifi/open-fallback', true);
  xhr.timeout = 8000;
  xhr.setRequestHeader('Content-Type', 'application/x-www-form-urlencoded');
  xhr.addEventListener('load', function () {
    var ok = xhr.status === 200;
    status.className = ok ? 'ok' : 'fail';
    status.textContent = xhr.responseText || ('Failed (HTTP ' + xhr.status + ').');
    checkbox.disabled = false;
    if (!ok) checkbox.checked = !checkbox.checked; // revert on failure
  });
  xhr.addEventListener('error', function () {
    status.className = 'fail';
    status.textContent = 'Connection lost -- setting NOT saved. Check WiFi and try again.';
    checkbox.disabled = false;
    checkbox.checked = !checkbox.checked;
  });
  xhr.addEventListener('timeout', function () {
    status.className = 'fail';
    status.textContent = 'Request timed out -- setting NOT saved. Try again.';
    checkbox.disabled = false;
    checkbox.checked = !checkbox.checked;
  });
  xhr.send('enabled=' + (checkbox.checked ? '1' : '0'));
});

document.getElementById('addForm').addEventListener('submit', function (e) {
  e.preventDefault();
  var form = e.target;
  var status = document.getElementById('status');
  var ssid = document.getElementById('ssid').value.trim();
  if (!ssid) return;

  var body = 'ssid=' + encodeURIComponent(ssid) +
    '&password=' + encodeURIComponent(document.getElementById('password').value) +
    '&ip=' + encodeURIComponent(document.getElementById('ip').value.trim()) +
    '&gateway=' + encodeURIComponent(document.getElementById('gateway').value.trim()) +
    '&subnet=' + encodeURIComponent(document.getElementById('subnet').value.trim()) +
    '&dns=' + encodeURIComponent(document.getElementById('dns').value.trim());

  var fields = form.querySelectorAll('input');
  fields.forEach(function (el) { el.disabled = true; });
  status.className = 'busy';
  status.textContent = 'Saving...';

  var xhr = new XMLHttpRequest();
  xhr.open('POST', '/wifi', true);
  xhr.timeout = 10000;
  xhr.setRequestHeader('Content-Type', 'application/x-www-form-urlencoded');
  xhr.addEventListener('load', function () {
    var ok = xhr.status === 200;
    status.className = ok ? 'ok' : 'fail';
    status.textContent = xhr.responseText || ('Failed (HTTP ' + xhr.status + ').');
    if (ok && xhr.responseText.indexOf('restarting') !== -1) {
      pollForReboot(status);
    } else if (ok) {
      setTimeout(function () { window.location.reload(); }, 800);
    } else {
      fields.forEach(function (el) { el.disabled = false; });
    }
  });
  xhr.addEventListener('error', function () {
    status.className = 'fail';
    status.textContent = 'Connection lost while saving -- check the device is still on WiFi.';
    fields.forEach(function (el) { el.disabled = false; });
  });
  xhr.addEventListener('timeout', function () {
    status.className = 'fail';
    status.textContent = 'Request timed out -- the device may be busy or unreachable. Try again.';
    fields.forEach(function (el) { el.disabled = false; });
  });
  xhr.send(body);
});

document.getElementById('wifi-list').addEventListener('click', function (e) {
  if (!e.target.classList.contains('remove-btn')) return;
  var btn = e.target;
  var ssid = btn.getAttribute('data-ssid');
  if (!window.confirm('Remove "' + ssid + '"? The device will restart to apply this.')) return;

  var status = document.getElementById('status');
  btn.disabled = true;
  status.className = 'busy';
  status.textContent = 'Removing...';

  var xhr = new XMLHttpRequest();
  xhr.open('POST', '/wifi/remove', true);
  xhr.timeout = 10000;
  xhr.setRequestHeader('Content-Type', 'application/x-www-form-urlencoded');
  xhr.addEventListener('load', function () {
    var ok = xhr.status === 200;
    status.className = ok ? 'ok' : 'fail';
    status.textContent = xhr.responseText || ('Failed (HTTP ' + xhr.status + ').');
    if (ok) { pollForReboot(status); } else { btn.disabled = false; }
  });
  xhr.addEventListener('error', function () {
    status.className = 'fail';
    status.textContent = 'Connection lost while removing -- it may or may not have been removed. Reload to check.';
    btn.disabled = false;
  });
  xhr.addEventListener('timeout', function () {
    status.className = 'fail';
    status.textContent = 'Request timed out -- try again.';
    btn.disabled = false;
  });
  xhr.send('index=' + encodeURIComponent(btn.getAttribute('data-index')));
});

// Same reboot-polling approach as the OTA update page.
function pollForReboot(status) {
  var elapsed = 0, STEP_MS = 2000, MAX_MS = 60000;
  function attempt() {
    var ping = new XMLHttpRequest();
    ping.open('GET', '/?_=' + Date.now(), true);
    ping.timeout = 2000;
    ping.onload = function () {
      if (ping.status === 200) {
        status.className = 'ok';
        status.textContent = 'Device is back online \u2014 reloading...';
        setTimeout(function () { window.location.reload(); }, 1000);
      } else {
        scheduleRetry();
      }
    };
    ping.onerror = scheduleRetry;
    ping.ontimeout = scheduleRetry;
    ping.send();
  }
  function scheduleRetry() {
    elapsed += STEP_MS;
    if (elapsed >= MAX_MS) {
      status.className = 'fail';
      status.textContent = 'Device hasn\u2019t come back online yet \u2014 check it manually.';
      return;
    }
    setTimeout(attempt, STEP_MS);
  }
  setTimeout(attempt, 6000);
}
</script>
</body></html>
)rawliteral";

const char* credentialsPage = R"rawliteral(
<!DOCTYPE html><html><head><meta charset='utf-8'>
<meta name='viewport' content='width=device-width, initial-scale=1'>
<style>
  body { font-family: sans-serif; max-width: 420px; margin: 40px auto; padding: 0 16px; }
  #status { margin-top:14px; font-weight:bold; min-height:1.2em; }
  .ok   { color:#2e7d32; }
  .fail { color:#c62828; }
  .busy { color:#555; }
  input[type=text], input[type=password] { width:100%; box-sizing:border-box; padding:8px; font-size:16px; margin-top:6px; }
  input[type=submit] { margin-top:14px; }
  label { display:block; margin-top:12px; }
</style>
</head><body>
<nav>
  <a href='/wifi'>WiFi networks</a> &middot;
  <a href='/firebase'>Firebase</a> &middot;
  <a href='/power-saving'>Power saving</a> &middot;
  <a href='/update'>OTA update</a> &middot;
  <a href='/health'>Device health</a>
</nav>
<h2>Dashboard Login</h2>
<p>This is the username/password for every protected page here, including this one.</p>
<form id='credForm'>
  <label for='user'>New username</label>
  <input type='text' id='user' name='user' autocomplete='off' autocapitalize='off' maxlength='64' required>

  <label for='pass'>New password (8+ characters)</label>
  <input type='password' id='pass' name='pass' autocomplete='new-password' minlength='8' maxlength='64' required>

  <label for='pass2'>Confirm new password</label>
  <input type='password' id='pass2' autocomplete='new-password' minlength='8' maxlength='64' required>

  <input type='submit' value='Save login'>
</form>
<div id='status'></div>
<script>
document.getElementById('credForm').addEventListener('submit', function (e) {
  e.preventDefault();
  var form = e.target;
  var status = document.getElementById('status');
  var user = document.getElementById('user').value.trim();
  var pass = document.getElementById('pass').value;
  var pass2 = document.getElementById('pass2').value;

  if (!user) {
    status.className = 'fail';
    status.textContent = 'Username cannot be blank.';
    return;
  }
  if (pass.length < 8) {
    status.className = 'fail';
    status.textContent = 'Password must be at least 8 characters.';
    return;
  }
  if (pass !== pass2) {
    status.className = 'fail';
    status.textContent = 'Passwords do not match.';
    return;
  }

  var fields = form.querySelectorAll('input');
  fields.forEach(function (el) { el.disabled = true; });
  status.className = 'busy';
  status.textContent = 'Saving...';

  var xhr = new XMLHttpRequest();
  xhr.open('POST', '/credentials', true);
  xhr.timeout = 8000;
  xhr.setRequestHeader('Content-Type', 'application/x-www-form-urlencoded');
  xhr.addEventListener('load', function () {
    var ok = xhr.status === 200;
    status.className = ok ? 'ok' : 'fail';
    status.textContent = xhr.responseText || ('Failed (HTTP ' + xhr.status + ').');
    fields.forEach(function (el) { el.disabled = false; });
    if (ok) {
      document.getElementById('pass').value = '';
      document.getElementById('pass2').value = '';
      status.textContent += ' You may be asked to log in again with the new details.';
    }
  });
  xhr.addEventListener('error', function () {
    status.className = 'fail';
    status.textContent = 'Connection lost -- login was NOT changed. Check WiFi and try again.';
    fields.forEach(function (el) { el.disabled = false; });
  });
  xhr.addEventListener('timeout', function () {
    status.className = 'fail';
    status.textContent = 'Request timed out -- login was NOT changed. Try again.';
    fields.forEach(function (el) { el.disabled = false; });
  });
  xhr.send('user=' + encodeURIComponent(user) + '&pass=' + encodeURIComponent(pass));
});
</script>
</body></html>
)rawliteral";

// %FB_HOST% and %MASKED_FB_AUTH% are filled in server-side (see the GET
// /firebase handler) before this is sent -- the raw auth token itself is
// never embedded in the page source, same reasoning as syncCodePage above.
const char* firebasePage = R"rawliteral(
<!DOCTYPE html><html><head><meta charset='utf-8'>
<meta name='viewport' content='width=device-width, initial-scale=1'>
<style>
  body { font-family: sans-serif; max-width: 420px; margin: 40px auto; padding: 0 16px; }
  #status { margin-top:14px; font-weight:bold; min-height:1.2em; }
  .ok   { color:#2e7d32; }
  .fail { color:#c62828; }
  .busy { color:#555; }
  input[type=text], input[type=password] { width:100%; box-sizing:border-box; padding:8px; font-size:16px; margin-top:6px; }
  input[type=submit] { margin-top:14px; }
  label { display:block; margin-top:12px; }
  .checkbox-row { display:flex; align-items:center; gap:8px; margin-top:14px; }
  .checkbox-row label { display:inline; margin-top:0; }
  code { background:#eee; padding:2px 6px; border-radius:4px; }
  small { color:#666; }
</style>
</head><body>
<nav>
  <a href='/wifi'>WiFi networks</a> &middot;
  <a href='/credentials'>Dashboard login</a> &middot;
  <a href='/power-saving'>Power saving</a> &middot;
  <a href='/update'>OTA update</a> &middot;
  <a href='/health'>Device health</a>
</nav>
<h2>Firebase Realtime Database</h2>
<p>Current auth token: <code>%MASKED_FB_AUTH%</code></p>
<form id='fbForm'>
  <label for='host'>Database host (no https://, no path)</label>
  <input type='text' id='host' name='host' value='%FB_HOST%' autocomplete='off' autocapitalize='off' required>

  <label for='auth'>New auth token</label>
  <input type='password' id='auth' name='auth' autocomplete='off'>
  <small>Leave blank to keep the current token. Check the box below to remove it entirely instead.</small>

  <div class='checkbox-row'>
    <input type='checkbox' id='clearAuth' name='clear_auth'>
    <label for='clearAuth'>Remove auth token (use open database rules)</label>
  </div>

  <input type='submit' value='Save'>
</form>
<div id='status'></div>
<script>
document.getElementById('fbForm').addEventListener('submit', function (e) {
  e.preventDefault();
  var form = e.target;

  var host   = document.getElementById('host').value.trim();
  var auth   = document.getElementById('auth').value;
  var clear  = document.getElementById('clearAuth').checked;
  var status = document.getElementById('status');
  if (!host) {
    status.className = 'fail';
    status.textContent = 'Database host cannot be blank.';
    return;
  }

  var fields = form.querySelectorAll('input');
  fields.forEach(function (el) { el.disabled = true; });
  status.className = 'busy';
  status.textContent = 'Saving...';

  var xhr = new XMLHttpRequest();
  xhr.open('POST', '/firebase', true);
  xhr.timeout = 8000;
  xhr.setRequestHeader('Content-Type', 'application/x-www-form-urlencoded');

  xhr.addEventListener('load', function () {
    var ok = xhr.status === 200;
    status.className = ok ? 'ok' : 'fail';
    status.textContent = xhr.responseText || ('Failed (HTTP ' + xhr.status + ').');
    if (ok) {
      document.getElementById('auth').value = '';
      document.getElementById('clearAuth').checked = false;
      setTimeout(function () { window.location.reload(); }, 800);
    } else {
      fields.forEach(function (el) { el.disabled = false; });
    }
  });

  xhr.addEventListener('error', function () {
    status.className = 'fail';
    status.textContent = 'Connection lost -- settings NOT saved. Check WiFi and try again.';
    fields.forEach(function (el) { el.disabled = false; });
  });
  xhr.addEventListener('timeout', function () {
    status.className = 'fail';
    status.textContent = 'Request timed out -- settings NOT saved. Try again.';
    fields.forEach(function (el) { el.disabled = false; });
  });

  xhr.send('host=' + encodeURIComponent(host) +
    '&auth=' + encodeURIComponent(auth) +
    '&clear_auth=' + (clear ? '1' : '0'));
});
</script>
</body></html>
)rawliteral";

// %CONTENT% is filled in server-side by buildPowerSavingContentHtml().
const char* powerSavingPage = R"rawliteral(
<!DOCTYPE html><html><head><meta charset='utf-8'>
<meta name='viewport' content='width=device-width, initial-scale=1'>
<title>Power Saving</title>
<style>
  body { font-family: sans-serif; max-width: 520px; margin: 40px auto; padding: 0 16px; color:#222; }
  #status { margin-top:14px; font-weight:bold; min-height:1.2em; }
  .ok   { color:#2e7d32; }
  .fail { color:#c62828; }
  .busy { color:#555; }
  .mode-card { display:block; border:1px solid #ddd; border-radius:8px; padding:12px 14px;
               margin:10px 0; cursor:pointer; }
  .mode-card.active { border-color:#1565c0; background:#f3f8ff; }
  .mode-title { font-weight:bold; }
  .mode-meta { color:#555; font-size:0.88em; margin-top:4px; line-height:1.4; }
  input[type=submit] { margin-top:14px; padding:9px 18px; border:none; border-radius:6px;
                       background:#1565c0; color:#fff; font-size:15px; cursor:pointer; }
  input[type=submit]:disabled { opacity:0.5; cursor:default; }
  nav { font-size:0.9em; margin-bottom:14px; }
  a { color:#1565c0; }
</style>
</head><body>
<nav>
  <a href='/wifi'>WiFi networks</a> &middot;
  <a href='/firebase'>Firebase</a> &middot;
  <a href='/credentials'>Dashboard login</a> &middot;
  <a href='/update'>OTA update</a> &middot;
  <a href='/health'>Device health</a>
</nav>
<h2>Power Saving</h2>
%CONTENT%
<div id='status'></div>
<script>
var form = document.getElementById('modeForm');
if (form) {
  form.addEventListener('submit', function (e) {
    e.preventDefault();
    var selected = document.querySelector("input[name=mode]:checked");
    if (!selected) return;
    var mode = selected.value;
    var status = document.getElementById('status');
    var els = form.querySelectorAll('input');
    els.forEach(function (el) { el.disabled = true; });
    status.className = 'busy';
    status.textContent = 'Applying power mode...';

    var xhr = new XMLHttpRequest();
    xhr.open('POST', '/power-saving', true);
    xhr.timeout = 8000;
    xhr.setRequestHeader('Content-Type', 'application/x-www-form-urlencoded');
    xhr.addEventListener('load', function () {
      var ok = xhr.status === 200;
      status.className = ok ? 'ok' : 'fail';
      status.textContent = xhr.responseText || ('Failed (HTTP ' + xhr.status + ').');
      if (ok && mode !== 'high') {
        setTimeout(function () { window.location.reload(); }, 700);
      } else {
        els.forEach(function (el) { el.disabled = false; });
      }
    });
    xhr.addEventListener('error', function () {
      status.className = 'fail';
      status.textContent = 'Connection lost -- reload to check active mode.';
      els.forEach(function (el) { el.disabled = false; });
    });
    xhr.addEventListener('timeout', function () {
      status.className = 'fail';
      status.textContent = 'Request timed out -- reload to check active mode.';
      els.forEach(function (el) { el.disabled = false; });
    });
    xhr.send('mode=' + encodeURIComponent(mode));
  });
}
</script>
</body></html>
)rawliteral";

const char* healthPage = R"rawliteral(<!DOCTYPE html>
<html>
<head>
<meta name='viewport' content='width=device-width, initial-scale=1'>
<title>Device Health</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, sans-serif; max-width: 480px;
         margin: 20px auto; padding: 0 14px; color: #222; }
  h2 { margin-bottom: 4px; }
  .subtitle { color: #666; font-size: 0.9em; margin: 0 0 14px 0; }
  .health-row { display: flex; align-items: center; justify-content: space-between;
                gap: 12px; border: 1px solid #ddd; border-radius: 8px;
                padding: 12px 14px; margin: 10px 0; }
  .health-name { font-weight: 600; }
  .health-detail { color: #666; font-size: 0.85em; margin-top: 2px; }
  .badge { display: inline-block; padding: 4px 10px; border-radius: 12px;
           font-size: 0.85em; font-weight: bold; white-space: nowrap; flex-shrink: 0; }
  .badge-ok   { background: #e6f4ea; color: #1e7e34; }
  .badge-bad  { background: #fdecea; color: #c62828; }
  .badge-warn { background: #fff8e1; color: #8a6d00; }
  a { color: #1565c0; }
  .back-link { display: block; margin-top: 18px; }
  nav { font-size: 0.9em; margin-bottom: 14px; }
</style>
</head>
<body>
<nav>
  <a href='/wifi'>WiFi networks</a> &middot;
  <a href='/firebase'>Firebase</a> &middot;
  <a href='/credentials'>Dashboard login</a> &middot;
  <a href='/power-saving'>Power saving</a> &middot;
  <a href='/update'>OTA update</a>
</nav>
<h2>Device Health</h2>
<div class='subtitle' id='pageSubtitle'>Refreshes automatically every few seconds.</div>

<div class='health-row'>
  <div>
    <div class='health-name'>Cloud &mdash; Firebase</div>
    <div class='health-detail' id='fb-detail'>Checking...</div>
  </div>
  <span class='badge' id='fb-badge'>...</span>
</div>

<div class='health-row'>
  <div>
    <div class='health-name'>RTC (clock)</div>
    <div class='health-detail' id='rtc-detail'>Checking...</div>
  </div>
  <span class='badge' id='rtc-badge'>...</span>
</div>

<div class='health-row'>
  <div>
    <div class='health-name'>DHT22 (temp/humidity)</div>
    <div class='health-detail' id='dht-detail'>Checking...</div>
  </div>
  <span class='badge' id='dht-badge'>...</span>
</div>

<div class='health-row'>
  <div>
    <div class='health-name'>Power mode</div>
    <div class='health-detail' id='power-detail'>Checking...</div>
  </div>
  <span class='badge' id='power-badge'>...</span>
</div>

<div class='health-row'>
  <div>
    <div class='health-name'>OTA partition slot</div>
    <div class='health-detail' id='ota-detail'>Checking...</div>
  </div>
  <span class='badge' id='ota-badge'>...</span>
</div>

<a class='back-link' href='/'>&larr; Back</a>

<script>
function setBadge(id, text, cls) {
  var el = document.getElementById(id);
  el.textContent = text;
  el.className = 'badge ' + cls;
}
function setDetail(id, text) {
  document.getElementById(id).textContent = text;
}
function fmtAgo(sec) {
  if (sec === null || sec === undefined) return 'never';
  if (sec < 60) return sec + 's ago';
  if (sec < 3600) return Math.floor(sec / 60) + 'm ago';
  return Math.floor(sec / 3600) + 'h ago';
}

function refreshHealth() {
  var xhr = new XMLHttpRequest();
  xhr.open('GET', '/health/status?_=' + Date.now(), true);
  xhr.timeout = 4000;
  xhr.addEventListener('load', function () {
    if (xhr.status !== 200) return;
    var d;
    try { d = JSON.parse(xhr.responseText); } catch (e) { return; }

    if (!d.wifiConnected) {
      setBadge('fb-badge', 'No WiFi', 'badge-bad');
      setDetail('fb-detail', 'Not connected to WiFi.');
    } else {
      if (!d.firebase.attempted) {
        setBadge('fb-badge', 'No data yet', 'badge-warn');
        setDetail('fb-detail', 'No upload attempted yet this boot.');
      } else if (d.firebase.ok) {
        setBadge('fb-badge', 'OK', 'badge-ok');
        setDetail('fb-detail', 'Last upload succeeded ' + fmtAgo(d.firebase.secondsAgo) + '.');
      } else {
        setBadge('fb-badge', 'Failing', 'badge-bad');
        setDetail('fb-detail', 'Last attempt failed, ' + fmtAgo(d.firebase.secondsAgo) + '.');
      }

    }

    var rtcInfo = d.rtc.diag ? (' (' + d.rtc.diag + ')') : '';
    if (!d.rtc.present) {
      setBadge('rtc-badge', 'Not found', 'badge-bad');
      setDetail('rtc-detail', 'No RTC detected on I2C' + rtcInfo + '.');
    } else if (!d.rtc.timeValid) {
      setBadge('rtc-badge', 'Unset', 'badge-warn');
      setDetail('rtc-detail', 'Present, but clock unset' + rtcInfo + '.');
    } else {
      setBadge('rtc-badge', 'OK', 'badge-ok');
      setDetail('rtc-detail', 'Present and keeping time' + rtcInfo + '.');
    }

    if (!d.dht.everRead) {
      setBadge('dht-badge', 'No data yet', 'badge-bad');
      setDetail('dht-detail', 'No successful reading yet this boot -- check wiring.');
    } else if (d.dht.stale) {
      setBadge('dht-badge', 'Stale', 'badge-bad');
      setDetail('dht-detail', 'Last good reading ' + fmtAgo(d.dht.secondsAgo) + ' -- check wiring.');
    } else {
      setBadge('dht-badge', 'OK', 'badge-ok');
      var reading = (d.dht.temp !== null ? d.dht.temp.toFixed(1) + '\u00b0C' : '--') +
                    ' / ' + (d.dht.hum !== null ? d.dht.hum.toFixed(0) + '%' : '--');
      setDetail('dht-detail', reading + ' (' + fmtAgo(d.dht.secondsAgo) + ')');
    }

    if (d.power) {
      var pm = d.power.mode || 'normal';
      var label = pm.charAt(0).toUpperCase() + pm.slice(1);
      setBadge('power-badge', label, pm === 'normal' ? 'badge-ok' : 'badge-warn');
      setDetail('power-detail', d.power.cpuMhz + ' MHz \u00b7 read every ' + Math.round(d.power.readIntervalMs / 1000) + 's');
    }

    if (d.ota) {
      var slotKb = d.ota.slotKb || 0;
      var sketchKb = d.ota.sketchKb || 0;
      var okSlot = slotKb >= 1500;
      setBadge('ota-badge', okSlot ? (slotKb + ' KB') : (slotKb + ' KB (Small)'), okSlot ? 'badge-ok' : 'badge-warn');
      setDetail('ota-detail', 'App ' + sketchKb + ' KB / ' + slotKb + ' KB slot' + (okSlot ? ' \u00b7 OTA ready' : ' \u00b7 flash partitions.csv over USB'));
    }

    document.getElementById('pageSubtitle').textContent = 'Refreshes automatically every few seconds. Last updated ' + new Date().toLocaleTimeString() + '.';
  });
  xhr.addEventListener('error', function () {
    document.getElementById('pageSubtitle').textContent =
      'Connection lost -- showing the last known state from ' + new Date().toLocaleTimeString() + '. Retrying...';
  });
  xhr.addEventListener('timeout', function () {
    document.getElementById('pageSubtitle').textContent =
      'Device not responding (timed out) -- retrying...';
  });
  xhr.send();
}
refreshHealth();
setInterval(refreshHealth, 5000);
</script>
</body></html>
)rawliteral";
// Rate-limits repeated failed logins to this device's admin pages, to slow
// down password-guessing. Note what this does NOT protect against:
// credentials being sniffable on plain HTTP -- that needs a server-side TLS
// cert, which this sketch doesn't have and can't safely generate on its own.
// It only blunts brute-forcing the password.
const char* updatePage = R"rawliteral(
<!DOCTYPE html><html><head><meta charset='utf-8'>
<meta name='viewport' content='width=device-width, initial-scale=1'>
<title>OTA Firmware Update</title>
<style>
  body { font-family: sans-serif; max-width: 480px; margin: 40px auto; padding: 0 16px; color:#222; }
  #status { margin-top:14px; font-weight:bold; min-height:1.2em; }
  .ok   { color:#2e7d32; }
  .fail { color:#c62828; }
  .busy { color:#555; }
  input[type=text], input[type=file] { width:100%; box-sizing:border-box; padding:8px; font-size:15px; margin-top:6px; }
  input[type=submit] { margin-top:12px; padding:9px 16px; border:none; border-radius:6px; background:#1565c0; color:#fff; font-size:15px; cursor:pointer; }
  input:disabled { opacity:0.5; }
  label { display:block; margin-top:10px; font-size:0.95em; }
  hr { margin:24px 0; border:none; border-top:1px solid #ddd; }
  nav { font-size:0.9em; margin-bottom:14px; }
  a { color:#1565c0; }
  small { color:#666; display:block; margin-top:4px; }
</style>
</head><body>
<nav>
  <a href='/wifi'>WiFi networks</a> &middot;
  <a href='/firebase'>Firebase</a> &middot;
  <a href='/credentials'>Dashboard login</a> &middot;
  <a href='/power-saving'>Power saving</a> &middot;
  <a href='/health'>Device health</a>
</nav>
<h2>OTA Firmware Update</h2>
<p><small>Available OTA slot: <b>%OTA_SLOT_KB% KB</b> (use Minimal SPIFFS 1.9 MB partition for plenty of headroom)</small></p>

<h3>1. Pull from GitHub Pages / HTTPS URL</h3>
<form id='urlForm'>
  <label for='binUrl'>Firmware <code>.bin</code> URL (https://...)</label>
  <input type='text' id='binUrl' name='url' value='%OTA_BIN_URL%' placeholder='https://user.github.io/repo/firmware/latest.bin' autocomplete='off' required>
  <small>The ESP32 downloads the .bin directly over HTTPS and reboots automatically.</small>
  <input type='submit' value='Flash from URL'>
</form>

<hr>
<h3>2. Upload compiled <code>.bin</code> file manually</h3>
<form id='fileForm'>
  <label for='binFile'>Select compiled firmware (.bin)</label>
  <input type='file' id='binFile' name='update' accept='.bin' required>
  <input type='submit' value='Upload &amp; Flash'>
</form>

<div id='status'></div>
<pre id='otaLog' style='display:none;background:#111;color:#d6e2f0;font-family:monospace;font-size:12px;padding:12px;border-radius:8px;max-height:260px;overflow-y:auto;white-space:pre-wrap;margin-top:12px;line-height:1.45;'></pre>
<script>
// Allow Dashboard PWA to pass ?url=https://.../latest.bin for 1-tap flashing.
(function () {
  var params = new URLSearchParams(window.location.search);
  var qUrl = params.get('url');
  if (qUrl) document.getElementById('binUrl').value = qUrl;
})();

var logEl = document.getElementById('otaLog');
function clearLog() {
  logEl.style.display = 'block';
  logEl.textContent = '';
}
function appendLog(line) {
  logEl.style.display = 'block';
  var t = new Date().toLocaleTimeString([], { hour12: false });
  logEl.textContent += '[' + t + '] ' + line + '\n';
  logEl.scrollTop = logEl.scrollHeight;
}

function setBusy(busy) {
  document.querySelectorAll('input').forEach(function (el) { el.disabled = busy; });
}

function pollAfterReboot(status) {
  var elapsed = 0, step = 2500, maxMs = 60000;
  appendLog('Waiting for ESP32 to finish 5s solid-LED confirmation & reboot...');
  function ping() {
    var x = new XMLHttpRequest();
    x.open('GET', '/?_=' + Date.now(), true);
    x.timeout = 2000;
    x.onload = function () {
      if (x.status === 200) {
        status.className = 'ok';
        status.textContent = 'Device rebooted with new firmware! Reloading...';
        appendLog('ESP32 is back online! Reloading page...');
        setTimeout(function () { window.location.reload(); }, 1000);
      } else retry();
    };
    x.onerror = retry;
    x.ontimeout = retry;
    x.send();
  }
  function retry() {
    elapsed += step;
    if (elapsed >= maxMs) {
      status.className = 'fail';
      status.textContent = 'Device has not come back online yet -- check power/WiFi.';
      appendLog('Timed out waiting for ESP32 to come back online.');
      setBusy(false);
      return;
    }
    appendLog('Still waiting for reboot (' + Math.round(elapsed / 1000) + 's)...');
    setTimeout(ping, step);
  }
  setTimeout(ping, 7500);
}

document.getElementById('urlForm').addEventListener('submit', function (e) {
  e.preventDefault();
  var url = document.getElementById('binUrl').value.trim();
  if (!url) return;
  var status = document.getElementById('status');
  setBusy(true);
  clearLog();
  status.className = 'busy';
  status.textContent = 'Starting OTA pull...';
  appendLog('Sending URL to ESP32: ' + url);

  var xhr = new XMLHttpRequest();
  var seenLen = 0;
  function flushStream() {
    var txt = xhr.responseText || '';
    if (txt.length > seenLen) {
      var chunk = txt.slice(seenLen);
      seenLen = txt.length;
      chunk.split('\n').forEach(function (line) {
        if (line.trim()) appendLog(line.trim());
      });
    }
  }
  xhr.open('POST', '/update-url', true);
  xhr.timeout = 120000;
  xhr.setRequestHeader('Content-Type', 'application/x-www-form-urlencoded');
  xhr.addEventListener('progress', flushStream);
  xhr.addEventListener('load', function () {
    flushStream();
    var all = xhr.responseText || '';
    var ok = xhr.status === 200 && all.indexOf('[OTA] DONE') !== -1;
    status.className = ok ? 'ok' : 'fail';
    status.textContent = ok
      ? 'OTA succeeded! Blue LED solid for 5s, then rebooting...'
      : 'OTA failed -- see live log below.';
    if (ok) pollAfterReboot(status);
    else setBusy(false);
  });
  xhr.addEventListener('error', function () {
    flushStream();
    status.className = 'fail';
    status.textContent = 'Connection lost during update -- checking if device rebooted...';
    appendLog('Connection dropped during update -- probing ESP32...');
    pollAfterReboot(status);
  });
  xhr.addEventListener('timeout', function () {
    flushStream();
    status.className = 'fail';
    status.textContent = 'Update timed out -- check Serial or /health.';
    appendLog('Request timed out after 120s.');
    setBusy(false);
  });
  xhr.send('url=' + encodeURIComponent(url));
});

document.getElementById('fileForm').addEventListener('submit', function (e) {
  e.preventDefault();
  var fileInput = document.getElementById('binFile');
  if (!fileInput.files || !fileInput.files.length) return;
  var file = fileInput.files[0];
  var status = document.getElementById('status');
  var fd = new FormData();
  fd.append('update', file);

  setBusy(true);
  clearLog();
  status.className = 'busy';
  status.textContent = 'Uploading firmware (0%)...';
  appendLog('Starting upload: ' + file.name + ' (' + (file.size / 1024).toFixed(1) + ' KB)');

  var lastPct = -10;
  var xhr = new XMLHttpRequest();
  xhr.open('POST', '/update', true);
  xhr.timeout = 120000;
  xhr.upload.addEventListener('progress', function (ev) {
    if (ev.lengthComputable) {
      var pct = Math.round(ev.loaded * 100 / ev.total);
      status.textContent = 'Uploading & flashing (' + pct + '%)...';
      if (pct >= lastPct + 10 || pct === 100) {
        lastPct = pct;
        appendLog('Uploading to ESP32: ' + pct + '% (' + Math.round(ev.loaded / 1024) + ' / ' + Math.round(ev.total / 1024) + ' KB)');
      }
      if (pct === 100) appendLog('Upload sent -- ESP32 is verifying flash image...');
    }
  });
  xhr.addEventListener('load', function () {
    var ok = xhr.status === 200;
    status.className = ok ? 'ok' : 'fail';
    status.textContent = xhr.responseText || ('Failed (HTTP ' + xhr.status + ').');
    appendLog('ESP32: ' + (xhr.responseText || ('HTTP ' + xhr.status)));
    if (ok) pollAfterReboot(status);
    else setBusy(false);
  });
  xhr.addEventListener('error', function () {
    status.className = 'fail';
    status.textContent = 'Upload interrupted -- check WiFi and try again.';
    appendLog('Upload interrupted (network error).');
    setBusy(false);
  });
  xhr.addEventListener('timeout', function () {
    status.className = 'fail';
    status.textContent = 'Upload timed out.';
    appendLog('Upload timed out after 120s.');
    setBusy(false);
  });
  xhr.send(fd);
});
</script>
</body></html>
)rawliteral";

int otaFailedAttempts = 0;
bool otaLockoutActive = false;
unsigned long otaLockoutStart = 0;
const int OTA_MAX_ATTEMPTS = 5;
const unsigned long OTA_LOCKOUT_MS = 60000;

bool otaLockedOut() {
  if (!otaLockoutActive) return false;
  if (millis() - otaLockoutStart >= OTA_LOCKOUT_MS) {
    otaLockoutActive = false;
    return false;
  }
  return true;
}

void otaRegisterAuthFailure() {
  otaFailedAttempts++;
  if (otaFailedAttempts >= OTA_MAX_ATTEMPTS) {
    otaLockoutActive = true;
    otaLockoutStart = millis();
    otaFailedAttempts = 0;
    Serial.println("OTA: too many failed auth attempts -- locked out for 60s");
  }
}

// Shared gate for every protected page (/sync-code, /wifi, /credentials,
// /firebase, /power-saving, /power-presets): checks the lockout, checks the
// current (possibly web-changed) username/password, and on failure sends
// whatever response the caller needs (429 or a 401 challenge) itself -- so a
// handler can just do "if (!requireAdminAuth()) return;" and nothing else.
// Renamed from requireOtaAuth() per spec Decision #1 -- now that OTA is
// gone, this gates ordinary admin pages, not an update flow, so the old
// name was misleading (behavior is unchanged). Uses currentOtaUser/
// currentOtaPass rather than the OTA_USERNAME_DEFAULT/OTA_PASSWORD_DEFAULT
// macros directly, so a credential change from /credentials takes effect on
// the very next request, no restart needed.
bool requireAdminAuth() {
  if (otaLockedOut()) {
    server.send(429, "text/plain", "Too many failed attempts -- try again shortly.");
    return false;
  }
  if (!server.authenticate(currentOtaUser.c_str(), currentOtaPass.c_str())) {
    // Only count as a failed login when the browser actually sent credentials,
    // not on the initial unauthenticated challenge that triggers the login popup.
    if (server.hasHeader("Authorization")) {
      otaRegisterAuthFailure();
    }
    server.requestAuthentication();
    return false;
  }
  otaFailedAttempts = 0;
  return true;
}

bool  fsReady   = false;
float lastTemp  = NAN;
float lastHum   = NAN;

// ---------------- Health tracking, for the /health page ----------------
// Plain bool/unsigned long/float globals -- safe to read from any core
// without a lock, same reasoning used throughout this file for small values
// (see settingsMutex's comment for the contrast: that one's specifically
// about Strings, which DO need one). Written from core 0
// (sensorUploadTask/ledgerUploadTask), read from core 1 (the /health page).
bool lastFirebaseUploadOk = false;
unsigned long lastFirebaseAttemptMillis = 0; // 0 = no attempt yet this boot
unsigned long lastFirebaseSuccessMillis = 0; // 0 = no successful upload yet this boot --
                                              // used by wifiMaintenanceTask's zombie-connection
                                              // watchdog (see there) to tell "genuinely still
                                              // connected" apart from "WiFi.status() says
                                              // connected but this AP is actually gone"
unsigned long lastGoodDhtReadMillis = 0;     // 0 = no successful read yet this boot

// Cached from the last actual rtcHasValidTime() I2C check (setup()'s boot
// check, and syncTimeSources()'s periodic recheck) rather than the /health
// page calling rtcHasValidTime() itself fresh -- that would be a brand new
// cross-core I2C access (core 1's HTTP handler vs. core 0's
// wifiMaintenanceTask, which is what now calls syncTimeSources()), and I2C
// transactions aren't safe to run concurrently from two cores. Reusing the
// result of a call that already exists avoids adding a new one.
bool rtcTimeValid = false;

// ---------------- Filesystem mount safety ----------------
// LittleFS.begin(true) will silently FORMAT the whole partition if a normal
// mount fails -- wiping the WiFi network list, the queued sensor readings,
// and any not-yet-uploaded study session events. That's the right behavior
// on a genuinely fresh device (nothing to lose), but wrong on one that's
// already had a working filesystem: a single unclean power loss (very
// plausible on a battery/hotspot-powered device away from a wall outlet)
// can leave LittleFS's internal state torn enough that the next mount
// fails, and auto-formatting at that point destroys real data instead of
// just recovering from "never initialized." This flag -- kept in NVS, a
// completely separate flash partition from LittleFS, so it survives even a
// LittleFS wipe -- is how setup() tells the two cases apart. Uses its own
// tiny Preferences handle rather than the shared syncCodePrefs, since it
// needs to be readable before anything else in setup() has run.
bool fsHasMountedBefore() {
  Preferences p;
  p.begin("roomlogger", /*readOnly=*/true);
  bool ok = p.getBool("fs_ok_once", false);
  p.end();
  return ok;
}
void markFsMountedOnce() {
  Preferences p;
  p.begin("roomlogger", /*readOnly=*/false);
  p.putBool("fs_ok_once", true);
  p.end();
}

// ---------------- Blue status LED ----------------
// Assumption: blue LED wired to GPIO2, active-HIGH (HIGH = lit). If yours is
// on a different pin, or wired active-LOW, this is the only line to change.
const int LED_PIN = 2;

const int NORMAL_CPU_MHZ       = 240;
const int POWER_SAVING_CPU_MHZ = 80;

volatile PowerMode powerMode = POWER_NORMAL;
// In POWER_HIGH, WiFi is duty-cycled: off for HIGH_POWER_SLEEP_MS, then on for
// HIGH_POWER_WAKE_WINDOW_MS so queued readings drain and the web UI is reachable.
volatile bool highPowerWifiAwake = true;
unsigned long highPowerSleepStartMs = 0;
unsigned long highPowerWakeStartMs  = 0;
volatile bool statusPublishRequested = false;
volatile bool highPowerPendingSleep  = false;

volatile bool otaInProgress = false;
bool otaLedState = false;
unsigned long otaLedLastToggleMs = 0;

bool ledAvailableForStatus() {
  return powerMode == POWER_NORMAL && !otaInProgress;
}

void serviceOtaLed() {
  unsigned long now = millis();
  if (now - otaLedLastToggleMs >= 200) {
    otaLedLastToggleMs = now;
    otaLedState = !otaLedState;
    digitalWrite(LED_PIN, otaLedState ? HIGH : LOW);
  }
}

// Registers every network in the live list (loadWifiNetworksFromDisk() must
// have already populated it) with WiFiMulti. It will connect to whichever
// configured network has the strongest signal in range, and will
// automatically hop to another one if the current AP drops.

// Whether the fallback below is allowed to run at all. Used to be a
// compile-time const you could only flip by reflashing; now it's a runtime
// setting toggled from the /wifi page (the "Connect to free WiFi" switch)
// and persisted in the same "roomlogger" Preferences namespace as the sync
// code/credentials/Firebase settings -- see loadOpenNetworkSetting()/
// saveOpenNetworkSetting() further down. Defaults to true (the old
// compile-time default) the very first time a device boots with no saved
// value yet.
bool allowOpenNetworkFallback = true;

// Last resort when none of the saved networks (WiFiMulti's list) are
// reachable: scan for nearby networks, and if any are open (no password at
// all -- not just one we don't have saved), join whichever one has the
// strongest signal instead of just sitting disconnected. Always tried AFTER
// wifiMulti.run() has already failed to find a known network -- a saved
// network is preferred over an unknown open one every time; this never
// competes with or interrupts an existing connection. Bypasses WiFiMulti
// entirely (it only ever tries pre-registered SSIDs) and talks to
// WiFi.begin() directly instead.
//
// Worth knowing before relying on this: it means the board will join ANY
// open network in range with no way to vet it first -- fine sitting on a
// home desk, worth switching the "Connect to free WiFi" toggle off on
// /wifi anywhere else an open network might belong to someone else, since
// sensor uploads would then be going out over a connection you don't control.
bool connectToAnyOpenNetwork() {
  if (!allowOpenNetworkFallback) return false;

  int count = WiFi.scanNetworks();
  if (count <= 0) {
    WiFi.scanDelete();
    return false;
  }

  int bestIndex = -1;
  int32_t bestRssi = -1000;
  for (int i = 0; i < count; i++) {
    if (WiFi.encryptionType(i) == WIFI_AUTH_OPEN && WiFi.RSSI(i) > bestRssi) {
      bestRssi = WiFi.RSSI(i);
      bestIndex = i;
    }
  }

  if (bestIndex < 0) {
    WiFi.scanDelete();
    return false;
  }

  String openSsid = WiFi.SSID(bestIndex);
  WiFi.scanDelete();

  Serial.println("No configured network reachable -- trying open network: " + openSsid);
  WiFi.begin(openSsid.c_str());

  int attempts = 0;
  while (WiFi.status() != WL_CONNECTED && attempts < 20) {
    delay(250);
    attempts++;
  }

  if (WiFi.status() == WL_CONNECTED) {
    if (!checkInternetReachable()) {
      Serial.println("Open network '" + openSsid + "' has no working internet (captive portal?) -- disconnecting.");
      WiFi.disconnect(false, false);
      return false;
    }
    Serial.println("Connected to open network with working internet: " + openSsid);
    return true;
  }
  return false;
}

void connectWiFi() {
  WiFi.persistent(false);      // prevent stale BSSID/channel caching across hotspot restarts
  WiFi.setAutoReconnect(true);
  WiFi.mode(WIFI_STA);
  for (size_t i = 0; i < wifiNetworks.size(); i++) {
    wifiMulti.addAP(wifiNetworks[i].ssid.c_str(), wifiNetworks[i].password.c_str());
  }
}

// Tracks which SSID we last set things up for, so this is only redone when
// the device actually switches (or reconnects to) a network -- not on every
// WiFi check. Cleared to "" on any disconnect, so a hotspot that drops and
// comes back on the SAME SSID but a DIFFERENT subnet (common on Android,
// which randomizes its hotspot subnet each time it's toggled on) still
// triggers a fresh setup instead of being skipped as "unchanged".
String lastConnectedSSID = "";
String lastPublishedIp = "";
volatile bool forceWifiSetupReset = false;
volatile bool restartWebServerRequested = false;
String lastProcessedCmdId = "";
String lastCmdResult = "";
String lastCmdStage = "idle";
String cloudOtaState = "idle";
String cloudOtaMsg = "";
bool staticIpWasActive = false;

bool onNetworkConnected() {
  if (forceWifiSetupReset) {
    lastConnectedSSID = "";
    forceWifiSetupReset = false;
  }

  if (WiFi.status() != WL_CONNECTED) {
    lastConnectedSSID = "";  // force re-setup next time we connect
    return false;
  }

  String currentSSID = WiFi.SSID();
  String currentIp   = WiFi.localIP().toString();
  if (currentSSID == lastConnectedSSID && currentIp == lastPublishedIp && currentIp != "0.0.0.0") {
    return false;
  }
  lastConnectedSSID = currentSSID;

  bool hasStaticConfig = false;
  IPAddress targetIp, targetGw, targetSn, targetDns;
  if (wifiNetworksMutex == NULL || xSemaphoreTake(wifiNetworksMutex, pdMS_TO_TICKS(1000)) == pdTRUE) {
    for (size_t i = 0; i < wifiNetworks.size(); i++) {
      if (currentSSID != wifiNetworks[i].ssid) continue;
      if (wifiNetworks[i].staticIP != IPAddress(0, 0, 0, 0)) {
        hasStaticConfig = true;
        targetIp  = wifiNetworks[i].staticIP;
        targetGw  = wifiNetworks[i].gateway;
        targetSn  = wifiNetworks[i].subnet;
        targetDns = (wifiNetworks[i].dns == IPAddress(0, 0, 0, 0)) ? targetGw : wifiNetworks[i].dns;
      }
      break;
    }
    if (wifiNetworksMutex != NULL) xSemaphoreGive(wifiNetworksMutex);
  }

  bool staticIpApplied = false;
  if (hasStaticConfig) {
    if (WiFi.localIP() == targetIp) {
      staticIpApplied = true;
      staticIpWasActive = true;
    } else if (WiFi.config(targetIp, targetGw, targetSn, targetDns)) {
      delay(200);
      Serial.println("Static IP applied: " + targetIp.toString());
      staticIpApplied = true;
      staticIpWasActive = true;
    } else {
      Serial.println("Failed to apply static IP for " + currentSSID + " -- staying on DHCP-assigned address");
    }
  }

  // Only reset WiFi.config() back to DHCP when switching AWAY from a network
  // that previously had a static IP applied. Calling WiFi.config(0,0,0,0) on
  // an already-connected DHCP interface wipes the live lease to 0.0.0.0 and
  // restarts the DHCP client, breaking mDNS and status.json immediately after.
  if (!staticIpApplied && staticIpWasActive) {
    WiFi.config(IPAddress(0, 0, 0, 0), IPAddress(0, 0, 0, 0), IPAddress(0, 0, 0, 0));
    staticIpWasActive = false;
    unsigned long waitStart = millis();
    while (WiFi.localIP() == IPAddress(0, 0, 0, 0) && millis() - waitStart < 3000) {
      delay(100);
    }
  }

  MDNS.end();
  if (MDNS.begin(MDNS_HOSTNAME)) {
    MDNS.addService("http", "tcp", 80);
    Serial.println("Reachable at: http://" + String(MDNS_HOSTNAME) + ".local/");
  } else {
    Serial.println("mDNS responder failed to start");
  }

  lastPublishedIp = WiFi.localIP().toString();
  restartWebServerRequested = true;
  return true;
}


// TLS validation was previously implicit (http.begin(url) with a bare URL),
// which behaves differently across ESP32 core versions -- sometimes checked
// against a bundled root store, sometimes not checked at all. This makes the
// behavior explicit and consistent instead. Each call site builds its own
// WiFiClientSecure on the stack (rather than sharing one global instance)
// since these calls happen from both core 1 (loop()) and core 0
// (ledgerUploadTask) and a shared client wouldn't be safe to use from two
// tasks at once.
//
// To turn on real certificate validation: add a line like
//   #define ROOT_CA_CERT "-----BEGIN CERTIFICATE-----\n...\n-----END CERTIFICATE-----\n"
// to secrets.h (a PEM root cert covering *.firebaseio.com and
// *.workers.dev -- e.g. a current ISRG Root / Google Trust root); this file
// will pick it up automatically. Until then it falls back to setInsecure(),
// which is the same trust-on-first-use posture the sketch already had, just
// stated on purpose instead of left to chance.
bool tlsWarningPrinted = false;
void configureSecureClient(WiFiClientSecure& client) {
#ifdef ROOT_CA_CERT
  client.setCACert(ROOT_CA_CERT);
#else
  client.setInsecure();
  if (!tlsWarningPrinted) {
    Serial.println("TLS: certificate validation is OFF (setInsecure). Define ROOT_CA_CERT in secrets.h to turn it on.");
    tlsWarningPrinted = true;
  }
#endif
}

// Reports the device's current local IP + SSID to Firebase, so it can be
// found from any browser (even over cellular data) by checking
// https://<host>/status.json -- doesn't depend on mDNS support, which many
// Android versions still don't have for plain .local lookups.
//
// §3.3 also requires this extended with powerSavingActive, the current
// WiFi-on/off mode, and the three toggle states, so the dashboard can
// reflect live power-saving status. Called on every reconnect as before,
// plus now from enterPowerSaving()/exitPowerSaving()/the toggles handler
// whenever any of those five fields actually changes -- see the call sites
// there for why (a WiFi-on session doesn't reconnect when toggled, so
// nothing would otherwise trigger a fresh publish).
// Lightweight real-internet probe: resolves Firebase host via DNS and opens a
// short TCP connection on port 443. Catches dead hotspots and captive portals
// where WiFi.status() still claims WL_CONNECTED with no working internet.
bool checkInternetReachable() {
  if (WiFi.status() != WL_CONNECTED) return false;
  if (WiFi.localIP() == IPAddress(0, 0, 0, 0)) return false;

  String fbHost;
  if (xSemaphoreTake(settingsMutex, pdMS_TO_TICKS(500)) != pdTRUE) return true; // avoid false negative on lock contention
  fbHost = currentFirebaseHost;
  xSemaphoreGive(settingsMutex);

  // Strip optional :port for DNS/TCP check
  int colon = fbHost.indexOf(':');
  String bareHost = (colon >= 0) ? fbHost.substring(0, colon) : fbHost;
  IPAddress resolved;
  if (!WiFi.hostByName(bareHost.c_str(), resolved)) {
    return false;
  }
  WiFiClient probe;
  probe.setTimeout(3000);
  bool ok = probe.connect(resolved, 443);
  if (ok) probe.stop();
  return ok;
}

String buildStorageJson() {
  unsigned long flashKb   = (unsigned long)(ESP.getFlashChipSize() / 1024UL);
  unsigned long sketchKb  = (unsigned long)(ESP.getSketchSize() / 1024UL);
  unsigned long otaSlotKb = (unsigned long)(ESP.getFreeSketchSpace() / 1024UL);
  unsigned long fsTotalB  = fsReady ? (unsigned long)LittleFS.totalBytes() : 0UL;
  unsigned long fsUsedB   = fsReady ? (unsigned long)LittleFS.usedBytes()  : 0UL;
  unsigned long pendB     = 0UL;
  unsigned long pendLines = 0UL;
  unsigned long wifiB     = 0UL;

  if (fsReady) {
    if (LittleFS.exists(QUEUE_FILE)) {
      File f = LittleFS.open(QUEUE_FILE, "r");
      if (f) {
        pendB = (unsigned long)f.size();
        while (f.available()) {
          if (f.read() == '\n') pendLines++;
        }
        f.close();
      }
    }
    if (LittleFS.exists(WIFI_CONFIG_FILE)) {
      File wf = LittleFS.open(WIFI_CONFIG_FILE, "r");
      if (wf) {
        wifiB = (unsigned long)wf.size();
        wf.close();
      }
    }
  }

  unsigned long heapTotalKb = (unsigned long)(ESP.getHeapSize() / 1024UL);
  unsigned long heapFreeKb  = (unsigned long)(ESP.getFreeHeap() / 1024UL);
  unsigned long heapMinKb   = (unsigned long)(ESP.getMinFreeHeap() / 1024UL);

  String j = "{";
  j += "\"flashKb\":" + String(flashKb) + ",";
  j += "\"sketchKb\":" + String(sketchKb) + ",";
  j += "\"otaSlotKb\":" + String(otaSlotKb) + ",";
  j += "\"fsTotalBytes\":" + String(fsTotalB) + ",";
  j += "\"fsUsedBytes\":" + String(fsUsedB) + ",";
  j += "\"queueCapBytes\":" + String((unsigned long)MAX_QUEUE_BYTES) + ",";
  j += "\"pendingBytes\":" + String(pendB) + ",";
  j += "\"pendingCount\":" + String(pendLines) + ",";
  j += "\"wifiBytes\":" + String(wifiB) + ",";
  j += "\"heapTotalKb\":" + String(heapTotalKb) + ",";
  j += "\"heapFreeKb\":" + String(heapFreeKb) + ",";
  j += "\"heapMinFreeKb\":" + String(heapMinKb);
  j += "}";
  return j;
}

bool publishStatusToFirebase() {
  if (WiFi.status() != WL_CONNECTED) return false;
  IPAddress ip = WiFi.localIP();
  if (ip == IPAddress(0, 0, 0, 0)) return false;

  String fbHost, fbAuth;
  if (xSemaphoreTake(settingsMutex, pdMS_TO_TICKS(1000)) != pdTRUE) return false;
  fbHost = currentFirebaseHost;
  fbAuth = currentFirebaseAuth;
  xSemaphoreGive(settingsMutex);

  HTTPClient http;
  String url = "https://" + fbHost + "/status.json";
  if (fbAuth.length() > 0) url += "?auth=" + fbAuth;

  time_t nowSec = time(nullptr);
  unsigned long lastSeen = ((unsigned long)nowSec >= MIN_VALID_EPOCH) ? (unsigned long)nowSec : 0;

  String wifiListJson = "[";
  String prefCopy = "";
  if (wifiNetworksMutex == NULL || xSemaphoreTake(wifiNetworksMutex, pdMS_TO_TICKS(500)) == pdTRUE) {
    prefCopy = preferredWifiSsid;
    for (size_t i = 0; i < wifiNetworks.size(); i++) {
      if (i > 0) wifiListJson += ",";
      bool hasStatic = (wifiNetworks[i].staticIP != IPAddress(0, 0, 0, 0));
      wifiListJson += "{\"ssid\":\"" + jsonEscape(wifiNetworks[i].ssid) +
                      "\",\"ip\":\"" + (hasStatic ? wifiNetworks[i].staticIP.toString() : String("")) + "\"}";
    }
    if (wifiNetworksMutex != NULL) xSemaphoreGive(wifiNetworksMutex);
  }
  wifiListJson += "]";

  String otaUrlCopy = "";
  if (settingsMutex == NULL || xSemaphoreTake(settingsMutex, pdMS_TO_TICKS(500)) == pdTRUE) {
    otaUrlCopy = currentOtaBinUrl;
    if (settingsMutex != NULL) xSemaphoreGive(settingsMutex);
  }

  String payload = "{\"ip\":\"" + ip.toString() +
                    "\",\"ssid\":\"" + jsonEscape(WiFi.SSID()) +
                    "\",\"fsOk\":" + (fsReady ? "true" : "false") +
                    ",\"internetOk\":true" +
                    ",\"lastSeen\":" + String(lastSeen) +
                    ",\"powerMode\":\"" + String(powerModeName(powerMode)) +
                    "\",\"lastCmdId\":\"" + jsonEscape(lastProcessedCmdId) +
                    "\",\"lastCmdStage\":\"" + jsonEscape(lastCmdStage) +
                    "\",\"lastCmdResult\":\"" + jsonEscape(lastCmdResult) +
                    "\",\"ota\":{\"state\":\"" + jsonEscape(cloudOtaState) +
                    "\",\"msg\":\"" + jsonEscape(cloudOtaMsg) +
                    "\",\"url\":\"" + jsonEscape(otaUrlCopy) +
                    "\"},\"wifi\":{\"preferred\":\"" + jsonEscape(prefCopy) +
                    "\",\"networks\":" + wifiListJson +
                    "},\"health\":" + buildHealthStatusJson() + ",\"storage\":" + buildStorageJson() + "}";

  if (tlsMutex != NULL && xSemaphoreTake(tlsMutex, pdMS_TO_TICKS(15000)) != pdTRUE) {
    Serial.println("Failed to publish status to Firebase (TLS busy)");
    return false;
  }
  int code = -1;
  {
    WiFiClientSecure client;
    configureSecureClient(client);
    client.setTimeout(10);
    http.setConnectTimeout(10000);
    http.setTimeout(10000);
    if (http.begin(client, url)) {
      http.addHeader("Content-Type", "application/json");
      code = http.PUT(payload);
      http.end();
    }
  }
  if (tlsMutex != NULL) xSemaphoreGive(tlsMutex);

  if (code == 200) {
    if (wifiMutex == NULL || xSemaphoreTake(wifiMutex, pdMS_TO_TICKS(200)) == pdTRUE) {
      lastPublishedIp = ip.toString();
      if (wifiMutex != NULL) xSemaphoreGive(wifiMutex);
    }
    Serial.println("Status published to Firebase: " + payload);
    return true;
  }
  Serial.println("Failed to publish status to Firebase (HTTP " + String(code) + ")");
  return false;
}

// Extracts a string or bare primitive value for `"key":...` from a flat JSON object.
String jsonExtractField(const String& json, const char* key) {
  String pat = String("\"") + key + "\"";
  int pos = json.indexOf(pat);
  if (pos < 0) return "";
  pos = json.indexOf(':', pos + pat.length());
  if (pos < 0) return "";
  pos++;
  while (pos < (int)json.length() && (json[pos] == ' ' || json[pos] == '\t' || json[pos] == '\r' || json[pos] == '\n')) pos++;
  if (pos >= (int)json.length()) return "";
  if (json[pos] == '"') {
    pos++;
    String out;
    while (pos < (int)json.length()) {
      char c = json[pos++];
      if (c == '\\' && pos < (int)json.length()) {
        char n = json[pos++];
        if (n == 'n') out += '\n';
        else if (n == 'r') out += '\r';
        else if (n == 't') out += '\t';
        else out += n;
      } else if (c == '"') {
        break;
      } else {
        out += c;
      }
    }
    return out;
  }
  int end = pos;
  while (end < (int)json.length() && json[end] != ',' && json[end] != '}' && json[end] != ' ' && json[end] != '\r' && json[end] != '\n') end++;
  String raw = json.substring(pos, end);
  if (raw == "null") return "";
  return raw;
}

void pollAndHandleFirebaseCommand() {
  if (otaInProgress || WiFi.status() != WL_CONNECTED) return;
  if (WiFi.localIP() == IPAddress(0, 0, 0, 0)) return;

  String fbHost, fbAuth;
  if (xSemaphoreTake(settingsMutex, pdMS_TO_TICKS(500)) != pdTRUE) return;
  fbHost = currentFirebaseHost;
  fbAuth = currentFirebaseAuth;
  xSemaphoreGive(settingsMutex);
  if (fbHost.length() == 0) return;

  String url = "https://" + fbHost + "/cmd.json";
  if (fbAuth.length() > 0) url += "?auth=" + fbAuth;

  if (tlsMutex != NULL && xSemaphoreTake(tlsMutex, pdMS_TO_TICKS(3000)) != pdTRUE) return;
  String body = "";
  int code = -1;
  {
    WiFiClientSecure client;
    configureSecureClient(client);
    client.setTimeout(6);
    HTTPClient http;
    http.setConnectTimeout(5000);
    http.setTimeout(6000);
    if (http.begin(client, url)) {
      code = http.GET();
      if (code == 200) body = http.getString();
      http.end();
    }
  }
  if (tlsMutex != NULL) xSemaphoreGive(tlsMutex);

  body.trim();
  if (code != 200 || body.length() < 4 || body == "null") return;

  String cmdId  = jsonExtractField(body, "id");
  String action = jsonExtractField(body, "action");
  if (action.length() == 0 || (cmdId.length() > 0 && cmdId == lastProcessedCmdId)) return;

  // Clear /cmd.json immediately so a reboot or retry never executes the same command twice.
  if (tlsMutex == NULL || xSemaphoreTake(tlsMutex, pdMS_TO_TICKS(5000)) == pdTRUE) {
    WiFiClientSecure client;
    configureSecureClient(client);
    client.setTimeout(6);
    HTTPClient http;
    http.setConnectTimeout(5000);
    http.setTimeout(6000);
    if (http.begin(client, url)) {
      http.sendRequest("DELETE");
      http.end();
    }
    if (tlsMutex != NULL) xSemaphoreGive(tlsMutex);
  }

  lastProcessedCmdId = cmdId.length() > 0 ? cmdId : String(millis());
  lastCmdStage = "received";
  lastCmdResult = "ESP32 received '" + action + "' -- applying...";
  Serial.println("[CloudCmd] Executing action=" + action + " id=" + lastProcessedCmdId);
  publishStatusToFirebase(); // Stage 2 ACK: ESP32 received command

  if (action == "setPowerMode") {
    String m = jsonExtractField(body, "mode");
    m.toLowerCase();
    PowerMode target = POWER_NORMAL;
    bool valid = true;
    if (m == "normal") target = POWER_NORMAL;
    else if (m == "low") target = POWER_LOW;
    else if (m == "medium") target = POWER_MEDIUM;
    else if (m == "high") target = POWER_HIGH;
    else valid = false;
    if (valid) {
      applyPowerMode(target, false);
      lastCmdStage = "completed";
      lastCmdResult = "Power mode set to " + String(powerModeName(target));
    } else {
      lastCmdStage = "error";
      lastCmdResult = "Invalid power mode: " + m;
    }
    publishStatusToFirebase();
  } else if (action == "addWifi") {
    String ssid = jsonExtractField(body, "ssid");
    String pass = jsonExtractField(body, "password");
    String ipS  = jsonExtractField(body, "ip");
    String gwS  = jsonExtractField(body, "gateway");
    String snS  = jsonExtractField(body, "subnet");
    String dnsS = jsonExtractField(body, "dns");
    WifiSaveResult r = addOrUpdateWifiNetwork(ssid, pass, ipS, gwS, snS, dnsS);
    if (r == WIFI_SAVE_ADDED) { lastCmdStage = "completed"; lastCmdResult = "Added WiFi '" + ssid + "'"; }
    else if (r == WIFI_SAVE_UPDATED) { lastCmdStage = "completed"; lastCmdResult = "Updated WiFi '" + ssid + "' (reboot to apply password/IP)"; }
    else if (r == WIFI_SAVE_LIMIT_REACHED) { lastCmdStage = "error"; lastCmdResult = "WiFi list is full"; }
    else { lastCmdStage = "error"; lastCmdResult = "Invalid WiFi settings for '" + ssid + "'"; }
    publishStatusToFirebase();
  } else if (action == "removeWifi") {
    String targetSsid = jsonExtractField(body, "ssid");
    int idx = -1;
    if (wifiNetworksMutex == NULL || xSemaphoreTake(wifiNetworksMutex, pdMS_TO_TICKS(1000)) == pdTRUE) {
      for (size_t i = 0; i < wifiNetworks.size(); i++) {
        if (wifiNetworks[i].ssid == targetSsid) { idx = (int)i; break; }
      }
      if (wifiNetworksMutex != NULL) xSemaphoreGive(wifiNetworksMutex);
    }
    String removed;
    if (idx >= 0 && removeWifiNetworkByIndex(idx, removed)) {
      lastCmdStage = "completed";
      lastCmdResult = "Removed WiFi '" + removed + "'";
    } else {
      lastCmdStage = "error";
      lastCmdResult = "WiFi '" + targetSsid + "' not found";
    }
    publishStatusToFirebase();
  } else if (action == "setPreferredWifi") {
    String pref = jsonExtractField(body, "ssid");
    if (savePreferredWifi(pref)) {
      lastCmdStage = "completed";
      lastCmdResult = pref.length() ? ("Preferred WiFi set to '" + pref + "'") : "Preferred WiFi cleared";
    } else {
      lastCmdStage = "error";
      lastCmdResult = "Failed to save Preferred WiFi";
    }
    publishStatusToFirebase();
  } else if (action == "otaUrl") {
    String otaUrl = jsonExtractField(body, "url");
    if (!otaUrl.startsWith("https://") && !otaUrl.startsWith("http://")) {
      cloudOtaState = "error";
      cloudOtaMsg = "Invalid OTA URL";
      lastCmdResult = cloudOtaMsg;
      publishStatusToFirebase();
      return;
    }
    cloudOtaState = "running";
    cloudOtaMsg = "Downloading & flashing firmware...";
    lastCmdResult = cloudOtaMsg;
    publishStatusToFirebase();

    String err;
    bool ok = performOtaFromUrl(otaUrl, err);
    if (ok) {
      cloudOtaState = "ok";
      cloudOtaMsg = "Flash complete -- rebooting now";
      lastCmdStage = "completed";
      lastCmdResult = cloudOtaMsg;
      publishStatusToFirebase();
      digitalWrite(LED_PIN, HIGH);
      delay(5000);
      ESP.restart();
    } else {
      cloudOtaState = "error";
      cloudOtaMsg = "OTA failed: " + err;
      lastCmdStage = "error";
      lastCmdResult = cloudOtaMsg;
      publishStatusToFirebase();
    }
  } else if (action == "reboot") {
    lastCmdStage = "completed";
    lastCmdResult = "Rebooting ESP32...";
    publishStatusToFirebase();
    delay(400);
    ESP.restart();
  } else if (action == "refreshStatus") {
    lastCmdStage = "completed";
    lastCmdResult = "Health & storage refreshed";
    publishStatusToFirebase();
  } else {
    lastCmdStage = "error";
    lastCmdResult = "Unknown command: " + action;
    publishStatusToFirebase();
  }
}


// Sends one reading to Firebase. Returns the HTTP status code (200 = success;
// <=0 = transport/connection failure). Returning the code, not just a bool,
// lets callers tell "this specific entry is bad and will never succeed"
// (4xx) apart from "temporarily unreachable, worth retrying" (5xx or a
// negative transport error) -- see drainQueue().
int putReading(unsigned long epoch, const String& jsonPayload) {
  // Snapshot under the lock -- see settingsMutex's comment up top. This runs
  // on sensorUploadTask (core 0) while /firebase's POST handler (core 1) can
  // reassign these Strings at any time. Released immediately, before the
  // HTTP call below.
  String fbHost, fbAuth;
  if (xSemaphoreTake(settingsMutex, pdMS_TO_TICKS(1000)) != pdTRUE) return -1;
  fbHost = currentFirebaseHost;
  fbAuth = currentFirebaseAuth;
  xSemaphoreGive(settingsMutex);

  HTTPClient http;
  String url = "https://" + fbHost + "/readings/" + String(epoch) + ".json";
  if (fbAuth.length() > 0) {
    url += "?auth=" + fbAuth;
  }

  if (tlsMutex != NULL && xSemaphoreTake(tlsMutex, pdMS_TO_TICKS(15000)) != pdTRUE) {
    Serial.println("Upload skipped: TLS busy");
    return -1;
  }
  int code = -1;
  {
    WiFiClientSecure client;
    configureSecureClient(client);
    client.setTimeout(10);
    http.setConnectTimeout(10000);
    http.setTimeout(10000);
    if (http.begin(client, url)) {
      http.addHeader("Content-Type", "application/json");
      code = http.PUT(jsonPayload);
      http.end();
    }
  }
  if (tlsMutex != NULL) xSemaphoreGive(tlsMutex);

  lastFirebaseAttemptMillis = millis();
  lastFirebaseUploadOk = (code == 200);
  if (lastFirebaseUploadOk) lastFirebaseSuccessMillis = lastFirebaseAttemptMillis;

  if (code == 200) return code;

  if (code > 0) {
    Serial.println("Upload rejected (HTTP " + String(code) + ")");
  } else {
    Serial.println("Upload failed: " + http.errorToString(code));
  }
  return code;
}

// Appends a reading to the offline backlog file so it isn't lost.
void queueReading(unsigned long epoch, const String& jsonPayload) {
  if (!fsReady) {
    Serial.println("No filesystem available -- reading dropped");
    return;
  }

  File check = LittleFS.open(QUEUE_FILE, "r");
  size_t currentSize = check ? check.size() : 0;
  if (check) check.close();

  if (currentSize > MAX_QUEUE_BYTES) {
    Serial.println("Offline backlog is full -- dropping reading");
    return;
  }

  File f = LittleFS.open(QUEUE_FILE, "a");
  if (!f) {
    Serial.println("Could not open backlog file for writing");
    return;
  }
  f.print(epoch);
  f.print('\t');
  f.println(jsonPayload);
  f.close();
  Serial.println("No connection -- reading saved to flash for later upload");
}

// Uploads up to maxCount queued readings, keeping whatever it couldn't send.
void drainQueue(int maxCount) {
  if (!fsReady || !LittleFS.exists(QUEUE_FILE)) return;

  File src = LittleFS.open(QUEUE_FILE, "r");
  if (!src || src.size() == 0) {
    if (src) src.close();
    return;
  }

  bool litForThisDrain = ledAvailableForStatus();
  if (litForThisDrain) digitalWrite(LED_PIN, HIGH);

  int uploaded = 0;
  bool droppedAny = false;
  String failedLine = "";

  // Process up to maxCount entries FIRST without touching flash. If nothing
  // succeeds or gets dropped (e.g. Firebase unreachable), we exit with ZERO
  // LittleFS writes instead of rewriting the whole backlog every 3 seconds.
  while (src.available() && uploaded < maxCount && !otaInProgress) {
    String line = src.readStringUntil('\n');
    line.trim();
    if (line.length() == 0) continue;

    int tabIdx = line.indexOf('\t');
    if (tabIdx < 0) { droppedAny = true; continue; }

    unsigned long epoch = strtoul(line.substring(0, tabIdx).c_str(), nullptr, 10);
    String payload = line.substring(tabIdx + 1);

    int code = putReading(epoch, payload);
    if (code == 200) {
      uploaded++;
    } else if (code >= 400 && code < 500) {
      Serial.println("Dropping unrecoverable queued reading (HTTP " + String(code) + ")");
      droppedAny = true;
    } else {
      failedLine = line;
      break;
    }
  }

  if (uploaded > 0 || droppedAny) {
    if (failedLine.length() == 0 && !src.available()) {
      src.close();
      LittleFS.remove(QUEUE_FILE);
    } else {
      File tmp = LittleFS.open(QUEUE_TMP_FILE, "w");
      if (tmp) {
        if (failedLine.length() > 0) tmp.println(failedLine);
        uint8_t buf[256];
        while (src.available()) {
          size_t n = src.read(buf, sizeof(buf));
          if (n > 0) tmp.write(buf, n);
        }
        tmp.close();
        src.close();
        LittleFS.rename(QUEUE_TMP_FILE, QUEUE_FILE);
      } else {
        Serial.println("Could not open scratch file for draining backlog");
        src.close();
      }
    }
    Serial.println("Drained " + String(uploaded) + " queued reading(s) from backlog");
  } else {
    src.close();
  }

  if (litForThisDrain && ledAvailableForStatus()) digitalWrite(LED_PIN, LOW);
}

// Reads the sensor, then either uploads immediately or queues for later.
// Glows the status LED for this whole read+upload window -- but only when
// it's actually available (see ledAvailableForStatus()), and re-checked
// again on the way out in case a session grabbed the LED partway through:
// session control's writes always take priority, so if that happened this
// just leaves the pin alone rather than forcing it off underneath whatever
// session control has since set it to.
void handleReadingCycle() {
  bool litForThisCycle = ledAvailableForStatus();
  if (litForThisCycle) digitalWrite(LED_PIN, HIGH);

  float temp = dht.readTemperature();
  float hum  = dht.readHumidity();

  if (isnan(temp) || isnan(hum)) {
    Serial.println("Read failed -- check wiring");
    if (litForThisCycle && ledAvailableForStatus()) digitalWrite(LED_PIN, LOW);
    return;
  }

  lastTemp = temp;
  lastHum  = hum;
  lastGoodDhtReadMillis = millis();
  Serial.print("Temperature: ");
  Serial.print(temp);
  Serial.print(" C   Humidity: ");
  Serial.print(hum);
  Serial.println(" %");

  time_t now;
  time(&now);
  if ((unsigned long)now < MIN_VALID_EPOCH) {
    Serial.println("Clock not synced yet -- skipping this reading");
    if (litForThisCycle && ledAvailableForStatus()) digitalWrite(LED_PIN, LOW);
    return;
  }

  unsigned long epoch = (unsigned long)now;
  String payload = "{\"temp\":" + String(temp) + ",\"hum\":" + String(hum) + ",\"t\":" + String(epoch) + "}";

  bool uploaded = false;
  if (uploadsAllowedNow() && WiFi.status() == WL_CONNECTED) {
    uploaded = (putReading(epoch, payload) == 200);
  }

  if (!uploaded) {
    queueReading(epoch, payload);
  }

  if (litForThisCycle && ledAvailableForStatus()) digitalWrite(LED_PIN, LOW);
}

// ---------------- DS1307 real-time clock ----------------
// Battery-backed hardware clock over I2C (pins above). Its whole job: make
// correct wall-clock time available immediately at boot, before WiFi/NTP
// have had any chance to run -- see its use in setup() below, right where
// the old code could only ever wait on NTP. NTP still runs as before (see
// configTime() further down) and periodically re-stamps the RTC with the
// corrected time via syncTimeSources() below, so the RTC's own (much less
// accurate) crystal doesn't drift unchecked between reboots.
//
// This talks to the DS1307 directly over I2C rather than pulling in a
// library for it -- the register map is small, stable, and well documented,
// and it keeps this sketch dependency-free the same way the WiFi network
// list and Ledger event log parse their own simple formats above rather
// than reaching for a JSON library.
const uint8_t DS1307_I2C_ADDR = 0x68;
bool rtcPresent = false;
String rtcDiag = "not probed";

uint8_t bcdToDec(uint8_t bcd) { return ((bcd >> 4) * 10) + (bcd & 0x0F); }
uint8_t decToBcd(uint8_t dec) { return ((dec / 10) << 4) | (dec % 10); }

// Wire.begin() with 100 kHz clock + short power-up settle + 3 probe retries.
// If 0x68 does not ACK, scans the I2C bus and records a short diagnostic
// string for /health so wiring/address/voltage issues are visible immediately.
bool rtcBegin() {
  if (i2cMutex != NULL && xSemaphoreTake(i2cMutex, pdMS_TO_TICKS(500)) != pdTRUE) return false;
  Wire.begin(RTC_SDA_PIN, RTC_SCL_PIN, 100000);
  delay(50);

  uint8_t err = 4;
  for (int attempt = 0; attempt < 3; attempt++) {
    Wire.beginTransmission(DS1307_I2C_ADDR);
    err = Wire.endTransmission(true);
    if (err == 0) break;
    delay(25);
  }

  bool ok = (err == 0);
  if (!ok) {
    String found = "";
    for (uint8_t addr = 0x08; addr <= 0x77; addr++) {
      Wire.beginTransmission(addr);
      if (Wire.endTransmission(true) == 0) {
        if (found.length() > 0) found += ",";
        found += "0x";
        if (addr < 16) found += "0";
        found += String(addr, HEX);
      }
    }
    rtcDiag = "I2C err " + String(err) + " at 0x68; bus: " + (found.length() ? found : "empty");
  }
  if (i2cMutex != NULL) xSemaphoreGive(i2cMutex);
  return ok;
}

bool rtcHasValidTime() {
  if (i2cMutex != NULL && xSemaphoreTake(i2cMutex, pdMS_TO_TICKS(500)) != pdTRUE) return false;
  bool valid = false;
  Wire.beginTransmission(DS1307_I2C_ADDR);
  Wire.write((uint8_t)0x00);
  // Use STOP (true) instead of repeated-start (false): ESP32 Core 3.x / IDF 5.5
  // I2C driver frequently fails repeated-start reads on DS1307 modules.
  uint8_t txErr = Wire.endTransmission(true);
  int got = (txErr == 0) ? Wire.requestFrom((uint8_t)DS1307_I2C_ADDR, (uint8_t)7) : 0;
  if (txErr == 0 && got == 7) {
    uint8_t rawSec   = Wire.read();
    Wire.read(); // min
    Wire.read(); // hour
    Wire.read(); // dow
    uint8_t rawDate  = Wire.read();
    uint8_t rawMonth = Wire.read();
    uint8_t rawYear  = Wire.read();
    bool oscRunning  = (rawSec & 0x80) == 0;
    int year2000     = 2000 + bcdToDec(rawYear);
    int month        = bcdToDec(rawMonth & 0x1F);
    int day          = bcdToDec(rawDate & 0x3F);
    valid = oscRunning && (year2000 >= 2021) && (month >= 1 && month <= 12) && (day >= 1 && day <= 31);
    rtcDiag = String(year2000) + "-" + String(month) + "-" + String(day) + (oscRunning ? "" : " (CH halted)");
  } else {
    rtcDiag = "read failed (txErr=" + String(txErr) + ", got=" + String(got) + ")";
  }
  if (i2cMutex != NULL) xSemaphoreGive(i2cMutex);
  return valid;
}

time_t rtcGetEpoch() {
  if (i2cMutex != NULL && xSemaphoreTake(i2cMutex, pdMS_TO_TICKS(500)) != pdTRUE) return 0;
  time_t result = 0;
  Wire.beginTransmission(DS1307_I2C_ADDR);
  Wire.write((uint8_t)0x00);
  if (Wire.endTransmission(true) == 0 && Wire.requestFrom((uint8_t)DS1307_I2C_ADDR, (uint8_t)7) == 7) {
    uint8_t rawSec   = Wire.read();
    uint8_t rawMin   = Wire.read();
    uint8_t rawHour  = Wire.read();
    Wire.read(); // day-of-week register
    uint8_t rawDate  = Wire.read();
    uint8_t rawMonth = Wire.read();
    uint8_t rawYear  = Wire.read();

    struct tm t = {};
    t.tm_sec  = bcdToDec(rawSec & 0x7F);
    t.tm_min  = bcdToDec(rawMin & 0x7F);
    t.tm_hour = bcdToDec(rawHour & 0x3F);
    t.tm_mday = bcdToDec(rawDate & 0x3F);
    t.tm_mon  = bcdToDec(rawMonth & 0x1F) - 1;
    t.tm_year = bcdToDec(rawYear) + 100;
    t.tm_isdst = 0;
    result = mktime(&t);
  }
  if (i2cMutex != NULL) xSemaphoreGive(i2cMutex);
  return result;
}

bool rtcSetEpoch(time_t epoch) {
  struct tm t;
  gmtime_r(&epoch, &t);

  if (i2cMutex != NULL && xSemaphoreTake(i2cMutex, pdMS_TO_TICKS(500)) != pdTRUE) return false;
  Wire.beginTransmission(DS1307_I2C_ADDR);
  Wire.write((uint8_t)0x00);
  Wire.write((uint8_t)(decToBcd(t.tm_sec) & 0x7F));  // clear CH bit so oscillator runs
  Wire.write(decToBcd(t.tm_min));
  Wire.write((uint8_t)(decToBcd(t.tm_hour) & 0x3F)); // 24-hour mode
  Wire.write(decToBcd(t.tm_wday == 0 ? 7 : t.tm_wday));
  Wire.write(decToBcd(t.tm_mday));
  Wire.write(decToBcd(t.tm_mon + 1));
  Wire.write(decToBcd(t.tm_year - 100));
  bool ok = (Wire.endTransmission(true) == 0);
  if (i2cMutex != NULL) xSemaphoreGive(i2cMutex);
  return ok;
}

// ---------------- Session control (button + LED + event log) ----------------
// Persists to SESSION_LOG_FILE on LittleFS as it happens, so a reboot mid-
// session can restore the LED to the right state by reading just the LAST
// line -- no separate "current state" flag needed -- and so a WiFi outage
// never loses an event, just delays its upload. No duration math happens on
// this device: every event (START/PAUSE/RESUME/STOP) is stored with only a
// subject and a raw epoch timestamp. Ledger's own Worker merges arrays by
// "id", and the app side is expected to turn this sequence into a real
// studyLogs entry (subtracting any paused spans) -- not built yet.
//
// SESSION_LOG_FILE is the one thing in this file touched from two different
// tasks: handleSession() below writes to it from the main loop (core 1) and
// ledgerUploadTask() reads/clears it from the background task (core 0).
// eventLogMutex serializes that. pending.txt/pending.tmp (the sensor queue)
// used to be touched from loop() too but now live exclusively on
// sensorUploadTask (core 0) -- see the comment above that task -- so they
// don't need a mutex of their own.

// SessionState / sessionState itself now live up near the LED section (see
// ledAvailableForStatus() there) -- everything below still uses them exactly
// as before, just declared earlier in the file now.

unsigned long lastButtonPress      = 0;
volatile bool timeSynced           = false;
bool          holdingForPowerSave  = false;
unsigned long longPressStart       = 0;

bool sessionButtonPressed() {
  static bool lastState = HIGH;
  bool current = digitalRead(BUTTON_PIN);
  bool edge = false;
  if (lastState == HIGH && current == LOW) {
    unsigned long now = millis();
    if (now - lastButtonPress > DEBOUNCE_MS) {
      edge = true;
      lastButtonPress = now;
    }
  }
  lastState = current;
  return edge;
}

unsigned long lastRtcCalibrationMillis = 0;
const unsigned long RTC_RECALIBRATE_INTERVAL_MS = 6UL * 60 * 60 * 1000; // check for RTC drift at most this often
const long RTC_DRIFT_TOLERANCE_SEC = 2; // don't bother rewriting the RTC for anything this small

// Keeps the two time sources -- the DS1307 (if present) and NTP -- pointed
// at each other. Unlike the old checkTimeSynced() this replaces, it does
// NOT require WiFi to become synced in the first place: with an RTC on
// board that's already been set, timeSynced is already true from setup(),
// WiFi or not (see setup() below). This only handles the other direction --
// once NTP successfully resolves (system clock crosses MIN_VALID_EPOCH),
// mark synced if that hadn't happened yet (the no-RTC/not-yet-set fallback,
// same as the old behavior), and periodically check the RTC's own reading
// against the system clock, rewriting it only if they've actually drifted
// apart -- so its own much-less-accurate crystal doesn't drift unchecked
// between reboots, without hammering it over I2C when nothing's changed.
void syncTimeSources() {
  if (WiFi.status() != WL_CONNECTED) return;
  time_t now = time(nullptr);
  if ((unsigned long)now < MIN_VALID_EPOCH) return; // NTP hasn't resolved yet

  if (!timeSynced) {
    timeSynced = true; // no RTC, or an unset one -- NTP is this boot's first valid time
    Serial.println("Time synced via NTP -- system clock synced.");
  }

  if (!rtcPresent) return;

  // If RTC is currently valid, only re-check every 6 hours. If it is still
  // unset/invalid, retry every cycle (30s) until calibration actually succeeds.
  bool firstCheckThisBoot = (lastRtcCalibrationMillis == 0);
  unsigned long interval = rtcTimeValid ? RTC_RECALIBRATE_INTERVAL_MS : 30000UL;
  if (!firstCheckThisBoot && millis() - lastRtcCalibrationMillis < interval) return;

  bool rtcWasValid = rtcHasValidTime();
  rtcTimeValid = rtcWasValid;
  time_t rtcNow = rtcWasValid ? rtcGetEpoch() : 0;
  long driftSec = (long)now - (long)rtcNow;
  if (!rtcWasValid || driftSec < -RTC_DRIFT_TOLERANCE_SEC || driftSec > RTC_DRIFT_TOLERANCE_SEC) {
    if (rtcSetEpoch(now)) {
      // Read back to verify the write actually stuck (catches 3.3V-powered DS1307 lockouts).
      rtcTimeValid = rtcHasValidTime();
      lastRtcCalibrationMillis = millis();
      Serial.println(rtcTimeValid
        ? ("RTC calibrated from NTP (was off by " + String(driftSec) + "s).")
        : "RTC write ACKed but read-back still invalid -- check VCC is 5V (not 3.3V) on DS1307.");
    } else {
      lastRtcCalibrationMillis = millis(); // retry in 30s since rtcTimeValid is false
      Serial.println("RTC calibration write failed -- will retry in 30s.");
    }
  } else {
    lastRtcCalibrationMillis = millis();
  }
}

unsigned long lastRtcRetryMillis = 0;
const unsigned long RTC_RETRY_INTERVAL_MS = 30UL * 1000; // how often to retry a failed boot-time RTC read

// Covers what setup()'s one-shot rtcBegin() can't: an RTC that's actually
// present and correctly battery-backed, but whose very first I2C probe at
// boot happened to fail -- a real, intermittently-seen "No RTC found" here,
// not a one-off. Without this, that single bad read leaves rtcPresent/
// timeSynced false for the rest of the boot with no way to recover --
// fatal in particular for a WiFi-off power-saving session, which skips NTP
// entirely (see setup()), making the RTC the ONLY time source available.
// Cheap to retry: pure I2C, no WiFi involved, so it runs the same whether
// WiFi is on, off, or mid-power-saving.
void retryRtcIfNeeded() {
  if (rtcPresent) return; // already detected on I2C -- syncTimeSources() handles calibration
  unsigned long nowMs = millis();
  if (nowMs - lastRtcRetryMillis < RTC_RETRY_INTERVAL_MS) return;
  lastRtcRetryMillis = nowMs;

  rtcPresent = rtcBegin();
  if (!rtcPresent) return; // still nothing there -- try again next interval

  rtcTimeValid = rtcHasValidTime();
  if (!rtcTimeValid) {
    Serial.println("RTC found on retry (" + rtcDiag + "), waiting on NTP calibration.");
    return;
  }

  if (!timeSynced) {
    time_t rtcEpoch = rtcGetEpoch();
    struct timeval tv = { .tv_sec = rtcEpoch, .tv_usec = 0 };
    settimeofday(&tv, nullptr);
    timeSynced = true;
    Serial.println("RTC found on retry (" + String((unsigned long)rtcEpoch) + ") -- system clock synced.");
  } else {
    Serial.println("RTC found on retry (" + rtcDiag + ").");
  }
}

// ---------------- Admin username/password storage (NVS) ----------------
// Same "roomlogger" Preferences namespace as the sync code above -- lets the
// dashboard login be changed from a phone (see the /credentials routes in
// setup()) without reflashing.

// A tab or newline in the username/password would corrupt other things that
// assume clean single-line values (e.g. Serial logging); a blank one would
// mean a page nobody can log into. Otherwise deliberately permissive --
// unlike WiFi passwords, there's no WPA2-style length rule to enforce here.
bool isValidOtaUsername(const String& user) {
  if (user.length() < 1 || user.length() > 64) return false;
  for (unsigned int i = 0; i < user.length(); i++) {
    if (user[i] == '\t' || user[i] == '\n' || user[i] == '\r') return false;
  }
  return true;
}
bool isValidOtaPassword(const String& pass) {
  if (pass.length() < 8 || pass.length() > 64) return false;
  for (unsigned int i = 0; i < pass.length(); i++) {
    if (pass[i] == '\t' || pass[i] == '\n' || pass[i] == '\r') return false;
  }
  return true;
}

void loadOtaCredentials() {
  // syncCodePrefs is already begin()'d by loadSyncCode(), which setup()
  // always calls first -- reused here rather than opening a second
  // Preferences handle on the same namespace.
  String savedUser = syncCodePrefs.getString("ota_user", "");
  String savedPass = syncCodePrefs.getString("ota_pass", "");
  if (savedUser.length() > 0 && savedPass.length() > 0) {
    currentOtaUser = savedUser;
    currentOtaPass = savedPass;
    Serial.println("Dashboard login loaded from saved settings.");
  } else {
    Serial.println("Dashboard login: using the defaults from secrets.h.");
  }
}

bool saveOtaCredentials(const String& newUser, const String& newPass) {
  if (!isValidOtaUsername(newUser) || !isValidOtaPassword(newPass)) return false;
  currentOtaUser = newUser;
  currentOtaPass = newPass;
  syncCodePrefs.putString("ota_user", currentOtaUser);
  syncCodePrefs.putString("ota_pass", currentOtaPass);
  return true;
}

// ---------------- Open-network-fallback toggle storage (NVS) ----------------
// Same "roomlogger" Preferences namespace as everything else here -- lets
// the /wifi page's "Connect to free WiFi" switch survive a restart instead
// of resetting to the compile-time default every boot.
void loadOpenNetworkSetting() {
  // syncCodePrefs is already begin()'d by loadSyncCode(), which setup()
  // always calls first -- reused here rather than opening a second
  // Preferences handle on the same namespace.
  allowOpenNetworkFallback = syncCodePrefs.getBool("open_fallback", true);
  Serial.println(String("Open-network fallback: ") + (allowOpenNetworkFallback ? "ON" : "OFF") +
                 (syncCodePrefs.isKey("open_fallback") ? " (saved setting)." : " (default)."));
}

void saveOpenNetworkSetting(bool enabled) {
  allowOpenNetworkFallback = enabled;
  syncCodePrefs.putBool("open_fallback", allowOpenNetworkFallback);
}

void loadPreferredWifi() {
  String saved = syncCodePrefs.getString("pref_ssid", "");
  if (wifiNetworksMutex == NULL || xSemaphoreTake(wifiNetworksMutex, pdMS_TO_TICKS(1000)) == pdTRUE) {
    preferredWifiSsid = saved;
    if (wifiNetworksMutex != NULL) xSemaphoreGive(wifiNetworksMutex);
  }
  if (saved.length() > 0) {
    Serial.println("Preferred WiFi: " + saved);
  }
}

bool savePreferredWifi(const String& ssid) {
  if (ssid.length() > 0 && !isValidSsid(ssid)) return false;
  if (wifiNetworksMutex != NULL && xSemaphoreTake(wifiNetworksMutex, pdMS_TO_TICKS(1000)) != pdTRUE) {
    return false;
  }
  bool exists = (ssid.length() == 0);
  if (!exists) {
    for (size_t i = 0; i < wifiNetworks.size(); i++) {
      if (wifiNetworks[i].ssid == ssid) { exists = true; break; }
    }
  }
  if (exists) {
    preferredWifiSsid = ssid;
  }
  if (wifiNetworksMutex != NULL) xSemaphoreGive(wifiNetworksMutex);
  if (!exists) return false;
  syncCodePrefs.putString("pref_ssid", ssid);
  return true;
}

void loadOtaBinUrl() {
  currentOtaBinUrl = syncCodePrefs.getString("ota_bin_url", "");
}

void saveOtaBinUrl(const String& url) {
  currentOtaBinUrl = url;
  syncCodePrefs.putString("ota_bin_url", url);
}

void otaStreamLog(const String& msg) {
  Serial.println(msg);
  server.sendContent(msg + "\n");
}

// Downloads a compiled .bin from an https:// URL, flashes via Update.h, blinks
// the blue LED every 200ms, and streams live status lines back to the browser.
bool performOtaFromUrl(const String& url, String& errOut) {
  if (!url.startsWith("https://") || url.length() > 256 || url.indexOf(' ') >= 0) {
    errOut = "URL must start with https:// and contain no spaces.";
    otaStreamLog("[OTA] FAILED: " + errOut);
    return false;
  }
  if (WiFi.status() != WL_CONNECTED) {
    errOut = "WiFi is not connected.";
    otaStreamLog("[OTA] FAILED: " + errOut);
    return false;
  }
  otaStreamLog("[OTA] Waiting for TLS lock...");
  if (tlsMutex != NULL && xSemaphoreTake(tlsMutex, pdMS_TO_TICKS(15000)) != pdTRUE) {
    errOut = "Device busy with another HTTPS request -- try again.";
    otaStreamLog("[OTA] FAILED: " + errOut);
    return false;
  }

  otaInProgress = true;
  otaLedState = true;
  otaLedLastToggleMs = millis();
  digitalWrite(LED_PIN, HIGH);

  bool ok = false;
  {
    WiFiClientSecure client;
    configureSecureClient(client);
    client.setTimeout(30);
    HTTPClient http;
    http.setConnectTimeout(15000);
    http.setTimeout(30000);
    http.setFollowRedirects(HTTPC_STRICT_FOLLOW_REDIRECTS);

    otaStreamLog("[OTA] Connecting to firmware server...");
    if (!http.begin(client, url)) {
      errOut = "Could not initialize HTTPS connection.";
      otaStreamLog("[OTA] FAILED: " + errOut);
    } else {
      int httpCode = http.GET();
      if (httpCode != HTTP_CODE_OK) {
        errOut = "Download failed (HTTP " + String(httpCode) + ").";
        otaStreamLog("[OTA] FAILED: " + errOut);
      } else {
        int contentLength = http.getSize();
        size_t updateSize = (contentLength > 0) ? (size_t)contentLength : UPDATE_SIZE_UNKNOWN;
        if (contentLength > 0) {
          otaStreamLog("[OTA] Connected (HTTP 200) -- firmware size: " + String(contentLength / 1024.0, 1) + " KB");
        } else {
          otaStreamLog("[OTA] Connected (HTTP 200) -- chunked stream");
        }
        otaStreamLog("[OTA] Preparing OTA flash partition...");
        if (!Update.begin(updateSize)) {
          errOut = "Not enough OTA space: " + String(Update.errorString());
          otaStreamLog("[OTA] FAILED: " + errOut);
        } else {
          otaStreamLog("[OTA] Downloading & flashing (blue LED blinking every 200ms)...");
          WiFiClient* stream = http.getStreamPtr();
          uint8_t buf[1024];
          size_t written = 0;
          int lastPctLogged = -10;
          unsigned long lastProgressMs = millis();
          unsigned long lastDataMs = millis();
          bool writeErr = false;

          while (http.connected() && (contentLength < 0 || (int)written < contentLength)) {
            serviceOtaLed();
            size_t avail = stream->available();
            if (avail > 0) {
              size_t toRead = avail > sizeof(buf) ? sizeof(buf) : avail;
              int n = stream->readBytes(buf, toRead);
              if (n > 0) {
                lastDataMs = millis();
                if (Update.write(buf, (size_t)n) != (size_t)n) {
                  writeErr = true;
                  break;
                }
                written += (size_t)n;
                if (contentLength > 0) {
                  int pct = (int)((written * 100UL) / (size_t)contentLength);
                  if (pct >= lastPctLogged + 10 || pct == 100) {
                    lastPctLogged = pct;
                    lastProgressMs = millis();
                    otaStreamLog("[OTA] Flashing... " + String(pct) + "% (" +
                                 String(written / 1024) + " / " + String(contentLength / 1024) + " KB)");
                  }
                } else if (millis() - lastProgressMs >= 2000) {
                  lastProgressMs = millis();
                  otaStreamLog("[OTA] Flashing... " + String(written / 1024) + " KB written");
                }
              }
            } else {
              if (millis() - lastDataMs > 15000) break;
              delay(5);
            }
          }

          if (writeErr) {
            Update.abort();
            errOut = "Flash write error: " + String(Update.errorString());
            otaStreamLog("[OTA] FAILED: " + errOut);
          } else if (contentLength > 0 && (int)written != contentLength) {
            Update.abort();
            errOut = "Incomplete download (" + String(written) + "/" + String(contentLength) + " bytes).";
            otaStreamLog("[OTA] FAILED: " + errOut);
          } else {
            otaStreamLog("[OTA] Verifying written image & switching boot partition...");
            if (!Update.end(true)) {
              errOut = "Flash verification failed: " + String(Update.errorString());
              otaStreamLog("[OTA] FAILED: " + errOut);
            } else if (!Update.isFinished()) {
              errOut = "Update did not finish cleanly.";
              otaStreamLog("[OTA] FAILED: " + errOut);
            } else {
              otaStreamLog("[OTA] DONE! " + String(written / 1024.0, 1) + " KB flashed & verified. Holding blue LED solid for 5s, then rebooting...");
              ok = true;
            }
          }
        }
      }
      http.end();
    }
  }
  if (!ok) {
    digitalWrite(LED_PIN, LOW);
    otaInProgress = false;
  }
  if (tlsMutex != NULL) xSemaphoreGive(tlsMutex);
  return ok;
}

// ---------------- Firebase host/auth storage (NVS) ----------------
// Same "roomlogger" Preferences namespace again -- lets the Firebase target
// be changed from a phone (see the /firebase routes in setup()) without
// reflashing. Nothing here needs a restart to take effect: both
// publishStatusToFirebase() and putReading() read currentFirebaseHost/
// currentFirebaseAuth fresh on every call.

// Goes straight after "https://" into a URL with no separate encoding step
// (same reasoning as isValidSyncCode() above), so this is what keeps a
// saved host from ever breaking that URL. Deliberately doesn't try to be a
// full hostname validator -- just rules out characters that would corrupt
// the request (whitespace, slashes, quotes) or obviously aren't part of a
// bare "host[:port]" (no scheme, no path).
bool isValidFirebaseHost(const String& host) {
  if (host.length() < 1 || host.length() > 128) return false;
  if (host.indexOf("://") >= 0 || host.indexOf('/') >= 0) return false;
  for (unsigned int i = 0; i < host.length(); i++) {
    char c = host[i];
    bool ok = isAlphaNumeric(c) || c == '.' || c == '-' || c == ':';
    if (!ok) return false;
  }
  return true;
}

// Empty is allowed on purpose -- that's how "no auth, open database rules"
// is represented, same meaning FIREBASE_AUTH_DEFAULT="" already has in
// secrets.h. Otherwise just rules out characters that would corrupt the URL
// query string it gets appended to.
bool isValidFirebaseAuth(const String& auth) {
  if (auth.length() == 0) return true;
  if (auth.length() > 256) return false;
  for (unsigned int i = 0; i < auth.length(); i++) {
    char c = auth[i];
    if (c == ' ' || c == '\t' || c == '\n' || c == '\r' || c == '/' || c == '?' || c == '&') return false;
  }
  return true;
}

// Same masking approach as maskSyncCode()/maskWifiPassword() above, for the
// same reason -- this page has no HTTPS on this device.
String maskFirebaseAuth(const String& auth) {
  if (auth.length() == 0) return "(none -- open rules)";
  String masked = auth.substring(0, auth.length() < 2 ? auth.length() : 2);
  while (masked.length() < auth.length()) masked += '*';
  return masked;
}

void loadFirebaseSettings() {
  // syncCodePrefs is already begin()'d by loadSyncCode() -- reused here
  // rather than opening a second Preferences handle on the same namespace.
  String savedHost = syncCodePrefs.getString("fb_host", "");
  // getString()'s own default only covers a totally missing key -- an
  // explicitly-saved empty auth token (the open-rules case) is a real,
  // intentional value and has to be told apart from "never saved", or a
  // saved blank would wrongly fall back to the secrets.h default forever.
  String savedAuth = syncCodePrefs.getString("fb_auth", FIREBASE_AUTH_DEFAULT);

  if (savedHost.length() > 0) {
    if (xSemaphoreTake(settingsMutex, pdMS_TO_TICKS(1000)) == pdTRUE) {
      currentFirebaseHost = savedHost;
      currentFirebaseAuth = savedAuth;
      xSemaphoreGive(settingsMutex);
    }
    Serial.println("Firebase host/auth loaded from saved settings.");
  } else {
    Serial.println("Firebase host/auth: using the defaults from secrets.h.");
  }
}

bool saveFirebaseSettings(const String& newHost, const String& newAuth) {
  if (!isValidFirebaseHost(newHost) || !isValidFirebaseAuth(newAuth)) return false;
  if (xSemaphoreTake(settingsMutex, pdMS_TO_TICKS(1000)) != pdTRUE) return false;
  currentFirebaseHost = newHost;
  currentFirebaseAuth = newAuth;
  xSemaphoreGive(settingsMutex);
  syncCodePrefs.putString("fb_host", newHost);
  syncCodePrefs.putString("fb_auth", newAuth);
  return true;
}

// ---------------- WiFi network list storage (LittleFS) ----------------
// Lets networks be added/removed/edited from a phone (see the /wifi routes
// in setup()) without reflashing. Stored as one line per network in its own
// file, tab-separated -- same idea as the ledger event log further up, and
// kept out of NVS/Preferences because it's a variable-length list rather
// than a handful of fixed scalar settings.
//
// Line format: ssid \t password \t staticIP \t gateway \t subnet \t dns
// IPs are stored as dotted strings; "0.0.0.0" means "not set" (DHCP), same
// meaning it already has in the WifiCred struct in secrets.h.
//
// Passwords land here in plain text, same as they already sit in plain text
// in the compiled firmware today (secrets.h) -- this isn't a new exposure,
// just the same trust level in a different place.

// 802.11 caps an SSID at 32 bytes. A tab/newline would corrupt the storage
// file's line format, so those are rejected regardless of length.
bool isValidSsid(const String& ssid) {
  if (ssid.length() < 1 || ssid.length() > 32) return false;
  for (unsigned int i = 0; i < ssid.length(); i++) {
    char c = ssid[i];
    if (c == '\t' || c == '\n' || c == '\r') return false;
  }
  return true;
}

// Empty is allowed on purpose -- that's how an open (unsecured) network is
// represented, both here and to WiFiMulti::addAP(). Otherwise WPA2's own
// 8-63 character rule, since anything outside that range can never actually
// associate.
bool isValidWifiPassword(const String& pass) {
  if (pass.length() == 0) return true;
  if (pass.length() < 8 || pass.length() > 63) return false;
  for (unsigned int i = 0; i < pass.length(); i++) {
    char c = pass[i];
    if (c == '\t' || c == '\n' || c == '\r') return false;
  }
  return true;
}

// Parses "a.b.c.d" into an IPAddress. Returns false (leaving out unchanged)
// for a blank string or anything that isn't 4 valid octets -- callers treat
// "blank" and "invalid" the same way (DHCP), but keep the distinction
// available since a genuinely malformed value is worth rejecting outright
// in the form handler rather than silently falling back to DHCP.
bool parseIPv4(const String& s, IPAddress& out) {
  if (s.length() == 0) { out = IPAddress(0, 0, 0, 0); return true; }
  int parts[4];
  int idx = 0, start = 0;
  for (int i = 0; i <= (int)s.length(); i++) {
    if (i == (int)s.length() || s[i] == '.') {
      if (idx >= 4) return false;
      String part = s.substring(start, i);
      if (part.length() == 0 || part.length() > 3) return false;
      for (unsigned int j = 0; j < part.length(); j++) {
        if (!isDigit(part[j])) return false;
      }
      int val = part.toInt();
      if (val < 0 || val > 255) return false;
      parts[idx++] = val;
      start = i + 1;
    }
  }
  if (idx != 4) return false;
  out = IPAddress(parts[0], parts[1], parts[2], parts[3]);
  return true;
}

// Shows enough of the password to recognize it without putting the whole
// thing on screen -- same reasoning as maskSyncCode() above.
String maskWifiPassword(const String& pass) {
  if (pass.length() == 0) return "(open network)";
  String masked = pass.substring(0, pass.length() < 2 ? pass.length() : 2);
  while (masked.length() < pass.length()) masked += '*';
  return masked;
}

// SSIDs (and, in the masked form, passwords) come from whatever someone
// typed into the /wifi form and get echoed back into HTML on every later
// GET -- without escaping, a name like `<script>` would be stored fine but
// then execute in the browser of anyone who opens the page.
String htmlEscape(const String& s) {
  String out;
  out.reserve(s.length());
  for (unsigned int i = 0; i < s.length(); i++) {
    switch (s[i]) {
      case '&':  out += "&amp;";  break;
      case '<':  out += "&lt;";   break;
      case '>':  out += "&gt;";   break;
      case '"':  out += "&quot;"; break;
      case '\'': out += "&#39;";  break;
      default:   out += s[i];
    }
  }
  return out;
}

// Same idea as htmlEscape() above, but for embedding a String inside a JSON
// string value -- used by buildWifiStatusJson() below, since an SSID is
// whatever the network broadcasts and could in principle contain a quote or
// backslash.
String jsonEscape(const String& s) {
  String out;
  out.reserve(s.length());
  for (unsigned int i = 0; i < s.length(); i++) {
    switch (s[i]) {
      case '"':  out += "\\\""; break;
      case '\\': out += "\\\\"; break;
      case '\n': out += "\\n";  break;
      case '\r': out += "\\r";  break;
      default:   out += s[i];
    }
  }
  return out;
}

// Backs the /wifi/status endpoint the "Connected to..." box on the /wifi
// page polls. isSaved tells the two ways a live connection can exist apart:
// true means it's one of the entries in wifiNetworks (added via the "Add a
// network" form above), false means the connection is currently on
// something NOT in that list -- which, since normal WiFiMulti connections
// only ever come from that list, can only mean connectToAnyOpenNetwork()'s
// fallback is what's actually holding the connection right now.
String buildWifiStatusJson() {
  bool connected = WiFi.status() == WL_CONNECTED;
  String ssid = connected ? WiFi.SSID() : "";

  bool isSaved = false;
  if (wifiNetworksMutex == NULL || xSemaphoreTake(wifiNetworksMutex, pdMS_TO_TICKS(1000)) == pdTRUE) {
    for (size_t i = 0; i < wifiNetworks.size(); i++) {
      if (wifiNetworks[i].ssid == ssid) { isSaved = true; break; }
    }
    if (wifiNetworksMutex != NULL) xSemaphoreGive(wifiNetworksMutex);
  }

  String json = "{\"connected\":" + String(connected ? "true" : "false") +
                ",\"ssid\":\"" + jsonEscape(ssid) + "\"" +
                ",\"ip\":\"" + (connected ? WiFi.localIP().toString() : String("")) + "\"" +
                ",\"rssi\":" + String(connected ? WiFi.RSSI() : 0) +
                ",\"isSaved\":" + (isSaved ? "true" : "false") +
                ",\"openFallbackEnabled\":" + (allowOpenNetworkFallback ? "true" : "false") + "}";
  return json;
}

// Backs the /health page's three status rows (Cloud/RTC/DHT22). Everything
// read here is a plain bool/unsigned long/float -- safe from this core-1
// HTTP handler without a lock, per each variable's own declaration comment.
// "Attempted"/"everRead" being false means genuinely "no data yet this
// boot" (0 is the sentinel), told apart from a real 0-seconds-ago result.
String buildHealthStatusJson() {
  bool wifiConnected = (WiFi.status() == WL_CONNECTED);
  unsigned long now = millis();

  bool fbAttempted = (lastFirebaseAttemptMillis != 0);
  bool dhtEverRead = (lastGoodDhtReadMillis != 0);

  // Scales with whatever read interval is CURRENTLY in effect (Normal or a
  // power-saving preset) rather than a fixed number -- a fixed threshold
  // would false-positive "stale" under any preset with a longer-than-usual
  // read interval.
  bool dhtStale = dhtEverRead &&
                  ((now - lastGoodDhtReadMillis) > (effectiveReadUploadIntervalMs() * 5 / 2));

  String json = "{";
  json += "\"wifiConnected\":" + String(wifiConnected ? "true" : "false") + ",";

  json += "\"firebase\":{\"attempted\":" + String(fbAttempted ? "true" : "false") +
          ",\"ok\":" + String(lastFirebaseUploadOk ? "true" : "false") +
          ",\"secondsAgo\":" + (fbAttempted ? String((now - lastFirebaseAttemptMillis) / 1000) : String("null")) +
          "},";

  String diagCopy = rtcDiag;
  diagCopy.replace("\"", "'");
  json += "\"rtc\":{\"present\":" + String(rtcPresent ? "true" : "false") +
          ",\"timeValid\":" + String(rtcTimeValid ? "true" : "false") +
          ",\"diag\":\"" + diagCopy + "\"},";

  json += "\"dht\":{\"everRead\":" + String(dhtEverRead ? "true" : "false") +
          ",\"secondsAgo\":" + (dhtEverRead ? String((now - lastGoodDhtReadMillis) / 1000) : String("null")) +
          ",\"stale\":" + String(dhtStale ? "true" : "false") +
          ",\"temp\":" + (isnan(lastTemp) ? String("null") : String(lastTemp, 1)) +
          ",\"hum\":" + (isnan(lastHum) ? String("null") : String(lastHum, 0)) +
          "},";

  int cpuMhz = (powerMode == POWER_NORMAL) ? NORMAL_CPU_MHZ : POWER_SAVING_CPU_MHZ;
  json += "\"power\":{\"mode\":\"" + String(powerModeName(powerMode)) + "\"" +
          ",\"cpuMhz\":" + String(cpuMhz) +
          ",\"readIntervalMs\":" + String(effectiveReadUploadIntervalMs()) +
          "},";
  unsigned long otaSlotKb = (unsigned long)(ESP.getFreeSketchSpace() / 1024UL);
  unsigned long sketchKb  = (unsigned long)(ESP.getSketchSize() / 1024UL);
  json += "\"ota\":{\"slotKb\":" + String(otaSlotKb) +
          ",\"sketchKb\":" + String(sketchKb) +
          "}";
  json += "}";
  return json;
}


// Builds the <li> rows for the /wifi page: one per configured network, each
// with a Remove button carrying that network's index -- except when it's
// the last remaining network, since removeWifiNetworkByIndex() won't allow
// that removal anyway (see its comment).
String buildWifiRowsHtml() {
  String html;
  if (wifiNetworksMutex == NULL || xSemaphoreTake(wifiNetworksMutex, pdMS_TO_TICKS(1000)) == pdTRUE) {
    for (size_t i = 0; i < wifiNetworks.size(); i++) {
      const WifiEntry& e = wifiNetworks[i];
      String ipMode = (e.staticIP == IPAddress(0, 0, 0, 0))
        ? "DHCP" : ("Static " + e.staticIP.toString());

      html += "<li class='wifi-row'>";
      html += "<div class='wifi-name'>" + htmlEscape(e.ssid) + (e.ssid == preferredWifiSsid ? " <span class='saved-tag'>(preferred)</span>" : "") + "</div>";
      html += "<div class='wifi-meta'>" + htmlEscape(maskWifiPassword(e.password)) + " &middot; " + ipMode + "</div>";
      if (wifiNetworks.size() > 1) {
        html += "<button type='button' class='remove-btn' data-index='" + String(i) + "' data-ssid='" +
                htmlEscape(e.ssid) + "'>Remove</button>";
      }
      html += "</li>";
    }
    if (wifiNetworksMutex != NULL) xSemaphoreGive(wifiNetworksMutex);
  }
  if (html.length() == 0) html = "<li class='wifi-row'>No networks configured.</li>";
  return html;
}

// Turns one network back into its storage line. A helper so
// saveWifiNetworksToDisk() and the seeding path in loadWifiNetworksFromDisk()
// (which writes the very first file) can't drift apart from each other.
String buildPreferredWifiOptionsHtml() {
  String html;
  if (wifiNetworksMutex == NULL || xSemaphoreTake(wifiNetworksMutex, pdMS_TO_TICKS(1000)) == pdTRUE) {
    html += "<option value=''" + String(preferredWifiSsid.length() == 0 ? " selected" : "") + ">None (disabled)</option>";
    for (size_t i = 0; i < wifiNetworks.size(); i++) {
      const String& s = wifiNetworks[i].ssid;
      html += "<option value='" + htmlEscape(s) + "'" + (s == preferredWifiSsid ? " selected" : "") + ">" + htmlEscape(s) + "</option>";
    }
    if (wifiNetworksMutex != NULL) xSemaphoreGive(wifiNetworksMutex);
  }
  return html;
}

String wifiEntryToLine(const WifiEntry& e) {
  return e.ssid + '\t' + e.password + '\t' +
         e.staticIP.toString() + '\t' + e.gateway.toString() + '\t' +
         e.subnet.toString() + '\t' + e.dns.toString();
}

// Parses one storage line back into a WifiEntry. Returns false (line
// dropped) for anything that doesn't have all 6 fields -- e.g. a line torn
// by a power cut mid-write, though the atomic tmp+rename in
// saveWifiNetworksToDisk() should make that rare.
bool parseWifiLine(const String& line, WifiEntry& out) {
  int tabs[5];
  int from = 0;
  for (int i = 0; i < 5; i++) {
    int t = line.indexOf('\t', from);
    if (t < 0) return false;
    tabs[i] = t;
    from = t + 1;
  }
  out.ssid     = line.substring(0, tabs[0]);
  out.password = line.substring(tabs[0] + 1, tabs[1]);
  bool ok = true;
  ok &= parseIPv4(line.substring(tabs[1] + 1, tabs[2]), out.staticIP);
  ok &= parseIPv4(line.substring(tabs[2] + 1, tabs[3]), out.gateway);
  ok &= parseIPv4(line.substring(tabs[3] + 1, tabs[4]), out.subnet);
  ok &= parseIPv4(line.substring(tabs[4] + 1), out.dns);
  return ok && out.ssid.length() > 0;
}

// Atomic write, same tmp-file-then-rename pattern used for the reading
// backlog above -- avoids a power cut mid-write leaving a half-written file
// that then fails to parse on next boot.
bool saveWifiNetworksToDisk() {
  if (!fsReady) return false;

  File tmp = LittleFS.open(WIFI_CONFIG_TMP_FILE, "w");
  if (!tmp) {
    Serial.println("Could not open scratch file for saving WiFi networks");
    return false;
  }
  for (size_t i = 0; i < wifiNetworks.size(); i++) {
    tmp.println(wifiEntryToLine(wifiNetworks[i]));
  }
  tmp.close();

  if (!LittleFS.rename(WIFI_CONFIG_TMP_FILE, WIFI_CONFIG_FILE)) {
    Serial.println("Could not save WiFi network list");
    return false;
  }
  return true;
}

// Populates wifiNetworks from LittleFS. On a genuinely fresh device (or
// after the saved file is cleared), seeds it from the WIFI_NETWORKS array in
// secrets.h instead, then immediately writes that out as the starting
// LittleFS file -- mirroring how loadSyncCode() falls back to
// LEDGER_SYNC_CODE_DEFAULT.
void loadWifiNetworksFromDisk() {
  wifiNetworks.clear();

  if (fsReady && LittleFS.exists(WIFI_CONFIG_FILE)) {
    File f = LittleFS.open(WIFI_CONFIG_FILE, "r");
    if (f) {
      while (f.available()) {
        String line = f.readStringUntil('\n');
        line.trim();
        if (line.length() == 0) continue;
        WifiEntry e;
        if (parseWifiLine(line, e)) wifiNetworks.push_back(e);
      }
      f.close();
    }
  }

  if (wifiNetworks.size() > 0) {
    Serial.println("WiFi network list loaded from saved settings (" + String(wifiNetworks.size()) + ").");
    return;
  }

  Serial.println("WiFi network list: seeding from secrets.h.");
  for (int i = 0; i < WIFI_SEED_NETWORK_COUNT; i++) {
    WifiEntry e;
    e.ssid     = WIFI_NETWORKS[i].ssid;
    e.password = WIFI_NETWORKS[i].password;
    e.staticIP = WIFI_NETWORKS[i].staticIP;
    e.gateway  = WIFI_NETWORKS[i].gateway;
    e.subnet   = WIFI_NETWORKS[i].subnet;
    e.dns      = WIFI_NETWORKS[i].dns;
    wifiNetworks.push_back(e);
  }
  saveWifiNetworksToDisk();
}

WifiSaveResult addOrUpdateWifiNetwork(const String& ssid, const String& password,
                                       const String& ipStr, const String& gwStr,
                                       const String& snStr, const String& dnsStr) {
  if (!isValidSsid(ssid) || !isValidWifiPassword(password)) return WIFI_SAVE_INVALID;

  WifiEntry e;
  e.ssid = ssid;
  e.password = password;

  // Static IP is all-or-nothing across ip/gateway/subnet -- a partial set
  // can't be applied by WiFi.config() later, so it's rejected here rather
  // than silently falling back to DHCP with two of the three fields lost.
  bool anyIpField = ipStr.length() > 0 || gwStr.length() > 0 || snStr.length() > 0;
  bool allIpFields = ipStr.length() > 0 && gwStr.length() > 0 && snStr.length() > 0;
  if (anyIpField && !allIpFields) return WIFI_SAVE_INVALID;

  if (!parseIPv4(ipStr, e.staticIP) || !parseIPv4(gwStr, e.gateway) ||
      !parseIPv4(snStr, e.subnet) || !parseIPv4(dnsStr, e.dns)) {
    return WIFI_SAVE_INVALID;
  }

  if (wifiNetworksMutex != NULL && xSemaphoreTake(wifiNetworksMutex, pdMS_TO_TICKS(1000)) != pdTRUE) {
    return WIFI_SAVE_INVALID;
  }

  for (size_t i = 0; i < wifiNetworks.size(); i++) {
    if (wifiNetworks[i].ssid != ssid) continue;
    WifiEntry previous = wifiNetworks[i];
    wifiNetworks[i] = e;
    bool saved = saveWifiNetworksToDisk();
    if (!saved) wifiNetworks[i] = previous;
    if (wifiNetworksMutex != NULL) xSemaphoreGive(wifiNetworksMutex);
    return saved ? WIFI_SAVE_UPDATED : WIFI_SAVE_INVALID;
  }

  if ((int)wifiNetworks.size() >= MAX_WIFI_NETWORKS) {
    if (wifiNetworksMutex != NULL) xSemaphoreGive(wifiNetworksMutex);
    return WIFI_SAVE_LIMIT_REACHED;
  }

  wifiNetworks.push_back(e);
  if (!saveWifiNetworksToDisk()) {
    wifiNetworks.pop_back();
    if (wifiNetworksMutex != NULL) xSemaphoreGive(wifiNetworksMutex);
    return WIFI_SAVE_INVALID;
  }
  if (wifiNetworksMutex != NULL) xSemaphoreGive(wifiNetworksMutex);
  // Safe to do live: addAP() only ever appends to WiFiMulti's own list, and
  // this SSID wasn't in it before. Still needs the lock -- wifiMaintenanceTask
  // (core 0) could be mid a multi-second reconnect/open-network-scan cycle
  // at this exact moment, which is why this waits longer than the
  // button-reachable WiFi.mode() calls in enterPowerSaving()/
  // exitPowerSaving() do: this is an infrequent, deliberate admin action
  // (not something that needs to stay button-snappy), so it's fine to wait
  // out a in-progress reconnect rather than give up quickly.
  if (xSemaphoreTake(wifiMutex, pdMS_TO_TICKS(3000)) == pdTRUE) {
    wifiMulti.addAP(e.ssid.c_str(), e.password.c_str());
    xSemaphoreGive(wifiMutex);
  } else {
    // Already safely saved to disk above either way -- this only means the
    // live add didn't happen THIS boot. connectWiFi() re-registers every
    // saved network with WiFiMulti on the next boot regardless, so nothing
    // is lost, it just won't be tried until then.
    Serial.println("Could not add '" + ssid + "' to WiFiMulti live (busy reconnecting) -- "
                    "saved to disk; it'll be tried starting next reboot.");
  }
  return WIFI_SAVE_ADDED;
}

// Removing always needs a restart to fully take effect (see the enum
// comment above), so this only updates storage -- the /wifi/remove handler
// is the one that decides to reboot. Refuses to remove the last remaining
// network so the device is never left with nothing to connect to.
bool removeWifiNetworkByIndex(int index, String& outRemovedSsid) {
  if (wifiNetworksMutex != NULL && xSemaphoreTake(wifiNetworksMutex, pdMS_TO_TICKS(1000)) != pdTRUE) {
    return false;
  }
  bool ok = false;
  if (index >= 0 && index < (int)wifiNetworks.size() && wifiNetworks.size() > 1) {
    WifiEntry removed = wifiNetworks[index];
    wifiNetworks.erase(wifiNetworks.begin() + index);
    if (saveWifiNetworksToDisk()) {
      ok = true;
      outRemovedSsid = removed.ssid;
      if (removed.ssid == preferredWifiSsid) {
        preferredWifiSsid = "";
        syncCodePrefs.putString("pref_ssid", "");
      }
    } else {
      wifiNetworks.insert(wifiNetworks.begin() + index, removed);
    }
  }
  if (wifiNetworksMutex != NULL) xSemaphoreGive(wifiNetworksMutex);
  return ok;
}

// =================================================================
// ---------------- Power-saving modes (Normal / Low / Medium / High) ----------------
// =================================================================

const char* powerModeName(PowerMode mode) {
  switch (mode) {
    case POWER_LOW:    return "low";
    case POWER_MEDIUM: return "medium";
    case POWER_HIGH:   return "high";
    default:           return "normal";
  }
}

const char* powerModeLabel(PowerMode mode) {
  switch (mode) {
    case POWER_LOW:    return "Low Power Saving";
    case POWER_MEDIUM: return "Medium Power Saving";
    case POWER_HIGH:   return "High Power Saving";
    default:           return "Normal (Off)";
  }
}

unsigned long effectiveReadUploadIntervalMs() {
  switch (powerMode) {
    case POWER_LOW:    return 120000UL; // 2 min
    case POWER_MEDIUM: return 300000UL; // 5 min
    case POWER_HIGH:   return 600000UL; // 10 min (queued locally while WiFi sleeps)
    default:           return READ_UPLOAD_INTERVAL_MS; // 60 s
  }
}

unsigned long effectiveWifiCheckIntervalMs() {
  switch (powerMode) {
    case POWER_LOW:    return 30000UL;  // 30 s
    case POWER_MEDIUM: return 60000UL;  // 60 s
    case POWER_HIGH:   return 10000UL;  // fast connect during the 60 s wake window
    default:           return WIFI_CHECK_INTERVAL_MS; // 10 s
  }
}

unsigned long effectiveDrainIntervalMs() {
  switch (powerMode) {
    case POWER_LOW:    return 10000UL;  // 10 s
    case POWER_MEDIUM: return 30000UL;  // 30 s
    case POWER_HIGH:   return 3000UL;   // drain rapidly during the 60 s wake window
    default:           return DRAIN_INTERVAL_MS; // 3 s
  }
}

bool uploadsAllowedNow() {
  return (powerMode != POWER_HIGH) || highPowerWifiAwake;
}

bool wifiCheckAllowedNow() {
  return (powerMode != POWER_HIGH) || highPowerWifiAwake;
}

void savePowerMode() {
  syncCodePrefs.putInt("power_mode", (int)powerMode);
}

void loadPowerMode() {
  int saved = syncCodePrefs.getInt("power_mode", (int)POWER_NORMAL);
  if (saved < (int)POWER_NORMAL || saved > (int)POWER_HIGH) saved = (int)POWER_NORMAL;
  powerMode = (PowerMode)saved;
  Serial.println("Power mode loaded: " + String(powerModeLabel(powerMode)));
}

// Applies hardware WiFi modem sleep + TX power settings for the current mode.
// Caller must hold wifiMutex (or be inside setup() before tasks start).
void applyWifiRadioProfileLocked(PowerMode mode) {
  switch (mode) {
    case POWER_NORMAL:
      esp_wifi_set_ps(WIFI_PS_NONE);
      WiFi.setTxPower(WIFI_POWER_19_5dBm);
      break;
    case POWER_LOW:
      esp_wifi_set_ps(WIFI_PS_MIN_MODEM);
      WiFi.setTxPower(WIFI_POWER_15dBm);
      break;
    case POWER_MEDIUM:
    case POWER_HIGH:
      esp_wifi_set_ps(WIFI_PS_MAX_MODEM);
      WiFi.setTxPower(WIFI_POWER_11dBm);
      break;
  }
}

void applyPowerMode(PowerMode newMode, bool publishStatus) {
  PowerMode prevMode = powerMode;
  powerMode = newMode;
  savePowerMode();

  // Bluetooth is unused -- ensure it stays off to save power.
  btStop();

  if (newMode != POWER_NORMAL) {
    digitalWrite(LED_PIN, LOW);
  }

  if (newMode == POWER_HIGH) {
    setCpuFrequencyMhz(POWER_SAVING_CPU_MHZ);
    // Let wifiMaintenanceTask (Core 0) publish status.json and cut WiFi cleanly
    // so Core 1's HTTP handler never stalls for a blocking HTTPS request.
    highPowerPendingSleep = true;
    if (publishStatus) statusPublishRequested = true;
    Serial.println("Power mode -> High Power Saving (80 MHz, WiFi sleeping for 30m after status publish).");
    return;
  }

  // Normal / Low / Medium: WiFi stays on with mode-appropriate modem sleep & TX power.
  highPowerPendingSleep = false;
  setCpuFrequencyMhz(newMode == POWER_NORMAL ? NORMAL_CPU_MHZ : POWER_SAVING_CPU_MHZ);
  highPowerWifiAwake = true;

  if (xSemaphoreTake(wifiMutex, pdMS_TO_TICKS(1500)) == pdTRUE) {
    if (prevMode == POWER_HIGH) {
      WiFi.mode(WIFI_STA);
      lastConnectedSSID = "";
    }
    applyWifiRadioProfileLocked(newMode);
    xSemaphoreGive(wifiMutex);
  } else if (prevMode == POWER_HIGH) {
    forceWifiSetupReset = true;
  }

  if (publishStatus) statusPublishRequested = true;
  Serial.println("Power mode -> " + String(powerModeLabel(newMode)));
}

String buildPowerSavingContentHtml() {
  String html;
  html += "<p><b>Current mode:</b> " + String(powerModeLabel(powerMode)) + "</p>";
  html += "<form id='modeForm'>";

  struct ModeInfo { PowerMode m; const char* val; const char* title; const char* desc; };
  const ModeInfo modes[4] = {
    { POWER_NORMAL, "normal", "Normal (Off)",
      "240 MHz CPU, WiFi modem sleep OFF, full TX power (19.5 dBm), 60 s reads, status LED on. Fastest web UI." },
    { POWER_LOW, "low", "Low Power Saving",
      "80 MHz CPU, WiFi min modem sleep, 15 dBm TX power, Bluetooth off, 2 min reads, LED off. Website stays fast and always reachable." },
    { POWER_MEDIUM, "medium", "Medium Power Saving",
      "80 MHz CPU, WiFi max modem sleep, 11 dBm TX power, Bluetooth off, 5 min reads, LED off. Lower idle draw; website stays reachable with slightly higher latency." },
    { POWER_HIGH, "high", "High Power Saving",
      "80 MHz CPU, Bluetooth off, 10 min reads queued to flash, LED off. WiFi turns OFF for 30 min then wakes for a 60 s sync &amp; web-UI window. Single-click the board BOOT button anytime to return to Normal immediately." }
  };

  for (int i = 0; i < 4; i++) {
    bool active = (powerMode == modes[i].m);
    html += "<label class='mode-card" + String(active ? " active" : "") + "'>";
    html += "<input type='radio' name='mode' value='" + String(modes[i].val) + "'" + (active ? " checked" : "") + "> ";
    html += "<span class='mode-title'>" + String(modes[i].title) + "</span>";
    html += "<div class='mode-meta'>" + String(modes[i].desc) + "</div>";
    html += "</label>";
  }

  html += "<input type='submit' value='Apply power mode'>";
  html += "</form>";
  return html;
}

// Runs forever on core 0. handleReadingCycle()
// and drainQueue() both make blocking HTTPClient calls (a stalled Firebase
// PUT can hang for the full HTTP timeout) and used to run inside loop() on
// core 1 -- the same core that debounces the button. A press-and-release
// landing entirely inside one of those calls was invisible to the edge
// detector, not delayed, just silently dropped. Moving them here mirrors
// why Ledger sync was already pulled off core 1. pending.txt/pending.tmp are
// now touched exclusively from this task (loop() no longer calls either
// function), so -- unlike SESSION_LOG_FILE -- no mutex is needed for them.
void sensorUploadTask(void* param) {
  bool firstReadDone                  = false;
  unsigned long lastReadUploadLocal   = 0;
  unsigned long lastDrainAttemptLocal = 0;

  vTaskDelay(pdMS_TO_TICKS(2000)); // let DHT22 stabilize after boot

  for (;;) {
    if (otaInProgress) {
      vTaskDelay(pdMS_TO_TICKS(500));
      continue;
    }

    unsigned long now = millis();

    unsigned long readInterval = firstReadDone ? effectiveReadUploadIntervalMs() : 10000UL;
    if (lastReadUploadLocal == 0 || (now - lastReadUploadLocal >= readInterval)) {
      if (timeSynced) firstReadDone = true;
      lastReadUploadLocal = now;
      handleReadingCycle();
    }

    if (!otaInProgress && (now - lastDrainAttemptLocal >= effectiveDrainIntervalMs())) {
      lastDrainAttemptLocal = now;
      if (uploadsAllowedNow() && WiFi.status() == WL_CONNECTED) {
        drainQueue(DRAIN_BATCH_SIZE);
      }
    }

    vTaskDelay(pdMS_TO_TICKS(500));
  }
}

// Runs forever on core 0, alongside ledgerUploadTask/sensorUploadTask. This
// USED TO be the tail end of loop() (core 1) -- but wifiMulti.run() and
// connectToAnyOpenNetwork() can each block for several seconds (scanning,
// connecting, or just waiting out WiFiMulti's own internal timeout), and
// loop() is also where the button gets debounced (handleSession()) and HTTP
// gets served (server.handleClient()). A press-and-release landing entirely
// inside one of those calls was invisible to the edge detector, not
// delayed, just silently dropped -- the exact failure mode already fixed
// once for sensor/ledger uploads (see sensorUploadTask's comment); it just
// never got applied to WiFi's own reconnect logic until now.
//
// wifiMutex guards this task's connect attempts against the other places
// that mutate live WiFi state from core 1 (addOrUpdateWifiNetwork()'s live
// wifiMulti.addAP(), and the WiFi.mode() flip in enterPowerSaving()/
// exitPowerSaving()) -- see wifiMutex's own comment up top for the full
// reasoning. Read-only status calls (WiFi.status()/SSID()/localIP()/RSSI(),
// used all over this file to build pages/JSON) stay lock-free -- safe from
// any core without one.
void wifiMaintenanceTask(void* param) {
  unsigned long lastCheckLocal = 0;
  // Two separate, complementary fixes for status.json getting stuck showing
  // a stale SSID/IP after the device actually changed networks -- see each
  // one at its own site below for the full reasoning:
  //
  // 1. The zombie-connection watchdog (right before wifiMulti.run() below)
  //    catches the actual root cause found in practice: WiFi.status() can
  //    keep reporting WL_CONNECTED to an AP that's already gone, so
  //    onNetworkConnected() never even sees a change to react to.
  //
  // 2. lastStatusPublishMs / STATUS_REPUBLISH_INTERVAL_MS below is a
  //    general safety net for a DIFFERENT failure: publishStatusToFirebase()
  //    itself has no retry (see its own comment) -- it's a single blocking
  //    HTTPS PUT, on purpose, so a bad connection can't stall this task's
  //    next check for multiple retries' worth of timeouts -- so if the
  //    one-shot call on a genuine SSID change fails for some transient
  //    reason (a fresh hotspot's DNS/routing not being ready for a second
  //    or two, say), this periodic republish catches it within
  //    STATUS_REPUBLISH_INTERVAL_MS instead of leaving it stuck until the
  //    next actual SSID change.
  //
  // Neither one makes the other redundant: (1) fixes the case where the
  // driver itself never notices anything changed; (2) fixes the case where
  // it does notice, but the one attempt that follows doesn't stick.
  unsigned long lastStatusPublishMs = 0;
  unsigned long lastZombieReconnectMs = 0;
  unsigned long lastPreferredScanMs = 0;
  int consecutiveNetFailures = 0;
  int consecutiveDisconnectTries = 0;
  unsigned long lastCmdPollMs = 0;

  for (;;) {
    vTaskDelay(pdMS_TO_TICKS(500));

    if (otaInProgress) continue;

    unsigned long now = millis();

    // Poll Firebase /cmd.json every 5s for instant remote Dashboard commands.
    if (WiFi.status() == WL_CONNECTED && (now - lastCmdPollMs >= 5000UL)) {
      lastCmdPollMs = now;
      pollAndHandleFirebaseCommand();
    }

    // Handle async status publish / High Power Saving sleep handoff requested from Core 1.
    if (statusPublishRequested) {
      statusPublishRequested = false;
      if (WiFi.status() == WL_CONNECTED) {
        publishStatusToFirebase();
        lastStatusPublishMs = now;
      }
    }
    if (highPowerPendingSleep && powerMode == POWER_HIGH) {
      highPowerPendingSleep = false;
      highPowerWifiAwake = false;
      highPowerSleepStartMs = now;
      if (xSemaphoreTake(wifiMutex, pdMS_TO_TICKS(1500)) == pdTRUE) {
        WiFi.mode(WIFI_OFF);
        lastConnectedSSID = "";
        lastPublishedIp = "";
        xSemaphoreGive(wifiMutex);
      }
      continue;
    }

    // High Power Saving duty-cycle: keep WiFi off for HIGH_POWER_SLEEP_MS, then
    // wake for HIGH_POWER_WAKE_WINDOW_MS so queued readings drain and the admin
    // website can be reached before turning WiFi back off.
    if (powerMode == POWER_HIGH) {
      if (!highPowerWifiAwake) {
        if (now - highPowerSleepStartMs < HIGH_POWER_SLEEP_MS) continue;
        if (xSemaphoreTake(wifiMutex, pdMS_TO_TICKS(1000)) == pdTRUE) {
          WiFi.mode(WIFI_STA);
          applyWifiRadioProfileLocked(POWER_HIGH);
          lastConnectedSSID = "";
          xSemaphoreGive(wifiMutex);
        }
        highPowerWifiAwake = true;
        highPowerWakeStartMs = now;
        lastCheckLocal = 0; // trigger immediate connect attempt
        Serial.println("High Power Saving: waking WiFi for 60s sync & web window.");
      } else if (now - highPowerWakeStartMs >= HIGH_POWER_WAKE_WINDOW_MS) {
        if (xSemaphoreTake(wifiMutex, pdMS_TO_TICKS(1000)) == pdTRUE) {
          WiFi.mode(WIFI_OFF);
          lastConnectedSSID = "";
          xSemaphoreGive(wifiMutex);
        }
        highPowerWifiAwake = false;
        highPowerSleepStartMs = now;
        Serial.println("High Power Saving: sync window done -- turning WiFi back off for 30m.");
        continue;
      }
    }
    unsigned long checkInterval = (WiFi.status() == WL_CONNECTED)
      ? effectiveWifiCheckIntervalMs()
      : 4000UL; // retry quickly (every 4s) while disconnected
    if (now - lastCheckLocal < checkInterval) continue;
    lastCheckLocal = now;

    if (xSemaphoreTake(wifiMutex, pdMS_TO_TICKS(1000)) != pdTRUE) continue;

    // Recover from a dropped connection, or a failed connect attempt at
    // boot. wifiMulti.run() handles reconnecting and switching to whichever
    // configured network currently has the best signal -- no manual
    // disconnect/reconnect needed. Only the reconnect ATTEMPT is gated by
    // wifiCheckAllowedNow() (§2.7.3, "OFF means no automatic reconnect") --
    // onNetworkConnected()/syncTimeSources() still run either way, since
    // they're just reflecting whatever the connection already is, not
    // attempting anything themselves.
    //
    // connectToAnyOpenNetwork() only runs when we're still not connected to
    // anything after that -- so a saved network already being connected (or
    // wifiMulti finding one) always wins, and this never interrupts an
    // existing connection just to look for something else.
    if (wifiCheckAllowedNow()) {
      // Zombie-connection watchdog, checked before wifiMulti.run() so a
      // positive hit gets retried in this very same cycle. WiFi.status()
      // == WL_CONNECTED only means the radio associated with an AP at SOME
      // point -- it does not mean that AP is still there. If a hotspot is
      // simply switched off (or swapped for a different one) rather than
      // the board walking out of range, the ESP32 WiFi driver commonly
      // never sees a deauth and just keeps reporting WL_CONNECTED to a
      // network that's actually gone, sometimes indefinitely. wifiMulti.run()
      // is a no-op whenever WiFi.status() already says connected, so a
      // zombie association like this was never retried on its own -- this,
      // not onNetworkConnected() or publishStatusToFirebase(), turned out to
      // be why the dashboard's SSID/IP got stuck on the old hotspot after
      // switching to a new one. (STATUS_REPUBLISH_INTERVAL_MS below checks
      // onNetworkConnected() and is still worth keeping -- it's a real
      // safety net for a publish that fails for some OTHER transient reason
      // -- but on its own it can't fix this specific case: republishing
      // more often doesn't help when WiFi.SSID()/WiFi.localIP() themselves
      // are still reporting the stale network, because the driver never
      // budged from WL_CONNECTED in the first place.)
      //
      // Detected via the existing sensor-upload heartbeat (putReading(),
      // already running every effectiveReadUploadIntervalMs()) instead of
      // adding a separate probe: uploads succeeding regularly is real
      // end-to-end proof the association is alive; three missed intervals
      // in a row while nominally connected isn't something an ordinary
      // transient Firebase/DNS hiccup explains. Explicitly re-checking
      // uploadsAllowedNow() here (independent from the wifiCheckAllowedNow()
      // gate we're already inside) excludes a WiFi-on power-saving session
      // with uploads paused, where lastFirebaseSuccessMillis wouldn't
      // advance for a reason unrelated to connectivity; != 0 excludes a
      // fresh boot that hasn't had a chance to succeed yet. WiFi.disconnect()
      // just drops the stale association -- wifiMulti.run() right below
      // then does a real scan-and-connect, exactly as if the AP had sent a
      // normal deauth to begin with.
      unsigned long zombieWindowMs = effectiveReadUploadIntervalMs() * 3;
      if (uploadsAllowedNow() && WiFi.status() == WL_CONNECTED &&
          lastFirebaseSuccessMillis != 0 &&
          (now - lastFirebaseSuccessMillis) > zombieWindowMs &&
          (lastZombieReconnectMs == 0 || (now - lastZombieReconnectMs) > zombieWindowMs)) {
        Serial.println("WiFi reports connected but uploads have failed for a while -- "
                        "forcing a clean reconnect in case the AP is actually gone.");
        lastZombieReconnectMs = now;
        WiFi.disconnect();
        lastConnectedSSID = "";  // force onNetworkConnected() to redo setup + republish once reconnected
      }

      if (WiFi.status() == WL_CONNECTED) {
        consecutiveDisconnectTries = 0;
      } else {
        // Every 3rd failed attempt, reset the STA driver to clear wedged
        // Android-hotspot / 4-way handshake states on ESP32.
        if (consecutiveDisconnectTries > 0 && (consecutiveDisconnectTries % 3) == 0) {
          Serial.println("Resetting WiFi STA state to clear stale association...");
          WiFi.disconnect(false, false);
          delay(150);
          WiFi.mode(WIFI_STA);
          applyWifiRadioProfileLocked(powerMode);
        }
        wifiMulti.run(6000);
        if (WiFi.status() == WL_CONNECTED) {
          consecutiveDisconnectTries = 0;
        } else {
          consecutiveDisconnectTries++;
          Serial.println("WiFi not connected (attempt " + String(consecutiveDisconnectTries) + ")...");
          // Give saved networks 2 clean tries before falling back to open WiFi
          if (consecutiveDisconnectTries >= 2) {
            if (connectToAnyOpenNetwork()) {
              consecutiveDisconnectTries = 0;
            }
          }
        }
      }

      // Preferred WiFi check: if connected to a different SSID, periodically scan
      // and switch over whenever the preferred saved network comes into range.
      if (WiFi.status() == WL_CONNECTED && (now - lastPreferredScanMs >= PREFERRED_WIFI_SCAN_INTERVAL_MS)) {
        String prefSsid, prefPass;
        bool hasPref = false;
        if (wifiNetworksMutex == NULL || xSemaphoreTake(wifiNetworksMutex, pdMS_TO_TICKS(500)) == pdTRUE) {
          if (preferredWifiSsid.length() > 0 && WiFi.SSID() != preferredWifiSsid) {
            for (size_t i = 0; i < wifiNetworks.size(); i++) {
              if (wifiNetworks[i].ssid == preferredWifiSsid) {
                prefSsid = wifiNetworks[i].ssid;
                prefPass = wifiNetworks[i].password;
                hasPref = true;
                break;
              }
            }
          }
          if (wifiNetworksMutex != NULL) xSemaphoreGive(wifiNetworksMutex);
        }

        if (hasPref) {
          lastPreferredScanMs = now;
          int n = WiFi.scanNetworks();
          bool foundPref = false;
          for (int i = 0; i < n; i++) {
            if (WiFi.SSID(i) == prefSsid && WiFi.RSSI(i) >= PREFERRED_WIFI_MIN_RSSI) {
              foundPref = true;
              break;
            }
          }
          WiFi.scanDelete();

          if (foundPref) {
            Serial.println("Preferred WiFi '" + prefSsid + "' is in range -- switching...");
            WiFi.disconnect();
            delay(100);
            if (prefPass.length() > 0) WiFi.begin(prefSsid.c_str(), prefPass.c_str());
            else WiFi.begin(prefSsid.c_str());
            int tries = 0;
            while (WiFi.status() != WL_CONNECTED && tries < 30) {
              delay(250);
              tries++;
            }
            lastConnectedSSID = ""; // trigger onNetworkConnected() setup + status.json publish
          }
        }
      }
    }
    bool justConnected = onNetworkConnected();
    syncTimeSources();

    xSemaphoreGive(wifiMutex);

    // Deliberately outside the lock above: publishStatusToFirebase() makes a
    // blocking HTTPS PUT that can take seconds under a bad connection, and
    // enterPowerSaving()/exitPowerSaving() (reachable straight from a button
    // press in handleSession(), core 1) need wifiMutex too -- holding it
    // through this call would let a slow/stalled Firebase request stall a
    // button press again, just via this mutex instead of via WiFi itself.
    //
    // justConnected fires the immediate, "be fresh right now" attempt on an
    // actual SSID change. The periodic branch is the safety net described
    // in this function's opening comment -- it deliberately does NOT skip
    // just because justConnected already fired this same iteration (the two
    // are mutually exclusive per iteration below only to avoid firing the
    // blocking PUT twice back-to-back for no reason, not because the
    // periodic one is redundant with it).
    unsigned long heartbeatMs = STATUS_REPUBLISH_INTERVAL_MS;
    if (powerMode == POWER_LOW)    heartbeatMs = 90000UL;
    if (powerMode == POWER_MEDIUM) heartbeatMs = 150000UL;

    if (justConnected) {
      lastZombieReconnectMs = now;
      if (publishStatusToFirebase()) {
        consecutiveNetFailures = 0;
      } else {
        consecutiveNetFailures++;
      }
      lastStatusPublishMs = now;
    } else if (WiFi.status() == WL_CONNECTED && (now - lastStatusPublishMs >= heartbeatMs)) {
      bool alive = checkInternetReachable() && publishStatusToFirebase();
      lastStatusPublishMs = now;
      if (alive) {
        consecutiveNetFailures = 0;
      } else {
        consecutiveNetFailures++;
        Serial.println("WiFi connected but internet check/heartbeat failed (" + String(consecutiveNetFailures) + "/2).");
        if (consecutiveNetFailures >= 2 && wifiCheckAllowedNow()) {
          Serial.println("No working internet on '" + WiFi.SSID() + "' -- disconnecting to look for a working network.");
          consecutiveNetFailures = 0;
          if (xSemaphoreTake(wifiMutex, pdMS_TO_TICKS(1000)) == pdTRUE) {
            WiFi.disconnect();
            lastConnectedSSID = "";
            lastPublishedIp = "";
            xSemaphoreGive(wifiMutex);
          }
        }
      }
    }
  }
}

// Physical BOOT button handler:
// - In any power-saving mode (Low/Medium/High): single click returns to Normal immediately.
// - In Normal mode: hold for 1 second to enter High Power Saving.
void handleButton() {
  bool rawPress = sessionButtonPressed();
  unsigned long now = millis();

  if (powerMode != POWER_NORMAL) {
    holdingForPowerSave = false;
    if (rawPress) {
      applyPowerMode(POWER_NORMAL, true);
    }
    return;
  }

  if (rawPress) {
    holdingForPowerSave = true;
    longPressStart = now;
    return;
  }

  if (holdingForPowerSave) {
    if (digitalRead(BUTTON_PIN) == LOW) {
      if (now - longPressStart >= LONG_PRESS_MS) {
        holdingForPowerSave = false;
        applyPowerMode(POWER_HIGH, true);
      }
    } else {
      holdingForPowerSave = false;
    }
  }
}

void setup() {
  Serial.begin(115200);
  delay(1000);
  dht.begin();

  btStop(); // Bluetooth is unused -- disable immediately to save power.

  wifiMutex         = xSemaphoreCreateMutex();
  tlsMutex          = xSemaphoreCreateMutex();
  wifiNetworksMutex = xSemaphoreCreateMutex();
  i2cMutex          = xSemaphoreCreateMutex();
  settingsMutex     = xSemaphoreCreateMutex();

  pinMode(LED_PIN, OUTPUT);
  digitalWrite(LED_PIN, LOW);

  // Try the RTC before anything else needs time. If it's present and has
  // been set before (not a brand-new, never-powered module -- see
  // rtcHasValidTime()), the system clock is correct from this line on, and
  // the session button works immediately below, with no WiFi/NTP wait at
  // all. If it's absent or not set yet, this falls through to exactly the
  // old NTP-only behavior -- see syncTimeSources() further down, which also
  // handles writing NTP's corrected time into the RTC once it's available,
  // either to set it for the first time or to correct its drift.
  rtcPresent = rtcBegin();
  rtcTimeValid = rtcPresent && rtcHasValidTime(); // cached for /health -- see its declaration
  if (rtcTimeValid) {
    time_t rtcEpoch = rtcGetEpoch();
    struct timeval tv = { .tv_sec = rtcEpoch, .tv_usec = 0 };
    settimeofday(&tv, nullptr);
    timeSynced = true;
    Serial.println("Time set from RTC (" + String((unsigned long)rtcEpoch) + ") -- system clock synced.");
  } else if (rtcPresent) {
    Serial.println("RTC found but not set yet -- waiting on NTP once WiFi connects, then will set it.");
  } else {
    Serial.println("No RTC found -- waiting on NTP once WiFi connects, same as before.");
  }

  // Try a normal mount first -- do NOT auto-format yet. Only safe to format
  // outright if this device has never had a working filesystem before (see
  // fsHasMountedBefore() above); otherwise a failed mount almost certainly
  // means real, saved data is sitting there corrupted, not absent, and
  // formatting would destroy it instead of recovering it.
  bool fsEverMountedBefore = fsHasMountedBefore();
  fsReady = LittleFS.begin(false);
  if (!fsReady) {
    if (!fsEverMountedBefore) {
      Serial.println("LittleFS: first-time setup, formatting...");
      fsReady = LittleFS.begin(true);
    } else {
      Serial.println("LittleFS: mount FAILED on a device that has mounted before -- "
                      "NOT auto-formatting to avoid wiping saved data. This boot is running on "
                      "in-RAM defaults (see /wifi -- it may be showing secrets.h's networks "
                      "instead of your saved ones). To force a clean reformat once you're sure "
                      "there's nothing worth recovering, POST to /filesystem/format (same login "
                      "as /wifi).");
    }
  }
  if (fsReady && !fsEverMountedBefore) markFsMountedOnce();

  syncCodePrefs.begin("roomlogger", /*readOnly=*/false);
  loadOtaCredentials();       // pulls in any login saved earlier via /credentials, else secrets.h defaults
  loadFirebaseSettings();     // pulls in any host/auth saved earlier via /firebase, else secrets.h defaults
  loadOpenNetworkSetting();   // pulls in the free-WiFi toggle saved earlier via /wifi, else defaults to ON
  loadWifiNetworksFromDisk(); // pulls in any networks saved via /wifi, else seeds from secrets.h
  loadPreferredWifi();
  loadOtaBinUrl();
  loadPowerMode();            // pulls in Normal / Low / Medium / High power mode

  pinMode(BUTTON_PIN, INPUT_PULLUP);

  setCpuFrequencyMhz(powerMode == POWER_NORMAL ? NORMAL_CPU_MHZ : POWER_SAVING_CPU_MHZ);

  Serial.println("Connecting to WiFi (" + String(wifiNetworks.size()) + " network(s) configured)...");
  connectWiFi();
  applyWifiRadioProfileLocked(powerMode);
  configTime(0, 0, "pool.ntp.org", "time.nist.gov");

  if (timeSynced) {
    wifiMulti.run(5000);
    Serial.println("RTC already provided the time -- connecting to WiFi in the background.");
  } else {
    // Each wifiMulti.run(6000) already scans and waits up to 6s; 2 tries (~12-15s)
    // is plenty at boot before handing off to wifiMaintenanceTask in the background.
    for (int attempt = 0; attempt < 2 && WiFi.status() != WL_CONNECTED; attempt++) {
      if (wifiMulti.run(6000) == WL_CONNECTED) break;
      delay(300);
      Serial.print(".");
    }
    if (WiFi.status() != WL_CONNECTED) {
      connectToAnyOpenNetwork();
    }
  }

  if (onNetworkConnected()) publishStatusToFirebase();
  syncTimeSources();

  if (WiFi.status() == WL_CONNECTED) {
    Serial.println();
    Serial.println("Connected to: " + WiFi.SSID());
    Serial.print("IP address: ");
    Serial.println(WiFi.localIP());
  } else {
    Serial.println();
    Serial.println("Not connected yet -- will keep retrying in the background.");
  }

  if (powerMode == POWER_HIGH) {
    // Give a 60 s reachable window on boot before turning WiFi off for 30 min.
    highPowerWifiAwake = true;
    highPowerWakeStartMs = millis();
    Serial.println("High Power Saving active -- WiFi will stay reachable for 60s, then sleep for 30m.");
  }

  server.on("/", HTTP_GET, []() {
    server.send(200, "text/plain",
      "ESP32 Room Logger is running.\n"
      "Manage WiFi networks: /wifi\n"
      "Change Firebase host/auth: /firebase\n"
      "Change dashboard login: /credentials\n"
      "Power saving: /power-saving\n"
      "OTA update: /update\n"
      "Device health: /health");
  });

  server.on("/health", HTTP_GET, []() {
    if (!requireAdminAuth()) return;

    server.sendHeader("Cache-Control", "no-store, must-revalidate");
    server.send(200, "text/html", healthPage);
  });

  server.on("/health/status", HTTP_GET, []() {
    if (!requireAdminAuth()) return;

    server.sendHeader("Cache-Control", "no-store, must-revalidate");
    server.send(200, "application/json", buildHealthStatusJson());
  });

  server.on("/wifi", HTTP_GET, []() {
    if (!requireAdminAuth()) return;

    String page = String(wifiPage);
    page.replace("%WIFI_ROWS%", buildWifiRowsHtml());
    page.replace("%PREFERRED_OPTIONS%", buildPreferredWifiOptionsHtml());
    server.sendHeader("Cache-Control", "no-store, must-revalidate");
    server.send(200, "text/html", page);
  });

  server.on("/wifi", HTTP_POST, []() {
    if (!requireAdminAuth()) return;

    if (!server.hasArg("ssid")) {
      return server.send(400, "text/plain", "Missing 'ssid' field.");
    }
    String ssid = server.arg("ssid");
    ssid.trim();
    String password = server.hasArg("password") ? server.arg("password") : "";
    String ip      = server.hasArg("ip")      ? server.arg("ip")      : "";
    String gateway = server.hasArg("gateway") ? server.arg("gateway") : "";
    String subnet  = server.hasArg("subnet")  ? server.arg("subnet")  : "";
    String dns     = server.hasArg("dns")     ? server.arg("dns")     : "";
    ip.trim(); gateway.trim(); subnet.trim(); dns.trim();

    WifiSaveResult result = addOrUpdateWifiNetwork(ssid, password, ip, gateway, subnet, dns);

    switch (result) {
      case WIFI_SAVE_INVALID:
        return server.send(400, "text/plain",
          "Invalid entry -- check the SSID (1-32 chars), password (blank or 8-63 chars), "
          "and that IP/Gateway/Subnet are either all filled in or all left blank.");
      case WIFI_SAVE_LIMIT_REACHED:
        return server.send(400, "text/plain",
          "Network list is full (" + String(MAX_WIFI_NETWORKS) + " max) -- remove one first.");
      case WIFI_SAVE_ADDED:
        Serial.println("WiFi network added via /wifi: " + ssid);
        return server.send(200, "text/plain", "Saved '" + ssid + "' -- the device will try it now.");
      case WIFI_SAVE_UPDATED:
        // Unlike a brand-new SSID, WiFiMulti has no way to update an entry
        // it's already holding -- see the WifiSaveResult comment above -- so
        // this one actually needs the restart the response text promises.
        Serial.println("WiFi network updated via /wifi: " + ssid);
        server.sendHeader("Connection", "close");
        server.send(200, "text/plain", "Saved '" + ssid + "' -- device is restarting to apply the change.");
        delay(500);
        ESP.restart();
        return;
    }
  });

  server.on("/wifi/status", HTTP_GET, []() {
    if (!requireAdminAuth()) return;

    server.sendHeader("Cache-Control", "no-store, must-revalidate");
    server.send(200, "application/json", buildWifiStatusJson());
  });

  server.on("/wifi/preferred", HTTP_POST, []() {
    if (!requireAdminAuth()) return;
    String ssid = server.hasArg("ssid") ? server.arg("ssid") : "";
    ssid.trim();
    if (!savePreferredWifi(ssid)) {
      return server.send(400, "text/plain", "Invalid SSID -- choose one of your saved networks or None.");
    }
    Serial.println("Preferred WiFi updated via /wifi/preferred: " + (ssid.length() ? ssid : String("(none)")));
    server.send(200, "text/plain", ssid.length()
      ? ("Saved -- board will automatically switch to '" + ssid + "' whenever it is in range.")
      : "Preferred WiFi cleared -- board will stay on whichever saved network it connects to.");
  });

  server.on("/wifi/open-fallback", HTTP_POST, []() {
    if (!requireAdminAuth()) return;

    bool enabled = server.hasArg("enabled") && server.arg("enabled") == "1";
    saveOpenNetworkSetting(enabled);

    Serial.println(String("Open-network fallback ") + (enabled ? "enabled" : "disabled") +
                    " via /wifi/open-fallback from " + server.client().remoteIP().toString());
    server.send(200, "text/plain", enabled
      ? "Saved -- if none of your saved networks are in range, the board will now join whichever "
        "open (password-free) network nearby has the strongest signal."
      : "Saved -- if none of your saved networks are in range, the board will now just stay "
        "disconnected instead of joining an open network you don't control.");
  });

  server.on("/wifi/remove", HTTP_POST, []() {
    if (!requireAdminAuth()) return;

    if (!server.hasArg("index")) {
      return server.send(400, "text/plain", "Missing 'index' field.");
    }
    int index = server.arg("index").toInt();
    String removedSsid;

    if (!removeWifiNetworkByIndex(index, removedSsid)) {
      return server.send(400, "text/plain",
        "Could not remove that network -- it may already be gone, or it's the only one left.");
    }

    Serial.println("WiFi network removed via /wifi/remove: " + removedSsid);
    server.sendHeader("Connection", "close");
    server.send(200, "text/plain", "Removed '" + removedSsid + "' -- device is restarting to apply the change.");

    delay(500);
    ESP.restart();
  });

  server.on("/filesystem/format", HTTP_POST, []() {
    if (!requireAdminAuth()) return;

    // Deliberate, explicit escape hatch for the "mount failed, NOT
    // auto-formatting" case in setup() above -- only reachable by someone
    // choosing to hit this on purpose, with the same login as everything
    // else here. Formats, then restarts so every piece of in-RAM state that
    // depends on the filesystem (the WiFi network list, the event/reading
    // queues) gets freshly re-initialized through the normal setup() path,
    // rather than trying to hand-reset all of it here.
    Serial.println("LittleFS: manual reformat requested via /filesystem/format from " +
                    server.client().remoteIP().toString());
    server.sendHeader("Connection", "close");
    server.send(200, "text/plain", "Reformatting and restarting...");
    delay(500);
    LittleFS.format();
    ESP.restart();
  });

  server.on("/credentials", HTTP_GET, []() {
    if (!requireAdminAuth()) return;

    server.sendHeader("Cache-Control", "no-store, must-revalidate");
    server.send(200, "text/html", credentialsPage);
  });

  server.on("/credentials", HTTP_POST, []() {
    if (!requireAdminAuth()) return;

    if (!server.hasArg("user") || !server.hasArg("pass")) {
      return server.send(400, "text/plain", "Missing 'user' or 'pass' field.");
    }
    String newUser = server.arg("user");
    newUser.trim();
    String newPass = server.arg("pass");

    if (!saveOtaCredentials(newUser, newPass)) {
      return server.send(400, "text/plain",
        "Invalid login -- username 1-64 chars, password 8-64 chars, no tabs/newlines in either.");
    }

    Serial.println("Dashboard login changed via /credentials from " + server.client().remoteIP().toString());
    server.send(200, "text/plain", "Saved. Use the new username/password next time you log in.");
  });

  server.on("/firebase", HTTP_GET, []() {
    if (!requireAdminAuth()) return;

    String page = String(firebasePage);
    page.replace("%FB_HOST%", htmlEscape(currentFirebaseHost));
    page.replace("%MASKED_FB_AUTH%", htmlEscape(maskFirebaseAuth(currentFirebaseAuth)));
    server.sendHeader("Cache-Control", "no-store, must-revalidate");
    server.send(200, "text/html", page);
  });

  server.on("/firebase", HTTP_POST, []() {
    if (!requireAdminAuth()) return;

    if (!server.hasArg("host")) {
      return server.send(400, "text/plain", "Missing 'host' field.");
    }
    String newHost = server.arg("host");
    newHost.trim();
    String authField = server.hasArg("auth") ? server.arg("auth") : "";
    bool clearAuth = server.hasArg("clear_auth") && server.arg("clear_auth") == "1";

    // Three distinct outcomes for the token, matching the form's own
    // options: an explicit new value, an explicit clear, or -- the common
    // case, just changing the host -- left alone entirely.
    String newAuth;
    if (clearAuth) {
      newAuth = "";
    } else if (authField.length() > 0) {
      newAuth = authField;
    } else {
      newAuth = currentFirebaseAuth;
    }

    if (!saveFirebaseSettings(newHost, newAuth)) {
      return server.send(400, "text/plain",
        "Invalid entry -- host must be a bare hostname[:port] (no https://, no path), "
        "auth token up to 256 chars with no spaces/slashes.");
    }

    Serial.println("Firebase settings changed via /firebase from " + server.client().remoteIP().toString());
    server.send(200, "text/plain",
      "Saved. Host is now: " + currentFirebaseHost + " -- auth token: " + maskFirebaseAuth(currentFirebaseAuth));
  });

  server.on("/power-saving", HTTP_GET, []() {
    if (!requireAdminAuth()) return;

    String page = String(powerSavingPage);
    page.replace("%CONTENT%", buildPowerSavingContentHtml());
    server.sendHeader("Cache-Control", "no-store, must-revalidate");
    server.send(200, "text/html", page);
  });

  server.on("/power-saving", HTTP_POST, []() {
    if (!requireAdminAuth()) return;

    String m = server.hasArg("mode") ? server.arg("mode") : "";
    PowerMode target;
    if (m == "normal")      target = POWER_NORMAL;
    else if (m == "low")    target = POWER_LOW;
    else if (m == "medium") target = POWER_MEDIUM;
    else if (m == "high")   target = POWER_HIGH;
    else {
      return server.send(400, "text/plain", "Invalid mode (expected normal, low, medium, or high).");
    }

    String msg;
    switch (target) {
      case POWER_NORMAL:
        msg = "Switched to Normal (Off) -- 240 MHz, WiFi modem sleep off, 60 s sensor reads.";
        break;
      case POWER_LOW:
        msg = "Switched to Low Power Saving -- 80 MHz, WiFi min modem sleep, 15 dBm TX, 2 min reads.";
        break;
      case POWER_MEDIUM:
        msg = "Switched to Medium Power Saving -- 80 MHz, WiFi max modem sleep, 11 dBm TX, 5 min reads.";
        break;
      case POWER_HIGH:
        msg = "Switched to High Power Saving -- 80 MHz, 10 min local reads, WiFi turning OFF now for 30 min (wakes 60 s every 30 min, or single-click BOOT button to exit immediately).";
        break;
    }

    server.send(200, "text/plain", msg);
    if (target == POWER_HIGH) delay(300); // let HTTP response flush before turning WiFi off
    applyPowerMode(target, true);
  });

  server.on("/update", HTTP_GET, []() {
    if (!requireAdminAuth()) return;
    String page = String(updatePage);
    page.replace("%OTA_BIN_URL%", htmlEscape(currentOtaBinUrl));
    page.replace("%OTA_SLOT_KB%", String((unsigned long)(ESP.getFreeSketchSpace() / 1024)));
    server.sendHeader("Cache-Control", "no-store, must-revalidate");
    server.send(200, "text/html", page);
  });

  server.on("/update", HTTP_POST,
    []() {
      if (!requireAdminAuth()) return;
      bool ok = !Update.hasError() && Update.isFinished();
      server.sendHeader("Connection", "close");
      server.send(ok ? 200 : 500, "text/plain",
        ok ? "Firmware flashed -- LED solid 5s, then restarting..." : ("Update failed: " + String(Update.errorString())));
      if (ok) {
        digitalWrite(LED_PIN, HIGH);
        delay(5000);
        ESP.restart();
      } else {
        digitalWrite(LED_PIN, LOW);
        otaInProgress = false;
      }
    },
    []() {
      if (!server.authenticate(currentOtaUser.c_str(), currentOtaPass.c_str())) return;
      HTTPUpload& upload = server.upload();
      if (upload.status == UPLOAD_FILE_START) {
        otaInProgress = true;
        otaLedState = true;
        otaLedLastToggleMs = millis();
        digitalWrite(LED_PIN, HIGH);
        Serial.println("OTA upload start: " + upload.filename);
        if (!Update.begin(UPDATE_SIZE_UNKNOWN)) {
          Serial.println("OTA begin failed: " + String(Update.errorString()));
        }
      } else if (upload.status == UPLOAD_FILE_WRITE) {
        serviceOtaLed();
        if (Update.write(upload.buf, upload.currentSize) != upload.currentSize) {
          Serial.println("OTA write failed: " + String(Update.errorString()));
        }
      } else if (upload.status == UPLOAD_FILE_END) {
        if (Update.end(true)) {
          Serial.println("OTA upload complete: " + String(upload.totalSize) + " bytes");
        } else {
          Serial.println("OTA end failed: " + String(Update.errorString()));
        }
      } else if (upload.status == UPLOAD_FILE_ABORTED) {
        Update.abort();
        digitalWrite(LED_PIN, LOW);
        otaInProgress = false;
      }
    }
  );

  server.on("/update-url", HTTP_POST, []() {
    if (!requireAdminAuth()) return;
    if (!server.hasArg("url")) {
      return server.send(400, "text/plain", "Missing 'url' field.");
    }
    String url = server.arg("url");
    url.trim();
    saveOtaBinUrl(url);

    server.setContentLength(CONTENT_LENGTH_UNKNOWN);
    server.sendHeader("Cache-Control", "no-store");
    server.sendHeader("Connection", "close");
    server.send(200, "text/plain", "");

    String err;
    otaStreamLog("[OTA] Request accepted -- starting pull update.");
    bool ok = performOtaFromUrl(url, err);
    server.sendContent(""); // finish chunked response

    if (ok) {
      digitalWrite(LED_PIN, HIGH);
      delay(5000);
      ESP.restart();
    }
  });

  const char* authHeaders[] = { "Authorization" };
  server.collectHeaders(authHeaders, 1);
  server.begin();

  // All three pinned to core 0, so a slow/stalled Firebase call, Ledger
  // upload, or WiFi reconnect attempt can never delay or eat a button press
  // -- loop() below (core 1) stays free-running for just
  // server.handleClient()/serviceLed()/handleSession(), nothing blocking.
  xTaskCreatePinnedToCore(sensorUploadTask, "sensorTask", 10240, NULL, 1, NULL, 0);
  xTaskCreatePinnedToCore(wifiMaintenanceTask, "wifiTask", 10240, NULL, 1, NULL, 0);
}

void loop() {
  if (restartWebServerRequested) {
    restartWebServerRequested = false;
    server.stop();
    server.begin();
    Serial.println("WebServer socket refreshed for current WiFi interface.");
  }
  server.handleClient();
  handleButton();
  retryRtcIfNeeded();
  delay(1); // yield to IDLE1 so Core 1's Task Watchdog is never starved

  // WiFi reconnect/retry logic used to live here -- moved to
  // wifiMaintenanceTask (core 0) so a slow reconnect attempt can never delay
  // a button press or an HTTP response. See that task's comment for why.
}