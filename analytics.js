  // ---------- Air Intelligence: 7 Psychrometric & Statistical Metrics (v3.11.0) ----------
  // Offload policy:
  //   - When ESP32 is ONLINE: ESP32 computes live metrics & 30-day rolling stats and publishes /analytics.json.
  //   - When ESP32 is OFFLINE (or /analytics.json is missing/stale): PWA computes all 7 metrics from
  //     loaded readings and syncs the result up to Firebase PUT /analytics.json so all clients stay fresh.

  const STD_PRESSURE_HPA = 1013.25;
  let lastCloudAnalytics = null;
  let lastPwaAnalyticsSig = '';
  let lastPwaAnalyticsUploadMs = 0;

  // 0. Magnus-Tetens actual vapor pressure e (hPa)
  function calcVaporPressureHpa(tempC, rhPct){
    const es = 6.112 * Math.exp((17.67 * tempC) / (tempC + 243.5));
    return (rhPct / 100.0) * es;
  }

  // 1. Absolute Humidity (g/m^3)
  function calcAbsoluteHumidity(tempC, rhPct){
    const e = calcVaporPressureHpa(tempC, rhPct);
    return (216.679 * e) / (tempC + 273.15);
  }

  // 2. Specific Enthalpy (kJ/kg dry air)
  function calcEnthalpyKjKg(tempC, rhPct){
    const e = calcVaporPressureHpa(tempC, rhPct);
    const denom = Math.max(1.0, STD_PRESSURE_HPA - e);
    const W = 0.62198 * (e / denom);
    return 1.006 * tempC + W * (2501.0 + 1.86 * tempC);
  }

  // 3. Heat Index (°C) — NOAA Rothfusz regression (applies when T >= 26.7°C & RH >= 40%)
  function calcHeatIndexC(tempC, rhPct){
    if (tempC < 26.7 || rhPct < 40.0) return tempC;
    const T = tempC * 1.8 + 32.0;
    const R = rhPct;
    let hiF = -42.379
      + 2.04901523 * T
      + 10.14333127 * R
      - 0.22475541 * T * R
      - 0.00683783 * T * T
      - 0.05481717 * R * R
      + 0.00122874 * T * T * R
      + 0.00085282 * T * R * R
      - 0.00000199 * T * T * R * R;
    // NOAA high-humidity adjustment (RH > 85% and 80 <= T <= 87°F)
    if (R > 85.0 && T >= 80.0 && T <= 87.0){
      hiF += ((R - 85.0) / 10.0) * ((87.0 - T) / 5.0);
    }
    return (hiF - 32.0) / 1.8;
  }

  function localDayKeyFromMs(ms){
    const d = new Date(ms);
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return y + '-' + m + '-' + day;
  }

  function meanAndStd(arr){
    if (!arr.length) return { mean: null, std: null };
    let sum = 0;
    for (const v of arr) sum += v;
    const mean = sum / arr.length;
    if (arr.length < 2) return { mean, std: 0 };
    let sq = 0;
    for (const v of arr){ const d = v - mean; sq += d * d; }
    return { mean, std: Math.sqrt(sq / arr.length) };
  }

  function computeAllSevenMetrics(entries){
    if (!entries || !entries.length) return null;
    const latest = entries[entries.length - 1];
    const liveT = latest.temp;
    const liveH = latest.hum;
    const liveVp = calcVaporPressureHpa(liveT, liveH);
    const liveAh = calcAbsoluteHumidity(liveT, liveH);
    const liveEnth = calcEnthalpyKjKg(liveT, liveH);
    const liveHi = calcHeatIndexC(liveT, liveH);
    const comfortNow = (liveT >= 20.0 && liveT <= 26.0 && liveH >= 30.0 && liveH <= 60.0);

    // Aggregate into calendar-day means
    const byDay = new Map();
    for (const e of entries){
      if (typeof e.epochMs !== 'number' || !Number.isFinite(e.temp) || !Number.isFinite(e.hum)) continue;
      const dk = localDayKeyFromMs(e.epochMs);
      let b = byDay.get(dk);
      if (!b){ b = { day: dk, tSum: 0, hSum: 0, ahSum: 0, n: 0 }; byDay.set(dk, b); }
      b.tSum += e.temp;
      b.hSum += e.hum;
      b.ahSum += calcAbsoluteHumidity(e.temp, e.hum);
      b.n++;
    }
    const days = Array.from(byDay.values())
      .sort((a, b) => a.day.localeCompare(b.day))
      .map(b => ({
        day: b.day,
        t: b.tSum / b.n,
        h: b.hSum / b.n,
        ah: b.ahSum / b.n,
        n: b.n
      }));

    // 4. Comfort Zone Compliance (%) — ASHRAE 55 (20..26°C AND 30..60% RH)
    let compliantDays = 0;
    // 5. Mold Risk Index — RH > 60% (strict > 65%) AND 20..30°C, tracking consecutive streaks
    let moldStreak = 0, moldMaxStreak = 0, moldHighDays = 0, moldStrictDays = 0;
    for (const d of days){
      if (d.t >= 20.0 && d.t <= 26.0 && d.h >= 30.0 && d.h <= 60.0) compliantDays++;
      const isMold = (d.h > 60.0 && d.t >= 20.0 && d.t <= 30.0);
      if (isMold){
        moldHighDays++;
        moldStreak++;
        if (moldStreak > moldMaxStreak) moldMaxStreak = moldStreak;
      } else {
        moldStreak = 0;
      }
      if (d.h > 65.0 && d.t >= 20.0 && d.t <= 30.0) moldStrictDays++;
    }
    const totalDays = days.length;
    const comfortPct = totalDays ? (compliantDays / totalDays) * 100.0 : (comfortNow ? 100.0 : 0.0);
    const moldRiskLevel =
      moldStreak >= 7 ? 'High' :
      moldStreak >= 3 ? 'Elevated' :
      moldStreak >= 1 ? 'Low' : 'Safe';

    // 6. Rolling Averages (7d & 30d) & 7d Volatility (Std Dev)
    const last7  = days.slice(-7);
    const last30 = days.slice(-30);
    const s7T  = meanAndStd(last7.map(d => d.t));
    const s7H  = meanAndStd(last7.map(d => d.h));
    const s7AH = meanAndStd(last7.map(d => d.ah));
    const s30T  = meanAndStd(last30.map(d => d.t));
    const s30H  = meanAndStd(last30.map(d => d.h));
    const s30AH = meanAndStd(last30.map(d => d.ah));

    // 7. Rolling 14-day Z-Score Anomaly Detection (|Z| > 2.5)
    const zAnomalies = [];
    let latestZT = 0, latestZH = 0, latestZAH = 0;
    for (let i = 0; i < days.length; i++){
      const winStart = Math.max(0, i - 14);
      const prior = days.slice(winStart, i);
      if (prior.length < 3) continue;
      const mT  = meanAndStd(prior.map(d => d.t));
      const mH  = meanAndStd(prior.map(d => d.h));
      const mAH = meanAndStd(prior.map(d => d.ah));
      const zT  = (mT.std  > 0.05) ? ((days[i].t  - mT.mean)  / mT.std)  : 0;
      const zH  = (mH.std  > 0.10) ? ((days[i].h  - mH.mean)  / mH.std)  : 0;
      const zAH = (mAH.std > 0.05) ? ((days[i].ah - mAH.mean) / mAH.std) : 0;
      if (i === days.length - 1){
        latestZT = zT; latestZH = zH; latestZAH = zAH;
      }
      const flags = [];
      if (Math.abs(zT)  > 2.5) flags.push('T '  + (zT  >= 0 ? '+' : '') + zT.toFixed(1)  + 'σ');
      if (Math.abs(zH)  > 2.5) flags.push('RH ' + (zH  >= 0 ? '+' : '') + zH.toFixed(1)  + 'σ');
      if (Math.abs(zAH) > 2.5) flags.push('AH ' + (zAH >= 0 ? '+' : '') + zAH.toFixed(1) + 'σ');
      if (flags.length){
        zAnomalies.push({
          day: days[i].day,
          t: Number(days[i].t.toFixed(1)),
          h: Number(days[i].h.toFixed(1)),
          flags: flags.join(', ')
        });
      }
    }

    const r1 = (v) => (v === null || v === undefined || !Number.isFinite(v)) ? null : Number(v.toFixed(1));
    const r2 = (v) => (v === null || v === undefined || !Number.isFinite(v)) ? null : Number(v.toFixed(2));
    return {
      computedBy: 'pwa',
      updatedAt: Math.floor(Date.now() / 1000),
      sourceReadingEpoch: Math.floor((latest.epochMs || Date.now()) / 1000),
      live: {
        temp: r1(liveT),
        hum: r1(liveH),
        vaporPressureHpa: r2(liveVp),
        absHumidity: r2(liveAh),
        enthalpy: r1(liveEnth),
        heatIndex: r1(liveHi),
        comfortNow: comfortNow
      },
      comfort: {
        pct: r1(comfortPct),
        compliantDays: compliantDays,
        totalDays: totalDays
      },
      mold: {
        level: moldRiskLevel,
        streak: moldStreak,
        maxStreak: moldMaxStreak,
        highRiskDays: moldHighDays,
        strictDays: moldStrictDays
      },
      rolling: {
        days7: last7.length,
        days30: last30.length,
        t7: r1(s7T.mean),   h7: r1(s7H.mean),   ah7: r2(s7AH.mean),
        t30: r1(s30T.mean), h30: r1(s30H.mean), ah30: r2(s30AH.mean),
        vol7T: r2(s7T.std), vol7H: r2(s7H.std), vol7AH: r2(s7AH.std)
      },
      zscore: {
        latestT: r2(latestZT),
        latestH: r2(latestZH),
        latestAH: r2(latestZAH),
        anomalyCount: zAnomalies.length,
        anomalies: zAnomalies.slice(-6).reverse()
      }
    };
  }

  async function fetchCloudAnalytics(){
    const host = getHost();
    if (!host) return null;
    try {
      const res = await fetch(appendAuthParam('https://' + host + '/analytics.json'), { cache: 'no-store' });
      if (!res.ok) return null;
      const data = await res.json();
      if (data && typeof data === 'object' && data.live){
        lastCloudAnalytics = data;
        renderAirIntelCard();
        return data;
      }
    } catch(e) {}
    return null;
  }

  async function syncAnalyticsToFirebase(analyticsObj, force){
    const host = getHost();
    if (!host || !analyticsObj) return false;
    const now = Date.now();
    const sig = JSON.stringify({ live: analyticsObj.live, comfort: analyticsObj.comfort, mold: analyticsObj.mold, z: analyticsObj.zscore && analyticsObj.zscore.anomalyCount });
    if (!force && sig === lastPwaAnalyticsSig && (now - lastPwaAnalyticsUploadMs < 60000)) return false;
    try {
      const url = 'https://' + host + '/analytics.json' + getFbAuthParam();
      const res = await fetch(url, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(analyticsObj),
        cache: 'no-store'
      });
      if (res.ok){
        lastPwaAnalyticsSig = sig;
        lastPwaAnalyticsUploadMs = now;
        lastCloudAnalytics = analyticsObj;
        return true;
      }
    } catch(e) {}
    return false;
  }

  function triggerAnalyticsCompute(){
    if (lastDeviceOnline === true){
      sendCloudCommand({ action: 'recomputeAnalytics' }, 'Computing 7 air metrics on ESP32…', 'air-intel');
    } else {
      const local = computeAllSevenMetrics(getValidSorted());
      if (!local){ showToast('No readings loaded yet'); return; }
      renderAirIntelCard(local);
      syncAnalyticsToFirebase(local, true).then(ok => {
        showToast(ok ? '7 metrics computed & synced to Firebase' : 'Computed locally (Firebase sync failed)');
      });
    }
  }

  function renderAirIntelCard(overrideObj){
    const summaryEl = document.getElementById('air-intel-summary');
    const detailEl  = document.getElementById('air-intel-detail');
    const srcPill   = document.getElementById('air-intel-src-pill');
    const actBtn    = document.getElementById('btn-air-intel-compute');
    if (!summaryEl || !detailEl) return;

    const espOnline = (lastDeviceOnline === true);
    const localCalc = computeAllSevenMetrics(typeof getValidSorted === 'function' ? getValidSorted() : []);
    let data = overrideObj || null;
    let srcLabel = 'Waiting';
    let srcCls = '';

    if (!data){
      if (espOnline && lastCloudAnalytics && lastCloudAnalytics.computedBy === 'esp32'){
        // ESP32 is online and publishing analytics! Merge multi-day rolling stats from PWA if ESP32 only has 1 day so far.
        data = Object.assign({}, lastCloudAnalytics);
        if (localCalc && localCalc.comfort && lastCloudAnalytics.comfort &&
            localCalc.comfort.totalDays > (lastCloudAnalytics.comfort.totalDays || 0)){
          data = Object.assign({}, lastCloudAnalytics, {
            comfort: localCalc.comfort,
            mold: localCalc.mold,
            rolling: localCalc.rolling,
            zscore: localCalc.zscore,
            computedBy: 'esp32+pwa'
          });
          srcLabel = 'ESP32 Live';
          srcCls = 'ok';
        } else {
          srcLabel = 'ESP32';
          srcCls = 'ok';
        }
      } else if (!espOnline && localCalc){
        // ESP32 is offline -> compute in PWA and sync to Firebase /analytics.json!
        data = localCalc;
        srcLabel = 'PWA Sync';
        srcCls = 'warn';
        syncAnalyticsToFirebase(localCalc, false);
      } else if (lastCloudAnalytics){
        data = lastCloudAnalytics;
        srcLabel = lastCloudAnalytics.computedBy === 'esp32' ? 'ESP32 Cached' : 'Cloud Sync';
        srcCls = 'ok';
      } else if (localCalc){
        data = localCalc;
        srcLabel = 'PWA Live';
        srcCls = 'warn';
        if (lastDeviceOnline === false) syncAnalyticsToFirebase(localCalc, false);
      }
    } else {
      srcLabel = data.computedBy === 'esp32' ? 'ESP32' : 'PWA Sync';
      srcCls = data.computedBy === 'esp32' ? 'ok' : 'warn';
    }

    if (srcPill){
      srcPill.textContent = srcLabel;
      srcPill.className = 'status-pill ' + srcCls;
    }
    if (actBtn){
      actBtn.textContent = espOnline ? 'Compute on ESP32' : 'Compute & Sync to Firebase';
    }

    if (!data || !data.live){
      summaryEl.innerHTML = '<div class="ota-meta" style="margin:0;">Waiting for sensor readings to calculate the 7 air metrics…</div>';
      detailEl.innerHTML = '';
      return;
    }

    const lv = data.live;
    const cf = data.comfort || {};
    const ml = data.mold || {};
    const rl = data.rolling || {};
    const zs = data.zscore || {};

    const moldCls = ml.level === 'High' ? 'err' : (ml.level === 'Elevated' || ml.level === 'Low' ? 'warn' : 'ok');
    const enthDesc = lv.enthalpy >= 65 ? 'Heavy AC load' : (lv.enthalpy >= 52 ? 'Warm / humid' : (lv.enthalpy >= 38 ? 'Comfortable' : 'Cool / dry'));
    const fmt = (v, unit) => (v !== null && v !== undefined && Number.isFinite(Number(v))) ? (Number(v).toFixed(1) + unit) : '—';
    const fmt2 = (v, unit) => (v !== null && v !== undefined && Number.isFinite(Number(v))) ? (Number(v).toFixed(2) + unit) : '—';

    // Always-visible Minimal 4-Tile Headline Strip
    summaryEl.innerHTML =
      '<div class="storage-sub-grid" style="margin-top:0;">' +
        '<div class="storage-mini"><div class="storage-mini-label">Absolute Humidity</div><div class="storage-mini-val">' + fmt2(lv.absHumidity, ' g/m³') + '</div></div>' +
        '<div class="storage-mini"><div class="storage-mini-label">Enthalpy (AC Load)</div><div class="storage-mini-val">' + fmt(lv.enthalpy, ' kJ/kg') + '</div></div>' +
        '<div class="storage-mini"><div class="storage-mini-label">Heat Index (Feels)</div><div class="storage-mini-val">' + fmt(lv.heatIndex, '°C') + '</div></div>' +
        '<div class="storage-mini"><div class="storage-mini-label">Mold Risk Index</div><div class="storage-mini-val">' + escapeHtml(ml.level || 'Safe') + ' · ' + (Number(ml.streak) || 0) + 'd</div></div>' +
      '</div>';

    // Full 7-Metric Breakdown inside Expandable Drawer
    const cfPct = Math.max(0, Math.min(100, Number(cf.pct || 0)));
    const zList = Array.isArray(zs.anomalies) && zs.anomalies.length
      ? '<div class="telem-reset-list">' + zs.anomalies.map(a =>
          '<div class="telem-reset-item"><span><b>' + escapeHtml(a.day) + '</b> · ' + escapeHtml(String(a.t)) + '°C / ' + escapeHtml(String(a.h)) + '%</span><span>' + escapeHtml(a.flags) + '</span></div>'
        ).join('') + '</div>'
      : '<div class="ota-meta" style="margin:6px 0 0;">No daily Z-score anomalies (|Z| &gt; 2.5) in loaded history.</div>';

    const updatedStr = data.updatedAt ? timeAgo(Math.max(0, Date.now() - Number(data.updatedAt) * 1000)) : 'just now';
    const byStr = data.computedBy === 'esp32' ? 'ESP32 hardware' : (data.computedBy === 'esp32+pwa' ? 'ESP32 live + PWA history' : 'PWA (ESP32 offline) → synced to Firebase');

    detailEl.innerHTML =
      '<div class="storage-bars">' +
        '<div class="storage-block">' +
          '<div class="storage-row-head"><span>4. Comfort Zone Compliance (ASHRAE 55)</span>' +
          '<span class="storage-row-val">' + cfPct.toFixed(0) + '% · ' + (Number(cf.compliantDays) || 0) + '/' + (Number(cf.totalDays) || 0) + ' days</span></div>' +
          '<div class="storage-track"><div class="storage-fill ram" style="transform:scaleX(' + (cfPct / 100).toFixed(3) + ')"></div></div>' +
          '<div class="storage-sub-grid">' +
            '<div class="storage-mini"><div class="storage-mini-label">Current Room Status</div><div class="storage-mini-val">' + (lv.comfortNow ? 'In Comfort Zone' : 'Outside (20–26°C, 30–60%)') + '</div></div>' +
            '<div class="storage-mini"><div class="storage-mini-label">Vapor Pressure / Load</div><div class="storage-mini-val">' + fmt2(lv.vaporPressureHpa, ' hPa') + ' · ' + escapeHtml(enthDesc) + '</div></div>' +
          '</div>' +
        '</div>' +

        '<div class="storage-block">' +
          '<div class="storage-row-head"><span>5. Mold Risk Index (RH &gt; 60%, 20–30°C)</span>' +
          '<span class="status-pill ' + moldCls + '" style="margin-left:auto;">' + escapeHtml(ml.level || 'Safe') + '</span></div>' +
          '<div class="storage-sub-grid">' +
            '<div class="storage-mini"><div class="storage-mini-label">Current Streak</div><div class="storage-mini-val">' + (Number(ml.streak) || 0) + ' day(s)</div></div>' +
            '<div class="storage-mini"><div class="storage-mini-label">Longest Streak</div><div class="storage-mini-val">' + (Number(ml.maxStreak) || 0) + ' day(s)</div></div>' +
            '<div class="storage-mini"><div class="storage-mini-label">High-Risk Days (&gt;60%)</div><div class="storage-mini-val">' + (Number(ml.highRiskDays) || 0) + '</div></div>' +
            '<div class="storage-mini"><div class="storage-mini-label">Strict Days (&gt;65%)</div><div class="storage-mini-val">' + (Number(ml.strictDays) || 0) + '</div></div>' +
          '</div>' +
        '</div>' +

        '<div class="storage-block">' +
          '<div class="storage-row-head"><span>6. Rolling Averages &amp; 7d Volatility</span>' +
          '<span class="storage-row-val">' + (Number(rl.days7) || 0) + 'd / ' + (Number(rl.days30) || 0) + 'd window</span></div>' +
          '<div class="storage-sub-grid">' +
            '<div class="storage-mini"><div class="storage-mini-label">Temp 7d / 30d Mean</div><div class="storage-mini-val">' + fmt(rl.t7, '°C') + ' / ' + fmt(rl.t30, '°C') + '</div></div>' +
            '<div class="storage-mini"><div class="storage-mini-label">Temp 7d Volatility (σ)</div><div class="storage-mini-val">±' + fmt2(rl.vol7T, '°C') + '</div></div>' +
            '<div class="storage-mini"><div class="storage-mini-label">RH 7d / 30d Mean</div><div class="storage-mini-val">' + fmt(rl.h7, '%') + ' / ' + fmt(rl.h30, '%') + '</div></div>' +
            '<div class="storage-mini"><div class="storage-mini-label">RH 7d Volatility (σ)</div><div class="storage-mini-val">±' + fmt2(rl.vol7H, '%') + '</div></div>' +
            '<div class="storage-mini"><div class="storage-mini-label">AH 7d / 30d Mean</div><div class="storage-mini-val">' + fmt2(rl.ah7, ' g/m³') + ' / ' + fmt2(rl.ah30, ' g/m³') + '</div></div>' +
            '<div class="storage-mini"><div class="storage-mini-label">AH 7d Volatility (σ)</div><div class="storage-mini-val">±' + fmt2(rl.vol7AH, ' g/m³') + '</div></div>' +
          '</div>' +
        '</div>' +

        '<div class="storage-block">' +
          '<div class="storage-row-head"><span>7. 14-Day Rolling Z-Score Anomalies (|Z| &gt; 2.5)</span>' +
          '<span class="storage-row-val">' + (Number(zs.anomalyCount) || 0) + ' flagged</span></div>' +
          '<div class="storage-sub-grid">' +
            '<div class="storage-mini"><div class="storage-mini-label">Latest Z (Temp / RH)</div><div class="storage-mini-val">' + fmt2(zs.latestT, 'σ') + ' / ' + fmt2(zs.latestH, 'σ') + '</div></div>' +
            '<div class="storage-mini"><div class="storage-mini-label">Latest Z (Abs. Hum)</div><div class="storage-mini-val">' + fmt2(zs.latestAH, 'σ') + '</div></div>' +
          '</div>' +
          zList +
        '</div>' +
      '</div>' +
      '<div class="ota-meta" style="margin-top:8px;">Source: <b>' + escapeHtml(byStr) + '</b> · updated ' + escapeHtml(updatedStr) + '</div>';
  }

  setTimeout(() => { fetchCloudAnalytics(); }, 1600);
