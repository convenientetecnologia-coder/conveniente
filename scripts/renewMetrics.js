'use strict';

/**
 * Métricas de renovação de classificados (Marketplace).
 * - resetAllRenovadosFlags: zera contadores no INÍCIO do ciclo renew-then-close
 * - aggregateRenovadosFromPerfis: contas + soma de anúncios para flagsAgg
 */

const manifestStore = require('./manifestStore.js');

async function resetAllRenovadosFlags({ fileStore, by = 'renew_then_close' } = {}) {
  if (!fileStore || typeof fileStore.loadPerfisJson !== 'function') {
    return { ok: false, error: 'missing_file_store', cleared: 0, failed: 0, total: 0 };
  }
  const loaded = fileStore.loadPerfisJson();
  const perfis = Array.isArray(loaded) ? loaded : [];
  let cleared = 0;
  let failed = 0;
  const errors = [];
  for (const p of perfis) {
    const nome = String(p && p.nome || '').trim();
    if (!nome) continue;
    try {
      await manifestStore.update(nome, (man) => {
        const next = man || {};
        next.accountFlags = next.accountFlags || {};
        next.accountFlags.renovadosLastCount = 0;
        next.accountFlags.renovadosAt = null;
        next.accountFlags.renovadosResetAt = Date.now();
        next.accountFlags.renovadosResetBy = String(by || 'renew_then_close').slice(0, 120);
        return next;
      });
      cleared += 1;
    } catch (e) {
      failed += 1;
      if (errors.length < 12) {
        errors.push({
          nome,
          error: String((e && e.message) || e).slice(0, 160)
        });
      }
    }
  }
  return {
    ok: true,
    cleared,
    failed,
    total: perfis.length,
    errors
  };
}

function aggregateRenovadosFromPerfis(perfis) {
  const list = Array.isArray(perfis) ? perfis : [];
  let renovados = 0;
  let renovados_qtd = 0;
  for (const p of list) {
    if (!p) continue;
    const n = Math.floor(Number(p.renovadosLastCount || 0) || 0);
    if (!(n > 0)) continue;
    renovados += 1;
    renovados_qtd += n;
  }
  return { renovados, renovados_qtd };
}

module.exports = {
  resetAllRenovadosFlags,
  aggregateRenovadosFromPerfis
};
