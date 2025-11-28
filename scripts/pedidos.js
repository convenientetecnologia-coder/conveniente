// pedidos.js

'use strict';

const fs = require('fs');
const path = require('path');
const EventEmitter = require('events');
const issues = require('./issues.js');
const { extractOrderFieldsLLM } = require('./iaExtractors.js');
const fileStore = require('./fileStore.js');
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
  if (!d.itens) missing.push('itens');
  if (!d.endereco_saida) missing.push('endereco_saida');
  if (!d.endereco_destino) missing.push('endereco_destino');
  if (typeof d.ajudante !== 'boolean') missing.push('ajudante');
  if (!d.saida_tipo) missing.push('saida_tipo');
  if (!d.destino_tipo) missing.push('destino_tipo');
  if (d.saida_tipo === 'apartamento' && typeof d.saida_elevador !== 'boolean') missing.push('saida_elevador');
  if (d.destino_tipo === 'apartamento' && typeof d.destino_elevador !== 'boolean') missing.push('destino_elevador');
  if (!d.cidade) missing.push('cidade');
  if (!d.telefone) missing.push('telefone');
  return missing;
}
function isValidPhoneBR(d) {
  const s = onlyDigits(d);
  if (s.length === 11) return /^[1-9]{2}9\d{8}$/.test(s);
  if (s.length === 10) return /^[1-9]{2}[2-9]\d{7}$/.test(s);
  return false;
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
  'saida_tipo',
  'destino_tipo',
  'saida_elevador',
  'destino_elevador',
  'ddd',
  'telefone'
]);

/**
 * Decide o próximo campo a perguntar COM ordem fixa e regras:
 * 1. itens
 * 2. endereco_saida
 * 3. endereco_destino
 * 4. ajudante
 * 5. saida_tipo
 * 6. destino_tipo
 * 7. saida_elevador (se apt)
 * 8. destino_elevador (se apt)
 * 9. telefone
 * Observação: cidade NÃO é perguntada no fluxo do chat ao cliente.
 */
function getNextAskField(data = {}) {
  const d = data || {};
  if (!d.itens) return 'itens';
  if (!d.endereco_saida) return 'endereco_saida';
  if (!d.endereco_destino) return 'endereco_destino';
  if (typeof d.ajudante !== 'boolean') return 'ajudante';
  if (!d.saida_tipo) return 'saida_tipo';
  if (!d.destino_tipo) return 'destino_tipo';
  if (d.saida_tipo === 'apartamento' && typeof d.saida_elevador !== 'boolean') return 'saida_elevador';
  if (d.destino_tipo === 'apartamento' && typeof d.destino_elevador !== 'boolean') return 'destino_elevador';

  // Política telefone:
  // 1) Se já houver telefone completo válido, nada a perguntar.
  if (isValidPhoneBR(d.telefone)) return null;

  // 2) Se houver apenas telefone_parcial e não houver ddd, pedir APENAS o ddd.
  if (!d.ddd && d.telefone_parcial) return 'ddd';

  // 3) Caso contrário, pedir o telefone (WhatsApp).
  return 'telefone';
}

/**
 * Deve pedir WhatsApp agora (primeira prioridade) se houver intenção de preço,
 * e ainda não houver telefone completo válido.
 */
function shouldAskWhatsappFirst({ historicoNovo = [], dataAtual = {} } = {}) {
  const telOk = isValidPhoneBR(dataAtual && dataAtual.telefone);
  if (telOk) return false;
  for (const m of (historicoNovo || [])) {
    const txt = (m && m.texto) || '';
    if (hasPriceIntent(txt)) return true;
  }
  return false;
}

