"use strict";

const { EventEmitter } = require("events");
const fs = require("fs");
const path = require("path");

const sweep = require("../scripts/chromeMemorySweep.js");
const robeQueue = require("../scripts/robeQueue.js");

let fail = 0;
function check(name, cond, extra) {
  if (cond) {
    console.log("OK", name);
  } else {
    fail += 1;
    console.log("FAIL", name, extra == null ? "" : extra);
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

const root = path.join(__dirname, "..");
const sweepSrc = fs.readFileSync(path.join(root, "scripts", "chromeMemorySweep.js"), "utf8");
const masterSrc = fs.readFileSync(path.join(root, "scripts", "clusterMaster.js"), "utf8");
const workerSrc = fs.readFileSync(path.join(root, "scripts", "worker.js"), "utf8");
const deltaSrc = fs.readFileSync(path.join(root, "scripts", "virtusDelta.js"), "utf8");
const robeSrc = fs.readFileSync(path.join(root, "scripts", "robeQueue.js"), "utf8");

check("src_no_os_cpus", !/require\(\s*['\"]os['\"]\s*\)/.test(sweepSrc) && !/\bos\.cpus\s*\(/.test(sweepSrc));
check("src_no_freemem", !/\bos\.freemem\s*\(/.test(sweepSrc) && !/\bos\.loadavg\s*\(/.test(sweepSrc));
check("src_no_setInterval", !/\bsetInterval\s*\(/.test(sweepSrc));
check("src_standbylist", sweepSrc.includes("/StandbyList"));
check("src_timeout_default_30s", /STANDBY_SWEEP_TIMEOUT_MS \|\| 30000/.test(sweepSrc));
check("src_not_hard_12s", !/TIMEOUT_MS[^\n]*12000/.test(sweepSrc) && sweep.TIMEOUT_MS === 30000, sweep.TIMEOUT_MS);
check("src_settle_2000", sweep.SETTLE_MS === 2000, sweep.SETTLE_MS);
check("src_min_15min", sweep.MIN_INTERVAL_MS === 15 * 60 * 1000, sweep.MIN_INTERVAL_MS);
check("src_master_wires", masterSrc.includes("chromeMemorySweep") && masterSrc.includes("standby-sweep-idle-hint"));
check("src_master_uses_sendTo", /sendTo\(i, type, payload/.test(masterSrc));
check("src_worker_handlers", workerSrc.includes("standby-sweep-probe") && workerSrc.includes("standby-sweep-arm") && workerSrc.includes("standby-sweep-release"));
check("src_worker_no_stopVirtus_in_arm", !/standby-sweep-arm[\s\S]{0,400}stopVirtus/.test(workerSrc));
check("src_delta_pause", deltaSrc.includes("enqueue.setPaused") && deltaSrc.includes("setSweepPause"));
check("src_delta_busy", deltaSrc.includes("getSweepBusy") && deltaSrc.includes("city_collect_bg"));
check("src_robe_no_1500_poll", !/setTimeout\(\s*\(\)\s*=>\s*\{\s*try\s*\{\s*this\.tick\(\)/.test(robeSrc));
check("src_robe_idle_hook", robeSrc.includes("setIdleHook") && robeSrc.includes("_emitIdle"));
check("src_tag", workerSrc.includes("2026-08-31_standby_sweep_consciente_v1"));

(async () => {
  {
    const { allIdle, reasons } = sweep.collectBusy([
      { ok: true, busy: false },
      { ok: true, busy: true, reasons: ["delta_inflight"] }
    ]);
    check("collect_busy_mixed", allIdle === false && /delta_inflight/.test(reasons.join("|")), reasons);
    check("collect_idle", sweep.collectBusy([{ ok: true, busy: false }]).allIdle === true);
    check("collect_probe_fail", sweep.collectBusy([{ ok: false, error: "timeout" }]).allIdle === false);
  }

  {
    const t0 = Date.now();
    const out = await sweep.runStandbySweep({
      exe: "mock-exe",
      timeoutMs: 800,
      spawnFn: () => {
        const ee = new EventEmitter();
        ee.kill = () => { ee.killed = true; };
        setTimeout(() => ee.emit("close", 0, null), 25);
        return ee;
      }
    });
    check("exe_waits_real_close", !!(out && out.ok && out.killed !== true && out.elapsedMs < 400), out);
    check("exe_not_padded_to_30s", (Date.now() - t0) < 400);
  }

  {
    const out = await sweep.runStandbySweep({
      exe: "mock-hang",
      timeoutMs: 1000,
      spawnFn: () => {
        const ee = new EventEmitter();
        ee.kill = () => {
          ee.killed = true;
          setImmediate(() => ee.emit("close", null, "SIGTERM"));
        };
        return ee;
      }
    });
    check("exe_timeout_kills", !!(out && out.ok === false && out.error === "exe_timeout" && out.killed === true), out);
    check("exe_timeout_bounded", Number(out.elapsedMs || 0) >= 900 && Number(out.elapsedMs || 0) < 1800, out);
  }

  {
    const logs = [];
    const jsonl = [];
    let sweeps = 0;
    let now = 10_000;
    const workers = [{ busy: false, held: false }];
    const coord = sweep.attachHostCoordinator({
      now: () => now,
      minIntervalMs: 1000,
      sendToAll: async (type) => workers.map((w) => {
        if (type === "standby-sweep-probe") return { ok: true, busy: !!w.busy, reasons: w.busy ? ["robe_exec"] : [] };
        if (type === "standby-sweep-arm") { w.held = true; return { ok: true }; }
        if (type === "standby-sweep-release") { w.held = false; return { ok: true }; }
        return { ok: true };
      }),
      shardCount: () => workers.length,
      runSweep: async () => { sweeps += 1; return { ok: true, elapsedMs: 12 }; },
      settle: async () => {},
      log: (l) => logs.push(String(l)),
      jsonl: (r) => jsonl.push(r)
    });
    coord._test.lastOkAt = now - 500;
    const early = await coord.tryAttempt("early");
    check("not_due_skips", !!(early && early.skipped && early.reason === "not_due") && sweeps === 0, early);
    coord._test.lastOkAt = now - 2000;
    const ok = await coord.tryAttempt("due");
    coord.stop();
    check("due_sweeps", !!(ok && ok.ok && sweeps === 1), ok);
    check("log_travada", logs.some((l) => l.includes("[ESTEIRA-TRAVADA]") && l.includes("shards=1")), logs);
    check("log_liberada", logs.some((l) => l.includes("[ESTEIRA-LIBERADA]") && l.includes("settleMs=2000")), logs);
    check("worker_released", workers[0].held === false);
    check("jsonl_has_sweep", jsonl.some((r) => r && r.event === "sweep"), jsonl.map((r) => r && r.event));
  }

  {
    const logs = [];
    let sweeps = 0;
    let now = 50_000;
    const workers = [{ busy: true, held: false }];
    const coord = sweep.attachHostCoordinator({
      now: () => now,
      minIntervalMs: 1000,
      sendToAll: async (type) => workers.map((w) => {
        if (type === "standby-sweep-probe") return { ok: true, busy: !!w.busy, reasons: w.busy ? ["delta_inflight"] : [] };
        if (type === "standby-sweep-arm") { w.held = true; return { ok: true }; }
        if (type === "standby-sweep-release") { w.held = false; return { ok: true }; }
        return { ok: true };
      }),
      shardCount: () => workers.length,
      runSweep: async () => { sweeps += 1; return { ok: true, elapsedMs: 4 }; },
      settle: async () => {},
      log: (l) => logs.push(String(l)),
      jsonl: () => {}
    });
    coord._test.lastOkAt = now - 2000;
    const busy = await coord.tryAttempt("due_busy");
    check("busy_does_not_sweep", !!(busy && busy.skipped && busy.reason === "waiting_idle") && sweeps === 0, busy);
    check("busy_still_armed", workers[0].held === true && coord._test.hostArmed === true);
    check("busy_waiting_flag", coord._test.waitingIdle === true);
    check("log_waiting", logs.some((l) => l.includes("waiting_idle")), logs);
    workers[0].busy = false;
    coord.idleHint();
    await sleep(450);
    check("idle_hint_sweeps", sweeps === 1, sweeps);
    check("hint_releases", workers[0].held === false);
    coord.stop();
  }

  {
    robeQueue.clear();
    robeQueue.setPausePredicate(null);
    let ran = 0;
    robeQueue.setPausePredicate(() => true);
    const enq = robeQueue.enqueue("sweep-test-a", async () => { ran += 1; });
    check("robe_enq_while_paused", enq === true);
    await sleep(40);
    check("robe_pause_holds_next", ran === 0 && robeQueue.isActive("sweep-test-a") === false, { ran, list: robeQueue.queueList() });
    check("robe_keeps_waiting", robeQueue.inQueue("sweep-test-a") === true);
    robeQueue.setPausePredicate(null);
    robeQueue.tick();
    await sleep(40);
    check("robe_release_runs", ran === 1, ran);
    robeQueue.clear();
  }

  if (fail) {
    console.error("FAIL_COUNT", fail);
    process.exit(1);
  }
  console.log("ALL_OK_STANDBY_SWEEP");
  process.exit(0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
