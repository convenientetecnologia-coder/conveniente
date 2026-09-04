"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");

function section(source, start, end, label) {
  const a = source.indexOf(start);
  assert(a >= 0, `${label}: início ausente`);
  const b = source.indexOf(end, a + start.length);
  assert(b > a, `${label}: fim ausente`);
  return source.slice(a, b);
}

function assertOrdered(source, first, second, label) {
  const a = source.indexOf(first);
  const b = source.indexOf(second);
  assert(a >= 0, `${label}: primeiro marcador ausente`);
  assert(b >= 0, `${label}: segundo marcador ausente`);
  assert(a < b, `${label}: ordem inválida`);
}

const serverConfig = require(path.join(ROOT, "scripts", "serverConfig.js"));

// Schema/default/clamp/validação sem escrever no arquivo real.
assert.strictEqual(serverConfig.DEFAULTS.memory.workerRamDivisorGb, 16);
assert.strictEqual(
  serverConfig.validateServerConfigPayload({ memory: { workerRamDivisorGb: 8 } }).normalized.memory.workerRamDivisorGb,
  8
);
assert.strictEqual(
  serverConfig.validateServerConfigPayload({ memory: { workerRamDivisorGb: 1 } }).normalized.memory.workerRamDivisorGb,
  4
);
assert.strictEqual(
  serverConfig.validateServerConfigPayload({ memory: { workerRamDivisorGb: 99 } }).normalized.memory.workerRamDivisorGb,
  32
);
const invalid = serverConfig.validateServerConfigPayload({ memory: { workerRamDivisorGb: "x" } });
assert.strictEqual(invalid.ok, false);
assert((invalid.details || []).includes("memory.workerRamDivisorGb_invalido"));
const decimal = serverConfig.validateServerConfigPayload({ memory: { workerRamDivisorGb: 8.5 } });
assert.strictEqual(decimal.ok, false);
assert((decimal.details || []).includes("memory.workerRamDivisorGb_deve_ser_inteiro"));

