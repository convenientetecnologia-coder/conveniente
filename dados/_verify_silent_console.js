"use strict";
/**
 * Parser da trava silentConsole + stdio de 4 slots. Não sobe cluster.
 */
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const sc = require(path.join(root, "scripts", "serverConfig.js"));
const logger = require(path.join(root, "scripts", "logger.js"));
const cluster = require(path.join(root, "scripts", "clusterMaster.js"));

function check(name, ok) {
  if (!ok) throw new Error("FAIL " + name);
  console.log("ok", name);
}

check("defaults_logging", !!(sc.DEFAULTS && sc.DEFAULTS.logging && sc.DEFAULTS.logging.silentConsole === true));

const eff = sc.readServerConfigEffective({});
check("effective_logging", !!(eff && eff.logging && typeof eff.logging.silentConsole === "boolean"));

const srcSc = fs.readFileSync(path.join(root, "scripts", "serverConfig.js"), "utf8");
check("src_defaults_block", srcSc.includes("logging: {") && srcSc.includes("silentConsole: true"));
check("src_normalize_logging", srcSc.includes("logRaw.silentConsole !== false"));
check("src_write_logging", srcSc.includes("silentConsole: v.normalized.logging.silentConsole !== false"));

const srcLg = fs.readFileSync(path.join(root, "scripts", "logger.js"), "utf8");
check("src_logger_gate", srcLg.includes("if (!isSilentConsole())") && srcLg.includes("console.error") && srcLg.includes("LOG_TO_FILE"));
check("src_logger_no_serverconfig_require", !/require\(\s*['\"]\.\/serverConfig\.js['\"]\s*\)/.test(srcLg));

const srcVd = fs.readFileSync(path.join(root, "scripts", "virtusDelta.js"), "utf8");
check(
  "src_virtus_log_level",
  srcVd.includes("process.env.FB_LOG_LEVEL || (process.env.CONVENIENTE_SILENT_CONSOLE === '0' ? 'info' : 'silent')")
);

const srcCm = fs.readFileSync(path.join(root, "scripts", "clusterMaster.js"), "utf8");
check("src_stdio_4slot_ignore", srcCm.includes("['ignore', 'ignore', 'ignore', 'ipc']"));
check("src_stdio_4slot_inherit", srcCm.includes("['inherit', 'inherit', 'inherit', 'ipc']"));
check("src_no_string_ignore_fork", !/fork\s*\([^)]*stdio:\s*['\"]ignore['\"]/.test(srcCm.replace(/\n/g, " ")));
check("src_ipc_guard", srcCm.includes("stdio[3] !== 'ipc'") && srcCm.includes("CLUSTER_STDIO_FATAL"));

const silent = cluster.workerStdioSlots(true);
const loud = cluster.workerStdioSlots(false);
check("stdio_silent_len4", Array.isArray(silent) && silent.length === 4);
check("stdio_silent_ipc", silent[3] === "ipc");
check("stdio_silent_ignore", silent[0] === "ignore" && silent[1] === "ignore" && silent[2] === "ignore");
check("stdio_loud_inherit", loud[0] === "inherit" && loud[3] === "ipc");
check("stdio_not_string", typeof silent !== "string" && typeof loud !== "string");

check("helpers_exported", typeof cluster.workerStdioSlots === "function" && typeof cluster.resolveClusterSilentConsole === "function");

const prev = process.env.CONVENIENTE_SILENT_CONSOLE;
process.env.CONVENIENTE_SILENT_CONSOLE = "0";
check("env0_loud", logger.isSilentConsole() === false);
process.env.CONVENIENTE_SILENT_CONSOLE = "1";
check("env1_silent", logger.isSilentConsole() === true);
if (prev == null) delete process.env.CONVENIENTE_SILENT_CONSOLE;
else process.env.CONVENIENTE_SILENT_CONSOLE = prev;

process.env.CONVENIENTE_SILENT_CONSOLE = "1";
const calls = { log: 0, warn: 0, error: 0 };
const orig = { log: console.log, warn: console.warn, error: console.error };
console.log = () => { calls.log++; };
console.warn = () => { calls.warn++; };
console.error = () => { calls.error++; };
try {
  logger.info("verify_silent_must_not_paint");
  logger.warn("verify_silent_must_not_paint");
  logger.error("verify_silent_must_not_paint");
} finally {
  console.log = orig.log;
  console.warn = orig.warn;
  console.error = orig.error;
  if (prev == null) delete process.env.CONVENIENTE_SILENT_CONSOLE;
  else process.env.CONVENIENTE_SILENT_CONSOLE = prev;
}
check("console_gated", calls.log === 0 && calls.warn === 0 && calls.error === 0);

const v = sc.validateServerConfigPayload({ logging: { silentConsole: true } });
check("validate_logging_only", v.ok === true && v.normalized.logging.silentConsole === true);
const bad = sc.validateServerConfigPayload({ logging: { silentConsole: "nope" } });
check("validate_logging_bad", bad.ok === false);

console.log("ALL_OK silent_console");
process.exit(0);
