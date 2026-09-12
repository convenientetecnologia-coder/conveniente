"use strict";

const assert = require("assert");
const path = require("path");
const life = require(path.join(__dirname, "..", "scripts", "cellLifecycle.js"));

assert.strictEqual(life.isSkippableListenPid(0), true);
assert.strictEqual(life.isSkippableListenPid(4), true);
assert.strictEqual(life.isSkippableListenPid(process.pid), true);
assert.strictEqual(life.isProvenCellEntryPid(1), false);
assert.strictEqual(life.isProvenCellEntryPid(process.pid), false);
assert.strictEqual(life.isLikelyCellListenPid(4), false);
assert.ok(typeof life.wantedCellCount === "function");
assert.ok(life.wantedCellCount() >= 1);
assert.ok(typeof life.listLiveCellPids === "function");
assert.strictEqual(life.forceKillPid(0), false);
assert.strictEqual(life.forceKillPid(4), false);

const src = require("fs").readFileSync(path.join(__dirname, "..", "scripts", "cellLifecycle.js"), "utf8");
assert.ok(src.includes("flush()"), "parser WMIC junta ProcessId+CommandLine no mesmo bloco, não na linha seguinte");
assert.ok(/const ok = entryLeft\.length === 0/.test(src), "sucesso do Encerrar é zero cellEntry");

console.log("ok _verify_encerrar_cell_identity");
