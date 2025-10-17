// scripts/clusterMaster.js

const { fork } = require('child_process');
const path = require('path');
const fs = require('fs');
const { planMemoryAndShards } = require('./memoryPlan.js');
const fileStore = require('./fileStore.js');
const logger = require('./logger.js');
const supervisor = require('./supervisor.js');

function newMsgId() { return Math.random().toString(36).slice(2); }

function splitInBlocks(list, blocks, maxPerBlock) {
  // Distribuição round-robin, balanceada por node
  const arr = Array.from(list);
  const out = Array.from({ length: blocks }, () => []);
  let i = 0;
  while (arr.length) {
    const name = arr.shift();
    let loops = 0;
    while (out[i].length >= maxPerBlock) {
      i = (i+1) % blocks;
      loops++; if (loops > blocks+2) break;
    }
    out[i].push(name);
    i = (i+1) % blocks;
  }
  return out;
}

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

function createCluster() {
  const allPerfis = fileStore.loadPerfisJson() || [];
  const names = allPerfis.map(p => p.nome);
  const plan = planMemoryAndShards({ totalProfiles: names.length });
  const blocks = splitInBlocks(names, plan.nodes, plan.perNode.maxChromes);

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

    children.push({ id: idx, proc, shardSet, pending, statusLast: null });
    logger.info('[CLUSTER] Worker iniciado', { idx: idx + 1, perfis: shardNames.length });
  }

  logger.info('[CLUSTER][ROUTE]', {
    totalPerfis: names.length,
    nodes: blocks.length,
    assigned: Object.keys(route).length,
    unassigned: names.length - Object.keys(route).length
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

  async function sendWorkerCommand(type, payload = {}, opts = {}) {
    const nome = payload && payload.nome;
    if (type === 'get-status' && !nome) {
      // --- PATCH AGREGADOR ROBUSTO ---
      const allPerfis = fileStore.loadPerfisJson() || [];
      const baseMap = new Map();
      for (const p of allPerfis) {
        baseMap.set(p.nome, {
          nome: p.nome,
          label: p.label || null,
          cidade: p.cidade,
          uaPresetId: p.uaPresetId,
          active: false, trabalhando:false, configurando:false, humanControl:false,
          issuesCount: 0,
          ramMB: null, cpuPercent: null, numPages: null,
          robeFrozenUntil: null, frozenReason:null, frozenAt:null, frozenSetBy:null,
          activationHeldUntil:null, killGuardUntil:null, reopenAt:null,
          openBackoffMs:null, lastSwapAt:null, lastSwapPeer:null, swapCooldown:null, whyNotOpen:null
        });
      }

      const results = await Promise.allSettled(
        children.map((_, i) => sendTo(i, 'get-status', {}, { timeoutMs: STATUS_TIMEOUT_MS }))
      );

      let warningParts = [];
      for (let i = 0; i < results.length; i++) {
        const r = results[i];
        let payload = null;
        let source = 'rpc';
        if (r.status === 'fulfilled' && r.value && Array.isArray(r.value.perfis)) {
          payload = r.value;
        } else {
          const fb = readNodeStatusFile(i);
          if (fb && fb.json && Array.isArray(fb.json.perfis) && fb.ageMs <= 30000) {
            payload = fb.json;
            source = `file(${Math.round(fb.ageMs/1000)}s)`;
            warningParts.push(`node${i+1}: rpc_fail -> file_ok(${Math.round(fb.ageMs/1000)}s)`);
          } else {
            warningParts.push(`node${i+1}: no_reply`);
          }
        }
        if (!payload) continue;
        for (const p of payload.perfis || []) {
          const m = baseMap.get(p.nome);
          if (!m) continue;
          Object.assign(m, p); // overlay fields
        }
      }

      const perfis = Array.from(baseMap.values());
      const robes = {}; // opcional: merge dos workers, se precisar
      const robeQueue = []; // concat arrays
      let out = { perfis, robes, robeQueue, autoMode: null, sys: null, ts: Date.now() };
      if (warningParts.length) out.warning = `partial nodes: ${warningParts.join('; ')}`;
      // LOG policia
      if (warningParts.length) {
        logger.warn('[CLUSTER][STATUS] parcial', { nodes: children.length, warn: out.warning, perfis: perfis.length, totalPerfis: allPerfis.length });
      } else {
        logger.info('[CLUSTER][STATUS] ok', { nodes: children.length, perfis: perfis.length });
      }
      return out;
    }
    // BROADCAST
    if (type === 'unfreeze-all' || type === 'robes-release-all') {
      const results = await Promise.all(children.map((_, i) => sendTo(i, type, payload, opts)));
      const allOk = results.every(r => r && r.ok !== false);
      return allOk ? { ok: true } : { ok: false, error: 'partial_fail' };
    }
    try {
      const i = findChildByPerfil(nome);
      return sendTo(i, type, payload, opts);
    } catch (err) {
      if (err && String(err).startsWith('Error: profile_not_assigned_to_any_worker')) {
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

  return { plan, children, sendWorkerCommand, kill };
}

module.exports = { createCluster };