// scripts/robeQueue.js

/**
 * Fila Robe por processo (1 singleton por worker).
 *
 * Em cluster (N workers), cada worker tem sua própria fila em memória.
 * O status agregado no master concatena as filas.
 *
 * Contrato:
 * - no máximo 1 postagem Robe ativa POR WORKER;
 * - N workers ⇒ até N postagens em paralelo no host (1 por shard);
 * - sem lock host-wide (não serializa o cluster inteiro).
 */

'use strict';

class RobeQueue {
  constructor() {
    this.fila = [];            // [ { nome, cb, timestampQueue } ]
    this.executando = null;    // { nome, startedAt }
    this._tickRunning = false;
    this._pausePredicate = null;
    this._idleHook = null;
  }

  setPausePredicate(fn) {
    // fn(): boolean — quando true, não inicia novas execuções (mantém fila intacta).
    this._pausePredicate = (typeof fn === 'function') ? fn : null;
  }

  setIdleHook(fn) {
    this._idleHook = (typeof fn === 'function') ? fn : null;
  }

  _emitIdle() {
    try { if (this._idleHook) this._idleHook(); } catch {}
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
            // Event-driven: o release chama tick(). Sem poll de 1500ms.
            this._tickRunning = false;
            return;
          }
        } catch {}

        // 1 por worker: se já tem execução local, não puxa a próxima.
        if (this.executando || this.fila.length === 0) {
          if (!this.executando) this._emitIdle();
          return;
        }

        const next = this.fila.shift();
        if (!next) return;

        this.executando = { nome: next.nome, startedAt: Date.now() };
        started = true;
        if (process.env.ROBEQUEUE_DEBUG === '1') {
          console.log('[ROBE-QUEUE] Iniciando execução de', next.nome, {
            shard: process.env.WORKER_SHARD_INDEX || null,
            pid: process.pid
          });
        }
        try {
          await Promise.resolve(next.cb());
        } catch (e) {
          try { console.warn('[ROBE-QUEUE] erro no cb', e && e.message); } catch {}
        } finally {
          this.executando = null;
        }
        this._tickRunning = false;
        this._emitIdle();
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
