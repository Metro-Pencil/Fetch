  // ---------- constants ----------
  const PAGE_SIZE = 200;          // initial fetch size
  const MAX_FETCH_LIMIT = 50000;  // hard ceiling on how much history one session will pull in
  // Floor for the $key-ordered fallback query (see fetchReadingsPage()) --
  // wide enough to outrun every pre-RTC legacy reading's raw key even
  // though $key string-ordering ranks them above RTC-era keys, without
  // guessing at exactly how many legacy readings exist.
  const FALLBACK_KEY_LIMIT = 1500;
  const TARGET_POINTS = 400;      // rendered points per view before bucket-averaging kicks in.
                                   // ESP reads once every 60s, so this stays raw (1 pt/reading)
                                   // up to ~6-7h spans, and averages progressively harder beyond
                                   // that as the span grows — a day averages ~4 readings/pt, a
                                   // month ~130/pt, etc. (bucketize() below recomputes bucket
                                   // width from the current span every time, so it scales
                                   // automatically with whatever range or zoom level is visible).
  const DAY = 86400000;

  const RANGE_DEFS = {
    '30':   { type:'count',    n:30 },
    '1h':   { type:'duration', ms: 60*60*1000 },
    '24h':  { type:'duration', ms: 24*60*60*1000 },
    'today':{ type:'today' },
    '3d':   { type:'duration', ms: 3*DAY },
    '2w':   { type:'duration', ms: 14*DAY },
    '3mo':  { type:'duration', ms: 90*DAY },
    '1y':   { type:'duration', ms: 365*DAY },
    'all':  { type:'all' }
  };

  // ---------- state ----------
  const entriesByKey = new Map(); // key(number, device millis()) -> {key, temp, hum, epochMs}
  let sortedCache = null;
  let anchorNewestKey = null;
  let anchorNowMs = null;
  let noMoreHistory = false;
  let isFetchingOlder = false;
  let currentFetchLimit = PAGE_SIZE;
  let userHasInteracted = false;
  let latestReadingEpoch = null;
  let lastFetchOk = null;
  // sessionPeakKey / lastNewDataMs (v2.14.0) -- see the "restart detection"
  // block near fetchReadings() for why these are tracked separately from
  // anchorNewestKey/lastFetchOk.
  let sessionPeakKey = null;   // highest raw key seen in any LIVE poll so far
  let lastNewDataMs = null;    // wall-clock time we last saw a genuinely new reading
  let lastKnownPowerMode = 'normal'; // tracks status.json powerMode for smart staleness thresholds
  let lastKnownDeviceIp = '';
  let lastFetchedStatus = null;
  let latestBinUrl = '';

  function escapeHtml(str){
    return String(str == null ? '' : str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }
  function stalenessThresholdMs(){
    if (lastKnownPowerMode === 'low')    return 5 * 60 * 1000;   // 2 min read interval
    if (lastKnownPowerMode === 'medium') return 11 * 60 * 1000;  // 5 min read interval
    if (lastKnownPowerMode === 'high')   return 40 * 60 * 1000;  // 30 min WiFi wake cycle
    return 150 * 1000;                                           // 60 s normal interval
  }
  let chartTemp = null;
  let chartHum = null;
  let autoTimer = null;
  let viewChangeTimer = null;

  // weather overlay (v2.19.0) -- see the "weather overlay" section below
  // for the functions that use these.
  const WEATHER_RECENT_LIMIT_DAYS = 90; // stay under /forecast's 92-day past_days ceiling
  const WEATHER_MAX_POINTS = 400;       // matches TARGET_POINTS -- no need to out-render the sensor charts
  const WEATHER_REFRESH_MS = 10 * 60 * 1000; // don't re-hit the API more than once per 10min for "now"
  const WEATHER_COLOR = 'rgba(148,163,184,0.65)';
  const WEATHER_BG = 'rgba(148,163,184,0.06)';
  let weatherEnabled = false;
  let weatherLoc = null;          // { lat, lon } once resolved
  let weatherLocPromise = null;   // in-flight geolocation lookup, shared across callers
  let weatherCache = null;        // { lat, lon, fetchedAt, minMs, maxMs, temp:[{x,y}], hum:[{x,y}] }
  let weatherFetchPromise = null; // in-flight cache-extend fetch, so concurrent redraws don't double-fetch

  function getHost(){ return document.getElementById('fb-host').value.trim(); }

  function getSorted(){
    if (!sortedCache){
      sortedCache = [...entriesByKey.values()].sort((a, b) => a.key - b.key);
    }
    return sortedCache;
  }
  function invalidateSorted(){ sortedCache = null; if (typeof invalidateValidSorted === 'function') invalidateValidSorted(); }

  // "Latest" means most recent in REAL time (epochMs), not the reading
  // with the biggest raw counter value. Those two usually agree, but not
  // right after a restart: getValidSorted() is sorted by raw key, and a
  // still-cached pre-restart reading can carry a bigger key than anything
  // the new (post-restart) session has produced yet, even though it's
  // chronologically older. Picking sorted[last] would silently show that
  // stale reading as "current." Picking the max epochMs instead is correct
  // regardless of which session happens to have bigger raw keys.
  function latestEntry(){
    const sorted = getValidSorted();
    if (!sorted.length) return null;
    return sorted.reduce((latest, e) => (e.epochMs > latest.epochMs ? e : latest), sorted[0]);
  }

  // ---------- time formatting (all 12-hour, explicit AM/PM) ----------
  function formatClock(ms){
    return new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', hour12: true });
  }
  function formatDateShort(ms){
    return new Date(ms).toLocaleDateString([], { month: 'short', day: 'numeric' });
  }
  function formatDateYear(ms){
    return new Date(ms).toLocaleDateString([], { month: 'short', year: 'numeric' });
  }
  function formatFull(ms, withSeconds){
    const opts = { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true };
    if (withSeconds) opts.second = '2-digit';
    return new Date(ms).toLocaleString([], opts);
  }
  function timeAgo(ms){
    const s = Math.round(ms / 1000);
    if (s < 5) return 'just now';
    if (s < 60) return s + 's ago';
    const m = Math.round(s / 60);
    if (m < 60) return m + 'm ago';
    const h = Math.round(m / 60);
    if (h < 24) return h + 'h ago';
    return Math.round(h / 24) + 'd ago';
  }
  function startOfLocalDay(ms){
    const d = new Date(ms);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  }
  function xTickLabel(ms, spanMs){
    if (spanMs <= DAY * 120) return [formatDateShort(ms), formatClock(ms)];
    return formatDateYear(ms);
  }

  // ---------- day/night segmentation (for the axis strip below) ----------
  // Fixed local-time convention (6:00-18:00 = day) rather than real
  // sunrise/sunset — this is a room logger, not an ephemeris, and a fixed
  // split is enough to answer "was this stretch day or night" at a glance.
  const DAY_START_HOUR = 6;
  const DAY_END_HOUR = 18;
  function isDaytime(ms){
    const h = new Date(ms).getHours();
    return h >= DAY_START_HOUR && h < DAY_END_HOUR;
  }
  // Next local-clock instant strictly after ms where day/night flips.
  function nextDayNightBoundary(ms){
    const d = new Date(ms);
    const y = d.getFullYear(), mo = d.getMonth(), da = d.getDate();
    const at6 = new Date(y, mo, da, DAY_START_HOUR, 0, 0, 0).getTime();
    const at18 = new Date(y, mo, da, DAY_END_HOUR, 0, 0, 0).getTime();
    if (ms < at6) return at6;
    if (ms < at18) return at18;
    return new Date(y, mo, da + 1, DAY_START_HOUR, 0, 0, 0).getTime();
  }
  // Splits [minMs, maxMs] into contiguous {start, end, isDay} runs. At
  // short zoom this returns a single segment (still tells you day-vs-
  // night for the whole visible window); at wide zoom it alternates once
  // per 12h boundary. guard caps iterations against clock weirdness
  // (DST etc.) rather than looping forever.
  function dayNightSegments(minMs, maxMs){
    const segs = [];
    let cur = minMs, guard = 0;
    while (cur < maxMs && guard < 4000){
      guard++;
      const isDay = isDaytime(cur);
      let next = nextDayNightBoundary(cur);
      if (next > maxMs) next = maxMs;
      segs.push({ start: cur, end: next, isDay });
      if (next <= cur) break;
      cur = next;
    }
    return segs;
  }

  // ---------- connection status ----------
  function setConnState(state, detail){
    const led = document.getElementById('fb-led');
    const label = document.getElementById('conn-label');
    led.className = 'led ' + state;
    if (state === 'online') label.textContent = 'firebase reachable';
    else if (state === 'stale') label.textContent = 'no recent readings';
    else label.textContent = detail || 'firebase unreachable';
    if (typeof updateHeroConnDot === 'function') updateHeroConnDot(state);
  }

  // ---------- time anchoring ----------
  // The ESP32 keys each reading by millis() (or so the code originally
  // assumed) — time since it booted, not a real clock. There's no
  // wall-clock time on the device at all right now. Since readings only
  // ever get uploaded while online (near-real-time), we approximate real
  // time here: anchor the newest reading from the latest live fetch to
  // "now", and derive every other loaded reading's time from the key gap
  // to that anchor.
  //
  // That assumed the key gap IS the millisecond gap. Evidence says
  // otherwise: with a known 60s reading interval, ~1431 raw readings
  // (477 pts × ~3/pt) should span ~23.85 real hours, but were rendering
  // compressed into ~60-90 seconds — a ~1000x compression, the exact
  // signature of the firmware writing something like seconds-since-boot
  // while this code multiplied key gaps by 1 (treating them as already
  // being milliseconds). Rather than hardcode a guess at the real unit,
  // detectKeyScale() below measures the TYPICAL gap between consecutive
  // readings' keys and compares it to the known ~60s interval, so this
  // keeps working correctly even if the firmware's unit is something else
  // entirely (or changes later).
  //
  // Separately: a reboot resets the device's counter back to 0, so a
  // stored reading's raw key can no longer be trusted as "same continuous
  // counter as now" — a reading from an earlier, longer-running boot has
  // a key LARGER than the current session's newest key. Anchoring that
  // the same way as everything else would shove it into the future or
  // cluster it right next to real current data. There's no way to
  // recover an old-boot reading's true time from its key alone, so
  // rather than guess, anchorEpoch() excludes (null) any reading whose
  // key exceeds the current session's newest key.
  //
  // That handles an OLD session's leftover big keys once the anchor has
  // already moved on to a new session. It does not, by itself, get the
  // anchor to actually move on promptly: right after a restart, the new
  // session's keys start small and stay smaller than the old
  // anchorNewestKey for a while, so nothing here would trigger a
  // re-anchor on its own -- the anchor would stay pinned to the dead
  // session, and the live new readings would get anchored AS IF they
  // were still part of the old session's continuous count (see
  // sessionPeakKey / the "restart detection" block in fetchReadings(),
  // added in v2.14.0, for the piece that actually detects the reboot and
  // forces the anchor to move).
  //
  // A real fix for all of this means adding NTP sync in the firmware so
  // each reading carries its own true timestamp; everything here is a
  // best-effort mitigation on the data we're actually given.
  const KNOWN_INTERVAL_MS = 60 * 1000; // told directly: ESP reads once every 60s
  let keyScaleToMs = 1;
  let staleFromPriorBoot = 0; // count of readings currently excluded as pre-reboot/unplaceable

  // Median gap between consecutive (same-session) keys, compared against
  // the known real reading interval, snapped to the nearest power of 10 —
  // a firmware unit choice is always a clean multiple (1 for ms, 1000 for
  // seconds, etc.), so snapping avoids chasing noise in the raw ratio.
  // Negative/zero gaps (reboot boundaries) are excluded so they can't
  // skew the estimate.
  function detectKeyScale(sorted){
    const deltas = [];
    for (let i = 1; i < sorted.length; i++){
      const d = sorted[i].key - sorted[i - 1].key;
      if (d > 0) deltas.push(d);
    }
    if (!deltas.length) return 1;
    deltas.sort((a, b) => a - b);
    const median = deltas[Math.floor(deltas.length / 2)];
    if (median <= 0) return 1;
    const pow = Math.round(Math.log10(KNOWN_INTERVAL_MS / median));
    return Math.pow(10, Math.max(0, pow));
  }

  function anchorEpoch(key){
    // RTC-stamped reading: real Unix seconds, not a boot-relative counter.
    // parseEntries() already sets these entries' epochMs directly and this
    // function normally never gets called on them, but every call site is
    // guarded here too so this stays correct even if that ever changes.
    if (isAbsoluteKey(key)) return key * 1000;
    if (anchorNewestKey === null || key > anchorNewestKey) return null;
    return anchorNowMs - (anchorNewestKey - key) * keyScaleToMs;
  }
  function setAnchor(newestKey){
    // newestKey is always a relative (boot-counter) key — see
    // fetchReadings(), which computes it only from the non-absolute subset
    // of each poll. Absolute (RTC) entries already carry a real epochMs
    // from parseEntries() and must never be recomputed here, since running
    // them through the relative-counter formula below (which assumes every
    // key shares one continuous boot-relative counter) would compare a
    // real Unix timestamp against a small boot-relative number and produce
    // a nonsense date decades in the past.
    anchorNewestKey = newestKey;
    anchorNowMs = Date.now();
    keyScaleToMs = detectKeyScale(getSorted().filter(e => !isAbsoluteKey(e.key)));
    staleFromPriorBoot = 0;
    getSorted().forEach(e => {
      if (isAbsoluteKey(e.key)) return;
      e.epochMs = anchorEpoch(e.key);
      if (e.epochMs === null) staleFromPriorBoot++;
    });
  }

  // Entries with a null epochMs are from a boot session we can't place in
  // real time (see anchorEpoch() above) — every chart-facing code path
  // should read through this instead of the raw getSorted().
  // ---------- Gap shading toggle & Spike Quarantine system (v3.4.0) ----------
  const GAP_SHADING_LS = 'rl_show_gaps';
  const ANOMALY_VAULT_LS = 'rl_anomaly_quarantine';
  const ANOMALY_KEPT_LS = 'rl_anomaly_kept';
  const FB_AUTH_LS = 'rl_fb_auth_secret';
  const TEMP_SPIKE_DELTA = 5.0;    // °C sudden single-instant jump
  const HUM_SPIKE_DELTA  = 18.0;   // %RH sudden single-instant jump
  const NEIGHBOR_MAX_MS  = 20 * 60 * 1000;

  let showGapShading = true;
  try {
    const savedGap = localStorage.getItem(GAP_SHADING_LS);
    if (savedGap === '0') showGapShading = false;
  } catch(e) {}

  let anomalyVault = {};   // rawKey -> record
  let anomalyKept  = {};   // rawKey -> true
  try {
    anomalyVault = JSON.parse(localStorage.getItem(ANOMALY_VAULT_LS) || '{}') || {};
    anomalyKept  = JSON.parse(localStorage.getItem(ANOMALY_KEPT_LS)  || '{}') || {};
  } catch(e) { anomalyVault = {}; anomalyKept = {}; }

  function persistAnomalyState(){
    try {
      localStorage.setItem(ANOMALY_VAULT_LS, JSON.stringify(anomalyVault));
      localStorage.setItem(ANOMALY_KEPT_LS, JSON.stringify(anomalyKept));
    } catch(e) {}
  }

  function saveFbAuthSecret(){
    const el = document.getElementById('fb-auth-secret');
    if (!el) return;
    try { localStorage.setItem(FB_AUTH_LS, el.value.trim()); } catch(e) {}
  }

  function getFbAuthParam(){
    let sec = '';
    const el = document.getElementById('fb-auth-secret');
    if (el && el.value.trim()) sec = el.value.trim();
    else { try { sec = localStorage.getItem(FB_AUTH_LS) || ''; } catch(e) {} }
    return sec ? ('?auth=' + encodeURIComponent(sec)) : '';
  }

  function toggleGapShading(){
    const cb = document.getElementById('toggle-gaps');
    showGapShading = cb ? !!cb.checked : true;
    try { localStorage.setItem(GAP_SHADING_LS, showGapShading ? '1' : '0'); } catch(e) {}
    if (chartTemp && chartHum){
      chartTemp.update('none');
      chartHum.update('none');
    }
  }

  function scanAnomalies(rawValid){
    let changed = false;
    for (let i = 0; i < rawValid.length; i++){
      const cur = rawValid[i];
      const rk = String(cur.rawKey !== undefined ? cur.rawKey : cur.key);
      if (anomalyKept[rk]) continue;
      if (anomalyVault[rk] && anomalyVault[rk].status === 'deleted') continue;

      let reason = '';
      if (cur.temp < -10 || cur.temp > 65){
        reason = 'Out-of-range temperature (' + cur.temp.toFixed(1) + '°C)';
      } else if (cur.hum < 0 || cur.hum > 100){
        reason = 'Out-of-range humidity (' + cur.hum.toFixed(1) + '%)';
      } else if (i > 0 && i < rawValid.length - 1){
        const prev = rawValid[i - 1], next = rawValid[i + 1];
        const prevClose = (cur.epochMs - prev.epochMs) <= NEIGHBOR_MAX_MS;
        const nextClose = (next.epochMs - cur.epochMs) <= NEIGHBOR_MAX_MS;
        if (prevClose && nextClose){
          const dPrevT = Math.abs(cur.temp - prev.temp), dNextT = Math.abs(cur.temp - next.temp);
          const spanT  = Math.abs(next.temp - prev.temp);
          const dPrevH = Math.abs(cur.hum - prev.hum), dNextH = Math.abs(cur.hum - next.hum);
          const spanH  = Math.abs(next.hum - prev.hum);
          if (dPrevT >= TEMP_SPIKE_DELTA && dNextT >= TEMP_SPIKE_DELTA && spanT < TEMP_SPIKE_DELTA * 0.6){
            const baseT = (prev.temp + next.temp) / 2;
            const diffT = cur.temp - baseT;
            reason = 'Sudden temp spike (' + (diffT >= 0 ? '+' : '') + diffT.toFixed(1) + '°C for 1 reading)';
          } else if (dPrevH >= HUM_SPIKE_DELTA && dNextH >= HUM_SPIKE_DELTA && spanH < HUM_SPIKE_DELTA * 0.6){
            const baseH = (prev.hum + next.hum) / 2;
            const diffH = cur.hum - baseH;
            reason = 'Sudden humidity spike (' + (diffH >= 0 ? '+' : '') + diffH.toFixed(1) + '% for 1 reading)';
          }
        } else if (prevClose !== nextClose){
          // Point sits right on the edge of an offline gap: compare against its close neighbor!
          const nb = prevClose ? prev : next;
          const dt = cur.temp - nb.temp;
          const dh = cur.hum - nb.hum;
          if (Math.abs(dt) >= TEMP_SPIKE_DELTA){
            reason = 'Gap-edge temp spike (' + (dt >= 0 ? '+' : '') + dt.toFixed(1) + '°C vs adjacent ' + nb.temp.toFixed(1) + '°C)';
          } else if (Math.abs(dh) >= HUM_SPIKE_DELTA){
            reason = 'Gap-edge humidity spike (' + (dh >= 0 ? '+' : '') + dh.toFixed(1) + '% vs adjacent ' + nb.hum.toFixed(1) + '%)';
          }
        }
      } else if (i > 0 && i === rawValid.length - 1){
        const prev = rawValid[i - 1];
        if ((cur.epochMs - prev.epochMs) <= 5 * 60 * 1000){
          if (Math.abs(cur.temp - prev.temp) >= TEMP_SPIKE_DELTA * 2){
            reason = 'Extreme newest temp jump (' + prev.temp.toFixed(1) + '°C → ' + cur.temp.toFixed(1) + '°C)';
          } else if (Math.abs(cur.hum - prev.hum) >= HUM_SPIKE_DELTA * 1.75){
            reason = 'Extreme newest humidity jump (' + prev.hum.toFixed(1) + '% → ' + cur.hum.toFixed(1) + '%)';
          }
        }
      }

      if (reason && !anomalyVault[rk]){
        const prev = i > 0 ? rawValid[i - 1] : null;
        const next = i < rawValid.length - 1 ? rawValid[i + 1] : null;
        anomalyVault[rk] = {
          rawKey: rk,
          key: cur.key,
          epochMs: cur.epochMs,
          temp: cur.temp,
          hum: cur.hum,
          prevTemp: prev ? prev.temp : null,
          nextTemp: next ? next.temp : null,
          prevHum: prev ? prev.hum : null,
          nextHum: next ? next.hum : null,
          reason: reason,
          detectedAt: Date.now(),
          status: 'pending'
        };
        changed = true;
      }
    }
    if (changed) persistAnomalyState();
    renderAnomalyUI();
  }

  function renderAnomalyUI(){
    const banner = document.getElementById('anomaly-banner');
    const listEl = document.getElementById('anomaly-list');
    const titleEl = document.getElementById('anomaly-title');
    const vaultSum = document.getElementById('vault-summary');
    const vaultList = document.getElementById('vault-list');
    if (!banner || !listEl) return;

    const all = Object.values(anomalyVault).sort((a, b) => (b.epochMs || 0) - (a.epochMs || 0));
    const pending = all.filter(x => x.status === 'pending' && entriesByKey.has(Number(x.key)));
    const archived = all.filter(x => x.status !== 'pending');

    if (pending.length){
      banner.style.display = 'block';
      titleEl.innerHTML = '&#9888; ' + pending.length + ' sudden sensor spike' + (pending.length === 1 ? '' : 's') + ' quarantined — review before deleting';
      listEl.innerHTML = pending.map(item => {
        const ts = item.epochMs ? formatFull(item.epochMs, true) : ('key ' + item.rawKey);
        const nbT = (item.prevTemp !== null && item.nextTemp !== null)
          ? (' · neighbors ' + item.prevTemp.toFixed(1) + '°C / ' + item.nextTemp.toFixed(1) + '°C') : '';
        const safeKey = escapeHtml(String(item.rawKey));
        return '<div class="anomaly-item">' +
          '<div class="anomaly-info">' +
            '<b>' + item.temp.toFixed(1) + '°C · ' + item.hum.toFixed(1) + '%RH</b> <span style="color:var(--muted);">at ' + escapeHtml(ts) + '</span>' +
            '<div class="anomaly-sub">' + escapeHtml(item.reason) + escapeHtml(nbT) + '</div>' +
          '</div>' +
          '<div class="anomaly-actions">' +
            '<button type="button" class="btn-danger" data-anom-act="delete" data-raw-key="' + safeKey + '">Delete from Firebase</button>' +
            '<button type="button" class="btn-ghost" data-anom-act="keep" data-raw-key="' + safeKey + '">Keep</button>' +
          '</div>' +
        '</div>';
      }).join('');
    } else {
      banner.style.display = 'none';
      listEl.innerHTML = '';
    }

    if (vaultSum){
      vaultSum.textContent = 'Spike Quarantine Vault (' + all.length + ' saved · ' + pending.length + ' pending, ' + archived.length + ' archived)';
    }
    if (vaultList){
      if (!all.length){
        vaultList.innerHTML = '<div class="vault-meta">No spikes recorded yet.</div>';
      } else {
        vaultList.innerHTML = all.slice(0, 40).map(item => {
          const ts = item.epochMs ? formatFull(item.epochMs, true) : ('key ' + item.rawKey);
          const badge = item.status === 'deleted' ? 'DELETED' : (item.status === 'kept' ? 'KEPT' : 'PENDING');
          const safeKey = escapeHtml(String(item.rawKey));
          const restoreBtn = item.status === 'deleted'
            ? '<button type="button" class="btn-ghost" data-anom-act="restore" data-raw-key="' + safeKey + '">Restore</button>' : '';
          return '<div class="anomaly-item">' +
            '<div class="anomaly-info">' +
              '<b>[' + badge + ']</b> ' + item.temp.toFixed(1) + '°C · ' + item.hum.toFixed(1) + '%RH · ' + escapeHtml(ts) +
              '<div class="anomaly-sub">' + escapeHtml(item.reason) + ' (key ' + safeKey + ')</div>' +
            '</div>' +
            '<div class="anomaly-actions">' + restoreBtn + '</div>' +
          '</div>';
        }).join('');
      }
    }
  }

  async function deleteAnomalyFromFirebase(rawKey, skipRedraw){
    const host = getHost();
    const statusEl = document.getElementById('anomaly-status');
    if (!host) return false;
    try {
      const url = 'https://' + host + '/readings/' + encodeURIComponent(rawKey) + '.json' + getFbAuthParam();
      const res = await fetch(url, { method: 'DELETE', cache: 'no-store' });
      if (!res.ok){
        if (statusEl) statusEl.textContent = 'Delete failed (HTTP ' + res.status + '). If RTDB requires auth, add your Firebase DB secret in the Spike Quarantine Vault below.';
        return false;
      }
      entriesByKey.delete(Number(rawKey));
      invalidateSorted();
      if (anomalyVault[rawKey]){
        anomalyVault[rawKey].status = 'deleted';
        anomalyVault[rawKey].deletedAt = Date.now();
      }
      persistAnomalyState();
      if (statusEl) statusEl.textContent = 'Deleted spike ' + rawKey + ' from Firebase (archived in local Spike Vault).';
      if (!skipRedraw){
        renderAnomalyUI();
        applyRangeSelection();
      }
      return true;
    } catch(err){
      if (statusEl) statusEl.textContent = 'Delete error: ' + err.message;
      return false;
    }
  }

  async function deleteAllPendingAnomalies(){
    const pending = Object.values(anomalyVault).filter(x => x.status === 'pending' && entriesByKey.has(Number(x.key)));
    if (!pending.length) return;
    if (!confirm('Delete ' + pending.length + ' flagged spike(s) from Firebase? Their info stays archived in your local Spike Vault.')) return;
    let okCount = 0;
    for (const item of pending){
      if (await deleteAnomalyFromFirebase(item.rawKey, true)) okCount++;
    }
    const statusEl = document.getElementById('anomaly-status');
    if (statusEl) statusEl.textContent = 'Deleted ' + okCount + '/' + pending.length + ' spike(s) from Firebase (archived in local Spike Vault).';
    renderAnomalyUI();
    applyRangeSelection();
  }

  function keepAnomaly(rawKey){
    anomalyKept[rawKey] = true; invalidateValidSorted();
    if (anomalyVault[rawKey]) anomalyVault[rawKey].status = 'kept';
    persistAnomalyState();
    renderAnomalyUI();
    applyRangeSelection();
  }

  async function restoreAnomalyToFirebase(rawKey){
    const item = anomalyVault[rawKey];
    const host = getHost();
    if (!item || !host) return;
    try {
      const url = 'https://' + host + '/readings/' + encodeURIComponent(rawKey) + '.json' + getFbAuthParam();
      const body = JSON.stringify({ temp: item.temp, hum: item.hum, t: Math.round((item.epochMs || 0) / 1000) });
      const res = await fetch(url, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      anomalyKept[rawKey] = true; invalidateValidSorted();
      item.status = 'kept';
      entriesByKey.set(Number(rawKey), { key: Number(rawKey), rawKey: rawKey, temp: item.temp, hum: item.hum, epochMs: item.epochMs });
      invalidateSorted();
      persistAnomalyState();
      renderAnomalyUI();
      applyRangeSelection();
    } catch(err){
      alert('Restore failed: ' + err.message);
    }
  }

  function exportAnomalyVault(){
    const blob = new Blob([JSON.stringify(Object.values(anomalyVault), null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'room-logger-spike-vault.json';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  function clearResolvedVault(){
    for (const k of Object.keys(anomalyVault)){
      if (anomalyVault[k].status !== 'pending') delete anomalyVault[k];
    }
    persistAnomalyState();
    renderAnomalyUI();
  }

  let validSortedCache = null;
  let validSortedDirty = true;

  function invalidateValidSorted(){
    validSortedCache = null;
    validSortedDirty = true;
  }

  function refreshAnomalyScan(){
    const raw = getSorted().filter(e => typeof e.epochMs === 'number').sort((a, b) => a.epochMs - b.epochMs);
    scanAnomalies(raw);
    validSortedCache = raw.filter(e => {
      const rk = String(e.rawKey !== undefined ? e.rawKey : e.key);
      return !(anomalyVault[rk] && anomalyVault[rk].status === 'pending');
    });
    validSortedDirty = false;
    return validSortedCache;
  }

  function getValidSorted(){
    if (!validSortedDirty && validSortedCache) return validSortedCache;
    return refreshAnomalyScan();
  }

  // Delegated click handlers for anomaly list, vault list, and cloud WiFi list (safe against quotes/XSS)
  document.addEventListener('click', function(ev){
    const anomBtn = ev.target && ev.target.closest('[data-anom-act]');
    if (anomBtn){
      const act = anomBtn.getAttribute('data-anom-act');
      const rk = anomBtn.getAttribute('data-raw-key') || '';
      if (act === 'delete') deleteAnomalyFromFirebase(rk);
      else if (act === 'keep') keepAnomaly(rk);
      else if (act === 'restore') restoreAnomalyToFirebase(rk);
      return;
    }
    const wifiBtn = ev.target && ev.target.closest('[data-wifi-act]');
    if (wifiBtn){
      const act = wifiBtn.getAttribute('data-wifi-act');
      const ssid = wifiBtn.getAttribute('data-ssid') || '';
      if (act === 'pref') cloudSetPreferredWifi(ssid);
      else if (act === 'remove') cloudRemoveWifi(ssid);
      return;
    }
    const qBtn = ev.target && ev.target.closest('[data-cmdq-act]');
    if (qBtn){
      ev.stopPropagation();
      const act = qBtn.getAttribute('data-cmdq-act');
      const cid = qBtn.getAttribute('data-cmd-id') || '';
      if (act === 'cancel') cancelQueuedCmd(cid);
      else if (act === 'push-now') pushOfflineCmdNow(cid);
      else if (act === 'cloud-queue') queueOfflineInCloud(cid);
      else if (act === 'retry') retryHistoryCmd(cid);
    }
  });

  function appendAuthParam(url){
    const auth = getFbAuthParam();
    if (!auth) return url;
    return url + (url.includes('?') ? ('&' + auth.slice(1)) : auth);
  }

  async function fbGet(host, query){
    const url = appendAuthParam('https://' + host + '/readings.json?' + query);
    const res = await fetch(url, { cache: 'no-store' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return res.json();
  }

  // v2.17.0 — orderBy="t" (see the ABSOLUTE_EPOCH_THRESHOLD_S comment
  // below for why it replaced orderBy="$key") needs an ".indexOn": ["t"]
  // rule under /readings in Firebase's security rules. Without that rule,
  // Firebase doesn't just run the query unindexed and slow — it can flat
  // out reject it with HTTP 400, which is a much worse failure than the
  // bug this was fixing: an outright "fetch failed", not just wrong
  // timestamps. So this always tries the indexed-preferred "t" query
  // first, and transparently falls back to the old $key-ordered query
  // (widened past FALLBACK_KEY_LIMIT to outrun the string-ordering
  // problem — see the fetchOlderPage() comment) if that fails for any
  // reason. The app works either way; it's just more efficient once the
  // index rule is added. To add it, in the Firebase console under
  // Realtime Database -> Rules, merge in:
  //   { "rules": { "readings": { ".indexOn": ["t"] } } }
  //
  // Returns { data, limitUsed } rather than just data — limitUsed can be
  // BIGGER than the requested limit whenever the fallback engages (it's
  // widened to at least FALLBACK_KEY_LIMIT regardless of what was asked
  // for). Callers MUST use limitUsed, not the limit they passed in, to
  // update currentFetchLimit. Without that (this was a real bug, found
  // v2.18.0): every poll silently over-fetches while the index is
  // missing, but currentFetchLimit keeps tracking the small nominal
  // number -- so the first-ever "load older" call doubles from that
  // stale small number, asks for FEWER entries than are already cached,
  // gets zero new ones back, and permanently sets noMoreHistory = true
  // on the very first pan-to-the-edge, even with thousands of readings
  // still unloaded.
  async function fetchReadingsPage(host, limit){
    try {
      const data = await fbGet(host, 'orderBy=%22t%22&limitToLast=' + limit);
      return { data, limitUsed: limit };
    } catch (err) {
      console.warn('orderBy="t" query failed (' + err.message + '), falling back to $key ordering. ' +
        'Add {"rules":{"readings":{".indexOn":["t"]}}} to your Firebase rules to fix this properly.');
      const fallbackLimit = Math.max(limit, FALLBACK_KEY_LIMIT);
      const data = await fbGet(host, 'orderBy=%22$key%22&limitToLast=' + fallbackLimit);
      return { data, limitUsed: fallbackLimit };
    }
  }
  // v2.15.0 — the firmware got a real RTC. Readings logged since then carry
  // an actual Unix-seconds timestamp as their key (and a matching "t"
  // field) instead of "seconds since this boot". A real timestamp is
  // unmistakably NOT a boot-relative counter: continuous uptime would need
  // to run for 30+ years to reach a value in this range, so any key at or
  // above ABSOLUTE_EPOCH_THRESHOLD_S is real wall-clock time, full stop —
  // no anchoring, no guessing, no restart-detection heuristics apply to it.
  // Older, still-cached readings from before the RTC went in keep using
  // the relative-counter reconstruction below; the two are never mixed
  // into the same math. Threshold is Unix seconds for 2001-09-09, comfortably
  // below any realistic RTC-stamped reading and comfortably above any
  // realistic relative counter.
  const ABSOLUTE_EPOCH_THRESHOLD_S = 1e9;
  function isAbsoluteKey(key){
    return key >= ABSOLUTE_EPOCH_THRESHOLD_S;
  }
  function parseEntries(data){
    if (!data) return [];
    return Object.entries(data)
      .map(([key, v]) => {
        const k = Number(key);
        const e = { key: k, rawKey: key, temp: Number(v.temp), hum: Number(v.hum) };
        // RTC-stamped reading: epochMs is a known fact, not an estimate.
        // Set it now so it's never touched by the anchoring code below.
        if (isAbsoluteKey(k)) e.epochMs = k * 1000;
        return e;
      })
      .filter(e => !isNaN(e.key) && !isNaN(e.temp) && !isNaN(e.hum));
  }

