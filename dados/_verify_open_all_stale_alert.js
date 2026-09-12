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
assert.ok(indexJs.includes("bootSrc === 'porteiro'") && indexJs.includes("maybePorterOpenAllOnBoot"), "porteiro no ciclo pergunta Abrir Tudo mesmo adotando célula");
const bootIntent = require(path.join(ROOT, "scripts", "bootIntent.js"));
assert.strictEqual(
  bootIntent.decideAutoOpenAll({
    bootSource: "porteiro",
    allCellsDead: false,
    humanHoldActive: false,
    workCycle: { inWorkCycle: true }
  }).yes,
  true,
  "porteiro no ciclo abre tudo mesmo com célula viva"
);
assert.strictEqual(
  bootIntent.decideAutoOpenAll({
    bootSource: "porteiro",
    allCellsDead: true,
    humanHoldActive: true,
    holdReason: "stop_workers",
    workCycle: { inWorkCycle: true }
  }).yes,
  false,
  "Encerrar workers barra Abrir Tudo do porteiro"
);
assert.strictEqual(
  bootIntent.decideAutoOpenAll({
    bootSource: "iniciar",
    allCellsDead: true,
    workCycle: { inWorkCycle: true }
  }).yes,
  false,
  "clique Iniciar não dispara Abrir Tudo"
);
assert.ok(indexJs.includes("work.yes && !holdStopWorkers"), "Ctrl+C depois de Encerrar mata célula, não solta");

const life = fs.readFileSync(path.join(ROOT, "scripts", "cellLifecycle.js"), "utf8");
const killFn = life.split("function forceKillPid")[1] || "";
assert.ok(/taskkill\.exe/.test(killFn) && /\/PID/.test(killFn) && /pidExistsOnSystem/.test(life), "Encerrar só conta PID que o tasklist ainda vê");
const stopFnLife = life.split("function stopAllCells")[1] || "";
assert.ok(
  stopFnLife.indexOf("taskkillPids(pids") >= 0 &&
    stopFnLife.indexOf("taskkillPids(pids") < stopFnLife.indexOf("reapAllConvenienteChrome"),
  "Encerrar/stamp mata a árvore da célula em lote ANTES do Chrome leftover"
);
assert.ok(!/for \(const pid of pids\) forceKillPid/.test(life), "Encerrar não mata PID um a um");
assert.ok(life.includes("function taskkillPids") && /\/T/.test(life.split("function taskkillPids")[1] || ""), "taskkill em lote com árvore /T");
assert.ok(indexJs.includes("wipeStaleCellsBeforeListen") && indexJs.indexOf("function wipeStaleCellsBeforeListen") < indexJs.indexOf("app.listen"), "código novo mata célula antes do painel");
assert.ok(!indexJs.includes("reciclando células depois do painel"), "Iniciar não espera o painel para matar célula velha");
const iniciarPs1 = fs.readFileSync(path.join(ROOT, "scripts", "iniciarSistema.ps1"), "utf8");
assert.ok(iniciarPs1.includes("cells_hard_stop before_launch") && iniciarPs1.includes("Stop-ConvenienteCells 'iniciar_stamp'"), "Iniciar com stamp mata célula antes de lançar o index");
assert.ok(iniciarPs1.includes("Invoke-ConvenienteCellCli 'stop' $Reason"), "CLI de stop recebe o motivo (iniciar_stamp)");
const reaper = fs.readFileSync(path.join(ROOT, "scripts", "orphanReaper.js"), "utf8");
assert.ok(reaper.includes("function taskkillPids") && /for \(const pid of toKill\)/.test(reaper) === false, "Chrome leftover morre em um taskkill, não um a um");
const cluster = fs.readFileSync(path.join(ROOT, "scripts", "clusterMaster.js"), "utf8");
const halt = cluster.split("function haltRespawn")[1] || cluster.split("function beginStop")[1] || "";
assert.ok(/deadHandled = true/.test(halt.slice(0, 500)), "haltRespawn marca célula morta pra não readotar");
assert.ok(/if \(isShuttingDown \|\| cellLifecycle\.isCellsStopped\(\)\) \{\s*child\.deadHandled = true/.test(cluster), "drop durante Encerrar não readota porta");
assert.ok(/listCellEntryPids/.test(life) && /cellentry\.js/.test(life), "Encerrar mata pelo cellEntry.js, não só pela porta");
assert.ok(/!recycledThisBoot && !cellLifecycle\.isStampStale\(\)/.test(cluster), "git pull nunca adota célula velha");
assert.ok(/mustDie/.test(life) && /listCellEntryPids/.test(life), "atualização e Encerrar insistem até a célula morrer");
assert.ok(/isSkippableListenPid/.test(life) && /terminateCellEntriesByCmd/.test(life), "Encerrar não trata porta do index como célula");
assert.ok(/reg\.cells = \[\]/.test(life), "Encerrar zera o registry; não grava leftover fantasma como 4/4");
assert.ok(/isProvenCellEntryPid/.test(life) && /listListenOwners/.test(life), "Encerrar identifica célula por cellEntry.js, não por LISTEN solto");
assert.ok(/const ok = entryLeft\.length === 0/.test(life), "Encerrar ok se não sobrou célula viva");
assert.ok(/listLiveCellPids/.test(life) && /wantedCellCount/.test(life), "conta célula viva e o plano 4, não 1/1");
assert.ok(/neutralizeWorkerStatusJournals/.test(life), "Encerrar apaga journal ativo para o painel não mentir");
assert.ok(/cells_stopped/.test(cluster) && /isCellsStopped/.test(cluster), "ensure não renasce célula depois do Encerrar");
assert.ok(/haltRespawn/.test(cluster) && /resumeAfterStop/.test(cluster), "Encerrar trava respawn; Abrir Tudo destrava sem matar o watcher");
assert.ok(indexJs.includes("haltRespawn:") && apiSys.includes("haltRespawn"), "Encerrar precisa alcançar o cluster — apiClient.haltRespawn");
assert.ok(life.includes("function setCellsStopped") && life.includes("function isCellsStopped"), "latch de Encerrar no processo do index");
assert.ok(fileStoreSrc.includes("_cellsStopped") && fileStoreSrc.includes("resumeCells"), "desired não religa conta depois do Encerrar sem resumeCells");
assert.ok(fileStoreSrc.includes("_encerrarGen"), "geração do Encerrar ganha corrida do Abrir Tudo");
assert.ok(openAllFn.includes("cancelled_by_encerrar") && openAllFn.includes("resumeCells: true"), "Abrir Tudo aborta se Encerrar ganhou e só escreve desired com resume");
assert.ok(openAllFn.includes("human_hold_stop_workers"), "porteiro/agenda não desfaz Encerrar");
assert.ok(stopFn.includes("setCellsStopped(true)") && stopFn.includes("api_cells_stop_reap"), "Encerrar trava, mata, reescreve desired e reap da corrida");
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
