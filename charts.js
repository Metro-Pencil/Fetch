  // ---------- live fetch (initial load, manual refresh, auto-refresh) ----------
  let isFetchingReadings = false;
  async function fetchReadings(){
    const host = getHost();
    if (!host || isFetchingReadings) return;
    isFetchingReadings = true;

    fetchStatus(); // rides along with every readings poll, doesn't block it

    try{
      // v2.15.0: order by "t" (a real JSON number on every RTC-era reading,
      // and still present as key+1 on most pre-RTC ones), not "$key". This
      // isn't a style choice -- with $key, limitToLast=200 can return ZERO
      // RTC readings, ever, no matter how much time passes. Firebase
      // compares $key lexicographically (confirmed against a real export
      // of this project's data): any legacy relative key with a leading
      // digit '2'-'9' (e.g. "99086") STRING-sorts above EVERY absolute
      // Unix-second key (10 digits, currently all starting with '1', e.g.
      // "1786693985") — '9' > '1' settles it on the first character,
      // regardless of the actual numeric values. That's not a rare edge
      // case here: on the real dataset, orderBy="$key"&limitToLast=200
      // returned 200 legacy readings and 0 RTC ones. "t" doesn't have this
      // problem because Firebase orders child-VALUE queries by actual
      // type/number, not string. This DOES need an ".indexOn": ["t"] rule
      // under /readings in Firebase's security rules to run efficiently --
      // and can return HTTP 400 without one rather than just running slow
      // (see fetchReadingsPage(), v2.17.0, for the fallback that handles
      // that either way).
      // Live polls only fetch the newest tail (PAGE_SIZE) once history is loaded, avoiding 50k re-downloads every 15s
      const pollLimit = entriesByKey.size > 0 ? PAGE_SIZE : currentFetchLimit;
      const { data, limitUsed } = await fetchReadingsPage(host, pollLimit);
      currentFetchLimit = Math.max(currentFetchLimit, limitUsed);
      const fetched = parseEntries(data);
      if (!fetched.length){
        setConnState('stale');
        return;
      }
      // "New data" = a key we've never fetched before, whether it's an
      // RTC-stamped absolute reading or a legacy relative one. Checked
      // before inserting, since entriesByKey.set() below would otherwise
      // make every key look "already known" by the time we check.
      const isNewData = fetched.some(e => !entriesByKey.has(e.key));
      fetched.forEach(e => entriesByKey.set(e.key, e));
      invalidateSorted();

      // Restart-detection / anchoring only ever applies to relative
      // (boot-counter) keys — see parseEntries()/ABSOLUTE_EPOCH_THRESHOLD_S.
      // RTC-stamped readings already have a real epochMs and must be kept
      // out of this entirely, or a single RTC reading (key ~1.7 billion)
      // would get treated as "the newest boot-relative key ever seen" and
      // poison every relative reading's reconstructed time.
      const relativeFetched = fetched.filter(e => !isAbsoluteKey(e.key));
      const newestKey = relativeFetched.length
        ? relativeFetched.reduce((m, e) => Math.max(m, e.key), relativeFetched[0].key)
        : null;

      // Restart detection (v2.14.0): a genuine device restart resets
      // millis() to ~0, so the NEXT live poll's newestKey can be smaller
      // than the peak key we've already confirmed live. That's the one
      // situation where "smaller key" doesn't mean "already seen, ignore
      // it" — it means a brand-new session just started, and the anchor
      // needs to move to it immediately rather than staying pinned to the
      // old (now-dead) session.
      //
      // Without this, here's the failure mode this fixes: device runs for
      // hours, drops offline (WiFi loss, brownout, watchdog reset -- any
      // of these can restart it), comes back after an outage of ANY
      // length, and starts logging again from a small key. That small key
      // never exceeds the old anchorNewestKey, so the old branch below
      // never re-anchors -- anchorNewestKey/anchorNowMs stay frozen at
      // their PRE-outage values, and every entry with key <=
      // anchorNewestKey (which now includes the entire new session, since
      // its keys are still small) gets anchored as if it belongs to the
      // SAME continuous run as the old session. That silently erases the
      // outage from the math: a reading taken the moment the device came
      // back online gets timestamped using a key-gap that has nothing to
      // do with how much real time actually passed, and can land right
      // next to "now" even though the device was offline for an hour.
      // sessionPeakKey (tracked only from live polls, unlike
      // anchorNewestKey which can lag behind on purpose) is what makes the
      // regression itself detectable: it only ever moves forward within a
      // session, so any drop is unambiguous.
      //
      // newestKey is null whenever this poll returned only RTC-stamped
      // (absolute) readings and no relative ones — increasingly the norm
      // as legacy pre-RTC data ages out of the fetch window. There's
      // nothing to anchor or detect a restart against in that case; the
      // absolute readings already carry their own real epochMs.
      if (newestKey !== null){
        const priorPeak = sessionPeakKey;
        const restarted = priorPeak !== null && newestKey < priorPeak;
        sessionPeakKey = restarted ? newestKey : Math.max(priorPeak ?? newestKey, newestKey);
        if (restarted || anchorNewestKey === null || newestKey > anchorNewestKey){
          setAnchor(newestKey);
        }
      }
      // Single fill-in pass: covers relative entries that didn't get a
      // fresh setAnchor() call above (existing anchor still covers them)
      // and is a no-op for absolute entries, which already have epochMs
      // set from parseEntries() and so never hit the undefined check.
      getSorted().forEach(e => {
        if (e.epochMs === undefined){
          e.epochMs = anchorEpoch(e.key);
          if (e.epochMs === null) staleFromPriorBoot++;
        }
      });

      // Firebase being reachable and the SENSOR actively reporting are two
      // different facts -- fetchReadings() can succeed every poll (Firebase
      // is a separate cloud service, up regardless of whether the ESP32
      // itself is connected to anything) while the device has been quiet
      // for an hour. lastFetchOk only ever answered the first question;
      // lastNewDataMs (used by the staleness sweep below) answers the
      // second, so "no recent readings" actually fires when the ESP32 goes
      // quiet instead of only when Firebase itself is unreachable.
      setConnState('online');
      lastFetchOk = Date.now();
      if (isNewData) lastNewDataMs = Date.now();

      const latest = latestEntry();
      renderCurrent(latest);
      ensureChart();

      if (!userHasInteracted || !chartTemp || !chartTemp.scales || !chartTemp.scales.x){
        await applyRangeSelection();
      } else {
        const xScale = chartTemp.scales.x;
        redrawChart(xScale.min, xScale.max);
      }
    } catch(err){
      setConnState('offline', 'fetch failed: ' + err.message);
    } finally {
      isFetchingReadings = false;
    }
  }

  // ---------- backward history loading ----------
  // Firebase's `$key` ordering compares keys as STRINGS, not numbers, which
  // used to mean a bound like endAt(oldestKey - 1) couldn't be trusted once
  // key lengths differed (e.g. "999999" vs "1000000") or after a reboot
  // reset millis() back to a small number. This file used to just widen
  // limitToLast and re-fetch instead of paging with startAt/endAt, to avoid
  // depending on key ordering being numerically correct.
  //
  // v2.15.0: readings now carry "t", a real Unix-seconds timestamp on RTC
  // -era data (see the anchoring block above and ABSOLUTE_EPOCH_THRESHOLD_S)
  // — this is the "firmware-side fix... NTP-synced epoch timestamps" this
  // comment used to ask for. Ordering by "t" instead of "$key" sidesteps
  // the string-comparison problem entirely (Firebase orders child-VALUE
  // queries by actual number, not string), so this now correctly finds the
  // true newest readings either way. Still widening limitToLast and
  // re-fetching rather than switching to a real startAt/endAt cursor on
  // "t" for now — that's a legitimate follow-up optimization once "t" is
  // universal across the dataset, but re-fetching a growing window is the
  // lower-risk change today.
  async function fetchOlderPage(){
    if (noMoreHistory || isFetchingOlder) return false;
    const host = getHost();
    if (!host) return false;

    const nextLimit = Math.min(currentFetchLimit * 2, MAX_FETCH_LIMIT);
    if (nextLimit === currentFetchLimit){ noMoreHistory = true; return false; }

    isFetchingOlder = true;
    setLoadingOlder(true);
    try{
      const prevCount = entriesByKey.size;
      const { data, limitUsed } = await fetchReadingsPage(host, nextLimit);
      const fetched = parseEntries(data);
      fetched.forEach(e => { if (!entriesByKey.has(e.key)) entriesByKey.set(e.key, e); });
      invalidateSorted();
      currentFetchLimit = Math.max(nextLimit, limitUsed);

      // anchorEpoch() handles both cases on its own: absolute (RTC) keys
      // always resolve to a real epochMs regardless of anchor state, and
      // relative keys correctly resolve to null (unrecoverable) if no
      // relative anchor has been set yet — no need to gate this on
      // anchorNewestKey anymore.
      getSorted().forEach(e => {
        if (e.epochMs === undefined){
          e.epochMs = anchorEpoch(e.key);
          if (e.epochMs === null) staleFromPriorBoot++;
        }
      });
      const gained = entriesByKey.size - prevCount;
      if (gained === 0) noMoreHistory = true;
      return gained > 0;
    } catch(err){
      console.error('older page fetch failed', err);
      return false;
    } finally{
      isFetchingOlder = false;
      setLoadingOlder(false);
    }
  }

  function setLoadingOlder(on){
    document.getElementById('chart-loading').classList.toggle('show', !!on);
  }

  // ---------- range selection ----------
  // Smallest x-domain width we'll ever set. This is ONLY a degenerate-case
  // guard (e.g. every visible reading landing at the exact same
  // millisecond, which would otherwise collapse the axis to zero width) —
  // it is deliberately much smaller than any real "comfortable viewing
  // window". A bigger value here silently overrides real data: if actual
  // readings span less time than this floor, every stretch gets padded
  // out to the floor instead of the data's real extent, which (a) leaves
  // blank space again — the exact bug this was meant to fix — and (b)
  // means picking a wider nominal range (1h vs 24h vs 3mo) can render
  // identically, since they all clamp to the same floor around the same
  // cluster of points. Mirrors the zoom plugin's own minRange (see
  // limits.x.minRange below) so the auto-picker floor and the interactive
  // zoom-in floor agree — you can always zoom in at least this far.
  const MIN_DOMAIN_MS = 15 * 1000;

  // Narrows [start, end] down to the actual first/last timestamp of
  // whatever data falls inside it, so the chart always stretches edge to
  // edge instead of leaving blank space where the nominal window (e.g.
  // "last hour") extends past the readings that actually exist. Falls
  // back to [start, end] untouched if nothing is loaded in range yet.
  function stretchToData(sorted, start, end){
    const visible = sorted.filter(e => e.epochMs >= start && e.epochMs <= end);
    if (!visible.length) return [start, end];
    let actualStart = visible[0].epochMs;
    let actualEnd = visible[visible.length - 1].epochMs;
    if (actualEnd - actualStart < MIN_DOMAIN_MS){
      const mid = (actualStart + actualEnd) / 2;
      actualStart = mid - MIN_DOMAIN_MS / 2;
      actualEnd = mid + MIN_DOMAIN_MS / 2;
    }
    return [actualStart, actualEnd];
  }

  // Short human-readable span, for the "that's all there is" caption note
  // (e.g. "42s", "3m", "5h", "2d") — not a formal duration format, just
  // enough for the user to see why a wider range looks the same as a
  // narrower one.
  function formatSpan(ms){
    const s = Math.round(ms / 1000);
    if (s < 90) return s + 's';
    const m = Math.round(s / 60);
    if (m < 90) return m + 'm';
    const h = Math.round(m / 60);
    if (h < 48) return h + 'h';
    return Math.round(h / 24) + 'd';
  }

  async function applyRangeSelection(){
    userZoomedY = false;
    if (!getValidSorted().length) return;
    const mode = document.getElementById('range-select').value;
    userHasInteracted = false;
    const def = RANGE_DEFS[mode] || RANGE_DEFS['24h'];

    if (def.type === 'count'){
      let guard = 0;
      while (getValidSorted().length < def.n && !noMoreHistory && guard < 25){
        const got = await fetchOlderPage();
        guard++;
        if (!got) break;
      }
      const sorted = getValidSorted();
      const slice = sorted.slice(-def.n);
      if (!slice.length) return;
      const [start, end] = stretchToData(slice, slice[0].epochMs, slice[slice.length - 1].epochMs);
      const shortNote = slice.length < def.n ? ('only ' + slice.length + ' of ' + def.n + ' readings logged so far') : null;
      setChartDomain(start, end, shortNote);
      return;
    }

    const now = Date.now();
    let cutoff;
    if (def.type === 'duration') cutoff = now - def.ms;
    else if (def.type === 'today') cutoff = startOfLocalDay(now);
    else cutoff = -Infinity; // 'all'

    let guard = 0;
    while (!noMoreHistory && guard < 25){
      const oldest = getValidSorted()[0];
      if (oldest && oldest.epochMs <= cutoff) break;
      const got = await fetchOlderPage();
      guard++;
      if (!got) break;
    }

    const sorted = getValidSorted();
    if (!sorted.length) return;
    const stillMore = cutoff > -Infinity && sorted[0].epochMs > cutoff && !noMoreHistory;
    const domainStart = Math.max(cutoff, sorted[0].epochMs);
    const [start, end] = stretchToData(sorted, domainStart, now);
    // Two distinct reasons the shown span can be shorter than the nominal
    // picker window, worth telling apart: we stopped early and there
    // might be more (stillMore) vs. we've confirmed this really is
    // everything logged so far (noMoreHistory) — in which case every
    // wider range will look identical to this one until more data comes in.
    let note = null;
    if (stillMore) note = 'showing available history only';
    else if (cutoff > -Infinity && noMoreHistory && (end - start) < (now - domainStart) * 0.9){
      note = 'only ' + formatSpan(end - start) + ' of readings logged so far';
    }
    setChartDomain(start, end, note);
  }

  function resetView(){
    userZoomedY = false;
    // resetZoom() clears any y-axis zoom/pan (vertical zoom is per-chart and
    // isn't touched by applyRangeSelection, which only manages the shared
    // x/time domain), then applyRangeSelection puts the time range back.
    if (chartTemp) chartTemp.resetZoom();
    if (chartHum) chartHum.resetZoom();
    applyRangeSelection();
  }

  // ---------- smoothing ----------
  // Buckets consecutive readings within the visible time window so the
  // chart never has to render more than ~TARGET_POINTS points. A short,
  // zoomed-in window has few enough raw points that no averaging happens
  // at all (raw resolution); a long window (weeks/months/years) gets
  // bucketed down. Re-run on every pan/zoom so it adapts as the visible
  // window changes, without flattening things more than the current zoom
  // level calls for.
  //
  // Each over-threshold bucket contributes up to 2 points — its min and
  // its max reading, in time order — rather than a single averaged point.
  // Plain averaging is what was clipping real spikes/dips (a brief 32°C
  // peak gets blended down with its cooler neighbors and disappears);
  // min/max decimation still cuts the point count down for a smoother
  // overall line, but a genuine extreme within a bucket always survives
  // as one of its two points instead of being averaged away. Temp and
  // humidity are decimated independently since their extremes don't
  // necessarily land on the same raw reading.
  //
  // Offline gaps: with no special handling, Chart.js just draws a
  // straight line from the last reading before a shutdown to the first
  // reading after it — visually identical to a real gradual change, even
  // across a multi-hour outage. GAP_THRESHOLD_MS flags any stretch
  // between two consecutive RAW readings (checked before bucketing, so
  // it's independent of how coarse the current zoom's buckets are) that's
  // wider than a few missed readings should ever be. Each flagged gap
  // gets a null-value point inserted at its midpoint — Chart.js breaks
  // the line at a null y (spanGaps defaults to false) — and is also
  // returned separately so redrawChart() can pass it to the shading
  // plugin that fills in the gap region visually.
  function getExpectedIntervalMs(){
    if (lastKnownPowerMode === 'high') return 600000;
    if (lastKnownPowerMode === 'medium') return 300000;
    if (lastKnownPowerMode === 'low') return 120000;
    return KNOWN_INTERVAL_MS;
  }
  function getGapThresholdMs(){
    return Math.max(5 * getExpectedIntervalMs(), 5 * 60 * 1000);
  }
  const GAP_THRESHOLD_MS = 5 * KNOWN_INTERVAL_MS; // ~4+ missed readings in a row

  function bucketize(sorted, rangeStart, rangeEnd){
    const visible = [];
    for (const e of sorted){
      if (e.epochMs >= rangeStart && e.epochMs <= rangeEnd) visible.push(e);
    }

    const gaps = [];
    for (let i = 1; i < visible.length; i++){
      const d = visible[i].epochMs - visible[i - 1].epochMs;
      if (d > GAP_THRESHOLD_MS){
        gaps.push({ start: visible[i - 1].epochMs, end: visible[i].epochMs });
      }
    }

    let tempPoints, humPoints, avgPerPoint;
    if (visible.length <= TARGET_POINTS){
      tempPoints = visible.map(e => ({ x: e.epochMs, y: e.temp }));
      humPoints = visible.map(e => ({ x: e.epochMs, y: e.hum }));
      avgPerPoint = 1;
    } else {
      const bucketMs = (rangeEnd - rangeStart) / TARGET_POINTS;
      const buckets = [];
      let cur = null, curIdx = -1;
      for (const e of visible){
        const idx = Math.floor((e.epochMs - rangeStart) / bucketMs);
        if (idx !== curIdx){
          if (cur) buckets.push(cur);
          cur = [];
          curIdx = idx;
        }
        cur.push(e);
      }
      if (cur) buckets.push(cur);

      tempPoints = [];
      humPoints = [];
      for (const entries of buckets){
        if (entries.length === 1){
          tempPoints.push({ x: entries[0].epochMs, y: entries[0].temp });
          humPoints.push({ x: entries[0].epochMs, y: entries[0].hum });
          continue;
        }
        let tMin = entries[0], tMax = entries[0], hMin = entries[0], hMax = entries[0];
        for (const e of entries){
          if (e.temp < tMin.temp) tMin = e;
          if (e.temp > tMax.temp) tMax = e;
          if (e.hum < hMin.hum) hMin = e;
          if (e.hum > hMax.hum) hMax = e;
        }
        if (tMin === tMax){
          tempPoints.push({ x: tMin.epochMs, y: tMin.temp });
        } else {
          [tMin, tMax].sort((a, b) => a.epochMs - b.epochMs)
            .forEach(e => tempPoints.push({ x: e.epochMs, y: e.temp }));
        }
        if (hMin === hMax){
          humPoints.push({ x: hMin.epochMs, y: hMin.hum });
        } else {
          [hMin, hMax].sort((a, b) => a.epochMs - b.epochMs)
            .forEach(e => humPoints.push({ x: e.epochMs, y: e.hum }));
        }
      }
      avgPerPoint = Math.round(visible.length / buckets.length);
    }

    const pointCount = tempPoints.length; // real points only, before gap markers below
    for (const g of gaps){
      const mid = (g.start + g.end) / 2;
      tempPoints.push({ x: mid, y: null });
      humPoints.push({ x: mid, y: null });
    }
    if (gaps.length){
      tempPoints.sort((a, b) => a.x - b.x);
      humPoints.sort((a, b) => a.x - b.x);
    }

    return { tempPoints, humPoints, avgPerPoint, gaps, pointCount };
  }

  // Fills the time span of each detected offline gap with a faint shaded
  // band, drawn behind the line but above the grid. Reads its gap list
  // from chart.options.plugins.gapShading.gaps, which redrawChart() sets
  // fresh on every redraw — same pattern as the zoom plugin's own
  // per-chart options.
  const gapShadingPlugin = {
    id: 'gapShading',
    beforeDatasetsDraw(chart, args, opts){
      if (!showGapShading) return;
      const gaps = opts.gaps;
      if (!gaps || !gaps.length) return;
      const { ctx, chartArea, scales } = chart;
      const xScale = scales.x;
      ctx.save();
      const pal = getChartThemePalette();
      ctx.fillStyle = pal.gapFill;
      ctx.strokeStyle = pal.gapStroke;
      ctx.setLineDash([3, 3]);
      for (const g of gaps){
        const x1 = Math.max(xScale.getPixelForValue(g.start), chartArea.left);
        const x2 = Math.min(xScale.getPixelForValue(g.end), chartArea.right);
        if (x2 <= x1) continue;
        ctx.fillRect(x1, chartArea.top, x2 - x1, chartArea.bottom - chartArea.top);
        ctx.beginPath(); ctx.moveTo(x1, chartArea.top); ctx.lineTo(x1, chartArea.bottom); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(x2, chartArea.top); ctx.lineTo(x2, chartArea.bottom); ctx.stroke();
      }
      ctx.restore();
    }
  };

  // Draws a thin day/night band in the reserved space below a chart's own
  // x-axis (see the layout.padding.bottom this relies on, set per-chart in
  // buildSeriesChart). Runs afterDraw since it only needs the x-scale's
  // final pixel position, not anything drawn earlier. Only fires for
  // charts whose x ticks are actually displayed — no axis, no strip.
  const DAYNIGHT_STRIP_GAP = 4;     // px between the axis labels and the band
  const DAYNIGHT_STRIP_HEIGHT = 11; // px height of the band itself
  const DAYNIGHT_RESERVED_BOTTOM = DAYNIGHT_STRIP_GAP + DAYNIGHT_STRIP_HEIGHT + 4;
  const dayNightStripPlugin = {
    id: 'dayNightStrip',
    afterDraw(chart){
      const xScale = chart.scales.x;
      if (!xScale || !xScale.options.ticks.display) return;
      const min = xScale.min, max = xScale.max;
      if (!(max > min)) return;
      const { ctx, chartArea } = chart;
      const top = xScale.bottom + DAYNIGHT_STRIP_GAP;
      const segs = dayNightSegments(min, max);
      ctx.save();
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      const dnPal = getChartThemePalette();
      for (const seg of segs){
        const x1 = Math.max(xScale.getPixelForValue(seg.start), chartArea.left);
        const x2 = Math.min(xScale.getPixelForValue(seg.end), chartArea.right);
        if (x2 <= x1) continue;
        ctx.fillStyle = seg.isDay ? dnPal.dayFill : dnPal.nightFill;
        ctx.fillRect(x1, top, x2 - x1, DAYNIGHT_STRIP_HEIGHT);
        if (x2 - x1 >= 60){ // only label a segment wide enough to hold it
          ctx.fillStyle = seg.isDay ? dnPal.dayText : dnPal.nightText;
          ctx.font = "600 8px 'IBM Plex Mono', monospace";
          ctx.fillText(seg.isDay ? 'day' : 'night', (x1 + x2) / 2, top + DAYNIGHT_STRIP_HEIGHT / 2 + 0.5);
        }
      }
      ctx.restore();
    }
  };

  // Builds the hover/tap handler passed as tooltip.external below. Instead
  // of letting Chart.js draw its own floating tooltip box (which follows
  // the cursor/touch point and ends up covering the very line segment
  // you're looking at), this writes the hovered point's time + value into
  // a fixed element in the chart's own header, and reverts to the plain
  // unit text once nothing is hovered. `enabled:false` + `external` is
  // Chart.js's documented pattern for fully custom tooltip rendering — it
  // still computes tooltipModel/dataPoints each hover, it just skips its
  // own canvas draw. The point itself keeps its hover highlight regardless
  // (pointHoverRadius is driven by core interaction, not this plugin).
  // Vertical dashed crosshair through the active tapped/hovered data point
  const crosshairPlugin = {
    id: 'crosshairLine',
    afterDatasetsDraw(chart){
      const active = chart.tooltip && chart.tooltip.getActiveElements ? chart.tooltip.getActiveElements() : [];
      if (!active || !active.length) return;
      const x = active[0].element && active[0].element.x;
      if (typeof x !== 'number' || !Number.isFinite(x)) return;
      const { ctx, chartArea } = chart;
      if (x < chartArea.left || x > chartArea.right) return;
      ctx.save();
      ctx.beginPath();
      ctx.setLineDash([3, 3]);
      ctx.lineWidth = 1;
      ctx.strokeStyle = getActiveTheme() === 'atelier' ? 'rgba(35,29,24,0.35)' : 'rgba(231,235,241,0.30)';
      ctx.moveTo(x, chartArea.top);
      ctx.lineTo(x, chartArea.bottom);
      ctx.stroke();
      ctx.restore();
    }
  };

  function chartReadoutHandler(readoutElId, unit){
    let lastSig = '';
    return function(context){
      const el = document.getElementById(readoutElId);
      if (!el) return;
      const tm = context.tooltip;
      const pts = tm && tm.dataPoints;
      const sensor = pts && pts.find(p => p.datasetIndex === 0);
      const outdoor = pts && pts.find(p => p.datasetIndex === 1);
      if (!tm || tm.opacity === 0 || !sensor || sensor.parsed.y === null || sensor.parsed.y === undefined){
        return; // keep last tapped reading pinned on mobile instead of clearing on finger-lift
      }
      const sig = sensor.parsed.x + '|' + sensor.parsed.y + '|' + (outdoor && outdoor.parsed ? outdoor.parsed.y : '');
      if (sig === lastSig) return;
      lastSig = sig;
      el.classList.remove('idle');
      let htmlOut = '<b>' + sensor.parsed.y.toFixed(1) + unit + '</b> \u00b7 ' + formatFull(sensor.parsed.x, true);
      if (outdoor && outdoor.parsed.y !== null && outdoor.parsed.y !== undefined){
        htmlOut += ' <span style="color:var(--muted);">· outdoor ' + outdoor.parsed.y.toFixed(1) + unit + '</span>';
      }
      el.innerHTML = htmlOut;
    };
  }

  // ---------- chart ----------
  // Temperature and humidity render as two fully separate boxed charts,
  // each with its own axis, rather than a combined dual-axis chart or a
  // shared-axis pair. They still track the same time window together:
  // syncOtherChart()/onViewChanged() mirror pan/zoom from whichever chart
  // the user drags onto the other, so scrolling one scrolls both.
  function buildSeriesChart(canvasId, color, bg, seriesLabel, unit, showXLabels, readoutElId){
    const ctx = document.getElementById(canvasId).getContext('2d');
    return new Chart(ctx, {
      type: 'line',
      data: {
        datasets: [{
          label: seriesLabel, data: [],
          borderColor: color,
          backgroundColor: (context) => makeAreaGradient(context, color),
          tension: 0.25, pointRadius: 0, pointHoverRadius: 5,
          pointHoverBackgroundColor: color, pointHitRadius: 28, borderWidth: 2, fill: 'start', parsing: false
        }, {
          // Outdoor reference line (v2.19.0) -- always present as dataset
          // index 1 so redrawChart()/updateWeatherOverlay() can address it
          // directly; sits empty ([]) whenever the weather switch is off or
          // no location/data is available yet. Styled thin/dashed/faint on
          // purpose so it reads as background context, never competing
          // visually with the real sensor line.
          label: 'Outdoor', data: [],
          borderColor: WEATHER_COLOR, backgroundColor: WEATHER_BG, borderDash: [5, 3],
          tension: 0.25, pointRadius: 0, pointHoverRadius: 3,
          pointHoverBackgroundColor: WEATHER_COLOR, borderWidth: 1.25, fill: false, parsing: false
        }]
      },
      plugins: [gapShadingPlugin, dayNightStripPlugin, crosshairPlugin],
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: false,
        // mode:'x' (not 'index'): 'index' resolves by matching raw ARRAY
        // POSITION across datasets, which only works when every dataset is
        // the same length -- true here until the outdoor dataset above
        // (hourly, far sparser than the per-minute sensor data) got added.
        // 'x' instead finds each dataset's own nearest point to the hovered
        // time pixel independently, so the two series stay correctly
        // aligned regardless of point-count mismatch. Behaves identically
        // to the old 'index' for a single dataset, so this is a no-op for
        // everything that isn't the new overlay.
        events: ['mousemove', 'click', 'touchstart', 'touchmove'],
        interaction: { mode: 'nearest', axis: 'x', intersect: false },
        onClick(evt, _els, chart){
          const nearest = chart.getElementsAtEventForMode(evt, 'nearest', { axis: 'x', intersect: false }, false);
          if (nearest && nearest.length){
            chart.setActiveElements(nearest);
            chart.tooltip.setActiveElements(nearest, { x: evt.x, y: evt.y });
            chart.update('none');
          }
        },
        // Reserves blank space below the x-axis for the day/night strip.
        // Chart.js never draws into layout padding itself, so this is
        // otherwise-unused space the plugin's afterDraw can paint into.
        layout: { padding: { left: 2, right: 6, top: 4, bottom: showXLabels ? DAYNIGHT_RESERVED_BOTTOM : 0 } },
        plugins: {
          legend: { display: false },
          gapShading: { gaps: [] },
          tooltip: {
            enabled: false,
            external: chartReadoutHandler(readoutElId, unit),
            // The gap-break marker points (bucketize()'s null-y inserts) have
            // no real reading to show — filter them out rather than crash on
            // item.parsed.y.toFixed(1) or show a blank readout.
            filter: (item) => item.parsed.y !== null
          },
          zoom: {
            limits: { x: { min: 0, minRange: MIN_DOMAIN_MS } },
            pan: { enabled: true, mode: 'xy', onPan: syncOtherChart, onPanComplete: onViewChanged },
            zoom: {
              wheel: { enabled: true }, pinch: { enabled: true }, drag: { enabled: false },
              mode: 'xy', onZoom: syncOtherChart, onZoomComplete: onViewChanged
            }
          }
        },
        scales: {
          x: {
            type: 'linear',
            ticks: {
              display: showXLabels,
              color: '#525C6B', font: { family: 'IBM Plex Mono', size: 10 }, maxTicksLimit: 6,
              callback: function(value){ return xTickLabel(value, this.max - this.min); }
            },
            grid: { color: '#1A222C' }
          },
          y: {
            type: 'linear', position: 'left',
            ticks: { color: color, font: { family: 'IBM Plex Mono', size: 10 }, padding: 4, maxTicksLimit: 6 },
            grid: { color: '#1A222C' }
          }
        }
      }
    });
  }

  const THEME_CHART_PALETTES = {
    kinetic: {
      themeColor: '#07090D',
      temp: '#F5A66B', tempBg: 'rgba(245,166,107,0.12)',
      hum: '#7DC4E4', humBg: 'rgba(125,196,228,0.10)',
      outdoor: 'rgba(226,232,240,0.52)', outdoorBg: 'rgba(226,232,240,0.05)',
      grid: 'rgba(255,255,255,0.07)', xTicks: 'rgba(235,233,228,0.58)',
      gapFill: 'rgba(255,255,255,0.06)', gapStroke: 'rgba(255,255,255,0.22)',
      dayFill: 'rgba(245,198,125,0.22)', nightFill: 'rgba(125,162,228,0.24)',
      dayText: 'rgba(255,248,235,0.88)', nightText: 'rgba(235,242,255,0.88)'
    },
    obsidian: {
      themeColor: '#0B0F14',
      temp: '#FF8A5B', tempBg: 'rgba(255,138,91,0.08)',
      hum: '#4FC3E8', humBg: 'rgba(79,195,232,0.06)',
      outdoor: 'rgba(148,163,184,0.65)', outdoorBg: 'rgba(148,163,184,0.06)',
      grid: '#1A222C', xTicks: '#525C6B',
      gapFill: 'rgba(120,132,148,0.10)', gapStroke: 'rgba(120,132,148,0.35)',
      dayFill: 'rgba(251,191,36,0.20)', nightFill: 'rgba(99,102,241,0.28)',
      dayText: 'rgba(40,30,5,0.75)', nightText: 'rgba(230,232,255,0.85)'
    },
    atelier: {
      themeColor: '#F3EFE9',
      temp: '#9E6B43', tempBg: 'rgba(158,107,67,0.10)',
      hum: '#4A6B68', humBg: 'rgba(74,107,104,0.10)',
      outdoor: 'rgba(115,104,94,0.55)', outdoorBg: 'rgba(115,104,94,0.06)',
      grid: 'rgba(36,29,24,0.08)', xTicks: '#73685E',
      gapFill: 'rgba(115,104,94,0.10)', gapStroke: 'rgba(115,104,94,0.32)',
      dayFill: 'rgba(198,146,101,0.26)', nightFill: 'rgba(35,29,24,0.16)',
      dayText: 'rgba(30,24,20,0.85)', nightText: 'rgba(30,24,20,0.82)'
    }
  };

  function getActiveTheme(){
    const t = document.documentElement.getAttribute('data-theme');
    if (t === 'atelier' || t === 'obsidian' || t === 'kinetic') return t;
    return 'kinetic';
  }
  function getChartThemePalette(){
    return THEME_CHART_PALETTES[getActiveTheme()] || THEME_CHART_PALETTES.kinetic;
  }

  function updateChartsTheme(){
    const pal = getChartThemePalette();
    const pairs = [
      [chartTemp, pal.temp, pal.tempBg],
      [chartHum,  pal.hum,  pal.humBg]
    ];
    for (const [ch, col, bg] of pairs){
      if (!ch) continue;
      ch.data.datasets[0].borderColor = col;
      ch.data.datasets[0].backgroundColor = (context) => makeAreaGradient(context, col);
      ch.data.datasets[0].pointHoverBackgroundColor = col;
      if (ch.data.datasets[1]){
        ch.data.datasets[1].borderColor = pal.outdoor;
        ch.data.datasets[1].backgroundColor = pal.outdoorBg;
        ch.data.datasets[1].pointHoverBackgroundColor = pal.outdoor;
      }
      ch.options.scales.x.ticks.color = pal.xTicks;
      ch.options.scales.x.grid.color = pal.grid;
      ch.options.scales.y.ticks.color = col;
      ch.options.scales.y.grid.color = pal.grid;
      ch.update('none');
    }
  }

  function applyTheme(theme){
    const next = (theme === 'atelier' || theme === 'obsidian' || theme === 'kinetic') ? theme : 'kinetic';
    document.documentElement.setAttribute('data-theme', next);
    try { localStorage.setItem('rl_theme', next); } catch(e) {}
    const meta = document.getElementById('meta-theme-color');
    if (meta) meta.setAttribute('content', THEME_CHART_PALETTES[next].themeColor);
    document.querySelectorAll('.theme-option').forEach(btn => {
      btn.setAttribute('aria-pressed', btn.dataset.themeChoice === next ? 'true' : 'false');
    });
    const lbl = document.getElementById('theme-toggle-label');
    if (lbl) lbl.textContent = next === 'kinetic' ? 'Kinetic' : (next === 'atelier' ? 'Atelier' : 'Obsidian');
    updateChartsTheme();
  }

  function toggleTheme(){
    const order = ['kinetic', 'obsidian', 'atelier'];
    const cur = getActiveTheme();
    const next = order[(order.indexOf(cur) + 1) % order.length];
    applyTheme(next);
    showToast('Theme: ' + next.charAt(0).toUpperCase() + next.slice(1));
  }

  // Smart mobile touch router (v3.4.4):
  // - Inside chart.chartArea (plot box): full XY pan & pinch zoom (locks page scroll).
  // - Outside chart.chartArea (axes/margins/day-night strip):
  //     * Vertical drag  -> scrolls the PAGE vertically (blocks graph pan)
  //     * Horizontal drag -> pans the GRAPH horizontally on X only (blocks page scroll)
  function attachSmartChartTouch(chart){
    const canvas = chart && chart.canvas;
    if (!canvas || canvas._smartTouchBound) return;
    canvas._smartTouchBound = true;

    let mode = null; // 'inside' | 'outside-pending' | 'outside-v' | 'outside-h'
    let startX = 0, startY = 0, lastX = 0;

    function isInsidePlot(touch){
      const rect = canvas.getBoundingClientRect();
      const x = touch.clientX - rect.left;
      const y = touch.clientY - rect.top;
      const ca = chart.chartArea;
      if (!ca) return true;
      return x >= ca.left && x <= ca.right && y >= ca.top && y <= ca.bottom;
    }

    canvas.addEventListener('touchstart', function(e){
      if (e.touches.length !== 1){
        // Multi-touch pinch zoom always goes to Chart.js
        mode = 'inside';
        return;
      }
      const t = e.touches[0];
      startX = lastX = t.clientX;
      startY = t.clientY;
      if (isInsidePlot(t)){
        mode = 'inside';
      } else {
        mode = 'outside-pending';
        // Keep Hammer/Chart.js from grabbing touches that start on the axis gutters
        e.stopImmediatePropagation();
      }
    }, { capture: true, passive: false });

    canvas.addEventListener('touchmove', function(e){
      if (e.touches.length !== 1 || mode === 'inside'){
        // Inside plot box or pinch-zooming: prevent page scroll so XY pan/zoom works cleanly
        if (e.cancelable) e.preventDefault();
        return;
      }
      const t = e.touches[0];
      const dxTotal = t.clientX - startX;
      const dyTotal = t.clientY - startY;

      if (mode === 'outside-pending'){
        if (Math.hypot(dxTotal, dyTotal) < 8){
          e.stopImmediatePropagation();
          return;
        }
        mode = (Math.abs(dyTotal) >= Math.abs(dxTotal)) ? 'outside-v' : 'outside-h';
      }

      if (mode === 'outside-v'){
        // Vertical motion outside plot box -> native vertical page scroll, never pan graph
        e.stopImmediatePropagation();
        return;
      }

      if (mode === 'outside-h'){
        // Horizontal motion outside plot box -> rAF-throttled X-axis pan only
        if (e.cancelable) e.preventDefault();
        e.stopImmediatePropagation();
        const stepX = t.clientX - lastX;
        lastX = t.clientX;
        if (stepX !== 0 && typeof chart.pan === 'function'){
          chart._pendingPanX = (chart._pendingPanX || 0) + stepX;
          if (!chart._panRaf){
            chart._panRaf = requestAnimationFrame(() => {
              chart._panRaf = 0;
              const dx = chart._pendingPanX || 0;
              chart._pendingPanX = 0;
              if (dx !== 0){
                chart.pan({ x: dx, y: 0 }, undefined, 'none');
                syncOtherChart({ chart });
              }
            });
          }
        }
      }
    }, { capture: true, passive: false });

    function onTouchDone(e){
      if (mode === 'outside-h'){
        e.stopImmediatePropagation();
        onViewChanged({ chart });
      } else if (mode === 'outside-v' || mode === 'outside-pending'){
        e.stopImmediatePropagation();
      }
      mode = null;
    }
    canvas.addEventListener('touchend', onTouchDone, { capture: true, passive: true });
    canvas.addEventListener('touchcancel', onTouchDone, { capture: true, passive: true });
  }

  function ensureChart(){
    if (chartTemp && chartHum) return;
    const pal = getChartThemePalette();
    chartTemp = buildSeriesChart('rt-chart-temp', pal.temp, pal.tempBg, 'Temperature', '°C', true, 'temp-readout');
    chartHum = buildSeriesChart('rt-chart-hum', pal.hum, pal.humBg, 'Humidity', '%RH', true, 'hum-readout');
    attachSmartChartTouch(chartTemp);
    attachSmartChartTouch(chartHum);
    updateChartsTheme();
  }

  // Sync toggle button, gap checkbox, vault auth & picker state on load
  applyTheme(getActiveTheme());
  (function initV340Controls(){
    const cb = document.getElementById('toggle-gaps');
    if (cb) cb.checked = showGapShading;
    const authEl = document.getElementById('fb-auth-secret');
    if (authEl){
      try { authEl.value = localStorage.getItem(FB_AUTH_LS) || ''; } catch(e) {}
    }
    renderAnomalyUI();
    loadCmdQueueAndHistory();
    renderCmdQueueSection();
    if (cmdQueue.length > 0 && navigator.onLine !== false){
      setTimeout(() => processNextCmdQueue(), 1200);
    }
    window.addEventListener('online', () => {
      if (!activeCmdJob && cmdQueue.length > 0) processNextCmdQueue();
    });
  })();

  // Keeps the chart NOT being dragged/zoomed visually in step with the one
  // that is, during the gesture itself (not just once it completes). Only
  // the x (time) axis is mirrored — temp and humidity have different units,
  // so each chart's y-axis zoom/pan stays independent.
  function syncOtherChart({ chart }){
    const other = chart === chartTemp ? chartHum : chartTemp;
    if (!other) return;
    other.options.scales.x.min = chart.scales.x.min;
    other.options.scales.x.max = chart.scales.x.max;
    other.update('none');
  }

  function setChartDomain(min, max, extraNote){
    [chartTemp, chartHum].forEach(c => { c.options.scales.x.min = min; c.options.scales.x.max = max; });
    redrawChart(min, max, extraNote);
  }

  function hexToRgba(hex, alpha){
    const h = hex.replace('#', '');
    if (h.length !== 6) return 'rgba(158,107,67,' + alpha + ')';
    const r = parseInt(h.slice(0, 2), 16);
    const g = parseInt(h.slice(2, 4), 16);
    const b = parseInt(h.slice(4, 6), 16);
    return 'rgba(' + r + ',' + g + ',' + b + ',' + alpha + ')';
  }

  function makeAreaGradient(context, hexColor){
    const { ctx, chartArea } = context.chart;
    if (!chartArea) return hexToRgba(hexColor, 0.08);
    const theme = getActiveTheme();
    const cacheKey = hexColor + '|' + theme + '|' + Math.round(chartArea.top) + '|' + Math.round(chartArea.bottom);
    if (context.chart._areaGradKey === cacheKey && context.chart._areaGrad){
      return context.chart._areaGrad;
    }
    const grad = ctx.createLinearGradient(0, chartArea.top, 0, chartArea.bottom);
    const topAlpha = theme === 'atelier' ? 0.20 : 0.18;
    grad.addColorStop(0, hexToRgba(hexColor, topAlpha));
    grad.addColorStop(1, hexToRgba(hexColor, 0.0));
    context.chart._areaGradKey = cacheKey;
    context.chart._areaGrad = grad;
    return grad;
  }

  let userZoomedY = false;

  function applyYAxisBounds(chart, pts, outdoorPts, minSpan, clampLo, clampHi){
    if (userZoomedY) return;
    let lo = Infinity, hi = -Infinity;
    const scan = (arr) => {
      if (!arr) return;
      for (const p of arr){
        if (p && p.y !== null && p.y !== undefined && Number.isFinite(p.y)){
          if (p.y < lo) lo = p.y;
          if (p.y > hi) hi = p.y;
        }
      }
    };
    scan(pts);
    scan(outdoorPts);
    if (!Number.isFinite(lo) || !Number.isFinite(hi)){
      delete chart.options.scales.y.min;
      delete chart.options.scales.y.max;
      return;
    }
    const span = hi - lo;
    let yMin, yMax;
    if (span < minSpan){
      const mid = (lo + hi) / 2;
      yMin = mid - minSpan / 2;
      yMax = mid + minSpan / 2;
    } else {
      const pad = span * 0.12;
      yMin = lo - pad;
      yMax = hi + pad;
    }
    if (clampLo !== null && yMin < clampLo) yMin = clampLo;
    if (clampHi !== null && yMax > clampHi) yMax = clampHi;
    const nextMin = Math.floor(yMin * 10) / 10;
    const nextMax = Math.ceil(yMax * 10) / 10;
    chart.options.scales.y.min = nextMin;
    chart.options.scales.y.max = nextMax;
    chart._autoYMin = nextMin;
    chart._autoYMax = nextMax;
  }

  function updateSeriesStats(elId, pts, unit){
    const el = document.getElementById(elId);
    if (!el) return;
    let lo = Infinity, hi = -Infinity, sum = 0, n = 0;
    for (const p of pts){
      if (p && p.y !== null && p.y !== undefined && Number.isFinite(p.y)){
        if (p.y < lo) lo = p.y;
        if (p.y > hi) hi = p.y;
        sum += p.y;
        n++;
      }
    }
    if (!n){
      el.innerHTML = '<span>Min <b>—</b></span><span>Avg <b>—</b></span><span>Max <b>—</b></span>';
      return;
    }
    const avg = sum / n;
    el.innerHTML =
      '<span>Min <b>' + lo.toFixed(1) + unit + '</b></span>' +
      '<span>Avg <b>' + avg.toFixed(1) + unit + '</b></span>' +
      '<span>Max <b>' + hi.toFixed(1) + unit + '</b></span>';
  }

  function redrawChart(rangeStart, rangeEnd, extraNote){
    const sorted = getValidSorted();
    const { tempPoints, humPoints, avgPerPoint, gaps, pointCount } = bucketize(sorted, rangeStart, rangeEnd);
    chartTemp.data.datasets[0].data = tempPoints;
    chartHum.data.datasets[0].data = humPoints;
    const weather = weatherOverlayPoints(rangeStart, rangeEnd);
    chartTemp.data.datasets[1].data = weather.tempPoints;
    chartHum.data.datasets[1].data = weather.humPoints;
    chartTemp.options.plugins.gapShading.gaps = gaps;
    chartHum.options.plugins.gapShading.gaps = gaps;
    applyYAxisBounds(chartTemp, tempPoints, weather.tempPoints, 2.0, null, null);
    applyYAxisBounds(chartHum, humPoints, weather.humPoints, 6.0, 0, 100);
    const rawVis = sorted.filter(e => e.epochMs >= rangeStart && e.epochMs <= rangeEnd);
    updateSeriesStats('temp-stats', rawVis.map(e => ({ y: e.temp })), '°C');
    updateSeriesStats('hum-stats', rawVis.map(e => ({ y: e.hum })), '%');
    chartTemp.update('none');
    chartHum.update('none');
    // Fire-and-forget: makes sure the cache actually covers what was just
    // drawn, fetching/extending it if not. Never awaited here -- redrawChart
    // must stay synchronous (called from live polls, pan/zoom, range
    // switches) and a missing/stale weather cache should never block or
    // delay the real sensor chart. It redraws just the overlay itself
    // (redrawWeatherOnly()) once new data actually lands.
    updateWeatherOverlay(rangeStart, rangeEnd);
    let note = extraNote;
    if (staleFromPriorBoot > 0){
      const staleNote = staleFromPriorBoot + ' reading' + (staleFromPriorBoot === 1 ? '' : 's') +
        " from before the sensor had a synced clock excluded (can't be placed in real time)";
      note = note ? (note + ' · ' + staleNote) : staleNote;
    }
    if (gaps.length){
      const totalOfflineMs = gaps.reduce((sum, g) => sum + (g.end - g.start), 0);
      const gapNote = gaps.length + ' offline gap' + (gaps.length === 1 ? '' : 's') +
        ' (' + formatSpan(totalOfflineMs) + ' total) shaded';
      note = note ? (note + ' · ' + gapNote) : gapNote;
    }
    const avgGapSec = computeAvgGapSeconds(sorted, rangeStart, rangeEnd);
    updateCaption(rangeStart, rangeEnd, pointCount, avgPerPoint, note, avgGapSec);
    if (entriesByKey.size > 0) hideEmptyState();
  }

  function computeAvgGapSeconds(sorted, rangeStart, rangeEnd){
    const vis = sorted.filter(e => e.epochMs >= rangeStart && e.epochMs <= rangeEnd);
    if (vis.length < 2) return null;
    let sumMs = 0, count = 0;
    for (let i = 1; i < vis.length; i++){
      const dt = vis[i].epochMs - vis[i - 1].epochMs;
      // Exclude multi-minute offline gaps so the average reflects real sensor cadence
      if (dt > 0 && dt <= getGapThresholdMs()){
        sumMs += dt;
        count++;
      }
    }
    if (!count){
      // Fallback: if every gap exceeded GAP_THRESHOLD_MS, average all positive gaps
      for (let i = 1; i < vis.length; i++){
        const dt = vis[i].epochMs - vis[i - 1].epochMs;
        if (dt > 0){ sumMs += dt; count++; }
      }
    }
    return count ? (sumMs / count / 1000) : null;
  }

  function updateCaption(rangeStart, rangeEnd, pointCount, avgPerPoint, extraNote, avgGapSec){
    const el = document.getElementById('chart-caption');
    const smoothNote = avgPerPoint > 1 ? (' · smoothed, ~' + avgPerPoint + ' readings/pt') : ' · raw resolution';
    const gapNote = (avgGapSec !== null && avgGapSec !== undefined && Number.isFinite(avgGapSec))
      ? (' · avg gap ' + avgGapSec.toFixed(1) + 's') : '';
    let text = formatFull(rangeStart) + ' \u2192 ' + formatFull(rangeEnd) + ' · ' + pointCount + ' pts' + gapNote + smoothNote;
    if (extraNote) text += ' · ' + extraNote;
    el.textContent = text;
  }

  function hideEmptyState(){ document.getElementById('chart-empty').style.display = 'none'; }
  function showEmptyState(){ document.getElementById('chart-empty').style.display = 'flex'; }

  // debounced: fires after the user stops panning/zooming either chart
  function onViewChanged({ chart }){
    const yScale = chart && chart.scales && chart.scales.y;
    if (yScale && chart._autoYMin !== undefined && chart._autoYMax !== undefined){
      if (Math.abs(yScale.min - chart._autoYMin) > 0.15 || Math.abs(yScale.max - chart._autoYMax) > 0.15){
        userZoomedY = true;
      }
    }
    clearTimeout(viewChangeTimer);
    viewChangeTimer = setTimeout(async () => {
      userHasInteracted = true;
      const min = chart.scales.x.min, max = chart.scales.x.max;
      const sorted = getValidSorted();
      const edgeBuffer = (max - min) * 0.15;
      if (sorted.length && min <= sorted[0].epochMs + edgeBuffer && !noMoreHistory){
        await fetchOlderPage();
      }
      redrawChart(chart.scales.x.min, chart.scales.x.max);
    }, 400);
  }

  // ---------- weather overlay (Open-Meteo) ----------
  // Faint outdoor reference line (v2.19.0) so the two sensor charts can be
  // checked against a real weather station -- "is my room actually 4
  // degrees warmer than outside, or did the DHT22 drift?" Open-Meteo was
  // picked because it's free, needs no API key, and is CORS-friendly for a
  // static page with no backend of its own to proxy through.
  function setWeatherStatus(text){
    const el = document.getElementById('weather-status');
    el.textContent = text || '';
    el.style.display = text ? '' : 'none';
  }

  // Accepts "lat,lon" typed into the override field. Takes priority over
  // geolocation whenever non-empty -- lets the field double as "my room
  // isn't wherever my phone happens to be right now" without needing a
  // separate on/off control of its own.
  function manualWeatherLoc(){
    const raw = document.getElementById('weather-loc').value.trim();
    if (!raw) return null;
    const m = raw.match(/^(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)$/);
    return m ? { lat: Number(m[1]), lon: Number(m[2]) } : null;
  }

  // Cached in weatherLocPromise so a second caller mid-lookup (e.g. both
  // charts' redraw firing in the same tick) shares the one browser prompt
  // instead of triggering it twice.
  function resolveWeatherLoc(){
    const manual = manualWeatherLoc();
    if (manual) return Promise.resolve(manual);
    if (weatherLocPromise) return weatherLocPromise;
    if (!('geolocation' in navigator)){
      setWeatherStatus('No device location available — enter "lat,lon" above to enable the outdoor line.');
      return Promise.resolve(null);
    }
    setWeatherStatus('Locating device for outdoor weather…');
    weatherLocPromise = new Promise((resolve) => {
      navigator.geolocation.getCurrentPosition(
        (pos) => resolve({ lat: pos.coords.latitude, lon: pos.coords.longitude }),
        () => resolve(null),
        { timeout: 10000, maximumAge: 30 * 60 * 1000 }
      );
    });
    return weatherLocPromise;
  }

  function dateStr(ms){ return new Date(ms).toISOString().slice(0, 10); }

  async function fetchWeatherJson(url){
    const res = await fetch(url, { cache: 'no-store' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return res.json();
  }

  // Both Open-Meteo endpoints are called with timezone=UTC, so hourly.time
  // strings ("2026-08-17T00:00") are plain UTC clock times with no offset
  // to resolve -- appending "Z" and parsing is all that's needed to line
  // them up with the sensor chart's epochMs, no local-timezone guessing.
  function hourlyToPoints(hourly){
    const temp = [], hum = [];
    if (!hourly || !hourly.time) return { temp, hum };
    for (let i = 0; i < hourly.time.length; i++){
      const x = Date.parse(hourly.time[i] + 'Z');
      if (isNaN(x)) continue;
      const t = hourly.temperature_2m ? hourly.temperature_2m[i] : null;
      const h = hourly.relative_humidity_2m ? hourly.relative_humidity_2m[i] : null;
      if (t !== null && t !== undefined) temp.push({ x, y: t });
      if (h !== null && h !== undefined) hum.push({ x, y: h });
    }
    return { temp, hum };
  }

  // Pulls whatever hourly outdoor data covers [startMs, endMs] and merges
  // it into weatherCache (deduped by timestamp, kept sorted, never just
  // replaced -- weather history doesn't change once recorded, so there's
  // no reason to re-fetch a span already cached). A span within the last
  // WEATHER_RECENT_LIMIT_DAYS is covered by /forecast alone (fresher, and
  // the only one of the two with the current hour); anything reaching
  // further back also pulls /archive for the older portion, since
  // /forecast's past_days tops out at 92.
  async function fetchAndMergeWeather(lat, lon, startMs, endMs){
    const now = Date.now();
    const recentCutoff = now - WEATHER_RECENT_LIMIT_DAYS * DAY;
    const sameLoc = weatherCache && weatherCache.lat === lat && weatherCache.lon === lon;
    const tempMap = new Map(sameLoc ? weatherCache.temp.map(p => [p.x, p.y]) : []);
    const humMap = new Map(sameLoc ? weatherCache.hum.map(p => [p.x, p.y]) : []);

    const legs = [];
    if (endMs >= recentCutoff){
      // How far back the /forecast call needs to reach: never further than
      // the actual requested startMs (a 24h view should only ask for ~1
      // day, not 90), and never further than recentCutoff either (anything
      // older than that is /archive's job, pulled separately below). That's
      // the LARGER (more recent) of the two -- Math.max, not Math.min.
      const forecastStart = Math.max(startMs, recentCutoff);
      const pastDays = Math.min(92, Math.max(1, Math.ceil((now - forecastStart) / DAY)));
      legs.push({ name: 'forecast', url:
        'https://api.open-meteo.com/v1/forecast?latitude=' + lat + '&longitude=' + lon +
        '&hourly=temperature_2m,relative_humidity_2m&past_days=' + pastDays +
        '&forecast_days=1&timezone=UTC' });
    }
    if (startMs < recentCutoff){
      legs.push({ name: 'archive', url:
        'https://archive-api.open-meteo.com/v1/archive?latitude=' + lat + '&longitude=' + lon +
        '&start_date=' + dateStr(startMs) + '&end_date=' + dateStr(recentCutoff) +
        '&hourly=temperature_2m,relative_humidity_2m&timezone=UTC' });
    }

    // allSettled, not all: /forecast and /archive are independent services,
    // and a transient failure of one shouldn't throw away data the other
    // one successfully returned (Promise.all would reject the whole thing
    // on either failing, discarding both).
    const settled = await Promise.allSettled(legs.map(l => fetchWeatherJson(l.url)));
    let anyOk = false;
    settled.forEach((res, i) => {
      if (res.status === 'fulfilled'){
        anyOk = true;
        const pts = hourlyToPoints(res.value.hourly);
        for (const p of pts.temp) tempMap.set(p.x, p.y);
        for (const p of pts.hum) humMap.set(p.x, p.y);
      } else {
        console.warn('Weather ' + legs[i].name + ' fetch failed:', res.reason && res.reason.message);
      }
    });
    if (!anyOk) throw new Error('all weather requests failed');

    const temp = [...tempMap.entries()].sort((a, b) => a[0] - b[0]).map(([x, y]) => ({ x, y }));
    const hum = [...humMap.entries()].sort((a, b) => a[0] - b[0]).map(([x, y]) => ({ x, y }));
    // minMs/maxMs come from what's ACTUALLY in the merged data (its first
    // and last timestamps -- already sorted, so no need to scan), not from
    // the requested startMs/endMs. That matters when one leg fails: if
    // /archive is down while /forecast succeeds, the merged set genuinely
    // doesn't reach as far back as startMs, and weatherCovers() needs to
    // see that honestly so it retries the missing portion next time
    // instead of believing a gap is already covered.
    const edges = [];
    if (temp.length) edges.push(temp[0].x, temp[temp.length - 1].x);
    if (hum.length) edges.push(hum[0].x, hum[hum.length - 1].x);
    weatherCache = {
      lat, lon, fetchedAt: now,
      minMs: edges.length ? Math.min(...edges) : startMs,
      maxMs: edges.length ? Math.max(...edges) : endMs,
      temp, hum
    };
  }


  // True when weatherCache already has what [rangeStart, rangeEnd] needs.
  // The "still reaches now" freshness check only applies while the visible
  // window's right edge is recent -- a view parked entirely in the past
  // never goes stale, since historical weather doesn't change.
  function weatherCovers(rangeStart, rangeEnd){
    if (!weatherCache) return false;
    if (weatherCache.minMs > rangeStart + DAY) return false;
    if (weatherCache.maxMs < rangeEnd - 2 * 60 * 60 * 1000) return false;
    if (rangeEnd >= Date.now() - DAY && (Date.now() - weatherCache.fetchedAt) > WEATHER_REFRESH_MS) return false;
    return true;
  }

  function downsample(points, maxPoints){
    if (points.length <= maxPoints) return points;
    const stride = Math.ceil(points.length / maxPoints);
    const out = [];
    for (let i = 0; i < points.length; i += stride) out.push(points[i]);
    return out;
  }

  // Reads straight from whatever's already cached -- never triggers a
  // fetch itself (see updateWeatherOverlay for that), so it's always safe
  // to call synchronously from redrawChart().
  function weatherOverlayPoints(rangeStart, rangeEnd){
    if (!weatherEnabled || !weatherCache) return { tempPoints: [], humPoints: [] };
    const temp = weatherCache.temp.filter(p => p.x >= rangeStart && p.x <= rangeEnd);
    const hum = weatherCache.hum.filter(p => p.x >= rangeStart && p.x <= rangeEnd);
    return { tempPoints: downsample(temp, WEATHER_MAX_POINTS), humPoints: downsample(hum, WEATHER_MAX_POINTS) };
  }

  // Re-pulls just the overlay datasets from the current cache and repaints
  // -- used once an async fetch lands, instead of re-running redrawChart()'s
  // full bucketize() pass (and risking looping back into another fetch).
  function redrawWeatherOnly(){
    if (!chartTemp || !chartHum) return;
    const min = chartTemp.options.scales.x.min, max = chartTemp.options.scales.x.max;
    const { tempPoints, humPoints } = weatherOverlayPoints(min, max);
    chartTemp.data.datasets[1].data = tempPoints;
    chartHum.data.datasets[1].data = humPoints;
    applyYAxisBounds(chartTemp, chartTemp.data.datasets[0].data, tempPoints, 2.0, null, null);
    applyYAxisBounds(chartHum, chartHum.data.datasets[0].data, humPoints, 6.0, 0, 100);
    chartTemp.update('none');
    chartHum.update('none');
  }

  // The one entry point redrawChart() calls. Resolves location if needed,
  // checks whether the cache already covers what's visible, and if not,
  // fetches -- all without ever blocking the caller (nothing here is
  // awaited from redrawChart). A failed fetch or denied location just
  // leaves the overlay empty; it never disturbs the real sensor chart.
  async function updateWeatherOverlay(rangeStart, rangeEnd){
    if (!weatherEnabled) return;
    if (!weatherLoc){
      const loc = await resolveWeatherLoc();
      if (!loc){
        setWeatherStatus('Outdoor line unavailable — location access was denied. Enter "lat,lon" above to set it manually.');
        return;
      }
      weatherLoc = loc;
      setWeatherStatus('');
    }
    if (weatherCovers(rangeStart, rangeEnd)) return;
    if (weatherFetchPromise){
      await weatherFetchPromise;
      redrawWeatherOnly();
      return;
    }
    setWeatherStatus('Loading outdoor weather…');
    weatherFetchPromise = fetchAndMergeWeather(weatherLoc.lat, weatherLoc.lon, rangeStart, rangeEnd)
      .catch((err) => {
        console.warn('Weather fetch failed:', err.message);
        setWeatherStatus('Outdoor weather unavailable right now.');
      })
      .finally(() => { weatherFetchPromise = null; });
    await weatherFetchPromise;
    if (weatherCache) setWeatherStatus('');
    redrawWeatherOnly();
  }

  function toggleWeather(){
    const sw = document.getElementById('weather-switch');
    weatherEnabled = sw.classList.toggle('on');
    saveSetting('weather_on', weatherEnabled ? '1' : '0');
    if (!weatherEnabled){
      setWeatherStatus('');
      if (chartTemp && chartHum){
        chartTemp.data.datasets[1].data = [];
        chartHum.data.datasets[1].data = [];
        chartTemp.update('none');
        chartHum.update('none');
      }
      return;
    }
    if (chartTemp){
      updateWeatherOverlay(chartTemp.options.scales.x.min, chartTemp.options.scales.x.max);
    }
  }

  // ---------- stat cards ----------
  function renderCurrent(latest){
    if (!latest) return;
    document.getElementById('temp-value').innerHTML = latest.temp.toFixed(1) + '<span class="unit">°C</span>';
    document.getElementById('hum-value').innerHTML = latest.hum.toFixed(1) + '<span class="unit">%RH</span>';
    latestReadingEpoch = latest.epochMs;
    updateAgeText();
    renderStatusUi();
    updateHeroOverview();

    ['stat-temp', 'stat-hum'].forEach(id => {
      const el = document.getElementById(id);
      if (!el) return;
      el.classList.remove('pulse');
      requestAnimationFrame(() => el.classList.add('pulse'));
    });
  }
  function updateAgeText(){
    if (latestReadingEpoch === null) return;
    const text = timeAgo(Date.now() - latestReadingEpoch) + ' · ' + formatClock(latestReadingEpoch);
    document.getElementById('temp-age').textContent = text;
    document.getElementById('hum-age').textContent = text;
    updateHeroAgeText(text);
  }
  setInterval(updateAgeText, 5000);

  // staleness sweep -- gated on lastNewDataMs (last genuinely new reading),
  // not lastFetchOk (last successful Firebase round-trip). Those diverge
  // exactly when the ESP32 has gone quiet but Firebase itself is still up:
  // lastFetchOk keeps refreshing every poll either way, which used to keep
  // the LED green/"reachable" straight through an hour-long sensor outage.
  setInterval(() => {
    if (lastNewDataMs && Date.now() - lastNewDataMs > stalenessThresholdMs()) setConnState('stale');
    renderStatusUi();
  }, 10000);

  // ---------- auto-refresh ----------
  function getRefreshSeconds(){
    const input = document.getElementById('refresh-secs');
    let v = parseInt(input.value, 10);
    if (isNaN(v) || v < 3) v = 15;
    input.value = v;
    return v;
  }
  function toggleAuto(){
    const sw = document.getElementById('auto-switch');
    const isOn = sw.classList.toggle('on');
    saveSetting('auto_on', isOn ? '1' : '0');
    if (autoTimer){ clearInterval(autoTimer); autoTimer = null; }
    if (isOn){
      fetchReadings();
      autoTimer = setInterval(fetchReadings, getRefreshSeconds() * 1000);
    } else {
      clearInterval(autoTimer);
      autoTimer = null;
    }
  }
  document.getElementById('refresh-secs').addEventListener('change', () => {
    const secs = getRefreshSeconds();
    if (autoTimer){
      clearInterval(autoTimer);
      autoTimer = setInterval(fetchReadings, secs * 1000);
    }
  });

  document.getElementById('range-select').addEventListener('change', () => { applyRangeSelection(); });

  // Typing a manual override invalidates whatever location/data is cached
  // under the old one -- resolveWeatherLoc() picks the new value straight
  // back up on the next redraw since manualWeatherLoc() is checked first.
  document.getElementById('weather-loc').addEventListener('change', () => {
    weatherLoc = null; weatherLocPromise = null; weatherCache = null;
    if (weatherEnabled && chartTemp){
      updateWeatherOverlay(chartTemp.options.scales.x.min, chartTemp.options.scales.x.max);
    }
  });

  document.getElementById('fb-host').addEventListener('change', () => {
    entriesByKey.clear();
    invalidateSorted();
    anchorNewestKey = null; anchorNowMs = null; keyScaleToMs = 1;
    staleFromPriorBoot = 0; lastKnownPowerMode = 'normal';
    sessionPeakKey = null; lastNewDataMs = null;
    noMoreHistory = false; currentFetchLimit = PAGE_SIZE;
    userHasInteracted = false; latestReadingEpoch = null;
    if (typeof stopStatusSse === 'function') stopStatusSse();
    lastFetchedStatus = null; lastKnownDeviceIp = ''; stagedPowerMode = null;
    lastCloudPanelSig = ''; window._lastRenderedLinkIp = '';
    ['cloud-health-list', 'cloud-wifi-list', 'cloud-telemetry-body', 'cloud-storage-body'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.innerHTML = '';
    });
    document.getElementById('temp-value').innerHTML = '—<span class="unit">°C</span>';
    document.getElementById('hum-value').innerHTML = '—<span class="unit">%RH</span>';
    document.getElementById('temp-age').textContent = 'no data yet';
    document.getElementById('hum-age').textContent = 'no data yet';
    document.getElementById('device-status-row').style.display = 'none';
    document.getElementById('dash-links').innerHTML = '';
    showEmptyState();
    fetchReadings();
  });

  // ---------- Firmware / OTA (2-repo GitHub Actions integration) ----------
  function updateOtaButtons(){
    const flashBtn = document.getElementById('btn-flash-esp');
    const cloudBtn = document.getElementById('btn-cloud-ota');
    const copyBtn = document.getElementById('btn-copy-bin');
    if (copyBtn) copyBtn.disabled = !latestBinUrl;
    if (flashBtn) flashBtn.disabled = !(latestBinUrl && lastKnownDeviceIp);
    if (cloudBtn) cloudBtn.disabled = !latestBinUrl;
  }

  async function fetchFirmwareInfo(){
    const metaEl = document.getElementById('ota-meta');
    try{
      const verUrl = new URL('firmware/version.json', window.location.href).href;
      const res = await fetch(verUrl, { cache: 'no-store' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const info = await res.json();
      latestBinUrl = new URL(info.file || 'firmware/latest.bin', window.location.href).href;
      const kb = info.sizeBytes ? (info.sizeBytes / 1024).toFixed(1) + ' KB' : 'unknown size';
      const when = info.builtAt ? formatFull(Date.parse(info.builtAt)) : 'unknown time';
      metaEl.innerHTML =
        'Latest build <b>' + escapeHtml(info.commit || 'unknown') + '</b> · ' +
        escapeHtml(kb) + ' · built ' + escapeHtml(when);
    } catch(err){
      latestBinUrl = '';
      metaEl.textContent = 'No published build found yet at firmware/version.json (' + err.message + '). Push room_logger.ino to trigger build.yml.';
    }
    updateOtaButtons();
  }

  function openEspOta(){
    if (!lastKnownDeviceIp || !latestBinUrl) return;
    const target = 'http://' + encodeURI(lastKnownDeviceIp) + '/update?url=' + encodeURIComponent(latestBinUrl);
    window.open(target, '_blank', 'noopener');
  }

  function copyBinUrl(){
    if (!latestBinUrl) return;
    const msgEl = document.getElementById('ota-push-msg');
    if (navigator.clipboard && navigator.clipboard.writeText){
      navigator.clipboard.writeText(latestBinUrl)
        .then(() => { msgEl.textContent = 'Copied .bin URL to clipboard.'; })
        .catch(() => { msgEl.textContent = latestBinUrl; });
    } else {
      msgEl.textContent = latestBinUrl;
    }
  }

  function textToBase64Utf8(str){
    const bytes = new TextEncoder().encode(str);
    let bin = '';
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin);
  }

  async function pushInoToGithub(){
    const repo = document.getElementById('gh-fw-repo').value.trim();
    const path = document.getElementById('gh-fw-path').value.trim() || 'room_logger/room_logger.ino';
    const token = document.getElementById('gh-fw-token').value.trim();
    const fileInput = document.getElementById('gh-ino-file');
    const msgEl = document.getElementById('ota-push-msg');
    const btn = document.getElementById('btn-push-ino');

    if (!/^[^/\s]+\/[^/\s]+$/.test(repo)){
      msgEl.textContent = 'Enter firmware repo in owner/repo format.';
      return;
    }
    if (!token){
      msgEl.textContent = 'Enter a GitHub PAT with Contents: Read & Write permission.';
      return;
    }
    if (!fileInput.files || !fileInput.files.length){
      msgEl.textContent = 'Select a room_logger.ino file first.';
      return;
    }

    btn.disabled = true;
    msgEl.textContent = 'Uploading to GitHub…';
    try{
      const content = await fileInput.files[0].text();
      const apiUrl = 'https://api.github.com/repos/' + repo + '/contents/' + encodeURI(path);
      const headers = {
        'Authorization': 'Bearer ' + token,
        'Accept': 'application/vnd.github+json',
        'Content-Type': 'application/json'
      };
      let sha = undefined;
      const getRes = await fetch(apiUrl, { headers, cache: 'no-store' });
      if (getRes.ok){
        const existing = await getRes.json();
        sha = existing.sha;
      }
      const body = {
        message: 'Update ' + path + ' from Room Logger PWA',
        content: textToBase64Utf8(content)
      };
      if (sha) body.sha = sha;
      const putRes = await fetch(apiUrl, { method: 'PUT', headers, body: JSON.stringify(body) });
      if (!putRes.ok){
        const errTxt = await putRes.text();
        throw new Error('HTTP ' + putRes.status + ': ' + errTxt.slice(0, 120));
      }
      msgEl.textContent = 'Pushed! GitHub Actions (build.yml) is compiling now (~1–2 min). Tap "Check build" once finished.';
    } catch(err){
      msgEl.textContent = 'Push failed: ' + err.message;
    } finally{
      btn.disabled = false;
    }
  }

  // ---------- App Self-Update Check & Force Refresh ----------
  function compareSemver(a, b){
    const pa = String(a || '0.0.0').replace(/^v/i, '').split('.').map(n => parseInt(n, 10) || 0);
    const pb = String(b || '0.0.0').replace(/^v/i, '').split('.').map(n => parseInt(n, 10) || 0);
    for (let i = 0; i < 3; i++){
      if ((pa[i] || 0) > (pb[i] || 0)) return 1;
      if ((pa[i] || 0) < (pb[i] || 0)) return -1;
    }
    return 0;
  }

  function dismissUpdatePopup(){
    const pop = document.getElementById('update-popup');
    if (pop) pop.classList.remove('show');
  }

  async function checkAppUpdate(manual){
    const metaEl = document.getElementById('app-ver-meta');
    const popEl = document.getElementById('update-popup');
    const popText = document.getElementById('update-popup-text');
    if (manual && metaEl) metaEl.textContent = 'Checking for app updates…';
    try{
      const url = new URL('app-version.json', window.location.href).href + '?_=' + Date.now();
      const res = await fetch(url, { cache: 'no-store' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const data = await res.json();
      const remoteVer = String(data.version || '').replace(/^v/i, '');
      if (remoteVer && compareSemver(remoteVer, APP_VERSION) > 0){
        if (metaEl) metaEl.innerHTML = 'Running <b>v' + escapeHtml(APP_VERSION) + '</b> · <span class="status-pill warn" style="margin-left:0;">Update v' + escapeHtml(remoteVer) + ' available</span>';
        if (popText) popText.textContent = 'Update available: v' + remoteVer + ' (currently v' + APP_VERSION + '). Tap Refresh to update.';
        if (popEl) popEl.classList.add('show');
      } else {
        if (metaEl) metaEl.innerHTML = 'Running <b>v' + escapeHtml(APP_VERSION) + '</b> · up to date';
        if (popEl) popEl.classList.remove('show');
      }
    } catch(err){
      if (metaEl) metaEl.innerHTML = 'Running <b>v' + escapeHtml(APP_VERSION) + '</b> · could not check updates (' + escapeHtml(err.message) + ')';
    }
  }

  async function forceUpdateApp(){
    const metaEl = document.getElementById('app-ver-meta');
    if (metaEl) metaEl.textContent = 'Clearing app cache and reloading…';
    try{
      if ('caches' in window){
        const keys = await caches.keys();
        await Promise.all(keys.map(k => caches.delete(k)));
      }
      if ('serviceWorker' in navigator){
        const regs = await navigator.serviceWorker.getRegistrations();
        await Promise.all(regs.map(r => r.unregister()));
      }
    } catch(e){
      console.warn('Cache clear warning:', e);
    }
    const cleanUrl = window.location.origin + window.location.pathname + '?v=' + Date.now();
    window.location.replace(cleanUrl);
  }

  // ---------- settings persistence (localStorage) ----------
  // Every user-editable field on every tab is restored here on load and
  // re-saved on change, so nothing needs re-entering on a repeat visit --
  // added in v2.20.0. Before this, fb-host in particular (the one field
  // everything else on the page depends on) reset to its hardcoded default
  // every single time despite everything downstream of it looking "sticky"
  // in spirit.
  const SETTINGS_PREFIX = 'roomlogger_';
  function loadSetting(key){
    try { return localStorage.getItem(SETTINGS_PREFIX + key); }
    catch(e){ return null; } // storage unavailable (private browsing etc.) -- just don't restore
  }
  function saveSetting(key, value){
    try { localStorage.setItem(SETTINGS_PREFIX + key, value); }
    catch(e){ /* storage unavailable/full -- app still works, just won't remember this time */ }
  }
  // Text/number/select fields: plain restore-then-persist-on-change. Does
  // NOT dispatch a 'change' event on restore -- every one of these fields'
  // existing 'change' handlers either does nothing useful yet this early
  // (e.g. fb-host's handler resets chart state that doesn't exist on a
  // fresh load) or is redundant with what the initial fetchReadings()/
  // fetchTerminal() calls below already do once every field is restored.
  function restoreField(id){
    const saved = loadSetting(id);
    if (saved !== null) document.getElementById(id).value = saved;
  }
  function wirePersistence(id){
    document.getElementById(id).addEventListener('change', function(){
      saveSetting(id, this.value);
    });
  }
  ['fb-host', 'range-select', 'weather-loc', 'refresh-secs', 'gh-fw-repo', 'gh-fw-path', 'gh-fw-token'].forEach(function(id){
    restoreField(id);
    wirePersistence(id);
  });

  // The three on/off switches persist from inside their own toggle
  // functions (toggleWeather()/toggleAuto()/toggleTermAuto() above) since a
  // click is the only thing that ever changes them -- there's no separate
  // 'change' event to hook the way text/number/select fields have. Restored
  // here by setting the class (and, for weather, the JS flag it actually
  // reads) directly rather than simulating a click: a simulated click on
  // auto-switch/term-auto-switch would call fetchReadings()/fetchTerminal()
  // immediately, duplicating the initial fetches just below, and on
  // weather-switch would hit an early chartTemp-is-null check this early on
  // a fresh load and silently do nothing. Restoring the underlying state
  // directly and letting the normal flow below pick it up avoids both.
  const restoredWeatherOn = loadSetting('weather_on') === '1';
  if (restoredWeatherOn){
    document.getElementById('weather-switch').classList.add('on');
    weatherEnabled = true; // picked up automatically inside fetchReadings()'s own redraw, below
  }
  const restoredAutoOn = loadSetting('auto_on') === '1';
  if (restoredAutoOn) document.getElementById('auto-switch').classList.add('on');
  // initial load
  fetchReadings();
  fetchFirmwareInfo();
  checkAppUpdate(false); // also triggers fetchStatus() and weather (if restored)
  if (restoredAutoOn) autoTimer = setInterval(fetchReadings, getRefreshSeconds() * 1000);

  // ---------- refresh on resume ----------
  // Mobile PWAs/tabs commonly get fully suspended in the background --
  // JS stops running (setInterval included) and the DOM just sits frozen
  // showing whatever it last showed, however stale, until something
  // actually re-runs. Reopening one after a while can also restore it
  // straight from the browser's back/forward cache (bfcache) -- a
  // snapshot from before the page was ever backgrounded, with NO script
  // re-executing at all, not even this file's own initial-load section
  // above. Both look identical to the fetches above having failed, even
  // though they ran fine at the time -- the fix is the same for both:
  // explicitly refetch the moment the page is actually visible/interactive
  // again, rather than trusting whatever's already on screen.
  function refreshAllTabs(){
    // fetchReadings() already kicks off fetchStatus() without blocking.
    fetchReadings();
    checkAppUpdate(false);
  }
  document.addEventListener('visibilitychange', function(){
    if (document.visibilityState === 'visible') refreshAllTabs();
  });
  window.addEventListener('pageshow', function(e){
    if (e.persisted) refreshAllTabs(); // specifically the bfcache-restore case above
  });

// ---------- Service Worker registration ----------
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('sw.js').catch((err) => {
        // Most likely cause: served over plain HTTP (or file://), where
        // service workers are refused outright. Non-fatal either way --
        // the dashboard works the same without one, just without the
        // installable/offline-shell extras.
        console.warn('Service worker registration failed:', err);
      });
    });
  }
