// pedidos.js

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const EventEmitter = require('events');
const issues = require('./issues.js');
const { extractOrderFieldsLLM } = require('./iaExtractors.js');
const fileStore = require('./fileStore.js');
const promptFretes = require('./promptFretes.js');
const { chatCompletion } = require('./inteligenciaArtificial.js');

function sha1(str) {
  return crypto.createHash('sha1').update(String(str || ''), 'utf8').digest('hex');
}
const MAX_ASK_RETRIES = parseInt(process.env.MAX_ASK_RETRIES || '3', 10);
const PHONE_ASK_COOLDOWN_MS = parseInt(process.env.PHONE_ASK_COOLDOWN_MS || '120000', 10); // 2 min de cooldown para pedir telefone/DDD novamente
const FIELD_TTL_MS = parseInt(process.env.FIELD_TTL_MS || '60000', 10); // 60s para expirar um campo perguntado

const ROOT = path.join(__dirname, '..', 'dados', 'perfis');
function stateFile(perfil){ return path.join(ROOT, perfil, 'pedidos_state.json'); }

function ensureDir(p){ try { fs.mkdirSync(path.dirname(p), { recursive:true }); } catch {} }
function acquireFileLock(fp, timeoutMs = 5000) {
  const lf = fp + '.LOCK';
  const start = Date.now();
  while ((Date.now() - start) < timeoutMs) {
    try {
      const fd = fs.openSync(lf, 'wx');
      fs.writeFileSync(fd, String(Date.now()));
      fs.fsyncSync(fd);
      fs.closeSync(fd);
      return true;
    } catch {
      try {
        const st = fs.statSync(lf);
        if ((Date.now() - st.mtimeMs) > 15000) {
          try { fs.unlinkSync(lf); } catch {}
          continue;
        }
      } catch {}
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    }
  }
  return false;
}
function releaseFileLock(fp) {
  const lf = fp + '.LOCK';
  try { fs.unlinkSync(lf); } catch {}
}
function readJsonSafe(file, fb){ try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fb; } }
function writeJsonAtomic(file, obj) {
  try {
    ensureDir(file);
    const tmp = file + '.tmp';
    const fd = fs.openSync(tmp, 'w');
    try { fs.writeFileSync(fd, JSON.stringify(obj, null, 2), 'utf8'); fs.fsyncSync(fd); }
    finally { fs.closeSync(fd); }
    try { fs.unlinkSync(file); } catch {}
    try { fs.renameSync(tmp, file); }
    catch { fs.copyFileSync(tmp, file); try { fs.unlinkSync(tmp); } catch{} }
    return true;
  } catch { return false; }
}

function now(){ return Date.now(); }
function onlyDigits(s){ return String(s||'').replace(/\D/g,''); }
function maskPhone(d) {
  try {
    const s = onlyDigits(d);
    if (s.length >= 10) return `${s.slice(0,2)}****${s.slice(-4)}`;
    if (s.length >= 4) return `**${s.slice(-4)}`;
    return '';
  } catch { return ''; }
}

function computeMissing(data) {
  const d = data || {};
  const missing = [];
  if (!isValidPhoneBR(d.telefone)) missing.push('telefone');
  if (!d.itens) missing.push('itens');
  if (!d.endereco_saida) missing.push('endereco_saida');
  if (!d.endereco_destino) missing.push('endereco_destino');
  return missing;
}
function isValidPhoneBR(d) {
  const s = onlyDigits(d);
  if (s.length === 11) return /^[1-9]{2}9\d{8}$/.test(s);
  if (s.length === 10) return /^[1-9]{2}[2-9]\d{7}$/.test(s);
  return false;
}

function normalizeContent(s) {
  try {
    return String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g,'')
      .replace(/\s+/g,' ').trim().toLowerCase();
  } catch {
    return String(s || '').trim().toLowerCase();
  }
}

function computeClientCursor(historico = []) {
  try {
    const msgs = (Array.isArray(historico) ? historico : []).filter(m => m && m.autor === 'cliente' && String(m.texto || '').trim());
    const count = msgs.length;
    const digest = count ? sha1(msgs.slice(-10).map(m => normalizeContent(m.texto || '')).join('|')) : '';
    const lastNorm = count ? normalizeContent(msgs[count - 1].texto || '') : '';
    const lastTs = count ? Number(msgs[count - 1].timestamp || 0) : 0;
    return { count, digest, lastNorm, lastTs };
  } catch {
    return { count: 0, digest: '', lastNorm: '', lastTs: 0 };
  }
}

function unifyClientMessages(novasMsgs = [], historico = []) {
  // Preferir delta (novas mensagens); fallback para últimas 5 do histórico do cliente
  let blocos = [];

  if (Array.isArray(novasMsgs) && novasMsgs.length) {
    blocos = novasMsgs.filter(m => m && m.autor === 'cliente' && String(m.texto || '').trim()).map(m => String(m.texto || '').trim());
  }

  if (!blocos.length) {
    const base = (Array.isArray(historico) ? historico : []).filter(m => m && m.autor === 'cliente' && String(m.texto || '').trim());
    blocos = base.slice(-5).map(m => String(m.texto || '').trim());
  }

  // Dedup simples dentro do bloco
  const seen = new Set();
  const uniq = [];
  for (const t of blocos) {
    const n = normalizeContent(t);
    if (!n || seen.has(n)) continue;
    seen.add(n);
    uniq.push(t);
  }

  return uniq.join(' ');
}

function detectDoubtsSimple(text) {
  const t = normalizeContent(text || '');
  const duvidas = [];
  if (!t) return duvidas;

  if (/(preco|valor|quanto\s+(custa|fica|sai)|orcamento|cobra)/.test(t)) duvidas.push('Pergunta sobre valor/orçamento');
  if (/(quando|em\s+quanto\s+tempo|que\s+horas|vai\s+me\s+chamar|tempo)/.test(t)) duvidas.push('Pergunta sobre quando o motorista entra em contato');
  if (/(disponivel|ainda\s+tem|tem\s+agora|ta\s+disponivel|tá\s+disponivel)/.test(t)) duvidas.push('Pergunta sobre disponibilidade');
  if (/(como\s+funciona|nao\s+entendi|explica|pode\s+explicar)/.test(t)) duvidas.push('Dúvida de funcionamento');

  return duvidas;
}

function describeAskField(field) {
  switch (String(field || '')) {
    case 'telefone': return 'seu WhatsApp com DDD';
    case 'ddd': return 'apenas o DDD (2 dígitos) do seu WhatsApp';
    case 'telefone_parcial': return 'o número do WhatsApp (sem DDD), com 8 ou 9 dígitos';
    case 'itens': return 'o que você precisa transportar';
    case 'endereco_saida': return 'o endereço de saída (pode ser bairro/ponto de referência)';
    case 'endereco_destino': return 'o endereço de destino (pode ser bairro/ponto de referência)';
    case 'ajudante': return 'se precisa de ajudante (sim ou não)';
    case 'descricao': return 'alguma observação breve (opcional)';
    default: return '';
  }
}

