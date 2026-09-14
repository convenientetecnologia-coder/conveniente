"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");

const root = path.join(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "triagem-append-"));
process.env.CONVENIENTE_DADOS_DIR = tmp;

const tri = require("../scripts/triagemAppend.js");

let failed = 0;
function check(name, ok, extra) {
  if (ok) console.log("OK  " + name);
  else {
    failed += 1;
    console.log("FAIL " + name + (extra ? " :: " + extra : ""));
  }
}

function waitMs(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

(async function main() {
  check("path_in_tmp", tri.FILE_PATH.indexOf(tmp) === 0);
  check("max_10mb", tri.MAX_BYTES === 10 * 1024 * 1024);

  const signed = tri.appendSigned("FORENSIC_TRIAGEM_DOM", {
    stage: "link_extract_hit",
    thread_key: "tk1",
    account_login: "acc1"
  });
  check("signed_ok", signed && signed.ok === true);

  const city = tri.appendJson({
    ts: Date.now(),
    tag: "TRIAGEM_DOM",
    msg: "city_collect",
    ctx: { account_login: "acc1" }
  });
  check("json_ok", city && city.ok === true);

  const fat = tri.appendSigned("FORENSIC_TRIAGEM_WORKER", {
    event: "timer_enqueued_in_reservoir",
    pad: "y".repeat(20000),
    pages: new Array(40).fill(0).map((_, i) => ({ u: "https://example.com/" + i }))
  });
  check("fat_ok", fat && fat.ok === true);

  await waitMs(120);
  const first = fs.existsSync(tri.FILE_PATH) ? fs.readFileSync(tri.FILE_PATH, "utf8") : "";
  check("signed_format", /\[FORENSIC_TRIAGEM_DOM\] \{/.test(first) && /link_extract_hit/.test(first));
  check("json_format", /\{"ts":\d+,"tag":"TRIAGEM_DOM","msg":"city_collect"/.test(first));
  check("fat_clipped", first.indexOf("FORENSIC_TRIAGEM_WORKER") >= 0 && !/y{5000}/.test(first));

  const magic = "MAGIC_HEAD_NO_READ\n";
  const padBytes = tri.MAX_BYTES - Buffer.byteLength(magic, "utf8");
  fs.writeFileSync(tri.FILE_PATH, magic + "z".repeat(padBytes), "utf8");
  check("seed_huge", fs.statSync(tri.FILE_PATH).size >= tri.MAX_BYTES);

  const afterRotate = tri.appendSigned("FORENSIC_TRIAGEM_DOM", { stage: "after_rotate" });
  check("rotate_append_ok", afterRotate && afterRotate.ok === true);

  await waitMs(120);
  const live = fs.existsSync(tri.FILE_PATH) ? fs.readFileSync(tri.FILE_PATH, "utf8") : "";
  const arch1 = path.join(tmp, "forensic_triagem.log.1");
  const archTxt = fs.existsSync(arch1) ? fs.readFileSync(arch1, "utf8").slice(0, 80) : "";

  check("rotate_moved_magic", archTxt.indexOf("MAGIC_HEAD_NO_READ") === 0);
  check("live_has_after_rotate", /\[FORENSIC_TRIAGEM_DOM\] \{[^\n]*after_rotate/.test(live));
  check("live_not_10mb_tail", live.indexOf("MAGIC_HEAD_NO_READ") < 0 && live.length < 64 * 1024);

  const src = (rel) => fs.readFileSync(path.join(root, rel), "utf8");
  const workerSrc = src("scripts/worker.js");
  const deltaSrc = src("scripts/virtusDelta.js");
  const citySrc = src("scripts/deltaCityCollector.js");
  const triSrc = src("scripts/triagemAppend.js");
  const lifeSrc = src("scripts/cellLifecycle.js");
  const allowSrc = src("scripts/logsAllowlist.js");

  check("mod_no_read_content", /readFileSync|readSync|allocUnsafe/.test(triSrc) === false);
  check("mod_rename_rotate", /renameSync/.test(triSrc) && /appendFile\(/.test(triSrc) && /appendFileSync/.test(triSrc) === false);
  check("worker_uses_mod", /triagemAppend\.appendSigned/.test(workerSrc));
  check("delta_uses_mod", /triagemAppend\.appendSigned/.test(deltaSrc));
  check("city_uses_mod", /triagemAppend\.appendJson/.test(citySrc));
  check("no_tail_rewrite", /writeFileSync\(fp, tail/.test(workerSrc + deltaSrc + citySrc) === false);
  check("delta_queue_still_sync", /appendFileSync\(dispatchToCt \? DELTA_QUEUE_PATH/.test(workerSrc));
  check("triagem_emit_untouched", /function __deltaTriagemEmit[\s\S]{0,280}__forensicEmitSync\(FORENSIC_TRIAGEM_LOG_PATH/.test(workerSrc));
  check("stamp_includes_mod", /scripts\/triagemAppend\.js/.test(lifeSrc));
  check("allow_archives", /forensic_triagem_1/.test(allowSrc) && /forensic_triagem\.log\.1/.test(allowSrc));

  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  if (failed) {
    console.log("FAIL_COUNT " + failed);
    process.exit(1);
  }
  console.log("ALL_OK");
})().catch((err) => {
  console.log("FAIL  crash :: " + (err && err.stack || err));
  process.exit(1);
});
