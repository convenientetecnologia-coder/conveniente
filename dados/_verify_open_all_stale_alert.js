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
assert.ok(
  fileStoreSrc.includes("desired._autoOpen") && fileStoreSrc.includes("enabled: false"),
  "resetDesired precisa desligar Tudo aberto"
);

const apiSys = fs.readFileSync(path.join(ROOT, "scripts", "api_sys.js"), "utf8");
const stopFn = apiSys.split("app.post('/api/cells/stop'")[1] || "";
assert.ok(stopFn.indexOf("setHumanHold") >= 0 && stopFn.indexOf("setHumanHold") < stopFn.indexOf("stopAllCells"), "Encerrar trava antes de matar");
assert.ok(stopFn.indexOf("resetDesiredAllOffOnBoot") >= 0 && stopFn.indexOf("resetDesiredAllOffOnBoot") < stopFn.indexOf("stopAllCells"), "Encerrar cancela Abrir Tudo antes de matar");
assert.ok(!/await workerClient\.kill/.test(stopFn), "Encerrar não pode matar o index duas vezes via kill()+stopAll");
assert.ok(html.includes("Encerrando workers..."), "botão Encerrar precisa mostrar Encerrando workers");

const indexJs = fs.readFileSync(path.join(ROOT, "index.js"), "utf8");
assert.ok(indexJs.includes("holdStopWorkers") && indexJs.includes("boot_hold_stop_workers"), "Iniciar com hold de Encerrar não adota leftover");
assert.ok(indexJs.includes("work.yes && !holdStopWorkers"), "Ctrl+C depois de Encerrar mata célula, não solta");

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