/* ===================== FIM — ADIÇÕES DETERMINÍSTICAS DE FLUXO ===================== */

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
      data: { itens:null,endereco_saida:null,endereco_destino:null,ajudante:null,saida_tipo:null,saida_elevador:null,destino_tipo:null,destino_elevador:null,telefone:null,ddd:null,telefone_parcial:null,cidade:null },
      flags: { firstIaReplied:false, greetDone:false, finalizedAt:null, finalizationFreezeUntil:null, sentToNotifierAt:null, hasAskedWhats:false, singleInactivityPingSent:false, sentType:null, pendingField: null },
      timers: { startedAt: now(), incompleteWithWhatsDeadline: null, withoutWhatsDeadline: null },
      askCounts: { telefone:0, ddd:0, itens:0, endereco_saida:0, endereco_destino:0, ajudante:0, saida_tipo:0, destino_tipo:0, saida_elevador:0, destino_elevador:0 },
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
    // Anti-loop: se exceder MAX_ASK_RETRIES e ainda faltar o campo → fallback humano
    const stillMissing = Array.isArray(s.missing) && s.missing.includes(field);
    if (field && stillMissing && s.askCounts[field] >= MAX_ASK_RETRIES) {
      fallbackToHuman(perfil, chatId, `max_retries_${field}`);
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

      if (k === 'saida_tipo' || k === 'destino_tipo') {
        const t = cleanStr(v).toLowerCase();
        if (t === 'casa' || t === 'apartamento') merged[k] = t;
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
      'saida_tipo','destino_tipo','saida_elevador','destino_elevador',
      'telefone','ddd','telefone_parcial','cidade'
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
        case 'saida_tipo': return (d.saida_tipo === 'casa' || d.saida_tipo === 'apartamento');
        case 'destino_tipo': return (d.destino_tipo === 'casa' || d.destino_tipo === 'apartamento');
        case 'saida_elevador': return (d.saida_elevador === true || d.saida_elevador === false);
        case 'destino_elevador': return (d.destino_elevador === true || d.destino_elevador === false);
        case 'ddd': return /^[1-9]\d$/.test(String(d.ddd || ''));
        case 'telefone_parcial': return /^\d{8,9}$/.test(String(d.telefone_parcial || ''));
        case 'telefone': return isValidPhoneBR(d.telefone);
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

    // Anti-loop: verifica se algum campo faltante excedeu MAX_ASK_RETRIES
    const sNow = this._get(perfil, chatId);
    if (sNow && sNow.askCounts) {
      for (const miss of (sNow.missing||[])) {
        const tries = sNow.askCounts[miss] || 0;
        if (tries >= MAX_ASK_RETRIES) {
          fallbackToHuman(perfil, chatId, `max_retries_${miss}`);
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
    if (s.flags && s.flags.sentToNotifierAt) return false; // idempotência
    const ok =
      !!d.itens &&
      !!d.endereco_saida &&
      !!d.endereco_destino &&
      (d.ajudante === true || d.ajudante === false) &&
      !!d.saida_tipo &&
      !!d.destino_tipo &&
      (d.saida_tipo !== 'apartamento' || (typeof d.saida_elevador === 'boolean')) &&
      (d.destino_tipo !== 'apartamento' || (typeof d.destino_elevador === 'boolean')) &&
      !!d.cidade &&
      !!d.telefone &&
      isValidPhoneBR(d.telefone);
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
            } else if (field === 'saida_elevador') {
              if (!(dataBefore.saida_elevador === true || dataBefore.saida_elevador === false)) {
                dataBefore.saida_elevador = 'nao_respondeu';
                touched = true;
              }
            } else if (field === 'destino_elevador') {
              if (!(dataBefore.destino_elevador === true || dataBefore.destino_elevador === false)) {
                dataBefore.destino_elevador = 'nao_respondeu';
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
            this.finalizeIfReady(perfil, chatId);
            continue;
          }

          // 2) Sem WhatsApp após 10min => UM ping de inatividade pedindo WhatsApp
          if ((!s.data || !isValidPhoneBR(s.data.telefone)) &&
              s.timers && s.timers.withoutWhatsDeadline &&
              s.timers.withoutWhatsDeadline <= now() &&
              !(s.flags && s.flags.singleInactivityPingSent === true)) {
            this.emit('inactivityPing', { perfil, chatId });
            try {
              const stepLog = require('./stepLog.js');
              stepLog.appendJSONL(perfil, 'inactivity_ping', { chatId });
            } catch {}
            s.flags = s.flags || {};
            s.flags.singleInactivityPingSent = true;
            this._set(perfil, chatId, s);
            this._audit('pedidos_inactivity_ping_sent', perfil, chatId, {});
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
  if (!d.saida_tipo) return 'saida_tipo';
  if (!d.destino_tipo) return 'destino_tipo';
  if (d.saida_tipo === 'apartamento' && typeof d.saida_elevador !== 'boolean') return 'saida_elevador';
  if (d.destino_tipo === 'apartamento' && typeof d.destino_elevador !== 'boolean') return 'destino_elevador';
  return null;
}

/**
 * Diretiva determinística: "qual campo perguntar agora" + acoplamento de próxima pergunta e modo de telefone.
 * Retorna: { askField, phase, reason, nextField, allowSecondQuestion, phoneMode }
 *   - askField: 'itens'|'endereco_saida'|'endereco_destino'|'ajudante'|'saida_tipo'|'destino_tipo'|'saida_elevador'|'destino_elevador'|'ddd'|'telefone'|null
 *   - phase: 'full'|'lite'|'none'
 *   - reason: 'price_intent' ou 'missing'
 *   - nextField: próximo campo não-telefone da sequência, ou null se não houver
 *   - allowSecondQuestion: true|false — se true e nextField != null, a IA deve fazer 2 perguntas (askField e depois nextField)
 *   - phoneMode: 'lite' (não menciona DDD) ou 'full' (pede "com DDD")
 */
function getAskDirective(perfil, chatId, novasMsgs = [], snapshot = {}) {
  const s = orchestrator._get(perfil, chatId) || {};
  const data = (snapshot && snapshot.data) || (s && s.data) || {};
  const counts = (s && s.askCounts) || {};
  const telOk = isValidPhoneBR(data.telefone);

  // 1) Intenção de preço: pedir WhatsApp imediatamente (sem cooldown) e, se possível, emendar próxima não-telefone
  if (!telOk && shouldAskWhatsappFirst({ historicoNovo: novasMsgs, dataAtual: data })) {
    const nextField = getNextNonPhoneField(data);
    const phoneMode = (counts.telefone >= 1 && !data.ddd && !data.telefone_parcial) ? 'full' : 'lite';
    return {
      askField: 'telefone',
      phase: 'none',
      reason: 'price_intent',
      nextField,
      allowSecondQuestion: !!nextField,
      phoneMode
    };
  }

  // 2) Telefone parcial presente sem DDD: priorize pedir DDD (sem cooldown) e, se possível, emendar próxima não-telefone
  if (!telOk && data && data.telefone_parcial && !data.ddd) {
    const nextField = getNextNonPhoneField(data);
    return {
      askField: 'ddd',
      phase: 'none',
      reason: 'missing',
      nextField,
      allowSecondQuestion: !!nextField,
      phoneMode: 'lite'
    };
  }

  // 3) Próximo campo do fluxo determinístico geral
  const next = getNextAskField(data);

  if (next === 'telefone') {
    const nextField = getNextNonPhoneField(data);
    const phoneMode = (counts.telefone >= 1 && !data.ddd && !data.telefone_parcial) ? 'full' : 'lite';
    return {
      askField: 'telefone',
      phase: 'none',
      reason: 'missing',
      nextField,
      allowSecondQuestion: !!nextField,
      phoneMode
    };
  }

  if (next === 'ddd') {
    const nextField = getNextNonPhoneField(data);
    return {
      askField: 'ddd',
      phase: 'none',
      reason: 'missing',
      nextField,
      allowSecondQuestion: !!nextField,
      phoneMode: 'lite'
    };
  }

  return {
    askField: next || null, // poderá ser null apenas quando não houver mais nada a perguntar
    phase: 'none',
    reason: 'missing',
    nextField: null,
    allowSecondQuestion: false,
    phoneMode: 'lite'
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
    await fileStore.withDesiredFileLockUpdate(desired => {
      desired.perfis = desired.perfis || {};
      desired.perfis[perfil] = { ...(desired.perfis[perfil] || {}), humanHold: true };
      return desired;
    });
    try { issues.append(perfil, 'mil_action', `handoff_to_human chat=${chatId} reason=${reason||''}`); } catch {}
    try {
      const stepLog = require('./stepLog.js');
      stepLog.appendJSONL(perfil, 'handoff_to_human', { chatId, reason });
    } catch {}
    orchestrator.emit('handoffToHuman', { perfil, chatId, reason });
  } catch (e) {
    try { issues.append(perfil, 'mil_action', `handoff_to_human_failed chat=${chatId} reason=${(e&&e.message)||e}`); } catch {}
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

  // ===== ADIÇÕES EXPORTADAS PARA CONTROLE DETERMINÍSTICO DO FLUXO =====
  getNextAskField,
  shouldAskWhatsappFirst,
  getAskDirective,
  setWhatsPhase,
  hasPriceIntent,
  finalizeIfReady: (perfil, chatId) => orchestrator.finalizeIfReady(perfil, chatId)
};
