// scripts/robeQueue.js

/**
 * Controle global da Fila Robe — ultra robusto, thread-safe para múltiplos navegadores rodando em paralelo.
 * Permite apenas 1 postagem Robe ativa por vez no sistema todo, independente de quantos navegadores.
 *
 * Modo de uso (import no worker.js):
 * const robeQueue = require('./robeQueue.js');
 *
 * robeQueue.enqueue(nome, callback) — adiciona o perfil "nome" na fila, executa callback exclusivo quando chegar a vez dele.
 * robeQueue.skip(nome) — remove da fila se ainda não executou.
 * robeQueue.inQueue(nome) — retorna true/false se está na fila (em qualquer status).
 * robeQueue.isActive(nome) — true se está executando agora.
 * robeQueue.activeCount() — quantidade de ativação simultânea (sempre 0 ou 1).
 * robeQueue.queueList() — retorna array dos nomes na fila de espera (ordem).
 * robeQueue.clear() — limpa toda a fila, inclusive ativa.
 * robeQueue.cancelActive(nome) — ativa sinal de cancelamento para o Robe ativo com esse nome.
 * robeQueue.isCanceled(nome) — retorna true/false se cb do Robe com esse nome foi sinalizado para cancel.
 * robeQueue.clearCancel(nome) — limpa sinalização de cancelamento depois que callback detectou e retornou.
 *
 * ATENÇÃO: Em cenário multi-worker/sharding, instanciar a fila unicamente no master/shard supervisor,
 * ou converter queue para fila distribuída/coordenada.
 *
 * IMPORTANTE PARA AMBIENTE CLUSTER:
 * Este singleton da fila deve ser centralizado e instanciado/apontado apenas no supervisor/master.
 * Não utilizar múltiplas instâncias (uma por worker) ou haverá quebras da invariante de exclusividade!
 * Se portar para cluster, garantir design de fila única coordenada.
 */

class RobeQueue {
  constructor() {
    this.fila = [];            // [ { nome, cb, timestampQueue } ]
    this.executando = null;    // { nome, cb, startedAt }
    this._tickRunning = false;
    this._cancelMap = new Set();   // nomes sinalizados para cancelamento cooperativo
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
    // Remove da fila se ainda não foi executado
    this.fila = this.fila.filter(ent => ent.nome !== nome);
    // Não remove se já está "executando"
    // Cancelamento real é cooperativo (via cancelActive/isCanceled)
  }

  inQueue(nome) {
    return this.fila.some(ent => ent.nome === nome);
  }

  isActive(nome) {
    return this.executando && this.executando.nome === nome;
  }

  activeCount() {
    return this.executando ? 1 : 0;
  }

  queueList() {
    const filaWaiting = this.fila.map(ent => ent.nome);
    if (this.executando) return [this.executando.nome, ...filaWaiting];
    return filaWaiting;
  }

  clear() {
    this.fila = [];
    this.executando = null;
    this._cancelMap.clear();
  }

  /**
   * Sinaliza para o Robe ativo com esse nome que ele deve cancelar (cooperativo).
   */
  cancelActive(nome) {
    if (this.executando && this.executando.nome === nome) {
      this._cancelMap.add(nome);
    }
  }

  /**
   * Retorna true se este Robe ativo está sinalizado para cancelar, false caso contrário.
   */
  isCanceled(nome) {
    return this._cancelMap.has(nome);
  }

  /**
   * Limpa sinalização de cancelamento para esse nome (deve ser chamada pelo callback ao sair).
   */
  clearCancel(nome) {
    this._cancelMap.delete(nome);
  }

  tick() {
    if (this._tickRunning) return;
    this._tickRunning = true;

    setImmediate(async () => {
      try {
        // Exclusão: só 1 Robe ativo
        if (!this.executando && this.fila.length > 0) {
          const next = this.fila.shift();
          this.executando = { nome: next.nome, startedAt: Date.now() };
          if (process.env.ROBEQUEUE_DEBUG === '1') {
            console.log('[ROBE-QUEUE] Iniciando execução de', next.nome);
          }
          try {
            await Promise.resolve(next.cb());
          } catch (e) {
            try { console.warn('[ROBE-QUEUE] erro no cb', e && e.message); } catch {}
          }
          this.executando = null;
          this._cancelMap.delete(next.nome);
          this._tickRunning = false;
          this.tick();
          return;
        }
      } finally {
        this._tickRunning = false;
      }
    });
  }
}

const robeQueueSingleton = new RobeQueue();
module.exports = robeQueueSingleton;