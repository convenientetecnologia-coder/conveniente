"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const ew = require(path.join(ROOT, "scripts", "ensureWorking.js"));
const workerSrc = fs.readFileSync(path.join(ROOT, "scripts", "worker.js"), "utf8");

const healthy = {
  wantActive: true,
  wantVirtus: "on",
  browserConnected: true,
  trabalhando: false,
  virtusOnline: false,
  flags: {}
};

assert.strictEqual(ew.classifyEnsureWorking(healthy).action, "start");
assert.strictEqual(ew.classifyEnsureWorking(healthy).reason, "healthy_idle");
assert.strictEqual(
  ew.classifyEnsureWorking({ ...healthy, trabalhando: true, virtusOnline: true }).reason,
  "already_working"
);
assert.strictEqual(
  ew.classifyEnsureWorking({ ...healthy, trabalhando: true, virtusOnline: false }).reason,
  "trabalhando_without_virtus"
);
assert.strictEqual(
  ew.classifyEnsureWorking({ ...healthy, wantVirtus: "off" }).action,
  "arm_and_start"
);
assert.strictEqual(
  ew.classifyEnsureWorking({ ...healthy, flags: { loginRequired: true } }).reason,
  "login_required"
);
assert.strictEqual(
  ew.classifyEnsureWorking({ ...healthy, flags: { captchaCheckpoint: true } }).reason,
  "captcha_checkpoint"
);
assert.strictEqual(
  ew.classifyEnsureWorking({ ...healthy, humanControl: true }).reason,
  "human_control"
);
assert.strictEqual(
  ew.classifyEnsureWorking({ ...healthy, browserConnected: false }).reason,
  "no_browser"
);
assert.strictEqual(
  ew.classifyEnsureWorking({ ...healthy, robeBusy: true }).reason,
  "robe_busy"
);

assert.strictEqual(
  ew.shouldAuditEnsureTick({ started: 1, leftoverStart: 0 }, { now: 10, lastHeartbeatAt: 1, heartbeatMs: 60_000 }),
  true
);
assert.strictEqual(
  ew.shouldAuditEnsureTick({ leftoverStart: 3 }, { now: 10, lastHeartbeatAt: 9, heartbeatMs: 60_000 }),
  true,
  "déficit de start tem que ir pro audit mesmo sem started"
);
assert.strictEqual(
  ew.shouldAuditEnsureTick({ leftoverStart: 0, started: 0 }, { now: 70_000, lastHeartbeatAt: 1, heartbeatMs: 60_000 }),
  true,
  "heartbeat periódico no steady-state"
);
assert.strictEqual(
  ew.shouldAuditEnsureTick({ leftoverStart: 0, started: 0 }, { now: 10_000, lastHeartbeatAt: 1, heartbeatMs: 60_000 }),
  false
);
assert.strictEqual(
  ew.shouldAuditEnsureTick({ stuckReset: true }, { now: 10, lastHeartbeatAt: 9, heartbeatMs: 60_000 }),
  true
);

assert.strictEqual(ew.isEnsureTickStuck(1000, 50_000, 45_000), true);
assert.strictEqual(ew.isEnsureTickStuck(1000, 10_000, 45_000), false);
assert.strictEqual(ew.isEnsureTickStuck(0, 50_000, 45_000), false);

(async () => {
  const t0 = Date.now();
  const timed = await ew.withTimeout(new Promise(() => {}), 80, "ensure_working_start_timeout");
  const elapsed = Date.now() - t0;
  assert.strictEqual(timed.ok, false);
  assert.strictEqual(timed.error, "ensure_working_start_timeout");
  assert.ok(elapsed >= 70 && elapsed < 2000, "timeout tem que cortar, elapsed=" + elapsed);

  const ok = await ew.withTimeout(Promise.resolve({ ok: true }), 2000, "ensure_working_start_timeout");
  assert.strictEqual(ok.ok, true);

  let calls = 0;
  const tick = ew.createEnsureWorkingTick({
    getControllers: () => {
      const m = new Map();
      m.set("a-idle", { browser: { isConnected: () => true }, trabalhando: false, virtus: null });
      m.set("b-work", { browser: { isConnected: () => true }, trabalhando: true, virtus: {} });
      return m;
    },
    readDesired: () => ({
      perfis: {
        "a-idle": { active: true, virtus: "on" },
        "b-work": { active: true, virtus: "on" }
      }
    }),
    readAccountFlags: async () => ({}),
    startWork: async ({ nome }) => {
      calls += 1;
      return { ok: true, nome };
    },
    inShard: () => true
  });
  const sum = await tick.tick();
  assert.strictEqual(sum.neededStart, 1);
  assert.strictEqual(sum.started, 1);
  assert.strictEqual(sum.leftoverStart, 0);
  assert.strictEqual(calls, 1);
  assert.deepStrictEqual(sum.startedNames, ["a-idle"]);
})().then(() => {
  assert.match(workerSrc, /want\.active === true && !isLiveBrowserCtrl\(ctrl\)/);
  assert.match(workerSrc, /activate_drop_stale_controller/);
  assert.match(workerSrc, /opening_ttl_expired/);
  assert.match(workerSrc, /isProfileOpening\(/);
  assert.match(workerSrc, /markProfileOpening\(/);
  assert.match(workerSrc, /ignoreTrabalhando: true/);
  assert.match(workerSrc, /emExecucao === true && isLiveBrowserCtrl\(ctrl\)/);
  assert.ok(
    !/shouldBypassNurseZombie\(nome, 'nurse\.no_pages'\)\) \{\s*robeMeta\[nome\]\.noPagesStrikes = 0;\s*robeMeta\[nome\]\.lastNoPagesAt = 0;/.test(workerSrc),
    "bypass Delta não pode zerar lastNoPagesAt"
  );
  assert.match(workerSrc, /shouldBypassNurseZombie\(nome, 'nurse\.page_zombie'\)[\s\S]{0,80}continue;/);
  const zIdx = workerSrc.indexOf("suspect_page_zombie");
  const zWin = workerSrc.slice(Math.max(0, zIdx - 400), zIdx + 80);
  assert.ok(zWin.includes("lastNoPagesAt"), "page_zombie precisa acumular lastNoPagesAt pro hard-20s");

  console.log("ok _verify_ensure_working");
}).catch((e) => {
  console.error(e);
  process.exit(1);
});
