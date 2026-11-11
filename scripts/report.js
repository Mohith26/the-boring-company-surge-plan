// Headline numbers for README/page + multi-seed benchmark. Usage: node scripts/report.js [nSeeds]
const fs = require('fs'), path = require('path');
const C = require('../core.js');
function summary(R) {
  const r = R.runs, f = (x) => ({ p50: +x.p50.toFixed(1), p95: +x.p95.toFixed(1), abandoned: x.abandoned, emptyCarMin: x.emptyMin, carMin: x.carMin, egressHourP95: +x.hourP95[11].toFixed(1) });
  return {
    targetDay: { parties: R.target.parties.length, riders: R.target.parties.reduce((a, p) => a + p.size, 0), close: R.target.show.closeMin / 60, dayOfShow: R.target.show.dayIdx + 1 },
    forecast: { coverage90: +R.coverage.toFixed(3), cells: R.nCoverage, q: +R.conf.qTwoSided.toFixed(3), calibScores: R.conf.n },
    budgetCars: R.budgetCars, driverHours: Math.round(R.budgetCars * 18),
    flat: f(r.flat), history: f(r.history), planNoStage: f(r.planNoStage), plan: f(r.plan),
    minBudget: R.minBudget,
    savingVsHistory: R.minBudget && R.minBudget.history ? +(1 - R.minBudget.plan / R.minBudget.history).toFixed(3) : null,
    savingVsFlat: R.minBudget && R.minBudget.flat ? +(1 - R.minBudget.plan / R.minBudget.flat).toFixed(3) : null,
  };
}
const main = summary(C.runAll({}));
console.log(JSON.stringify(main, null, 2));
const bench = [];
for (let k = 0; k < +(process.argv[2] || 5); k++) {
  const seed = 101 + 211 * k, s = summary(C.runAll({ seed }));
  bench.push({ seed, riders: s.targetDay.riders, coverage90: s.forecast.coverage90, historyP95: s.history.p95, historyAbandoned: s.history.abandoned, planP95: s.plan.p95, planAbandoned: s.plan.abandoned, minBudget: s.minBudget, savingVsHistory: s.savingVsHistory });
  console.log('seed', seed, JSON.stringify(bench[bench.length - 1]));
}
fs.writeFileSync(path.join(__dirname, '..', 'data', 'summary.json'), JSON.stringify({ main, bench }, null, 2));