const memoryPlan = require(path.join(ROOT, "scripts", "memoryPlan.js"));
assert.strictEqual(memoryPlan.calcWorkerNodes({ totalMB: 32768, divisorGb: 32, totalProfiles: 10 }), 1);
assert.strictEqual(memoryPlan.calcWorkerNodes({ totalMB: 32768, divisorGb: 32, totalProfiles: 50 }), 1);
assert.strictEqual(memoryPlan.calcWorkerNodes({ totalMB: 32768, divisorGb: 32, totalProfiles: 200 }), 1);
assert.strictEqual(memoryPlan.calcWorkerNodes({ totalMB: 65536, divisorGb: 32, totalProfiles: 80 }), 2);
assert.strictEqual(memoryPlan.calcWorkerNodes({ totalMB: 32768, divisorGb: 4, totalProfiles: 8 }), 8);
assert.strictEqual(memoryPlan.calcWorkerNodes({ totalMB: 32768, divisorGb: 4, totalProfiles: 6 }), 6);
assert.strictEqual(memoryPlan.calcWorkerNodes({ totalMB: 32768, divisorGb: 4, totalProfiles: 80 }), 8);
assert.strictEqual(memoryPlan.calcWorkerNodes({ totalMB: 32768, divisorGb: 8, totalProfiles: 60 }), 4);
assert.strictEqual(memoryPlan.calcWorkerNodes({ totalMB: 32768, divisorGb: 8, totalProfiles: 0 }), 1);
assert.strictEqual(memoryPlan.calcLiveDesiredWorkerNodes({ totalMB: 32768, divisorGb: 16, totalProfiles: 5 }), 2);
assert.strictEqual(memoryPlan.calcLiveDesiredWorkerNodes({ totalMB: 32768, divisorGb: 8, totalProfiles: 5 }), 4);
assert.strictEqual(memoryPlan.calcLiveDesiredWorkerNodes({ totalMB: 32768, divisorGb: 8, totalProfiles: 51 }), 4);
{
  const g = memoryPlan.planStickyGrow({
    currentShards: [["a"], ["b"], ["c"]],
    namesNow: ["a", "b", "c", "d"],
    desiredNodes: 4
  });
  assert.strictEqual(g.growTo, 4);
  assert.deepStrictEqual(g.newWorkerIndexes, [3]);
  assert.deepStrictEqual(g.nextShards[3], ["d"]);
  assert.deepStrictEqual(g.nextShards.slice(0, 3), [["a"], ["b"], ["c"]]);
}
{
  const g = memoryPlan.planStickyGrow({
    currentShards: [["a"], ["b"], ["c"], ["d"]],
    namesNow: ["a", "b", "c", "d", "e"],
    desiredNodes: 4
  });
  assert.strictEqual(g.grew, false);
  assert.strictEqual(g.nextShards[0].includes("e"), true);
  assert.deepStrictEqual(g.nextShards.slice(1), [["b"], ["c"], ["d"]]);
}
{
  const g = memoryPlan.planStickyGrow({
    currentShards: [["a"], ["b"], ["c"]],
    namesNow: ["a", "b", "c", "d", "e", "f"],
    desiredNodes: 6
  });
  assert.deepStrictEqual(g.newWorkerIndexes, [3, 4, 5]);
  assert.deepStrictEqual(g.nextShards, [["a"], ["b"], ["c"], ["d"], ["e"], ["f"]]);
}
{
  const g = memoryPlan.planStickyGrow({
    currentShards: [["a"], ["b"], ["c"], ["d"], [], []],
    namesNow: ["a", "b", "c", "d", "e"],
    desiredNodes: 5
  });
  assert.strictEqual(g.grew, false);
  assert.strictEqual(g.nextShards.length, 6);
  assert.deepStrictEqual(g.nextShards[4], ["e"]);
  assert.deepStrictEqual(g.nextShards[5], []);
}
{
  const g = memoryPlan.planStickyGrow({
    currentShards: [["a"], ["b"]],
    namesNow: ["a", "b", "c"],
    desiredNodes: 2
  });
  assert.strictEqual(g.grew, false);
  assert.strictEqual(g.nextShards[0].includes("c"), true);
}
{
  const ten = (prefix) => Array.from({ length: 10 }, (_, i) => `${prefix}${i}`);
  const g = memoryPlan.planStickyGrow({
    currentShards: [ten("a"), ten("b"), ten("c"), ten("d"), ten("e")],
    namesNow: [...ten("a"), ...ten("b"), ...ten("c"), ...ten("d"), ...ten("e"), "nova"],
    desiredNodes: 6
  });
  assert.deepStrictEqual(g.newWorkerIndexes, [5]);
  assert.deepStrictEqual(g.nextShards[5], ["nova"]);
  assert.strictEqual(g.nextShards[0].length, 10);
}
{
  const names = Array.from({ length: 51 }, (_, i) => `c${String(i).padStart(2, "0")}`);
  const fair = memoryPlan.planFairReshuffle({ names, nodes: 6 });
  assert.strictEqual(fair.accounts, 51);
  assert.strictEqual(fair.nodes, 6);
  assert.deepStrictEqual(fair.nextShards.map((s) => s.length), [9, 9, 9, 8, 8, 8]);
}
assert.deepStrictEqual(
  [0, 1, 2, 3, 4, 5, 6, 7].map((i) => Math.floor(80 / 8) + (i < (80 % 8) ? 1 : 0)),
  [10, 10, 10, 10, 10, 10, 10, 10]
);

