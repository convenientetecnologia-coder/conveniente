// scripts/clusterMaster.js

const { fork } = require('child_process');
const path = require('path');
const fs = require('fs');
const { planMemoryAndShards } = require('./memoryPlan.js');
const fileStore = require('./fileStore.js');
const logger = require('./logger.js');
const supervisor = require('./supervisor.js');

function newMsgId() { return Math.random().toString(36).slice(2); }

// NOVO: Algoritmo determinístico, justo, distribui round-robin lexicográfico.
// Balanceamento perfeito, diferença máxima 1 entre nodes.
function splitRoundRobinFair(names, blocks) {
  if (blocks < 1) return [names.slice()];
  const sorted = names.slice().sort((a, b) => a.localeCompare(b, 'pt-BR', {sensitivity:'base'}));
  const out = Array.from({ length: blocks }, () => []);
  sorted.forEach((name, idx) => {
    out[idx % blocks].push(name);
  });
  return out;
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
    perNodeMax: plan.perNode.maxChromes,
    reservedForOverheadMB: plan.budgets.reservedForOverheadMB,
    remainingForChromesMB: plan.budgets.remainingForChromesMB,
    chromeAvgMB: plan.budgets.chromeAvgMB,
    totalProfiles: names.length,
    effectiveChromesCap: 'all'
  });

  const children = [];
  const route = {};

  // Rebuild route from a block array (idx->name list)
  function routeRebuildFromBlocks(blocksArr) {
    for (let i = 0; i < blocksArr.length; i++) {
      for (const n of (blocksArr[i] || [])) route[n] = i;
    }
  }

  for (let idx = 0; idx < blocks.length; idx++) {
    const shardNames = blocks[idx] || [];
    const shardSet = new Set(shardNames);
    shardNames.forEach(n => (route[n] = idx));
    const env = { ...process.env };
    env.IS_WORKER_CHILD = '1';
    env.SHARD_PROFILES = JSON.stringify(shardNames);
    env.STATUS_FILE_NAME = `status_node_${idx + 1}.json`;

    const execPath = process.env.npm_node_execpath || process.env.NODE || process.execPath;
    const proc = fork(path.join(__dirname, 'worker.js'), [], {
      stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
      execPath,
      env
    });
    const pending = new Map();

    proc.on('message', (msg) => {
      if (msg && msg.replyTo && pending.has(msg.replyTo)) {
        const { resolve } = pending.get(msg.replyTo);
        pending.delete(msg.replyTo);
        return resolve(msg.data);
      }
      if (msg && msg.type === 'sup:reqOpen') {
        const { perfil } = msg;
        const r = supervisor.requestOpen(perfil);
        return proc.send({ replyTo: msg.msgId, data: r });
      }
      if (msg && msg.type === 'sup:notifyOpened') {
        const { perfil, result } = msg;
        const r = supervisor.notifyOpened(perfil, result);
        return proc.send({ replyTo: msg.msgId, data: r });
      }
      if (msg && msg.type === 'sup:getStatus') {
        const r = supervisor.getStatus();
        return proc.send({ replyTo: msg.msgId, data: r });
      }
    });

    proc.on('exit', (code, signal) => {
      logger.warn('[CLUSTER] worker dropado', { idx, code, signal });
    });

    children.push({ id: idx, proc, pending, shard: new Set(shardNames) });
    logger.info('[CLUSTER] Worker iniciado', { idx: idx + 1, perfis: shardNames.length });
  }

  logger.info('[CLUSTER][ROUTE]', {
    totalPerfis: names.length,
    nodes: blocks.length,
    assigned: Object.keys(route).length
  });

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

  // Aplica shards diretamente em todos os workers e reconstrói as rotas internas (route)
  async function applyShardsToWorkers(blocksArr, reason = 'rebalance') {
    logger.info('[CLUSTER][REB] applyShardsToWorkers', { reason, nodes: blocksArr.length });
    const tasks = [];
    for (let i = 0; i < children.length; i++) {
      const shardNames = blocksArr[i] || [];
      children[i].shard = new Set(shardNames);
      tasks.push(sendTo(i, 'set-shard', { names: shardNames }, { timeoutMs: 20000 }));
    }
    await Promise.all(tasks);
    // reconstrói rota
    for (const k of Object.keys(route)) delete route[k];
    routeRebuildFromBlocks(blocksArr);
  }

  // Garante rebalanceamento justo (diferença <= 1) sob evento ou demanda
  async function rebalance(reason = 'watcher') {
    const perfis = fileStore.loadPerfisJson() || [];
    const namesNow = perfis.map(p => p.nome);
    const k = children.length;
    const fairBlocks = splitRoundRobinFair(namesNow, k);
    await applyShardsToWorkers(fairBlocks, reason);
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

      let combinedRobes = {};
      let combinedQueue = [];
      let anyOverlay = false;
      let sysPick = null;
      const warningParts = [];

      // Primeira passada: RPC ou arquivo fresco (<= MAX_FILE_AGE_MS)
      for (let i = 0; i < results.length; i++) {
        let payload = null;
        let source = 'rpc';
        const r = results[i];

        if (r.status === 'fulfilled' && r.value && Array.isArray(r.value.perfis)) {
          payload = r.value;
        } else {
          const fb = readNodeStatusFile(i);
          if (fb && fb.json && Array.isArray(fb.json.perfis) && fb.ageMs <= MAX_FILE_AGE_MS) {
            payload = fb.json;
            source = `file(${Math.round(fb.ageMs / 1000)}s)`;
            warningParts.push(`node${i + 1}: rpc_fail -> file_ok(${Math.round(fb.ageMs / 1000)}s)`);
          } else {
            warningParts.push(`node${i + 1}: no_reply`);
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

        if (!sysPick && payload.sys) sysPick = payload.sys;
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
            if (!sysPick && payload.sys) sysPick = payload.sys;
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
      const out = {
        perfis,
        robes: combinedRobes,
        robeQueue: combinedQueue,
        autoMode: null,
        sys: sysPick || null,
        ts: Date.now()
      };
      if (warningParts.length) out.warning = `partial nodes: ${warningParts.join('; ')}`;
      return out;
    }
    if (type === 'unfreeze-all' || type === 'robes-release-all') {
      const results = await Promise.all(children.map((_, i) => sendTo(i, type, payload, opts)));
      const allOk = results.every(r => r && r.ok !== false);
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
    for (const c of children) {
      try { c.proc.kill('SIGTERM'); } catch {}
    }
  }

  // Watcher hot/rebalance em perfis.json
  (function watchPerfisJson(){
    const perfisFile = path.join(__dirname, '..', 'dados', 'perfis.json');
    if (process.env.CLUSTER_AUTO_REBALANCE === '1') {
      let timer = null;
      try {
        fs.watch(perfisFile, { persistent: false }, () => {
          clearTimeout(timer);
          timer = setTimeout(() => {
            rebalance('watcher:perfis.json').catch(e => logger.warn('[CLUSTER][REB] watcher error', { error: e && e.message || e }));
          }, 150);
        });
      } catch (e) {
        logger.warn('[CLUSTER] fs.watch perfis.json falhou; prossegue sem watcher.', { error: e && e.message || e });
      }
    } else {
      logger.info('[CLUSTER][REB] watcher disabled (CLUSTER_AUTO_REBALANCE!=1)');
    }
  })();

  return { plan, children, sendWorkerCommand, kill, rebalance };
}

module.exports = { createCluster };