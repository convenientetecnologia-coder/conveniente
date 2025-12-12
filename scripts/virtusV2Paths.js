'use strict';

/**
 * Virtus V2 - Paths Configuration
 * 
 * Centraliza TODOS os caminhos do Virtus V2 em um único lugar.
 * Isso garante consistência e facilita manutenção.
 * 
 * Regra: NUNCA espalhe path.join() pelo código - sempre use este módulo.
 */

const path = require('path');

const BASE = path.join(__dirname, '..', 'dados', 'virtus_v2');

/**
 * Helper para construir paths dentro do BASE
 */
function p(...parts) {
  return path.join(BASE, ...parts);
}

module.exports = {
  BASE,
  
  // Coleta: estado e histórico coletado
  collectDueDir: (perfil) => p('collect_due', perfil),
  
  collectedInboxDir: (perfil) => p('collected', perfil, 'inbox'),
  collectedProcessingDir: (perfil) => p('collected', perfil, 'processing'),
  collectedDoneDir: (perfil) => p('collected', perfil, 'done'),
  collectedDeadDir: (perfil) => p('collected', perfil, 'dead'),
  
  // Respostas: respostas prontas para enviar
  repliesInboxDir: (perfil) => p('replies', perfil, 'inbox'),
  repliesScheduledDir: (perfil) => p('replies', perfil, 'scheduled'),
  repliesProcessingDir: (perfil) => p('replies', perfil, 'processing'),
  repliesSentDir: (perfil) => p('replies', perfil, 'sent'),
  repliesCanceledDir: (perfil) => p('replies', perfil, 'canceled'),
  repliesDeadDir: (perfil) => p('replies', perfil, 'dead'),
  
  // Estado global: anti-flood persistente
  sendStateFile: (perfil) => p('send_state', `${perfil}.json`),
  
  // Ledgers: append-only para rastreio e idempotência
  sentLedgerFile: (perfil) => p('ledgers', perfil, 'sent.jsonl'),
  llmLedgerFile: (perfil) => p('ledgers', perfil, 'llm.jsonl'),
};