// memoryPlan deve ler o mesmo campo efetivo; capacidade alta NÃO reduz Workers.
const originalReadEffective = serverConfig.readServerConfigEffective;
try {
  serverConfig.readServerConfigEffective = () => ({
    memory: { workerRamDivisorGb: 8 },
    capacity: { mode: "absolute", maxAccountsEffective: 1000 }
  });
  const plan8 = memoryPlan.planMemoryAndShards({ totalProfiles: 1000 });
  const expected8 = Math.max(1, Math.ceil(plan8.totalMB / (8 * 1024)));
  assert.strictEqual(plan8.nodes, expected8);
  assert.strictEqual(plan8.serverConfig.workerRamDivisorGb, 8);
  assert.strictEqual(plan8.budgets.nodeSegmentMB, 8 * 1024);

  serverConfig.readServerConfigEffective = () => ({
    memory: { workerRamDivisorGb: 16 },
    capacity: { mode: "absolute", maxAccountsEffective: 1000 }
  });
  const plan16 = memoryPlan.planMemoryAndShards({ totalProfiles: 1000 });
  const expected16 = Math.max(1, Math.ceil(plan16.totalMB / (16 * 1024)));
  assert.strictEqual(plan16.nodes, expected16);
  assert.strictEqual(plan16.serverConfig.workerRamDivisorGb, 16);
  assert.strictEqual(plan16.budgets.nodeSegmentMB, 16 * 1024);

  serverConfig.readServerConfigEffective = () => ({
    memory: { workerRamDivisorGb: 8 },
    capacity: { mode: "absolute", maxAccountsEffective: 1000 }
  });
  const planFew = memoryPlan.planMemoryAndShards({ totalProfiles: 1 });
  assert.strictEqual(planFew.nodes, 1);
  assert.ok(planFew.serverConfig.hardwareNodes >= 1);
} finally {
  serverConfig.readServerConfigEffective = originalReadEffective;
}

// ramPolicy aceita a mesma configuração, inclusive nos limites.
const ramPolicy = require(path.join(ROOT, "scripts", "ramPolicy.js"));
assert.strictEqual(ramPolicy.calcNodesByTotalMemMB(24 * 1024, { workerRamDivisorGb: 8 }), 3);
assert.strictEqual(ramPolicy.calcNodesByTotalMemMB(24 * 1024, { workerRamDivisorGb: 16 }), 2);
assert.strictEqual(ramPolicy.getWorkerRamDivisorGB({ workerRamDivisorGb: 1 }), 4);
assert.strictEqual(ramPolicy.getWorkerRamDivisorGB({ workerRamDivisorGb: 99 }), 32);

const worker = read("scripts/worker.js");
const wsClosed = section(
  worker,
  "const onWsClosed = (event) => {",
  "const onResponseReceived = async (event) => {",
  "onWsClosed"
);
assert(wsClosed.includes("wsState.byId.delete(requestId);"));
assert(wsClosed.includes("wsState.heartbeatBySocket.delete(requestId);"));

const tracing = section(
  worker,
  "async function collectChromePidsViaTracing",
  "async function getControllerPidsCached",
  "collectChromePidsViaTracing"
);
assert(tracing.includes("finally {"));
assert(tracing.includes("await chromeHeapFaxina.detachCdpSession(session)"));

const detach = section(
  worker,
  "async function __deltaDetachCdpSession",
  "async function __deltaAttachCdpEar",
  "__deltaDetachCdpSession"
);
assertOrdered(
  detach,
  "await chromeHeapFaxina.detachCdpSession(s)",
  "ctrl.deltaCdpSession = null",
  "detach antes de null"
);
assert(detach.includes("if (expectedCtrl && ctrl !== expectedCtrl) return false;"));
assert(detach.includes("if (s && ctrl.deltaCdpSession !== s) return false;"));

const attach = section(
  worker,
  "async function __deltaAttachCdpEar",
  "async function wirePageObservers",
  "__deltaAttachCdpEar"
);
assertOrdered(
  attach,
  "await __deltaDetachCdpSession(nome, {",
  "cdp = await page.target().createCDPSession()",
  "detach antes de re-attach"
);
assert(attach.includes("await chromeHeapFaxina.detachCdpSession(cdp)"));
assert(attach.includes("deltaCdpAttachGeneration"));
assert(attach.includes("preserveAttachGeneration: true"));

