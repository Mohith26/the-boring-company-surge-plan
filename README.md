# Surge Plan: forecast-shaped driver staffing and car staging for the Vegas Loop

**Live demo:** https://mohith26.github.io/the-boring-company-surge-plan/

Unofficial concept demo by Mohith Gajjela. Not affiliated with The Boring Company or Vegas Loop. Synthetic data; station locations approximate (from public maps), tunnel graph simplified.

## What it is

Vegas Loop moves 30-40k riders on a big convention day (127,566 riders across 14 stations during SEMA 2026, ~40k on a busy day per TBC's Mike Baier). The hard part is not the tunnel trip, it is the minutes after a show closes, when thousands of people arrive at LVCC stations at once and the cars are elsewhere. Two levers decide that queue: **how many cars (drivers) are on duty in each 15 minutes**, and **where idle cars wait**.

Surge Plan is a page next to Dispatch in a Vegas Loop operations console. For a show day it:

1. **Forecasts departures** per station and origin-destination pair every 5 minutes from past show days (aligned to the show's close time, scaled by registrations), with **split-conformal 90% intervals** per station and 15-minute block.
2. **Turns the forecast into car demand**: loaded car-minutes (load + tunnel travel + unload) plus the empty repositioning car-minutes implied by each block's inbound/outbound imbalance (a min-cost transport problem), using the 80% upper forecast.
3. **Shapes a fixed driver-hour budget** to that curve, and every 15 minutes stages idle cars toward the stations that will need them (min-cost flow on empty travel minutes).
4. **Checks the plan in a discrete-event simulation** (parties queue FIFO, loading bays, travel times, reactive nearest-idle-car pull for every policy, riders walk away after 45 minutes) against two baselines with the **same driver-hours**: a flat fleet, and a schedule shaped to the historical average ridership curve.

## Results (busiest held-out day: show day 2, 36,738 riders, show closes 17:00)

Same budget for all three (about 2,160 driver-hours, 06:00-24:00):

| Schedule | p95 wait | p95 wait in the 17:00 hour | Walked away (>45 min) |
|---|---|---|---|
| Flat (120 cars all day) | 45 min | 28.6 min | 1,791 parties |
| Shaped to the historical ridership curve | 36.1 min | 31.7 min | 831 parties |
| **Forecast plan** | **3.7 min** | **4.9 min** | **0** |

Smallest budget that holds p95 wait at or under 5 minutes on that day: flat 184 car-equivalents (3,312 driver-hours), historical curve 145 (2,610), **forecast plan 117 (2,106): 19% fewer driver-hours than the historical curve, 36% fewer than flat**.

Forecast intervals: 91.5% of held-out station-blocks fall inside the 90% band (9,080 station x 15-min blocks over 10 test days).

Five more seeds (`node scripts/report.js 5`): driver-hour saving vs the historical curve 15-33%; at the fixed budget the plan's p95 is 2.9-6.5 min (above 5 min on two of five days) vs 8.5-45 min for the historical curve; interval coverage 89.4-91.9%.

Honest attribution: on the default day, staging moves change almost nothing (p95 3.7 min with or without them); the gain comes from shaping the driver budget to a travel-time-aware car-demand curve from a day-specific forecast. Staging matters more when the fleet is tight; I left it in because it is how the plan would be executed.

All numbers come from `node scripts/report.js` (writes `data/summary.json`); the page recomputes everything in the browser from the same seeded code.

## How it works

* **Network** (`core.js`): 13 stations at approximate public locations (LVCC West/Central/Central Plaza/South/Riviera, Resorts World, Westgate, Encore, Fontainebleau, Sahara, Turnberry Towers, Airport T1/T3), a simplified tunnel graph with two junctions on the airport branch, length = straight line x 1.15, 13.5 m/s average speed, loading bays per station.
* **Demand**: synthetic history of 70 show days (48 train, 12 calibration, 10 test). Each day mixes inbound (hotels to halls, around opening), outbound (halls to hotels, sharp after close), intra-LVCC and evening hotel-to-hotel trips; attendance varies (lognormal), the last show day closes early, some days close 30 min late. Parties of 1-4.
* **Forecaster**: per (origin, destination, 5-min bin) average share of the day's trips over training days of the same type, with the afternoon aligned to the close time, times registrations x a learned rider rate per day type.
* **Conformal**: score = (actual - forecast) / sqrt(forecast + 4) per station x 15-min block on calibration days; two-sided 90% quantile for the band, one-sided 80% quantile for planning.
* **Requirement curve**: per block, sum over OD of upper-forecast trips x (load + travel + unload) plus min-cost transport of the block's imbalance, divided by block length.
* **Schedule**: cars on duty per block = max(floor, c x requirement) with c chosen so the total equals the budget; the historical baseline uses the same rule on average historical departures.
* **Simulation**: 1-minute steps with sub-minute arrivals; FIFO queues; one load per bay per minute; cars reappear at the destination after travel + unload; any station with a queue and no car pulls the nearest spare idle cars (all policies); new drivers start where the plan or the queue needs them; drivers leaving only take idle cars.

## Tests

```
node --test test/core.test.js     # 8 tests
node scripts/report.js 5          # headline numbers + 5-seed benchmark
```

Covers: travel-time symmetry and triangle inequality, deterministic demand matching the rider target, min-cost transport against brute force, budget-preserving schedule shaping, party conservation and wait behaviour at large and tiny fleets, 90% interval coverage on held-out days, the same-budget comparison, and the ordering of minimum budgets (plan < historical curve < flat).

## Honest limitations

* Everything is synthetic. Demand shapes, attendance, party sizes, bay counts, speeds and the tunnel graph are my assumptions; real station capacities, driver rules (breaks, shift lengths, minimum shift) and dispatch logic are not modelled.
* Riders are one party per car; pooling strangers to the same destination, which raises surge capacity, is not modelled.
* The historical-curve baseline is a stand-in for how staffing might be planned today; I don't know TBC's actual process, which may already be better than this baseline.
* The forecaster is simple (profile x registrations); a real one would use ticket scans, show schedules, hotel occupancy and live feedback, and would be re-run during the day.
* Two of five extra seeds miss the 5-minute target at the default budget; the plan reports the budget it needs instead of hiding that.
* The map is a schematic drawn on canvas (the airport run is compressed); footprints are generic boxes, not traced from any map.

## Novelty note

TBC does not publish its operations tooling (Vegas Loop's software stack includes automated traffic management per public LinkedIn descriptions), and it obviously staffs drivers for shows today. I found no public description of a forecast-driven, travel-time-aware staffing and staging planner for the Loop, or of calibrated departure forecasts. Fleet rebalancing and demand-driven driver scheduling are well studied for ride-hailing and taxis; the contribution here is the combination for a point-to-point tunnel network evaluated at equal driver-hours. I can't verify what TBC's internal tools already do.

## Files

* `index.html`, `styles.css`, `app.js`: the page, styled with the public vegasloop.com design tokens (Inter, `--vl-*` colours, radii, 11 px uppercase detail labels, map colours).
* `core.js`: network, demand, forecaster, conformal, requirement curve, schedules, min-cost flow, simulation (UMD).
* `scripts/report.js`, `test/core.test.js`, `data/summary.json`, `assets/vegas-loop-wordmark.svg`.
