// scripts/clusterMaster.js

const { fork } = require('child_process');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { planMemoryAndShards } = require('./memoryPlan.js');
const fileStore = require('./fileStore.js');
const logger = require('./logger.js');
const supervisor = require('./supervisor.js');

// Util simples para RPC msgId por worker
function newMsgId() { return Math.random().toString(36).slice(2); }

function splitInBlocks(list, blocks, maxPerBlock) {
  // Distribuição round-robin, balanceada por node
  const arr = Array.from(list);
  const out = Array.from({ length: blocks }, () => []);
  let i = 0;
  while (arr.length) {
    const name = arr.shift();
    // Se já atingiu maxPerBlock, pula para próximo bloco
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

function createCluster() {
  const allPerfis = fileStore.loadPerfisJson() || [];
  const names = allPerfis.map(p => p.nome);
  const plan = planMemoryAndShards({ totalProfiles: names.length });

  // Corta perfis se RAM real não comportar todos os Chromes
  const chromesGlobalCap = plan.budgets.remainingForChromesMB > 0
    ? Math.min(names.length, Math.floor(plan.budgets.remainingForChromesMB / plan.budgets.chromeAvgMB))
    : 0;
  const usableNames = names.slice(0, chromesGlobalCap || names.length);
  const blocks = splitInBlocks(usableNames, plan.nodes, plan.perNode.maxChromes);

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
    effectiveChromesCap: chromesGlobalCap || 'all'
  });

  const children = []; // [{ id, proc, shardSet, pending, statusLast }]
  const route = {};    // nome -> idx filho

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
      // RPC para comandos de slot/supervisão
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

  function findChildByPerfil(nome) {
    const i = route[nome];
    return typeof i === 'number' ? i : 0; // fallback
  }

  async function sendWorkerCommand(type, payload = {}, opts = {}) {
    const nome = payload && payload.nome;
    // GET UNIFIED STATUS
    if (type === 'get-status' && !nome) {
      const results = await Promise.all(children.map((_, i) => sendTo(i, 'get-status', {}, { timeoutMs: 8000 })));
      // Merge resultados de todos filhos
      const perfis = [];
      const robes = {};
      const robeQueue = [];
      let autoMode = null;
      let sys = null;
      for (const r of results) {
        if (r && r.perfis) perfis.push(...r.perfis);
        if (r && r.robes) Object.assign(robes, r.robes);
        if (r && Array.isArray(r.robeQueue)) robeQueue.push(...r.robeQueue);
        if (!autoMode && r && r.autoMode) autoMode = r.autoMode;
        if (!sys && r && r.sys) sys = r.sys;
      }
      return { perfis, robes, robeQueue, autoMode, sys, ts: Date.now() };
    }
    // BROADCAST (ex: unfreeze-all, robes-release-all)
    if (type === 'unfreeze-all' || type === 'robes-release-all') {
      const results = await Promise.all(children.map((_, i) => sendTo(i, type, payload, opts)));
      const allOk = results.every(r => r && r.ok !== false);
      return allOk ? { ok: true } : { ok: false, error: 'partial_fail' };
    }
    // ROTA POR PERFIL
    const i = findChildByPerfil(nome);
    return sendTo(i, type, payload, opts);
  }

  async function kill() {
    for (const c of children) {
      try { c.proc.kill('SIGTERM'); } catch {}
    }
  }

  return { plan, children, sendWorkerCommand, kill };
}

module.exports = { createCluster };