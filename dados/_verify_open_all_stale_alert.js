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
const apiPerfis = fs.readFileSync(path.join(ROOT, "scripts", "api_perfis.js"), "utf8");
const openAllFn = apiPerfis.split("app.post('/api/perfis/open-all-24h'")[1] || "";
assert.ok(
  openAllFn.indexOf("clearHumanHold") >= 0 &&
    openAllFn.indexOf("clearHumanHold") < openAllFn.indexOf("ensureCellsRunning('open_all_24h')"),
  "Abrir Tudo destrava Encerrar antes de renascer célula"
);
const stopFn = apiSys.split("app.post('/api/cells/stop'")[1] || "";
assert.ok(stopFn.indexOf("setHumanHold") >= 0 && stopFn.indexOf("setHumanHold") < stopFn.indexOf("stopAllCells"), "Encerrar trava antes de matar");
assert.ok(stopFn.indexOf("resetDesiredAllOffOnBoot") >= 0 && stopFn.indexOf("resetDesiredAllOffOnBoot") < stopFn.indexOf("stopAllCells"), "Encerrar cancela Abrir Tudo antes de matar");
assert.ok(!/await workerClient\.kill/.test(stopFn), "Encerrar não pode matar o index duas vezes via kill()+stopAll");
assert.ok(html.includes("Encerrando workers..."), "botão Encerrar precisa mostrar Encerrando workers");

const indexJs = fs.readFileSync(path.join(ROOT, "index.js"), "utf8");
assert.ok(indexJs.includes("holdStopWorkers") && indexJs.includes("boot_hold_stop_workers"), "Iniciar com hold de Encerrar não adota leftover");
assert.ok(indexJs.includes("work.yes && !holdStopWorkers"), "Ctrl+C depois de Encerrar mata célula, não solta");

const life = fs.readFileSync(path.join(ROOT, "scripts", "cellLifecycle.js"), "utf8");
const killFn = life.split("function forceKillPid")[1] || "";
assert.ok(/taskkill\.exe/.test(killFn) && /\/PID/.test(killFn) && !/\/T/.test(killFn.split("function")[0] || killFn), "Encerrar mata a célula sem /T (árvore do Chrome)");
const cluster = fs.readFileSync(path.join(ROOT, "scripts", "clusterMaster.js"), "utf8");
const begin = cluster.split("function beginStop")[1] || "";
assert.ok(/deadHandled = true/.test(begin.slice(0, 500)), "beginStop marca célula morta pra não readotar");
assert.ok(/if \(isShuttingDown\) \{\s*child\.deadHandled = true/.test(cluster), "drop durante Encerrar não readota porta");
assert.ok(/listCellEntryPids/.test(life) && /cellentry\.js/.test(life), "Encerrar mata pelo cellEntry.js, não só pela porta");
assert.ok(/!recycledThisBoot && !cellLifecycle\.isStampStale\(\)/.test(cluster), "git pull nunca adota célula velha");
assert.ok(/mustDie/.test(life) && /listCellEntryPids/.test(life), "atualização e Encerrar insistem até a célula morrer");
assert.ok(/isSkippableListenPid/.test(life) && /terminateCellEntriesByCmd/.test(life), "Encerrar não trata porta do index como célula");
assert.ok(/reg\.cells = \[\]/.test(life), "Encerrar zera o registry; não grava leftover fantasma como 4/4");
assert.ok(/isProvenCellEntryPid/.test(life) && /listListenOwners/.test(life), "Encerrar identifica célula por cellEntry.js, não por LISTEN solto");
assert.ok(/const ok = entryLeft\.length === 0/.test(life), "Encerrar ok se não sobrou célula viva");
assert.ok(/listLiveCellPids/.test(life) && /wantedCellCount/.test(life), "conta célula viva e o plano 4, não 1/1");
assert.ok(/neutralizeWorkerStatusJournals/.test(life), "Encerrar apaga journal ativo para o painel não mentir");
assert.ok(/human_hold_stop_workers/.test(cluster), "ensure não renasce célula depois do Encerrar");
assert.ok(/isProvenCellEntryPid\(owner\)/.test(cluster), "não adota LISTEN que não é cellEntry");
assert.ok(/cell_port_relocated/.test(cluster) && /findFreePort/.test(cluster), "porta bloqueada troca de porta, não mata o slot");
assert.ok(/reapForeignCellEntries/.test(cluster) && /reapForeignCellEntries/.test(life), "boot mata cellEntry que não é do plano");
assert.ok(/leftoverCell/.test(cluster), "não troca de porta se a ocupante ainda é célula");
assert.ok(apiSys.includes("listLiveCellPids") && apiSys.includes("want"), "GET /api/cells manda alive e want");
assert.ok(html.includes("cells.want") && html.includes("ownerLines"), "painel mostra vivo/plano e dono no Encerrar");

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