function buildUserOrchestrationPrompt({ clienteUnificado = '', dados = {}, faltantes = [], duvidas = [], proximaPergunta = '', instrucoes = [] } = {}) {
  const dataView = {
    itens: !!(dados && dados.itens),
    endereco_saida: !!(dados && dados.endereco_saida),
    endereco_destino: !!(dados && dados.endereco_destino),
    ajudante: (typeof (dados && dados.ajudante) === 'boolean') ? String(dados.ajudante) : 'indefinido',
    telefone: isValidPhoneBR(dados && dados.telefone) ? 'presente' : 'ausente',
    ddd: (dados && /^[1-9]\d$/.test(String(dados.ddd || ''))) ? 'presente' : 'ausente',
    telefone_parcial: (dados && /^\d{8,9}$/.test(String(dados.telefone_parcial || ''))) ? 'presente' : 'ausente',
    cidade: (dados && dados.cidade) ? 'presente' : 'ausente'
  };

  const faltas = (faltantes || []).slice(0);
  const proxLabel = describeAskField(proximaPergunta);

  const lines = [];
  lines.push('Mensagens do cliente (unificadas):');
  lines.push(clienteUnificado ? `"""${clienteUnificado}"""` : '"""(sem conteúdo adicional)"""');
  lines.push('');
  lines.push('Dados já coletados (apenas sinalizar se presentes/ausentes):');
  lines.push(JSON.stringify(dataView));
  lines.push('');
  lines.push('Falta coletar (ordem do funil):');
  lines.push(faltas.length ? faltas.join(', ') : 'nada');
  lines.push('');
  lines.push('Dúvidas detectadas:');
  lines.push(duvidas.length ? ('- ' + duvidas.join('\n- ')) : 'nenhuma');
  lines.push('');
  lines.push('Próxima pergunta obrigatória:');
  lines.push(proxLabel || 'nenhuma');
  lines.push('');
  lines.push('Instruções:');
  lines.push('- Responda às dúvidas de forma breve e objetiva (sem inventar).');
  lines.push('- Sempre finalize com a próxima pergunta do funil (não envie mensagem apenas tirando dúvidas).');
  lines.push('- Seja humano, simpático e direto; varie micro expressões e evite repetir frases.');
  lines.push('Produza UMA ÚNICA mensagem. Nada de segunda mensagem, lembrete, "aguarde", "vou te chamar" ou "já volto".');
  lines.push('Na mesma mensagem, componha: 1) responda dúvidas/protestos em 1–2 frases; 2) faça APENAS a pergunta indicada nas instruções do funil (não peça WhatsApp nem repita a frase do motorista/WhatsApp a menos que as instruções digam explicitamente); 3) finalize.');
  lines.push('Jamais ecoe ou confirme o que o cliente disse; não use "entendi", "vi que", "obrigado pelos dados", "certo, você informou...".');
  lines.push('Proibido repetir a explicação do orçamento/via motorista/WhatsApp depois da primeira resposta.');
  lines.push('Se já recebemos número sem DDD, peça APENAS o que faltar (DDD ou número sem DDD), conforme instruções.');
  lines.push('Não quebre em mensagens separadas — conteúdo todo em uma única mensagem.');
  for (const i of (instrucoes || [])) lines.push('- ' + i);

  return lines.join('\n');
}

/* ===================== INÍCIO — ADIÇÕES DETERMINÍSTICAS DE FLUXO ===================== */

/**
 * Normaliza texto (sem acentos, lower) para match robusto.
 */
function _norm(s) { try { return String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase(); } catch { return String(s || '').toLowerCase(); } }

/**
 * Intenção de preço — usado para disparar pedido de WhatsApp "já".
 */
const PRICE_INTENT_RE = /(pre[cç]o|valor|quanto\s+(custa|fica|sai)|cobra|or[cç]amento)/i;
function hasPriceIntent(text) {
  const t = _norm(text || '');
  return /(preco|valor|quanto\s+(custa|fica|sai)|cobra|orcamento)/.test(t);
}

const ALLOWED_ASK_FIELDS = Object.freeze([
  'itens',
  'endereco_saida',
  'endereco_destino',
  'ajudante',
  'ddd',
  'telefone_parcial',
  'telefone',
  'descricao'
]);

function getNextAskField(d = {}) {
  const telValido = isValidPhoneBR(d && d.telefone);
  const hasParcial = /^\d{8,9}$/.test(String((d && d.telefone_parcial) || ''));
  const hasDDD = /^[1-9]\d$/.test(String((d && d.ddd) || ''));

  if (!telValido) {
    if (hasParcial && !hasDDD) return 'ddd';
    if (hasDDD && !hasParcial) return 'telefone_parcial';
    return 'telefone';
  }

  if (!d.itens) return 'itens';
  if (!d.endereco_saida) return 'endereco_saida';
  if (!d.endereco_destino) return 'endereco_destino';
  if (typeof d.ajudante !== 'boolean') return 'ajudante';
  return null;
}

function shouldAskWhatsappFirst({ historicoNovo = [], dataAtual = {} } = {}) {
  const telOk = isValidPhoneBR(dataAtual && dataAtual.telefone);
  return !telOk; // sempre priorize WhatsApp até ter telefone válido
}

function removeTelefonesCompletos(texto) {
  try { return String(texto||'').replace(/\b\d{8,11}\b/g, '******'); } catch { return String(texto||''); }
}

function buildInstrucoesFromDirective({ directive, snapshotData = {}, firstReply = false, novasMsgs = [] }) {
  const instr = [];

  if (firstReply) {
    instr.push('Cumprimente de forma calorosa e humana (ex.: "Olá! Que bom falar contigo 😊").');
  }
  // A frase do orçamento SÓ APARECE quando estiver pedindo telefone (primeira ou não)
  if (directive && directive.askField === 'telefone') {
    instr.push('Inclua exatamente uma vez a frase: "O valor exato é passado pelo motorista no WhatsApp assim que coletarmos seus dados. Repasso para ele, e você recebe o orçamento certinho."');
  }
  if (!firstReply) {
    instr.push('Não use saudação (oi/olá/bom dia/boa tarde/boa noite). Vá direto ao ponto.');
  }

  const perguntas = (Array.isArray(novasMsgs) ? novasMsgs : [])
    .map(m => (m && m.texto ? String(m.texto) : ''))
    .filter(t => /\?/.test(t))
    .slice(0, 3);
  if (perguntas.length > 0) {
    instr.push('Responda de forma objetiva às perguntas do cliente (não invente informações).');
  } else {
    instr.push('Se houver algo a esclarecer na mensagem do cliente, responda de forma breve.');
  }

  const textoJanela = (Array.isArray(novasMsgs) ? novasMsgs : [])
    .map(m => (m && m.texto ? String(m.texto) : ''))
    .join(' ')
    .toLowerCase();
  const perguntouTempo = /quanto\s+tempo|quando|que\s+horas|vai\s+me\s+chamar|em\s+quanto/.test(textoJanela);
  if (perguntouTempo) {
    instr.push('Se perguntarem quando o motorista vai chamar, responda apenas: "em alguns minutinhos".');
  }

  if (directive && directive.askField) {
    if (directive.askField === 'telefone') {
      const temParcial = !!(snapshotData && snapshotData.telefone_parcial);
      const temDDD = !!(snapshotData && snapshotData.ddd);
      if (temParcial && !temDDD) {
        instr.push('Peça APENAS o DDD (2 dígitos) para completar o WhatsApp. Não repita nem reformule o número do cliente.');
      } else if (temDDD && !temParcial) {
        instr.push('Peça APENAS o número do WhatsApp (sem DDD), com 8 ou 9 dígitos.');
      } else {
        instr.push('Peça o WhatsApp com DDD em uma única frase curta. Sem explicação do fluxo do motorista.');
      }
      instr.push('Tudo em UMA mensagem única junto com a próxima pergunta obrigatória.');
    }
    if (directive.askField === 'ddd') {
      instr.push('Peça APENAS o DDD (2 dígitos) para completar o WhatsApp. Não repita o número do cliente.');
      instr.push('Tudo em UMA mensagem única junto com a próxima pergunta obrigatória.');
    }
    if (directive.askField === 'telefone_parcial') {
      instr.push('Peça APENAS o número do WhatsApp (sem DDD), com 8 ou 9 dígitos. Não repita o número do cliente.');
      instr.push('Tudo em UMA mensagem única junto com a próxima pergunta obrigatória.');
    }
    if (directive.askField === 'itens') {
      instr.push('Pergunte o que precisa transportar (itens).');
    }
    if (directive.askField === 'endereco_saida') {
      instr.push('Pergunte o endereço de saída (pode ser informal: bairro, ponto de referência).');
    }
    if (directive.askField === 'endereco_destino') {
      instr.push('Pergunte o endereço de destino (pode ser informal).');
    }
    if (directive.askField === 'ajudante') {
      instr.push('Pergunte se precisa de ajudante (resposta sim ou não).');
    }
    if (directive.askField === 'descricao') {
      instr.push('Pergunte se há alguma observação breve sobre a coleta/entrega.');
    }

    if (directive.allowSecondQuestion && directive.nextField) {
      if (directive.nextField === 'itens') {
        instr.push('Na sequência, pergunte também o que precisa transportar (itens).');
      }
      if (directive.nextField === 'endereco_saida') {
        instr.push('Na sequência, pergunte também o endereço de saída (pode ser informal).');
      }
      if (directive.nextField === 'endereco_destino') {
        instr.push('Na sequência, pergunte também o endereço de destino (pode ser informal).');
      }
    }
  }

  instr.push('Jamais ecoe ou confirme o que o cliente disse; não use "entendi", "vi que", "obrigado pelos dados".');
  instr.push('Não repita números de telefone do cliente no texto.');
  instr.push('Não crie perguntas além das listadas.');
  instr.push('Seja breve, humano e profissional.');

  return instr;
}

/* ===================== FIM — ADIÇÕES DETERMINÍSTICAS DE FLUXO ===================== */

// [PATCH-ABERTURA] — constrói mensagens determinísticas calorosas e aplica guardrails

function _isAskingPhoneDirective(directive) {
  return directive && String(directive.askField || '') === 'telefone';
}

function _nextNonPhoneMissing(d) {
  if (!d || !d.itens) return 'itens';
  if (!d.endereco_saida) return 'endereco_saida';
  if (!d.endereco_destino) return 'endereco_destino';
  if (typeof d.ajudante !== 'boolean') return 'ajudante';
  return null;
}

function _humanGreet() {
  const variants = [
    'Olá! Que bom falar contigo 😊',
    'Oi! Que bom te atender agora',
    'Olá! Feliz em te ajudar'
  ];
  return variants[Math.floor(Math.random() * variants.length)];
}

function _askPhoneLine(d) {
  const hasFull = isValidPhoneBR(d && d.telefone);
  const hasDDD = /^[1-9]\d$/.test(String(d && d.ddd || ''));
  const hasParcial = /^\d{8,9}$/.test(String(d && d.telefone_parcial || ''));
  if (hasFull) return ''; // nada
  if (hasParcial && !hasDDD) return 'Me passa só o DDD do seu WhatsApp (2 dígitos)?';
  if (hasDDD && !hasParcial) return 'Perfeito! E o número do WhatsApp (sem DDD), com 8 ou 9 dígitos, qual é?';
  return 'Pode me passar seu WhatsApp com DDD?';
}

function _askFieldLine(field) {
  switch (String(field||'')) {
    case 'itens': return 'E já me conta: o que vamos transportar?';
    case 'endereco_saida': return 'Qual é o ponto de saída? Pode ser bairro ou referência.';
    case 'endereco_destino': return 'E o destino, para onde vai? Pode ser bairro ou referência.';
    case 'ajudante': return 'Precisa de ajudante para carregar? (sim ou não)';
    default: return '';
  }
}

function buildAberturaImpecavel({ data = {}, nextField = 'itens' } = {}) {
  const greet = _humanGreet();
  const fraseValor = 'O valor exato é passado pelo motorista no WhatsApp assim que coletarmos seus dados — eu repasso pra ele e você recebe o orçamento certinho.';
  const askPhone = _askPhoneLine(data);
  const askNext = _askFieldLine(nextField || 'itens');
  const partes = [
    `${greet} Sim, faço fretes e consigo agilizar.`,
    fraseValor,
    askPhone,
    askNext
  ].filter(Boolean);
  return partes.join(' ');
}

function stripValorFraseIfNotAllowed(texto) {
  try {
    let s = String(texto||'');
    const re = /(o valor (exato )?(ser[aá]|sera|é|eh)\s+(passado|informado)\s+pelo\s+motorista.?(whats|whatsapp)[^.!?][.!?]?)/ig;
    s = s.replace(re, '').replace(/\s+/g, ' ').trim();
    return s;
  } catch { return texto; }
}

function enforceAnswerGuardrails({ texto, directive, firstReply, snapshotData, askCounts }) {
  let out = String(texto||'').trim();

  // Abertura determinística: primeira resposta + pedindo telefone
  if (firstReply && _isAskingPhoneDirective(directive)) {
    const nextField = _nextNonPhoneMissing(snapshotData) || 'itens';
    return buildAberturaImpecavel({ data: snapshotData || {}, nextField });
  }

  // Se a instrução é pedir telefone (mesmo não sendo a primeira), garanta frase de valor + coleta incremental
  if (!firstReply && _isAskingPhoneDirective(directive)) {
    const fraseValor = 'O valor exato é passado pelo motorista no WhatsApp assim que coletarmos seus dados — eu repasso pra ele e você recebe o orçamento certinho.';
    const askPhone = _askPhoneLine(snapshotData || {});
    const nextField = _nextNonPhoneMissing(snapshotData) || null;
    const askNext = nextField ? _askFieldLine(nextField) : '';
    return [fraseValor, askPhone, askNext].filter(Boolean).join(' ');
  }

  // NÃO está coletando telefone: remova qualquer menção de orçamento via motorista/WhatsApp
  if (!_isAskingPhoneDirective(directive)) {
    out = stripValorFraseIfNotAllowed(out);
  }

  // Evitar abertura fria "Sim, podemos ajudar com o frete!" em qualquer turno
  const neutralRe = /^sim,\spodemos\s+ajudar.?o que voc[eê]\s+precisa\s+transportar??$/i;
  if (neutralRe.test(out)) {
    const variants = [
      'Claro! Vou agilizar pra você. O que vamos transportar?',
      'Perfeito! Me diz o que vamos levar?',
      'Show! Qual item você precisa transportar?'
    ];
    out = variants[(askCounts && askCounts.itens ? askCounts.itens : 0) % variants.length];
  }

  // Se sobrou vazio por qualquer motivo, pergunta a próxima obrigatória
  if (!out) {
    const f = (directive && directive.askField) || _nextNonPhoneMissing(snapshotData) || 'itens';
    out = _askFieldLine(f) || 'Pode me confirmar essa informação, por favor?';
  }

  return out.trim();
}

// [FSM] — definição dos passos do funil e controle total centralizado

const FSM_STEPS = Object.freeze([
  'boas_vindas',
  'info_orcamento',
  'whatsapp_pedido_1',
  'ddd_pedido',
  'whatsapp_parcial_pedido',
  'itens_pedido',
  'end_saida_pedido',
  'end_destino_pedido',
  'ajudante_pedido',
  'lembrete_1',
  'lembrete_2'
]);

function ensureFsmStruct(snap) {
  snap.fsm = snap.fsm || { executedSteps: {}, stepHistory: [], lastStep: null, lastQueuedCursorSig: '', lastRepliedCursorSig: '' };
  snap.fsm.executedSteps = snap.fsm.executedSteps || {};
  snap.fsm.stepHistory = Array.isArray(snap.fsm.stepHistory) ? snap.fsm.stepHistory : [];
  return snap;
}

function proximoPasso(chatState, dados) {
  const s = ensureFsmStruct(chatState);
  const ex = s.fsm.executedSteps || {};
  const telOk = isValidPhoneBR(dados && dados.telefone);
  const hasDDD = /^[1-9]\d$/.test(String(dados && dados.ddd || ''));
  const hasParcial = /^\d{8,9}$/.test(String(dados && dados.telefone_parcial || ''));

  if (!ex.boas_vindas) return 'boas_vindas';
  if (!telOk && !ex.info_orcamento && !ex.whatsapp_pedido_1) return 'info_orcamento';
  if (!telOk && !ex.whatsapp_pedido_1 && !hasDDD && !hasParcial) return 'whatsapp_pedido_1';
  if (!telOk && hasParcial && !hasDDD && !ex.ddd_pedido) return 'ddd_pedido';
  if (!telOk && hasDDD && !hasParcial && !ex.whatsapp_parcial_pedido) return 'whatsapp_parcial_pedido';
  if (!dados.itens && !ex.itens_pedido) return 'itens_pedido';
  if (!dados.endereco_saida && !ex.end_saida_pedido) return 'end_saida_pedido';
  if (!dados.endereco_destino && !ex.end_destino_pedido) return 'end_destino_pedido';
  if (typeof dados.ajudante !== 'boolean' && !ex.ajudante_pedido) return 'ajudante_pedido';
  const faltam = computeMissing(dados);
  if (faltam.length > 0) {
    if (!ex.lembrete_1) return 'lembrete_1';
    if (!ex.lembrete_2) return 'lembrete_2';
  }
  return null;
}

function registrarPassoExecutado(perfil, chatId, step, { cursorSig = '', text = '' } = {}) {
  const s = orchestrator._get(perfil, chatId) || orchestrator._set(perfil, chatId, {});
  ensureFsmStruct(s);
  s.fsm.executedSteps[step] = true;
  s.fsm.stepHistory.push({ step, at: now(), cursorSig, textHash: sha1(text || '') });
  s.fsm.lastStep = step;
  orchestrator._set(perfil, chatId, s);
}

function gerarMensagemNegocioParaStep(step, dados, chatState) {
  const d = dados || {};
  switch (step) {
    case 'boas_vindas':
      return 'Olá! Que bom falar contigo. Sim, faço fretes e consigo agilizar.';
    case 'info_orcamento':
      return 'O valor exato é passado pelo motorista no WhatsApp assim que coletarmos seus dados — eu repasso para ele e você recebe o orçamento certinho.';
    case 'whatsapp_pedido_1':
      return 'Pode me passar seu WhatsApp com DDD?';
    case 'ddd_pedido':
      return 'Perfeito! Me passa só o DDD do seu WhatsApp (2 dígitos)?';
    case 'whatsapp_parcial_pedido':
      return 'Obrigada! E o número do WhatsApp (sem DDD), com 8 ou 9 dígitos, qual é?';
    case 'itens_pedido':
      return 'O que vamos transportar?';
    case 'end_saida_pedido':
      return 'Qual é o ponto de saída? Pode ser bairro ou referência.';
    case 'end_destino_pedido':
      return 'E o destino, para onde vai? Pode ser bairro ou referência.';
    case 'ajudante_pedido':
      return 'Precisa de ajudante para carregar? (sim ou não)';
    case 'lembrete_1': {
      const faltam = computeMissing(d);
      const foco = (faltam[0] || '').replace('_', ' ');
      return `Fico por aqui te ajudando! Se puder, me envia ${foco} para agilizar.`;
    }
    case 'lembrete_2': {
      const faltam = computeMissing(d);
      const foco = (faltam[0] || '').replace('_', ' ');
      return `Só passando para lembrar: ficou faltando ${foco}. Assim já repasso tudo ao motorista.`;
    }
    default:
      return 'Me confirma essa informação, por favor?';
  }
}

function gerarMensagemNegocio(stepAtual, dados, chatState) {
  const parts = [];
  const ex = ensureFsmStruct(chatState).fsm.executedSteps || {};

  if (stepAtual === 'boas_vindas') {
    parts.push(gerarMensagemNegocioParaStep('boas_vindas', dados, chatState));
    if (!isValidPhoneBR(dados && dados.telefone) && !ex.info_orcamento) {
      parts.push(gerarMensagemNegocioParaStep('info_orcamento', dados, chatState));
      parts.push(gerarMensagemNegocioParaStep('whatsapp_pedido_1', dados, chatState));
    }
    const nextNonPhone = (!dados.itens) ? 'itens_pedido' : (!dados.endereco_saida) ? 'end_saida_pedido' : 'end_destino_pedido';
    if (nextNonPhone) parts.push(gerarMensagemNegocioParaStep(nextNonPhone, dados, chatState));
    return parts.join(' ');
  }

  if (stepAtual === 'info_orcamento') {
    parts.push(gerarMensagemNegocioParaStep('info_orcamento', dados, chatState));
    parts.push(gerarMensagemNegocioParaStep('whatsapp_pedido_1', dados, chatState));
    const nextNonPhone = (!dados.itens) ? 'itens_pedido' : (!dados.endereco_saida) ? 'end_saida_pedido' : 'end_destino_pedido';
    if (nextNonPhone) parts.push(gerarMensagemNegocioParaStep(nextNonPhone, dados, chatState));
    return parts.join(' ');
  }

  return gerarMensagemNegocioParaStep(stepAtual, dados, chatState);
}

function ackReplyQueued(perfil, chatId, cursorSig) {
  const s = orchestrator._get(perfil, chatId) || orchestrator._set(perfil, chatId, {});
  ensureFsmStruct(s);
  s.fsm.lastQueuedCursorSig = String(cursorSig || '');
  orchestrator._set(perfil, chatId, s);
}

function ackReplySent(perfil, chatId, cursorSig) {
  const s = orchestrator._get(perfil, chatId) || orchestrator._set(perfil, chatId, {});
  ensureFsmStruct(s);
  s.fsm.lastRepliedCursorSig = String(cursorSig || '');
  const [cnt, dig] = String(cursorSig || '').split('|');
  if (cnt && dig) {
    s.repliedCursorCount = Number(cnt) || 0;
    s.repliedCursorDigest = dig || '';
  }
  orchestrator._set(perfil, chatId, s);
}

class PedidoOrchestrator extends EventEmitter {
  constructor() {
    super();
    this.cache = new Map(); // perfil -> { chats: { [chatId]: snapshot } }
    this.ticker = setInterval(() => this._tick(), 1000); // timers internos
  }

  _load(perfil) {
    if (this.cache.has(perfil)) return this.cache.get(perfil);
    const file = stateFile(perfil);
    const st = readJsonSafe(file, { chats: {} });
    this.cache.set(perfil, st);
    return st;
  }

  _save(perfil) {
    const st = this.cache.get(perfil) || { chats: {} };
    const file = stateFile(perfil);
    if (!acquireFileLock(file, 3000)) return false;
    try { return writeJsonAtomic(file, st); }
    finally { releaseFileLock(file); }
  }

  _get(perfil, chatId) {
    const st = this._load(perfil);
    return (st.chats && st.chats[chatId]) ? st.chats[chatId] : null;
  }

  _set(perfil, chatId, patch) {
    const st = this._load(perfil);
    const cur = st.chats[chatId] || {
      createdAt: now(), updatedAt: now(),
      data: { itens:null,endereco_saida:null,endereco_destino:null,ajudante:null,telefone:null,ddd:null,telefone_parcial:null,cidade:null,descricao:null },
      flags: { firstIaReplied:false, greetDone:false, finalizedAt:null, finalizationFreezeUntil:null, sentToNotifierAt:null, hasAskedWhats:false, singleInactivityPingSent:false, sentType:null, pendingField: null },
      timers: { startedAt: now(), incompleteWithWhatsDeadline: null, withoutWhatsDeadline: null },
      askCounts: { telefone:0, ddd:0, telefone_parcial:0, itens:0, endereco_saida:0, endereco_destino:0, ajudante:0, descricao:0 },
      lastWhatsAskAt: null,
      missing: []
    };
    const next = Object.assign({}, cur, patch || {});
    next.updatedAt = now();
    // sanitize
    if (!next.data) next.data = cur.data;
    next.missing = computeMissing(next.data);

    // timers coerência (inicia apenas uma vez cada ramo)
    if (next.data && isValidPhoneBR(next.data.telefone)) {
      if (!next.timers.incompleteWithWhatsDeadline) next.timers.incompleteWithWhatsDeadline = now() + 10*60*1000;
      next.timers.withoutWhatsDeadline = null;
  } else {
      if (!next.timers.withoutWhatsDeadline) next.timers.withoutWhatsDeadline = now() + 10*60*1000;
      next.timers.incompleteWithWhatsDeadline = null;
    }

    st.chats[chatId] = next;
    this.cache.set(perfil, st);
    this._save(perfil);
    return next;
  }

  getSnapshot(perfil, chatId) {
    return this._get(perfil, chatId) || {
      data:{}, flags:{}, askCounts:{}, timers:{}, missing:[]
    };
  }

  isFinalized(perfil, chatId) {
    const s = this._get(perfil, chatId);
    if (!s) return false;
    const until = s.flags && s.flags.finalizationFreezeUntil;
    return !!(until && until > now());
  }

  shouldGreetFirstReply(perfil, chatId) {
    const s = this._get(perfil, chatId);
    if (!s) return true;
    const f = s.flags || {};
    return !(f.greetDone || f.firstIaReplied);
  }

  markIaReplied(perfil, chatId) {
    const s = this._get(perfil, chatId);
    if (!s) return;
    s.flags = s.flags || {};
    s.flags.firstIaReplied = true;
    s.flags.greetDone = true;
    this._set(perfil, chatId, s);
  }

  recordAsk(perfil, chatId, field) {
    const s = this._get(perfil, chatId) || this._set(perfil, chatId, {});
    const dataNow = (s && s.data) || {};

    // Remapeia pedido "telefone" para sub-etapas corretas quando já houve progresso parcial
    if (field === 'telefone' && !isValidPhoneBR(dataNow.telefone)) {
      const hasParcial = /^\d{8,9}$/.test(String(dataNow.telefone_parcial || ''));
      const hasDDD = /^[1-9]\d$/.test(String(dataNow.ddd || ''));
      if (hasParcial && !hasDDD) field = 'ddd';
      else if (hasDDD && !hasParcial) field = 'telefone_parcial';
    }

    s.askCounts = s.askCounts || {};
    if (field) s.askCounts[field] = (s.askCounts[field] || 0) + 1;

    s.flags = s.flags || {};
    if (field) {
      s.flags.lastAskedField = String(field);
      s.flags.lastAskedAt = now();
      s.flags.pendingField = {
        field: String(field || ''),
        askedAt: now(),
        expiresAt: now() + FIELD_TTL_MS,
        attempts: s.askCounts[field] || 0
      };
    }

    this._set(perfil, chatId, s);

    // Anti-loop: se exceder MAX_ASK_RETRIES e ainda faltar o campo → apenas logar (sem fallback humano)
    const stillMissing = Array.isArray(s.missing) && s.missing.includes(field);
    if (field && stillMissing && s.askCounts[field] >= MAX_ASK_RETRIES) {
      try {
        issues.append(perfil, 'pedidos_max_ask_retries', `campo=${field} chat=${chatId} tentativas=${s.askCounts[field]}`);
      } catch {}
      try {
        const stepLog = require('./stepLog.js');
        stepLog.appendJSONL(perfil, 'pedidos_max_ask_retries', { chatId, field, attempts: s.askCounts[field] });
      } catch {}
    }
  }

  markSentAndFreeze(perfil, chatId, tipo='completo') {
    const s = this._get(perfil, chatId) || this._set(perfil, chatId, {});
    s.flags = s.flags || {};
    s.flags.finalizedAt = now();
    s.flags.finalizationFreezeUntil = now() + 486060*1000;
    s.flags.sentToNotifierAt = s.flags.sentToNotifierAt || now();
    s.flags.sentType = tipo;
    this._set(perfil, chatId, s);
  }

  markFinalizedAndFreeze(perfil, chatId) {
    const s = this._get(perfil, chatId) || this._set(perfil, chatId, {});
    s.flags = s.flags || {};
    s.flags.finalizedAt = now();
    s.flags.finalizationFreezeUntil = now() + 486060*1000;
    this._set(perfil, chatId, s);
  }

  upsertFromIA(perfil, chatId, campos) {
    const s = this._get(perfil, chatId) || this._set(perfil, chatId, {});
    const cur = s.data || {};
    const c = campos || {};
    const merged = Object.assign({}, cur);

    function cleanStr(v) { return String(v == null ? '' : v).trim(); }
    function onlyDigits(v) { return String(v || '').replace(/\D/g, ''); }
    function isStopwordStr(t) { return /^conveniente(?:\s+contingencia)?$/i.test(String(t||'').trim()); }

    function setIfMeaningful(k, v) {
      if (v === undefined || v === null) return;

      if (typeof v === 'boolean') {
        merged[k] = v;
        return;
      }

      if (k === 'telefone') {
        const d = onlyDigits(v);
        if (isValidPhoneBR(d)) merged.telefone = d;
        return;
      }

      if (k === 'ddd') {
        const d = onlyDigits(v);
        if (/^[1-9]\d$/.test(d)) merged.ddd = d;
        return;
      }

      if (k === 'telefone_parcial') {
        const d = onlyDigits(v);
        if (/^\d{8,9}$/.test(d)) merged.telefone_parcial = d;
        return;
      }


      // Demais strings (endereços, itens, cidade etc.)
      const t = cleanStr(v);
      if (!t) return;
      if (isStopwordStr(t)) return; // ignora "Conveniente/Conveniente Contingencia"
      merged[k] = t;
    }

    const KEYS = [
      'itens','endereco_saida','endereco_destino','ajudante',
      'telefone','ddd','telefone_parcial','cidade','descricao'
    ];
    for (const k of KEYS) {
      if (Object.prototype.hasOwnProperty.call(c, k)) {
        setIfMeaningful(k, c[k]);
      }
    }

    // Montagem automática de telefone caso tenha DDD + parcial
    if (!merged.telefone && merged.ddd && merged.telefone_parcial) {
      const combinado = String(merged.ddd) + String(merged.telefone_parcial);
      if (isValidPhoneBR(combinado)) {
        merged.telefone = combinado;
        delete merged.telefone_parcial;
      }
    }

    // Limpar pendingField se o último campo perguntado recebeu resposta útil
    const sBefore = this._get(perfil, chatId) || {};
    const flagsCur = (sBefore && sBefore.flags) || {};
    const askedField = flagsCur.lastAskedField;

    function _hasFieldValue(d, field) {
      if (!field) return false;
      switch (String(field)) {
        case 'itens': return !!(d.itens && String(d.itens).trim());
        case 'endereco_saida': return !!(d.endereco_saida && String(d.endereco_saida).trim());
        case 'endereco_destino': return !!(d.endereco_destino && String(d.endereco_destino).trim());
        case 'ajudante': return (d.ajudante === true || d.ajudante === false);
        case 'ddd': return /^[1-9]\d$/.test(String(d.ddd || ''));
        case 'telefone_parcial': return /^\d{8,9}$/.test(String(d.telefone_parcial || ''));
        case 'telefone': {
          const hasFull = isValidPhoneBR(d.telefone);
          const hasParcial = /^\d{8,9}$/.test(String(d.telefone_parcial || ''));
          const hasDDD = /^[1-9]\d$/.test(String(d.ddd || ''));
          return !!(hasFull || hasParcial || hasDDD);
        }
        case 'descricao': return !!(d.descricao && String(d.descricao).trim());
        default: return false;
      }
    }

    let patch = { data: merged };
    if (askedField && _hasFieldValue(merged, askedField)) {
      const newFlags = Object.assign({}, flagsCur, { pendingField: null });
      patch.flags = newFlags;
    }

    return this._set(perfil, chatId, patch);
  }

  async upsertFromHistoryLLM(perfil, chatId, mensagensDoCliente, { contexto } = {}) {
    // mensagensDoCliente: histórico completo ou último lote; o extrator usa as últimas 15–30 internamente
    const allMsgs = Array.isArray(mensagensDoCliente) ? mensagensDoCliente : [];
    const campos = await extractOrderFieldsLLM({ perfil, chatId, mensagens: allMsgs, contexto: contexto || {} });
    const snap = this.upsertFromIA(perfil, chatId, campos);

    // Preenche descricao se estiver vazia, concatenando mensagens do cliente
    try {
      const textoHistorico = (Array.isArray(mensagensDoCliente) ? mensagensDoCliente : []).filter(m => m && m.autor === 'cliente').map(m => m.texto).join(' | ').slice(0, 600);
      if (!snap.data.descricao && textoHistorico) {
        snap.data.descricao = textoHistorico;
        this._set(perfil, chatId, { data: snap.data });
      }
    } catch {}

    // Anti-loop: verifica se algum campo faltante excedeu MAX_ASK_RETRIES (apenas logar, sem fallback humano)
    const sNow = this._get(perfil, chatId);
    if (sNow && sNow.askCounts) {
      for (const miss of (sNow.missing||[])) {
        const tries = sNow.askCounts[miss] || 0;
        if (tries >= MAX_ASK_RETRIES) {
          try {
            issues.append(perfil, 'pedidos_max_ask_retries', `campo=${miss} chat=${chatId} tentativas=${tries}`);
          } catch {}
          try {
            const stepLog = require('./stepLog.js');
            stepLog.appendJSONL(perfil, 'pedidos_max_ask_retries', { chatId, field: miss, attempts: tries });
          } catch {}
          break;
        }
      }
    }

    // Decisão centralizada de finalização
    this.finalizeIfReady(perfil, chatId);

    return this._get(perfil, chatId);
  }

  readyToSendComplete(perfil, chatId) {
    const s = this._get(perfil, chatId);
    if (!s) return false;
    const d = s.data || {};
    if (s.flags && s.flags.sentToNotifierAt) return false;
    const ok =
      isValidPhoneBR(d.telefone) &&
      !!d.itens &&
      !!d.endereco_saida &&
      !!d.endereco_destino;
    return !!ok;
  }

  finalizeIfReady(perfil, chatId) {
    const s = this._get(perfil, chatId);
    if (!s) return false;
    if (s.flags && s.flags.sentToNotifierAt) return false; // já enviado

    // 1) Se está completo: enviar COMPLETO
    if (this.readyToSendComplete(perfil, chatId)) {
      const payload = Object.assign({}, s.data);
      this.emit('orderSent', { perfil, chatId, tipo: 'completo', payload });
      try {
        const stepLog = require('./stepLog.js');
        stepLog.appendJSONL(perfil, 'order_sent', { chatId, tipo: 'completo', payload });
      } catch {}
      this.markSentAndFreeze(perfil, chatId, 'completo');
      this._audit('pedidos_order_sent', perfil, chatId, { tipo: 'completo', telefone_mask: maskPhone(payload.telefone), campos_faltantes_count: 0 });
      return 'completo';
    }

    // 2) Se tem WhatsApp e estourou o prazo: enviar INCOMPLETO
    if (isValidPhoneBR(s.data && s.data.telefone) &&
        s.timers && s.timers.incompleteWithWhatsDeadline &&
        s.timers.incompleteWithWhatsDeadline <= now() &&
        !(s.flags && s.flags.sentToNotifierAt)) {
      const payload = Object.assign({}, s.data);
      this.emit('orderSent', { perfil, chatId, tipo: 'incompleto', payload });
      try {
        const stepLog = require('./stepLog.js');
        stepLog.appendJSONL(perfil, 'order_sent', { chatId, tipo: 'incompleto', payload });
      } catch {}
      this.markSentAndFreeze(perfil, chatId, 'incompleto');
      this._audit('pedidos_order_sent', perfil, chatId, { tipo: 'incompleto', telefone_mask: maskPhone(payload.telefone), campos_faltantes_count: (s.missing||[]).length });
      return 'incompleto';
    }

    return false;
  }

