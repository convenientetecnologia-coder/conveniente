// scripts/clusterMaster.js

const { spawn } = require('child_process');
const net = require('net');
const path = require('path');
const fs = require('fs');
const { planMemoryAndShards, planStickyGrow, calcLiveDesiredWorkerNodes, planFairReshuffle } = require('./memoryPlan.js');
const fileStore = require('./fileStore.js');
const logger = require('./logger.js');
const supervisor = require('./supervisor.js');
const provisionLock = require('./provisionLock.js');
const chromeMemorySweep = require('./chromeMemorySweep.js');
const chromeMotores = require('./chromeMotores.js');
const cellRegistry = require('./cellRegistry.js');
const cellForensic = require('./cellForensic.js');
const cellLifecycle = require('./cellLifecycle.js');
const { writeJsonLine, attachLineParser } = require('./cellNet.js');

function newMsgId() { return Math.random().toString(36).slice(2); }

function resolveClusterSilentConsole() {
  try {
    if (logger && typeof logger.isSilentConsole === 'function') return !!logger.isSilentConsole();
  } catch {}
  return true;
}

// 4 slots. String 'ignore' sozinha some com o fd ipc.
function workerStdioSlots(silent) {
  const stdio = silent
    ? ['ignore', 'ignore', 'ignore', 'ipc']
    : ['inherit', 'inherit', 'inherit', 'ipc'];
  if (!Array.isArray(stdio) || stdio.length !== 4 || stdio[3] !== 'ipc') {
    throw new Error('CLUSTER_STDIO_FATAL: ipc obrigatorio em array de 4; string ignore proibida');
  }
  return stdio;
}

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

