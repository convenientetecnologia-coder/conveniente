// scripts/clusterMaster.js

const { fork } = require('child_process');
const path = require('path');
const fs = require('fs');
const { planMemoryAndShards, planStickyGrow, calcLiveDesiredWorkerNodes, planFairReshuffle } = require('./memoryPlan.js');
const fileStore = require('./fileStore.js');
const logger = require('./logger.js');
const supervisor = require('./supervisor.js');
const provisionLock = require('./provisionLock.js');
const chromeMemorySweep = require('./chromeMemorySweep.js');

function newMsgId() { return Math.random().toString(36).slice(2); }

// NOVO: Algoritmo determinístico, justo, distribui round-robin lexicográfico.
// Balanceamento perfeito, diferença máxima 1 entre nodes.
function splitRoundRobinFair(names, blocks) {
  return planFairReshuffle({ names, nodes: Math.max(1, Number(blocks) || 1) }).nextShards;
}

// REMOVIDO splitInBlocks

function readNodeStatusFile(idx) {
  try {
    const file = path.join(__dirname, '..', 'dados', `status_node_${idx+1}.json`);
    if (!fs.existsSync(file)) return null;
    const stat = fs.statSync(file);
    const ageMs = Date.now() - stat.mtimeMs;
    const json = JSON.parse(fs.readFileSync(file, 'utf8'));
    return { json, ageMs };
  } catch { return null; }
}

const MAX_FILE_AGE_MS = parseInt(process.env.CLUSTER_STATUS_FILE_MAX_AGE_MS || '60000', 10);

