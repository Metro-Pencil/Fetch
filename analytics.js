  // ---------- Air Intelligence: 7 Psychrometric & Statistical Metrics + Plain-English Advice & Visuals (v3.12.0) ----------
  const STD_PRESSURE_HPA = 1013.25;
  let lastCloudAnalytics = null;
  let lastRenderedAnalytics = null;
  let activeAdviceTopic = '';
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
    if (R > 85.0 && T >= 80.0 && T <= 87.0){
      hiF += ((R - 85.0) / 10.0) * ((87.0 - T) / 5.0);
    }
    return (hiF - 32.0) / 1.8;
  }

  function localDayKeyFromMs(ms){
    const d = new Date(ms);
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
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

  function meanStd(arr){ return meanAndStd(arr); }
  function isComfortCompliant(t, rh){ return t >= 20.0 && t <= 26.0 && rh >= 30.0 && rh <= 60.0; }

  // Incremental daily cache: completed past calendar days (day < today) are frozen in localStorage
  // keyed by sample count so already-computed historical days are never redundantly re-averaged.
  const FROZEN_DAILY_LS = 'rl_frozen_daily_cache_v1';
  let frozenDailyCache = null;

  function loadFrozenDailyCache(){
    if (frozenDailyCache) return frozenDailyCache;
    try {
      const obj = JSON.parse(localStorage.getItem(FROZEN_DAILY_LS) || '{}');
      frozenDailyCache = (obj && typeof obj === 'object') ? obj : {};
    } catch(e) { frozenDailyCache = {}; }
    return frozenDailyCache;
  }

  function saveFrozenDailyCache(cache){
    const keys = Object.keys(cache).sort();
    if (keys.length > 90){
      for (let i = 0; i < keys.length - 90; i++) delete cache[keys[i]];
    }
    try { localStorage.setItem(FROZEN_DAILY_LS, JSON.stringify(cache)); } catch(e) {}
  }

  function aggregateDaily(validReadings){
    const rows = Array.isArray(validReadings) ? validReadings : [];
    const todayKey = localDayKeyFromMs(Date.now());
    const cache = loadFrozenDailyCache();
    const countsByDay = new Map();
    for (const r of rows){
      const tv = (r && r.temp !== undefined) ? r.temp : (r ? r.t : NaN);
      const hv = (r && r.hum !== undefined) ? r.hum : (r ? r.h : NaN);
      if (!r || !Number.isFinite(tv) || !Number.isFinite(hv) || !r.epochMs) continue;
      const day = localDayKeyFromMs(r.epochMs);
      countsByDay.set(day, (countsByDay.get(day) || 0) + 1);
    }

    const skipDays = new Set();
    for (const [day, cnt] of countsByDay.entries()){
      if (day < todayKey && cache[day] && cache[day].n === cnt){
        skipDays.add(day);
      }
    }

    const byDay = new Map();
    for (const r of rows){
      const tv = (r && r.temp !== undefined) ? r.temp : (r ? r.t : NaN);
      const hv = (r && r.hum !== undefined) ? r.hum : (r ? r.h : NaN);
      if (!r || !Number.isFinite(tv) || !Number.isFinite(hv) || !r.epochMs) continue;
      const day = localDayKeyFromMs(r.epochMs);
      if (skipDays.has(day)) continue;
      let b = byDay.get(day);
      if (!b){ b = { day, tSum: 0, hSum: 0, ahSum: 0, n: 0, okN: 0, minT: tv, maxT: tv, minH: hv, maxH: hv }; byDay.set(day, b); }
      b.tSum += tv; b.hSum += hv; b.ahSum += calcAbsoluteHumidity(tv, hv); b.n++;
      if (isComfortCompliant(tv, hv)) b.okN++;
      if (tv < b.minT) b.minT = tv; if (tv > b.maxT) b.maxT = tv;
      if (hv < b.minH) b.minH = hv; if (hv > b.maxH) b.maxH = hv;
    }

    let cacheDirty = false;
    const result = [];
    const allDays = new Set([...skipDays, ...byDay.keys()]);
    for (const day of Array.from(allDays).sort((a, b) => a.localeCompare(b))){
      if (skipDays.has(day)){
        result.push(cache[day]);
      } else {
        const b = byDay.get(day);
        const row = {
          day: b.day,
          tAvg: b.tSum / b.n,
          hAvg: b.hSum / b.n,
          ahAvg: b.ahSum / b.n,
          minT: b.minT, maxT: b.maxT, minH: b.minH, maxH: b.maxH,
          n: b.n,
          okN: b.okN
        };
        result.push(row);
        if (day < todayKey){
          cache[day] = row;
          cacheDirty = true;
        }
      }
    }
    if (cacheDirty) saveFrozenDailyCache(cache);
    return result;
  }

  // Seasonal Shift Classifier (combines 7d vs 30d trend + current month + live temp/moisture)
  function classifySeasonShift(data){
    const lv = (data && data.live) || {};
    const rl = (data && data.rolling) || {};
    const tNow = Number(lv.temp ?? rl.t7 ?? 24);
    const hNow = Number(lv.hum ?? rl.h7 ?? 50);
    const ahNow = Number(lv.absHumidity ?? rl.ah7 ?? 10);
    const t7 = (rl.t7 !== null && rl.t7 !== undefined) ? Number(rl.t7) : tNow;
    const t30 = (rl.t30 !== null && rl.t30 !== undefined) ? Number(rl.t30) : t7;
    const ah7 = (rl.ah7 !== null && rl.ah7 !== undefined) ? Number(rl.ah7) : ahNow;
    const ah30 = (rl.ah30 !== null && rl.ah30 !== undefined) ? Number(rl.ah30) : ah7;
    const dT = t7 - t30;
    const dAH = ah7 - ah30;
    const month = new Date().getMonth() + 1; // 1..12

    let label = 'Steady Climate';
    let tone = 'ok';
    let summary = '';
    const tips = [];

    if (ah7 >= 16.0 || (hNow >= 70 && t7 >= 24 && month >= 6 && month <= 9)){
      label = dAH > 0.8 ? 'Monsoon Building' : (dAH < -0.8 ? 'Monsoon Receding' : 'Peak Monsoon / Humid');
      tone = 'warn';
      summary = 'Heavy moisture in the air (7-day AH ' + ah7.toFixed(1) + ' g/m³, RH ' + hNow.toFixed(0) + '%). Air feels sticky and mold risk rises quickly.';
      tips.push('Run AC in Dry mode for 1–2 hrs/day or use a dehumidifier.');
      tips.push('Keep windows closed during humid afternoons; ventilate briefly after sun warms the air.');
    } else if (t7 <= 18.5){
      if (dT <= -0.6){
        label = 'Winter Deepening';
        tone = 'info';
        summary = 'Room is cold (' + t7.toFixed(1) + '°C 7d avg) and still dropping (' + dT.toFixed(1) + '°C below 30d avg) — heading into peak winter.';
      } else if (dT >= 0.6 && month >= 1 && month <= 4){
        label = 'Winter Leaving';
        tone = 'ok';
        summary = 'Still cool (' + t7.toFixed(1) + '°C), but 7-day average is ' + dT.toFixed(1) + '°C warmer than your 30-day average — winter is easing out.';
      } else {
        label = 'Peak Winter';
        tone = 'info';
        summary = 'Cold and steady at ' + t7.toFixed(1) + '°C (7-day avg). You are right in the heart of winter.';
      }
      tips.push('Let midday sunlight in to passively warm the room; seal door/window drafts before sunset.');
      tips.push('Watch for condensation on cold glass/walls if RH climbs above 60%.');
    } else if (t7 <= 22.5){
      if (dT <= -0.5 || (month >= 10 && month <= 12)){
        label = 'Winter Arriving';
        tone = 'info';
        summary = 'Temperatures are cooling down (' + t7.toFixed(1) + '°C 7d avg vs ' + t30.toFixed(1) + '°C 30d avg) — crisp winter weather is arriving.';
        tips.push('Great natural ventilation window — open windows in the afternoon for fresh, dry air.');
        tips.push('Close windows at night to keep indoor warmth steady and reduce morning chill.');
      } else if (dT >= 0.5 || (month >= 2 && month <= 4)){
        label = 'Winter Leaving / Spring';
        tone = 'ok';
        summary = 'Mild and warming (' + t7.toFixed(1) + '°C 7d avg, +' + Math.max(0, dT).toFixed(1) + '°C vs 30d) — winter is transitioning into spring.';
        tips.push('Ideal comfort season — minimal heating or cooling needed.');
      } else {
        label = 'Cool & Pleasant';
        tone = 'ok';
        summary = 'Cool, comfortable room conditions around ' + t7.toFixed(1) + '°C with minimal seasonal drift.';
        tips.push('Natural cross-ventilation works well to keep indoor air fresh.');
      }
    } else if (t7 >= 30.0){
      if (dT >= 0.5){
        label = 'Peak Summer Heat';
        tone = 'err';
        summary = 'Hot and climbing (' + t7.toFixed(1) + '°C 7d avg, +' + dT.toFixed(1) + '°C above 30d) — peak summer heat load.';
      } else if (dT <= -0.5){
        label = 'Summer Easing';
        tone = 'warn';
        summary = 'Still warm (' + t7.toFixed(1) + '°C), but trending ' + Math.abs(dT).toFixed(1) + '°C cooler than your 30-day average.';
      } else {
        label = 'Peak Summer';
        tone = 'err';
        summary = 'Sustained high heat (' + t7.toFixed(1) + '°C 7d avg). Expect heavy AC cooling demand.';
      }
      tips.push('Draw curtains/blinds on sun-facing windows between 11 AM and 4 PM.');
      tips.push('Pre-cool the room before peak afternoon heat and ventilate only late at night if outdoor air is cooler.');
    } else if (t7 >= 26.5){
      label = dT >= 0.5 ? 'Summer Arriving' : (dT <= -0.5 ? 'Cooling Down' : 'Warm Season');
      tone = 'warn';
      summary = 'Warm indoor trend (' + t7.toFixed(1) + '°C 7d avg vs ' + t30.toFixed(1) + '°C 30d avg).';
      tips.push('Use fans + evening ventilation to delay needing AC; keep blinds closed during direct sun.');
    } else {
      label = dT <= -0.6 ? 'Cooling Trend' : (dT >= 0.6 ? 'Warming Trend' : 'Mild & Balanced');
      tone = 'ok';
      summary = 'Room sits right in the sweet spot (' + t7.toFixed(1) + '°C 7d avg, ' + (dT >= 0 ? '+' : '') + dT.toFixed(1) + '°C vs 30d).';
      tips.push('Conditions are balanced — no major heating or cooling adjustments needed.');
    }
    return { label, tone, summary, tips, dT, dAH };
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

    // Count individual-reading compliance too (so even 1-day views always show a real %)
    let readingCompliant = 0, readingTotal = 0;
    const byDay = new Map();
    for (const e of entries){
      if (typeof e.epochMs !== 'number' || !Number.isFinite(e.temp) || !Number.isFinite(e.hum)) continue;
      readingTotal++;
      if (e.temp >= 20.0 && e.temp <= 26.0 && e.hum >= 30.0 && e.hum <= 60.0) readingCompliant++;
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
      .map(b => ({ day: b.day, t: b.tSum / b.n, h: b.hSum / b.n, ah: b.ahSum / b.n, n: b.n }));

    // 4. Comfort Zone Compliance (%) — ASHRAE 55 (20..26°C AND 30..60% RH)
    let compliantDays = 0;
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
    const dayComfortPct = totalDays ? (compliantDays / totalDays) * 100.0 : (comfortNow ? 100.0 : 0.0);
    const readingComfortPct = readingTotal ? (readingCompliant / readingTotal) * 100.0 : dayComfortPct;
    const moldRiskLevel =
      moldStreak >= 7 ? 'High' :
      moldStreak >= 3 ? 'Elevated' :
      moldStreak >= 1 ? 'Low' : 'Safe';

    // 6. Rolling Averages (7d & 30d) & 7d Volatility
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
    const anomalyDaySet = new Set();
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
        anomalyDaySet.add(days[i].day);
        zAnomalies.push({ day: days[i].day, t: Number(days[i].t.toFixed(1)), h: Number(days[i].h.toFixed(1)), flags: flags.join(', ') });
      }
    }

    const r1 = (v) => (v === null || v === undefined || !Number.isFinite(v)) ? null : Number(v.toFixed(1));
    const r2 = (v) => (v === null || v === undefined || !Number.isFinite(v)) ? null : Number(v.toFixed(2));
    return {
      computedBy: 'pwa',
      updatedAt: Math.floor(Date.now() / 1000),
      sourceReadingEpoch: Math.floor((latest.epochMs || Date.now()) / 1000),
      live: {
        temp: r1(liveT), hum: r1(liveH), vaporPressureHpa: r2(liveVp),
        absHumidity: r2(liveAh), enthalpy: r1(liveEnth), heatIndex: r1(liveHi), comfortNow: comfortNow
      },
      comfort: {
        pct: r1(dayComfortPct),
        readingPct: r1(readingComfortPct),
        compliantDays: compliantDays,
        totalDays: totalDays
      },
      mold: {
        level: moldRiskLevel, streak: moldStreak, maxStreak: moldMaxStreak,
        highRiskDays: moldHighDays, strictDays: moldStrictDays
      },
      rolling: {
        days7: last7.length, days30: last30.length,
        t7: r1(s7T.mean), h7: r1(s7H.mean), ah7: r2(s7AH.mean),
        t30: r1(s30T.mean), h30: r1(s30H.mean), ah30: r2(s30AH.mean),
        vol7T: r2(s7T.std), vol7H: r2(s7H.std), vol7AH: r2(s7AH.std)
      },
      zscore: {
        latestT: r2(latestZT), latestH: r2(latestZH), latestAH: r2(latestZAH),
        anomalyCount: zAnomalies.length, anomalies: zAnomalies.slice(-6).reverse()
      },
      dailySeries: days.slice(-14).map(d => ({
        day: d.day, t: r1(d.t), h: r1(d.h), ah: r2(d.ah), isAnom: anomalyDaySet.has(d.day)
      }))
    };
  }

  // ---------- Plain-English Advice Builder for Any Topic ----------
  function buildAdviceForTopic(topic, data){
    const lv = data.live || {};
    const cf = data.comfort || {};
    const ml = data.mold || {};
    const rl = data.rolling || {};
    const zs = data.zscore || {};
    const t = Number(lv.temp ?? 22);
    const h = Number(lv.hum ?? 50);
    const hi = Number(lv.heatIndex ?? t);
    const ah = Number(lv.absHumidity ?? 10);
    const enth = Number(lv.enthalpy ?? 45);
    const dispComfortPct = (cf.readingPct !== undefined && cf.readingPct !== null && (cf.totalDays || 0) <= 1)
      ? Number(cf.readingPct)
      : Number(cf.pct ?? cf.readingPct ?? 0);

    if (topic === 'feels'){
      const diff = hi - t;
      let plain = 'Your room is ' + t.toFixed(1) + '°C and feels like ' + hi.toFixed(1) + '°C. ';
      const tips = [];
      if (hi >= 32){
        plain += 'High heat + humidity makes it hard for sweat to evaporate, so the room feels oppressive.';
        tips.push('Turn on AC (Cool or Dry mode) or increase fan airflow across the room.');
        tips.push('Keep curtains closed on sun-facing windows and stay hydrated.');
      } else if (hi >= 27){
        plain += diff >= 1.0 ? ('Humidity adds +' + diff.toFixed(1) + '°C to how warm it feels.') : 'Warm air — noticeably above the 20–26°C comfort band.';
        tips.push('A ceiling/desk fan or brief evening cross-ventilation will make it feel 2–3°C cooler.');
      } else if (hi >= 20){
        plain += 'Right inside the ideal human thermal comfort range.';
        tips.push('No cooling or heating needed — keep light ventilation if RH rises above 60%.');
      } else {
        plain += 'Cooler than the 20–26°C standard comfort band.';
        tips.push('Close drafts/windows after sunset and let midday sunlight warm the space.');
      }
      return {
        title: 'Feels Like & Cooling Load',
        plain, tips,
        tech: 'Heat Index: ' + hi.toFixed(1) + '°C · Enthalpy: ' + enth.toFixed(1) + ' kJ/kg · Abs. Humidity: ' + ah.toFixed(2) + ' g/m³'
      };
    }

    if (topic === 'comfort'){
      const reasons = [];
      if (t < 20) reasons.push('too cool (' + t.toFixed(1) + '°C vs 20–26°C)');
      else if (t > 26) reasons.push('too warm (' + t.toFixed(1) + '°C vs 20–26°C)');
      if (h < 30) reasons.push('too dry (' + h.toFixed(0) + '% vs 30–60%)');
      else if (h > 60) reasons.push('too humid (' + h.toFixed(0) + '% vs 30–60%)');

      const plain = lv.comfortNow
        ? ('Right now your room is INSIDE the ideal comfort zone (20–26°C, 30–60% RH). Overall compliance is ' + dispComfortPct.toFixed(0) + '%.')
        : ('Right now your room is outside the comfort zone because it is ' + reasons.join(' and ') + '. Overall compliance is ' + dispComfortPct.toFixed(0) + '%.');
      const tips = [];
      if (h > 60) tips.push('Lower humidity below 60%: run AC Dry mode for 30–60 min or ventilate when outdoor air is drier.');
      if (h < 30) tips.push('Air is dry — a small humidifier or open water bowl helps prevent dry throat/skin.');
      if (t > 26) tips.push('Shade windows during peak sun and cool down toward 24–25°C.');
      if (t < 20) tips.push('Seal cold window/door drafts and let afternoon sun warm the room.');
      if (!tips.length) tips.push('Keep current ventilation/AC settings — your room is right in the ASHRAE 55 sweet spot.');
      return {
        title: 'Comfort Zone Compliance (' + dispComfortPct.toFixed(0) + '%)',
        plain, tips,
        tech: 'Readings in zone: ' + (cf.readingPct !== undefined ? Number(cf.readingPct).toFixed(0) + '%' : '—') + ' · Full compliant days: ' + (cf.compliantDays || 0) + '/' + (cf.totalDays || 0) + ' (' + Number(cf.pct || 0).toFixed(0) + '%)'
      };
    }

    if (topic === 'mold'){
      const lvl = ml.level || 'Safe';
      const st = Number(ml.streak || 0);
      let plain = '';
      const tips = [];
      if (lvl === 'High'){
        plain = 'HIGH MOLD RISK: Humidity has stayed above 60% in the 20–30°C growth zone for ' + st + ' consecutive days. Mold spores can actively colonize walls, closets, and fabric.';
        tips.push('Run AC in Dry/Dehumidify mode or a dehumidifier until RH drops below 55%.');
        tips.push('Pull beds, wardrobes, and electronics at least 5–8 cm away from exterior walls for airflow.');
        tips.push('Stop drying damp towels/clothes indoors and keep bathroom/kitchen exhaust fans running.');
        tips.push('Check dark corners, behind curtains, and shoe racks for musty odors or early spots.');
      } else if (lvl === 'Elevated'){
        plain = 'ELEVATED MOLD RISK: ' + st + ' straight days above 60% RH in warm air. A few more damp days will push this into active mold growth territory.';
        tips.push('Break the streak today: ventilate during the driest midday hours or run AC Dry mode for 1 hour.');
        tips.push('Keep closet doors cracked open slightly so stagnant damp air can circulate.');
      } else if (lvl === 'Low'){
        plain = 'LOW MOLD RISK: Short ' + st + '-day humidity bump above 60%. A 1–2 day spike rarely grows mold if the room dries back out.';
        tips.push('Air out the room when outdoor air is drier so humidity drops back under 60%.');
      } else {
        plain = 'SAFE: Humidity is below the 60% mold threshold (0-day streak). Conditions do not support mold growth.';
        tips.push('Keep RH between 35–55% to stay comfortably mold-free.');
      }
      return {
        title: 'Mold Risk: ' + lvl + ' (' + st + 'd streak)',
        plain, tips,
        tech: 'Current streak: ' + st + 'd · Longest streak: ' + (ml.maxStreak || 0) + 'd · >60% days: ' + (ml.highRiskDays || 0) + ' · Strict >65% days: ' + (ml.strictDays || 0)
      };
    }

    if (topic === 'season'){
      const s = classifySeasonShift(data);
      return {
        title: 'Seasonal Shift: ' + s.label,
        plain: s.summary,
        tips: s.tips,
        tech: '7d vs 30d Temp: ' + (rl.t7 ?? '—') + '°C vs ' + (rl.t30 ?? '—') + '°C (' + (s.dT >= 0 ? '+' : '') + s.dT.toFixed(1) + '°C) · 7d vs 30d AH: ' + (rl.ah7 ?? '—') + ' vs ' + (rl.ah30 ?? '—') + ' g/m³'
      };
    }

    // 'trends' — Rolling Averages, Volatility & Z-Score Anomalies
    const volT = Number(rl.vol7T || 0);
    const stabWord = volT < 0.8 ? 'very steady (good insulation / consistent climate)' : (volT < 1.8 ? 'normal day-to-day swings' : 'high day-to-day swings (drafty windows, weather shifts, or heavy AC on/off cycling)');
    const anomCnt = Number(zs.anomalyCount || 0);
    const plain = 'Your room\'s 7-day stability is ' + stabWord + ' (±' + volT.toFixed(2) + '°C). ' +
      (anomCnt > 0
        ? (anomCnt + ' unusual day(s) stood out sharply (>2.5σ from the prior 14-day norm) — usually caused by an AC left off/on, an open window, a sudden weather front, or sensor drift.')
        : 'No unusual anomaly days (>2.5σ) detected over your rolling 14-day baseline.');
    const tips = [
      '7-day vs 30-day average shows whether your room is warming up, cooling down, or holding steady across weeks.',
      '7-day volatility (σ) measures how bumpy day-to-day temperatures are — lower σ means better insulation and steadier comfort.',
      '14-day Z-score flags days that break your normal pattern (|Z| > 2.5) so you can spot forgotten windows, AC faults, or weather shocks.'
    ];
    return {
      title: 'Trends, Volatility & Anomalies',
      plain, tips,
      tech: '7d σ: ±' + volT.toFixed(2) + '°C / ±' + Number(rl.vol7H || 0).toFixed(1) + '%RH · Latest Z: T ' + Number(zs.latestT || 0).toFixed(2) + 'σ, RH ' + Number(zs.latestH || 0).toFixed(2) + 'σ'
    };
  }

  function openIntelAdvice(topic){
    const sheet = document.getElementById('intel-advice-sheet');
    if (!sheet || !lastRenderedAnalytics) return;
    if (activeAdviceTopic === topic && sheet.classList.contains('show')){
      closeIntelAdvice();
      return;
    }
    activeAdviceTopic = topic;
    const info = buildAdviceForTopic(topic, lastRenderedAnalytics);
    document.getElementById('intel-advice-title').textContent = info.title;
    document.getElementById('intel-advice-plain').textContent = info.plain;
    document.getElementById('intel-advice-tips').innerHTML = info.tips.map(t => '<li>' + escapeHtml(t) + '</li>').join('');
    document.getElementById('intel-advice-tech').textContent = info.tech;
    sheet.classList.add('show');
    document.querySelectorAll('#hero-intel-strip .intel-chip').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.topic === topic);
    });
  }

  function closeIntelAdvice(){
    activeAdviceTopic = '';
    const sheet = document.getElementById('intel-advice-sheet');
    if (sheet) sheet.classList.remove('show');
    document.querySelectorAll('#hero-intel-strip .intel-chip').forEach(btn => btn.classList.remove('active'));
  }

  // ---------- Lightweight Inline SVG Visualizers (60fps, Zero Extra Libraries) ----------
  function buildComfortMapSvg(data){
    const W = 320, H = 148, padL = 30, padR = 10, padT = 10, padB = 22;
    const pw = W - padL - padR, ph = H - padT - padB;
    const tMin = 10, tMax = 40, hMin = 15, hMax = 95;
    const xOf = (t) => padL + Math.max(0, Math.min(1, (t - tMin) / (tMax - tMin))) * pw;
    const yOf = (h) => padT + (1 - Math.max(0, Math.min(1, (h - hMin) / (hMax - hMin)))) * ph;

    // Comfort Zone box: 20..26°C, 30..60%
    const cx1 = xOf(20), cx2 = xOf(26), cy1 = yOf(60), cy2 = yOf(30);
    // Mold Zone box: 20..30°C, 60..95%
    const mx1 = xOf(20), mx2 = xOf(30), my1 = yOf(95), my2 = yOf(60);

    const trail = (data.dailySeries || []).slice(-10).map(d =>
      '<circle cx="' + xOf(d.t).toFixed(1) + '" cy="' + yOf(d.h).toFixed(1) + '" r="2.6" fill="rgba(125,196,228,0.55)"/>'
    ).join('');

    const lx = xOf(Number(data.live.temp)), ly = yOf(Number(data.live.hum));
    const liveCol = data.live.comfortNow ? '#4ADE80' : (Number(data.live.hum) > 60 ? '#FB7185' : '#F5A66B');

    return '<div class="intel-viz-box">' +
      '<div class="intel-viz-title"><span>Comfort &amp; Mold Zone Map (Temp vs RH)</span><span>● Live: ' + data.live.temp + '°C / ' + data.live.hum + '%</span></div>' +
      '<svg class="intel-viz-svg" viewBox="0 0 ' + W + ' ' + H + '">' +
        '<rect x="' + padL + '" y="' + padT + '" width="' + pw + '" height="' + ph + '" rx="6" fill="rgba(255,255,255,0.02)" stroke="rgba(148,163,184,0.18)"/>' +
        '<rect x="' + mx1.toFixed(1) + '" y="' + my1.toFixed(1) + '" width="' + (mx2 - mx1).toFixed(1) + '" height="' + (my2 - my1).toFixed(1) + '" fill="rgba(251,113,133,0.15)" stroke="rgba(251,113,133,0.45)" stroke-dasharray="3 2"/>' +
        '<text x="' + (mx1 + 4).toFixed(1) + '" y="' + (my1 + 11).toFixed(1) + '" fill="#FB7185" font-size="8.5" font-family="IBM Plex Mono,monospace">Mold Risk</text>' +
        '<rect x="' + cx1.toFixed(1) + '" y="' + cy1.toFixed(1) + '" width="' + (cx2 - cx1).toFixed(1) + '" height="' + (cy2 - cy1).toFixed(1) + '" fill="rgba(74,222,128,0.16)" stroke="rgba(74,222,128,0.65)"/>' +
        '<text x="' + (cx1 + 4).toFixed(1) + '" y="' + (cy1 + 11).toFixed(1) + '" fill="#4ADE80" font-size="8.5" font-family="IBM Plex Mono,monospace">Comfort</text>' +
        trail +
        '<circle cx="' + lx.toFixed(1) + '" cy="' + ly.toFixed(1) + '" r="7" fill="' + liveCol + '" opacity="0.22"/>' +
        '<circle cx="' + lx.toFixed(1) + '" cy="' + ly.toFixed(1) + '" r="4" fill="' + liveCol + '" stroke="#FFFFFF" stroke-width="1.3"/>' +
        '<text x="' + padL + '" y="' + (H - 5) + '" fill="var(--muted)" font-size="8.5" font-family="IBM Plex Mono,monospace">10°C</text>' +
        '<text x="' + xOf(25).toFixed(1) + '" y="' + (H - 5) + '" fill="var(--muted)" font-size="8.5" text-anchor="middle" font-family="IBM Plex Mono,monospace">25°C</text>' +
        '<text x="' + (W - padR) + '" y="' + (H - 5) + '" fill="var(--muted)" font-size="8.5" text-anchor="end" font-family="IBM Plex Mono,monospace">40°C</text>' +
        '<text x="4" y="' + (yOf(90) + 3).toFixed(1) + '" fill="var(--muted)" font-size="8.5" font-family="IBM Plex Mono,monospace">90%</text>' +
        '<text x="4" y="' + (yOf(55) + 3).toFixed(1) + '" fill="var(--muted)" font-size="8.5" font-family="IBM Plex Mono,monospace">55%</text>' +
        '<text x="4" y="' + (yOf(20) + 3).toFixed(1) + '" fill="var(--muted)" font-size="8.5" font-family="IBM Plex Mono,monospace">20%</text>' +
      '</svg></div>';
  }

  function buildTrendSparklineSvg(data){
    const pts = data.dailySeries || [];
    if (pts.length < 2) return '';
    const W = 320, H = 92, padL = 28, padR = 10, padT = 10, padB = 18;
    const pw = W - padL - padR, ph = H - padT - padB;
    const vals = pts.map(p => Number(p.t));
    const lo = Math.min(...vals) - 1.0, hi = Math.max(...vals) + 1.0;
    const span = Math.max(1.5, hi - lo);
    const xOf = (i) => padL + (i / (pts.length - 1)) * pw;
    const yOf = (v) => padT + (1 - (v - lo) / span) * ph;

    const poly = pts.map((p, i) => xOf(i).toFixed(1) + ',' + yOf(p.t).toFixed(1)).join(' ');
    const dots = pts.map((p, i) =>
      '<circle cx="' + xOf(i).toFixed(1) + '" cy="' + yOf(p.t).toFixed(1) + '" r="' + (p.isAnom ? 4.2 : 2.5) +
      '" fill="' + (p.isAnom ? '#FB7185' : '#F5A66B') + '"/>'
    ).join('');

    return '<div class="intel-viz-box">' +
      '<div class="intel-viz-title"><span>Daily Mean Temp Trend (' + pts.length + 'd)</span><span>Red dot = Z-score anomaly</span></div>' +
      '<svg class="intel-viz-svg" viewBox="0 0 ' + W + ' ' + H + '">' +
        '<polyline fill="none" stroke="#F5A66B" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" points="' + poly + '"/>' +
        dots +
        '<text x="2" y="' + (padT + 8) + '" fill="var(--muted)" font-size="8.5" font-family="IBM Plex Mono,monospace">' + hi.toFixed(0) + '°</text>' +
        '<text x="2" y="' + (H - padB) + '" fill="var(--muted)" font-size="8.5" font-family="IBM Plex Mono,monospace">' + lo.toFixed(0) + '°</text>' +
        '<text x="' + padL + '" y="' + (H - 4) + '" fill="var(--muted)" font-size="8.5" font-family="IBM Plex Mono,monospace">' + escapeHtml(pts[0].day.slice(5)) + '</text>' +
        '<text x="' + (W - padR) + '" y="' + (H - 4) + '" fill="var(--muted)" font-size="8.5" text-anchor="end" font-family="IBM Plex Mono,monospace">' + escapeHtml(pts[pts.length - 1].day.slice(5)) + '</text>' +
      '</svg></div>';
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

  function renderTopInsightStrip(data){
    const strip = document.getElementById('hero-intel-strip');
    if (!strip || !data || !data.live) return;
    const lv = data.live;
    const cf = data.comfort || {};
    const ml = data.mold || {};
    const season = classifySeasonShift(data);

    // Use readingPct when only 0-1 full days are loaded so Comfort % is NEVER stuck blank/0% unfairly!
    const dispCfPct = (cf.readingPct !== undefined && cf.readingPct !== null && (cf.totalDays || 0) <= 1)
      ? Math.round(Number(cf.readingPct))
      : Math.round(Number(cf.pct ?? cf.readingPct ?? 0));
    const cfCls = dispCfPct >= 70 ? 'ok' : (dispCfPct >= 35 ? 'warn' : 'err');
    const mlCls = ml.level === 'High' ? 'err' : (ml.level === 'Elevated' || ml.level === 'Low' ? 'warn' : 'ok');
    const hiCls = lv.heatIndex >= 32 ? 'err' : (lv.heatIndex >= 27 ? 'warn' : 'ok');
    const zCnt = Number((data.zscore && data.zscore.anomalyCount) || 0);
    const trCls = zCnt > 0 ? 'warn' : 'info';

    strip.innerHTML =
      '<button type="button" class="intel-chip ' + cfCls + (activeAdviceTopic === 'comfort' ? ' active' : '') + '" data-topic="comfort" onclick="openIntelAdvice(\'comfort\')"><span class="idot"></span>Comfort ' + dispCfPct + '%</button>' +
      '<button type="button" class="intel-chip ' + mlCls + (activeAdviceTopic === 'mold' ? ' active' : '') + '" data-topic="mold" onclick="openIntelAdvice(\'mold\')"><span class="idot"></span>Mold: ' + escapeHtml(ml.level || 'Safe') + '</button>' +
      '<button type="button" class="intel-chip ' + season.tone + (activeAdviceTopic === 'season' ? ' active' : '') + '" data-topic="season" onclick="openIntelAdvice(\'season\')"><span class="idot"></span>' + escapeHtml(season.label) + '</button>' +
      '<button type="button" class="intel-chip ' + hiCls + (activeAdviceTopic === 'feels' ? ' active' : '') + '" data-topic="feels" onclick="openIntelAdvice(\'feels\')"><span class="idot"></span>Feels ' + Number(lv.heatIndex).toFixed(1) + '°C</button>' +
      '<button type="button" class="intel-chip ' + trCls + (activeAdviceTopic === 'trends' ? ' active' : '') + '" data-topic="trends" onclick="openIntelAdvice(\'trends\')"><span class="idot"></span>' + (zCnt ? (zCnt + ' Anomaly') : 'Trends') + '</button>';

    if (activeAdviceTopic){
      const info = buildAdviceForTopic(activeAdviceTopic, data);
      const tEl = document.getElementById('intel-advice-title');
      const pEl = document.getElementById('intel-advice-plain');
      const ulEl = document.getElementById('intel-advice-tips');
      const tcEl = document.getElementById('intel-advice-tech');
      if (tEl) tEl.textContent = info.title;
      if (pEl) pEl.textContent = info.plain;
      if (ulEl) ulEl.innerHTML = info.tips.map(t => '<li>' + escapeHtml(t) + '</li>').join('');
      if (tcEl) tcEl.textContent = info.tech;
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
    let srcLabel = 'Waiting', srcCls = '';

    if (!data){
      if (espOnline && lastCloudAnalytics && lastCloudAnalytics.computedBy === 'esp32'){
        data = Object.assign({}, lastCloudAnalytics);
        if (localCalc){
          // Always attach dailySeries & readingPct for rich visuals + accurate single-day %
          data.dailySeries = localCalc.dailySeries;
          data.comfort = Object.assign({}, data.comfort, { readingPct: localCalc.comfort.readingPct });
          if (localCalc.comfort.totalDays > ((lastCloudAnalytics.comfort && lastCloudAnalytics.comfort.totalDays) || 0)){
            data.comfort = localCalc.comfort;
            data.mold = localCalc.mold;
            data.rolling = localCalc.rolling;
            data.zscore = localCalc.zscore;
            data.computedBy = 'esp32+pwa';
          }
        }
        srcLabel = data.computedBy === 'esp32+pwa' ? 'ESP32 Live' : 'ESP32';
        srcCls = 'ok';
      } else if (!espOnline && localCalc){
        data = localCalc;
        srcLabel = 'PWA Sync';
        srcCls = 'warn';
        syncAnalyticsToFirebase(localCalc, false);
      } else if (lastCloudAnalytics){
        data = Object.assign({}, lastCloudAnalytics);
        if (localCalc){
          data.dailySeries = localCalc.dailySeries;
          data.comfort = Object.assign({}, data.comfort, { readingPct: localCalc.comfort.readingPct });
        }
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

    if (srcPill){ srcPill.textContent = srcLabel; srcPill.className = 'status-pill ' + srcCls; }
    if (actBtn){ actBtn.textContent = espOnline ? 'Compute on ESP32' : 'Compute & Sync to Firebase'; }

    if (!data || !data.live){
      summaryEl.innerHTML = '<div class="ota-meta" style="margin:0;">Waiting for sensor readings to calculate the 7 air metrics…</div>';
      detailEl.innerHTML = '';
      return;
    }

    lastRenderedAnalytics = data;
    renderTopInsightStrip(data);

    const lv = data.live;
    const cf = data.comfort || {};
    const ml = data.mold || {};
    const rl = data.rolling || {};
    const zs = data.zscore || {};
    const season = classifySeasonShift(data);

    const moldCls = ml.level === 'High' ? 'err' : (ml.level === 'Elevated' || ml.level === 'Low' ? 'warn' : 'ok');
    const enthDesc = lv.enthalpy >= 65 ? 'Heavy AC load' : (lv.enthalpy >= 52 ? 'Warm / muggy' : (lv.enthalpy >= 38 ? 'Comfortable air' : 'Cool & crisp'));
    const enthPinPct = Math.max(2, Math.min(98, ((Number(lv.enthalpy || 45) - 20) / 60) * 100));
    const fmt = (v, u) => (v !== null && v !== undefined && Number.isFinite(Number(v))) ? (Number(v).toFixed(1) + u) : '—';
    const fmt2 = (v, u) => (v !== null && v !== undefined && Number.isFinite(Number(v))) ? (Number(v).toFixed(2) + u) : '—';

    // Fixed Comfort Zone Compliance %: show reading-level % when <=1 day, daily % when multi-day (always >= 0..100%)
    const useReadingPct = (cf.readingPct !== undefined && cf.readingPct !== null && (cf.totalDays || 0) <= 1);
    const cfPct = Math.max(0, Math.min(100, Number(useReadingPct ? cf.readingPct : (cf.pct ?? cf.readingPct ?? 0))));
    const cfSub = useReadingPct
      ? (cfPct.toFixed(0) + '% of readings today')
      : (cfPct.toFixed(0) + '% · ' + (Number(cf.compliantDays) || 0) + '/' + (Number(cf.totalDays) || 0) + ' days');

    // Mold 7-day dot strip
    const stCount = Math.min(7, Number(ml.streak || 0));
    const moldDotsHtml = '<div class="mold-dots">' + Array.from({ length: 7 }, (_, i) => {
      if (i >= stCount) return '<span class="mold-dot"></span>';
      const cls = stCount >= 7 ? 'on-high' : (stCount >= 3 ? 'on-elev' : 'on-low');
      return '<span class="mold-dot ' + cls + '"></span>';
    }).join('') + '</div>';

    // Headline 4-tile summary (Plain + Technical)
    summaryEl.innerHTML =
      '<div class="storage-sub-grid" style="margin-top:0;">' +
        '<div class="storage-mini"><div class="storage-mini-label">Comfort Compliance</div><div class="storage-mini-val">' + cfPct.toFixed(0) + '% · ' + (lv.comfortNow ? 'Good' : 'Outside') + '</div></div>' +
        '<div class="storage-mini"><div class="storage-mini-label">Season Trend</div><div class="storage-mini-val">' + escapeHtml(season.label) + '</div></div>' +
        '<div class="storage-mini"><div class="storage-mini-label">Feels Like / Load</div><div class="storage-mini-val">' + fmt(lv.heatIndex, '°C') + ' · ' + escapeHtml(enthDesc) + '</div></div>' +
        '<div class="storage-mini"><div class="storage-mini-label">Mold Risk</div><div class="storage-mini-val">' + escapeHtml(ml.level || 'Safe') + ' · ' + (Number(ml.streak) || 0) + 'd streak</div></div>' +
      '</div>';

    const cfAdvice = buildAdviceForTopic('comfort', data);
    const mlAdvice = buildAdviceForTopic('mold', data);
    const trAdvice = buildAdviceForTopic('trends', data);

    const zList = Array.isArray(zs.anomalies) && zs.anomalies.length
      ? '<div class="telem-reset-list">' + zs.anomalies.map(a =>
          '<div class="telem-reset-item"><span><b>' + escapeHtml(a.day) + '</b> · ' + escapeHtml(String(a.t)) + '°C / ' + escapeHtml(String(a.h)) + '%</span><span>' + escapeHtml(a.flags) + '</span></div>'
        ).join('') + '</div>'
      : '<div class="ota-meta" style="margin:6px 0 0;">No daily Z-score anomalies (|Z| &gt; 2.5) — room has behaved normally.</div>';

    const updatedStr = data.updatedAt ? timeAgo(Math.max(0, Date.now() - Number(data.updatedAt) * 1000)) : 'just now';
    const byStr = data.computedBy === 'esp32' ? 'ESP32 hardware' : (data.computedBy === 'esp32+pwa' ? 'ESP32 live + PWA history' : 'PWA (ESP32 offline) → synced to Firebase');

    detailEl.innerHTML =
      buildComfortMapSvg(data) +
      buildTrendSparklineSvg(data) +
      '<div class="storage-bars" style="margin-top:10px;">' +
        '<div class="storage-block">' +
          '<div class="storage-row-head"><span>1–3. Moisture, AC Load &amp; Feels Like</span>' +
          '<span class="storage-row-val">' + fmt(lv.enthalpy, ' kJ/kg') + ' · ' + escapeHtml(enthDesc) + '</span></div>' +
          '<div class="enth-scale"><div class="enth-pin" style="left:' + enthPinPct.toFixed(1) + '%"></div></div>' +
          '<div class="storage-sub-grid">' +
            '<div class="storage-mini"><div class="storage-mini-label">Absolute Humidity</div><div class="storage-mini-val">' + fmt2(lv.absHumidity, ' g/m³') + '</div></div>' +
            '<div class="storage-mini"><div class="storage-mini-label">Heat Index (Feels)</div><div class="storage-mini-val">' + fmt(lv.heatIndex, '°C') + '</div></div>' +
            '<div class="storage-mini"><div class="storage-mini-label">Vapor Pressure</div><div class="storage-mini-val">' + fmt2(lv.vaporPressureHpa, ' hPa') + '</div></div>' +
            '<div class="storage-mini"><div class="storage-mini-label">Enthalpy (Energy)</div><div class="storage-mini-val">' + fmt(lv.enthalpy, ' kJ/kg') + '</div></div>' +
          '</div>' +
        '</div>' +

        '<div class="storage-block">' +
          '<div class="storage-row-head"><span>4. Comfort Zone Compliance (ASHRAE 55)</span>' +
          '<span class="storage-row-val">' + escapeHtml(cfSub) + '</span></div>' +
          '<div class="storage-track"><div class="storage-fill ram" style="transform:scaleX(' + Math.max(0.02, cfPct / 100).toFixed(3) + ')"></div></div>' +
          '<div class="intel-plain-note">' + escapeHtml(cfAdvice.plain) + '</div>' +
        '</div>' +

        '<div class="storage-block">' +
          '<div class="storage-row-head"><span>5. Mold Risk Index (RH &gt; 60%, 20–30°C)</span>' +
          '<span class="status-pill ' + moldCls + '" style="margin-left:auto;">' + escapeHtml(ml.level || 'Safe') + '</span></div>' +
          moldDotsHtml +
          '<div class="intel-plain-note">' + escapeHtml(mlAdvice.plain) + ' <b>Tip:</b> ' + escapeHtml(mlAdvice.tips[0] || '') + '</div>' +
          '<div class="storage-sub-grid">' +
            '<div class="storage-mini"><div class="storage-mini-label">Current / Max Streak</div><div class="storage-mini-val">' + (Number(ml.streak) || 0) + 'd / ' + (Number(ml.maxStreak) || 0) + 'd</div></div>' +
            '<div class="storage-mini"><div class="storage-mini-label">Risk Days (&gt;60% / &gt;65%)</div><div class="storage-mini-val">' + (Number(ml.highRiskDays) || 0) + ' / ' + (Number(ml.strictDays) || 0) + '</div></div>' +
          '</div>' +
        '</div>' +

        '<div class="storage-block">' +
          '<div class="storage-row-head"><span>6. Season Shift, Rolling Means &amp; Volatility</span>' +
          '<span class="status-pill ' + season.tone + '" style="margin-left:auto;">' + escapeHtml(season.label) + '</span></div>' +
          '<div class="intel-plain-note">' + escapeHtml(season.summary) + ' ' + escapeHtml(trAdvice.plain) + '</div>' +
          '<div class="storage-sub-grid">' +
            '<div class="storage-mini"><div class="storage-mini-label">Temp 7d / 30d Mean</div><div class="storage-mini-val">' + fmt(rl.t7, '°C') + ' / ' + fmt(rl.t30, '°C') + '</div></div>' +
            '<div class="storage-mini"><div class="storage-mini-label">Temp 7d Volatility (σ)</div><div class="storage-mini-val">±' + fmt2(rl.vol7T, '°C') + '</div></div>' +
            '<div class="storage-mini"><div class="storage-mini-label">RH 7d / 30d Mean</div><div class="storage-mini-val">' + fmt(rl.h7, '%') + ' / ' + fmt(rl.h30, '%') + '</div></div>' +
            '<div class="storage-mini"><div class="storage-mini-label">AH 7d / 30d Mean</div><div class="storage-mini-val">' + fmt2(rl.ah7, ' g/m³') + ' / ' + fmt2(rl.ah30, ' g/m³') + '</div></div>' +
          '</div>' +
        '</div>' +

        '<div class="storage-block">' +
          '<div class="storage-row-head"><span>7. 14-Day Z-Score Anomalies (|Z| &gt; 2.5)</span>' +
          '<span class="storage-row-val">' + (Number(zs.anomalyCount) || 0) + ' flagged</span></div>' +
          '<div class="intel-plain-note">Compares each day to the prior 14-day average. A spike above ±2.5σ flags unusual events like an AC fault, open window, weather front, or sensor drift.</div>' +
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

  // ---------- Gemini Flash Daily Room Brief (v3.13.2 — 48h + Live Outdoor Weather/AQI) ----------
  const GEMINI_KEY_LS   = 'rl_gemini_api_key_v1';
  const GEMINI_BRIEF_LS = 'rl_gemini_daily_brief_v1';
  const GEMINI_MODEL_LS = 'rl_gemini_model_v1';
  const CLIMATE_ROLLUP_LS = 'rl_climate_rollup_v1';
  const ROLLUP_INTERVAL_MS = 60 * 60 * 1000; // hourly rollup refresh
  let lastClimateRollup = null;
  let rollupSyncBusy = false;
  const BRIEF_HISTORY_LS = 'rl_gemini_brief_history_v1';
  const HOURLY_48H_LS = 'rl_hourly_48h_cache_v1';
  let lastHourly48hCloud = null;
  let lastSavedDrawerFetchMs = 0;
  function loadLocalHourly48h(){
    if (lastHourly48hCloud) return lastHourly48hCloud;
    try {
      const obj = JSON.parse(localStorage.getItem(HOURLY_48H_LS) || 'null');
      if (obj && Array.isArray(obj.hourly48h)){ lastHourly48hCloud = obj; return obj; }
    } catch(e) {}
    return null;
  }
  let activeSavedTab = 'rollup';
  const PERF_STATS_LS = 'rl_esp_perf_stats_v1';
  let lastEspPerfStats = null;
  const GEMINI_MODELS   = ['gemini-3.5-flash-lite', 'gemini-3.8-flash', 'gemini-3.1-flash-lite'];
  let geminiGenerating  = false;

  async function fetchWithTimeout(url, options, timeoutMs){
    const ms = timeoutMs || 5000;
    const ctrl = (typeof AbortController !== 'undefined') ? new AbortController() : null;
    const timer = ctrl ? setTimeout(() => ctrl.abort(), ms) : null;
    try {
      const opts = Object.assign({}, options || {});
      if (ctrl) opts.signal = ctrl.signal;
      return await fetch(url, opts);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  function getGeminiApiKey(){
    try { return (localStorage.getItem(GEMINI_KEY_LS) || '').trim(); } catch(e) { return ''; }
  }

  function formatGeminiModelLabel(modelId){
    if (!modelId) return 'Gemini Flash';
    return String(modelId)
      .replace(/^models\//, '')
      .replace(/^gemini-/i, 'Gemini ')
      .replace(/-flash-lite\b/i, ' Flash-Lite')
      .replace(/-flash\b/i, ' Flash')
      .replace(/-pro\b/i, ' Pro');
  }

  function getCachedGeminiModel(){
    try {
      const m = (localStorage.getItem(GEMINI_MODEL_LS) || '').trim();
      if (m && !/^gemini-2\.5-flash/i.test(m)) return m;
    } catch(e) {}
    return '';
  }

  function setCachedGeminiModel(modelId){
    if (!modelId) return;
    try { localStorage.setItem(GEMINI_MODEL_LS, modelId); } catch(e) {}
    const badge = document.getElementById('ai-brief-badge');
    if (badge) badge.textContent = formatGeminiModelLabel(modelId);
  }

  function toggleGeminiKeyDrawer(forceShow){
    const dr = document.getElementById('ai-key-drawer');
    if (!dr) return;
    const show = (forceShow !== undefined) ? !!forceShow : !dr.classList.contains('show');
    dr.classList.toggle('show', show);
    const inp = document.getElementById('gemini-api-key');
    if (show && inp){
      inp.value = getGeminiApiKey();
      inp.focus();
    }
  }

  function saveGeminiApiKey(){
    const inp = document.getElementById('gemini-api-key');
    const val = (inp && inp.value ? inp.value : '').trim();
    if (!val || val.length < 15){
      showToast('Enter a valid Google AI Studio API key (starts with AIza…)');
      return;
    }
    try { localStorage.setItem(GEMINI_KEY_LS, val); } catch(e) {}
    toggleGeminiKeyDrawer(false);
    showToast('Gemini API key saved on this device');
    generateGeminiDailyBrief(true);
  }

  function clearGeminiApiKey(){
    try { localStorage.removeItem(GEMINI_KEY_LS); } catch(e) {}
    try { localStorage.removeItem(GEMINI_MODEL_LS); } catch(e) {}
    const inp = document.getElementById('gemini-api-key');
    if (inp) inp.value = '';
    toggleGeminiKeyDrawer(false);
    showToast('Gemini API key cleared');
  }

  function formatAiBriefHtml(rawText){
    const inlineMd = s => escapeHtml(s).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    const lines = String(rawText || '').split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    const blocks = [];
    let curBullets = [];
    const flushBullets = () => {
      if (curBullets.length){
        blocks.push('<ul class="ai-brief-list">' + curBullets.map(b => '<li>' + inlineMd(b) + '</li>').join('') + '</ul>');
        curBullets = [];
      }
    };
    for (const line of lines){
      if (/^#{1,3}\s+/.test(line)){
        flushBullets();
        const heading = line.replace(/^#{1,3}\s+/, '').replace(/\*\*(.*?)\*\*/g, '$1');
        blocks.push('<div class="ai-sec-head">' + escapeHtml(heading) + '</div>');
      } else if (/^[-*•]\s+/.test(line)){
        curBullets.push(line.replace(/^[-*•]\s+/, ''));
      } else {
        flushBullets();
        blocks.push('<p>' + inlineMd(line) + '</p>');
      }
    }
    flushBullets();
    return blocks.join('') || '<p>' + inlineMd(rawText || '') + '</p>';
  }

  function renderCachedAiBrief(briefObj){
    const bodyEl = document.getElementById('ai-brief-body');
    const metaEl = document.getElementById('ai-brief-meta');
    const badgeEl = document.getElementById('ai-brief-badge');
    const activeModel = (briefObj && briefObj.model) || getCachedGeminiModel() || GEMINI_MODELS[0];
    if (badgeEl) badgeEl.textContent = formatGeminiModelLabel(activeModel);
    if (!bodyEl) return;
    if (!briefObj || !briefObj.text){
      const hasKey = !!getGeminiApiKey();
      bodyEl.innerHTML = hasKey
        ? '<div class="ota-meta" style="margin:0;">Tap <b>Refresh Brief</b> to generate a 48-hour room &amp; live outdoor weather brief with ' + escapeHtml(formatGeminiModelLabel(activeModel)) + '.</div>'
        : '<div class="ota-meta" style="margin:0;">Tap <b>API Key</b> to paste your free Google AI Studio key, then tap <b>Refresh Brief</b> for a 48-hour room &amp; outdoor summary.</div>';
      if (metaEl) metaEl.textContent = '';
      return;
    }
    bodyEl.innerHTML = formatAiBriefHtml(briefObj.text);
    if (metaEl){
      const when = briefObj.generatedAt ? timeAgo(Math.max(0, Date.now() - Number(briefObj.generatedAt))) : 'just now';
      const scopeTag = briefObj.outdoorTag ? (' · ' + briefObj.outdoorTag) : '';
      metaEl.textContent = 'Generated ' + when + ' (' + (briefObj.day || '') + ') · ' + (briefObj.model || activeModel) + scopeTag;
    }
  }

  function loadLocalAiBrief(){
    try {
      const saved = JSON.parse(localStorage.getItem(GEMINI_BRIEF_LS) || 'null');
      if (saved && saved.text) return saved;
    } catch(e) {}
    return null;
  }

  async function fetchCloudAiBrief(){
    const host = getHost();
    if (!host) return null;
    try {
      const res = await fetchWithTimeout(appendAuthParam('https://' + host + '/dailyBrief.json'), { cache: 'no-store' }, 4000);
      if (!res.ok) return null;
      const obj = await res.json();
      if (obj && obj.text){
        const local = loadLocalAiBrief();
        if (!local || (obj.generatedAt || 0) > (local.generatedAt || 0)){
          try { localStorage.setItem(GEMINI_BRIEF_LS, JSON.stringify(obj)); } catch(e) {}
          renderCachedAiBrief(obj);
        }
        return obj;
      }
    } catch(e) {}
    return null;
  }

  async function syncAiBriefToFirebase(briefObj){
    const host = getHost();
    if (!host || !briefObj || !briefObj.text) return;
    try {
      // Only sync the generated text/metadata — NEVER the API key!
      await fetch('https://' + host + '/dailyBrief.json' + getFbAuthParam(), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(briefObj),
        cache: 'no-store'
      });
    } catch(e) {}
  }

  // ---------- Hourly Low-Resolution Weekly & Monthly Rollup (/climateRollup.json) ----------
  function computeClimateRollup(validReadings){
    const rows = Array.isArray(validReadings) ? validReadings : [];
    const days = aggregateDaily(rows);
    if (!days.length) return null;
    const recent30 = days.slice(-30);
    const round1 = v => Math.round(v * 10) / 10;
    const round2 = v => Math.round(v * 100) / 100;

    const enriched = recent30.map(d => ({
      day: d.day,
      t: d.tAvg,
      h: d.hAvg,
      ah: d.ahAvg,
      en: calcEnthalpyKjKg(d.tAvg, d.hAvg),
      fl: calcHeatIndexC(d.tAvg, d.hAvg),
      ok: isComfortCompliant(d.tAvg, d.hAvg),
      m60: (d.hAvg > 60 && d.tAvg >= 20 && d.tAvg <= 30),
      m65: (d.hAvg > 65 && d.tAvg >= 20 && d.tAvg <= 30)
    }));

    const summarizePeriod = (slice, includeMaxStreak) => {
      if (!slice.length) return null;
      const ts = slice.map(x => x.t);
      const hs = slice.map(x => x.h);
      const ahs = slice.map(x => x.ah);
      const tStat = meanStd(ts);
      const hStat = meanStd(hs);
      const ahStat = meanStd(ahs);
      const enAvg = slice.reduce((a, x) => a + x.en, 0) / slice.length;
      const flAvg = slice.reduce((a, x) => a + x.fl, 0) / slice.length;
      let okN = 0, m60 = 0, m65 = 0, curSt = 0, maxSt = 0;
      for (const x of slice){
        if (x.ok) okN++;
        if (x.m60){ m60++; curSt++; if (curSt > maxSt) maxSt = curSt; } else { curSt = 0; }
        if (x.m65) m65++;
      }
      const out = {
        days: slice.length,
        tMin: round1(Math.min(...ts)), tAvg: round1(tStat.mean), tMax: round1(Math.max(...ts)),
        rhMin: round1(Math.min(...hs)), rhAvg: round1(hStat.mean), rhMax: round1(Math.max(...hs)),
        ahAvg: round2(ahStat.mean),
        enthalpyAvg: round1(enAvg),
        feelsLikeAvg: round1(flAvg),
        comfortPct: round1((okN / slice.length) * 100),
        moldHighDays: m60,
        moldStrictDays: m65,
        volT: round2(tStat.std),
        volH: round2(hStat.std)
      };
      if (includeMaxStreak) out.maxMoldStreak = maxSt;
      return out;
    };

    const weekly = summarizePeriod(enriched.slice(-7), false);
    const monthly = summarizePeriod(enriched, true);

    const weeklyBuckets = [];
    for (let i = 0; i < enriched.length; i += 7){
      const chunk = enriched.slice(i, i + 7);
      const okN = chunk.filter(x => x.ok).length;
      const mN = chunk.filter(x => x.m60).length;
      weeklyBuckets.push({
        week: 'W' + (weeklyBuckets.length + 1),
        from: chunk[0].day.slice(5),
        to: chunk[chunk.length - 1].day.slice(5),
        days: chunk.length,
        tAvg: round1(chunk.reduce((a, x) => a + x.t, 0) / chunk.length),
        rhAvg: round1(chunk.reduce((a, x) => a + x.h, 0) / chunk.length),
        ahAvg: round2(chunk.reduce((a, x) => a + x.ah, 0) / chunk.length),
        comfortPct: Math.round((okN / chunk.length) * 100),
        moldDays: mN
      });
    }

    const daily30d = enriched.map(x => ({
      d: x.day.slice(5),
      t: round1(x.t),
      h: round1(x.h),
      ah: round1(x.ah),
      ok: x.ok ? 1 : 0,
      m: x.m60 ? 1 : 0
    }));

    return {
      computedBy: 'pwa',
      updatedAt: Date.now(),
      resolution: 'daily-30d+weekly-4w+monthly',
      weekly,
      monthly,
      weeklyBuckets,
      daily30d
    };
  }

  function loadLocalClimateRollup(){
    try {
      const obj = JSON.parse(localStorage.getItem(CLIMATE_ROLLUP_LS) || 'null');
      if (obj && obj.weekly) return obj;
    } catch(e) {}
    return null;
  }

  async function fetchCloudClimateRollup(){
    const host = getHost();
    if (!host) return null;
    try {
      const res = await fetchWithTimeout(appendAuthParam('https://' + host + '/climateRollup.json'), { cache: 'no-store' }, 4000);
      if (!res.ok) return null;
      const obj = await res.json();
      if (obj && obj.weekly){
        lastClimateRollup = obj;
        try { localStorage.setItem(CLIMATE_ROLLUP_LS, JSON.stringify(obj)); } catch(e) {}
        return obj;
      }
    } catch(e) {}
    return null;
  }

  async function syncClimateRollupToFirebase(rollup){
    const host = getHost();
    if (!host || !rollup) return false;
    try {
      const res = await fetch('https://' + host + '/climateRollup.json' + getFbAuthParam(), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(rollup),
        cache: 'no-store'
      });
      return res.ok;
    } catch(e) { return false; }
  }

  // Keeps /climateRollup.json fresh on an hourly cadence when ESP32 is offline (or hasn't updated in >1h)
  async function ensureHourlyClimateRollup(validReadings, force){
    if (rollupSyncBusy) return lastClimateRollup || loadLocalClimateRollup();
    rollupSyncBusy = true;
    try {
      const cloud = await fetchCloudClimateRollup();
      const existing = cloud || lastClimateRollup || loadLocalClimateRollup();
      const ageMs = existing && existing.updatedAt ? (Date.now() - Number(existing.updatedAt)) : Infinity;
      const espOnline = isEspOnlineForAnalytics();
      if (!force && existing && espOnline && ageMs < (ROLLUP_INTERVAL_MS + 5 * 60 * 1000)){
        lastClimateRollup = existing;
        return existing;
      }
      if (!force && existing && ageMs < ROLLUP_INTERVAL_MS){
        lastClimateRollup = existing;
        return existing;
      }
      const rows = Array.isArray(validReadings) && validReadings.length
        ? validReadings
        : (typeof getValidSorted === 'function' ? getValidSorted() : []);
      const computed = computeClimateRollup(rows);
      if (computed){
        lastClimateRollup = computed;
        try { localStorage.setItem(CLIMATE_ROLLUP_LS, JSON.stringify(computed)); } catch(e) {}
        syncClimateRollupToFirebase(computed);
        return computed;
      }
      return existing;
    } finally {
      rollupSyncBusy = false;
    }
  }

  async function fetchCloudHourly48h(){
    const host = getHost();
    if (!host) return null;
    try {
      const res = await fetchWithTimeout(appendAuthParam('https://' + host + '/hourly48h.json'), { cache: 'no-store' }, 4000);
      if (!res.ok) return null;
      const obj = await res.json();
      if (obj && Array.isArray(obj.hourly48h)){
        lastHourly48hCloud = obj;
        try { localStorage.setItem(HOURLY_48H_LS, JSON.stringify(obj)); } catch(e) {}
        return obj;
      }
    } catch(e) {}
    return null;
  }

  function loadBriefHistoryLocal(){
    try {
      const arr = JSON.parse(localStorage.getItem(BRIEF_HISTORY_LS) || '[]');
      return Array.isArray(arr) ? arr : [];
    } catch(e) { return []; }
  }

  async function saveBriefToHistory(briefObj){
    if (!briefObj || !briefObj.text) return;
    let list = loadBriefHistoryLocal().filter(x => x && x.generatedAt !== briefObj.generatedAt);
    list.unshift(briefObj);
    list = list.slice(0, 14);
    try { localStorage.setItem(BRIEF_HISTORY_LS, JSON.stringify(list)); } catch(e) {}
    const host = getHost();
    if (!host) return;
    try {
      await fetch('https://' + host + '/dailyBriefHistory.json' + getFbAuthParam(), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(list),
        cache: 'no-store'
      });
    } catch(e) {}
  }

  async function fetchBriefHistoryCloud(){
    const host = getHost();
    if (!host) return loadBriefHistoryLocal();
    try {
      const res = await fetchWithTimeout(appendAuthParam('https://' + host + '/dailyBriefHistory.json'), { cache: 'no-store' }, 4000);
      if (!res.ok) return loadBriefHistoryLocal();
      const arr = await res.json();
      if (Array.isArray(arr) && arr.length){
        try { localStorage.setItem(BRIEF_HISTORY_LS, JSON.stringify(arr.slice(0, 14))); } catch(e) {}
        return arr.slice(0, 14);
      }
    } catch(e) {}
    return loadBriefHistoryLocal();
  }

  function loadLocalPerfStats(){
    try { return JSON.parse(localStorage.getItem(PERF_STATS_LS) || 'null'); } catch(e) { return null; }
  }

  function updateEspSyncEtaBadge(stats){
    const btn = document.getElementById('btn-ai-esp-sync');
    if (!btn || btn.disabled) return;
    const s = stats || lastEspPerfStats || loadLocalPerfStats();
    const etaMs = (s && s.ewmaTotalMs > 0) ? Number(s.ewmaTotalMs) : 3500;
    const etaStr = (etaMs / 1000).toFixed(1) + 's';
    const suffix = (s && s.samples > 0) ? (' (~' + etaStr + ')') : (' (~' + etaStr + ' est.)');
    btn.textContent = 'Sync on ESP32' + suffix;
  }

  async function fetchCloudPerfStats(){
    const host = getHost();
    if (!host) return loadLocalPerfStats();
    try {
      const res = await fetchWithTimeout(appendAuthParam('https://' + host + '/perfStats.json'), { cache: 'no-store' }, 4000);
      if (!res.ok) return loadLocalPerfStats();
      const obj = await res.json();
      if (obj && (obj.ewmaTotalMs || obj.samples)){
        lastEspPerfStats = obj;
        try { localStorage.setItem(PERF_STATS_LS, JSON.stringify(obj)); } catch(e) {}
        updateEspSyncEtaBadge(obj);
        return obj;
      }
    } catch(e) {}
    updateEspSyncEtaBadge(loadLocalPerfStats());
    return loadLocalPerfStats();
  }

  // Dedicated button: task ESP32 directly to compile & push /analytics.json + /climateRollup.json + /hourly48h.json
  async function triggerEspRollupSync(){
    const btn = document.getElementById('btn-ai-esp-sync');
    if (typeof sendCloudCommand !== 'function'){
      showToast('Cloud command queue unavailable');
      return;
    }
    const etaInfo = (typeof getProcessEtaInfo === 'function') ? getProcessEtaInfo('refreshRollup') : { ms: 3800, learned: false };
    if (btn){ btn.disabled = true; btn.textContent = 'Sending…'; }
    try {
      sendCloudCommand(
        { action: 'refreshRollup' },
        'Syncing 48h & weekly/monthly rollups on ESP32 (' + (typeof formatEtaShort === 'function' ? formatEtaShort(etaInfo.ms, etaInfo.learned) : '~3.8s') + ')…',
        'air-intel'
      );
      const waitMs = Math.max(2500, Math.min(12000, Number(etaInfo.ms || 3800) + 1800));
      setTimeout(async () => {
        await Promise.all([fetchCloudClimateRollup(), fetchCloudHourly48h(), fetchCloudPerfStats()]);
        if (document.getElementById('ai-saved-drawer')?.classList.contains('show')) renderSavedRollupDrawer();
      }, waitMs);
    } finally {
      setTimeout(() => {
        if (btn){ btn.disabled = false; if (typeof refreshAllProcessEtaBadges === 'function') refreshAllProcessEtaBadges(); else updateEspSyncEtaBadge(); }
      }, 900);
    }
  }

  function toggleSavedRollupDrawer(forceShow){
    const dr = document.getElementById('ai-saved-drawer');
    if (!dr) return;
    const show = (forceShow !== undefined) ? !!forceShow : !dr.classList.contains('show');
    dr.classList.toggle('show', show);
    if (show) renderSavedRollupDrawer(false);
  }

  function switchSavedDrawerTab(tab){
    activeSavedTab = tab || 'rollup';
    document.querySelectorAll('#ai-saved-drawer .ai-saved-tab').forEach(b => {
      b.classList.toggle('active', b.dataset.tab === activeSavedTab);
    });
    // 0ms instant tab switch using cached data — zero network fetches!
    paintSavedRollupPane();
  }

  function paintSavedRollupPane(){
    const pane = document.getElementById('ai-saved-pane');
    if (!pane) return;

    let rollup = lastClimateRollup || loadLocalClimateRollup();
    if (!rollup){
      const rows = (typeof getValidSorted === 'function') ? getValidSorted() : [];
      if (rows.length) rollup = computeClimateRollup(rows);
    }
    const h48 = lastHourly48hCloud || loadLocalHourly48h();
    const hist = loadBriefHistoryLocal();
    const perf = lastEspPerfStats || loadLocalPerfStats();

    if (activeSavedTab === 'history'){
      if (!hist || !hist.length){
        pane.innerHTML = '<div class="ota-meta" style="margin:0;">No saved briefs yet. Tap <b>Refresh Brief</b> to generate and archive your first summary.</div>';
        return;
      }
      pane.innerHTML = hist.map(item => {
        const dt = item.generatedAt ? new Date(Number(item.generatedAt)).toLocaleString() : (item.day || '');
        const tag = item.outdoorTag ? (' · ' + item.outdoorTag) : '';
        return '<div class="brief-hist-item"><div class="brief-hist-head">' +
          escapeHtml(dt + ' · ' + (item.model || 'Gemini') + tag) +
          '</div><div class="ai-brief-body">' + formatAiBriefHtml(item.text) + '</div></div>';
      }).join('');
      return;
    }

    if (activeSavedTab === 'json'){
      const dump = {
        firebase_climateRollup: rollup || null,
        firebase_hourly48h: h48 || null
      };
      pane.innerHTML = '<pre class="brief-raw-pre">' + escapeHtml(JSON.stringify(dump, null, 2)) + '</pre>';
      return;
    }

    // Default tab: 'rollup'
    if (!rollup || !rollup.weekly){
      pane.innerHTML = '<div class="ota-meta" style="margin:0;">No weekly/monthly rollup cached yet. Tap <b>Sync on ESP32</b> or wait a second for Firebase sync.</div>';
      return;
    }
    const w = rollup.weekly;
    const m = rollup.monthly || w;
    const srcLabel = (rollup.computedBy === 'esp32') ? 'ESP32 (on-device)' : 'PWA (browser)';
    const updAgo = rollup.updatedAt ? timeAgo(Math.max(0, Date.now() - Number(rollup.updatedAt))) : 'unknown';
    const h48Info = h48
      ? (h48.hoursCount + 'h (' + h48.readingCount48h + ' pts · ' + (h48.computedBy || 'esp32') + ')')
      : 'computed live from loaded readings';

    const perfLine = (perf && perf.samples > 0)
      ? ('ESP32 sync ETA: <b>~' + (perf.ewmaTotalMs / 1000).toFixed(1) + 's</b> (compute ' + perf.ewmaComputeMs + 'ms + upload ' + (perf.ewmaUploadMs / 1000).toFixed(2) + 's · learned from ' + perf.samples + ' run' + (perf.samples === 1 ? '' : 's') + ')')
      : 'ESP32 sync ETA: <b>~3.5s est.</b> (auto-calibrates after first ESP32 sync)';
    let html = '<div class="ota-meta" style="margin:0 0 8px;">Source: <b>' + escapeHtml(srcLabel) +
      '</b> · Updated <b>' + escapeHtml(updAgo) + '</b> · 48h cache: <b>' + escapeHtml(h48Info) + '</b><br>' + perfLine + '</div>';

    html += '<div class="rollup-grid">' +
      '<div class="rollup-box"><div class="rollup-box-title">Weekly (' + w.days + 'd)</div>' +
      '<div class="rollup-box-val">' + w.tAvg + '°C · ' + w.rhAvg + '%</div>' +
      '<div class="rollup-box-sub">Range: ' + w.tMin + '–' + w.tMax + '°C / ' + w.rhMin + '–' + w.rhMax + '%<br>' +
      'Comfort: <b>' + w.comfortPct + '%</b> · Mold &gt;60%: <b>' + w.moldHighDays + 'd</b><br>' +
      'AH: ' + w.ahAvg + ' g/m³ · σT ±' + w.volT + '°C</div></div>' +

      '<div class="rollup-box"><div class="rollup-box-title">Monthly (' + m.days + 'd)</div>' +
      '<div class="rollup-box-val">' + m.tAvg + '°C · ' + m.rhAvg + '%</div>' +
      '<div class="rollup-box-sub">Range: ' + m.tMin + '–' + m.tMax + '°C / ' + m.rhMin + '–' + m.rhMax + '%<br>' +
      'Comfort: <b>' + m.comfortPct + '%</b> · Mold &gt;60%: <b>' + m.moldHighDays + 'd</b> (max streak ' + (m.maxMoldStreak || 0) + 'd)<br>' +
      'AH: ' + m.ahAvg + ' g/m³ · Enthalpy ' + m.enthalpyAvg + ' kJ/kg</div></div>' +
      '</div>';

    if (Array.isArray(rollup.weeklyBuckets) && rollup.weeklyBuckets.length){
      html += '<table class="rollup-table"><thead><tr><th>Week</th><th>Dates</th><th>Temp</th><th>RH</th><th>Comfort</th><th>Mold</th></tr></thead><tbody>' +
        rollup.weeklyBuckets.map(b =>
          '<tr><td>' + escapeHtml(b.week) + '</td><td>' + escapeHtml(b.from + '→' + b.to) + '</td><td>' +
          b.tAvg + '°C</td><td>' + b.rhAvg + '%</td><td>' + b.comfortPct + '%</td><td>' + b.moldDays + 'd</td></tr>'
        ).join('') + '</tbody></table>';
    }
    if (typeof processTimingsMap === 'object' && processTimingsMap){
      const entries = Object.entries(processTimingsMap).filter(([, v]) => v && v.ewmaMs > 0);
      if (entries.length){
        html += '<div class="ota-meta" style="margin:10px 0 4px;"><b>Learned Process Timings (Cloud /processTimings.json)</b></div>' +
          '<table class="rollup-table"><thead><tr><th>Process</th><th>Predicted ETA</th><th>Last Run</th><th>Runs</th></tr></thead><tbody>' +
          entries.map(([k, v]) =>
            '<tr><td>' + escapeHtml(k) + '</td><td>~' + (Number(v.ewmaMs) / 1000).toFixed(1) + 's</td><td>' +
            (Number(v.lastMs || v.ewmaMs) / 1000).toFixed(1) + 's</td><td>' + Number(v.samples || 1) + '</td></tr>'
          ).join('') + '</tbody></table>';
      }
    }
    pane.innerHTML = html;
  }

  async function renderSavedRollupDrawer(forceFetch){
    // 1. Paint immediately in 0ms from RAM / localStorage cache (never blocks on network!)
    paintSavedRollupPane();

    // 2. Silently refresh from Firebase in the background at most once per 60s (unless forced)
    if (!forceFetch && (Date.now() - lastSavedDrawerFetchMs) < 60000) return;
    lastSavedDrawerFetchMs = Date.now();
    try {
      await Promise.allSettled([
        fetchCloudClimateRollup(),
        fetchCloudHourly48h(),
        fetchBriefHistoryCloud(),
        fetchCloudPerfStats()
      ]);
      if (document.getElementById('ai-saved-drawer')?.classList.contains('show')){
        paintSavedRollupPane();
      }
    } catch(e) {}
  }

  // Build rich 48-hour (2-day) indoor hourly trajectory + day-by-day mold/comfort/season stats
  function buildTwoDayRoomSnapshot(validReadings, data){
    const round1 = v => Math.round(v * 10) / 10;
    const round2 = v => Math.round(v * 100) / 100;
    const rows = Array.isArray(validReadings) ? validReadings : [];
    const latestMs = rows.length ? rows[rows.length - 1].epochMs : Date.now();
    const anchorMs = Math.max(Date.now(), latestMs);
    const cutoff48h = anchorMs - 48 * 3600 * 1000;

    // Include at least the last 48h (and if sparse, fall back to the latest 2 distinct calendar days present)
    let windowRows = rows.filter(r => r.epochMs >= cutoff48h);
    if (windowRows.length < 4 && rows.length){
      const recentDays = [];
      for (let i = rows.length - 1; i >= 0; i--){
        const dk = localDayKeyFromMs(rows[i].epochMs);
        if (!recentDays.includes(dk)) recentDays.push(dk);
        if (recentDays.length >= 2) break;
      }
      const daySet = new Set(recentDays);
      windowRows = rows.filter(r => daySet.has(localDayKeyFromMs(r.epochMs)));
    }

    // Hourly buckets across the 48h window
    const hourMap = new Map();
    const dayMap = new Map();

    for (const r of windowRows){
      const rt = (r.temp !== undefined) ? r.temp : r.t;
      const rh = (r.hum !== undefined) ? r.hum : r.h;
      if (!Number.isFinite(rt) || !Number.isFinite(rh)) continue;
      const d = new Date(r.epochMs);
      const pad = n => String(n).padStart(2, '0');
      const dayKey = localDayKeyFromMs(r.epochMs);
      const hourKey = dayKey.slice(5) + ' ' + pad(d.getHours()) + ':00';
      const fl = calcHeatIndexC(rt, rh);
      const ah = calcAbsoluteHumidity(rt, rh);
      const en = calcEnthalpyKjKg(rt, rh);
      const ok = isComfortCompliant(rt, rh);

      let hb = hourMap.get(hourKey);
      if (!hb){
        hb = { hour: hourKey, n: 0, sT: 0, minT: rt, maxT: rt, sH: 0, sFL: 0, sAH: 0, okN: 0, mold60N: 0, mold65N: 0 };
        hourMap.set(hourKey, hb);
      }
      hb.n++; hb.sT += rt; hb.sH += rh; hb.sFL += fl; hb.sAH += ah;
      if (rt < hb.minT) hb.minT = rt;
      if (rt > hb.maxT) hb.maxT = rt;
      if (ok) hb.okN++;
      if (rh > 60 && rt >= 20 && rt <= 30) hb.mold60N++;
      if (rh > 65 && rt >= 20 && rt <= 30) hb.mold65N++;

      let db = dayMap.get(dayKey);
      if (!db){
        db = {
          day: dayKey, n: 0, sT: 0, minT: rt, maxT: rt, sH: 0, minH: rh, maxH: rh,
          sFL: 0, maxFL: fl, sAH: 0, sEN: 0, okN: 0,
          tooCool: 0, tooWarm: 0, tooHumid: 0, tooDry: 0,
          peakRh: -1, peakRhHour: hourKey
        };
        dayMap.set(dayKey, db);
      }
      db.n++; db.sT += rt; db.sH += rh; db.sFL += fl; db.sAH += ah; db.sEN += en;
      if (rt < db.minT) db.minT = rt;
      if (rt > db.maxT) db.maxT = rt;
      if (rh < db.minH) db.minH = rh;
      if (rh > db.maxH) db.maxH = rh;
      if (fl > db.maxFL) db.maxFL = fl;
      if (ok) db.okN++;
      if (rt < 20) db.tooCool++;
      if (rt > 26) db.tooWarm++;
      if (rh > 60) db.tooHumid++;
      if (rh < 30) db.tooDry++;
      if (rh > db.peakRh){ db.peakRh = rh; db.peakRhHour = hourKey; }
    }

    const hourly48h = Array.from(hourMap.values()).slice(-48).map(h => ({
      hr: h.hour,
      t: round1(h.sT / h.n),
      tMin: round1(h.minT),
      tMax: round1(h.maxT),
      rh: round1(h.sH / h.n),
      fl: round1(h.sFL / h.n),
      ah: round1(h.sAH / h.n),
      okPct: Math.round((h.okN / h.n) * 100),
      n: h.n
    }));

    // Count mold-risk hours per day from hourly buckets
    const moldHoursByDay = {};
    for (const h of hourMap.values()){
      const dk = h.hour.slice(0, 5); // MM-DD
      if (!moldHoursByDay[dk]) moldHoursByDay[dk] = { over60: 0, over65: 0 };
      if (h.mold60N > 0) moldHoursByDay[dk].over60++;
      if (h.mold65N > 0) moldHoursByDay[dk].over65++;
    }

    const dailyBreakdown = Array.from(dayMap.values()).map(d => {
      const mmdd = d.day.slice(5);
      const mh = moldHoursByDay[mmdd] || { over60: 0, over65: 0 };
      return {
        day: d.day,
        samples: d.n,
        tempC: { min: round1(d.minT), avg: round1(d.sT / d.n), max: round1(d.maxT), swing: round1(d.maxT - d.minT) },
        humidityPct: { min: round1(d.minH), avg: round1(d.sH / d.n), max: round1(d.maxH), peakAt: d.peakRhHour },
        feelsLikeC: { avg: round1(d.sFL / d.n), max: round1(d.maxFL) },
        absHumidityGm3: round2(d.sAH / d.n),
        enthalpyKjKg: round1(d.sEN / d.n),
        comfortPct: Math.round((d.okN / d.n) * 100),
        outsideReasonsPct: {
          tooCool: Math.round((d.tooCool / d.n) * 100),
          tooWarm: Math.round((d.tooWarm / d.n) * 100),
          tooHumid: Math.round((d.tooHumid / d.n) * 100),
          tooDry: Math.round((d.tooDry / d.n) * 100)
        },
        moldHours: { rhOver60In20to30C: mh.over60, rhOver65In20to30C: mh.over65 }
      };
    });

    const spanHours = windowRows.length >= 2
      ? round1((windowRows[windowRows.length - 1].epochMs - windowRows[0].epochMs) / 3600000)
      : 0;

    return {
      readingCount48h: windowRows.length,
      coveredHours: spanHours,
      dailyBreakdown,
      hourly48h
    };
  }

  // Instant 0ms location helper: grabs raw lat/lon from app's #weather-loc field or cached GPS (no blocking API calls!)
  function getRawLocationForGemini(){
    let loc = null;
    let source = '';
    try {
      if (typeof manualWeatherLoc === 'function'){
        const m = manualWeatherLoc();
        if (m && Number.isFinite(m.lat) && Number.isFinite(m.lon)){ loc = m; source = 'app-lat-lon'; }
      }
      if (!loc && typeof weatherLoc !== 'undefined' && weatherLoc && Number.isFinite(weatherLoc.lat) && Number.isFinite(weatherLoc.lon)){
        loc = weatherLoc; source = 'device-gps';
      }
    } catch(e) {}
    if (!loc) return { available: false, note: 'No lat,lon entered in Graphs -> Weather location field.' };
    const out = {
      available: true,
      latitude: Math.round(loc.lat * 10000) / 10000,
      longitude: Math.round(loc.lon * 10000) / 10000,
      source: source
    };
    // If Graphs tab already has cached outdoor weather in RAM, include the latest point at 0ms cost
    try {
      if (typeof weatherCache !== 'undefined' && weatherCache && Array.isArray(weatherCache.temp) && weatherCache.temp.length){
        const lt = weatherCache.temp[weatherCache.temp.length - 1];
        const lh = (Array.isArray(weatherCache.hum) && weatherCache.hum.length) ? weatherCache.hum[weatherCache.hum.length - 1] : null;
        if (lt && Number.isFinite(lt.y)){
          out.cachedOutdoorNow = { tempC: Math.round(lt.y * 10) / 10, humidityPct: (lh && Number.isFinite(lh.y)) ? Math.round(lh.y * 10) / 10 : null };
        }
      }
    } catch(e) {}
    return out;
  }

  async function discoverGeminiFlashModel(apiKey){
    try {
      const res = await fetch('https://generativelanguage.googleapis.com/v1beta/models?key=' + encodeURIComponent(apiKey), { cache: 'no-store' });
      if (!res.ok) return null;
      const data = await res.json();
      const models = Array.isArray(data && data.models) ? data.models : [];
      const eligible = models
        .filter(m => m && m.name && Array.isArray(m.supportedGenerationMethods) && m.supportedGenerationMethods.includes('generateContent'))
        .map(m => String(m.name).replace(/^models\//, ''))
        .filter(id => /^gemini-/i.test(id) && /flash/i.test(id) && !/(tts|image|audio|embedding|live|2\.5)/i.test(id));
      if (!eligible.length) return null;
      eligible.sort((a, b) => {
        const aLite = /flash-lite/i.test(a) ? 1 : 0;
        const bLite = /flash-lite/i.test(b) ? 1 : 0;
        if (aLite !== bLite) return bLite - aLite;
        return b.localeCompare(a, undefined, { numeric: true });
      });
      return eligible[0];
    } catch(e) {
      return null;
    }
  }

  async function callGeminiModel(apiKey, modelId, prompt){
    const endpoint = 'https://generativelanguage.googleapis.com/v1beta/models/' + encodeURIComponent(modelId) + ':generateContent?key=' + encodeURIComponent(apiKey);
    const res = await fetchWithTimeout(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // Omit sampling params (temperature/topP/topK) — unsupported on Gemini 3.x+
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { maxOutputTokens: 950 }
      })
    }, 18000);
    if (!res.ok){
      let errMsg = '';
      try {
        const errJson = await res.json();
        errMsg = (errJson && errJson.error && errJson.error.message) ? errJson.error.message : JSON.stringify(errJson);
      } catch(e) {
        errMsg = await res.text().catch(() => '');
      }
      const err = new Error(errMsg || ('HTTP ' + res.status));
      err.status = res.status;
      throw err;
    }
    const json = await res.json();
    const parts = json && json.candidates && json.candidates[0] && json.candidates[0].content && json.candidates[0].content.parts;
    const text = Array.isArray(parts)
      ? parts.filter(p => p && !p.thought && typeof p.text === 'string').map(p => p.text).join('').trim()
      : '';
    if (!text) throw new Error('Empty response from Gemini');
    return text;
  }

  async function generateGeminiDailyBrief(manual){
    if (geminiGenerating) return;
    const apiKey = getGeminiApiKey();
    if (!apiKey){
      if (manual){
        toggleGeminiKeyDrawer(true);
        showToast('Paste your free Gemini API key first');
      }
      return;
    }
    const validReadings = (typeof getValidSorted === 'function') ? getValidSorted() : [];
    const data = lastRenderedAnalytics || computeAllSevenMetrics(validReadings);
    if (!data || !data.live){
      if (manual) showToast('Wait for room readings to load first');
      return;
    }

    const todayKey = localDayKeyFromMs(Date.now());
    const cached = loadLocalAiBrief();
    if (!manual && cached && cached.day === todayKey){
      renderCachedAiBrief(cached);
      return;
    }

    geminiGenerating = true;
    const briefStartMs = Date.now();
    const btn = document.getElementById('btn-ai-refresh');
    const bodyEl = document.getElementById('ai-brief-body');
    if (btn){ btn.disabled = true; btn.textContent = 'Writing…'; }
    if (bodyEl && manual) bodyEl.innerHTML = '<div class="ota-meta" style="margin:0;">Step 1/2: Reading ESP32 48h &amp; rollup cache…</div>';

    const season = classifySeasonShift(data);
    const rawLoc = getRawLocationForGemini();

    // Fast parallel read of ESP32-compiled /climateRollup.json + /hourly48h.json (4s timeout each, zero Open-Meteo calls!)
    let climateRollup = lastClimateRollup || loadLocalClimateRollup();
    let espHourly48h = lastHourly48hCloud;
    const [rRes, hRes] = await Promise.allSettled([
      fetchCloudClimateRollup(),
      fetchCloudHourly48h()
    ]);
    if (rRes.status === 'fulfilled' && rRes.value) climateRollup = rRes.value;
    if (hRes.status === 'fulfilled' && hRes.value) espHourly48h = hRes.value;

    // Prefer ESP32's pre-compiled /hourly48h.json directly so we don't re-scan raw logs!
    let twoDayPayload;
    if (espHourly48h && Array.isArray(espHourly48h.hourly48h) && espHourly48h.hourly48h.length > 0){
      twoDayPayload = {
        source: espHourly48h.computedBy || 'esp32',
        readingCount48h: espHourly48h.readingCount48h || espHourly48h.hourly48h.length,
        hoursCount: espHourly48h.hoursCount || espHourly48h.hourly48h.length,
        hourly48h: espHourly48h.hourly48h
      };
    } else {
      twoDayPayload = buildTwoDayRoomSnapshot(validReadings, data);
    }

    if (!climateRollup && validReadings.length){
      climateRollup = computeClimateRollup(validReadings);
    }

    if (bodyEl && manual) bodyEl.innerHTML = '<div class="ota-meta" style="margin:0;">Step 2/2: Asking Gemini Flash to write your brief…</div>';

    const payload = {
      localTime: new Date().toLocaleString(),
      locationCoordinates: rawLoc,
      liveIndoor: {
        tempC: data.live.temp,
        humidityPct: data.live.hum,
        feelsLikeC: data.live.heatIndex,
        absHumidityGm3: data.live.absHumidity,
        enthalpyKjKg: data.live.enthalpy,
        comfortNow: data.live.comfortNow
      },
      last48HoursIndoor: twoDayPayload,
      weeklyAndMonthlyRollup: climateRollup || null,
      comfortMoldSeasonAndTrends: {
        comfortCompliance: data.comfort,
        moldRiskPattern: data.mold,
        seasonTrend: {
          phase: season.label,
          summary: season.summary,
          delta7dVs30dTempC: Math.round((season.dT || 0) * 100) / 100,
          delta7dVs30dAhGm3: Math.round((season.dAH || 0) * 100) / 100
        },
        rolling7dVs30dAndVolatility: data.rolling,
        zScoreAnomalies14d: data.zscore
      }
    };

    const prompt =
      'You are a sharp, friendly home-climate analyst. Based on the 48-hour indoor ESP32 dataset, the weekly/monthly rollup, and the user\'s raw locationCoordinates in the JSON below, write a super readable, scannable daily room brief WITHOUT losing any detail or numbers. Skip greetings like "Hello there!".\n' +
      'Format STRICTLY using these 4 short sections and concise bullet points (starting with "- ") that compare indoor vs outdoor and short-term vs long-term data SIDE BY SIDE on the same line:\n\n' +
      '## Right Now: Indoor vs Outdoor\n' +
      '- **Temperature:** Compare indoor temp & 48h swing directly against outdoor temp for the coordinates/city right now (include the exact °C gap).\n' +
      '- **Humidity & Feel:** Compare indoor RH vs outdoor RH, feels-like temperature, and comfort compliance % (state clearly why compliance is high or low).\n\n' +
      '## 48-Hour Pattern & Mold Risk\n' +
      '- **48h Stability:** Summarize warmest/coolest hours, day-night swing, and any 14-day Z-score anomalies.\n' +
      '- **Mold & Moisture:** State the mold risk level/streak and what persistent moisture means for corners/glass.\n\n' +
      '## Weekly, Monthly & Local Outlook\n' +
      '- **7d vs 30d Trend:** Compare this week\'s avg temp/RH against the 30-day rollup, volatility, and seasonal shift.\n' +
      '- **Local Air & AQI:** Mention regional climate and air-quality/AQI context for the coordinates.\n\n' +
      '## What to Do Today\n' +
      '- Give 3 short, specific action bullets (bold the 2-3 word action lead-in on each bullet, e.g., **Midday Ventilation:** ...).\n\n' +
      'Use **bold** only for short labels and key numbers. Keep every bullet to 1-2 crisp sentences. Total length ~220-320 words.\n\n' +
      'Room & Location JSON:\n' + JSON.stringify(payload);

    try {
      const candidates = [];
      const remembered = getCachedGeminiModel();
      if (remembered) candidates.push(remembered);
      for (const m of GEMINI_MODELS){
        if (!candidates.includes(m)) candidates.push(m);
      }

      let text = '';
      let usedModel = '';
      let lastErr = null;

      for (const modelId of candidates){
        try {
          text = await callGeminiModel(apiKey, modelId, prompt);
          usedModel = modelId;
          break;
        } catch(err){
          lastErr = err;
          if (err.status === 404) continue;
          if (err.status === 401 || err.status === 403){
            throw new Error('Invalid or restricted Gemini API key (HTTP ' + err.status + ')');
          }
          if (err.status === 429){
            throw new Error('Gemini free-tier rate limit reached — try again in a minute');
          }
          throw new Error('Gemini HTTP ' + (err.status || '?') + ': ' + String(err.message || '').slice(0, 120));
        }
      }

      if (!text && lastErr && lastErr.status === 404){
        const discovered = await discoverGeminiFlashModel(apiKey);
        if (discovered && !candidates.includes(discovered)){
          text = await callGeminiModel(apiKey, discovered, prompt);
          usedModel = discovered;
        }
      }

      if (!text){
        throw new Error(lastErr ? ('No active Gemini Flash model available (' + String(lastErr.message || '').slice(0, 100) + ')') : 'No response from Gemini');
      }

      setCachedGeminiModel(usedModel);
      const rollupTag = climateRollup ? (' + ' + (climateRollup.monthly ? climateRollup.monthly.days : 30) + 'd rollup') : '';
      const outdoorTag = rawLoc && rawLoc.available
        ? ('48h' + rollupTag + ' · ' + rawLoc.latitude.toFixed(2) + ', ' + rawLoc.longitude.toFixed(2))
        : ('48h' + rollupTag);
      const briefObj = {
        day: todayKey,
        generatedAt: Date.now(),
        model: usedModel,
        outdoorTag: outdoorTag,
        text: text
      };
      try { localStorage.setItem(GEMINI_BRIEF_LS, JSON.stringify(briefObj)); } catch(e) {}
      renderCachedAiBrief(briefObj);
      syncAiBriefToFirebase(briefObj);
      saveBriefToHistory(briefObj);
      if (typeof recordProcessTiming === 'function') recordProcessTiming('geminiBrief', Date.now() - briefStartMs);
      if (manual) showToast('Daily room brief updated (' + formatGeminiModelLabel(usedModel) + ')');
    } catch(err){
      if (bodyEl){
        bodyEl.innerHTML = '<div class="ota-meta" style="margin:0;color:var(--err);">AI brief failed: ' + escapeHtml(err.message) + '</div>';
      }
      if (manual) showToast('Gemini error: ' + err.message);
    } finally {
      geminiGenerating = false;
      if (btn){ btn.disabled = false; if (typeof refreshAllProcessEtaBadges === 'function') refreshAllProcessEtaBadges(); else btn.textContent = 'Refresh Brief'; }
    }
  }

  // Boot: render local cached brief immediately, check cloud brief, and auto-generate once per new day if key is set
  (function initGeminiDailyBrief(){
    const local = loadLocalAiBrief();
    renderCachedAiBrief(local);
    setTimeout(async () => {
      const cloud = await fetchCloudAiBrief();
      const latest = cloud || local;
      const todayKey = localDayKeyFromMs(Date.now());
      await Promise.allSettled([ensureHourlyClimateRollup(typeof getValidSorted === 'function' ? getValidSorted() : [], false), fetchCloudHourly48h(), fetchBriefHistoryCloud(), fetchCloudPerfStats()]);
      if (getGeminiApiKey() && (!latest || latest.day !== todayKey)){
        generateGeminiDailyBrief(false);
      }
    }, 3200);
    // Keep /climateRollup.json updated hourly while the PWA is open (if ESP32 is offline or stale)
    setInterval(() => {
      ensureHourlyClimateRollup(typeof getValidSorted === 'function' ? getValidSorted() : [], false);
    }, 15 * 60 * 1000);
  })();
