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

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "native-eye-"));
process.env.CONVENIENTE_DADOS_DIR = tmp;

const nativeAbs = require.resolve("../scripts/nativeCrashLog.js");
delete require.cache[nativeAbs];
const native = require("../scripts/nativeCrashLog.js");

const fast = native.decodeExitCode(-1073740791);
check("hex_fastfail", fast.hex === "0xC0000409" && fast.name === "FASTFAIL");
const abort = native.decodeExitCode(134);
check("hex_abort", abort.name === "ABORT");
const heap = native.decodeExitCode(-1073740940);
check("hex_heap_corrupt", heap.hex === "0xC0000374" && heap.name === "HEAP_CORRUPT");

const tiny = path.join(tmp, "messenger_pin.jsonl");
fs.mkdirSync(tmp, { recursive: true });
fs.writeFileSync(tiny, "x".repeat(80), "utf8");
const small = native.archiveHugeJsonl({ maxBytes: 1000 });
check("huge_skip_small", Array.isArray(small) && small.some((r) => r.key === "messenger_pin" && r.skipped === "small"));

fs.writeFileSync(tiny, "y".repeat(2000), "utf8");
const moved = native.archiveHugeJsonl({ maxBytes: 500, keep: 2 });
const pinHit = (moved || []).find((r) => r.key === "messenger_pin");
check("huge_rename_no_read", pinHit && pinHit.ok === true && Number(pinHit.bytes) === 2000);
check("huge_recreated_empty", fs.existsSync(tiny) && fs.statSync(tiny).size === 0);
check("huge_dest_in_logs", pinHit && pinHit.dest && fs.existsSync(path.join(tmp, "logs", pinHit.dest)));

const cellLog = native.cellNativeLogPath(2);
fs.mkdirSync(path.dirname(cellLog), { recursive: true });
fs.writeFileSync(cellLog, "hello\nFatal process out of memory: Zone\n", "utf8");
const tail = native.tailFileBytes(cellLog, 200);
check("tail_has_zone", /out of memory: Zone/.test(tail));
const opened = native.openCellNativeFd(2);
check("open_cell_fd", opened && Number.isFinite(opened.fd));
try { fs.closeSync(opened.fd); } catch {}

const reportDir = native.REPORT_DIR;
fs.mkdirSync(reportDir, { recursive: true });
const reportName = "report.20260913.194237.47648.0.001.json";
fs.writeFileSync(path.join(reportDir, reportName), "{\"ok\":1}\n", "utf8");
const idxw = native.writeReportsIndex();
check("reports_index_ok", idxw && idxw.ok === true);
const listed = native.listRecentReports(5);
check("reports_list_pid", listed.some((r) => r.name === reportName && Number(r.pid) === 47648));
const found = native.findReportForPid(47648);
check("reports_find_pid", found && found.name === reportName);
check("reports_find_miss_null", native.findReportForPid(1) == null);

fs.writeFileSync(path.join(reportDir, reportName), JSON.stringify({
  header: { event: "Allocation failed - JavaScript heap out of memory", trigger: "FatalError" },
  javascriptHeap: { usedHeapSize: 16 * 1048576, totalHeapSize: 18 * 1048576, heapSizeLimit: 32 * 1048576 }
}) + "\n", "utf8");
const sum = native.summarizeReport(path.join(reportDir, reportName));
check("report_summary_trigger", sum && sum.trigger === "FatalError" && /heap out of memory/.test(String(sum.event || "")));
check("report_summary_heap", sum && sum.heap && Number(sum.heap.usedMB) === 16);
const idxw2 = native.writeReportsIndex();
check("reports_index_refresh", idxw2 && idxw2.ok === true);
const idxBody = JSON.parse(fs.readFileSync(native.INDEX_JSON, "utf8"));
check("reports_index_has_trigger", idxBody && Array.isArray(idxBody.items) && idxBody.items.some((it) => it && it.trigger === "FatalError"));

const host = fs.readFileSync(path.join(root, "scripts", "convenienteNodeHost.ps1"), "utf8");
check("host_redirect", /cmd\.exe \/c/.test(host) && /2>> `"\$errLog`"/.test(host) && /1>> `"\$outLog`"/.test(host));
check("host_hex_fn", /function Format-ExitHex/.test(host) && /codeName/.test(host));
check("host_no_ps_amp", !/& \$node \$idx 1>>/.test(host));

const cluster = fs.readFileSync(path.join(root, "scripts", "clusterMaster.js"), "utf8");
check("cluster_stderr_fd", /openCellNativeFd/.test(cluster) && /\['ignore', 'ignore', errFd\]/.test(cluster));
check("cluster_drop_tail", /nativeTail/.test(cluster) && /codeName/.test(cluster) && /_goneAt/.test(cluster));

const worker = fs.readFileSync(path.join(root, "scripts", "worker.js"), "utf8");
check("worker_lr_fp", /lastLrScanFp/.test(worker));
check("worker_pin_fp", /lastPinScanFp/.test(worker));

const allow = fs.readFileSync(path.join(root, "scripts", "logsAllowlist.js"), "utf8");
check("allow_native_keys", /crash_nativo_index/.test(allow) && /cell_\$\{i\}_native/.test(allow) && /node_report_/.test(allow));

const indexJs = fs.readFileSync(path.join(root, "index.js"), "utf8");
check("index_boot_archive", /archiveHugeJsonl/.test(indexJs));

const life = fs.readFileSync(path.join(root, "scripts", "indexLifecycle.js"), "utf8");
check("life_jsonl_sizes", /jsonlSizes/.test(life) && /indexDeathEvidence/.test(life));

const dash = fs.readFileSync(path.join(root, "scripts", "dashboard.js"), "utf8");
check("dash_rotate_keep_3", /archiveHugeJsonl/.test(dash) && /keep: 3/.test(dash) && /skipped: 'small'/.test(dash));

const fetchExec = fs.readFileSync(path.join(root, "scripts", "logFetchExec.js"), "utf8");
check("fetch_report_from_start", /node_report_\\d\+/.test(fetchExec) && /reportHead/.test(fetchExec));

const evMiss = native.deathEvidence({ idx1: 2, pid: 1 });
check("death_no_wrong_report", evMiss && evMiss.reportName == null);

try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}

if (failed) {
  console.log("FAIL_COUNT " + failed);
  process.exit(1);
}
console.log("ALL_OK");
