// master.js
// INFRAESTRUTURA OPCIONAL: sharding/cluster não está integrado ao fluxo principal padrão; use apenas sob planejamento e sob comando do supervisor.
// Não altere fluxo principal nem rotinas do worker convencional ainda!

'use strict';

const { fork } = require('child_process');
const path = require('path');
const os = require('os');
const fileStore = require('./fileStore.js');

// CONFIGS — quantos shards/workers (defaults: nº de CPUs ou via env)
const SHARD_COUNT = parseInt(process.env.SHARD_COUNT || String(os.cpus().length), 10);
// Pega todos perfis para distribuir
const allPerfis = fileStore.loadPerfisJson();

function shardIdFor(nome) {
  // Hash estável (pode ser CRC-32, aqui hashCode simples)
  let h = 0;
  for (const c of String(nome)) h = ((h << 5) - h) + c.charCodeAt(0);
  return Math.abs(h) % SHARD_COUNT;
}

// Split perfis entre shards
function computeShardAssignment() {
  const workersPerfis = Array(SHARD_COUNT).fill().map(()=>[]);
  allPerfis.forEach(p => {
    const sid = shardIdFor(p.nome);
    workersPerfis[sid].push(p.nome);
  });
  return workersPerfis;
}

// Processos filhos (shards)
// ATENÇÃO: O array `shards` é gerenciado internamente e só faz sentido se iniciou via `startShards`.
// Não utilizar no fluxo principal. Pronto para integração mas não plugado no boot principal.
const shards = [];
let shardReady = Array(SHARD_COUNT).fill(false);

// Lançar os workers/shards
// ATENÇÃO: startShards existe apenas para orquestração em modo cluster/sharding.
// Não utilize no fluxo padrão; use apenas se a arquitetura migrar para cluster sob planejamento/supervisão.
// TODO/SUPERVISOR: When deploying distributed Supervisor, integrate startShards into main server boot.
function startShards() {
  const workersPerfis = computeShardAssignment();
  for (let i = 0; i < SHARD_COUNT; i++) {
    const env = { ...process.env, SHARD_ID: String(i), SHARD_COUNT: String(SHARD_COUNT), PERFIS: JSON.stringify(workersPerfis[i]) };
    const workerPath = path.join(__dirname, 'worker.js');
    const worker = fork(workerPath, [], { stdio: ['inherit', 'inherit', 'inherit', 'ipc'], env });
    worker.shardId = i;
    worker.perfis = workersPerfis[i];
    worker.lastMsgAt = Date.now();
    shards.push(worker);

    worker.on('message', (msg) => {
      worker.lastMsgAt = Date.now();
      // Opcional: coletar eventos ou repassar para painel
      if (msg && msg.statusReady) shardReady[i] = true;
      // [Bonus] Implementar handler para registrar respostas e comandos se preciso
    });

    worker.on('exit', (code, signal) => {
      console.warn(`[MASTER][SHARD ${i}] morto, code=${code}, signal=${signal}, reiniciando em 2s`);
      shardReady[i] = false;
      setTimeout(() => { /* Implementar respawn igual ao startShards, só para o i */ }, 2000);
      // TODO/SUPERVISOR: Definir política de reinício conforme orquestrador externo
    });
  }
}

// Health monitor por shard
// ATENÇÃO: Health-check dos shards faz sentido apenas quando sharding está ativo por comando externo/supervisão.
setInterval(() => {
  const now = Date.now();
  shards.forEach((shard, i) => {
    if (!shard) return;
    // Checa heartbeat; se passar de 30s, reinicia
    if (now - shard.lastMsgAt > 30000) {
      try { shard.kill('SIGKILL'); } catch {}
      shardReady[i] = false;
    }
  });
}, 15000);

// Comando: agregador de status
// ATENÇÃO: getClusterStatus só deve ser utilizado em contexto de operação em cluster/sharding
// Não utilize em rotina usual ou single-worker!
// TODO/SUPERVISOR: Integrar com event-stream/status centralizados se for adotada a arquitetura de cluster.
async function getClusterStatus() {
  const proms = shards.map((sh, i) =>
    new Promise(resolve => {
      let replied = false;
      const handler = (msg) => {
        if (msg && msg.type === 'cluster-status-reply') {
          replied = true;
          resolve({shard: i, status: msg.data});
          sh.off('message', handler);
        }
      };
      sh.on('message', handler);
      // Timeout de 5s
      setTimeout(() => {
        if (!replied) {
          sh.off('message', handler);
          resolve({shard: i, status: null});
        }
      }, 5000);
      // Envie o comando "get-status"
      try { sh.send({ type: 'get-status', payload: {}, msgId: Date.now() + '-' + i }); } catch {}
    })
  );
  const allStatus = await Promise.all(proms);
  // Montar status global do cluster (concatena arrays, soma/faz merge, etc)
  // Exemplo: { perfis: [...], robes: {...}, robeQueue: [...], ... }
  // Cada worker retorna seu status como JSON igual ao status.json do antigo sistema
  return allStatus.reduce((acc, s) => {
    if (s && s.status && s.status.perfis) {
      acc.perfis.push(...(s.status.perfis || []));
      Object.assign(acc.robes, (s.status.robes || {}));
      acc.robeQueue.push(...(s.status.robeQueue || []));
      // Merge outros campos, autoMode, sys, etc., se desejar
    }
    return acc;
  }, { perfis: [], robes: {}, robeQueue: [] }); // ... outros campos agregados
}

// Comando: dispatcher (rotear por nome do perfil)
// ATENÇÃO: findShardForNome, sendCommandToShard — uso restrito ao ambiente cluster/sharding.
// Não utilizar em produção única ou sem shard; somente sob comando/supervisão caso arquitetura evolua.
// TODO/SUPERVISOR: Integrar dispatcher externo ou camada de API para comandos de cluster.
function findShardForNome(nome) {
  return shardIdFor(nome);
}
async function sendCommandToShard(nome, type, payload, opts) {
  const id = findShardForNome(nome);
  const shard = shards[id];
  if (!shard) throw new Error('shard não iniciado');
  let replied = false;
  return new Promise((resolve) => {
    // Handler para resposta
    const handler = (msg) => {
      if (msg && msg.replyTo === payload.msgId) {
        replied = true;
        resolve(msg.data);
        shard.off('message', handler);
      }
    };
    shard.on('message', handler);
    setTimeout(() => {
      if (!replied) {
        shard.off('message', handler);
        resolve({ ok: false, error: 'timeout shard' });
      }
    }, (opts && opts.timeoutMs) || 15000);
    // Envia comando (tipo+payload)
    try { shard.send({ type, payload, msgId: payload.msgId }); } catch {}
  });
}

// ATENÇÃO: Exporte apenas as funções; uso exclusivo para gerenciamento em cluster/sharding sob futuro/supervisão.
// Não utilizar via index.js, workerClient.js ou outros scripts — responsabilidade exclusiva do Supervisor externo no futuro.
module.exports = {
  startShards,           // Apenas para uso em cluster; não plugado no boot principal
  getClusterStatus,      // Apenas para uso em cluster; pronto para integração com supervisor/orquestrador externo
  sendCommandToShard,    // Apenas para uso em cluster; dispatcher de comandos, não use com worker simples
  findShardForNome,      // Apenas para uso em cluster/sharding
  SHARD_COUNT,
  shards                 // ATENÇÃO: acesso ao array shards só faz sentido após startShards ser executado
};