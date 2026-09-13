"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const cluster = require(path.join(ROOT, "scripts", "clusterMaster.js"));
const src = fs.readFileSync(path.join(ROOT, "scripts", "clusterMaster.js"), "utf8");

assert.strictEqual(typeof cluster.shouldApplyNodeStatusJournal, "function", "helper export ausente");

assert.strictEqual(
  cluster.shouldApplyNodeStatusJournal({ liveChild: false, ageMs: 1000 }),
  true,
  "journal fresco sem child vivo ainda vale"
);
assert.strictEqual(
  cluster.shouldApplyNodeStatusJournal({ liveChild: true, ageMs: 120000 }),
  true,
  "journal stale de child vivo ainda vale como fallback"
);
assert.strictEqual(
  cluster.shouldApplyNodeStatusJournal({ liveChild: false, ageMs: 120000 }),
  false,
  "journal stale órfão não pode contaminar aggregate"
);

assert(src.includes("stale_ignored("), "aggregate precisa marcar stale órfão como ignored");
assert(src.includes("ignored: true"), "debug do aggregate precisa expor ignored");
assert(
  /if \(fb\.ageMs > MAX_FILE_AGE_MS\) \{\s*if \(liveChild\) \{\s*warningParts/.test(src),
  "warning partial deve ficar só para child vivo stale"
);
const staleAgePos = src.indexOf("if (fb.ageMs > MAX_FILE_AGE_MS)");
assert(staleAgePos >= 0, "ramo de journal_stale precisa existir");
const staleAgeSlice = src.slice(staleAgePos, staleAgePos + 220);
assert(
  staleAgeSlice.includes("warningParts") && !staleAgeSlice.includes("missingIdx.push"),
  "jornal stale de child vivo não dispara RPC"
);
assert(
  /else if \(liveChild\) \{\s*missingIdx\.push\(i\);/.test(src),
  "RPC só quando o jornal do node não existe"
);

const blockedPos = src.indexOf("if (ownerLooksBlockedNotCell) {");
const blockedEnd = blockedPos >= 0 ? src.indexOf("child.deadHandled = true;", blockedPos) : -1;
assert(blockedPos >= 0 && blockedEnd > blockedPos, "ramo de porta bloqueada por não-célula precisa existir");
if (blockedPos >= 0 && blockedEnd > blockedPos) {
  const blockedBranch = src.slice(blockedPos, blockedEnd);
  assert(blockedBranch.includes("cell_port_blocked_not_cell"), "forense do bloqueio de porta precisa ser persistido");
  assert(blockedBranch.indexOf("return;") === -1, "porta bloqueada por não-célula não pode abortar antes do respawn");
}
assert(
  src.includes("scheduleRespawn(idx, ownerLooksBlockedNotCell ? 'port_blocked_not_cell' : 'worker_drop', 2000);"),
  "drop com porta bloqueada por processo estranho precisa reentrar no respawn"
);

console.log("ALL_OK");
process.exit(0);