async function createCluster() {
  const allPerfis = fileStore.loadPerfisJson() || [];
  const names = allPerfis.map(p => p.nome);
  const plan = planMemoryAndShards({ totalProfiles: names.length });
  let blocks = splitRoundRobinFair(names, plan.nodes);
  let aliveAtBoot = cellRegistry.listAlive();
  const bootStamp = cellLifecycle.currentStamp();
  if (aliveAtBoot.length > 0 && cellLifecycle.isStampStale()) {
    try {
      logger.warn('[CLUSTER] código novo no disco: reciclando células antigas (git pull / atualização)', {
        saved: cellLifecycle.savedStamp(),
        disk: bootStamp,
        alive: aliveAtBoot.length
      });
    } catch {}
    try { cellLifecycle.stopAllCells({ reason: 'code_stamp_mismatch' }); } catch {}
    aliveAtBoot = [];
  }
  if (aliveAtBoot.length > 0 && cellLifecycle.isTopologyStale()) {
    try {
      logger.warn('[CLUSTER] topologia nova (divisor/RAM): reciclando células para o número certo', {
        alive: aliveAtBoot.length,
        want: plan.nodes,
        divisorGb: plan.serverConfig && plan.serverConfig.workerRamDivisorGb
      });
    } catch {}
    try { cellLifecycle.stopAllCells({ reason: 'topology_mismatch' }); } catch {}
    aliveAtBoot = [];
  }
  const adopting = aliveAtBoot.length > 0;
  if (adopting) {
    const maxIdx = Math.max(
      plan.nodes - 1,
      ...aliveAtBoot.map((r) => Math.max(0, Number(r.idx) || 0))
    );
    const fromReg = Array.from({ length: Math.max(plan.nodes, maxIdx + 1) }, () => []);
    for (const row of aliveAtBoot) {
      const i = Math.max(0, Number(row.idx) || 0);
      fromReg[i] = Array.isArray(row.shard) ? row.shard.slice() : [];
    }
    const used = new Set();
    for (const shard of fromReg) {
      for (const n of shard) used.add(n);
    }
    for (const n of names) {
      if (used.has(n)) continue;
      let best = 0;
      for (let i = 1; i < fromReg.length; i++) {
        if (fromReg[i].length < fromReg[best].length) best = i;
      }
      fromReg[best].push(n);
      used.add(n);
    }
    blocks = fromReg;
    try {
      logger.info('[CLUSTER][ADOPT_PLAN]', {
        alive: aliveAtBoot.length,
        nodes: blocks.length,
        sizes: blocks.map((s) => s.length)
      });
    } catch {}
  }

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
  const silentConsole = resolveClusterSilentConsole();
  const workerStdio = workerStdioSlots(silentConsole);
  try {
    logger.info('[CLUSTER][SILENT_CONSOLE]', {
      silentConsole,
      stdio: workerStdio.join(','),
      ipcSlot: workerStdio[3]
    });
  } catch {}
  try {
    require('./indexLifecycle.js').append('silent_console_boot', {
      silentConsole,
      stdio: workerStdio,
      ipcSlot: workerStdio[3]
    });
  } catch {}

  // Rebuild route from a block array (idx->name list)
  function routeRebuildFromBlocks(blocksArr) {
    for (let i = 0; i < blocksArr.length; i++) {
      for (const n of (blocksArr[i] || [])) route[n] = i;
    }
  }

  // ================= BEGIN PATCH: perfisWatcher handle ====================
  let perfisWatcher = null;
  // ================= END PATCH: perfisWatcher handle ======================

  function cellReply(child, msgId, data) {
    if (!child || typeof child.netSend !== 'function') return;
    try { child.netSend({ replyTo: msgId, data }); } catch {}
  }

  function handleCellInbound(child, idx, msg) {
    if (msg && msg.replyTo && child.pending && child.pending.has(msg.replyTo)) {
      const { resolve } = child.pending.get(msg.replyTo);
      child.pending.delete(msg.replyTo);
      return resolve(msg.data);
    }
    if (msg && msg.type === 'standby-sweep-idle-hint') {
      try {
        if (standbySweep && typeof standbySweep.idleHint === 'function') standbySweep.idleHint();
      } catch {}
      return;
    }
    if (msg && msg.type === 'perfis:remove') {
      const nome = String((msg.payload && msg.payload.nome) || '').trim();
      const reason = String((msg.payload && msg.payload.reason) || 'worker_remove').slice(0, 180);
      const caller = String((msg.payload && msg.payload.caller) || `worker_${idx + 1}`).slice(0, 80);
      const r = fileStore.withPerfisFileLockUpdate((arr) => {
        return Array.isArray(arr) ? arr.filter(p => p && p.nome !== nome) : [];
      }, { caller, reason });
      return cellReply(child, msg.msgId, Object.assign({ ok: true, nome }, r));
    }
    if (msg && msg.type === 'perfis:upsert') {
      const perfil = (msg.payload && typeof msg.payload.perfil === 'object') ? msg.payload.perfil : null;
      const nome = String(perfil && perfil.nome || '').trim();
      const reason = String((msg.payload && msg.payload.reason) || 'worker_upsert').slice(0, 180);
      const caller = String((msg.payload && msg.payload.caller) || `worker_${idx + 1}`).slice(0, 80);
      if (!perfil || !nome) return cellReply(child, msg.msgId, { ok: false, error: 'invalid_perfil' });
      const r = fileStore.withPerfisFileLockUpdate((arr) => {
        const next = Array.isArray(arr) ? arr.slice() : [];
        const i = next.findIndex(p => p && p.nome === nome);
        if (i >= 0) next[i] = Object.assign({}, next[i], perfil);
        else next.push(Object.assign({}, perfil));
        return next;
      }, { caller, reason });
      return cellReply(child, msg.msgId, Object.assign({ ok: true, nome }, r));
    }
    if (msg && msg.type === 'perfis:patch') {
      const nome = String((msg.payload && msg.payload.nome) || '').trim();
      const patch = (msg.payload && typeof msg.payload.patch === 'object') ? msg.payload.patch : null;
      const reason = String((msg.payload && msg.payload.reason) || 'worker_patch').slice(0, 180);
      const caller = String((msg.payload && msg.payload.caller) || `worker_${idx + 1}`).slice(0, 80);
      if (!nome || !patch) return cellReply(child, msg.msgId, { ok: false, error: 'invalid_args' });
      const r = fileStore.withPerfisFileLockUpdate((arr) => {
        const next = Array.isArray(arr) ? arr.slice() : [];
        const i = next.findIndex(p => p && p.nome === nome);
        if (i >= 0) next[i] = Object.assign({}, next[i], patch);
        return next;
      }, { caller, reason });
      return cellReply(child, msg.msgId, Object.assign({ ok: true, nome }, r));
    }
    if (msg && msg.type === 'sup:reqOpen') {
      const { perfil } = msg;
      const r = supervisor.requestOpen(perfil, (msg && msg.opts) || {});
      return cellReply(child, msg.msgId, r);
    }
    if (msg && msg.type === 'sup:reqPermit') {
      const kind = msg && msg.kind ? String(msg.kind) : '';
      const perfil = msg && msg.perfil ? String(msg.perfil) : '';
      const opts = (msg && msg.opts && typeof msg.opts === 'object') ? msg.opts : {};
      const r = supervisor.requestPermit({ kind, perfil, operator: opts.operator || '', ttlMs: opts.ttlMs });
      return cellReply(child, msg.msgId, r);
    }
    if (msg && msg.type === 'sup:notifyOpened') {
      const { perfil, result } = msg;
      const r = supervisor.notifyOpened(perfil, result);
      return cellReply(child, msg.msgId, r);
    }
    if (msg && msg.type === 'sup:releasePermit') {
      const token = msg && msg.token ? String(msg.token) : '';
      const opts = (msg && msg.opts && typeof msg.opts === 'object') ? msg.opts : {};
      const r = supervisor.releasePermit({ token, result: opts.result || null });
      return cellReply(child, msg.msgId, r);
    }
    if (msg && msg.type === 'sup:getStatus') {
      const r = supervisor.getStatus();
      return cellReply(child, msg.msgId, r);
    }
  }

  function bindCellSocket(child, idx, sock) {
    try { if (child.socket && child.socket !== sock) child.socket.destroy(); } catch {}
    child.socket = sock;
    try { sock.setNoDelay(true); } catch {}
    child.netSend = (obj) => writeJsonLine(sock, obj);
    attachLineParser(sock, (msg) => handleCellInbound(child, idx, msg));
    sock.on('close', () => {
      if (child.socket === sock) child.socket = null;
      if (isShuttingDown || child.deadHandled) return;
      if (cellRegistry.pidAlive(child.pid)) {
        setTimeout(() => { connectCellSocket(child, idx).catch(() => {}); }, 400);
      }
    });
    sock.on('error', () => {});
  }

  function connectCellSocket(child, idx) {
    return new Promise((resolve) => {
      const port = Number(child.port);
      const sock = net.connect({ host: '127.0.0.1', port });
      const fail = () => {
        try { sock.destroy(); } catch {}
        resolve(false);
      };
      sock.once('connect', () => {
        try { sock.setTimeout(0); } catch {}
        bindCellSocket(child, idx, sock);
        try {
          cellForensic.append('cell_maestro_socket', { idx: idx + 1, port, pid: child.pid, adopted: !!child.adopted });
        } catch {}
        resolve(true);
      });
      sock.once('error', fail);
      sock.setTimeout(4000, fail);
    });
  }

  function onCellDeath(idx, { code, signal, pid } = {}) {
    const child = children[idx];
    if (!child || child.deadHandled) return;
    if (pid && child.pid && Number(pid) !== Number(child.pid)) return;
    child.deadHandled = true;
    logger.warn('[CLUSTER] worker dropado', { idx, code, signal, pid: pid || child.pid });
    try {
      require('./crashHammer.js').scheduleWorkerDrop({
        idx: idx + 1,
        code: code == null ? null : Number(code),
        signal: signal == null ? null : String(signal),
        workerPid: pid || (child && child.pid) || null,
        shard: child && child.shard ? child.shard.size : (blocks[idx] || []).length
      });
    } catch {}
    try { cellForensic.append('cell_drop', { idx: idx + 1, code, signal, pid: pid || child.pid }); } catch {}
    for (const [msgId, { resolve }] of (child.pending || new Map()).entries()) {
      try { resolve({ ok: false, error: 'worker_died' }); } catch {}
    }
    try { child.pending.clear(); } catch {}
    if (isShuttingDown) return;
    try {
      const dyingShard = child && child.shard ? Array.from(child.shard) : (blocks[idx] || []);
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
      const target = children[idx];
      const shardNames = target && target.shard ? Array.from(target.shard) : (blocks[idx] || []);
      logger.info('[CLUSTER] respawnando worker', { idx: idx + 1 });
      spawnWorker(idx, shardNames).then((fresh) => {
        if (!target) {
          children.push(fresh);
          return;
        }
        target.proc = fresh.proc;
        target.pending = fresh.pending;
        target.pid = fresh.pid;
        target.port = fresh.port;
        target.socket = fresh.socket;
        target.netSend = fresh.netSend;
        target.adopted = false;
        target.deadHandled = false;
        target.shard = fresh.shard;
      }).catch((e) => {
        logger.error('[CLUSTER] erro ao respawnar worker', { idx, error: e && e.message || e }, e);
      });
    }, 2000);
  }

  function spawnDetachedCell(idx, shardNames, env) {
    const execPath = process.env.npm_node_execpath || process.env.NODE || process.execPath;
    const entry = path.join(__dirname, 'cellEntry.js');
    const proc = spawn(execPath, [entry], {
      cwd: path.join(__dirname, '..'),
      env,
      detached: true,
      windowsHide: true,
      stdio: 'ignore'
    });
    try { proc.unref(); } catch {}
    proc.on('error', (err) => {
      try { logger.error('[WORKER] erro no spawn da célula', { idx: idx + 1, error: err && err.message || err }, err); } catch {}
    });
    proc.on('exit', (code, signal) => {
      onCellDeath(idx, { code, signal, pid: proc.pid });
    });
    return proc;
  }

  async function spawnWorker(idx, shardNames) {
    shardNames.forEach(n => (route[n] = idx));
    const env = { ...process.env };
    env.IS_WORKER_CHILD = '1';
    env.CONVENIENTE_CELL = '1';
    env.WORKER_SHARD_INDEX = String(idx);
    env.SHARD_PROFILES = JSON.stringify(shardNames);
    env.STATUS_FILE_NAME = `status_node_${idx + 1}.json`;
    env.CELL_CMD_PORT = String(cellRegistry.portForIdx(idx));
    env.VIRTUS_DELTA_CITY_COLLECTOR_USER_DATA_DIR = path.join(
      __dirname,
      '..',
      'dados',
      'city-collector-shards',
      `w${idx + 1}`
    );
    const motorExe = chromeMotores.motorExe(idx + 1);
    if (!fs.existsSync(motorExe)) {
      throw new Error('MULTI_ENGINE_FATAL: motor ausente no spawn w' + (idx + 1) + ' ' + motorExe);
    }
    env.CHROME_PATH = motorExe;
    env.CHROME_MOTOR_EXE = motorExe;
    if (silentConsole && String(env.CONVENIENTE_SILENT_CONSOLE || '').trim() !== '0') {
      env.CONVENIENTE_SILENT_CONSOLE = '1';
      if (!env.FB_LOG_LEVEL) env.FB_LOG_LEVEL = 'silent';
    }

    const pending = new Map();
    const child = {
      id: idx,
      proc: null,
      pending,
      shard: new Set(shardNames),
      pid: null,
      port: cellRegistry.portForIdx(idx),
      socket: null,
      netSend: null,
      adopted: false,
      deadHandled: false
    };

    const aliveRow = (cellRegistry.listAlive() || []).find((r) => Number(r.idx) === idx);
    if (aliveRow && cellRegistry.pidAlive(aliveRow.pid)) {
      child.pid = Number(aliveRow.pid);
      child.port = Number(aliveRow.port) || child.port;
      child.adopted = true;
      child.shard = new Set(Array.isArray(aliveRow.shard) && aliveRow.shard.length ? aliveRow.shard : shardNames);
      child.shard.forEach((n) => { route[n] = idx; });
      const connected = await (async () => {
        const started = Date.now();
        while ((Date.now() - started) < 8000) {
          if (await connectCellSocket(child, idx)) return true;
          await new Promise((r) => setTimeout(r, 150));
        }
        return false;
      })();
      if (!connected) {
        logger.warn('[CLUSTER] adopt sem socket', { idx: idx + 1, pid: child.pid, port: child.port });
      }
      try {
        logger.info('[CLUSTER][ADOPT]', { worker: idx + 1, pid: child.pid, port: child.port, shardSize: child.shard.size });
        cellForensic.append('cell_adopt', { idx: idx + 1, pid: child.pid, port: child.port, shard: child.shard.size });
      } catch {}
      return child;
    }

    try {
      logger.info('[CLUSTER][SPAWN]', {
        worker: idx + 1,
        shardSize: Array.isArray(shardNames) ? shardNames.length : 0,
        cityCollectorUserDataDir: env.VIRTUS_DELTA_CITY_COLLECTOR_USER_DATA_DIR,
        chromeMotor: motorExe,
        silentConsole,
        cellPort: env.CELL_CMD_PORT,
        detached: true
      });
    } catch {}

    const proc = spawnDetachedCell(idx, shardNames, env);
    child.proc = proc;
    child.pid = proc.pid || null;
    const connected = await (async () => {
      const started = Date.now();
      while ((Date.now() - started) < 90000) {
        if (await connectCellSocket(child, idx)) return true;
        await new Promise((r) => setTimeout(r, 150));
      }
      return false;
    })();
    if (!connected) {
      throw new Error('CELL_LISTEN_TIMEOUT: w' + (idx + 1) + ' port ' + child.port);
    }
    try {
      cellRegistry.upsertCell({
        idx,
        pid: child.pid,
        port: child.port,
        shard: shardNames,
        statusFile: env.STATUS_FILE_NAME
      });
      cellForensic.append('cell_spawn', { idx: idx + 1, pid: child.pid, port: child.port, shard: shardNames.length });
    } catch {}
    return child;
  }

  const motorCapacity = Math.max(1, Number(plan.serverConfig && plan.serverConfig.hardwareNodes) || blocks.length);
  chromeMotores.ensureWorkers(motorCapacity, { purge: !adopting });
  try { cellRegistry.setMaestroPid(process.pid); } catch {}

  for (let idx = 0; idx < blocks.length; idx++) {
    const shardNames = blocks[idx] || [];
    const child = await spawnWorker(idx, shardNames);
    children.push(child);
    logger.info('[CLUSTER] Worker iniciado', {
      idx: idx + 1,
      perfis: child.shard ? child.shard.size : shardNames.length,
      pid: child.pid,
      port: child.port,
      adopted: !!child.adopted
    });
  }
  try { cellLifecycle.setStamp(bootStamp); } catch {}
  try {
    cellLifecycle.setTopology({
      divisorGb: plan.serverConfig && plan.serverConfig.workerRamDivisorGb,
      hardwareNodes: plan.serverConfig && plan.serverConfig.hardwareNodes,
      nodes: children.length
    });
  } catch {}

  try {
    const watch = setInterval(() => {
      if (isShuttingDown) return;
      for (let i = 0; i < children.length; i++) {
        const c = children[i];
        if (!c || c.deadHandled) continue;
        if (!cellRegistry.pidAlive(c.pid)) {
          onCellDeath(i, { code: null, signal: 'pid_gone', pid: c.pid });
        }
      }
    }, 2500);
    if (watch && typeof watch.unref === 'function') watch.unref();
  } catch {}

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
  const STATUS_CACHE_MS = Math.max(0, parseInt(process.env.CLUSTER_STATUS_CACHE_MS || '4500', 10) || 4500);
  let statusAggCache = { at: 0, value: null };
  let statusAggInflight = null;

  async function sendTo(idx, type, payload, { timeoutMs = 20000 } = {}) {
    const child = children[idx];
    if (!child) return { ok: false, error: 'child_not_found' };
    const msgId = newMsgId();
    const p = new Promise((resolve) => {
      child.pending.set(msgId, { resolve });
      try {
        if (typeof child.netSend === 'function') {
          if (!child.netSend({ type, payload, msgId })) throw new Error('send_failed');
        } else {
          throw new Error('cell_socket_missing');
        }
      } catch (e) {
        child.pending.delete(msgId);
        resolve({ ok: false, error: e && e.message ? e.message : 'send_failed' });
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
      tasks.push(
        sendTo(i, 'set-shard', { names: shardNames }, { timeoutMs: 20000 }).then(() => {
          try {
            cellRegistry.upsertCell({
              idx: i,
              pid: children[i] && children[i].pid,
              port: children[i] && children[i].port,
              shard: shardNames
            });
          } catch {}
        })
      );
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

    if (growPlan.newWorkerIndexes && growPlan.newWorkerIndexes.length) {
      const motorCapacity = Math.max(
        1,
        Number(livePlan.serverConfig && livePlan.serverConfig.hardwareNodes) || desiredNodes
      );
      chromeMotores.ensureWorkers(motorCapacity, { purge: false });
    }
    for (const idx of growPlan.newWorkerIndexes) {
      const shardNames = growPlan.nextShards[idx] || [];
      const child = await spawnWorker(idx, shardNames);
      children.push(child);
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
      const bypass = !!(opts && (opts.bypassStatusCache === true || opts.fresh === true));
      const nowTs = Date.now();
      if (!bypass && STATUS_CACHE_MS > 0 && statusAggCache.value && (nowTs - statusAggCache.at) < STATUS_CACHE_MS) {
        return statusAggCache.value;
      }
      if (!bypass && STATUS_CACHE_MS > 0 && statusAggInflight) {
        return statusAggInflight;
      }
      const runAgg = (async () => {
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

      let autoModePick = null;
      let sysPick = null;
      let serverConfigPick = null;
      let buildPick = null;
      let lastEngineEvent = null;
      let lastEngineEventAt = null;
      const nodesDebug = [];
      let combinedRobes = {};
      let combinedQueue = [];
      const warningParts = [];
      const missingIdx = [];

      const applyPayload = (payload, source, i, ageMs) => {
        if (!payload || !Array.isArray(payload.perfis)) return false;
        try {
          nodesDebug.push({
            node: i + 1,
            source,
            ok: true,
            journalAgeMs: (typeof ageMs === 'number') ? ageMs : null,
            pid: payload && payload._debug ? payload._debug.pid : null,
            buildTag: payload && payload._debug ? (payload._debug.buildTag || null) : null,
            controllersCount: payload && payload._debug ? payload._debug.controllersCount : null,
            shardSize: payload && payload._debug ? payload._debug.shardSize : null
          });
        } catch {}
        for (const p of payload.perfis || []) {
          const dst = baseMap.get(p.nome);
          if (dst) Object.assign(dst, p);
        }
        if (payload.robes && typeof payload.robes === 'object') {
          combinedRobes = Object.assign(combinedRobes, payload.robes);
        }
        if (Array.isArray(payload.robeQueue)) {
          combinedQueue.push(...payload.robeQueue);
        }
        if (!sysPick && payload.sys) sysPick = payload.sys;
        if (!autoModePick && payload.autoMode) autoModePick = payload.autoMode;
        if (!serverConfigPick && payload.serverConfig) serverConfigPick = payload.serverConfig;
        if (!buildPick && payload.build) buildPick = payload.build;
        if (lastEngineEvent == null && payload.last_engine_event != null) lastEngineEvent = payload.last_engine_event;
        if (lastEngineEventAt == null && payload.last_engine_event_at != null) lastEngineEventAt = payload.last_engine_event_at;
        return true;
      };

      for (let i = 0; i < children.length; i++) {
        const fb = readNodeStatusFile(i);
        if (fb && fb.json && Array.isArray(fb.json.perfis)) {
          const ageSec = Math.round((fb.ageMs || 0) / 1000);
          applyPayload(fb.json, `journal(${ageSec}s)`, i, fb.ageMs);
          if (fb.ageMs > MAX_FILE_AGE_MS) {
            warningParts.push(`node${i + 1}: journal_stale(${ageSec}s)`);
          }
        } else {
          missingIdx.push(i);
          try { nodesDebug.push({ node: i + 1, source: 'none', ok: false }); } catch {}
        }
      }

      // RPC só se o jornal daquele node ainda não existe (boot). Com jornal no disco, não cutuca o worker.
      if (missingIdx.length) {
        try {
          logger.info('[CLUSTER][STATUS] jornal ausente, rpc só nesses nodes', {
            nodes: missingIdx.map((i) => i + 1)
          });
        } catch {}
        const rpcResults = await Promise.allSettled(
          missingIdx.map((i) => sendTo(i, 'get-status', {}, { timeoutMs: STATUS_TIMEOUT_MS }).then((v) => ({ i, v })))
        );
        for (const r of rpcResults) {
          if (r.status !== 'fulfilled' || !r.value) {
            warningParts.push('rpc_boot_fail');
            continue;
          }
          const i = r.value.i;
          const payload = r.value.v;
          if (payload && Array.isArray(payload.perfis)) {
            const di = nodesDebug.findIndex((n) => n && n.node === (i + 1) && n.ok === false);
            if (di >= 0) nodesDebug.splice(di, 1);
            applyPayload(payload, 'rpc_boot', i, null);
          } else {
            warningParts.push(`node${i + 1}: no_journal`);
          }
        }
      }

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
        autoMode: autoModePick || null,
        sys: sysPick || null,
        serverConfig: serverConfigPick || null,
        build: buildPick || null,
        last_engine_event: lastEngineEvent,
        last_engine_event_at: lastEngineEventAt,
        ts: Date.now(),
        _debug: { nodes: nodesDebug, source: 'journal' }
      };
      try { out.provisionLock = provisionLock.get(); } catch { out.provisionLock = null; }
      if (warningParts.length) out.warning = `partial nodes: ${warningParts.join('; ')}`;

      try {
        const aggPath = path.join(__dirname, '..', 'dados', 'status.json');
        fileStore.writeJsonAtomic(aggPath, out);
      } catch {}

      statusAggCache = { at: Date.now(), value: out };
      return out;
      })();
      if (!bypass && STATUS_CACHE_MS > 0) {
        statusAggInflight = runAgg.finally(() => { statusAggInflight = null; });
      }
      return runAgg;
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

  async function detach() {
    isShuttingDown = true;
    try { if (standbySweep && typeof standbySweep.stop === 'function') standbySweep.stop(); } catch {}
    try { perfisWatcher && perfisWatcher.close && perfisWatcher.close(); } catch {}
    for (const c of children) {
      try { if (c.socket) c.socket.destroy(); } catch {}
      c.socket = null;
      c.netSend = null;
    }
    try { cellForensic.append('cell_maestro_detach', { cells: children.length, pids: children.map((c) => c.pid) }); } catch {}
    try { logger.info('[CLUSTER] maestro detach: células seguem vivas', { cells: children.length }); } catch {}
  }

  async function kill() {
    isShuttingDown = true;
    try { if (standbySweep && typeof standbySweep.stop === 'function') standbySweep.stop(); } catch {}
    try { perfisWatcher && perfisWatcher.close && perfisWatcher.close(); } catch {}
    for (const c of children) {
      try { if (c.socket) c.socket.destroy(); } catch {}
    }
    try { cellLifecycle.stopAllCells({ reason: 'maestro_kill' }); } catch {}
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

  return { plan, children, sendWorkerCommand, kill, detach, rebalance, reshuffleFairIfIdle, silentConsole, adopting };
}

module.exports = { createCluster, workerStdioSlots, resolveClusterSilentConsole };