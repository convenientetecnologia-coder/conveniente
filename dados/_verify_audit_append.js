"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");

const root = path.join(__dirname, "..");
let failed = 0;
function check(name, ok, extra) {
  if (ok) console.log("OK  " + name);
  else {
    failed += 1;
    console.log("FAIL " + name + (extra ? " :: " + extra : ""));
  }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "audit-append-"));
const audit = require("../scripts/auditAppend.js");
const fat = {
  event: "lr_scan_tabs",
  pages: new Array(40).fill(0).map((_, i) => ({ u: "https://example.com/" + i, pad: "x".repeat(4000) })),
  details: { huge: "y".repeat(20000), nested: { a: 1, b: { c: 2 } } }
};
const slim = audit.slim(fat);
const slimLine = JSON.stringify(slim);
check("slim_small", slimLine.length < 8000);
check("slim_pages_capped", Array.isArray(slim.pages) && slim.pages.length <= 9);
check("slim_no_20k_string", !/y{5000}/.test(slimLine));

const fp = path.join(tmp, "audit.jsonl");
const wrote = audit.appendLine(fp, { event: "ping", perfil: "acc1" });
check("append_ok", wrote && wrote.ok === true);

const hugeWrite = audit.appendLine(fp, fat);
check("huge_append_ok", hugeWrite && hugeWrite.ok === true);

setTimeout(() => {
  const txt = fs.existsSync(fp) ? fs.readFileSync(fp, "utf8") : "";
  check("file_has_ping", /"event":"ping"/.test(txt));
  check("file_not_fat_20k", !/y{5000}/.test(txt));

  const auditSrc = fs.readFileSync(path.join(root, "scripts", "auditAppend.js"), "utf8");
  check("src_no_ram_bag", !/queue\.push|pendingLines/.test(auditSrc) && /appendFile\(/.test(auditSrc) && !/appendFileSync/.test(auditSrc));

  const provSrc = fs.readFileSync(path.join(root, "scripts", "provisionAudit.js"), "utf8");
  check("prov_uses_helper", /auditAppend/.test(provSrc) && !/appendFileSync/.test(provSrc));

  const browserSrc = fs.readFileSync(path.join(root, "scripts", "browser.js"), "utf8");
  check("pinlog_async", /auditAppend/.test(browserSrc) && !/pinLog[\s\S]{0,180}appendFileSync/.test(browserSrc));

  const workerSrc = fs.readFileSync(path.join(root, "scripts", "worker.js"), "utf8");
  check("worker_appendjsonl_async", /function appendJsonl[\s\S]{0,180}auditAppend/.test(workerSrc));
  check("worker_delta_still_sync", /DELTA_QUEUE_PATH[\s\S]{0,80}appendFileSync/.test(workerSrc) || /appendFileSync\(dispatchToCt \? DELTA_QUEUE_PATH/.test(workerSrc));
  check("worker_pin_no_sync", !/messenger_pin\.jsonl[\s\S]{0,80}appendFileSync/.test(workerSrc));

  const indexSrc = fs.readFileSync(path.join(root, "index.js"), "utf8");
  check("index_forensic_async", /function __forensicEmitSync[\s\S]{0,220}auditAppend/.test(indexSrc));

  const deltaSrc = fs.readFileSync(path.join(root, "scripts", "virtusDelta.js"), "utf8");
  check("delta_forensic_async", /function __forensicEmitSync[\s\S]{0,220}auditAppend/.test(deltaSrc));

  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  if (failed) {
    console.log("FAIL_COUNT " + failed);
    process.exit(1);
  }
  console.log("ALL_OK");
}, 80);
