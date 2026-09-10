"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const html = fs.readFileSync(path.join(ROOT, "public", "index.html"), "utf8");
const fileStoreSrc = fs.readFileSync(path.join(ROOT, "scripts", "fileStore.js"), "utf8");
const fileStore = require(path.join(ROOT, "scripts", "fileStore.js"));

assert.strictEqual(
  html.includes("alert(`Abrir Todos concluído"),
  false,
  "dashboard não pode mais disparar alert nativo do Abrir Todos parcial"
);
assert.ok(
  html.includes("window.__openAllWatchedThisPage"),
  "dashboard precisa exigir que esta aba tenha visto o job ativo"
);
assert.ok(
  html.includes("NUNCA alert() de job antigo"),
  "comentário de contrato do stale alert ausente"
);
assert.ok(
  fileStoreSrc.includes("neutralizeOpenAllAfterBoot"),
  "boot precisa neutralizar cadáver de _openAll"
);
assert.ok(
  fileStoreSrc.includes("desired._openAll = neutralizeOpenAllAfterBoot"),
  "resetDesiredAllOffOnBoot precisa chamar neutralizeOpenAllAfterBoot"
);

const now = 1_700_000_000_000;
const active = fileStore.neutralizeOpenAllAfterBoot(
  { active: true, lastError: null, queue: ["a"] },
  { nowMs: now }
);
assert.strictEqual(active.active, false);
assert.strictEqual(active.lastError, "boot_reset");
assert.strictEqual(active.doneAt, now);

const stale = fileStore.neutralizeOpenAllAfterBoot(
  {
    active: false,
    lastError: "partial_ram",
    partial: true,
    partialOpened: 12,
    partialTotal: 56,
    doneAt: now - 86_400_000
  },
  { nowMs: now }
);
assert.strictEqual(stale.active, false);
assert.strictEqual(stale.lastError, null);
assert.strictEqual(stale.partial, false);
assert.strictEqual(stale.partialOpened, 12);
assert.strictEqual(stale.partialTotal, 56);

const clean = fileStore.neutralizeOpenAllAfterBoot(
  { active: false, lastError: null },
  { nowMs: now }
);
assert.strictEqual(clean.lastError, null);
assert.strictEqual(fileStore.neutralizeOpenAllAfterBoot(null, { nowMs: now }), null);

console.log("ok _verify_open_all_stale_alert");
