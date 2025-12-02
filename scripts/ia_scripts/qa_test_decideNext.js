// scripts/ia_scripts/qa_test_decideNext.js

"use strict";
const fs = require('fs');
const path = require('path');
const fsm = require('../virtusFSM.js');

const perfil = 'qa_decide';
const chatId = '001';
const baseDir = path.join(__dirname, '..', '..', 'dados', 'perfis', perfil);
fs.mkdirSync(baseDir, { recursive: true });

(async () => {
  // Reset estado (começa com tudo vazio)
  fsm.patch(perfil, chatId, {
    flags: { greetDone: false },
    funil: { pending: { field: null, askedAt: null, expiresAt: null }, askCounts: {} },
    data: { telefone: null, itens: null, endereco_saida: null, endereco_destino: null, ajudante: null, descricao: null, missing: [] }
  });

  // 1) PRIMEIRA CHAMADA: deve selecionar 'saudacao'
  let d1 = fsm.decideNext(perfil, chatId);
  if (!d1 || d1.ask_field !== 'saudacao') {
    console.error('[FAIL] Esperado saudacao como primeiro passo.', d1);
    process.exit(1);
  }
  console.log('[OK] Saudacao primeiro.');

  // 2) Simula que já foi perguntado telefone (pending + askCounts: telefone=1)
  fsm.patch(perfil, chatId, {
    flags: { greetDone: true },
    funil: { pending: { field: 'telefone', askedAt: Date.now(), expiresAt: Date.now() + 600000 }, askCounts: { telefone: 1 } }
  });
  let d2 = fsm.decideNext(perfil, chatId);
  if (d2 && d2.ask_field) {
    console.error('[FAIL] Não deveria perguntar pendente repetido enquanto TTL vigente. d2=', d2);
    process.exit(1);
  }
  console.log('[OK] Anti-spam de re-ask pendente funcionando.');

  // 3) Simula cliente preenchendo telefone (pendingField = null), deve perguntar próximo step
  fsm.patch(perfil, chatId, {
    data: { telefone: '48999998888', itens: null, endereco_saida: null, endereco_destino: null, ajudante: null, descricao: null, missing: ['itens', 'endereco_saida', 'endereco_destino'] },
    funil: { pending: { field: null, askedAt: null, expiresAt: null }, askCounts: { telefone: 1 } }
  });
  let d3 = fsm.decideNext(perfil, chatId);
  if (!d3 || d3.ask_field !== 'itens') {
    console.error('[FAIL] Esperado ' + d3.ask_field + ' como próximo passo após telefone.', d3);
    process.exit(1);
  }
  console.log('[OK] Step avança determinístico após campo preenchido.');

  // 4) Cliente já informou tudo (sem missing), directive.shouldReply deve ser false
  fsm.patch(perfil, chatId, {
    data: { telefone: '48999998888', itens: 'Sofá', endereco_saida: 'Kobrasol', endereco_destino: 'Centro', ajudante: true, descricao: 'Só isso', missing: [] },
    funil: { pending: { field: null, askedAt: null, expiresAt: null }, askCounts: { telefone: 1, itens: 1, endereco_saida: 1, endereco_destino: 1 } }
  });
  let d4 = fsm.decideNext(perfil, chatId);
  if (d4 && d4.shouldReply !== false) {
    console.error('[FAIL] Expect shouldReply false quando tudo preenchido/removal feito.', d4);
    process.exit(1);
  }
  console.log('[OK] Funil fecha corretamente, shouldReply false em finalizado.');

  console.log('QA decideNext: PASS');

  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });