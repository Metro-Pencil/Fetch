  const APP_VERSION = '3.12.0';
  document.getElementById('version-badge').textContent = 'v' + APP_VERSION;

  const VIEW_ORDER = ['dashboard', 'graphs', 'controls', 'system'];
  let currentViewName = 'dashboard';
  let heroDialMode = 'temp'; // 'temp' | 'hum'
  let uiToastTimer = null;

  function showToast(msg){
    const el = document.getElementById('ui-toast');
    if (!el) return;
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(uiToastTimer);
    uiToastTimer = setTimeout(() => el.classList.remove('show'), 1900);
  }

  // ---------- Minimal vs Super-Detailed Toggle (Card Tap OR Same-Tab Re-Tap) ----------
  function isInteractiveTarget(target){
    if (!target) return false;
    return !!target.closest('button, input, select, textarea, a, summary, label, .switch, canvas, .power-opt, .cmd-stepper');
  }

  function toggleCardExpand(evt, cardEl){
    if (evt && isInteractiveTarget(evt.target)) return;
    if (!cardEl) return;
    cardEl.classList.toggle('is-expanded');
  }

  function toggleInnerDetail(evt, blockEl){
    if (evt && isInteractiveTarget(evt.target)) return;
    if (!blockEl) return;
    blockEl.classList.toggle('is-expanded');
  }

  function toggleSectionDetailed(viewName){
    const viewEl = document.getElementById('view-' + viewName);
    if (!viewEl) return;
    const expandables = viewEl.querySelectorAll('.expandable-card, .expandable-inner');
    if (!expandables.length) return;
    const anyCollapsed = Array.from(expandables).some(el => !el.classList.contains('is-expanded'));
    expandables.forEach(el => el.classList.toggle('is-expanded', anyCollapsed));
    showToast(anyCollapsed ? 'Detailed view expanded' : 'Minimal view restored');
  }

  function handleBottomNavClick(name){
    if (name === currentViewName){
      toggleSectionDetailed(name);
      return;
    }
    const oldIdx = VIEW_ORDER.indexOf(currentViewName);
    const newIdx = VIEW_ORDER.indexOf(name);
    const dir = newIdx > oldIdx ? 'right' : 'left';
    showView(name, dir);
  }

  function showView(name, slideDir){
    if (!VIEW_ORDER.includes(name)) name = 'dashboard';
    const prev = currentViewName;
    currentViewName = name;

    VIEW_ORDER.forEach(function(v){
      const el = document.getElementById('view-' + v);
      if (!el) return;
      el.classList.remove('active-view', 'slide-from-right', 'slide-from-left', 'fade-pop');
      if (v === name){
        el.classList.add('active-view');
        if (slideDir === 'right') el.classList.add('slide-from-right');
        else if (slideDir === 'left') el.classList.add('slide-from-left');
        else if (prev !== name) el.classList.add('fade-pop');
      }
    });

    document.querySelectorAll('.bnav-btn').forEach(function(btn){
      const isActive = btn.getAttribute('data-view') === name;
      btn.classList.toggle('active', isActive);
      btn.setAttribute('aria-selected', isActive ? 'true' : 'false');
    });

    const nowMs = Date.now();
    // Defer network/canvas work until the 180ms slide transition completes to avoid frame drops
    clearTimeout(window._tabPostSwitchTimer);
    window._tabPostSwitchTimer = setTimeout(() => {
      if (name === 'dashboard' || name === 'controls' || name === 'system'){
        if (!window._lastTabStatusMs || (nowMs - window._lastTabStatusMs) > 4000){
          window._lastTabStatusMs = nowMs;
          fetchStatus();
        }
        if (name === 'controls' && (!window._lastFwCheckMs || (nowMs - window._lastFwCheckMs) > 15000)){
          window._lastFwCheckMs = nowMs;
          fetchFirmwareInfo();
        }
      }
      if (name === 'graphs'){
        if (chartTemp){ chartTemp.resize(); chartTemp.update('none'); }
        if (chartHum){ chartHum.resize(); chartHum.update('none'); }
      }
    }, 190);
    if (window.scrollY > 0) window.scrollTo(0, 0);
  }

  function triggerFabRefresh(){
    const fab = document.getElementById('bnav-refresh-fab');
    if (fab){
      clearTimeout(window._fabSpinTimer);
      fab.classList.add('spinning');
      window._fabSpinTimer = setTimeout(() => fab.classList.remove('spinning'), 950);
    }
    fetchReadings();
    fetchStatus();
    if (currentViewName === 'controls') fetchFirmwareInfo();
    showToast('Refreshing live data…');
  }

  // ---------- Image-2 Radial Tick Gauge SVG & Live Hero Overview Sync ----------
  function renderHeroGaugeSvg(pct, accentColor){
    const svg = document.getElementById('hero-gauge-svg');
    if (!svg) return;
    const totalTicks = 44;
    const activeTicks = Math.max(2, Math.min(totalTicks, Math.round((pct / 100) * totalTicks)));
    const cx = 110, cy = 110, rOuter = 96;
    let markup = '';
    for (let i = 0; i < totalTicks; i++){
      const angleDeg = -90 + (i * (360 / totalTicks));
      const rad = (angleDeg * Math.PI) / 180;
      const isActive = i < activeTicks;
      const distFromTip = activeTicks - 1 - i;
      const isAccentBar = isActive && distFromTip >= 0 && distFromTip < 6;
      const len = isAccentBar ? (18 + (5 - distFromTip) * 2.2) : (isActive ? 13 : 11);
      const rInner = rOuter - len;
      const x1 = cx + rInner * Math.cos(rad);
      const y1 = cy + rInner * Math.sin(rad);
      const x2 = cx + rOuter * Math.cos(rad);
      const y2 = cy + rOuter * Math.sin(rad);
      const sw = isAccentBar ? 3.2 : (isActive ? 1.8 : 1.15);
      const stroke = isAccentBar ? '#F7F5F0' : (isActive ? accentColor : 'rgba(244,242,238,0.22)');
      const op = isAccentBar ? (0.65 + (5 - distFromTip) * 0.07) : (isActive ? 0.78 : 0.45);
      markup += '<line x1="' + x1.toFixed(1) + '" y1="' + y1.toFixed(1) + '" x2="' + x2.toFixed(1) + '" y2="' + y2.toFixed(1) +
        '" stroke="' + stroke + '" stroke-width="' + sw + '" stroke-linecap="round" opacity="' + op.toFixed(2) + '"/>';
    }
    svg.innerHTML = markup;
  }

  function cycleHeroDial(forceMode){
    const center = document.getElementById('hero-gauge-center');
    const dialOrder = ['temp', 'hum', 'feels'];
    heroDialMode = forceMode || dialOrder[(dialOrder.indexOf(heroDialMode) + 1) % dialOrder.length];
    if (center){
      clearTimeout(window._dialSwitchTimer);
      center.classList.add('switching');
      window._dialSwitchTimer = setTimeout(() => {
        updateHeroOverview();
        center.classList.remove('switching');
      }, 150);
    } else {
      updateHeroOverview();
    }
  }

  function updateHeroConnDot(state){
    const badge = document.getElementById('hero-online-badge');
    if (!badge) return;
    if (!lastFetchedStatus){
      badge.className = 'hero-badge ' + state;
      const txt = document.getElementById('hero-online-text');
      if (txt) txt.textContent = state === 'online' ? 'ONLINE' : (state === 'stale' ? 'STALE' : 'OFFLINE');
    }
  }

  function updateHeroAgeText(ageText){
    const tAge = document.getElementById('hero-temp-age');
    const hAge = document.getElementById('hero-hum-age');
    if (tAge) tAge.textContent = 'Temperature · ' + ageText.split('·')[0].trim();
    if (hAge) hAge.textContent = 'Humidity · ' + ageText.split('·')[0].trim();
  }

  function updateHeroOverview(){
    const latest = (typeof latestEntry === 'function') ? latestEntry() : null;
    const status = lastFetchedStatus;

    const tempValEl = document.getElementById('hero-temp-val');
    const humValEl = document.getElementById('hero-hum-val');
    const feelsValEl = document.getElementById('hero-feels-val');
    const feelsLblEl = document.getElementById('hero-feels-lbl');
    const feelsC = (latest && typeof calcHeatIndexC === 'function')
      ? calcHeatIndexC(latest.temp, latest.hum)
      : (latest ? latest.temp : null);
    if (latest){
      if (tempValEl) tempValEl.innerHTML = latest.temp.toFixed(1) + '<span>°C</span>';
      if (humValEl) humValEl.innerHTML = latest.hum.toFixed(1) + '<span>%RH</span>';
      if (feelsValEl && feelsC !== null) feelsValEl.innerHTML = feelsC.toFixed(1) + '<span>°C</span>';
      if (feelsLblEl && feelsC !== null){
        const feelTag = feelsC >= 32 ? 'Hot / Oppressive' : (feelsC >= 27 ? 'Warm' : (feelsC >= 20 ? 'Feels Comfy' : (feelsC >= 15 ? 'Cool' : 'Chilly')));
        feelsLblEl.textContent = feelTag;
      }
    }

    const gaugeVal = document.getElementById('hero-gauge-val');
    const gaugeSub = document.getElementById('hero-gauge-sub');
    const dotT = document.getElementById('dial-dot-temp');
    const dotH = document.getElementById('dial-dot-hum');
    const dotF = document.getElementById('dial-dot-feels');
    if (dotT) dotT.classList.toggle('active', heroDialMode === 'temp');
    if (dotH) dotH.classList.toggle('active', heroDialMode === 'hum');
    if (dotF) dotF.classList.toggle('active', heroDialMode === 'feels');

    if (heroDialMode === 'temp'){
      const t = latest ? latest.temp : null;
      if (gaugeVal) gaugeVal.innerHTML = (t !== null ? t.toFixed(1) : '—') + '<span class="unit-sup">°C</span>';
      if (gaugeSub) gaugeSub.textContent = 'Room Temp';
      const pct = t !== null ? Math.max(6, Math.min(100, ((t - 10) / 35) * 100)) : 28;
      renderHeroGaugeSvg(pct, '#F5A66B');
    } else if (heroDialMode === 'hum'){
      const h = latest ? latest.hum : null;
      if (gaugeVal) gaugeVal.innerHTML = (h !== null ? Math.round(h) : '—') + '<span class="unit-sup">%</span>';
      if (gaugeSub) gaugeSub.textContent = 'Humidity';
      const pct = h !== null ? Math.max(6, Math.min(100, h)) : 46;
      renderHeroGaugeSvg(pct, '#7DC4E4');
    } else {
      if (gaugeVal) gaugeVal.innerHTML = (feelsC !== null ? feelsC.toFixed(1) : '—') + '<span class="unit-sup">°C</span>';
      if (gaugeSub) gaugeSub.textContent = 'Feels Like';
      const pct = feelsC !== null ? Math.max(6, Math.min(100, ((feelsC - 10) / 35) * 100)) : 32;
      renderHeroGaugeSvg(pct, '#5EEAD4');
    }

    const wifiEl = document.getElementById('hero-wifi-name');
    const subEl = document.getElementById('hero-conn-sub');
    const badge = document.getElementById('hero-online-badge');
    const badgeTxt = document.getElementById('hero-online-text');
    const pwrBadge = document.getElementById('hero-power-badge');

    if (status && status.ip){
      const mode = (typeof status.powerMode === 'string' && status.powerMode) ? status.powerMode.toLowerCase() : 'normal';
      const lastSeenSec = Number(status.lastSeen || 0);
      const heartbeatMs = lastSeenSec > 1e9 ? lastSeenSec * 1000 : 0;
      const readingMs = (typeof latestReadingEpoch === 'number' && latestReadingEpoch > 1e12) ? latestReadingEpoch : 0;
      const bestSeenMs = Math.max(heartbeatMs, readingMs);
      const ageMs = bestSeenMs ? Math.max(0, Date.now() - bestSeenMs) : Infinity;
      const offlineWindowMs = mode === 'high' ? 35*60*1000 : mode === 'medium' ? 7*60*1000 : mode === 'low' ? 4*60*1000 : 2.5*60*1000;
      const validIp = isSafeHostOrIp(status.ip) && status.ip !== '0.0.0.0';
      const isOnline = validIp && status.internetOk !== false && (ageMs <= offlineWindowMs);

      if (wifiEl) wifiEl.textContent = status.ssid || 'Room Logger';
      if (subEl){
        subEl.textContent = isOnline
          ? (status.ip + ' · active ' + timeAgo(ageMs))
          : (bestSeenMs ? ('Offline · last seen ' + timeAgo(ageMs)) : 'Device offline');
      }
      if (badge) badge.className = 'hero-badge ' + (isOnline ? 'online' : 'offline');
      if (badgeTxt) badgeTxt.textContent = isOnline ? 'ONLINE' : 'OFFLINE';
      if (pwrBadge) pwrBadge.textContent = mode.charAt(0).toUpperCase() + mode.slice(1) + (mode === 'normal' ? ' Power' : ' Save');
    }
  }

  function renderMinimalSummaries(status){
    const strip = document.getElementById('home-health-minimal');
    const h = status && status.health;
    if (strip){
      if (!h){
        strip.innerHTML = '<span class="mini-health-chip warn"><span class="mhd"></span>Update FW for live health</span>';
      } else {
        const chips = [];
        if (h.firebase){
          const cls = !h.firebase.attempted ? 'warn' : (h.firebase.ok ? 'ok' : 'err');
          chips.push('<span class="mini-health-chip ' + cls + '"><span class="mhd"></span>Firebase ' + (h.firebase.ok ? 'OK' : 'Check') + '</span>');
        }
        if (h.rtc){
          const cls = !h.rtc.present ? 'err' : (!h.rtc.timeValid ? 'warn' : 'ok');
          chips.push('<span class="mini-health-chip ' + cls + '"><span class="mhd"></span>RTC ' + (h.rtc.present && h.rtc.timeValid ? 'Synced' : 'Check') + '</span>');
        }
        if (h.dht){
          const cls = (!h.dht.everRead || h.dht.stale) ? 'err' : 'ok';
          chips.push('<span class="mini-health-chip ' + cls + '"><span class="mhd"></span>DHT22 ' + (cls === 'ok' ? 'OK' : 'Stale') + '</span>');
        }
        if (h.power){
          const pm = String(h.power.mode || 'normal');
          chips.push('<span class="mini-health-chip ' + (pm === 'normal' ? 'ok' : 'warn') + '"><span class="mhd"></span>' + escapeHtml(pm.charAt(0).toUpperCase() + pm.slice(1)) + '</span>');
        }
        if (window._espFwOutdated && window._espFwLatestBuild){
          chips.push('<span class="mini-health-chip warn" onclick="event.stopPropagation(); showView(\'controls\', \'right\')" style="cursor:pointer;"><span class="mhd"></span>FW Update #' + Number(window._espFwLatestBuild) + '</span>');
        }
        strip.innerHTML = chips.join('');
      }
    }
    const pmPill = document.getElementById('power-minimal-pill');
    if (pmPill && status && status.powerMode){
      const m = String(status.powerMode);
      pmPill.textContent = m.charAt(0).toUpperCase() + m.slice(1);
    }
    const wifiPill = document.getElementById('wifi-minimal-pill');
    if (wifiPill && status){
      const cnt = status.wifi && Array.isArray(status.wifi.networks) ? status.wifi.networks.length : 0;
      wifiPill.textContent = (status.ssid ? status.ssid : 'WiFi') + (cnt ? (' · ' + cnt + ' saved') : '');
    }
  }

  // ---------- Smooth rAF-Batched Left/Right Swipe Gestures + Pull-to-Refresh ----------
  (function initGestures(){
    const viewport = document.getElementById('views-viewport');
    const ptrEl = document.getElementById('ptr-indicator');
    let sx = 0, sy = 0, swiping = false, lockedAxis = null, pulling = false, pullDist = 0;
    let isDraggingClassOn = false, ptrVisible = false, ptrLastText = '';
    let gestureRaf = 0, pendingDamped = null, pendingPullY = null, pendingPullReady = false;

    function shouldIgnoreTabSwipe(target){
      if (!target) return true;
      return !!target.closest('.chart-canvas-box, canvas, input, select, textarea, .hero-dial-wrap, [data-no-tab-swipe]');
    }

    function flushGestureFrame(){
      gestureRaf = 0;
      if (pendingDamped !== null && viewport){
        if (!isDraggingClassOn){
          viewport.classList.add('dragging');
          isDraggingClassOn = true;
        }
        viewport.style.transform = 'translate3d(' + pendingDamped.toFixed(1) + 'px, 0, 0)';
        pendingDamped = null;
      }
      if (pendingPullY !== null && ptrEl){
        if (!ptrVisible){
          ptrEl.classList.add('visible');
          ptrVisible = true;
        }
        ptrEl.style.transform = 'translate3d(-50%, ' + pendingPullY.toFixed(0) + 'px, 0)';
        const txt = pendingPullReady ? 'Release to refresh' : 'Pull to refresh…';
        if (txt !== ptrLastText){
          ptrEl.textContent = txt;
          ptrLastText = txt;
        }
        pendingPullY = null;
      }
    }

    document.addEventListener('touchstart', function(e){
      if (e.touches.length !== 1) return;
      sx = e.touches[0].clientX;
      sy = e.touches[0].clientY;
      lockedAxis = null;
      swiping = !shouldIgnoreTabSwipe(e.target);
      pulling = (window.scrollY <= 2) && !e.target.closest('.chart-canvas-box, canvas');
      pullDist = 0;
    }, { passive: true });

    document.addEventListener('touchmove', function(e){
      if (e.touches.length !== 1) return;
      const dx = e.touches[0].clientX - sx;
      const dy = e.touches[0].clientY - sy;

      if (!lockedAxis && (Math.abs(dx) > 14 || Math.abs(dy) > 14)){
        lockedAxis = Math.abs(dx) > Math.abs(dy) * 1.4 ? 'x' : 'y';
      }

      if (lockedAxis === 'x' && swiping && viewport){
        const curIdx = VIEW_ORDER.indexOf(currentViewName);
        let damped = dx * 0.20;
        if ((curIdx === 0 && dx > 0) || (curIdx === VIEW_ORDER.length - 1 && dx < 0)){
          damped = dx * 0.06;
        }
        pendingDamped = Math.max(-44, Math.min(44, damped));
        if (!gestureRaf) gestureRaf = requestAnimationFrame(flushGestureFrame);
      } else if (lockedAxis === 'y' && pulling && dy > 24){
        pullDist = Math.min(90, (dy - 24) * 0.45);
        if (ptrEl && pullDist > 14){
          pendingPullY = Math.min(26, pullDist - 36);
          pendingPullReady = pullDist > 62;
          if (!gestureRaf) gestureRaf = requestAnimationFrame(flushGestureFrame);
        }
      }
    }, { passive: true });

    function finishGesture(e, cancelled){
      if (gestureRaf){ cancelAnimationFrame(gestureRaf); gestureRaf = 0; }
      pendingDamped = null;
      pendingPullY = null;
      const didSwipeX = !cancelled && lockedAxis === 'x' && swiping && e.changedTouches && e.changedTouches.length;
      const dx = didSwipeX ? (e.changedTouches[0].clientX - sx) : 0;
      const idx = VIEW_ORDER.indexOf(currentViewName);
      let nextView = null, nextDir = null;
      if (didSwipeX && Math.abs(dx) >= 60){
        if (dx < 0 && idx < VIEW_ORDER.length - 1){ nextView = VIEW_ORDER[idx + 1]; nextDir = 'right'; }
        else if (dx > 0 && idx > 0){ nextView = VIEW_ORDER[idx - 1]; nextDir = 'left'; }
      }
      if (viewport){
        if (nextView){
          viewport.classList.add('dragging');
          viewport.style.transform = '';
          requestAnimationFrame(() => { viewport.classList.remove('dragging'); isDraggingClassOn = false; });
        } else {
          viewport.classList.remove('dragging');
          isDraggingClassOn = false;
          viewport.style.transform = '';
        }
      }
      if (ptrEl && ptrVisible){
        ptrEl.classList.remove('visible');
        ptrEl.style.transform = 'translate3d(-50%, -60px, 0)';
        ptrVisible = false;
      }
      if (!cancelled && pulling && pullDist > 62){
        triggerFabRefresh();
      }
      if (nextView){
        showView(nextView, nextDir);
      }
      swiping = false;
      pulling = false;
      lockedAxis = null;
      pullDist = 0;
    }
    document.addEventListener('touchend', (e) => finishGesture(e, false), { passive: true });
    document.addEventListener('touchcancel', (e) => finishGesture(e, true), { passive: true });

    // Dedicated horizontal swipe on Hero Dial to swap Temp <-> Humidity
    const dialWrap = document.getElementById('hero-dial-wrap');
    if (dialWrap){
      let dsx = 0, dsy = 0;
      dialWrap.addEventListener('touchstart', (e) => {
        if (e.touches.length === 1){ dsx = e.touches[0].clientX; dsy = e.touches[0].clientY; }
      }, { passive: true });
      dialWrap.addEventListener('touchend', (e) => {
        if (!e.changedTouches || !e.changedTouches.length) return;
        const dx = e.changedTouches[0].clientX - dsx;
        const dy = e.changedTouches[0].clientY - dsy;
        if (Math.abs(dx) > 36 && Math.abs(dx) > Math.abs(dy) * 1.2){
          cycleHeroDial();
        }
      }, { passive: true });
    }

    // Desktop keyboard left/right arrow tab switching
    document.addEventListener('keydown', function(e){
      if (e.target && /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) return;
      if (e.key === 'ArrowRight'){
        const idx = VIEW_ORDER.indexOf(currentViewName);
        if (idx < VIEW_ORDER.length - 1) showView(VIEW_ORDER[idx + 1], 'right');
      } else if (e.key === 'ArrowLeft'){
        const idx = VIEW_ORDER.indexOf(currentViewName);
        if (idx > 0) showView(VIEW_ORDER[idx - 1], 'left');
      }
    });
  })();

  // Initial Hero Gauge render before first network response
  renderHeroGaugeSvg(42, '#F5A66B');

