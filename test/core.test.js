const test = require('node:test');
const assert = require('node:assert');
const C = require('../core.js');
const net = C.buildNetwork();
const id = (s) => net.stations.findIndex(x => x.id === s);

test('network: travel times are symmetric, positive and respect the triangle inequality on metres', () => {
  for (let i = 0; i < net.S; i++) for (let j = 0; j < net.S; j++) {
    assert.strictEqual(net.travel[i][j], net.travel[j][i]);
    if (i !== j) assert.ok(net.travel[i][j] >= 1);
    for (let k = 0; k < net.S; k++) assert.ok(net.meters[i][j] <= net.meters[i][k] + net.meters[k][j] + 1e-6);
  }
  assert.ok(net.travel[id('lvcc-west')][id('airport-t1')] > net.travel[id('lvcc-west')][id('resorts-world')]);
});

test('demand sampling is deterministic and matches the expected rider volume', () => {
  const rng1 = C.makeRng(9), rng2 = C.makeRng(9);
  const show = { dayIdx: 1, openMin: 540, closeMin: 1020, registrations: 30000, riders: 30000 };
  const a = C.sampleDay(net, show, rng1), b = C.sampleDay(net, show, rng2);
  assert.strictEqual(a.length, b.length);
  assert.deepStrictEqual(a[500], b[500]);
  const riders = a.reduce((s, p) => s + p.size, 0);
  assert.ok(Math.abs(riders - 30000) / 30000 < 0.06, `riders ${riders}`);
});

test('min-cost transport matches brute force on a small instance', () => {
  const cost = [[0, 2, 9], [2, 0, 4], [9, 4, 0]];
  const moves = C.minCostTransport([3, 0, 0], [0, 1, 2], cost);
  const total = moves.reduce((s, m) => s + m.n * cost[m.from][m.to], 0);
  assert.strictEqual(moves.reduce((s, m) => s + m.n, 0), 3);
  assert.strictEqual(total, 1 * 2 + 2 * 9);
  // two sources: the cheaper assignment must be found
  const mv2 = C.minCostTransport([1, 1, 0], [0, 0, 2], [[0, 1, 5], [1, 0, 1], [5, 1, 0]]);
  assert.strictEqual(mv2.reduce((s, m) => s + m.n * [[0, 1, 5], [1, 0, 1], [5, 1, 0]][m.from][m.to], 0), 6);
});

test('schedule shaping keeps the car-minute budget and follows the curve', () => {
  const req = Float64Array.from([10, 20, 40, 80, 40, 20, 10, 10]);
  const sch = C.scheduleFromCurve(req, 100 * 8 * 15, 5);
  const tot = sch.reduce((a, b) => a + b, 0) * 15;
  assert.ok(tot <= 100 * 8 * 15 && tot > 0.97 * 100 * 8 * 15, `total ${tot}`);
  assert.strictEqual(sch.indexOf(Math.max(...sch)), 3);
});

test('simulation conserves parties and a very large fleet gives short waits', () => {
  const rng = C.makeRng(4);
  const show = { dayIdx: 1, openMin: 540, closeMin: 1020, registrations: 20000, riders: 20000 };
  const parties = C.sampleDay(net, show, rng);
  const r = C.simulate(net, parties, 400, 'reactive', null);
  assert.strictEqual(r.served + r.abandoned + r.unserved, parties.length);
  assert.strictEqual(r.abandoned, 0);
  assert.ok(r.p95 <= 3, `p95 ${r.p95}`);
  const small = C.simulate(net, parties, 30, 'reactive', null);
  assert.ok(small.p95 > r.p95 && small.abandoned > 0);
});

let RUN = null;
const run = () => (RUN = RUN || C.runAll({}));

test('forecast: 90% conformal intervals cover about 90% of held-out station-blocks', () => {
  const R = run();
  assert.ok(R.coverage > 0.85 && R.coverage < 0.95, `coverage ${R.coverage}`);
});

test('end to end: same driver-hours, forecast-shaped plan beats staffing to the historical curve', () => {
  const R = run();
  assert.ok(Math.abs(R.runs.plan.carMin - R.runs.history.carMin) / R.runs.history.carMin < 0.02, 'equal budgets');
  assert.ok(R.runs.plan.p95 <= C.CFG.waitTarget, `plan p95 ${R.runs.plan.p95}`);
  assert.ok(R.runs.history.p95 > 2 * R.runs.plan.p95);
  assert.ok(R.runs.plan.abandoned < R.runs.history.abandoned);
});

test('end to end: smallest budget holding p95 <= 5 min is ordered plan < history < flat', () => {
  const R = run();
  const b = R.minBudget;
  assert.ok(b.plan < b.history && b.history < b.flat, JSON.stringify(b));
});
