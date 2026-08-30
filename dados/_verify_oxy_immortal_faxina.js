"use strict";

const { EventEmitter } = require("events");
const faxina = require("../scripts/chromeHeapFaxina.js");
const life = require("../scripts/indexLifecycle.js");

let fail = 0;
function check(name, cond, extra) {
  if (cond) {
    console.log("OK", name);
  } else {
    fail += 1;
    console.log("FAIL", name, extra || "");
  }
}

faxina._resetForTests();

// 1) Puppeteer 24: _client é método
{
  const sent = [];
  const page = {
    _client() {
      return { send: async (m) => { sent.push(m); } };
    },
    isClosed() { return false; }
  };
  const r = faxina.resolveCdpClient(page);
  check("cdp_via_client_fn", !!(r && r.via === "page._client()"));
}

// 2) GC usa HeapProfiler.collectGarbage no client nativo
(async () => {
  faxina._resetForTests();
  const sent = [];
  const page = {
    _client() {
      return { send: async (m) => { sent.push(m); return { ok: true }; } };
    },
    isClosed() { return false; }
  };
  const out = await faxina.collectPageGarbage(page, { nome: "conta_teste", reason: "unit" });
  check("gc_ok", !!(out && out.ok === true), out);
  check("gc_method", sent[0] === "HeapProfiler.collectGarbage", sent);
})().then(async () => {
  // 3) sequencial: segunda espera a primeira
  faxina._resetForTests();
  let current = 0;
  let maxOverlap = 0;
  const mk = (nome) => ({
    nome,
    page: {
      _client() {
        return {
          send: async () => {
            current += 1;
            maxOverlap = Math.max(maxOverlap, current);
            await new Promise((r) => setTimeout(r, 40));
            current -= 1;
          }
        };
      },
      isClosed() { return false; }
    }
  });
  const a = mk("a");
  const b = mk("b");
  await Promise.all([
    faxina.collectPageGarbage(a.page, { nome: a.nome, reason: "seq" }),
    faxina.collectPageGarbage(b.page, { nome: b.nome, reason: "seq" })
  ]);
  check("gc_serial_no_overlap", maxOverlap === 1, { maxOverlap });

  // 4) cooldown não dispara segundo GC na mesma conta
  faxina._resetForTests();
  let n = 0;
  const page = {
    _client() { return { send: async () => { n += 1; } }; },
    isClosed() { return false; }
  };
  const first = await faxina.collectPageGarbage(page, { nome: "cool", reason: "c1" });
  const second = await faxina.collectPageGarbage(page, { nome: "cool", reason: "c2" });
  check("cooldown_first_ok", !!(first && first.ok));
  check("cooldown_second_skip", !!(second && second.skipped && second.reason === "cooldown"), second);
  check("cooldown_send_once", n === 1, n);

  // 5) skip se reply em voo — não engessa o Delta
  faxina._resetForTests();
  const busy = {
    __virtusDeltaReplyInFlight: true,
    _client() { return { send: async () => { throw new Error("should_not_gc"); } }; },
    isClosed() { return false; }
  };
  const busyOut = await faxina.collectPageGarbage(busy, { nome: "busy", reason: "reply" });
  check("skip_reply_inflight", !!(busyOut && busyOut.skipped), busyOut);

  // 6) sanitize NUNCA wipeia sem nome de evento
  const ee = new EventEmitter();
  ee.on("keep", () => {});
  ee.on("wipe", () => {});
  ee.on("wipe", () => {});
  faxina.sanitizeListenCycle(ee, ["wipe", "", null]);
  check("sanitize_keeps_other", ee.listenerCount("keep") === 1);
  check("sanitize_wipes_named", ee.listenerCount("wipe") === 0);

  // 7) MaxListeners sobe, não zera (0 = Infinity)
  const ee2 = new EventEmitter();
  faxina.elevateMaxListeners(ee2, 32);
  check("max_listeners_32", ee2.getMaxListeners() === 32);
  ee2.setMaxListeners(0);
  faxina.elevateMaxListeners(ee2, 32);
  check("max_listeners_respects_unlimited", ee2.getMaxListeners() === 0);

  // 8) SIGHUP/SIGBREAK NÃO chamam process.exit
  const origExit = process.exit;
  let exitCode = null;
  process.exit = (code) => { exitCode = code; };
  try {
    const r1 = life.handleConsoleSessionSignal("SIGHUP");
    const r2 = life.handleConsoleSessionSignal("SIGBREAK");
    check("sighup_keep_alive", !!(r1 && r1.keptAlive === true && r1.exited === false));
    check("sigbreak_keep_alive", !!(r2 && r2.keptAlive === true && r2.exited === false));
    check("no_process_exit", exitCode === null, exitCode);
    check("is_session_sighup", life.isConsoleSessionSignal("SIGHUP") === true);
    check("is_session_sigint_false", life.isConsoleSessionSignal("SIGINT") === false);
  } finally {
    process.exit = origExit;
  }

  // 9) error sink impede EventEmitter sem listener (não mata processo)
  const pageEe = new EventEmitter();
  pageEe.isClosed = () => false;
  faxina.attachErrorSink(pageEe);
  pageEe.emit("error", new Error("tab_crash_sim"));
  check("error_sink_marks_crash", pageEe.__oxyCrashed === true);
  check("error_sink_idempotent", faxina.attachErrorSink(pageEe) === false);

  if (fail) {
    console.error("FAIL_COUNT", fail);
    process.exit(1);
  }
  console.log("ALL_OK");
  process.exit(0);
}).catch((e) => {
  console.error(e);
  process.exit(1);
});
