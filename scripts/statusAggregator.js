// statusAggregator.js
// INFRAESTRUTURA OPCIONAL: Este módulo é para agregaçao de status em multi-worker/sharding (cluster). 
// NÃO integrá-lo na pipeline principal de produção sem orquestração direta do Supervisor externo e sem ativação formal do modo cluster!

'use strict';

const { SHARD_COUNT, shards } = require('./master.js');

// Consulta status de todos os shards/workers e agrega em um único objeto status para painel.
async function aggregateStatus(timeoutMs = 6000) {
  // Para cada shard, pede status via IPC e espera a resposta
  function getOneShardStatus(shard, sid) {
    return new Promise((resolve) => {
      let replied = false;
      const handler = (msg) => {
        if (msg && msg.type === 'cluster-status-reply') {
          replied = true;
          resolve({ shard: sid, status: msg.data });
          shard.off('message', handler);
        }
      };
      shard.on('message', handler);
      setTimeout(() => {
        if (!replied) {
          shard.off('message', handler);
          resolve({ shard: sid, status: null });
        }
      }, timeoutMs);
      // Envia o comando "get-status"
      try { shard.send({ type: 'get-status', payload: {}, msgId: Date.now() + '-s' + sid }); } catch {}
    });
  }

  const shardProms = shards.map((sh, i) => getOneShardStatus(sh, i));
  const allStatus = await Promise.all(shardProms);

  // AGREGADOR GERAL
  const global = {
    perfis: [],
    robes: {},
    robeQueue: [],
    // Soma/merge outros campos como autoMode, sys, status por shard.
    // Futuros: autoModeGlobal, sysGlobal, agregados que fizerem sentido
    shards: []
  };

  for (const resp of allStatus) {
    if (resp && resp.status) {
      if (Array.isArray(resp.status.perfis)) global.perfis.push(...(resp.status.perfis || []));
      if (typeof resp.status.robes === "object" && resp.status.robes) {
        for (const [k, v] of Object.entries(resp.status.robes)) global.robes[k] = v;
      }
      if (Array.isArray(resp.status.robeQueue)) global.robeQueue.push(...resp.status.robeQueue);
      // Guarda status extra por shard, opcional:
      global.shards.push({
        id: resp.shard,
        robeQueue: resp.status.robeQueue || [],
        sys: resp.status.sys || null,
        autoMode: resp.status.autoMode || null
      });
    }
  }

  // Exemplo de agregação avançada (opcional):
  // Calcule autoMode global como o modo predominante
  let countFull = 0, countLight = 0;
  for (const s of global.shards) {
    if (s.autoMode && s.autoMode.mode === "light") countLight++;
    else if (s.autoMode && s.autoMode.mode === "full") countFull++;
  }
  if (countLight > countFull) global.autoModeGlobal = "light";
  else if (countFull > countLight) global.autoModeGlobal = "full";
  else global.autoModeGlobal = "mixed";

  // Pode somar sys. Exemplo: RAM_total = sum(shard.sys.freeMB), etc.

  return global;
}

module.exports = {
  aggregateStatus // TODO/SUPERVISOR: Plug aggregateStatus diretamente à interface do Supervisor para consolidar status cross-shard.
};