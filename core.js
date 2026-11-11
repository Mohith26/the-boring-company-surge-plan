/*
 * Surge Plan core: forecast-driven vehicle staging for a point-to-point tunnel network (Vegas Loop style).
 *
 *  1. Demand: seeded synthetic history of convention days (OD trips per minute) driven by show schedule,
 *     attendance and day-of-show; a profile forecaster per (origin, destination, 5-min bin) scaled by the
 *     expected attendance, with split-conformal intervals per station and 15-min block.
 *  2. Plan: every 15 min, the target idle-car stock at each station = upper-quantile departures over the next
 *     block minus expected inbound cars; deficits are filled from surpluses by a min-cost flow
 *     (successive shortest paths on empty-car travel minutes).
 *  3. Evaluate: minute-step discrete-event simulation (parties queue FIFO, loading bays, tunnel travel times,
 *     reactive nearest-idle-car pull for both policies) -> waits, queues, empty minutes, and the smallest
 *     fleet that keeps p95 wait under a target.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.SurgeCore = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ---------- RNG ----------
  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function makeRng(seed) {
    const u = mulberry32(seed >>> 0);
    let spare = null;
    const r = { u };
    r.n = () => {
      if (spare !== null) { const s = spare; spare = null; return s; }
      let a, b, s; do { a = 2 * u() - 1; b = 2 * u() - 1; s = a * a + b * b; } while (s >= 1 || s === 0);
      const m = Math.sqrt(-2 * Math.log(s) / s); spare = b * m; return a * m;
    };
    r.poisson = (lam) => {
      if (lam <= 0) return 0;
      if (lam > 40) return Math.max(0, Math.round(lam + Math.sqrt(lam) * r.n()));
      const L = Math.exp(-lam); let k = 0, p = 1; do { k++; p *= u(); } while (p > L); return k - 1;
    };
    return r;
  }

  // ---------- network (approximate public station locations; simplified tunnel graph) ----------
  const STATIONS = [
    // id, name, lat, lon, loading bays, group
    ['lvcc-west', 'LVCC West', 36.1336, -115.1563, 20, 'lvcc'],
    ['lvcc-central', 'LVCC Central', 36.1312, -115.1530, 16, 'lvcc'],
    ['lvcc-central-plaza', 'LVCC Central Plaza', 36.1320, -115.1512, 8, 'lvcc'],
    ['lvcc-south', 'LVCC South', 36.1287, -115.1500, 20, 'lvcc'],
    ['lvcc-riviera', 'LVCC Riviera', 36.1366, -115.1580, 10, 'lvcc'],
    ['resorts-world', 'Resorts World', 36.1344, -115.1665, 12, 'loop'],
    ['westgate', 'Westgate', 36.1349, -115.1515, 8, 'loop'],
    ['encore', 'Encore', 36.1292, -115.1656, 10, 'loop'],
    ['fontainebleau', 'Fontainebleau', 36.1374, -115.1594, 8, 'loop'],
    ['sahara', 'Sahara', 36.1427, -115.1570, 8, 'loop'],
    ['turnberry-towers', 'Turnberry Towers', 36.1409, -115.1538, 6, 'loop'],
    ['airport-t1', 'Airport T1', 36.0870, -115.1365, 10, 'loop'],
    ['airport-t3', 'Airport T3', 36.0856, -115.1499, 10, 'loop'],
  ];
  const JUNCTIONS = [['j-airport', 36.1180, -115.1530], ['j-airport-branch', 36.0905, -115.1440]];
  const EDGES = [
    ['lvcc-west', 'lvcc-central'], ['lvcc-central', 'lvcc-south'], ['lvcc-central', 'lvcc-central-plaza'],
    ['lvcc-west', 'lvcc-riviera'], ['lvcc-riviera', 'resorts-world'], ['lvcc-riviera', 'encore'],
    ['lvcc-riviera', 'fontainebleau'], ['fontainebleau', 'sahara'], ['sahara', 'turnberry-towers'],
    ['turnberry-towers', 'westgate'], ['westgate', 'lvcc-central-plaza'], ['lvcc-south', 'j-airport'],
    ['j-airport', 'j-airport-branch'], ['j-airport-branch', 'airport-t1'], ['j-airport-branch', 'airport-t3'],
  ];

  const CFG = {
    startMin: 6 * 60, endMin: 24 * 60,   // 06:00-24:00
    speed: 13.5,                          // m/s average tunnel speed incl. accel/turns
    detour: 1.15,                         // tunnel length / straight line
    loadMin: 1.0, unloadMin: 0.7,
    partyMean: 1.7,
    blockMin: 15,
    stageQuantile: 0.8,                   // staging uses the 80% upper forecast
    alpha: 0.1,                           // 90% intervals
    waitTarget: 5,                        // p95 wait target, minutes
    patience: 45,                         // parties give up (walk / taxi) after this many minutes
    historyDays: 48, calibDays: 12, testDays: 10,
  };

  function hav(a, b) {
    const R = 6371000, toR = Math.PI / 180;
    const dLat = (b[0] - a[0]) * toR, dLon = (b[1] - a[1]) * toR;
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(a[0] * toR) * Math.cos(b[0] * toR) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
  }

  function buildNetwork() {
    const nodes = STATIONS.map(([id, name, lat, lon, bays, group]) => ({ id, name, lat, lon, bays, group, station: true }))
      .concat(JUNCTIONS.map(([id, lat, lon]) => ({ id, name: id, lat, lon, station: false })));
    const idx = new Map(nodes.map((n, k) => [n.id, k]));
    const N = nodes.length;
    const D = Array.from({ length: N }, (_, i) => Array.from({ length: N }, (_, j) => (i === j ? 0 : Infinity)));
    const edges = EDGES.map(([a, b]) => {
      const i = idx.get(a), j = idx.get(b);
      const len = hav([nodes[i].lat, nodes[i].lon], [nodes[j].lat, nodes[j].lon]) * CFG.detour;
      D[i][j] = D[j][i] = len; return { i, j, len };
    });
    for (let k = 0; k < N; k++) for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) if (D[i][k] + D[k][j] < D[i][j]) D[i][j] = D[i][k] + D[k][j];
    const S = STATIONS.length;
    const travel = Array.from({ length: S }, (_, i) => Array.from({ length: S }, (_, j) => (i === j ? 0 : Math.max(1, Math.round(D[i][j] / CFG.speed / 60 + 0.6)))));
    const meters = Array.from({ length: S }, (_, i) => Array.from({ length: S }, (_, j) => D[i][j]));
    return { nodes, edges, S, travel, meters, stations: nodes.slice(0, S) };
  }

  // ---------- demand ----------
  // station roles: hotel weights for convention traffic and nightlife
  const HOTEL_W = { 'resorts-world': 1.25, 'westgate': 0.9, 'encore': 1.1, 'fontainebleau': 0.85, 'sahara': 0.6, 'turnberry-towers': 0.25, 'airport-t1': 0.18, 'airport-t3': 0.22 };
  const HALL_W = { 'lvcc-west': 1.25, 'lvcc-central': 1.0, 'lvcc-central-plaza': 0.35, 'lvcc-south': 1.0, 'lvcc-riviera': 0.5 };
  const gauss = (t, mu, sd) => Math.exp(-0.5 * ((t - mu) / sd) ** 2);

  /** expected trips per minute for OD (i,j) at minute-of-day m, for a show with given params */
  function intensityFactory(net, show) {
    const S = net.S, ids = net.stations.map(s => s.id);
    const hall = ids.map(id => HALL_W[id] || 0), hotel = ids.map(id => HOTEL_W[id] || 0);
    const sumHall = hall.reduce((a, b) => a + b, 0), sumHotel = hotel.reduce((a, b) => a + b, 0);
    const scale = show.riders; // expected riders for the day
    // component weights (fractions of daily riders)
    const W = { inbound: 0.2, outbound: 0.22, intra: 0.42, night: 0.16 };
    const open = show.openMin, close = show.closeMin;
    // normalised time profiles (per minute)
    const prof = (fn) => { let s = 0; const a = []; for (let m = CFG.startMin; m < CFG.endMin; m++) { const v = fn(m); a.push(v); s += v; } return a.map(v => v / s); };
    const pIn = prof(m => 0.55 * gauss(m, open - 15, 70) + 0.45 * gauss(m, open + 150, 110));
    const pOut = prof(m => 0.25 * gauss(m, close - 120, 90) + 0.6 * gauss(m, close + 20, 40) * (m >= close - 15 ? 1 : 0.4) + 0.15 * gauss(m, close + 90, 50));
    const pIntra = prof(m => (m > open - 30 && m < close + 15) ? 1 + 0.4 * gauss(m, open + 210, 80) : 0.02);
    const pNight = prof(m => gauss(m, 20.5 * 60, 85) + 0.4 * gauss(m, 23 * 60, 40));
    return function (i, j, m) {
      if (i === j) return 0;
      const k = m - CFG.startMin; if (k < 0 || k >= pIn.length) return 0;
      let v = 0;
      if (hotel[i] && hall[j]) v += W.inbound * scale * pIn[k] * (hotel[i] / sumHotel) * (hall[j] / sumHall);
      if (hall[i] && hotel[j]) v += W.outbound * scale * pOut[k] * (hall[i] / sumHall) * (hotel[j] / sumHotel);
      if (hall[i] && hall[j]) v += W.intra * scale * pIntra[k] * (hall[i] * hall[j]) / (sumHall * sumHall - hall.reduce((a, b) => a + b * b, 0));
      if (hotel[i] && hotel[j]) v += W.night * scale * pNight[k] * (hotel[i] * hotel[j]) / (sumHotel * sumHotel - hotel.reduce((a, b) => a + b * b, 0));
      return v / CFG.partyMean; // parties per minute
    };
  }

  function makeShow(rng, k) {
    const dayIdx = k % 4; // day of a 4-day show
    const closeMin = dayIdx === 3 ? 16 * 60 : 17 * 60 + (rng.u() < 0.25 ? 30 : 0);
    const registrations = 24000 + 12000 * rng.u();            // forecast input known in advance
    const realised = registrations * Math.exp(0.10 * rng.n()) * (dayIdx === 3 ? 0.78 : 1) * (dayIdx === 0 ? 1.06 : 1);
    return { dayIdx, openMin: 9 * 60, closeMin, registrations, riders: realised };
  }

  /** sample parties for a day: array of {t, o, d, size} */
  function sampleDay(net, show, rng) {
    const lam = intensityFactory(net, show);
    const out = [];
    for (let m = CFG.startMin; m < CFG.endMin; m++) for (let i = 0; i < net.S; i++) for (let j = 0; j < net.S; j++) {
      const l = lam(i, j, m); if (!l) continue;
      const n = rng.poisson(l);
      for (let q = 0; q < n; q++) out.push({ t: m + rng.u(), o: i, d: j, size: 1 + (rng.u() < 0.45 ? 1 : 0) + (rng.u() < 0.15 ? 1 : 0) + (rng.u() < 0.08 ? 1 : 0) });
    }
    out.sort((a, b) => a.t - b.t);
    return out;
  }

  // ---------- forecasting ----------
  const NB = () => Math.ceil((CFG.endMin - CFG.startMin) / 5);
  function countsOD(net, parties) { // [o][d][5-min bin]
    const S = net.S, nb = NB();
    const c = Array.from({ length: S }, () => Array.from({ length: S }, () => new Float64Array(nb)));
    for (const p of parties) c[p.o][p.d][Math.floor((p.t - CFG.startMin) / 5)]++;
    return c;
  }
  function departuresByBlock(net, parties) { // [station][15-min block]
    const nbk = Math.ceil((CFG.endMin - CFG.startMin) / CFG.blockMin);
    const c = Array.from({ length: net.S }, () => new Float64Array(nbk));
    for (const p of parties) c[p.o][Math.floor((p.t - CFG.startMin) / CFG.blockMin)]++;
    return c;
  }

  /**
   * Profile forecaster: for each day-type (regular vs last day) and close time, average the per-rider OD counts
   * of training days, aligned to the show close time, then scale by registrations * learned rider rate.
   */
  function fitForecaster(net, train) {
    const S = net.S, nb = NB();
    // rider rate per registration by day type (least squares through origin)
    const rate = {};
    for (const key of ['first', 'mid', 'last']) {
      const ds = train.filter(d => dayKey(d.show) === key);
      const num = ds.reduce((s, d) => s + d.parties.length * d.show.registrations, 0), den = ds.reduce((s, d) => s + d.show.registrations ** 2, 0);
      rate[key] = den ? num / den : 0.6;
    }
    // shape: average normalised counts, shifted so close time aligns at a reference (17:00)
    const shape = {};
    for (const key of ['regular', 'last']) {
      const ds = train.filter(d => (key === 'last') === (d.show.dayIdx === 3));
      const acc = Array.from({ length: S }, () => Array.from({ length: S }, () => new Float64Array(nb)));
      for (const d of ds) {
        const c = countsOD(net, d.parties), tot = d.parties.length, shift = Math.round((d.show.closeMin - 17 * 60) / 5);
        for (let i = 0; i < S; i++) for (let j = 0; j < S; j++) for (let b = 0; b < nb; b++) {
          // align: evening (outbound) part follows the close, morning part does not
          const src = b + (b >= 96 ? shift : 0); // after 14:00 align to close
          if (src >= 0 && src < nb) acc[i][j][b] += c[i][j][src] / tot;
        }
      }
      for (let i = 0; i < S; i++) for (let j = 0; j < S; j++) for (let b = 0; b < nb; b++) acc[i][j][b] /= Math.max(1, ds.length);
      // light temporal smoothing
      for (let i = 0; i < S; i++) for (let j = 0; j < S; j++) {
        const a = acc[i][j], sm = new Float64Array(nb);
        for (let b = 0; b < nb; b++) sm[b] = (0.25 * (a[b - 1] || a[b]) + 0.5 * a[b] + 0.25 * (a[b + 1] || a[b]));
        acc[i][j] = sm;
      }
      shape[key] = acc;
    }
    return { rate, shape };
  }
  const dayKey = (show) => (show.dayIdx === 0 ? 'first' : show.dayIdx === 3 ? 'last' : 'mid');

  function forecastOD(net, fc, show) {
    const S = net.S, nb = NB();
    const sh = fc.shape[show.dayIdx === 3 ? 'last' : 'regular'];
    const total = fc.rate[dayKey(show)] * show.registrations, shift = Math.round((show.closeMin - 17 * 60) / 5);
    const out = Array.from({ length: S }, () => Array.from({ length: S }, () => new Float64Array(nb)));
    for (let i = 0; i < S; i++) for (let j = 0; j < S; j++) for (let b = 0; b < nb; b++) {
      const src = b - (b >= 96 ? shift : 0);
      out[i][j][b] = src >= 0 && src < nb ? total * sh[i][j][src] : 0;
    }
    return out;
  }
  function blockDepartures(net, od) { // forecast departures per station per 15-min block
    const nbk = Math.ceil((CFG.endMin - CFG.startMin) / CFG.blockMin), per = CFG.blockMin / 5;
    const c = Array.from({ length: net.S }, () => new Float64Array(nbk));
    for (let i = 0; i < net.S; i++) for (let j = 0; j < net.S; j++) for (let b = 0; b < od[i][j].length; b++) c[i][Math.floor(b / per)] += od[i][j][b];
    return c;
  }

  // split-conformal: normalised residual score per (station, block), quantile over calibration days
  function conformal(net, fc, calib, alpha) {
    const scores = [];
    for (const d of calib) {
      const f = blockDepartures(net, forecastOD(net, fc, d.show)), y = departuresByBlock(net, d.parties);
      for (let i = 0; i < net.S; i++) for (let b = 0; b < f[i].length; b++) {
        if (f[i][b] < 0.5 && y[i][b] === 0) continue;
        scores.push((y[i][b] - f[i][b]) / Math.sqrt(f[i][b] + 4));
      }
    }
    const abs = scores.map(Math.abs).sort((a, b) => a - b), up = scores.slice().sort((a, b) => a - b), n = abs.length;
    const q = (arr, lvl) => arr[Math.min(n - 1, Math.ceil((n + 1) * lvl) - 1)];
    return { qTwoSided: q(abs, 1 - alpha), qUpper: (lvl) => q(up, lvl), n };
  }
  const interval = (f, q) => [Math.max(0, f - q * Math.sqrt(f + 4)), f + q * Math.sqrt(f + 4)];

  // ---------- min-cost flow (successive shortest paths, Bellman-Ford) ----------
  function minCostTransport(supply, demand, cost) {
    // supply[i] >= 0 surplus cars, demand[j] >= 0 deficits; returns list of {from,to,n}
    const S = supply.length, src = 2 * S, snk = 2 * S + 1, N = 2 * S + 2;
    const g = Array.from({ length: N }, () => []);
    const add = (u, v, cap, c) => { g[u].push({ v, cap, c, r: g[v].length }); g[v].push({ v: u, cap: 0, c: -c, r: g[u].length - 1 }); };
    for (let i = 0; i < S; i++) if (supply[i] > 0) add(src, i, supply[i], 0);
    for (let j = 0; j < S; j++) if (demand[j] > 0) add(S + j, snk, demand[j], 0);
    for (let i = 0; i < S; i++) if (supply[i] > 0) for (let j = 0; j < S; j++) if (demand[j] > 0 && i !== j) add(i, S + j, Infinity, cost[i][j]);
    const moves = [];
    for (;;) {
      const dist = new Array(N).fill(Infinity), pv = new Array(N).fill(-1), pe = new Array(N).fill(-1);
      dist[src] = 0;
      for (let it = 0; it < N; it++) { let ch = false; for (let u = 0; u < N; u++) if (dist[u] < Infinity) g[u].forEach((e, k) => { if (e.cap > 0 && dist[u] + e.c < dist[e.v]) { dist[e.v] = dist[u] + e.c; pv[e.v] = u; pe[e.v] = k; ch = true; } }); if (!ch) break; }
      if (dist[snk] === Infinity) break;
      let f = Infinity; for (let v = snk; v !== src; v = pv[v]) f = Math.min(f, g[pv[v]][pe[v]].cap);
      for (let v = snk; v !== src; v = pv[v]) { const e = g[pv[v]][pe[v]]; e.cap -= f; g[v][e.r].cap += f; }
    }
    // read flows from reverse edges
    for (let j = 0; j < S; j++) for (const e of g[S + j]) if (e.v < S && e.cap > 0) moves.push({ from: e.v, to: j, n: e.cap });
    return moves;
  }

  // ---------- staging plan ----------
  function makePlan(net, odForecast, fleet, qUpperZ) {
    const S = net.S, nbk = Math.ceil((CFG.endMin - CFG.startMin) / CFG.blockMin), per = CFG.blockMin / 5;
    const dep = blockDepartures(net, odForecast);
    // inbound cars per station per block (arrive travel minutes after departure)
    const inb = Array.from({ length: S }, () => new Float64Array(nbk + 4));
    for (let i = 0; i < S; i++) for (let j = 0; j < S; j++) for (let b = 0; b < odForecast[i][j].length; b++) {
      const v = odForecast[i][j][b]; if (!v) continue;
      const t = (b * 5 + 2.5 + net.travel[i][j] + CFG.unloadMin) / CFG.blockMin;
      inb[j][Math.floor(t)] += v;
    }
    const blocks = [];
    for (let k = 0; k < nbk; k++) {
      // target idle stock for the coming block: upper-quantile departures minus expected inbound cars,
      // scaled to what a car can do in a block at this station (round trip share)
      const target = new Float64Array(S);
      for (let i = 0; i < S; i++) {
        const up = dep[i][k] + qUpperZ * Math.sqrt(dep[i][k] + 4) * (dep[i][k] > 0.5 ? 1 : 0);
        target[i] = Math.max(0, Math.ceil(up - 0.85 * inb[i][k] - 0.5 * inb[i][k + 1]));
      }
      const tsum = target.reduce((a, b) => a + b, 0);
      const scale = tsum > fleet * 0.9 ? (fleet * 0.9) / tsum : 1; // cannot stage more than the fleet
      blocks.push(Array.from(target, v => Math.floor(v * scale)));
    }
    return { blocks, dep, inb };
  }

  // ---------- fleet requirement curve (fluid model) and driver schedule ----------
  /**
   * Cars needed per 15-min block from an OD forecast: loaded car-minutes (load + travel + unload) plus the
   * empty repositioning car-minutes implied by the block's inbound/outbound imbalance (min-cost transport),
   * divided by block length, plus the staging buffer.
   */
  function requirementCurve(net, od, zUp) {
    const S = net.S, nbk = Math.ceil((CFG.endMin - CFG.startMin) / CFG.blockMin), per = CFG.blockMin / 5;
    const req = new Float64Array(nbk), loaded = new Float64Array(nbk), empty = new Float64Array(nbk);
    for (let k = 0; k < nbk; k++) {
      const out = new Float64Array(S), inn = new Float64Array(S);
      let load = 0;
      for (let i = 0; i < S; i++) for (let j = 0; j < S; j++) {
        let v = 0; for (let b = k * per; b < (k + 1) * per && b < od[i][j].length; b++) v += od[i][j][b];
        if (!v) continue;
        // upper-quantile inflation at the OD level, proportional to the station block quantile
        v = v + zUp * Math.sqrt(v + 1) * 0.5;
        out[i] += v; inn[j] += v; load += v * (net.travel[i][j] + CFG.loadMin + CFG.unloadMin);
      }
      const sup = [], dem = [];
      for (let i = 0; i < S; i++) { const d = inn[i] - out[i]; sup.push(d > 0 ? Math.round(d) : 0); dem.push(d < 0 ? Math.round(-d) : 0); }
      const mv = minCostTransport(sup, dem, net.travel);
      const emp = mv.reduce((a, x) => a + x.n * net.travel[x.from][x.to], 0);
      loaded[k] = load / CFG.blockMin; empty[k] = emp / CFG.blockMin;
      req[k] = loaded[k] + empty[k];
    }
    return { req, loaded, empty };
  }

  /** shape a car-minute budget to the requirement curve (with a floor), same total as a flat schedule */
  function scheduleFromCurve(req, budgetCarMin, floor) {
    const nbk = req.length; floor = floor || 12;
    const f = (c) => Array.from(req, r => Math.max(floor, Math.round(c * r)));
    let lo = 0, hi = 50;
    for (let it = 0; it < 60; it++) { const mid = (lo + hi) / 2; const tot = f(mid).reduce((a, b) => a + b, 0) * CFG.blockMin; if (tot > budgetCarMin) hi = mid; else lo = mid; }
    return f(lo);
  }

  /** baseline schedule: shape the same budget to the historical average departures per block (no travel-time
   *  or repositioning model, no day-specific forecast) - "staff to last year's ridership curve" */
  function historyCurve(net, train) {
    const nbk = Math.ceil((CFG.endMin - CFG.startMin) / CFG.blockMin);
    const c = new Float64Array(nbk);
    for (const d of train) for (const p of d.parties) c[Math.floor((p.t - CFG.startMin) / CFG.blockMin)] += 1 / train.length;
    return c;
  }

  // ---------- discrete-event simulation (1-minute steps, sub-minute arrival times) ----------
  /**
   * policy: 'reactive' (pull nearest idle car when a queue has no car) or 'planned' (reactive + 15-min
   * proactive staging toward plan targets via min-cost flow).
   */
  function simulate(net, parties, fleet, policy, plan, opts) {
    opts = opts || {};
    const S = net.S, T0 = CFG.startMin, T1 = CFG.endMin + 60;
    // fleet may be a number (flat) or an array of cars on duty per 15-min block (driver schedule)
    const sched = Array.isArray(fleet) ? fleet : null;
    const fleet0 = sched ? sched[0] : fleet;
    // initial placement: proportional to bays (same rule for both policies)
    const idle = new Array(S).fill(0);
    const totalBays = net.stations.reduce((a, s) => a + s.bays, 0);
    let placed = 0; net.stations.forEach((s, i) => { idle[i] = Math.floor(fleet0 * s.bays / totalBays); placed += idle[i]; });
    for (let i = 0; placed < fleet0; i = (i + 1) % S) { idle[i]++; placed++; }
    let onDuty = fleet0, toRelease = 0, carMin = 0;
    const queue = Array.from({ length: S }, () => []);
    const inTransit = []; // {arrive, to}
    const loading = new Array(S).fill(0); // bay occupancy tokens: list of release times
    const bayFree = Array.from({ length: S }, () => []);
    let pi = 0;
    const waits = [], waitsByHour = Array.from({ length: 19 }, () => []);
    let emptyMin = 0, paxMin = 0, served = 0, abandoned = 0;
    const qTrace = Array.from({ length: S }, () => []), idleTrace = Array.from({ length: S }, () => []);
    const moves = [];
    for (let m = T0; m < T1; m++) {
      // arrivals of cars
      for (let k = inTransit.length - 1; k >= 0; k--) if (inTransit[k].arrive <= m) { idle[inTransit[k].to]++; inTransit.splice(k, 1); }
      // new parties
      while (pi < parties.length && parties[pi].t < m + 1) { queue[parties[pi].o].push(parties[pi]); pi++; }
      // driver shift changes at block boundaries: new cars start where the plan wants them (or where queues are)
      if (sched && (m - T0) % CFG.blockMin === 0) {
        const k = Math.min(sched.length - 1, Math.floor((m - T0) / CFG.blockMin));
        const want = m >= CFG.endMin ? sched[sched.length - 1] : sched[k];
        if (want > onDuty) {
          let add = want - onDuty; onDuty = want; toRelease = 0;
          const tgt = plan && plan.blocks[k] ? plan.blocks[k] : null;
          while (add > 0) {
            let best = 0, bv = -Infinity;
            for (let i = 0; i < S; i++) { const v = (tgt ? tgt[i] : 0) + queue[i].length - idle[i] + net.stations[i].bays * 0.01; if (v > bv) { bv = v; best = i; } }
            idle[best]++; add--;
          }
        } else if (want < onDuty) { toRelease += onDuty - want; onDuty = want; }
      }
      if (toRelease > 0) { // release idle cars (largest surplus first)
        for (let i = 0; i < S && toRelease > 0; i++) { const spare = idle[i] - queue[i].length; if (spare > 0) { const n = Math.min(spare, toRelease); idle[i] -= n; toRelease -= n; } }
      }
      if (m < CFG.endMin) carMin += onDuty + toRelease;
      // proactive staging every block
      if (policy === 'planned' && (m - T0) % CFG.blockMin === 0 && plan) {
        const k = Math.floor((m - T0) / CFG.blockMin);
        if (k < plan.blocks.length) {
          const tgt = plan.blocks[k];
          const supply = new Array(S).fill(0), demand = new Array(S).fill(0);
          for (let i = 0; i < S; i++) { const need = tgt[i] + queue[i].length; const d = idle[i] - need; if (d > 0) supply[i] = Math.floor(d * 0.8); else demand[i] = -d; }
          const mv = minCostTransport(supply, demand, net.travel);
          for (const x of mv) { idle[x.from] -= x.n; for (let q = 0; q < x.n; q++) inTransit.push({ arrive: m + net.travel[x.from][x.to], to: x.to }); emptyMin += x.n * net.travel[x.from][x.to]; moves.push({ t: m, from: x.from, to: x.to, n: x.n }); }
        }
      }
      // abandonment: parties that waited longer than their patience leave the queue
      for (let i = 0; i < S; i++) { while (queue[i].length && m - queue[i][0].t > CFG.patience) { queue[i].shift(); abandoned++; } }
      // board: each station can start (bays) loads per loadMin
      for (let i = 0; i < S; i++) {
        bayFree[i] = bayFree[i].filter(t => t > m);
        while (queue[i].length && idle[i] > 0 && bayFree[i].length < net.stations[i].bays) {
          const p = queue[i].shift(); idle[i]--; bayFree[i].push(m + CFG.loadMin);
          const w = Math.max(0, m - p.t); waits.push(w); const h = Math.floor(p.t / 60) - 6; if (h >= 0 && h < 19) waitsByHour[h].push(w);
          const tt = net.travel[i][p.d]; inTransit.push({ arrive: m + CFG.loadMin + tt + CFG.unloadMin, to: p.d }); paxMin += tt; served++;
        }
      }
      // reactive pull: stations with waiting parties and no idle car call the nearest station with spare idle cars
      for (let i = 0; i < S; i++) {
        const enRoute = inTransit.filter(c => c.to === i && c.arrive - m <= 3).length;
        let need = queue[i].length - idle[i] - enRoute; if (need <= 0) continue;
        const order = [...Array(S).keys()].filter(j => j !== i).sort((a, b) => net.travel[a][i] - net.travel[b][i]);
        for (const j of order) {
          if (need <= 0) break;
          const spare = idle[j] - queue[j].length; if (spare <= 0) continue;
          const n = Math.min(spare, need); idle[j] -= n; need -= n;
          for (let q = 0; q < n; q++) inTransit.push({ arrive: m + net.travel[j][i], to: i });
          emptyMin += n * net.travel[j][i];
        }
      }
      if (opts.trace) for (let i = 0; i < S; i++) { qTrace[i].push(queue[i].length); idleTrace[i].push(idle[i]); }
    }
    for (let k = 0; k < abandoned; k++) waits.push(CFG.patience); // abandoned parties count as (at least) patience-long waits
    const sorted = waits.slice().sort((a, b) => a - b), q = (lvl) => sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(lvl * sorted.length))] : 0;
    const hourP95 = waitsByHour.map(a => { if (!a.length) return 0; const s = a.slice().sort((x, y) => x - y); return s[Math.floor(0.95 * s.length)] || s[s.length - 1]; });
    const unserved = parties.length - served - abandoned;
    return { abandoned, carMin, p50: q(0.5), p95: q(0.95), p99: q(0.99), max: sorted[sorted.length - 1] || 0, mean: waits.reduce((a, b) => a + b, 0) / Math.max(1, waits.length), served, unserved, emptyMin, paxMin, hourP95, qTrace, idleTrace, moves };
  }

  // smallest fleet keeping p95 <= target on each of the given demand samples
  function minFleet(net, samples, policy, planFor, lo, hi) {
    const ok = (F) => samples.every(p => simulate(net, p, F, policy, planFor ? planFor(F) : null).p95 <= CFG.waitTarget);
    if (!ok(hi)) return null;
    while (hi - lo > 2) { const mid = Math.floor((lo + hi) / 2); if (ok(mid)) hi = mid; else lo = mid; }
    return hi;
  }

  // ---------- full pipeline ----------
  function runAll(opts) {
    opts = opts || {};
    const net = buildNetwork();
    const rng = makeRng(opts.seed || 2026);
    const total = CFG.historyDays + CFG.calibDays + CFG.testDays;
    const days = [];
    for (let k = 0; k < total; k++) { const show = makeShow(rng, k); days.push({ show, parties: sampleDay(net, show, rng) }); }
    const train = days.slice(0, CFG.historyDays), calib = days.slice(CFG.historyDays, CFG.historyDays + CFG.calibDays), test = days.slice(CFG.historyDays + CFG.calibDays);
    const fc = fitForecaster(net, train);
    const conf = conformal(net, fc, calib, CFG.alpha);
    // coverage of the 90% interval on held-out test days (station x 15-min blocks with traffic)
    let cov = 0, ncov = 0;
    for (const d of test) {
      const f = blockDepartures(net, forecastOD(net, fc, d.show)), y = departuresByBlock(net, d.parties);
      for (let i = 0; i < net.S; i++) for (let b = 0; b < f[i].length; b++) { if (f[i][b] < 0.5 && y[i][b] === 0) continue; const [lo, hi] = interval(f[i][b], conf.qTwoSided); ncov++; if (y[i][b] >= lo && y[i][b] <= hi) cov++; }
    }
    // target day: the busiest held-out day (a SEMA/CES-scale convention day)
    const target = test.reduce((a, b) => (b.parties.length > a.parties.length ? b : a));
    const odF = forecastOD(net, fc, target.show);
    const zUp = conf.qUpper(CFG.stageQuantile);
    const rc = requirementCurve(net, odF, zUp), hc = historyCurve(net, train);
    const hours = (CFG.endMin - CFG.startMin) / 60;
    const budgetCars = opts.budgetCars || 120; // car-equivalents over 06:00-24:00 (x18 h = driver-hours)
    const budget = budgetCars * hours * 60;
    const schedPlan = scheduleFromCurve(rc.req, budget), schedHist = scheduleFromCurve(hc, budget);
    const plan = makePlan(net, odF, Math.max(...schedPlan), zUp);
    const runs = {
      flat: simulate(net, target.parties, budgetCars, 'reactive', null, { trace: true }),
      history: simulate(net, target.parties, schedHist, 'reactive', null, { trace: true }),
      planNoStage: simulate(net, target.parties, schedPlan, 'reactive', null),
      plan: simulate(net, target.parties, schedPlan, 'planned', plan, { trace: true }),
    };
    // smallest budget (car-equivalents) that holds p95 <= target, per policy
    const search = (mk) => { let lo = 60, hi = 260; if (mk(hi).p95 > CFG.waitTarget) return null; while (hi - lo > 1) { const mid = Math.floor((lo + hi) / 2); if (mk(mid).p95 <= CFG.waitTarget) hi = mid; else lo = mid; } return hi; };
    let minBudget = null;
    if (opts.fleetSearch !== false) {
      minBudget = {
        flat: search(B => simulate(net, target.parties, B, 'reactive', null)),
        history: search(B => simulate(net, target.parties, scheduleFromCurve(hc, B * hours * 60), 'reactive', null)),
        plan: search(B => { const sp = scheduleFromCurve(rc.req, B * hours * 60); return simulate(net, target.parties, sp, 'planned', makePlan(net, odF, Math.max(...sp), zUp)); }),
      };
    }
    return { CFG, net, days, train, calib, test, fc, conf, coverage: ncov ? cov / ncov : null, nCoverage: ncov, target, odF, zUp, rc, hc, budgetCars, schedPlan, schedHist, plan, runs, minBudget };
  }

  return { historyCurve, requirementCurve, scheduleFromCurve, CFG, makeRng, buildNetwork, intensityFactory, makeShow, sampleDay, fitForecaster, forecastOD, blockDepartures, departuresByBlock, conformal, interval, minCostTransport, makePlan, simulate, minFleet, runAll, hav, STATIONS };
});