const browserDisconnected = section(
  worker,
  "browser.once('disconnected', async () => {",
  "async function tryReconnectAfterDisconnected",
  "browser disconnected"
);
assertOrdered(
  browserDisconnected,
  "await __deltaDetachCdpSession(nome, { expectedCtrl: ctrl })",
  "controllers.delete(nome)",
  "disconnect limpa CDP antes de remover controller"
);
assert(browserDisconnected.includes("if (controllers.get(nome) !== ctrl)"));

const hardClose = section(
  worker,
  "async function hardCloseController",
  "async function killStrayChromes",
  "hardCloseController"
);
assert(hardClose.includes("await __deltaDetachCdpSession(nome, { expectedCtrl: ctrl })"));

const shutdown = section(
  worker,
  "async function gracefulShutdown",
  "process.on('SIGTERM'",
  "gracefulShutdown"
);
assert(shutdown.includes("__deltaDetachCdpSession(nome, { expectedCtrl: ctrl })"));
assert(shutdown.includes("Promise.allSettled"));
assert(shutdown.includes("WORKER_SHUTDOWN_FAILSAFE_MS"));

const ui = read("public/index.html");
assert(ui.includes('id="srvMemWorkerDivisor" min="4" max="32" step="1"'));
assert(ui.includes("workerRamDivisorGb,"));
assert(ui.includes("Salvar já vale para a próxima conta nova"));
assert(ui.includes("redistribui todas as contas iguais"));
assert(!ui.includes("nodesByProfiles"));
assert(ui.includes("workerRamDivisorChanged"));
assert(ui.includes("workerDivisorSupported"));
assert(ui.includes("partialFailure"));
const inlineScriptMatch = ui.match(/<script>\s*([\s\S]*?)\s*<\/script>/);
assert(inlineScriptMatch && inlineScriptMatch[1], "script inline do painel ausente");
new Function(inlineScriptMatch[1]);

const api = read("scripts/api_perfis.js");
assert(api.includes("workerRamDivisorChanged"));
assert(api.includes("workerTopologyRestartRequired"));
assert(api.includes("next_index_restart"));
assert(api.includes("...postWriteMeta"));
assert(api.includes("workerClient.rebalance('api_perfis_create:'"));
assert(api.includes("clusterGrowQueued"));
assert(api.includes("setImmediate"));
assert(api.includes("reshuffleFairIfIdle('open_all_24h')"));

const cluster = read("scripts/clusterMaster.js");
assert(cluster.includes("workerRamDivisorGb: plan.serverConfig.workerRamDivisorGb"));
assert(cluster.includes("hardwareNodes: plan.serverConfig.hardwareNodes"));
assert(cluster.includes("nodeSegmentMB: plan.budgets.nodeSegmentMB"));
assert(cluster.includes("planStickyGrow"));
assert(cluster.includes("calcLiveDesiredWorkerNodes"));
assert(cluster.includes("liveDivisorGb"));
assert(cluster.includes("bootHardwareNodes"));
assert(cluster.includes("reshuffleFairIfIdle"));
assert(cluster.includes("fair_reshuffle"));
assert(worker.includes("shard-busy-count"));
assert(cluster.includes("Worker nascido ao vivo"));
assert(cluster.includes("rebalanceTail"));

assert(worker.includes("WORKER_SHARD_INDEX"));
assert(worker.includes("Worker de cluster com shard vazio não é dono de conta nenhuma."));

const liveConfig = JSON.parse(read("dados/server_runtime_config.json"));
assert.strictEqual(liveConfig.memory.workerRamDivisorGb, 16);