function createCluster() {
  const allPerfis = fileStore.loadPerfisJson() || [];
  const names = allPerfis.map(p => p.nome);
  const plan = planMemoryAndShards({ totalProfiles: names.length });
  const blocks = splitRoundRobinFair(names, plan.nodes);

  logger.info('[CLUSTER][PLAN]', {
    totalMB: plan.totalMB,
    cushionMB: plan.cushionMB,
    usableMB: plan.usableMB,
    nodes: plan.nodes,
    hardwareNodes: plan.serverConfig.hardwareNodes,
    workerRamDivisorGb: plan.serverConfig.workerRamDivisorGb,
    nodeSegmentMB: plan.budgets.nodeSegmentMB,
    perNodeMax: plan.perNode.maxChromes,
    reservedForOverheadMB: plan.budgets.reservedForOverheadMB,
    remainingForChromesMB: plan.budgets.remainingForChromesMB,
    chromeAvgMB: plan.budgets.chromeAvgMB,
    totalProfiles: names.length,
    effectiveChromesCap: 'all'
  });

  const children = [];
  const route = {};
  let isShuttingDown = false;
  let standbySweep = null;
  let rebalanceTail = Promise.resolve();
  const bootHardwareNodes = Math.max(1, Number(plan.serverConfig && plan.serverConfig.hardwareNodes) || 1);
  const bootDivisorGb = Math.max(4, Number(plan.serverConfig && plan.serverConfig.workerRamDivisorGb) || 16);

  // Rebuild route from a block array (idx->name list)
  function routeRebuildFromBlocks(blocksArr) {
    for (let i = 0; i < blocksArr.length; i++) {
      for (const n of (blocksArr[i] || [])) route[n] = i;
    }
  }

  // ================= BEGIN PATCH: perfisWatcher handle ====================
  let perfisWatcher = null;
  // ================= END PATCH: perfisWatcher handle ======================

  function spawnWorker(idx, shardNames) {
    shardNames.forEach(n => (route[n] = idx));
    const env = { ...process.env };
    env.IS_WORKER_CHILD = '1';
    env.WORKER_SHARD_INDEX = String(idx);
    env.SHARD_PROFILES = JSON.stringify(shardNames);
    env.STATUS_FILE_NAME = `status_node_${idx + 1}.json`;
    // Blindagem city collector: 1 Chrome de raspagem por worker (sem Code 21 cross-kill).
    // Path dedicado — não compartilha userDataDir entre shards do mesmo host.
    env.VIRTUS_DELTA_CITY_COLLECTOR_USER_DATA_DIR = path.join(
      __dirname,
      '..',
      'dados',
      'city-collector-shards',
      `w${idx + 1}`
    );

    const execPath = process.env.npm_node_execpath || process.env.NODE || process.execPath;

    try {
      logger.info('[CLUSTER][SPAWN]', {
        worker: idx + 1,
        shardSize: Array.isArray(shardNames) ? shardNames.length : 0,
        cityCollectorUserDataDir: env.VIRTUS_DELTA_CITY_COLLECTOR_USER_DATA_DIR,
      });
    } catch {}

    const proc = fork(path.join(__dirname, 'worker.js'), [], {
      stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
      execPath,
      env
    });

    // ================== BEGIN PATCH: worker error+close handlers ================
    proc.on('error', (err) => {
      try { logger.error('[WORKER] erro no fork', { error: err && err.message || err }, err); } catch {}
    });
    proc.on('close', () => { /* noop para manter referência viva até exit resolver */ });
    // ================== END PATCH: worker error+close handlers ==================

    const pending = new Map();

    proc.on('message', (msg) => {
      if (msg && msg.replyTo && pending.has(msg.replyTo)) {
        const { resolve } = pending.get(msg.replyTo);
        pending.delete(msg.replyTo);
        return resolve(msg.data);
      }
      if (msg && msg.type === 'standby-sweep-idle-hint') {
        try {
          if (standbySweep && typeof standbySweep.idleHint === 'function') standbySweep.idleHint();
        } catch {}
        return;
      }
      // ===== perfis.json master-only writes (blindagem máxima) =====
      // Workers NÃO escrevem perfis.json; pedem mutação ao master via IPC.
      if (msg && msg.type === 'perfis:remove') {
        const nome = String((msg.payload && msg.payload.nome) || '').trim();
        const reason = String((msg.payload && msg.payload.reason) || 'worker_remove').slice(0, 180);
        const caller = String((msg.payload && msg.payload.caller) || `worker_${idx + 1}`).slice(0, 80);
        const r = fileStore.withPerfisFileLockUpdate((arr) => {
          return Array.isArray(arr) ? arr.filter(p => p && p.nome !== nome) : [];
        }, { caller, reason });
        return proc.send({ replyTo: msg.msgId, data: Object.assign({ ok: true, nome }, r) });
      }
      if (msg && msg.type === 'perfis:upsert') {
        const perfil = (msg.payload && typeof msg.payload.perfil === 'object') ? msg.payload.perfil : null;
        const nome = String(perfil && perfil.nome || '').trim();
        const reason = String((msg.payload && msg.payload.reason) || 'worker_upsert').slice(0, 180);
        const caller = String((msg.payload && msg.payload.caller) || `worker_${idx + 1}`).slice(0, 80);
        if (!perfil || !nome) return proc.send({ replyTo: msg.msgId, data: { ok: false, error: 'invalid_perfil' } });
        const r = fileStore.withPerfisFileLockUpdate((arr) => {
          const next = Array.isArray(arr) ? arr.slice() : [];
          const i = next.findIndex(p => p && p.nome === nome);
          if (i >= 0) next[i] = Object.assign({}, next[i], perfil);
          else next.push(Object.assign({}, perfil));
          return next;
        }, { caller, reason });
        return proc.send({ replyTo: msg.msgId, data: Object.assign({ ok: true, nome }, r) });
      }
      if (msg && msg.type === 'perfis:patch') {
        const nome = String((msg.payload && msg.payload.nome) || '').trim();
        const patch = (msg.payload && typeof msg.payload.patch === 'object') ? msg.payload.patch : null;
        const reason = String((msg.payload && msg.payload.reason) || 'worker_patch').slice(0, 180);
        const caller = String((msg.payload && msg.payload.caller) || `worker_${idx + 1}`).slice(0, 80);
        if (!nome || !patch) return proc.send({ replyTo: msg.msgId, data: { ok: false, error: 'invalid_args' } });
        const r = fileStore.withPerfisFileLockUpdate((arr) => {
          const next = Array.isArray(arr) ? arr.slice() : [];
          const i = next.findIndex(p => p && p.nome === nome);
          if (i >= 0) next[i] = Object.assign({}, next[i], patch);
          return next;
        }, { caller, reason });
        return proc.send({ replyTo: msg.msgId, data: Object.assign({ ok: true, nome }, r) });
      }
      if (msg && msg.type === 'sup:reqOpen') {
        const { perfil } = msg;
        const r = supervisor.requestOpen(perfil, (msg && msg.opts) || {});
        return proc.send({ replyTo: msg.msgId, data: r });
      }
      if (msg && msg.type === 'sup:reqPermit') {
        const kind = msg && msg.kind ? String(msg.kind) : '';
        const perfil = msg && msg.perfil ? String(msg.perfil) : '';
        const opts = (msg && msg.opts && typeof msg.opts === 'object') ? msg.opts : {};
        const r = supervisor.requestPermit({ kind, perfil, operator: opts.operator || '', ttlMs: opts.ttlMs });
        return proc.send({ replyTo: msg.msgId, data: r });
      }
      if (msg && msg.type === 'sup:notifyOpened') {
        const { perfil, result } = msg;
        const r = supervisor.notifyOpened(perfil, result);
        return proc.send({ replyTo: msg.msgId, data: r });
      }
      if (msg && msg.type === 'sup:releasePermit') {
        const token = msg && msg.token ? String(msg.token) : '';
        const opts = (msg && msg.opts && typeof msg.opts === 'object') ? msg.opts : {};
        const r = supervisor.releasePermit({ token, result: opts.result || null });
        return proc.send({ replyTo: msg.msgId, data: r });
      }
      if (msg && msg.type === 'sup:getStatus') {
        const r = supervisor.getStatus();
        return proc.send({ replyTo: msg.msgId, data: r });
      }
    });

    proc.on('exit', (code, signal) => {
      logger.warn('[CLUSTER] worker dropado', { idx, code, signal });
      try {
        require('./crashHammer.js').scheduleWorkerDrop({
          idx: idx + 1,
          code: code == null ? null : Number(code),
          signal: signal == null ? null : String(signal),
          workerPid: proc && proc.pid ? Number(proc.pid) : null,
          shard: (() => {
            try {
              const child = children[idx];
              if (child && child.shard) return child.shard.size;
            } catch {}
            return (blocks[idx] || []).length;
          })()
        });
      } catch {}
      // Resolver pendências do pending com erro
      for (const [msgId, { resolve }] of pending.entries()) {
        try { resolve({ ok: false, error: 'worker_died' }); } catch {}
      }
      pending.clear();
      // Respawn após 2000ms se não estiver em shutdown
      if (!isShuttingDown) {
        // Chrome do shard morto fica órfão (hardClose não rodou). Limpa SÓ este shard
        // antes do respawn, senão o worker novo abre em cima dos zumbis.
        try {
          const dyingShard = (() => {
            try {
              const child = children[idx];
              if (child && child.shard) return Array.from(child.shard);
            } catch {}
            return blocks[idx] || [];
          })();
          const reap = require('./orphanReaper.js').reapShard({
            names: dyingShard,
            shardIdx: idx,
            reason: 'worker_drop'
          });
          try {
            require('./indexLifecycle.js').append('worker_drop_reap', {
              idx: idx + 1,
              code: code == null ? null : Number(code),
              signal: signal == null ? null : String(signal),
              shard: dyingShard.length,
              killed: reap && reap.killed != null ? reap.killed : null
            });
          } catch {}
        } catch (e) {
          try { logger.warn('[CLUSTER] orphan reap falhou (best-effort)', { idx, error: e && e.message || e }); } catch {}
        }
        setTimeout(() => {
          if (isShuttingDown) return;
          try {
            logger.info('[CLUSTER] respawnando worker', { idx: idx + 1 });
            const child = children[idx];
            if (child) {
              const shardNames = Array.from(child.shard);
              const newWorker = spawnWorker(idx, shardNames);
              child.proc = newWorker.proc;
              child.pending = newWorker.pending;
            } else {
              const shardNames = blocks[idx] || [];
              const newWorker = spawnWorker(idx, shardNames);
              children.push({ id: idx, proc: newWorker.proc, pending: newWorker.pending, shard: new Set(shardNames) });
            }
          } catch (e) {
            logger.error('[CLUSTER] erro ao respawnar worker', { idx, error: e && e.message || e }, e);
          }
        }, 2000);
      }
    });

    return { proc, pending };
  }

  for (let idx = 0; idx < blocks.length; idx++) {
    const shardNames = blocks[idx] || [];
    const { proc, pending } = spawnWorker(idx, shardNames);
    children.push({ id: idx, proc, pending, shard: new Set(shardNames) });
    logger.info('[CLUSTER] Worker iniciado', { idx: idx + 1, perfis: shardNames.length });
  }

  logger.info('[CLUSTER][ROUTE]', {
    totalPerfis: names.length,
    nodes: blocks.length,
    assigned: Object.keys(route).length
  });

  try {
    const diskcleanOff = chromeMemorySweep.prodDiskCleanDisabled() || chromeMemorySweep.envDisabled();
    standbySweep = chromeMemorySweep.attachHostCoordinator({
      sendToAll: (type, payload, timeoutMs) => Promise.all(
        children.map((_, i) => sendTo(i, type, payload || {}, { timeoutMs: timeoutMs || 8000 }))
      ),
      shardCount: () => children.length,
      disabled: diskcleanOff
    });
    logger.info('[CLUSTER][STANDBY-SWEEP] diskclean_disabled', {
      disabled: diskcleanOff,
      reason: 'diskclean_off_keep_porteiro',
      minMs: chromeMemorySweep.MIN_INTERVAL_MS,
      timeoutMs: chromeMemorySweep.TIMEOUT_MS,
      settleMs: chromeMemorySweep.SETTLE_MS
    });
    try {
      require("./indexLifecycle").append("standby_sweep_on", {
        disabled: diskcleanOff,
        reason: 'diskclean_off_keep_porteiro',
        minMs: chromeMemorySweep.MIN_INTERVAL_MS,
        timeoutMs: chromeMemorySweep.TIMEOUT_MS,
        settleMs: chromeMemorySweep.SETTLE_MS
      });
    } catch {}
  } catch (e) {
    standbySweep = null;
    try { logger.warn('[CLUSTER][STANDBY-SWEEP] coordinator off', { error: e && e.message || e }); } catch {}
    try {
      require("./indexLifecycle").append("standby_sweep_off", {
        error: String((e && e.message) || e || "fail").slice(0, 180)
      });
    } catch {}
  }

  function findChildByPerfil(nome) {
    const i = route[nome];
    if (typeof i === 'number') return i;
    throw new Error('profile_not_assigned_to_any_worker:' + nome);
  }

  const STATUS_TIMEOUT_MS = parseInt(process.env.CLUSTER_STATUS_TIMEOUT_MS || '25000', 10);

  async function sendTo(idx, type, payload, { timeoutMs = 20000 } = {}) {
    const child = children[idx];
    if (!child) return { ok: false, error: 'child_not_found' };
    const msgId = newMsgId();
    const p = new Promise((resolve) => {
      child.pending.set(msgId, { resolve });
      try {
        child.proc.send({ type, payload, msgId });
      } catch (e) {
        child.pending.delete(msgId);
        resolve({ ok: false, error: 'send_failed' });
      }
      setTimeout(() => {
        if (child.pending.has(msgId)) {
          child.pending.delete(msgId);
          resolve({ ok: false, error: 'timeout' });
        }
      }, timeoutMs);
    });
    return p;
  }

  // -------- HOT REBALANCE/HOT WATCHING ---------

  function shardKey(names) {
    return (Array.isArray(names) ? names : [])
      .map((n) => String(n || '').trim())
      .filter(Boolean)
      .sort((a, b) => a.localeCompare(b, 'pt-BR', { sensitivity: 'base' }))
      .join('\n');
  }

  // Só manda set-shard onde a lista mudou. Worker novo já nasce com SHARD_PROFILES.
  async function applyShardsToWorkers(blocksArr, reason = 'rebalance') {
    logger.info('[CLUSTER][REB] applyShardsToWorkers', { reason, nodes: blocksArr.length, children: children.length });
    const tasks = [];
    for (let i = 0; i < children.length; i++) {
      const shardNames = Array.isArray(blocksArr[i]) ? blocksArr[i] : [];
      const prevNames = Array.from((children[i] && children[i].shard) ? children[i].shard : []);
      children[i].shard = new Set(shardNames);
      if (shardKey(prevNames) === shardKey(shardNames)) continue;
      tasks.push(sendTo(i, 'set-shard', { names: shardNames }, { timeoutMs: 20000 }));
    }
    if (tasks.length) await Promise.all(tasks);
    for (const k of Object.keys(route)) delete route[k];
    routeRebuildFromBlocks(blocksArr);
  }

  async function rebalanceOnce(reason = 'watcher') {
    if (isShuttingDown) return { ok: false, error: 'shutting_down' };
    const perfis = fileStore.loadPerfisJson() || [];
    const namesNow = perfis.map((p) => p && p.nome).filter(Boolean);
    const livePlan = planMemoryAndShards({ totalProfiles: namesNow.length });
    const desiredNodes = calcLiveDesiredWorkerNodes({
      totalMB: livePlan.totalMB,
      divisorGb: livePlan.serverConfig && livePlan.serverConfig.workerRamDivisorGb,
      totalProfiles: namesNow.length
    });
    const currentShards = children.map((ch) => Array.from((ch && ch.shard) ? ch.shard : []));
    const growPlan = planStickyGrow({
      currentShards,
      namesNow,
      desiredNodes
    });

    for (const idx of growPlan.newWorkerIndexes) {
      const shardNames = growPlan.nextShards[idx] || [];
      const { proc, pending } = spawnWorker(idx, shardNames);
      children.push({ id: idx, proc, pending, shard: new Set(shardNames) });
      logger.info('[CLUSTER] Worker nascido ao vivo', {
        reason: String(reason || ''),
        idx: idx + 1,
        perfis: shardNames.length,
        names: shardNames.slice(0, 8),
        desiredNodes,
        liveHardwareNodes: livePlan.serverConfig.hardwareNodes,
        liveDivisorGb: livePlan.serverConfig.workerRamDivisorGb,
        bootHardwareNodes,
        bootDivisorGb
      });
    }

    try {
      plan.nodes = children.length;
      if (plan.serverConfig) {
        plan.serverConfig.hardwareNodes = livePlan.serverConfig.hardwareNodes;
        plan.serverConfig.workerRamDivisorGb = livePlan.serverConfig.workerRamDivisorGb;
      }
    } catch {}

    await applyShardsToWorkers(growPlan.nextShards, String(reason || 'rebalance') + ':sticky_grow');
    logger.info('[CLUSTER][REB] sticky_grow', {
      reason: String(reason || ''),
      added: growPlan.added.length,
      grew: growPlan.grew,
      nodes: children.length,
      desiredNodes,
      liveHardwareNodes: livePlan.serverConfig.hardwareNodes,
      liveDivisorGb: livePlan.serverConfig.workerRamDivisorGb,
      bootHardwareNodes,
      bootDivisorGb
    });
    return {
      ok: true,
      added: growPlan.added,
      grew: growPlan.grew,
      nodes: children.length,
      desiredNodes,
      liveHardwareNodes: livePlan.serverConfig.hardwareNodes,
      liveDivisorGb: livePlan.serverConfig.workerRamDivisorGb,
      bootHardwareNodes,
      bootDivisorGb
    };
  }

  function rebalance(reason = 'watcher') {
    const run = rebalanceTail.then(
      () => rebalanceOnce(reason),
      () => rebalanceOnce(reason)
    );
    rebalanceTail = run.then(() => {}, () => {});
    return run;
  }

  // Fallback para caso especial: novo perfil não roteado ainda
  async function ensureAssigned(nome, reason = 'on_demand') {
    const exists = (fileStore.loadPerfisJson() || []).some(p => p.nome === nome);
    if (!exists) return false;
    try {
      findChildByPerfil(nome);
      return true;
    } catch {
      await rebalance(reason + ': ' + nome);
      try { findChildByPerfil(nome); return true; }
      catch { return false; }
    }
  }

  async function sendWorkerCommand(type, payload = {}, opts = {}) {
    const nome = payload && payload.nome;
    // Comandos globais (não dependem de perfil atribuído).
    // Em modo cluster, comandos sem "nome" caem no roteamento por perfil e geram profile_not_assigned.
    if (!nome) {
      if (type === 'robe-v2-warmup') {
        // Determinístico: apenas o node 1 gera o bloco/fila global (há lock em disco; evita duplicação).
        return sendTo(0, type, payload, opts);
      }
      if (type === 'ua-presets-realign') {
        const timeoutMs = Math.max(Number(opts && opts.timeoutMs || 0) || 0, 180000);
        const sendOpts = Object.assign({}, opts || {}, { timeoutMs });
        const results = await Promise.all(children.map((_, i) => sendTo(i, type, payload, sendOpts)));
        const allOk = results.every(r => r && r.ok !== false);
        const merged = {
          ok: allOk,
          scanned: 0,
          changed: 0,
          skipped: 0,
          failed: 0,
          persist: !(payload && payload.dryRun === true),
          changes: [],
          failures: [],
          results
        };
        for (const r of results) {
          if (!r) continue;
          merged.scanned += Number(r.scanned || 0) || 0;
          merged.changed += Number(r.changed || 0) || 0;
          merged.skipped += Number(r.skipped || 0) || 0;
          merged.failed += Number(r.failed || 0) || 0;
          if (Array.isArray(r.changes)) merged.changes.push(...r.changes);
          if (Array.isArray(r.failures)) merged.failures.push(...r.failures);
        }
        if (!allOk) merged.error = 'partial_fail';
        return merged;
      }
      if (type === 'robe-replan-all' || type === 'renew-replan-all') {
        // Broadcast: cada node pode limpar caches/planos; retorno agregado.
        const results = await Promise.all(children.map((_, i) => sendTo(i, type, payload, opts)));
        const allOk = results.every(r => r && r.ok !== false);
        if (allOk) {
          const pick = results.find(r => r && r.ok === true) || { ok: true };
          return pick;
        }
        return { ok: false, error: 'partial_fail', results };
      }
      if (type === 'network-rotation-pause-runtime' || type === 'network-rotation-resume-runtime') {
        const results = await Promise.all(children.map((_, i) => sendTo(i, type, payload, opts)));
        const allOk = results.every(r => r && r.ok !== false);
        const merged = {
          ok: allOk,
          results,
          pausedNames: [],
          resumedNames: [],
          failed: [],
          skipped: []
        };
        for (const r of results) {
          if (r && Array.isArray(r.pausedNames)) merged.pausedNames.push(...r.pausedNames);
          if (r && Array.isArray(r.resumedNames)) merged.resumedNames.push(...r.resumedNames);
          if (r && Array.isArray(r.failed)) merged.failed.push(...r.failed);
          if (r && Array.isArray(r.skipped)) merged.skipped.push(...r.skipped);
        }
        merged.pausedNames = Array.from(new Set(merged.pausedNames.filter(Boolean)));
        merged.resumedNames = Array.from(new Set(merged.resumedNames.filter(Boolean)));
        return merged;
      }
      if (type === 'renew-listings-shard') {
        return {
          ok: false,
          error: 'renew_listings_shard_removed',
          message: 'Renovação desacoplada do fechar/abrir. Use marketplaceRenew + pós-publish Robe.',
          total: 0,
          renewedOk: 0,
          renewedFail: 0,
          renewedNone: 0,
          skipped: 0,
          results: []
        };
      }
    }
    if (type === 'get-status' && !nome) {
      const allPerfis = fileStore.loadPerfisJson() || [];
      const baseMap = new Map();
      for (const p of allPerfis) {
        baseMap.set(p.nome, {
          nome: p.nome,
          label: p.label || null,
          cidade: p.cidade,
          uaPresetId: p.uaPresetId,
          active: false, trabalhando: false, configurando: false, humanControl: false,
          issuesCount: 0,
          ramMB: null, cpuPercent: null, numPages: null,
          robeFrozenUntil: null, frozenReason: null, frozenAt: null, frozenSetBy: null,
          activationHeldUntil: null, killGuardUntil: null, reopenAt: null,
          openBackoffMs: null, lastSwapAt: null, lastSwapPeer: null, swapCooldown: null, whyNotOpen: null,
          manifestStatus: null, closingReason: null
        });
      }

      const results = await Promise.allSettled(
        children.map((_, i) => sendTo(i, 'get-status', {}, { timeoutMs: STATUS_TIMEOUT_MS }))
      );

      // INÍCIO: Adicionado para agregação resiliente de autoMode e sys
      let autoModePick = null;
      let sysPick = null;
      // FIM DECLARAÇÕES INICIAIS
      const nodesDebug = [];

      let combinedRobes = {};
      let combinedQueue = [];
      let anyOverlay = false;
      const warningParts = [];

      // Primeira passada: RPC ou arquivo fresco (<= MAX_FILE_AGE_MS)
      for (let i = 0; i < results.length; i++) {
        let payload = null;
        let source = 'rpc';
        const r = results[i];

        if (r.status === 'fulfilled' && r.value && Array.isArray(r.value.perfis)) {
          payload = r.value;
          try {
            nodesDebug.push({
              node: i + 1,
              source,
              ok: true,
              pid: payload && payload._debug ? payload._debug.pid : null,
              buildTag: payload && payload._debug ? (payload._debug.buildTag || null) : null,
              controllersCount: payload && payload._debug ? payload._debug.controllersCount : null,
              shardSize: payload && payload._debug ? payload._debug.shardSize : null
            });
          } catch {}
        } else {
          const fb = readNodeStatusFile(i);
          if (fb && fb.json && Array.isArray(fb.json.perfis) && fb.ageMs <= MAX_FILE_AGE_MS) {
            payload = fb.json;
            source = `file(${Math.round(fb.ageMs / 1000)}s)`;
            warningParts.push(`node${i + 1}: rpc_fail -> file_ok(${Math.round(fb.ageMs / 1000)}s)`);
            try {
              nodesDebug.push({
                node: i + 1,
                source,
                ok: true,
                pid: payload && payload._debug ? payload._debug.pid : null,
                buildTag: payload && payload._debug ? (payload._debug.buildTag || null) : null,
                controllersCount: payload && payload._debug ? payload._debug.controllersCount : null,
                shardSize: payload && payload._debug ? payload._debug.shardSize : null
              });
            } catch {}
          } else {
            warningParts.push(`node${i + 1}: no_reply`);
            try { nodesDebug.push({ node: i + 1, source, ok: false }); } catch {}
          }
        }
        if (!payload) continue;
        anyOverlay = true;

        // perfis
        for (const p of payload.perfis || []) {
          const dst = baseMap.get(p.nome);
          if (dst) Object.assign(dst, p);
        }

        // robes
        if (payload.robes && typeof payload.robes === 'object') {
          combinedRobes = Object.assign(combinedRobes, payload.robes);
        }
        // robeQueue
        if (Array.isArray(payload.robeQueue)) {
          combinedQueue.push(...payload.robeQueue);
        }

        // NOVO: Agregue autoMode e sys do primeiro node válido desta rodada
        if (!sysPick && payload.sys) sysPick = payload.sys;
        if (!autoModePick && payload.autoMode) autoModePick = payload.autoMode;
      }

      // Segunda passada: se não houve overlay nenhum, aceite arquivos mesmo “stale”
      if (!anyOverlay) {
        for (let i = 0; i < children.length; i++) {
          const fb = readNodeStatusFile(i);
          if (fb && fb.json && Array.isArray(fb.json.perfis)) {
            const payload = fb.json;
            // perfis
            for (const p of payload.perfis || []) {
              const dst = baseMap.get(p.nome);
              if (dst) Object.assign(dst, p);
            }
            // robes/queue
            if (payload.robes && typeof payload.robes === 'object') {
              combinedRobes = Object.assign(combinedRobes, payload.robes);
            }
            if (Array.isArray(payload.robeQueue)) {
              combinedQueue.push(...payload.robeQueue);
            }
            // NOVO: Agregue autoMode e sys do primeiro arquivo válido "stale"
            if (!sysPick && payload.sys) sysPick = payload.sys;
            if (!autoModePick && payload.autoMode) autoModePick = payload.autoMode;
            warningParts.push(`node${i + 1}: using_stale_file(${Math.round((fb.ageMs || 0) / 1000)}s)`);
          }
        }
      }

      // dedup e ordem para robeQueue
      if (combinedQueue.length) {
        const seen = new Set();
        combinedQueue = combinedQueue.filter(n => {
          if (!n || seen.has(n)) return false;
          seen.add(n);
          return true;
        });
      }

      const perfis = Array.from(baseMap.values());
      // TROQUE: autoMode: null → autoMode: autoModePick || null (sys já faz sysPick || null)
      const out = {
        perfis,
        robes: combinedRobes,
        robeQueue: combinedQueue,
        autoMode: autoModePick || null,
        sys: sysPick || null,
        ts: Date.now(),
        _debug: { nodes: nodesDebug }
      };
      // Expor lock global no status agregado (painel/CT): evita “0 trabalhando” sem explicação.
      try { out.provisionLock = provisionLock.get(); } catch { out.provisionLock = null; }
      if (warningParts.length) out.warning = `partial nodes: ${warningParts.join('; ')}`;
      
      // ADICIONADO: grava agregado em dados/status.json antes do return out;
      try {
        const aggPath = path.join(__dirname, '..', 'dados', 'status.json');
        fileStore.writeJsonAtomic(aggPath, out);
      } catch {}
      
      return out;
    }
    if (type === 'unfreeze-all' || type === 'robes-release-all') {
      const timeoutMs = type === 'robes-release-all'
        ? Math.max(Number(opts && opts.timeoutMs || 0) || 0, 120000)
        : (opts && opts.timeoutMs);
      const sendOpts = Object.assign({}, opts || {}, timeoutMs ? { timeoutMs } : {});
      const results = await Promise.all(children.map((_, i) => sendTo(i, type, payload, sendOpts)));
      const allOk = results.every(r => r && r.ok !== false);
      if (type === 'robes-release-all') {
        const enqueued = results.reduce((s, r) => s + (Number(r && r.enqueued || 0) || 0), 0);
        const cleared = results.reduce((s, r) => s + (Number(r && r.cleared || 0) || 0), 0);
        const awaitingKept = results.reduce((s, r) => s + (Number(r && r.awaitingKept || 0) || 0), 0);
        const stillPronto = [];
        const blockedLimitPosting = [];
        for (const r of results) {
          if (r && Array.isArray(r.stillPronto)) stillPronto.push(...r.stillPronto);
          if (r && Array.isArray(r.blockedLimitPosting)) {
            blockedLimitPosting.push(...r.blockedLimitPosting);
          }
        }
        try {
          logger.info('[CLUSTER] robes-release-all aggregate', {
            enqueued,
            cleared,
            awaitingKept,
            stillPronto: stillPronto.length,
            blockedLimitPosting: blockedLimitPosting.length,
            nodes: results.map((r, i) => ({
              node: i + 1,
              ok: !!(r && r.ok !== false),
              enqueued: Number(r && r.enqueued || 0) || 0,
              working: Number(r && r.working || 0) || 0,
              stillPronto: Array.isArray(r && r.stillPronto) ? r.stillPronto.length : null,
              blockedLimitPosting: Array.isArray(r && r.blockedLimitPosting) ? r.blockedLimitPosting.length : null,
              error: r && r.error ? String(r.error).slice(0, 80) : null
            }))
          });
        } catch {}
        return allOk
          ? { ok: true, enqueued, cleared, awaitingKept, stillPronto, blockedLimitPosting, nodes: results.length, results }
          : { ok: false, error: 'partial_fail', enqueued, cleared, awaitingKept, stillPronto, blockedLimitPosting, results };
      }
      return allOk ? { ok: true } : { ok: false, error: 'partial_fail' };
    }
    // para comandos por perfil, assegura roteamento
    if (nome && route[nome] === undefined) {
      await ensureAssigned(nome, 'on_demand_send');
    }
    try {
      const i = findChildByPerfil(nome);
      return sendTo(i, type, payload, opts);
    } catch (err) {
      if (String(err).startsWith('Error: profile_not_assigned_to_any_worker')) {
        return { ok: false, error: 'profile_not_assigned' };
      }
      throw err;
    }
  }

  async function kill() {
    isShuttingDown = true;
    try { if (standbySweep && typeof standbySweep.stop === 'function') standbySweep.stop(); } catch {}
    // ============= BEGIN PATCH: close perfisWatcher before killing =============
    try { perfisWatcher && perfisWatcher.close && perfisWatcher.close(); } catch {}
    // ============= END PATCH: close perfisWatcher before killing ===============
    for (const c of children) {
      try { c.proc.kill('SIGTERM'); } catch {}
    }
  }

  // Watcher: conta nova / conta apagada. Grow ao vivo; não reshuffle.
  // CLUSTER_AUTO_REBALANCE=0 desliga. Default ligado.
  (function watchPerfisJson(){
    const perfisFile = path.join(__dirname, '..', 'dados', 'perfis.json');
    const enabled = String(process.env.CLUSTER_AUTO_REBALANCE || '1') !== '0';
    if (!enabled) {
      logger.info('[CLUSTER][REB] watcher disabled (CLUSTER_AUTO_REBALANCE=0)');
      return;
    }
    let timer = null;
    try {
      perfisWatcher = fs.watch(perfisFile, { persistent: false }, () => {
        clearTimeout(timer);
        timer = setTimeout(() => {
          rebalance('watcher:perfis.json').catch(e => logger.warn('[CLUSTER][REB] watcher error', { error: e && e.message || e }));
        }, 150);
      });
    } catch (e) {
      logger.warn('[CLUSTER] fs.watch perfis.json falhou; cadastro ainda cresce via API/ensureAssigned.', { error: e && e.message || e });
    }
  })();

  async function reshuffleFairIfIdle(reason = 'open_all') {
    if (isShuttingDown) return { ok: false, error: 'shutting_down', reshuffled: false };
    const checks = await Promise.all(
      children.map((_, i) => sendTo(i, 'shard-busy-count', {}, { timeoutMs: 8000 }))
    );
    let connected = 0;
    let unknown = 0;
    for (const r of checks) {
      if (!r || r.ok === false) unknown += 1;
      else connected += Math.max(0, Number(r.connected) || 0);
    }
    if (unknown > 0 || connected > 0) {
      logger.info('[CLUSTER][REB] fair_reshuffle skipped', {
        reason: String(reason || ''),
        connected,
        unknown,
        nodes: children.length
      });
      return { ok: true, reshuffled: false, connected, unknown, nodes: children.length };
    }
    const namesNow = (fileStore.loadPerfisJson() || []).map((p) => p && p.nome).filter(Boolean);
    const fair = planFairReshuffle({ names: namesNow, nodes: Math.max(1, children.length) });
    await applyShardsToWorkers(fair.nextShards, String(reason || 'open_all') + ':fair_idle');
    logger.info('[CLUSTER][REB] fair_reshuffle', {
      reason: String(reason || ''),
      accounts: fair.accounts,
      nodes: fair.nodes,
      sizes: fair.nextShards.map((s) => s.length)
    });
    return {
      ok: true,
      reshuffled: true,
      connected: 0,
      unknown: 0,
      accounts: fair.accounts,
      nodes: fair.nodes,
      sizes: fair.nextShards.map((s) => s.length)
    };
  }

  return { plan, children, sendWorkerCommand, kill, rebalance, reshuffleFairIfIdle };
}

module.exports = { createCluster };