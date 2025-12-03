'use strict';

// [STUB SEGURO] Implementação mínima do Robe para manter o sistema operacional sem erros.
// Evita postar, aplica um cooldown curto e registra uma linha em issues.

const logger = require('./logger.js');
const issues = require('./issues.js');
const manifestStore = require('./manifestStore.js');

async function startRobe(browser, nome, robePauseMs = 0, workingNames = []) {
  try {
    const pause = robePauseMs || ((15 + Math.floor(Math.random() * 16)) * 60 * 1000); // 15–30min
    await manifestStore.update(nome, (m) => {
      m = m || {};
      const now = Date.now();
      if (!m.robeCooldownUntil || m.robeCooldownUntil < now) {
        m.robeCooldownUntil = now + pause;
        m.robeCooldownRemainingMs = 0;
      }
      return m;
    });
    try { await issues.append(nome, 'mil_action', 'robe_stub_noop'); } catch {}
    logger.info('[ROBE][STUB] execução ignorada (stub ativo)', { nome });
    return { ok: false, error: 'robe_stub_noop' };
  } catch (e) {
    logger.warn('[ROBE][STUB] erro interno no stub', { nome, error: (e && e.message) || e });
    return { ok: false, error: (e && e.message) || String(e) };
  }
}

function robeQueueFilter(nome) {
  return true;
}

module.exports = { startRobe, robeQueueFilter };
