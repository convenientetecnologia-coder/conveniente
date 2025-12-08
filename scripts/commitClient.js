// scripts/commitClient.js

'use strict';

const logger = require('./logger.js');

async function commitPedido(perfil, chatId, payload) {
  // PATCH: futuro — envie via HTTP para o sistema externo.
  // Exemplo:
  // const resp = await fetch(EXTERNAL_URL, { method: 'POST', body: JSON.stringify(payload) });
  // if (!resp.ok) return { ok:false, error: `HTTP ${resp.status}` };

  // Atualmente apenas loga e finge sucesso
  logger.info('[COMMIT] pedido enviado', { perfil, chatId, final: payload.final, msgs: (payload.mensagens||[]).length });
  return { ok: true };
}

module.exports = { commitPedido };