  _tick() {
    try {
      for (const [perfil, st] of this.cache.entries()) {
        const chats = st && st.chats ? st.chats : {};
        const keys = Object.keys(chats);
        for (const chatId of keys) {
          const s = chats[chatId];
          if (!s) continue;

          // janela de silêncio ativa? então não faça nada
          if (s.flags && s.flags.finalizationFreezeUntil && s.flags.finalizationFreezeUntil > now()) continue;

          // 0) TTL por campo pendente — se o cliente não respondeu no TTL, marque e avance
          const pf = s.flags && s.flags.pendingField;
          if (pf && pf.expiresAt && pf.expiresAt <= now()) {
            const field = pf.field;
            const dataBefore = Object.assign({}, s.data || {});
            let touched = false;

            // Para campos booleanos tri-state, marque "nao_respondeu" se ainda não houver booleano
            if (field === 'ajudante') {
              if (!(dataBefore.ajudante === true || dataBefore.ajudante === false)) {
                dataBefore.ajudante = 'nao_respondeu';
                touched = true;
              }
            }
            // Para campos textuais e demais enumerações, não preenche automaticamente; permanecem null

            s.askCounts = s.askCounts || {};
            if (field) s.askCounts[field] = (s.askCounts[field] || 0) + 1;

            s.flags.pendingField = null;
            this._set(perfil, chatId, { data: dataBefore, flags: s.flags, askCounts: s.askCounts });

            try { issues.append(perfil, 'mil_action', `field_timeout chat=${chatId} field=${field}`); } catch {}
            this.emit('fieldTimeout', { perfil, chatId, field });
          }

          // 1) Incompleto com WhatsApp após 10min => delegar a finalizeIfReady()
          if (!s.flags.sentToNotifierAt &&
              isValidPhoneBR(s.data && s.data.telefone) &&
              s.timers && s.timers.incompleteWithWhatsDeadline &&
              s.timers.incompleteWithWhatsDeadline <= now()) {
            // 2) Com WhatsApp válido e incompleto há 10min => UM ping e ENCERRA
            if (!(s.flags && s.flags.singleInactivityPingSent === true)) {
              this.emit('inactivityPing', { perfil, chatId });
              try {
                const stepLog = require('./stepLog.js');
                stepLog.appendJSONL(perfil, 'inactivity_ping', { chatId, withWhats: true });
              } catch {}
              s.flags = s.flags || {};
              s.flags.singleInactivityPingSent = true;
              this._set(perfil, chatId, s);
              this._audit('pedidos_inactivity_ping_sent', perfil, chatId, { withWhats: true });

              // Envia INCOMPLETO ao notificador e congela janela
              this.finalizeIfReady(perfil, chatId);
              continue;
            }
            this.finalizeIfReady(perfil, chatId);
            continue;
          }
        }
      }
    } catch {}
  }

  _audit(type, perfil, chatId, extra) {
    try {
      issues.append(perfil, type, `chat=${chatId} ${extra ? JSON.stringify(extra).slice(0,180) : ''}`);
    } catch {}
  }
}

const orchestrator = new PedidoOrchestrator();

function getNextNonPhoneField(d = {}) {
  // Ordem fixa sem campos de telefone
  if (!d.itens) return 'itens';
  if (!d.endereco_saida) return 'endereco_saida';
  if (!d.endereco_destino) return 'endereco_destino';
  if (typeof d.ajudante !== 'boolean') return 'ajudante';
  return null;
}

function getAskDirective(perfil, chatId, novasMsgs = [], snapshot = {}) {
  const s = orchestrator._get(perfil, chatId) || {};
  const data = (snapshot && snapshot.data) || (s && s.data) || {};
  const telOk = isValidPhoneBR(data.telefone);
  const firstReply = !(s && s.flags && (s.flags.firstIaReplied || s.flags.greetDone));
  const hasAskedWhats = !!(s && s.flags && s.flags.hasAskedWhats);
  const lastWhatsAskAt = s && s.lastWhatsAskAt || 0;
  const canAskPhoneAgain = !telOk && (!hasAskedWhats || (now() - lastWhatsAskAt) >= PHONE_ASK_COOLDOWN_MS);

  // Primeira resposta: WhatsApp + próxima pergunta real do funil
  if (!telOk && firstReply) {
    const nextAfterPhone = getNextNonPhoneField(data) || 'itens';
    return {
      askField: 'telefone',
      phase: 'first_contact',
      reason: 'first_contact',
      nextField: nextAfterPhone,
      allowSecondQuestion: true,
      phoneMode: 'full'
    };
  }

  // Após a saudação: NÃO repetir pedido de WhatsApp. Priorize itens/endereço/etc.
  if (!telOk && hasAskedWhats && !firstReply) {
    const nextNonPhone = getNextNonPhoneField(data);
    if (nextNonPhone) {
      return {
        askField: nextNonPhone,
        phase: 'none',
        reason: 'non_phone_after_first',
        nextField: null,
        allowSecondQuestion: false
      };
    }
    if (canAskPhoneAgain) {
      return {
        askField: 'telefone',
        phase: 'reminder',
        reason: 'cooldown_elapsed',
        nextField: null,
        allowSecondQuestion: false,
        phoneMode: 'full'
      };
    }
    return {
      askField: 'descricao',
      phase: 'none',
      reason: 'optional',
      nextField: null,
      allowSecondQuestion: false
    };
  }

  // Telefone OK ou nunca pedimos (mas não é primeira): siga ordem do funil padrão
  const next = getNextAskField(data);
  if (next) {
    return {
      askField: next,
      phase: 'none',
      reason: 'missing',
      nextField: null,
      allowSecondQuestion: false
    };
  }

  return {
    askField: 'descricao',
    phase: 'none',
    reason: 'optional',
    nextField: null,
    allowSecondQuestion: false
  };
}

/**
 * Persistência da fase do WhatsApp (para ser chamada pelo executor quando efetivamente perguntar).
 * phase: 'full'|'lite'
 */
function setWhatsPhase(perfil, chatId, phase) {
  try {
    const s = orchestrator._get(perfil, chatId) || orchestrator._set(perfil, chatId, {});
    s.flags = s.flags || {};
    s.flags.whatsAskedPhase = String(phase || 'full');
    s.flags.hasAskedWhats = true;
    s.lastWhatsAskAt = now();
    orchestrator._set(perfil, chatId, s);
    try { issues.append(perfil, 'mil_action', `whats_phase_set chat=${chatId} phase=${phase}`); } catch {}
    return true;
  } catch { return false; }
}

async function fallbackToHuman(perfil, chatId, reason) {
  try {
    // Apenas logar; NÃO acionar eventos/outros fluxos de handoff humano
    // O Virtus é responsável por enviar mensagem educativa pedindo WhatsApp quando necessário
    try { 
      issues.append(perfil, 'pedidos_fallback_to_human_disabled', `chat=${chatId} reason=${reason||''}`);
    } catch {}
    try {
      const stepLog = require('./stepLog.js');
      stepLog.appendJSONL(perfil, 'pedidos_fallback_to_human_disabled', { chatId, reason: reason || '' });
    } catch {}
    // NÃO acionar eventos/outros fluxos
    // orchestrator.emit('handoffToHuman', { perfil, chatId, reason }); // DESABILITADO
  } catch (e) {
    try { 
      issues.append(perfil, 'pedidos_fallback_to_human_disabled_error', `chat=${chatId} reason=${(e&&e.message)||e}`);
    } catch {}
  }
}

