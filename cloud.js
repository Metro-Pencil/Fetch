  // ---------- device status (current IP/SSID, reported by the firmware) ----------
  // Added because mDNS's roomlogger.local turned out to be unreliable
  // across Android versions -- this reads status.json off the same RTDB
  // host instead, which the firmware writes on every (re)connect.
  //
  // Fire-and-forget from fetchReadings()'s perspective -- a failed status
  // fetch must never disturb the Graphs tab. On the Dashboard tab, though,
  // this IS the whole point, so (v2.20.0) failures are surfaced there via
  // dash-msg instead of swallowed silently the way this used to be.
  // status.ip now backs ten links -- every GET-able page the firmware
  // serves. v2.20.0 added /power-saving, /power-presets, /terminal,
  // /health, and the root index alongside the original five (/update,
  // /sync-code, /wifi, /credentials, /firebase). The two POST-only action
  // routes (/wifi/remove, /filesystem/format) are deliberately left off,
  // same as the firmware's own "/" index doesn't link them either --
  // they're not pages, just endpoints those pages' own forms submit to.
  const DEVICE_PAGES = [
    ['', 'Home', 'Index of every page this device serves'],
    ['wifi', 'WiFi Networks', 'Saved networks, static IP, open-network fallback'],
    ['firebase', 'Firebase', 'Realtime Database host and auth token'],
    ['credentials', 'Dashboard Login', 'Username/password for these admin pages'],
    ['power-saving', 'Power Saving', 'Switch between Normal, Low, Medium, and High power modes'],
    ['update', 'OTA Update', 'Flash compiled .bin from URL or manual upload'],
    ['health', 'Device Health', 'Firebase, RTC, DHT22, and active power mode status'],
    ['telemetry', 'Battery & WiFi Telemetry', 'Start voltage, uptime, crash log & WiFi connect tracker'],
  ];

  function isSafeHostOrIp(v){
    return typeof v === 'string' && /^[0-9a-zA-Z.:-]+$/.test(v);
  }

  function renderDeviceLinks(ip){
    const safeIp = isSafeHostOrIp(ip) ? ip : '';
    if (!safeIp){
      document.getElementById('dash-links').innerHTML = '';
      return;
    }
    document.getElementById('dash-links').innerHTML = DEVICE_PAGES.map(function(p){
      return '<a class="link-tile" href="http://' + encodeURI(safeIp) + '/' + p[0] + '" target="_blank" rel="noopener">' +
        '<div class="link-tile-name">' + escapeHtml(p[1]) + '</div>' +
        '<div class="link-tile-desc">' + escapeHtml(p[2]) + '</div>' +
        '</a>';
    }).join('');
  }

  function renderStatusUi(){
    const status = lastFetchedStatus;
    const dashMsg = document.getElementById('dash-msg');
    if (!status || !status.ip) return;

    const mode = (typeof status.powerMode === 'string' && status.powerMode)
      ? status.powerMode.toLowerCase()
      : (status.powerSavingActive ? 'low' : 'normal');
    lastKnownPowerMode = mode;

    // Use the freshest signal from EITHER status.lastSeen (45s heartbeat) OR
    // latestReadingEpoch (live DHT22 uploads). That way active uploads always
    // prove the board is ONLINE—even before flashing v3.2.0+ firmware—while a
    // genuinely dropped hotspot stops BOTH signals and flips to OFFLINE.
    const lastSeenSec = Number(status.lastSeen || 0);
    const heartbeatMs = lastSeenSec > 1e9 ? lastSeenSec * 1000 : 0;
    const readingMs   = (typeof latestReadingEpoch === 'number' && latestReadingEpoch > 1e12) ? latestReadingEpoch : 0;
    const bestSeenMs  = Math.max(heartbeatMs, readingMs);
    const ageMs       = bestSeenMs ? Math.max(0, Date.now() - bestSeenMs) : Infinity;

    const offlineWindowMs =
      mode === 'high'   ? 35 * 60 * 1000 :
      mode === 'medium' ?  7 * 60 * 1000 :
      mode === 'low'    ?  4 * 60 * 1000 :
                           2.5 * 60 * 1000;
    const validIp = isSafeHostOrIp(status.ip) && status.ip !== '0.0.0.0';
    const isOnline = validIp && status.internetOk !== false && (ageMs <= offlineWindowMs);

    const modeLabel = mode.charAt(0).toUpperCase() + mode.slice(1) + (mode === 'normal' ? '' : ' power save');
    const modeCls = mode === 'normal' ? 'ok' : 'warn';
    const fsBadge = (status.fsOk === false)
      ? '<span class="status-pill err">FS mount failed</span>'
      : '';

    document.getElementById('device-status-row').style.display = '';
    if (!isOnline){
      lastKnownDeviceIp = validIp ? status.ip : '';
      document.getElementById('device-status').innerHTML =
        '<span class="status-pill err" style="margin-left:0;">OFFLINE</span>' +
        (bestSeenMs
          ? ' · last seen ' + escapeHtml(timeAgo(ageMs)) + ' on <b>' + escapeHtml(status.ssid || 'unknown') + '</b>'
          : ' · waiting for first reading or heartbeat');
      if (validIp){
        renderDeviceLinks(status.ip);
        dashMsg.textContent = 'Device appears offline (last-known IP ' + status.ip + ' links remain available in Controls).';
      } else {
        renderDeviceLinks('');
        dashMsg.textContent = 'Device is currently offline.';
      }
      renderCloudPanelsIfChanged(status);
      updateOtaButtons();
      updateHeroOverview();
      return;
    }

    document.getElementById('device-status').innerHTML =
      '<span class="status-pill ok" style="margin-left:0;margin-right:6px;">ONLINE</span>' +
      'On <b>' + escapeHtml(status.ssid || 'unknown') + '</b>, at <b>' + escapeHtml(status.ip) + '</b>' +
      '<span class="status-pill ' + modeCls + '">' + escapeHtml(modeLabel) + '</span>' +
      fsBadge +
      ' · active ' + escapeHtml(timeAgo(ageMs));
    lastKnownDeviceIp = status.ip;
    if (window._lastRenderedLinkIp !== status.ip){
      renderDeviceLinks(status.ip);
      window._lastRenderedLinkIp = status.ip;
    }
    renderCloudPanelsIfChanged(status);
    updateOtaButtons();
    updateHeroOverview();
    dashMsg.textContent = '';
  }

  // ---------- Native Firebase Cloud Control Bridge (v3.9.2 — FIFO 4-Step Queue + Offline History) ----------
  const CMD_QUEUE_LS = 'rl_cmd_queue_v1';
  const CMD_HISTORY_LS = 'rl_cmd_history_v1';
  const CMD_HISTORY_MAX = 100;

  let cmdQueue = [];
  let cmdHistory = [];
  let activeCmdJob = null;
  let cmdSeqCounter = 0;
  let pendingCmdId = '';
  let pendingCmdStartMs = 0;
  let pendingCmdLabel = '';
  let cmdPollTimer = null;
  let cmdClockTimer = null;
  let cmdAutoHideTimer = null;
  let cmdNextTimer = null;
  let activeCmdSlotKey = 'home-actions';

  function loadCmdQueueAndHistory(){
    try {
      const q = JSON.parse(localStorage.getItem(CMD_QUEUE_LS) || '[]');
      if (Array.isArray(q)) cmdQueue = q.filter(j => j && j.payload && j.id);
    } catch(e) { cmdQueue = []; }
    try {
      const h = JSON.parse(localStorage.getItem(CMD_HISTORY_LS) || '[]');
      if (Array.isArray(h)) cmdHistory = h.filter(j => j && j.id).slice(0, CMD_HISTORY_MAX);
    } catch(e) { cmdHistory = []; }
  }

  function persistCmdQueueAndHistory(){
    try { localStorage.setItem(CMD_QUEUE_LS, JSON.stringify(cmdQueue)); } catch(e) {}
    try { localStorage.setItem(CMD_HISTORY_LS, JSON.stringify(cmdHistory.slice(0, CMD_HISTORY_MAX))); } catch(e) {}
  }

  function cmdStepStatesForStage(stage){
    if (stage === 'queued')     return ['', '', '', ''];
    if (stage === 'sending')    return ['active', '', '', ''];
    if (stage === 'sent')       return ['done', 'active', '', ''];
    if (stage === 'received')   return ['done', 'done', 'active', ''];
    if (stage === 'completed')  return ['done', 'done', 'done', 'done'];
    if (stage === 'error')      return ['done', 'done', 'err', 'err'];
    if (stage === 'send_error') return ['err', '', '', ''];
    if (stage === 'timeout')    return ['done', 'err', '', ''];
    return ['', '', '', ''];
  }

  function renderCmdJobCardHtml(job, isLive){
    const st = cmdStepStatesForStage(job.stage);
    const stepLabels = ['1 Firebase', '2 ESP Got', '3 Applied', '4 Done'];
    const cardCls =
      job.stage === 'completed' ? ' is-done' :
      (job.stage === 'error' || job.stage === 'send_error' || job.stage === 'timeout') ? ' is-err' :
      (isLive && job.stage !== 'queued') ? ' is-active' : '';
    const durStr = job.durationMs !== null && job.durationMs !== undefined
      ? ((job.durationMs / 1000).toFixed(1) + 's')
      : (job.startedAt ? (((Date.now() - job.startedAt) / 1000).toFixed(1) + 's') : 'Queued');
    const whenStr = job.createdAt ? formatFull(job.createdAt, true) : '';
    const actBtns = job.stage === 'queued'
      ? '<button type="button" class="btn-ghost cmd-q-btn-sm" data-cmdq-act="cancel" data-cmd-id="' + escapeHtml(job.id) + '">Cancel</button>'
      : (!isLive ? '<button type="button" class="btn-ghost cmd-q-btn-sm" data-cmdq-act="retry" data-cmd-id="' + escapeHtml(job.id) + '">Retry</button>' : '');

    return '<div class="cmd-q-item' + cardCls + '" data-cmd-job-id="' + escapeHtml(job.id) + '">' +
      '<div class="cmd-q-head">' +
        '<span>' + escapeHtml(job.label || (job.payload && job.payload.action) || 'Command') + '</span>' +
        '<span class="cmd-q-meta">' + escapeHtml(durStr) + (whenStr ? (' · ' + escapeHtml(whenStr)) : '') + '</span>' +
      '</div>' +
      '<div class="cmd-q-steps">' +
        stepLabels.map((lbl, idx) => '<div class="cmd-q-step ' + st[idx] + '">' + lbl + '</div>').join('') +
      '</div>' +
      '<div class="cmd-q-foot">' +
        '<span class="cmd-q-foot-msg">' + escapeHtml(job.detail || job.stage) + '</span>' +
        actBtns +
      '</div>' +
    '</div>';
  }

  function renderCmdQueueSection(){
    const pill = document.getElementById('cmd-queue-pill');
    const cntEl = document.getElementById('cmd-history-count');
    const activeList = document.getElementById('cmd-active-queue-list');
    const histList = document.getElementById('cmd-history-list');
    const qBadge = document.getElementById('cmd-stepper-qbadge');

    const pendingCount = cmdQueue.length;
    if (qBadge){
      if (pendingCount > 0){
        qBadge.style.display = 'inline-flex';
        qBadge.textContent = '+' + pendingCount + ' queued';
      } else {
        qBadge.style.display = 'none';
      }
    }

    if (pill){
      if (activeCmdJob){
        pill.textContent = pendingCount > 0 ? ('1 Running · ' + pendingCount + ' Queued') : '1 Running';
        pill.className = 'status-pill warn';
      } else if (pendingCount > 0){
        pill.textContent = pendingCount + ' Queued';
        pill.className = 'status-pill warn';
      } else {
        pill.textContent = 'Idle';
        pill.className = 'status-pill ok';
      }
    }
    if (cntEl){
      cntEl.textContent = cmdHistory.length + ' saved';
    }
    if (activeList){
      const liveItems = [];
      if (activeCmdJob) liveItems.push(renderCmdJobCardHtml(activeCmdJob, true));
      for (const qJob of cmdQueue) liveItems.push(renderCmdJobCardHtml(qJob, true));
      activeList.innerHTML = liveItems.length
        ? liveItems.join('')
        : '<div class="ota-meta" style="margin:0;">No active 4-step uploads. Tap the header above to view offline history.</div>';
    }
    if (histList){
      histList.innerHTML = cmdHistory.length
        ? cmdHistory.map(j => renderCmdJobCardHtml(j, false)).join('')
        : '<div class="ota-meta" style="margin:0;">No upload history recorded yet.</div>';
    }
  }

  function cancelQueuedCmd(id){
    const idx = cmdQueue.findIndex(j => j.id === id);
    if (idx < 0) return;
    const [removed] = cmdQueue.splice(idx, 1);
    removed.stage = 'error';
    removed.detail = 'Cancelled before upload';
    removed.finishedAt = Date.now();
    removed.durationMs = 0;
    cmdHistory.unshift(removed);
    if (cmdHistory.length > CMD_HISTORY_MAX) cmdHistory.length = CMD_HISTORY_MAX;
    persistCmdQueueAndHistory();
    renderCmdQueueSection();
    showToast('Cancelled queued command');
  }

  function retryHistoryCmd(id){
    const item = cmdHistory.find(j => j.id === id);
    if (!item || !item.payload) return;
    sendCloudCommand(Object.assign({}, item.payload), item.label, item.slotKey);
  }

  function resumeCmdQueueNow(){
    if (!activeCmdJob && cmdQueue.length > 0){
      processNextCmdQueue();
      showToast('Processing queued commands…');
    } else if (activeCmdJob){
      showToast('A command is already running');
    } else {
      showToast('Queue is empty');
    }
  }

  function exportCmdHistory(){
    const payload = { exportedAt: new Date().toISOString(), active: activeCmdJob, queue: cmdQueue, history: cmdHistory };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'room-logger-command-history.json';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  function clearCmdHistory(){
    if (!cmdHistory.length){ showToast('History is already empty'); return; }
    if (!confirm('Clear all ' + cmdHistory.length + ' saved offline upload history records?')) return;
    cmdHistory = [];
    persistCmdQueueAndHistory();
    renderCmdQueueSection();
    showToast('Upload history cleared');
  }

  function finalizeActiveCmdJob(finalStage, detailMsg){
    if (cmdPollTimer){ clearInterval(cmdPollTimer); cmdPollTimer = null; }
    if (cmdClockTimer){ clearInterval(cmdClockTimer); cmdClockTimer = null; }
    if (activeCmdJob){
      activeCmdJob.stage = finalStage;
      activeCmdJob.detail = detailMsg || activeCmdJob.detail;
      activeCmdJob.finishedAt = Date.now();
      activeCmdJob.durationMs = activeCmdJob.startedAt ? Math.max(0, activeCmdJob.finishedAt - activeCmdJob.startedAt) : 0;
      cmdHistory.unshift(activeCmdJob);
      if (cmdHistory.length > CMD_HISTORY_MAX) cmdHistory.length = CMD_HISTORY_MAX;
      activeCmdJob = null;
    }
    pendingCmdId = '';
    persistCmdQueueAndHistory();
    renderCmdQueueSection();
    if (cmdQueue.length > 0){
      clearTimeout(cmdNextTimer);
      cmdNextTimer = setTimeout(() => processNextCmdQueue(), 650);
    }
  }

  function setCloudCmdStatus(msg, cls){
    const el = document.getElementById('cloud-cmd-status');
    if (!el) return;
    el.textContent = msg || '';
    el.className = 'cloud-cmd-bar' + (cls ? (' ' + cls) : '');
  }

  function resolveCmdSlotEl(slotKey){
    if (typeof slotKey === 'string' && slotKey){
      const found = document.querySelector('.inline-cmd-slot[data-cmd-slot="' + slotKey + '"]');
      if (found) return found;
    }
    return document.querySelector('.inline-cmd-slot[data-cmd-slot="home-actions"]') || document.getElementById('cmd-stepper-fallback-host');
  }

  function mountStepperIntoSlot(slotKey){
    const box = document.getElementById('cmd-stepper');
    const slot = resolveCmdSlotEl(slotKey);
    if (!box || !slot) return;
    if (box.parentElement !== slot){
      slot.appendChild(box);
    }
    activeCmdSlotKey = slotKey || 'home-actions';
  }

  function dismissCmdStepper(){
    if (cmdAutoHideTimer){ clearTimeout(cmdAutoHideTimer); cmdAutoHideTimer = null; }
    if (!activeCmdJob){
      if (cmdPollTimer){ clearInterval(cmdPollTimer); cmdPollTimer = null; }
      if (cmdClockTimer){ clearInterval(cmdClockTimer); cmdClockTimer = null; }
    }
    const box = document.getElementById('cmd-stepper');
    if (box){
      box.classList.remove('show', 'is-done', 'is-err');
    }
  }

  function updateCmdStepper(stage, detailMsg){
    const box = document.getElementById('cmd-stepper');
    const titleEl = document.getElementById('cmd-stepper-title');
    const timeEl = document.getElementById('cmd-stepper-time');
    const footEl = document.getElementById('cmd-stepper-foot');
    const closeBtn = document.getElementById('cmd-stepper-close');
    if (!box) return;
    if (cmdAutoHideTimer){ clearTimeout(cmdAutoHideTimer); cmdAutoHideTimer = null; }

    box.classList.remove('is-done', 'is-err');
    box.classList.add('show');
    if (titleEl) titleEl.textContent = pendingCmdLabel || 'Applying Change';
    if (timeEl && pendingCmdStartMs){
      timeEl.textContent = ((Date.now() - pendingCmdStartMs) / 1000).toFixed(1) + 's';
    }
    if (footEl) footEl.textContent = detailMsg || '';
    if (closeBtn) closeBtn.style.display = (stage === 'error' || stage === 'send_error') ? 'inline-flex' : 'none';

    const s = [
      document.getElementById('cstep-1'),
      document.getElementById('cstep-2'),
      document.getElementById('cstep-3'),
      document.getElementById('cstep-4')
    ];
    const setSt = (el, cls, icon) => {
      if (!el) return;
      el.className = 'cmd-step' + (cls ? (' ' + cls) : '');
      const dot = el.querySelector('.cmd-step-dot');
      if (dot) dot.textContent = icon;
    };

    if (stage === 'sending'){
      setSt(s[0], 'active', '1'); setSt(s[1], '', '2'); setSt(s[2], '', '3'); setSt(s[3], '', '4');
    } else if (stage === 'sent'){
      setSt(s[0], 'done', '✓'); setSt(s[1], 'active', '2'); setSt(s[2], '', '3'); setSt(s[3], '', '4');
    } else if (stage === 'received'){
      setSt(s[0], 'done', '✓'); setSt(s[1], 'done', '✓'); setSt(s[2], 'active', '3'); setSt(s[3], '', '4');
    } else if (stage === 'completed'){
      setSt(s[0], 'done', '✓'); setSt(s[1], 'done', '✓'); setSt(s[2], 'done', '✓'); setSt(s[3], 'done', '✓');
      box.classList.add('is-done');
      if (cmdClockTimer){ clearInterval(cmdClockTimer); cmdClockTimer = null; }
      if (closeBtn) closeBtn.style.display = 'inline-flex';
      cmdAutoHideTimer = setTimeout(() => {
        dismissCmdStepper();
      }, 4500);
    } else if (stage === 'error'){
      setSt(s[0], 'done', '✓'); setSt(s[1], 'done', '✓'); setSt(s[2], 'err', '!'); setSt(s[3], 'err', '✕');
      box.classList.add('is-err');
      if (cmdClockTimer){ clearInterval(cmdClockTimer); cmdClockTimer = null; }
    } else if (stage === 'send_error'){
      setSt(s[0], 'err', '!'); setSt(s[1], '', '2'); setSt(s[2], '', '3'); setSt(s[3], '', '4');
      box.classList.add('is-err');
      if (cmdClockTimer){ clearInterval(cmdClockTimer); cmdClockTimer = null; }
    }
  }

  function fmtBytes(b){
    b = Number(b || 0);
    if (b < 1024) return b + ' B';
    if (b < 1024 * 1024) return (b / 1024).toFixed(1) + ' KB';
    return (b / (1024 * 1024)).toFixed(2) + ' MB';
  }

  // ---------- Battery Run & Telemetry UI (v3.9.2 — Separate Battery/WiFi + Start Voltage SOC) ----------
  const PACK_MAH_LS = 'rl_pack_mah';
  let lastBattTrackOn = false;
  let lastWifiTrackOn = false;

  function liionVoltageToPct(v){
    v = Number(v);
    if (!Number.isFinite(v) || v <= 0) return 100;
    const pts = [
      [3.00, 0], [3.30, 3], [3.50, 10], [3.65, 22], [3.75, 40],
      [3.85, 58], [3.95, 72], [4.05, 85], [4.15, 95], [4.20, 100]
    ];
    if (v <= pts[0][0]) return 0;
    if (v >= pts[pts.length - 1][0]) return 100;
    for (let i = 1; i < pts.length; i++){
      if (v <= pts[i][0]){
        const [v0, p0] = pts[i - 1], [v1, p1] = pts[i];
        return Math.round(p0 + ((v - v0) / (v1 - v0)) * (p1 - p0));
      }
    }
    return 100;
  }

  function getPackMah(){
    try {
      const v = Number(localStorage.getItem(PACK_MAH_LS));
      if (v >= 300 && v <= 20000) return v;
    } catch(e) {}
    return 2400;
  }

  function savePackMah(){
    const el = document.getElementById('pack-mah-input');
    if (!el) return;
    const v = Math.max(300, Math.min(20000, Number(el.value) || 2400));
    el.value = v;
    try { localStorage.setItem(PACK_MAH_LS, String(v)); } catch(e) {}
    if (lastFetchedStatus) renderTelemetryCard(lastFetchedStatus.telemetry, lastFetchedStatus.powerMode);
  }

  function fmtDurShort(sec){
    sec = Math.max(0, Math.floor(Number(sec || 0)));
    const d = Math.floor(sec / 86400);
    const h = Math.floor((sec % 86400) / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = sec % 60;
    if (d > 0) return d + 'd ' + h + 'h ' + m + 'm';
    if (h > 0) return h + 'h ' + m + 'm';
    if (m > 0) return m + 'm ' + s + 's';
    return s + 's';
  }

  function renderTelemetryCard(t, activePowerMode){
    const body = document.getElementById('cloud-telemetry-body');
    const bPill = document.getElementById('telem-batt-pill');
    const wPill = document.getElementById('telem-wifi-pill');
    const bBtn  = document.getElementById('btn-batt-toggle');
    const wBtn  = document.getElementById('btn-wifi-toggle');
    const vInp  = document.getElementById('start-volt-input');
    const vSoc  = document.getElementById('start-volt-soc');
    const hint  = document.getElementById('pack-usable-hint');
    const inp   = document.getElementById('pack-mah-input');

    const packMah = getPackMah();
    if (inp && document.activeElement !== inp) inp.value = packMah;
    const fullUsable5vMah = Math.round(packMah * (3.7 / 5.12) * 0.83);
    if (hint) hint.textContent = '~' + fullUsable5vMah + ' mAh usable @ 5.12V';
    if (!body) return;

    if (!t){
      if (bPill){ bPill.textContent = 'Update FW'; bPill.className = 'status-pill warn'; }
      if (wPill){ wPill.textContent = 'Update FW'; wPill.className = 'status-pill warn'; }
      body.innerHTML = '<div class="ota-meta">Flash v3.9.2 firmware to enable separate Battery/WiFi tracking &amp; manual start voltage.</div>';
      return;
    }

    lastBattTrackOn = (t.battEnabled !== undefined) ? !!t.battEnabled : !!t.enabled;
    lastWifiTrackOn = (t.wifiEnabled !== undefined) ? !!t.wifiEnabled : !!t.enabled;

    if (bPill){
      bPill.textContent = lastBattTrackOn ? 'Batt ON' : 'Batt Off';
      bPill.className = 'status-pill ' + (lastBattTrackOn ? 'ok' : 'warn');
    }
    if (wPill){
      wPill.textContent = lastWifiTrackOn ? 'WiFi ON' : 'WiFi Off';
      wPill.className = 'status-pill ' + (lastWifiTrackOn ? 'ok' : 'warn');
    }
    if (bBtn) bBtn.textContent = lastBattTrackOn ? 'Pause Battery' : 'Start Battery';
    if (wBtn) wBtn.textContent = lastWifiTrackOn ? 'Pause WiFi' : 'Start WiFi';

    const startV = Number(t.startVolts || 0);
    if (vInp && document.activeElement !== vInp && startV > 0){
      vInp.value = startV.toFixed(2);
    }
    const startPct = startV > 0 ? liionVoltageToPct(startV) : 100;
    if (vSoc){
      vSoc.textContent = startV > 0 ? ('Start: ' + startV.toFixed(2) + 'V (~' + startPct + '%)') : 'Not set (assumes 4.20V / 100%)';
    }

    const startUsableMah = fullUsable5vMah * (startPct / 100);
    const MA = { normal: 130, low: 72, medium: 57, high: 38 };
    const modeTotalSec = (t.normalSec || 0) + (t.lowSec || 0) + (t.mediumSec || 0) + (t.highSec || 0);
    const usedMah =
      ((t.normalSec || 0) / 3600) * MA.normal +
      ((t.lowSec    || 0) / 3600) * MA.low +
      ((t.mediumSec || 0) / 3600) * MA.medium +
      ((t.highSec   || 0) / 3600) * MA.high;
    const remMah = Math.max(0, startUsableMah - usedMah);
    const pctLeft = Math.max(0, Math.min(100, Math.round((remMah / Math.max(1, fullUsable5vMah)) * 100)));
    const avgMa = (modeTotalSec > 0) ? (usedMah / (modeTotalSec / 3600)) : 0;
    const curMode = String(activePowerMode || 'normal').toLowerCase();
    const curDraw = MA[curMode] || MA.normal;
    const remHours = remMah / curDraw;

    const wifiTotal = (t.wifiConnSec || 0) + (t.wifiDiscSec || 0);
    const wifiPct = wifiTotal > 0 ? Math.max(0, Math.min(100, Math.round(((t.wifiConnSec || 0) / wifiTotal) * 100))) : null;
    const wifiBarScale = wifiPct !== null ? (wifiPct / 100) : 0;
    const avgConnStr = t.avgWifiConnMs ? ((t.avgWifiConnMs / 1000).toFixed(1) + 's') : '—';

    let resetRowsHtml = '';
    if (t.resetLog){
      const items = String(t.resetLog).split('|').filter(Boolean);
      resetRowsHtml = '<div class="telem-reset-list">' + items.map(entry => {
        const parts = entry.split('@');
        const reason = parts[0] || 'Unknown';
        const ep = Number(parts[1] || 0);
        const when = ep > 1600000000 ? formatFull(ep * 1000, true) : 'pre-NTP';
        return '<div class="telem-reset-item"><span>' + escapeHtml(reason) + '</span><span>' + escapeHtml(when) + '</span></div>';
      }).join('') + '</div>';
    }

    // Preserve user-expanded state & reset log <details> open state across live updates
    const prevBattOpen = !!body.querySelector('[data-telem-block="batt"].is-expanded');
    const prevWifiOpen = !!body.querySelector('[data-telem-block="wifi"].is-expanded');
    const prevResetOpen = !!body.querySelector('details[data-telem-reset][open]');

    body.innerHTML =
      '<div class="storage-block expandable-inner' + (prevBattOpen ? ' is-expanded' : '') + '" data-telem-block="batt" onclick="event.stopPropagation(); toggleInnerDetail(event, this)">' +
        '<div class="storage-row-head"><span>Estimated Battery Remaining</span>' +
        '<span class="storage-row-val">' + pctLeft + '% · ~' + remHours.toFixed(1) + 'h left (' + escapeHtml(curMode) + ')</span></div>' +
        '<div class="storage-track"><div class="storage-fill ram" style="transform:scaleX(' + (pctLeft / 100).toFixed(3) + ')"></div></div>' +
        '<div class="inner-detail-drawer"><div class="inner-detail-content">' +
          '<div class="storage-sub-grid">' +
            '<div class="storage-mini"><div class="storage-mini-label">Start → Est. Now</div><div class="storage-mini-val">' + (startV > 0 ? (startV.toFixed(2) + 'V (' + startPct + '%)') : '100%') + ' → ' + pctLeft + '%</div></div>' +
            '<div class="storage-mini"><div class="storage-mini-label">Tracked Run Uptime</div><div class="storage-mini-val">' + fmtDurShort(t.sessionUptimeSec) + '</div></div>' +
            '<div class="storage-mini"><div class="storage-mini-label">Current Boot Uptime</div><div class="storage-mini-val">' + fmtDurShort(t.bootUptimeSec) + '</div></div>' +
            '<div class="storage-mini"><div class="storage-mini-label">Est. Used / Avg Draw</div><div class="storage-mini-val">' + Math.round(usedMah) + ' mAh · ' + (avgMa ? Math.round(avgMa) + ' mA' : '—') + '</div></div>' +
            '<div class="storage-mini"><div class="storage-mini-label">Normal / Low</div><div class="storage-mini-val">' + fmtDurShort(t.normalSec) + ' / ' + fmtDurShort(t.lowSec) + '</div></div>' +
            '<div class="storage-mini"><div class="storage-mini-label">Medium / High</div><div class="storage-mini-val">' + fmtDurShort(t.mediumSec) + ' / ' + fmtDurShort(t.highSec) + '</div></div>' +
            '<div class="storage-mini span-full"><div class="storage-mini-label">Boots / Crashes</div><div class="storage-mini-val">' + (Number(t.bootCount) || 0) + ' / ' + (Number(t.crashCount) || 0) + ' (' + escapeHtml(t.lastReset || '—') + ')</div></div>' +
          '</div>' +
          (resetRowsHtml ? ('<details class="ota-details" data-telem-reset' + (prevResetOpen ? ' open' : '') + ' style="margin-top:10px;padding-top:8px;" onclick="event.stopPropagation()"><summary>Recent Reset &amp; Crash Log</summary>' + resetRowsHtml + '</details>') : '') +
        '</div></div>' +
      '</div>' +
      '<div class="storage-block expandable-inner' + (prevWifiOpen ? ' is-expanded' : '') + '" data-telem-block="wifi" onclick="event.stopPropagation(); toggleInnerDetail(event, this)">' +
        '<div class="storage-row-head"><span>WiFi Connection Telemetry</span>' +
        '<span class="storage-row-val">' + (wifiPct !== null ? ('Up ' + wifiPct + '%') : 'No data') + ' · avg join ' + avgConnStr + '</span></div>' +
        '<div class="storage-track"><div class="storage-fill fs" style="transform:scaleX(' + wifiBarScale.toFixed(3) + ')"></div></div>' +
        '<div class="inner-detail-drawer"><div class="inner-detail-content">' +
          '<div class="storage-sub-grid">' +
            '<div class="storage-mini"><div class="storage-mini-label">WiFi Connected</div><div class="storage-mini-val">' + fmtDurShort(t.wifiConnSec) + '</div></div>' +
            '<div class="storage-mini"><div class="storage-mini-label">WiFi Disconnected</div><div class="storage-mini-val">' + fmtDurShort(t.wifiDiscSec) + '</div></div>' +
            '<div class="storage-mini"><div class="storage-mini-label">Total Joins</div><div class="storage-mini-val">' + (Number(t.wifiReconnects) || 0) + '</div></div>' +
            '<div class="storage-mini"><div class="storage-mini-label">Avg Join Speed</div><div class="storage-mini-val">' + avgConnStr + '</div></div>' +
          '</div>' +
        '</div></div>' +
      '</div>';
  }

  function parseValidatedStartVoltage(required){
    const vStr = (document.getElementById('start-volt-input')?.value || '').trim();
    if (!vStr) return required ? null : '';
    const v = Number(vStr);
    if (!Number.isFinite(v) || v < 2.5 || v > 4.5){
      showToast('Voltage must be between 2.50 and 4.50 V');
      return null;
    }
    return v.toFixed(2);
  }

  function cloudToggleBatteryTrack(){
    const nextEn = !lastBattTrackOn;
    const payload = { action: 'setBatteryTrack', enabled: nextEn ? '1' : '0' };
    if (nextEn){
      const v = parseValidatedStartVoltage(false);
      if (v === null) return;
      if (v) payload.startVolts = v;
    }
    sendCloudCommand(payload, nextEn ? 'Starting battery run tracking…' : 'Pausing battery run tracking…', 'telemetry-control');
  }

  function cloudSaveStartVoltage(){
    const v = parseValidatedStartVoltage(true);
    if (!v) return;
    sendCloudCommand({ action: 'setStartVoltage', startVolts: v }, 'Saving start voltage (' + v + 'V)…', 'telemetry-control');
  }

  function cloudResetBatteryTrack(){
    if (!confirm('Reset battery uptime, power-mode time, and boot/crash counters to 0?')) return;
    const v = parseValidatedStartVoltage(false);
    if (v === null) return;
    const payload = { action: 'resetBatteryTrack' };
    if (v) payload.startVolts = v;
    sendCloudCommand(payload, 'Resetting battery run counters…', 'telemetry-control');
  }

  function cloudToggleWifiTrack(){
    const nextEn = !lastWifiTrackOn;
    sendCloudCommand({ action: 'setWifiTrack', enabled: nextEn ? '1' : '0' }, nextEn ? 'Starting WiFi duration tracking…' : 'Pausing WiFi duration tracking…', 'telemetry-control');
  }

  function cloudResetWifiTrack(){
    if (!confirm('Reset WiFi connected/disconnected durations and join stats to 0?')) return;
    sendCloudCommand({ action: 'resetWifiTrack' }, 'Resetting WiFi tracking counters…', 'telemetry-control');
  }

  function renderStorageCard(st){
    const body = document.getElementById('cloud-storage-body');
    const sumEl = document.getElementById('system-minimal-summary');
    if (!body) return;
    if (!st){
      body.innerHTML = '<div class="ota-meta">Flash v3.6.0+ firmware to see live Flash, LittleFS, Queue, and RAM usage.</div>';
      if (sumEl) sumEl.textContent = 'Waiting for telemetry…';
      return;
    }
    const appPct = st.otaSlotKb ? Math.min(100, Math.round((st.sketchKb / st.otaSlotKb) * 100)) : 0;
    const appFree = Math.max(0, (st.otaSlotKb || 0) - (st.sketchKb || 0));
    const fsTotal = st.fsTotalBytes || 0;
    const fsUsed  = st.fsUsedBytes || 0;
    const fsPct   = fsTotal ? Math.min(100, Math.round((fsUsed / fsTotal) * 100)) : 0;
    const otherFs = Math.max(0, fsUsed - (st.pendingBytes || 0) - (st.wifiBytes || 0));
    const ramTotal = st.heapTotalKb || 0;
    const ramUsed  = Math.max(0, ramTotal - (st.heapFreeKb || 0));
    const ramPct   = ramTotal ? Math.min(100, Math.round((ramUsed / ramTotal) * 100)) : 0;

    if (sumEl){
      sumEl.textContent = 'Flash ' + appPct + '% · FS ' + fsPct + '% · RAM ' + ramPct + '%';
    }

    const expFlash = !!body.querySelector('[data-st-block="flash"].is-expanded');
    const expFs    = !!body.querySelector('[data-st-block="fs"].is-expanded');
    const expRam   = !!body.querySelector('[data-st-block="ram"].is-expanded');
    const maxAllocTile = st.heapMaxAllocKb !== undefined
      ? '<div class="storage-mini"><div class="storage-mini-label">Max Contiguous Block</div><div class="storage-mini-val">' + Number(st.heapMaxAllocKb) + ' KB</div></div>'
      : '';

    body.innerHTML =
      '<div class="storage-block expandable-inner' + (expFlash ? ' is-expanded' : '') + '" data-st-block="flash" onclick="toggleInnerDetail(event, this)">' +
        '<div class="storage-row-head"><span>Firmware Flash</span>' +
        '<span class="storage-row-val">' + appPct + '% · ' + Number(st.sketchKb || 0) + '/' + Number(st.otaSlotKb || 0) + ' KB</span></div>' +
        '<div class="storage-track"><div class="storage-fill" style="transform:scaleX(' + (appPct / 100).toFixed(3) + ')"></div></div>' +
        '<div class="inner-detail-drawer"><div class="inner-detail-content">' +
          '<div class="storage-sub-grid">' +
            '<div class="storage-mini"><div class="storage-mini-label">Active Firmware</div><div class="storage-mini-val">' + Number(st.sketchKb || 0) + ' KB</div></div>' +
            '<div class="storage-mini"><div class="storage-mini-label">OTA Headroom</div><div class="storage-mini-val">' + appFree + ' KB free</div></div>' +
            '<div class="storage-mini"><div class="storage-mini-label">Total Flash</div><div class="storage-mini-val">' + (Number(st.flashKb) || 4096) + ' KB (A/B)</div></div>' +
          '</div>' +
        '</div></div>' +
      '</div>' +
      '<div class="storage-block expandable-inner' + (expFs ? ' is-expanded' : '') + '" data-st-block="fs" onclick="toggleInnerDetail(event, this)">' +
        '<div class="storage-row-head"><span>LittleFS Storage</span>' +
        '<span class="storage-row-val">' + fsPct + '% · ' + fmtBytes(fsUsed) + '/' + fmtBytes(fsTotal) + '</span></div>' +
        '<div class="storage-track"><div class="storage-fill fs" style="transform:scaleX(' + (fsPct / 100).toFixed(3) + ')"></div></div>' +
        '<div class="inner-detail-drawer"><div class="inner-detail-content">' +
          '<div class="storage-sub-grid">' +
            '<div class="storage-mini"><div class="storage-mini-label">Offline Queue (/pending.txt)</div><div class="storage-mini-val">' + fmtBytes(st.pendingBytes) + ' (' + (Number(st.pendingCount) || 0) + ' rows)</div></div>' +
            '<div class="storage-mini"><div class="storage-mini-label">Saved WiFi (/wifi_networks.txt)</div><div class="storage-mini-val">' + fmtBytes(st.wifiBytes) + '</div></div>' +
            '<div class="storage-mini"><div class="storage-mini-label">FS Overhead / Other</div><div class="storage-mini-val">' + fmtBytes(otherFs) + '</div></div>' +
            '<div class="storage-mini"><div class="storage-mini-label">Queue Safety Cap</div><div class="storage-mini-val">' + fmtBytes(st.queueCapBytes) + '</div></div>' +
          '</div>' +
        '</div></div>' +
      '</div>' +
      '<div class="storage-block expandable-inner' + (expRam ? ' is-expanded' : '') + '" data-st-block="ram" onclick="toggleInnerDetail(event, this)">' +
        '<div class="storage-row-head"><span>Live RAM (Heap)</span>' +
        '<span class="storage-row-val">' + ramPct + '% · ' + ramUsed + '/' + ramTotal + ' KB</span></div>' +
        '<div class="storage-track"><div class="storage-fill ram" style="transform:scaleX(' + (ramPct / 100).toFixed(3) + ')"></div></div>' +
        '<div class="inner-detail-drawer"><div class="inner-detail-content">' +
          '<div class="storage-sub-grid">' +
            '<div class="storage-mini"><div class="storage-mini-label">Free RAM Now</div><div class="storage-mini-val">' + (Number(st.heapFreeKb) || 0) + ' KB</div></div>' +
            '<div class="storage-mini"><div class="storage-mini-label">Lowest Free (Boot Min)</div><div class="storage-mini-val">' + (Number(st.heapMinFreeKb) || 0) + ' KB</div></div>' +
            maxAllocTile +
          '</div>' +
        '</div></div>' +
      '</div>';
  }

  let lastCloudPanelSig = '';
  function renderCloudPanelsIfChanged(status){
    const sig = JSON.stringify({
      health: status && status.health,
      wifi: status && status.wifi,
      ota: status && status.ota,
      telemetry: status && status.telemetry,
      storage: status && status.storage,
      powerMode: status && status.powerMode,
      ssid: status && status.ssid,
      lastCmdId: status && status.lastCmdId,
      lastCmdStage: status && status.lastCmdStage,
      lastCmdResult: status && status.lastCmdResult,
      packMah: getPackMah()
    });
    if (sig === lastCloudPanelSig) return;
    lastCloudPanelSig = sig;
    renderCloudPanels(status);
  }

  function renderCloudPanels(status){
    const healthEl = document.getElementById('cloud-health-list');
    if (healthEl){
      const h = status && status.health;
      if (!h){
        healthEl.innerHTML = '<div class="health-row"><div><div class="health-name">Cloud Health</div><div class="health-detail">Flash the latest room_logger.ino once to stream live health &amp; cloud commands here.</div></div><span class="status-pill warn">Update FW</span></div>';
      } else {
        const rows = [];
        if (h.firebase){
          const fbCls = !h.firebase.attempted ? 'warn' : (h.firebase.ok ? 'ok' : 'err');
          const fbBadge = !h.firebase.attempted ? 'No data' : (h.firebase.ok ? 'OK' : 'Failing');
          const fbDet = !h.firebase.attempted ? 'No upload attempted yet this boot.'
            : ((h.firebase.ok ? 'Last upload succeeded ' : 'Last attempt failed ') + h.firebase.secondsAgo + 's ago.');
          rows.push(['Cloud — Firebase', fbDet, fbBadge, fbCls]);
        }
        if (h.rtc){
          const diag = h.rtc.diag ? (' (' + h.rtc.diag + ')') : '';
          const rCls = !h.rtc.present ? 'err' : (!h.rtc.timeValid ? 'warn' : 'ok');
          const rBadge = !h.rtc.present ? 'Not found' : (!h.rtc.timeValid ? 'Unset' : 'OK');
          const rDet = !h.rtc.present ? ('No RTC detected on I2C' + diag)
            : (!h.rtc.timeValid ? ('Present, clock unset' + diag) : ('Present & keeping time' + diag));
          rows.push(['RTC (clock)', rDet, rBadge, rCls]);
        }
        if (h.dht){
          const dCls = (!h.dht.everRead || h.dht.stale) ? 'err' : 'ok';
          const dBadge = !h.dht.everRead ? 'No data' : (h.dht.stale ? 'Stale' : 'OK');
          const dDet = !h.dht.everRead ? 'No successful reading yet this boot.'
            : (h.dht.temp + '°C / ' + h.dht.hum + '% (' + h.dht.secondsAgo + 's ago)');
          rows.push(['DHT22 (sensor)', dDet, dBadge, dCls]);
        }
        if (h.power){
          const pm = h.power.mode || 'normal';
          const pDet = h.power.cpuMhz + ' MHz · read every ' + Math.round((h.power.readIntervalMs || 60000) / 1000) + 's';
          rows.push(['Power mode', pDet, pm.charAt(0).toUpperCase() + pm.slice(1), pm === 'normal' ? 'ok' : 'warn']);
        }
        if (h.ota){
          const okSlot = (h.ota.slotKb || 0) >= 1500;
          rows.push(['OTA partition slot', 'App ' + h.ota.sketchKb + ' KB / ' + h.ota.slotKb + ' KB slot', h.ota.slotKb + ' KB', okSlot ? 'ok' : 'warn']);
        }
        healthEl.innerHTML = rows.map(r =>
          '<div class="health-row"><div><div class="health-name">' + escapeHtml(r[0]) +
          '</div><div class="health-detail">' + escapeHtml(r[1]) +
          '</div></div><span class="status-pill ' + r[3] + '">' + escapeHtml(r[2]) + '</span></div>'
        ).join('');
      }
    }

    const activeMode = (status && status.powerMode ? String(status.powerMode).toLowerCase() : 'normal');
    document.querySelectorAll('#cloud-power-grid .power-opt').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.pm === activeMode);
    });

    const wifiEl = document.getElementById('cloud-wifi-list');
    if (wifiEl){
      const w = status && status.wifi;
      if (!w || !Array.isArray(w.networks)){
        wifiEl.innerHTML = '<div class="ota-meta">Waiting for firmware v3.5+ status sync…</div>';
      } else if (!w.networks.length){
        wifiEl.innerHTML = '<div class="ota-meta">No saved networks reported.</div>';
      } else {
        const pref = w.preferred || '';
        const curSsid = status.ssid || '';
        wifiEl.innerHTML = w.networks.map(net => {
          const isCur = net.ssid === curSsid;
          const isPref = net.ssid === pref;
          const pills = (isCur ? '<span class="status-pill ok">Connected</span>' : '') +
                        (isPref ? '<span class="status-pill warn">Preferred</span>' : '');
          const sub = net.ip ? ('Static IP: ' + net.ip) : 'DHCP';
          const safeSsid = escapeHtml(net.ssid);
          const prefBtn = isPref
            ? '<button type="button" class="btn-ghost" data-wifi-act="pref" data-ssid="">Clear Pref</button>'
            : '<button type="button" class="btn-ghost" data-wifi-act="pref" data-ssid="' + safeSsid + '">Set Preferred</button>';
          const remBtn = w.networks.length > 1
            ? '<button type="button" class="btn-ghost" data-wifi-act="remove" data-ssid="' + safeSsid + '">Remove</button>' : '';
          return '<div class="wifi-item"><div><div class="wifi-ssid">' + escapeHtml(net.ssid) + pills +
                 '</div><div class="wifi-sub">' + escapeHtml(sub) + '</div></div>' +
                 '<div class="wifi-actions">' + prefBtn + remBtn + '</div></div>';
        }).join('');
      }
    }

    const otaStEl = document.getElementById('cloud-ota-status');
    if (otaStEl && status && status.ota && status.ota.msg){
      otaStEl.innerHTML = 'ESP32 OTA status: <b>' + escapeHtml(status.ota.state || 'idle') + '</b> — ' + escapeHtml(status.ota.msg);
    }

    renderTelemetryCard(status && status.telemetry, status && status.powerMode);
    renderStorageCard(status && status.storage);
    renderMinimalSummaries(status);

    if (pendingCmdId && status && String(status.lastCmdId || '') === pendingCmdId){
      const stg = String(status.lastCmdStage || 'completed');
      if (stg === 'received'){
        const msg = 'ESP32 received command — applying changes now…';
        if (activeCmdJob){ activeCmdJob.stage = 'received'; activeCmdJob.detail = msg; renderCmdQueueSection(); }
        updateCmdStepper('received', msg);
        setCloudCmdStatus('ESP32 received command — applying…', 'warn');
      } else if (stg === 'error'){
        const msg = 'ESP32 reported error: ' + (status.lastCmdResult || 'Failed');
        updateCmdStepper('error', msg);
        setCloudCmdStatus('✕ ESP32: ' + (status.lastCmdResult || 'Failed'), 'err');
        finalizeActiveCmdJob('error', msg);
      } else {
        const msg = 'Confirmed by ESP32: ' + (status.lastCmdResult || 'Done');
        updateCmdStepper('completed', msg);
        setCloudCmdStatus('✓ ' + (status.lastCmdResult || 'Done'), '');
        stagedPowerMode = null;
        document.querySelectorAll('#cloud-power-grid .power-opt.staged').forEach(b => b.classList.remove('staged'));
        finalizeActiveCmdJob('completed', msg);
      }
    }
  }

  function sendCloudCommand(payloadObj, waitingMsg, slotKey){
    const inferredSlot = slotKey || (
      payloadObj && payloadObj.action === 'setPowerMode' ? 'power-mode' :
      payloadObj && (payloadObj.action === 'addWifi' || payloadObj.action === 'removeWifi' || payloadObj.action === 'setPreferredWifi') ? 'wifi-control' :
      payloadObj && payloadObj.action === 'otaUrl' ? 'ota-control' :
      payloadObj && /^(setTelemetry|resetTelemetry|setBatteryTrack|resetBatteryTrack|setStartVoltage|setWifiTrack|resetWifiTrack)$/.test(payloadObj.action) ? 'telemetry-control' :
      'home-actions'
    );
    const host = getHost();
    if (!host){
      setCloudCmdStatus('Set Firebase RTDB host on the Graphs tab first.', 'err');
      showToast('Set Firebase RTDB host on Graphs tab first');
      return false;
    }
    const id = String(Date.now()) + '_' + (++cmdSeqCounter);
    const job = {
      id: id,
      payload: Object.assign({}, payloadObj),
      label: waitingMsg || ('Action: ' + (payloadObj.action || 'command')),
      slotKey: inferredSlot,
      stage: 'queued',
      detail: 'Queued — waiting for earlier upload to finish…',
      createdAt: Date.now(),
      startedAt: null,
      finishedAt: null,
      durationMs: null
    };
    cmdQueue.push(job);
    persistCmdQueueAndHistory();
    renderCmdQueueSection();

    if (activeCmdJob){
      showToast('Queued (#' + cmdQueue.length + '): ' + job.label.replace(/…$/, ''));
      return true;
    }
    return processNextCmdQueue();
  }

  async function processNextCmdQueue(){
    if (activeCmdJob || !cmdQueue.length) return false;
    const host = getHost();
    if (!host) return false;

    activeCmdJob = cmdQueue.shift();
    activeCmdJob.startedAt = Date.now();
    activeCmdJob.stage = 'sending';
    activeCmdJob.detail = 'Uploading command to Firebase…';
    persistCmdQueueAndHistory();

    mountStepperIntoSlot(activeCmdJob.slotKey);
    if (cmdPollTimer){ clearInterval(cmdPollTimer); cmdPollTimer = null; }
    if (cmdClockTimer){ clearInterval(cmdClockTimer); cmdClockTimer = null; }

    pendingCmdId = activeCmdJob.id;
    pendingCmdStartMs = activeCmdJob.startedAt;
    pendingCmdLabel = activeCmdJob.label;
    updateCmdStepper('sending', activeCmdJob.detail);
    renderCmdQueueSection();
    setCloudCmdStatus('', '');

    cmdClockTimer = setInterval(() => {
      const elapsed = ((Date.now() - pendingCmdStartMs) / 1000).toFixed(1) + 's';
      const tEl = document.getElementById('cmd-stepper-time');
      if (tEl && pendingCmdStartMs) tEl.textContent = elapsed;
      if (activeCmdJob){
        const liveMeta = document.querySelector('[data-cmd-job-id="' + activeCmdJob.id + '"] .cmd-q-meta');
        if (liveMeta) liveMeta.textContent = elapsed + ' · ' + formatFull(activeCmdJob.createdAt, true);
      }
    }, 250);

    try {
      const body = Object.assign({ id: activeCmdJob.id }, activeCmdJob.payload);
      const url = 'https://' + host + '/cmd.json' + getFbAuthParam();
      const res = await fetch(url, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        cache: 'no-store'
      });
      if (!res.ok){
        const errMsg = 'Upload to Firebase failed (HTTP ' + res.status + '). Add Firebase DB secret in Graphs → Spike Vault if needed.';
        updateCmdStepper('send_error', errMsg);
        setCloudCmdStatus(errMsg, 'err');
        finalizeActiveCmdJob('send_error', errMsg);
        return false;
      }
      activeCmdJob.stage = 'sent';
      activeCmdJob.detail = 'Uploaded to Firebase — waiting for ESP32 to pick it up (~5s)…';
      updateCmdStepper('sent', activeCmdJob.detail);
      renderCmdQueueSection();

      let polls = 0;
      cmdPollTimer = setInterval(() => {
        polls++;
        fetchStatus();
        if (polls >= 20){
          const timeoutMsg = 'Timed out waiting for ESP32 ACK (30s) — ESP32 will apply on next wake/poll window.';
          updateCmdStepper('error', timeoutMsg);
          finalizeActiveCmdJob('timeout', timeoutMsg);
        }
      }, 1500);
      return true;
    } catch(err){
      const errMsg = 'Network error: ' + err.message;
      updateCmdStepper('send_error', errMsg);
      setCloudCmdStatus('Command error: ' + err.message, 'err');
      finalizeActiveCmdJob('send_error', errMsg);
      return false;
    }
  }

  let stagedPowerMode = null;
  function selectPowerMode(mode){
    stagedPowerMode = mode;
    document.querySelectorAll('#cloud-power-grid .power-opt').forEach(btn => {
      btn.classList.toggle('staged', btn.dataset.pm === mode);
    });
    const applyBtn = document.getElementById('btn-apply-power');
    if (applyBtn){
      const label = mode.charAt(0).toUpperCase() + mode.slice(1);
      applyBtn.textContent = 'Apply ' + label + ' Mode';
      applyBtn.disabled = false;
    }
  }
  function applyStagedPowerMode(){
    const mode = stagedPowerMode || lastKnownPowerMode || 'normal';
    cloudSetPowerMode(mode);
  }
  function cloudSetPowerMode(mode){
    stagedPowerMode = mode;
    sendCloudCommand({ action: 'setPowerMode', mode: mode }, 'Switching ESP32 to ' + mode + ' mode…', 'power-mode');
  }

  function cloudAddWifi(){
    const ssid = (document.getElementById('cw-ssid').value || '').trim();
    const pass = document.getElementById('cw-pass').value || '';
    if (!ssid){ setCloudCmdStatus('Enter a WiFi SSID first.', 'err'); showToast('Enter a WiFi SSID first'); return; }
    sendCloudCommand({ action: 'addWifi', ssid: ssid, password: pass }, 'Saving WiFi "' + ssid + '" to ESP32…');
    document.getElementById('cw-ssid').value = '';
    document.getElementById('cw-pass').value = '';
  }

  function cloudRemoveWifi(ssid){
    if (!confirm('Remove saved WiFi "' + ssid + '" from the ESP32?')) return;
    sendCloudCommand({ action: 'removeWifi', ssid: ssid }, 'Removing "' + ssid + '"…');
  }

  function cloudSetPreferredWifi(ssid){
    sendCloudCommand({ action: 'setPreferredWifi', ssid: ssid }, ssid ? ('Setting Preferred WiFi to "' + ssid + '"…') : 'Clearing Preferred WiFi…');
  }

  function cloudFlashLatestOta(){
    if (!latestBinUrl) return;
    if (!confirm('Tell the ESP32 to download and flash the latest firmware over the cloud now?')) return;
    sendCloudCommand({ action: 'otaUrl', url: latestBinUrl }, 'Triggering remote Cloud OTA flash (~20–30s)…');
  }

  function confirmCloudReboot(){
    if (!confirm('Reboot the ESP32 remotely now?')) return;
    sendCloudCommand({ action: 'reboot' }, 'Sending reboot command to ESP32…');
  }

  async function fetchStatus(){
    const host = getHost();
    const dashMsg = document.getElementById('dash-msg');
    if (!host){
      dashMsg.textContent = 'Enter a Firebase RTDB host on the Graphs tab first.';
      return;
    }
    try{
      const res = await fetch(appendAuthParam('https://' + host + '/status.json'), { cache: 'no-store' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const status = await res.json();
      if (!status || !status.ip){
        dashMsg.textContent = 'No status published yet -- the device publishes this on every (re)connect, so it should appear shortly after it\'s next online.';
        return;
      }
      lastFetchedStatus = status;
      renderStatusUi();
    } catch(err){
      lastKnownDeviceIp = '';
      document.getElementById('dash-links').innerHTML = '';
      updateOtaButtons();
      dashMsg.textContent = 'Could not reach status.json (' + err.message + '). Check the Firebase host on the Graphs tab, and that the device has published at least once.';
    }
  }

