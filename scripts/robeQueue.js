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
    // Nenhum callback ou código externo pode mexer diretamente na fila
    this.fila = this.fila.filter(ent => ent.nome !== nome);
    // Não remove se já está "executando"
    if (this.executando && this.executando.nome === nome) {
      // Opcional: cancelar execução ativa? (Depende do Robe trabalhar com timeout/cancelamento)
    }
  }

  inQueue(nome) {
    return this.fila.some(ent => ent.nome === nome);
  }

  isActive(nome) {
    return this.executando && this.executando.nome === nome;
  }

  activeCount() {
    // INVARIANTE: Nunca haverá mais de uma execução ativa da Robe no sistema.
    // (Só 1 Robe postando a qualquer momento!)
    // Garantia reforçada: só pode retornar 0 ou 1.
    return this.executando ? 1 : 0;
  }

  queueList() {
    const filaWaiting = this.fila.map(ent => ent.nome);
    if (this.executando) return [this.executando.nome, ...filaWaiting];
    return filaWaiting;
  }

  clear() {
    // Toda alteração de fila/executando ocorre APENAS via métodos oficiais!
    this.fila = [];
    this.executando = null;
  }

  tick() {
    if (this._tickRunning) return; // Impede execução concorrente
    this._tickRunning = true;

    setImmediate(async () => {
      try {
        // INVARIANTE: Nunca haverá mais de uma execução ativa da Robe no sistema.
        // O tick só avança após cb finalizar.
        if (!this.executando && this.fila.length > 0) {
          // Pega o próximo da fila
          const next = this.fila.shift();
          this.executando = { nome: next.nome, startedAt: Date.now() };
          if (process.env.ROBEQUEUE_DEBUG === '1') {
            console.log('[ROBE-QUEUE] Iniciando execução de', next.nome);
          }
          try {
            await Promise.resolve(next.cb());
          } catch (e) {
            // O callback do Robe sempre precisa dar catch aos próprios erros!
            try { console.warn('[ROBE-QUEUE] erro no cb', e && e.message); } catch {}
          }
          // Sempre set executando = null; antes de chamar novo tick!
          this.executando = null;
          // Chama tick recursivo para partir para o próximo (se houver)
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