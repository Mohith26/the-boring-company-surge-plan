/* Surge Plan UI. Every number is computed in the browser by core.js from the seeded synthetic history. */
(function () {
  const C = window.SurgeCore, $ = (id) => document.getElementById(id);
  const R = C.runAll({});
  const net = R.net, S = net.S, T0 = C.CFG.startMin;
  const qs = new URLSearchParams(location.search);
  const state = { t: +(qs.get('t') || 1035), policy: qs.get('p') || 'plan', sel: Math.max(0, net.stations.findIndex(s => s.id === (qs.get('st') || 'lvcc-south'))), playing: false };
  const pad = (n) => String(n).padStart(2, '0');
  const hhmm = (m) => `${pad(Math.floor(m / 60) % 24)}:${pad(Math.floor(m % 60))}`;
  const LABEL = { plan: 'Forecast plan', history: 'Historical curve', flat: 'Flat' };
  const COL = { plan: '#ffffff', history: '#d3a259', flat: '#939393' };
  const run = () => R.runs[state.policy];

  // ---------- header / title ----------
  const riders = R.target.parties.reduce((a, p) => a + p.size, 0);
  $("dayTitle").textContent = `Day ${R.target.show.dayIdx + 1} · ${riders.toLocaleString()} riders`;
  $('daySub').textContent = `Surge plan · show closes ${hhmm(R.target.show.closeMin)}`;
  $('covNote').textContent = `90% band · held-out coverage ${(R.coverage * 100).toFixed(1)}%`;
  $('budgetNote').textContent = `${Math.round(R.runs.plan.carMin / 60).toLocaleString()} / ${Math.round(R.runs.history.carMin / 60).toLocaleString()} / ${Math.round(R.runs.flat.carMin / 60).toLocaleString()} driver-hours`;

  // ---------- KPIs ----------
  function renderKpis() {
    const r = run(), h = R.runs.history, mb = R.minBudget;
    const dh = Math.round(r.carMin / 60);
    const cls = (v, t) => (v <= t ? 'good' : 'bad');
    $('kpis').innerHTML = `
      <div class="kpi"><div class="vl-detail muted">p95 wait</div><div class="v ${cls(r.p95, 5)}">${r.p95.toFixed(1)} min</div><div class="s">median ${r.p50.toFixed(1)} min</div></div>
      <div class="kpi"><div class="vl-detail muted">Walked away (&gt;45 min)</div><div class="v ${r.abandoned ? 'bad' : 'good'}">${r.abandoned.toLocaleString()}</div><div class="s">of ${R.target.parties.length.toLocaleString()} parties</div></div>
      <div class="kpi"><div class="vl-detail muted">Driver-hours used</div><div class="v">${dh.toLocaleString()}</div><div class="s">${Math.round(r.emptyMin / 60).toLocaleString()} h empty repositioning</div></div>
      <div class="kpi"><div class="vl-detail muted">Hours to hold p95 ≤ 5 min</div><div class="v">${mb && mb[state.policy] ? Math.round(mb[state.policy] * 18).toLocaleString() : '—'}</div><div class="s">${state.policy === 'plan' && mb ? `<b class="good">${Math.round((1 - mb.plan / mb.history) * 100)}% fewer</b> than historical curve` : mb ? `forecast plan needs ${Math.round(mb.plan * 18).toLocaleString()}` : ''}</div></div>`;
  }

  // ---------- charts ----------
  function svgChart(el, series, opts) {
    const box = el.getBoundingClientRect(), W = Math.max(300, box.width), H = Math.max(90, box.height);
    const l = 34, r = 8, t = 8, b = 18, iw = W - l - r, ih = H - t - b;
    const x0 = opts.x0, x1 = opts.x1, ymax = opts.ymax;
    const X = (x) => l + (x - x0) / (x1 - x0) * iw, Y = (y) => t + ih - Math.min(1, y / ymax) * ih;
    let s = `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">`;
    for (const g of opts.yticks) s += `<line x1="${l}" x2="${W - r}" y1="${Y(g)}" y2="${Y(g)}" stroke="#1a1a1a"/><text x="${l - 6}" y="${Y(g) + 3.5}" fill="#939393" font-size="10" text-anchor="end" font-family="Inter">${g}</text>`;
    for (let hh = 6; hh <= 24; hh += 3) s += `<text x="${X(hh * 60)}" y="${H - 4}" fill="#939393" font-size="10" text-anchor="${hh === 24 ? 'end' : hh === 6 ? 'start' : 'middle'}" font-family="Inter">${pad(hh % 24)}:00</text>`;
    for (const se of series) {
      if (se.band) {
        let d = ''; se.band.forEach(([x, lo], k) => { d += (k ? 'L' : 'M') + X(x) + ',' + Y(lo); });
        for (let k = se.band.length - 1; k >= 0; k--) d += 'L' + X(se.band[k][0]) + ',' + Y(se.band[k][2]);
        s += `<path d="${d}Z" fill="${se.fill}"/>`; continue;
      }
      let d = ''; se.pts.forEach(([x, y], k) => { d += (k ? 'L' : 'M') + X(x).toFixed(1) + ',' + Y(y).toFixed(1); });
      s += `<path d="${d}" fill="none" stroke="${se.color}" stroke-width="${se.w || 1.5}" ${se.dash ? `stroke-dasharray="${se.dash}"` : ''} ${se.step ? '' : ''}/>`;
      if (se.label) { const last = se.pts[se.labelAt || se.pts.length - 1]; s += `<text x="${X(last[0]) + 4}" y="${Y(last[1]) - 4}" fill="${se.color}" font-size="10" font-family="Inter">${se.label}</text>`; }
    }
    if (opts.hline !== undefined) s += `<line x1="${l}" x2="${W - r}" y1="${Y(opts.hline)}" y2="${Y(opts.hline)}" stroke="#80c799" stroke-dasharray="3 3"/>`;
    s += `<line x1="${X(state.t)}" x2="${X(state.t)}" y1="${t}" y2="${t + ih}" stroke="#ffffff" stroke-opacity=".7"/>`;
    s += '</svg>';
    el.innerHTML = s;
  }
  const nbk = R.schedPlan.length, blk = C.CFG.blockMin;
  const fDep = C.blockDepartures(net, R.odF), aDep = C.departuresByBlock(net, R.target.parties);
  const netF = Array.from({ length: nbk }, (_, k) => fDep.reduce((a, row) => a + row[k], 0));
  const netA = Array.from({ length: nbk }, (_, k) => aDep.reduce((a, row) => a + row[k], 0));
  // network band: sum of per-station conformal half-widths (conservative)
  const netBand = Array.from({ length: nbk }, (_, k) => { let lo = 0, hi = 0; for (let i = 0; i < S; i++) { const [a, b] = C.interval(fDep[i][k], R.conf.qTwoSided); lo += a; hi += b; } return [lo, hi]; });
  function renderCharts() {
    const xm = (k) => T0 + k * blk + blk / 2;
    const ymaxD = Math.ceil(Math.max(...netBand.map(b => b[1]), ...netA) / 100) * 100;
    svgChart($('chartDemand'), [
      { band: netBand.map((b, k) => [xm(k), b[0], b[1]]), fill: 'rgba(79,156,255,0.16)' },
      { pts: netF.map((v, k) => [xm(k), v]), color: '#4f9cff' },
      { pts: netA.map((v, k) => [xm(k), v]), color: '#ffffff', w: 1.2 },
    ], { x0: T0, x1: 24 * 60, ymax: ymaxD, yticks: [0, ymaxD / 2, ymaxD] });
    const stepPts = (arr) => { const p = []; arr.forEach((v, k) => { p.push([T0 + k * blk, v]); p.push([T0 + (k + 1) * blk, v]); }); return p; };
    const ymaxF = Math.ceil(Math.max(...R.schedPlan, ...R.schedHist, R.budgetCars) / 50) * 50;
    svgChart($('chartFleet'), [
      { pts: stepPts(Array.from(R.rc.req)), color: '#4f9cff', dash: '3 3', w: 1 },
      { pts: stepPts(Array(nbk).fill(R.budgetCars)), color: COL.flat, w: 1.2 },
      { pts: stepPts(R.schedHist), color: COL.history, w: 1.4 },
      { pts: stepPts(R.schedPlan), color: COL.plan, w: 1.8 },
    ], { x0: T0, x1: 24 * 60, ymax: ymaxF, yticks: [0, ymaxF / 2, ymaxF] });
    const hourPts = (r) => r.hourP95.slice(0, 18).map((v, h) => [T0 + h * 60 + 30, v]);
    svgChart($('chartWait'), ['flat', 'history', 'plan'].map(p => ({ pts: hourPts(R.runs[p]), color: COL[p], w: p === state.policy ? 2.2 : 1.1 })),
      { x0: T0, x1: 24 * 60, ymax: 50, yticks: [0, 25, 50], hline: 5 });
  }

  // ---------- map ----------
  const cv = $('map'), ctx = cv.getContext('2d');
  const lat0 = 36.112, kx = Math.cos(lat0 * Math.PI / 180);
  // schematic: the long Paradise Rd run to the airport is compressed (piecewise latitude scale)
  const CUT = 36.1265, SQ = 0.8;
  const yLat = (lat) => (lat >= CUT ? lat : CUT - (CUT - lat) * SQ);
  const bounds = { lat: [yLat(36.0835), 36.1445], lon: [-115.1760, -115.1290] };
  let view;
  function fit() {
    const dpr = window.devicePixelRatio || 1, w = cv.clientWidth, h = cv.clientHeight;
    cv.width = w * dpr; cv.height = h * dpr; ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const spanX = (bounds.lon[1] - bounds.lon[0]) * kx, spanY = bounds.lat[1] - bounds.lat[0];
    const s = Math.min((w - 40) / spanX, (h - 70) / spanY);
    view = { s, cx: (bounds.lon[0] + bounds.lon[1]) / 2 - 0.0012, cy: (bounds.lat[0] + bounds.lat[1]) / 2 + 0.0035, w, h };
  }
  const P = (lat, lon) => [view.w / 2 + (lon - view.cx) * kx * view.s, view.h / 2 - (yLat(lat) - view.cy) * view.s];
  // generic structure footprints near stations (drawn, not traced from any map)
  const STRUCT = [[36.1312, -115.1528, 0.0034, 0.0042], [36.1338, -115.1566, 0.0016, 0.0026], [36.1287, -115.1497, 0.0018, 0.0034], [36.1346, -115.1668, 0.0018, 0.0022], [36.1294, -115.1658, 0.0022, 0.0018],
    [36.1351, -115.1512, 0.0018, 0.0016], [36.1376, -115.1597, 0.0014, 0.0016], [36.1429, -115.1567, 0.0014, 0.0016], [36.1410, -115.1535, 0.0010, 0.0012], [36.0870, -115.1362, 0.0016, 0.0040], [36.0856, -115.1502, 0.0016, 0.0034]];
  // label offsets [dx, dy] per station (dx < 0: label to the left)
  const LBL = { 'sahara': [-14, -6], 'turnberry-towers': [14, -8], 'fontainebleau': [-14, -10], 'lvcc-riviera': [14, -16], 'resorts-world': [-14, 0], 'westgate': [16, -14],
    'lvcc-west': [-14, 6], 'lvcc-central-plaza': [16, -4], 'lvcc-central': [16, 12], 'encore': [-14, 4], 'lvcc-south': [16, 28], 'airport-t1': [-14, 18], 'airport-t3': [-14, 0] };
  function drawMap() {
    const t = state.t, k = Math.max(0, Math.min(run().qTrace[0].length - 1, t - T0));
    ctx.fillStyle = '#141414'; ctx.fillRect(0, 0, view.w, view.h);
    // faint street grid
    ctx.strokeStyle = '#1a1a1a'; ctx.lineWidth = 1;
    for (let la = 36.1265; la < 36.15; la += 0.0036) { const a = P(la, bounds.lon[0] - 0.01), b = P(la, bounds.lon[1] + 0.01); ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.stroke(); }
    for (let lo = -115.175; lo < -115.13; lo += 0.0045) { const a = P(36.0835, lo), b = P(36.15, lo); ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.stroke(); }
    for (const [la, lo, dla, dlo] of STRUCT) { const a = P(la + dla / 2, lo - dlo / 2), b = P(la - dla / 2, lo + dlo / 2); ctx.fillStyle = '#23272c'; ctx.strokeStyle = '#363c44'; ctx.fillRect(a[0], a[1], b[0] - a[0], b[1] - a[1]); ctx.strokeRect(a[0], a[1], b[0] - a[0], b[1] - a[1]); }
    // tunnels
    for (const e of net.edges) {
      const A = net.nodes[e.i], B = net.nodes[e.j], a = P(A.lat, A.lon), b = P(B.lat, B.lon);
      const lv = A.group === 'lvcc' && B.group === 'lvcc';
      ctx.strokeStyle = lv ? '#19c37d' : '#4f9cff'; ctx.lineWidth = 3; ctx.shadowColor = lv ? 'rgba(25,195,125,.35)' : 'rgba(79,156,255,.35)'; ctx.shadowBlur = 8;
      ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.stroke(); ctx.shadowBlur = 0;
    }
    // staging moves in flight (plan policy) near this time
    if (state.policy === 'plan') {
      for (const mv of R.runs.plan.moves) {
        if (t < mv.t || t > mv.t + net.travel[mv.from][mv.to]) continue;
        const A = net.stations[mv.from], B = net.stations[mv.to], a = P(A.lat, A.lon), b = P(B.lat, B.lon);
        ctx.setLineDash([4, 4]); ctx.strokeStyle = 'rgba(255,255,255,.75)'; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.stroke(); ctx.setLineDash([]);
      }
    }
    // stations
    net.stations.forEach((s, i) => {
      const [x, y] = P(s.lat, s.lon), q = run().qTrace[i][k], idle = run().idleTrace[i][k];
      if (q > 0) { const rr = 6 + Math.sqrt(q) * 2.2; ctx.fillStyle = 'rgba(227,127,112,0.22)'; ctx.strokeStyle = 'rgba(227,127,112,0.85)'; ctx.lineWidth = 1; ctx.beginPath(); ctx.arc(x, y, rr, 0, 7); ctx.fill(); ctx.stroke(); }
      const col = i === state.sel ? '#ffffff' : s.group === 'lvcc' ? '#19c37d' : '#4f9cff';
      ctx.shadowColor = col; ctx.shadowBlur = 9; ctx.fillStyle = '#050505'; ctx.strokeStyle = col; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(x, y, 8, 0, 7); ctx.fill(); ctx.stroke(); ctx.shadowBlur = 0;
      ctx.fillStyle = col; ctx.beginPath(); ctx.arc(x, y, 3, 0, 7); ctx.fill();
      ctx.font = '500 11px Inter'; ctx.textAlign = 'left';
      const lbl = `${s.name}`, sub = `${q} waiting · ${idle} idle`;
      const L = LBL[s.id] || [14, 0];
      const tx = x + L[0], ty = y + L[1]; ctx.textAlign = L[0] < 0 ? 'right' : 'left';
      ctx.fillStyle = i === state.sel ? '#ffffff' : '#dfdfdf'; ctx.fillText(lbl, tx, ty - 1);
      ctx.font = '400 10px Inter'; ctx.fillStyle = q > 20 ? '#e37f70' : '#939393'; ctx.fillText(sub, tx, ty + 11);
    });
    ctx.textAlign = 'left';
    $('hudTime').textContent = `${hhmm(t)} · ${LABEL[state.policy]}`;
  }

  // ---------- sheet ----------
  function renderSheet() {
    const t = state.t, k = Math.max(0, t - T0), i = state.sel, s = net.stations[i], r = run();
    const q = r.qTrace[i][k], idle = r.idleTrace[i][k], b = Math.min(nbk - 1, Math.floor((t - T0) / blk));
    const [lo, hi] = C.interval(fDep[i][b], R.conf.qTwoSided);
    const st = q > 30 ? ['bad', 'Queue building'] : q > 8 ? ['warn', 'Busy'] : ['ok', 'Flowing'];
    const moves = R.runs.plan.moves.filter(m => m.t <= t && m.t > t - 60).slice(-6).reverse();
    let h = `<div class="vl-detail muted">Station · ${s.group === 'lvcc' ? 'LVCC Loop' : 'Vegas Loop'}</div><h2>${s.name}</h2><span class="chip ${st[0]}">${st[1]}</span>
      <div class="sec"><div class="vl-detail">At ${hhmm(t)} · ${LABEL[state.policy]}</div>
        <div class="vl-datarow"><span class="l">Parties waiting</span><span class="r">${q}</span></div>
        <div class="vl-datarow"><span class="l">Idle cars at station</span><span class="r">${idle}</span></div>
        <div class="vl-datarow"><span class="l">Departures this 15 min</span><span class="r">${aDep[i][b]} (forecast ${fDep[i][b].toFixed(0)}, 90% ${lo.toFixed(0)}–${hi.toFixed(0)})</span></div>
        <div class="vl-datarow"><span class="l">Plan staging target</span><span class="r">${R.plan.blocks[b] ? R.plan.blocks[b][i] : 0} cars</span></div>
        <div class="vl-datarow"><span class="l">Loading bays</span><span class="r">${s.bays}</span></div>
      </div>
      <div class="sec"><div class="vl-detail">Staging moves · last 60 min (forecast plan)</div>
        ${moves.length ? moves.map(m => `<div class="move"><span class="t">${hhmm(m.t)}</span><span>${net.stations[m.from].name} → ${net.stations[m.to].name}</span><span class="n">${m.n} cars</span></div>`).join('') : '<div class="note">No staging moves in the last hour; supply and demand are balanced.</div>'}
      </div>
      <div class="sec"><div class="vl-detail">All stations at ${hhmm(t)}</div><div class="stlist">
        <div class="row hd vl-detail"><span>Station</span><span>Queue</span><span>Idle</span></div>
        ${net.stations.map((x, j) => `<div class="row ${j === i ? 'sel' : ''}" data-st="${j}"><span>${x.name}</span><span class="${r.qTrace[j][k] > 30 ? 'bad' : ''}">${r.qTrace[j][k]}</span><span>${r.idleTrace[j][k]}</span></div>`).join('')}
      </div></div>
      <div class="note">Plan = cars on duty shaped to the 80% upper forecast of car demand (loaded + repositioning minutes), plus 15-minute staging moves solved as a min-cost flow. Same driver-hours as the other two schedules.</div>`;
    $('sheet').innerHTML = h;
  }

  function render() { $('clock').textContent = hhmm(state.t); $('slider').value = state.t; renderKpis(); renderCharts(); drawMap(); renderSheet(); }

  // ---------- interactions ----------
  $('policy').addEventListener('click', (e) => { const b = e.target.closest('[data-p]'); if (!b) return; state.policy = b.dataset.p; document.querySelectorAll('.vl-segment').forEach(x => x.classList.toggle('is-active', x === b)); render(); });
  $('slider').addEventListener('input', (e) => { state.t = +e.target.value; render(); });
  $('sheet').addEventListener('click', (e) => { const r = e.target.closest('[data-st]'); if (r) { state.sel = +r.dataset.st; render(); } });
  cv.addEventListener('click', (e) => {
    const rc = cv.getBoundingClientRect(), x = e.clientX - rc.left, y = e.clientY - rc.top;
    let best = -1, bd = 16; net.stations.forEach((s, i) => { const p = P(s.lat, s.lon), d = Math.hypot(p[0] - x, p[1] - y); if (d < bd) { bd = d; best = i; } });
    if (best >= 0) { state.sel = best; render(); }
  });
  let timer = null;
  $('play').addEventListener('click', () => { state.playing = !state.playing; $('play').textContent = state.playing ? '❚❚' : '▶'; if (state.playing) timer = setInterval(() => { state.t = state.t >= 1439 ? 360 : state.t + 2; render(); }, 90); else clearInterval(timer); });
  window.addEventListener('resize', () => { fit(); render(); });
  document.querySelectorAll('.vl-segment').forEach(x => x.classList.toggle('is-active', x.dataset.p === state.policy));
  window.__SURGE = R;
  const go = () => { fit(); render(); };
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(go); else go();
})();