async function runAsyncCdpContracts() {
  const chromeHeapFaxina = require(path.join(ROOT, "scripts", "chromeHeapFaxina.js"));

  // Um CDP nativo travado não pode bloquear indefinidamente o chamador.
  const timeoutStartedAt = Date.now();
  await chromeHeapFaxina.detachCdpSession(
    { detach: () => new Promise(() => {}) },
    { timeoutMs: 50 }
  );
  const timeoutElapsedMs = Date.now() - timeoutStartedAt;
  assert(timeoutElapsedMs >= 40 && timeoutElapsedMs < 500, `timeout detach inválido: ${timeoutElapsedMs}ms`);

  // Executa a função real isoladamente para provar CAS e identidade de controller.
  const detachSource = detach.trim();
  const controllers = new Map();
  const isolatedDetach = new Function(
    "controllers",
    "chromeHeapFaxina",
    `return (${detachSource});`
  )(controllers, chromeHeapFaxina);

  let resolveOldDetach;
  const oldSession = {
    removeListener() {},
    detach: () => new Promise((resolve) => { resolveOldDetach = resolve; })
  };
  const newSession = { removeListener() {}, detach: async () => {} };
  const newFrameHandler = () => {};
  const ctrl = {
    deltaCdpSession: oldSession,
    deltaCdpOnFrame: () => {},
    deltaCdpOnWsCreated: () => {},
    deltaCdpOnWsHandshakeReq: () => {},
    deltaCdpOnWsHandshakeRes: () => {},
    deltaCdpOnWsClosed: () => {},
    deltaCdpOnResponseReceived: () => {},
    deltaCdpEarPage: { __deltaCdpEarAttached: true },
    deltaWsRouteState: { byId: new Map() }
  };
  controllers.set("race", ctrl);
  const detachRace = isolatedDetach("race", { expectedCtrl: ctrl });
  await new Promise((resolve) => setTimeout(resolve, 10));
  ctrl.deltaCdpSession = newSession;
  ctrl.deltaCdpOnFrame = newFrameHandler;
  resolveOldDetach();
  const raceResult = await detachRace;
  assert.strictEqual(raceResult, false);
  assert.strictEqual(ctrl.deltaCdpSession, newSession);
  assert.strictEqual(ctrl.deltaCdpOnFrame, newFrameHandler);

  const foreignCtrl = { deltaCdpSession: newSession };
  controllers.set("race", foreignCtrl);
  const staleResult = await isolatedDetach("race", { expectedCtrl: ctrl });
  assert.strictEqual(staleResult, false);
  assert.strictEqual(foreignCtrl.deltaCdpSession, newSession);

  const ownPage = { __deltaCdpEarAttached: true };
  const ownSession = { removeListener() {}, detach: async () => {} };
  const ownCtrl = {
    deltaCdpSession: ownSession,
    deltaCdpOnFrame: () => {},
    deltaCdpEarPage: ownPage,
    deltaWsRouteState: { byId: new Map() }
  };
  controllers.set("owned", ownCtrl);
  const ownResult = await isolatedDetach("owned", {
    expectedCtrl: ownCtrl,
    expectedSession: ownSession
  });
  assert.strictEqual(ownResult, true);
  assert.strictEqual(ownCtrl.deltaCdpSession, null);
  assert.strictEqual(ownCtrl.deltaCdpOnFrame, null);
  assert.strictEqual(ownCtrl.deltaWsRouteState, null);
  assert.strictEqual(ownPage.__deltaCdpEarAttached, false);
  assert.strictEqual(ownCtrl.deltaCdpAttachGeneration, 1);

  return { timeoutElapsedMs };
}

runAsyncCdpContracts()
  .then(({ timeoutElapsedMs }) => {
    console.log(JSON.stringify({
      ok: true,
      contracts: {
        wsClosedMapCleanup: true,
        tracingFinallyDetach: true,
        boundedDetachMsObserved: timeoutElapsedMs,
        detachIdentityAndCas: true,
        reattachGenerationGuard: true,
        browserDisconnectDetaches: true,
        hardCloseDetaches: true,
        shutdownDetaches: true,
        divisorClamp: [4, 32],
        divisorDefault: 16,
        divisorIntegerOnly: true,
        apply: "next_index_restart"
      }
    }, null, 2));
  })
  .catch((err) => {
    console.error(err && err.stack ? err.stack : err);
    process.exitCode = 1;
  });
