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
  /if \(fb\.ageMs > MAX_FILE_AGE_MS\) \{\s*if \(liveChild\)/.test(src),
  "warning partial deve ficar só para child vivo stale"
);

console.log("ALL_OK");
process.exit(0);
