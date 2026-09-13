"use strict";

const assert = require("assert");
const path = require("path");
const fs = require("fs");

const ROOT = path.join(__dirname, "..");
const wh = require(path.join(ROOT, "scripts", "workHours.js"));
const bootIntent = require(path.join(ROOT, "scripts", "bootIntent.js"));

const WIN = {
  enabled: true,
  mode: "window_close_open",
  closeStartMin: 60,
  openStartMin: 300,
  openEndMin: 420,
  day: "2026-09-13"
};

function hours(nowMin, lastOpenDay) {
  return wh.decideWorkHours({
    ...WIN,
    nowMin,
    lastOpenDay: lastOpenDay || null
  });
}

assert.strictEqual(hours(245).reason, "closed_night_clock");
assert.strictEqual(hours(245).inWorkHours, false);
assert.strictEqual(hours(120).reason, "closed_night_clock");

assert.strictEqual(hours(330).reason, "wait_scheduled_open");
assert.strictEqual(hours(330).inWorkHours, true);
assert.strictEqual(hours(330).waitScheduledOpen, true);

assert.strictEqual(hours(412, "2026-09-13").reason, "work_hours_clock");
assert.strictEqual(hours(412, "2026-09-13").waitScheduledOpen, false);

assert.strictEqual(hours(421).reason, "work_hours_clock");
assert.strictEqual(hours(635).reason, "work_hours_clock");
assert.strictEqual(hours(30).reason, "work_hours_clock");

assert.strictEqual(
  wh.shouldSkipStartClosedOnPorterBoot({
    bootSource: "porteiro",
    inWorkHours: true,
    holdStopWorkers: false
  }),
  true,
  "porteiro de dia não zera desired"
);
assert.strictEqual(
  wh.shouldSkipStartClosedOnPorterBoot({
    bootSource: "porteiro",
    inWorkHours: false,
    holdStopWorkers: false
  }),
  false,
  "04:05 continua start-closed"
);
assert.strictEqual(
  wh.shouldSkipStartClosedOnPorterBoot({
    bootSource: "iniciar",
    inWorkHours: true,
    holdStopWorkers: false
  }),
  false,
  "clique Iniciar continua start-closed"
);
assert.strictEqual(
  wh.shouldSkipStartClosedOnPorterBoot({
    bootSource: "porteiro",
    inWorkHours: true,
    holdStopWorkers: true
  }),
  false,
  "Encerrar continua zerando"
);

assert.strictEqual(wh.countDesiredActive({ perfis: { a: { active: true }, b: { active: false } } }), 1);
assert.strictEqual(wh.desiredAllOff({ perfis: { a: { active: false } } }), true);
assert.strictEqual(wh.desiredAllOff({ perfis: { a: { active: true } } }), false);

assert.strictEqual(
  bootIntent.decideWorkCycle({
    enabled: true,
    mode: "window_close_open",
    nowMin: 635,
    day: "2026-09-13",
    lastOpenDay: "2026-09-13",
    lastOpenAt: 1,
    lastCloseAt: 9e15
  }).inWorkCycle,
  true,
  "carimbo lastOpenAt velho não manda no expediente"
);
assert.strictEqual(
  bootIntent.decideWorkCycle({
    enabled: true,
    mode: "window_close_open",
    nowMin: 245,
    day: "2026-09-13",
    lastOpenDay: "2026-09-13"
  }).inWorkCycle,
  false,
  "04:05 fora do expediente"
);

const indexJs = fs.readFileSync(path.join(ROOT, "index.js"), "utf8");
assert.ok(indexJs.includes("shouldSkipStartClosedOnPorterBoot"));
const sched = fs.readFileSync(path.join(ROOT, "scripts", "dailyWindowScheduler.js"), "utf8");
assert.ok(sched.includes("await maybeRecoverOpenAllIfDesiredOff()"));
assert.ok(sched.includes("daily_window_open_skip_already_done"));
assert.ok(
  sched.indexOf("daily_window_open_skip_already_done") < sched.indexOf("await maybeRecoverOpenAllIfDesiredOff()"),
  "recover roda depois que a agenda já gastou a bala do dia"
);

console.log("ok _verify_work_hours");
