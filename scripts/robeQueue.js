// scripts/robeQueue.js

/**
 * Fila Robe por processo + exclusão cross-process na EXECUÇÃO.
 *
 * Em cluster (N workers), cada worker tem sua própria fila em memória (enqueue local).
 * O status agregado no master concatena as filas.
 *
 * INVARIANTE global: no máximo 1 postagem Robe ativa no host inteiro.
 * Garantida via lock em disco (dados/robe_exec_lock.json), porque cada worker
 * tem o próprio singleton e sem isso dois workers postam em paralelo.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const EXEC_LOCK_PATH = path.join(__dirname, '..', 'dados', 'robe_exec_lock.json');
const EXEC_LOCK_STALE_MS = Math.max(
  5 * 60 * 1000,
  Number(process.env.ROBE_EXEC_LOCK_STALE_MS || 45 * 60 * 1000) || 45 * 60 * 1000
);

function _now() {
  return Date.now();
}

function _pidAlive(pid) {
  try {
    const n = Number(pid || 0) || 0;
    if (!n) return false;
    process.kill(n, 0);
    return true;
  } catch {
    return false;
  }
}

function _readLock() {
  try {
    if (!fs.existsSync(EXEC_LOCK_PATH)) return null;
    return JSON.parse(fs.readFileSync(EXEC_LOCK_PATH, 'utf8'));
  } catch {
    return null;
  }
}

function _writeLock(obj) {
  try {
    const dir = path.dirname(EXEC_LOCK_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const tmp = `${EXEC_LOCK_PATH}.${process.pid}.${_now()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8');
    try {
      fs.renameSync(tmp, EXEC_LOCK_PATH);
    } catch {
      fs.copyFileSync(tmp, EXEC_LOCK_PATH);
      try { fs.unlinkSync(tmp); } catch {}
    }
    return true;
  } catch {
    return false;
  }
}

function _clearLockFile() {
  try { fs.unlinkSync(EXEC_LOCK_PATH); } catch {}
}

/**
 * Tenta adquirir exclusão global de execução.
 * @returns {{ ok: true } | { ok: false, reason: string, holder?: object }}
 */
function tryAcquireExecLock(nome) {
  const n = String(nome || '');
  const cur = _readLock();
  const now = _now();
  if (cur) {
    const until = Number(cur.untilMs || 0) || 0;
    const since = Number(cur.sinceMs || 0) || 0;
    const pid = Number(cur.pid || 0) || 0;
    const stale =
      (until > 0 && until < now) ||
      (since > 0 && (now - since) > EXEC_LOCK_STALE_MS) ||
      (pid > 0 && !_pidAlive(pid));
    if (!stale) {
      // Mesmo pid (reentrada do mesmo worker após crash parcial): permite retomar.
      if (pid === process.pid && String(cur.nome || '') === n) {
        return { ok: true, reentrant: true };
      }
      return { ok: false, reason: 'busy', holder: cur };
    }
  }
  const lock = {
    pid: process.pid,
    nome: n,
    sinceMs: now,
    untilMs: now + EXEC_LOCK_STALE_MS,
    workerShard: process.env.WORKER_SHARD_INDEX || null
  };
  if (!_writeLock(lock)) return { ok: false, reason: 'lock_write_failed' };
  // Confirma que somos o dono (corrida entre workers).
  const check = _readLock();
  if (!check || Number(check.pid || 0) !== process.pid || String(check.nome || '') !== n) {
    return { ok: false, reason: 'lost_race', holder: check || null };
  }
  return { ok: true };
}

function releaseExecLock(nome) {
  try {
    const cur = _readLock();
    if (!cur) return;
    if (Number(cur.pid || 0) !== process.pid) return;
    if (nome && String(cur.nome || '') && String(cur.nome) !== String(nome)) return;
    _clearLockFile();
  } catch {}
}

class RobeQueue {
  constructor() {
    this.fila = [];            // [ { nome, cb, timestampQueue } ]
    this.executando = null;    // { nome, cb, startedAt }
    this._tickRunning = false;
    this._pausePredicate = null;
    this._pausedUntil = 0;
  }

  setPausePredicate(fn) {
    // fn(): boolean — quando true, não inicia novas execuções (mantém fila intacta).
    this._pausePredicate = (typeof fn === 'function') ? fn : null;
  }

  enqueue(nome, cb) {
    if (this.inQueue(nome) || this.isActive(nome)) return false;

    this.fila.push({
      nome,
      cb,
      timestampQueue: Date.now()
    });

    this.tick();
    return true;
  }

  skip(nome) {
    this.fila = this.fila.filter((ent) => ent.nome !== nome);
  }

  inQueue(nome) {
    return this.fila.some((ent) => ent.nome === nome);
  }

  isActive(nome) {
    return !!(this.executando && this.executando.nome === nome);
  }

  activeCount() {
    return this.executando ? 1 : 0;
  }

  queueList() {
    const filaWaiting = this.fila.map((ent) => ent.nome);
    if (this.executando) return [this.executando.nome, ...filaWaiting];
    return filaWaiting;
  }

  clear() {
    this.fila = [];
    this.executando = null;
  }

  tick() {
    if (this._tickRunning) return;
    this._tickRunning = true;

    setImmediate(async () => {
      let started = false;
      try {
        try {
          const paused = !!(this._pausePredicate && this._pausePredicate());
          if (paused) {
            this._pausedUntil = Date.now() + 1500;
            this._tickRunning = false;
            setTimeout(() => { try { this.tick(); } catch {} }, 1500);
            return;
          }
        } catch {}

        if (this.executando || this.fila.length === 0) return;

        const peek = this.fila[0];
        if (!peek) return;

        // Cross-process: só um worker executa Robe por vez no host.
        const got = tryAcquireExecLock(peek.nome);
        if (!(got && got.ok)) {
          this._tickRunning = false;
          setTimeout(() => { try { this.tick(); } catch {} }, 2000);
          return;
        }

        const next = this.fila.shift();
        this.executando = { nome: next.nome, startedAt: Date.now() };
        started = true;
        if (process.env.ROBEQUEUE_DEBUG === '1') {
          console.log('[ROBE-QUEUE] Iniciando execução de', next.nome);
        }
        try {
          await Promise.resolve(next.cb());
        } catch (e) {
          try { console.warn('[ROBE-QUEUE] erro no cb', e && e.message); } catch {}
        } finally {
          try { releaseExecLock(next.nome); } catch {}
          this.executando = null;
        }
        this._tickRunning = false;
        this.tick();
        return;
      } finally {
        if (!started) this._tickRunning = false;
      }
    });
  }
}

const robeQueueSingleton = new RobeQueue();
module.exports = robeQueueSingleton;
module.exports.tryAcquireExecLock = tryAcquireExecLock;
module.exports.releaseExecLock = releaseExecLock;