async function ingestFromVirtus(perfil, chatId, { historico = [], contexto = {}, novasMsgs = [] } = {}) {
  try {
    const cursor = computeClientCursor(historico);
    const sig = `${cursor.count}|${cursor.digest}`;
    let sPrev = orchestrator._get(perfil, chatId) || orchestrator._set(perfil, chatId, {});

    // Janela finalizada
    if (module.exports.isFinalized(perfil, chatId)) {
      return { mensagemParaCliente: '', dadosExtraidosAtualizados: (sPrev && sPrev.data) || {}, proximaPergunta: null, tudoColetado: module.exports.readyToSendComplete(perfil, chatId) };
    }

    // Idempotência: se já enfileirado/resp. para esse cursor, não reemite
    const alreadyQueuedSig = (sPrev && sPrev.fsm && sPrev.fsm.lastQueuedCursorSig) || '';
    if (alreadyQueuedSig === sig) {
      return { mensagemParaCliente: '', dadosExtraidosAtualizados: (sPrev && sPrev.data) || {}, proximaPergunta: null, tudoColetado: module.exports.readyToSendComplete(perfil, chatId) };
    }

    // Extrai dados via LLM extrator (só parsing)
    const snapAfter = await module.exports.upsertFromHistoryLLM(perfil, chatId, historico, { contexto });
    const snap = module.exports.getSnapshot(perfil, chatId);
    const dados = (snap && snap.data) || {};

    // FSM: qual próximo step
    const step = proximoPasso(snap, dados);
    if (!step) {
      // Nada a fazer (pode estar aguardando timeout para enviar incompleto ou já completo)
      module.exports.finalizeIfReady(perfil, chatId);
      return { mensagemParaCliente: '', dadosExtraidosAtualizados: dados, proximaPergunta: null, tudoColetado: module.exports.readyToSendComplete(perfil, chatId) };
    }

    // Mensagem de negócio determinística para o step
    const msgNegocio = gerarMensagemNegocio(step, dados, snap);

    // Passa pelo prompt apenas para humanizar (sem decidir fluxo)
    const systemPrompt = promptFretes.buildSystemPrompt();
    const userPrompt = promptFretes.buildUserPrompt({
      instrucoes: [
        'Reescreva a mensagem abaixo no seu tom humano e profissional.',
        'Não adicione perguntas além do que já estiver no texto.',
        'Não repita explicações que não estejam no texto.',
        'A resposta deve ser uma única mensagem.'
      ],
      acao: '',
      historico: historico.slice(-8),
      mensagemCliente: (novasMsgs && novasMsgs.length) ? (novasMsgs[novasMsgs.length - 1].texto || '') : ''
    }) + `\n\nMENSAGEM_DE_NEGOCIO:\n"${msgNegocio}"`;

    const model = process.env.GROQ_MODEL_ANSWER || process.env.GROQ_MODEL || 'llama-3.3-70b-versatile';
    let raw = '';
    try {
      raw = await chatCompletion({
        system: systemPrompt,
        user: userPrompt,
        provider: 'groq',
        model,
        task: 'answer',
        timeoutMs: 22000,
        retries: 2
      });
    } catch (e) {
      raw = msgNegocio; // fallback: envia o texto de negócio cru
    }
    const parsed = promptFretes.parseModelAnswerToDomain(raw);
    let textoFinal = String(parsed && parsed.resposta ? parsed.resposta : raw).trim();
    if (!textoFinal) textoFinal = msgNegocio;

    // Registro FSM e contadores (sem marcar replied aqui)
    try {
      registrarPassoExecutado(perfil, chatId, step, { cursorSig: sig, text: textoFinal });
      const stepToField = {
        whatsapp_pedido_1: 'telefone',
        ddd_pedido: 'ddd',
        whatsapp_parcial_pedido: 'telefone_parcial',
        itens_pedido: 'itens',
        end_saida_pedido: 'endereco_saida',
        end_destino_pedido: 'endereco_destino',
        ajudante_pedido: 'ajudante'
      };
      const field = stepToField[step] || null;
      if (field) module.exports.recordAsk(perfil, chatId, field);
    } catch {}

    // Emite para a fila (Virtus). ACKS ajustarão flags sig.
    orchestrator.emit('replyReady', {
      perfil,
      chatId,
      texto: textoFinal,
      cursorCount: cursor.count || 0,
      cursorDigest: cursor.digest || '',
      cursorSig: sig,
      lastClientTs: cursor.lastTs || 0
    });

    // Decide finalização se estiver completo
    try { module.exports.finalizeIfReady(perfil, chatId); } catch {}

    return {
      mensagemParaCliente: textoFinal,
      dadosExtraidosAtualizados: (module.exports.getSnapshot(perfil, chatId).data) || {},
      proximaPergunta: step,
      tudoColetado: module.exports.readyToSendComplete(perfil, chatId)
    };

  } catch (e) {
    try { issues.append(perfil, 'ingest_from_virtus_fail', `chat=${chatId} err=${(e && e.message) || e}`); } catch {}
    return {
      mensagemParaCliente: '',
      dadosExtraidosAtualizados: (module.exports.getSnapshot(perfil, chatId).data) || {},
      proximaPergunta: null,
      tudoColetado: false
    };
  }
}

module.exports = {
  events: orchestrator, // emitter: 'orderSent', 'inactivityPing'
  getSnapshot: (perfil, chatId) => orchestrator.getSnapshot(perfil, chatId),
  isFinalized: (perfil, chatId) => orchestrator.isFinalized(perfil, chatId),
  shouldGreetFirstReply: (perfil, chatId) => orchestrator.shouldGreetFirstReply(perfil, chatId),
  markIaReplied: (perfil, chatId) => orchestrator.markIaReplied(perfil, chatId),
  recordAsk: (perfil, chatId, field) => orchestrator.recordAsk(perfil, chatId, field),
  markSentAndFreeze: (perfil, chatId, tipo) => orchestrator.markSentAndFreeze(perfil, chatId, tipo),
  markFinalizedAndFreeze: (perfil, chatId) => orchestrator.markFinalizedAndFreeze(perfil, chatId),
  upsertFromIA: (perfil, chatId, campos) => orchestrator.upsertFromIA(perfil, chatId, campos),
  upsertFromHistoryLLM: (perfil, chatId, mensagens, opts) => orchestrator.upsertFromHistoryLLM(perfil, chatId, mensagens, opts),
  readyToSendComplete: (perfil, chatId) => orchestrator.readyToSendComplete(perfil, chatId),

  // ===== ADIÇÕES EXPORTADAS PARA CONTROLE DETERMINÍSTICO DO FLUXO =====
  getNextAskField,
  shouldAskWhatsappFirst,
  getAskDirective,
  setWhatsPhase,
  hasPriceIntent,
  finalizeIfReady: (perfil, chatId) => orchestrator.finalizeIfReady(perfil, chatId),

  // NOVO: ponto de integração Virtus -> Pedidos
  ingestFromVirtus,

  ackReplyQueued: (perfil, chatId, cursorSig) => ackReplyQueued(perfil, chatId, cursorSig),
  ackReplySent: (perfil, chatId, cursorSig) => ackReplySent(perfil, chatId, cursorSig)
};
