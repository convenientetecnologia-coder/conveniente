const { extractOrderFieldsLLM } = require('./iaExtractors.js');

// ==== INTEGRAÇÃO DO STEP ENGINE (FLOW MODULAR) ====
const stepEngine = require('./ia_scripts/core');
const stepRegistry = require('./ia_scripts/registry');

// computeMissing delegado ao Step Engine
let computeMissing = null;
try {
  computeMissing = stepEngine.computeMissingByFlow;
} catch {
  try { computeMissing = require('./missing.js').computeMissing; } catch {}
}

const path = require('path');

const fs = require('fs');

const crypto = require('crypto');



let fsmFlow = null;

try { fsmFlow = require('./fsmFlow.js'); } catch { fsmFlow = null; }



// Configuração de tempos (padrões seguros; personalizáveis via env)

const FSM_VERSION = 1;

const PENDING_TTL_MS = parseInt(process.env.FSM_PENDING_TTL_MS || '600000', 10); // 10 minutos

const FINAL_FREEZE_MS = parseInt(process.env.FSM_FINAL_FREEZE_MS || '43200000', 10); // 12h

const REPLY_MIN_MS = parseInt(process.env.FSM_WAIT_BEFORE_REPLY_MIN_MS || '20000', 10); // 20s

const REPLY_MAX_MS = parseInt(process.env.FSM_WAIT_BEFORE_REPLY_MAX_MS || '60000', 10); // 60s



// Renderização (apenas helpers — o FSM não decide step aqui)

let renderUnico = null;

let sanitizeAnswerUnico = null;

try {

const prompt = require('./promptFretes.js');

renderUnico = prompt.renderUnico || prompt.render;

sanitizeAnswerUnico = prompt.sanitizeAnswerUnico;

} catch {}



// Utilidades

function sha1(s) {

return crypto.createHash('sha1').update(String(s || ''), 'utf8').digest('hex');

}

function now() { return Date.now(); }

function deepClone(o) { try { return JSON.parse(JSON.stringify(o || {})); } catch { return {}; } }

function jitter(min, max) { return min + Math.floor(Math.random() * (max - min + 1)); }



// Persistência — atomic fsync write (sem depender de qualquer outro módulo)

function ensureDirSync(p) { try { fs.mkdirSync(p, { recursive: true }); } catch {} }

function statePathOf(perfil) {

return path.join(__dirname, '..', 'dados', 'perfis', String(perfil || ''), 'fsm_state.json');

}

function readJsonSafe(file, fallback) {

try {

const txt = fs.readFileSync(file, 'utf8');

return JSON.parse(txt);

} catch {

return fallback;

}

}

function writeJsonAtomicFsync(file, obj) {

try {

ensureDirSync(path.dirname(file));

const tmp = file + '.tmp';

const fd = fs.openSync(tmp, 'w');

try {

fs.writeFileSync(fd, JSON.stringify(obj, null, 2), 'utf8');

fs.fsyncSync(fd);

} finally {

fs.closeSync(fd);

}

try { fs.unlinkSync(file); } catch {}

try { fs.renameSync(tmp, file); }

catch {

fs.copyFileSync(tmp, file);

try { fs.unlinkSync(tmp); } catch {}

}

return true;

} catch { return false; }

}

function ensureStateShape(st) {

const base = st && typeof st === 'object' ? st : {};

base.version = Number.isFinite(base.version) ? base.version : FSM_VERSION;

base.chats = (base.chats && typeof base.chats === 'object') ? base.chats : {};

return base;

}

function ensureChatShape(chat) {

const t = now();

const out = chat && typeof chat === 'object' ? chat : {};

out.meta = out.meta || { createdAt: t, updatedAt: t, canal: 'messenger' };

out.meta.createdAt = out.meta.createdAt || t;

out.meta.updatedAt = t;

out.meta.canal = out.meta.canal || 'messenger';



out.cursor = out.cursor || {};

out.cursor.client = out.cursor.client || { count: 0, digest: '', lastTs: 0 };

out.cursor.ia = out.cursor.ia || { queuedSig: null, sentSig: null };



out.data = out.data || {

telefone: null, ddd: null, telefone_parcial: null,

itens: null, endereco_saida: null, endereco_destino: null,

ajudante: null, cidade: null, descricao: null,

tom_cliente: 'casual', saudacao_cliente: null,

missing: []

};

out.funil = out.funil || {};

out.funil.step = out.funil.step || 'init';

out.funil.pending = out.funil.pending || { field: null, askedAt: null, expiresAt: null };

out.funil.askCounts = out.funil.askCounts || {};



out.flags = out.flags || { greetDone: false, explainedOrcamentoOnce: false, humanHold: false, finalizing: false };

out.freeze = out.freeze || { finalizationUntil: null, reason: null };

out.schedule = out.schedule || { nextAllowedSendAt: null };

out.audit = out.audit || { lastEnqueueAt: null, lastSendAt: null };



// Para contexto de render (opcional)

out.meta.lastClientText = out.meta.lastClientText || null;

out.meta.lastClientTexts = Array.isArray(out.meta.lastClientTexts) ? out.meta.lastClientTexts : [];



return out;

}



// Flow log — snapshot mínimo

function getSnapshot(chat) {

const missing = (chat && chat.data && Array.isArray(chat.data.missing)) ? chat.data.missing.slice(0) : [];

const step = (chat && chat.funil && chat.funil.pending && chat.funil.pending.field) || (chat && chat.funil && chat.funil.step) || null;

const freeze = (chat && chat.freeze) ? { until: chat.freeze.finalizationUntil || null, reason: chat.freeze.reason || null } : { until: null, reason: null };

const schedule = (chat && chat.schedule) ? { next: chat.schedule.nextAllowedSendAt || null } : { next: null };

const cursor = (chat && chat.cursor && chat.cursor.client) ? { count: chat.cursor.client.count || 0, digest: chat.cursor.client.digest || '', lastTs: chat.cursor.client.lastTs || 0 } : { count: 0, digest: '', lastTs: 0 };

return { step, missing, freeze, schedule, cursor };

}

function flowLog(perfil, chatId, eventName, payload) {

try {

const st = ensureStateShape(readJsonSafe(statePathOf(perfil), {}));

const baseChat = ensureChatShape(st.chats[chatId]);

const snap = getSnapshot(baseChat);

const entry = Object.assign({ ts: now(), chatId, event: String(eventName || '') }, payload || {}, { snapshot: snap });

if (fsmFlow && typeof fsmFlow.append === 'function') {

try { fsmFlow.append(perfil, chatId, eventName, entry); return; } catch {}

}

// shim

const dir = path.join(__dirname, '..', 'dados', 'perfis', String(perfil || ''));

ensureDirSync(dir);

fs.appendFileSync(path.join(dir, 'fsm_flow.log'), JSON.stringify(entry) + '\n', 'utf8');

} catch {}

}



// Leitura/patch

function get(perfil, chatId) {

const st = ensureStateShape(readJsonSafe(statePathOf(perfil), {}));

const c = ensureChatShape(st.chats[chatId]);

return deepClone(c);

}

function deepMerge(target, patch) {

if (!patch || typeof patch !== 'object') return target;

const out = Array.isArray(target) ? target.slice() : Object.assign({}, target || {});

for (const [k, v] of Object.entries(patch)) {

if (v && typeof v === 'object' && !Array.isArray(v)) {

out[k] = deepMerge(out[k] || {}, v);

} else {

out[k] = v;

}

}

return out;

}

function patch(perfil, chatId, patchObj) {

const file = statePathOf(perfil);

const st = ensureStateShape(readJsonSafe(file, {}));

const cur = ensureChatShape(st.chats[chatId]);

const next = deepMerge(cur, patchObj || {});

next.meta = next.meta || {};

next.meta.updatedAt = now();

st.chats[chatId] = next;

writeJsonAtomicFsync(file, st);

return deepClone(next);

}



// Ingestão: merge histórico/cursores/dados extraídos

async function ingestFromVirtus(perfil, chatId, { historico, novasMsgs, cursor, contexto }) {

try {

// flow_in

const lastClientText = Array.isArray(novasMsgs) && novasMsgs.length ? String(novasMsgs[novasMsgs.length - 1].texto || '') : null;

const lastTs = Number(cursor && cursor.lastTs || 0);

const cCount = Number(cursor && cursor.count || 0);

const cDigest = String(cursor && cursor.digest || '');



const pre = get(perfil, chatId);

flowLog(perfil, chatId, 'flow_in', { cursor: { count: cCount, digest: cDigest, lastTs }, lastClientText });



const st1 = patch(perfil, chatId, {

  meta: {

    lastClientText,

    lastClientTexts: (()=>{

      const prev = Array.isArray(pre.meta && pre.meta.lastClientTexts) ? pre.meta.lastClientTexts.slice(0) : [];

      if (lastClientText) {

        const arr = prev.concat([{ texto: lastClientText, timestamp: lastTs || now() }]).slice(-4);

        return arr;

      }

      return prev;

    })()

  },

  cursor: {

    client: { count: cCount, digest: cDigest, lastTs }

  }

});



// Chama extrator IA

const fields = await extractOrderFieldsLLM({

  perfil,

  chatId,

  mensagens: Array.isArray(historico) ? historico : [],

  contexto: contexto || {}

}).catch(() => ({}));



// Merge apenas campos conhecidos

const allowed = ['telefone','ddd','telefone_parcial','itens','endereco_saida','endereco_destino','ajudante','cidade','descricao','tom_cliente','saudacao_cliente'];

const put = {};

for (const k of allowed) {

  if (Object.prototype.hasOwnProperty.call(fields || {}, k)) {

    put[k] = fields[k];

  }

}



const st2 = patch(perfil, chatId, {

  data: put

});



// Recalcula missing (sempre com computeMissing unificada)

if (typeof computeMissing === 'function') {

  const missing = computeMissing(st2 && st2.data ? st2.data : {});

  patch(perfil, chatId, { data: { missing: Array.isArray(missing) ? missing : [] } });

}

// Limpa pending se o campo foi preenchido e atualiza step
const st3 = get(perfil, chatId);
const pendingField = st3 && st3.funil && st3.funil.pending && st3.funil.pending.field;
const missingAfter = Array.isArray(st3 && st3.data && st3.data.missing) ? st3.data.missing : [];

// Se o pending field foi preenchido (não está mais em missing), limpa pending e atualiza step
if (pendingField && !missingAfter.includes(pendingField)) {
  const nextField = stepEngine.nextFieldByOrder(st3 && st3.data, st3 && st3.flags || {});
  patch(perfil, chatId, {
    funil: {
      pending: null,
      step: nextField || null
    }
  });
}

flowLog(perfil, chatId, 'extract_ok', { fields: Object.keys(put), missing: (st3 && st3.data && st3.data.missing) ? st3.data.missing.slice(0) : [] });



} catch (e) {

flowLog(perfil, chatId, 'error_extract', { error: (e && e.message) || String(e) });

throw e;

}

}



// Pipeline/decisão: qual perguntar agora (única autoridade)

function _orderMandatory(data) {

// Ordem estrita: telefone -> itens -> end_saida -> end_destino

// Ajudante/descricao são opcionais e só entram quando principais preenchidos.

const miss = Array.isArray(data && data.missing) ? data.missing.slice(0) : [];

const order = ['telefone', 'itens', 'endereco_saida', 'endereco_destino'];

for (const f of order) {

if (miss.includes(f)) return f;

}

// Se nenhum obrigatório faltando, opcional:

if (data && typeof data.ajudante !== 'boolean') return 'ajudante';

if (!data || !data.descricao) return 'descricao';

return null;

}



function _decideIncludeOrcamento(chat, ask_field) {

// Inclui explicador de orçamento apenas uma vez (greet ou primeira pergunta-chave)

if (!chat || !chat.flags) return false;

if (!chat.flags.explainedOrcamentoOnce && (ask_field === 'telefone' || chat.flags.greetDone === false)) {

return true;

}

return false;

}



function _setPendingAsk(perfil, chatId, field) {

const t = now();

const expiresAt = t + PENDING_TTL_MS;

const cur = get(perfil, chatId);

const askCounts = Object.assign({}, (cur && cur.funil && cur.funil.askCounts) || {});

askCounts[field] = (askCounts[field] || 0) + 1;

patch(perfil, chatId, {

funil: {

step: String(field),

pending: { field, askedAt: t, expiresAt },

askCounts

}

});

return { askedAt: t, expiresAt };

}



function _checkPendingTTL(perfil, chatId) {

const c = get(perfil, chatId);

const p = c && c.funil && c.funil.pending;

if (!p || !p.field || !p.expiresAt) return { expired: false };

if (now() > Number(p.expiresAt)) {

// TTL estourado — marcar flag de finalização; freezing após envio da final

patch(perfil, chatId, { flags: { finalizing: true } });

return { expired: true, field: p.field };

}

return { expired: false };

}



// Pipeline/decisão: qual perguntar agora (única autoridade)
// shouldReply = true é exigido para garantir que o ciclo Virtus nunca fique travado.
function decideNext(perfil, chatId) {

try {

const c = get(perfil, chatId);

const frozen = c && c.freeze && c.freeze.finalizationUntil && (c.freeze.finalizationUntil > now());

if (frozen) {

flowLog(perfil, chatId, 'decide_ok', { blocked: true, reason: 'frozen' });

return { blocked: true };

}

// [PATCH A1] SAUDAÇÃO PRIMEIRO E ANTI-SPAM DE RE-ASK
if (!c.flags || c.flags.greetDone !== true) {
  _setPendingAsk(perfil, chatId, 'saudacao');
  patch(perfil, chatId, { flags: { greetDone: true } });
  const directive = {
    ask_field: 'saudacao',
    ask_next_field: null,
    include_orcamento: true,
    saudacao: true
  };
  directive.shouldReply = true;
  flowLog(perfil, chatId, 'decide_ok', directive);
  return directive;
}

// TTL pendente: se campo já foi perguntado uma vez (askCounts>=1), NÃO repetir a mesma pergunta
const ttl = _checkPendingTTL(perfil, chatId);
if (ttl.expired) {
  const directive = { final_message: true, ask_field: null, ask_next_field: null, include_orcamento: false };
  directive.shouldReply = !!(directive.final_message);
  flowLog(perfil, chatId, 'decide_ok', directive);
  return directive;
}

const pendingField = c && c.funil && c.funil.pending && c.funil.pending.field;
if (pendingField) {
  const counts = (c && c.funil && c.funil.askCounts) ? c.funil.askCounts : {};
  const askedTimes = counts[pendingField] || 0;
  if (askedTimes >= 1) {
    // Não repetir a pergunta do mesmo campo enquanto pendente
    flowLog(perfil, chatId, 'pending_hold_no_repeat', { field: pendingField, askedTimes });
    return { blocked: false, ask_field: null, ask_next_field: null, include_orcamento: false, saudacao: false, shouldReply: false };
  }
  const include_orcamento = _decideIncludeOrcamento(c, pendingField);
  const directive = { ask_field: pendingField, ask_next_field: null, include_orcamento, saudacao: false };
  directive.shouldReply = true;
  flowLog(perfil, chatId, 'decide_ok', directive);
  return directive;
}



// Escolha próximo mandatory/optional (via Step Engine)

const field = stepEngine.nextFieldByOrder(c && c.data, c && c.flags || {});

if (!field) {

  // Nada a perguntar (completo). Sem directive.

  const directive = { ask_field: null, ask_next_field: null, include_orcamento: false, saudacao: false, done: true };

  directive.shouldReply = !!(directive.ask_field || directive.final_message === true);

  flowLog(perfil, chatId, 'decide_ok', directive);

  return directive;

}



_setPendingAsk(perfil, chatId, field);

const c2 = get(perfil, chatId);

const include_orcamento = _decideIncludeOrcamento(c2, field);

if (include_orcamento) patch(perfil, chatId, { flags: { explainedOrcamentoOnce: true } });



const directive = {

  ask_field: field,

  ask_next_field: null,

  include_orcamento,

  saudacao: c2.flags && c2.flags.greetDone === false

};

directive.shouldReply = !!(directive.ask_field || directive.final_message === true);

if (c2.flags && c2.flags.greetDone === false) patch(perfil, chatId, { flags: { greetDone: true } });

flowLog(perfil, chatId, 'decide_ok', directive);

return directive;



} catch (e) {

flowLog(perfil, chatId, 'error_decide', { error: (e && e.message) || String(e) });

throw e;

}

}



// Contexto para prompt/render

function buildRenderContext(perfil, chatId, directive) {

const c = get(perfil, chatId);

const ask_field = directive && directive.ask_field || null;

const ask_next_field = directive && directive.ask_next_field || null;

const include_orcamento = !!(directive && directive.include_orcamento);

const saudacao = !!(directive && directive.saudacao);

// Clona os dados atuais do chat para o contexto de render (fundamental para os steps e o renderer enxergarem o que já foi coletado)
const dataClone = deepClone(c.data || {});
const missingOrdered = Array.isArray(dataClone.missing) ? dataClone.missing.slice(0) : [];

// Campos já fornecidos (booleanos de presença)
const ja_fornecidos = {
telefone: !!dataClone.telefone,
ddd: !!dataClone.ddd,
telefone_parcial: !!dataClone.telefone_parcial,
itens: !!dataClone.itens,
endereco_saida: !!dataClone.endereco_saida,
endereco_destino: !!dataClone.endereco_destino,
ajudante: (typeof dataClone.ajudante === 'boolean'),
descricao: !!dataClone.descricao
};

// Na saudação, o "próximo campo" para o renderer deve ser o primeiro pendente real (usualmente telefone)
let nextFieldForAsk = ask_field;
if (ask_field === 'saudacao') {
nextFieldForAsk = missingOrdered[0] || 'telefone';
}

// Flags sombra: para renderizar a primeira mensagem com saudação+explicação e budget=2, mesmo que greetDone tenha sido marcado em decideNext
const flagsShadow = deepClone(c.flags || {});
if (ask_field === 'saudacao') {
flagsShadow.greetDone = false;              // libera saudação e 2 perguntas
flagsShadow.explainedOrcamentoOnce = false; // libera explicação de orçamento uma única vez
}

// Budget de perguntas: 2 na saudação, senão respeita a regra padrão (1 após saudação)
const questionBudget = (ask_field === 'saudacao') ? 2 : (flagsShadow.greetDone ? 1 : 2);

const ctx = {

meta: {

perfil: String(perfil || ''),

chatId: String(chatId || ''),

cidade: dataClone.cidade || null,

regiao: null

},

fluxo: {

saudacao,

explicar_orcamento: include_orcamento,

ordem: {

perguntar: ask_field,

perguntar_tambem: ask_next_field

},

estilo: 'acolhedor',

prioridade: 'normal'

},

dados: {

ja_fornecidos

},

interpretacao: {

tom_cliente: dataClone.tom_cliente || 'casual',

duvidas: []

},

historico: {

ultimas_do_cliente: Array.isArray(c.meta && c.meta.lastClientTexts) ? c.meta.lastClientTexts : []

},

flags: flagsShadow,

audit: c.audit || {},

funil: {

step: ask_field

},

render: {

nextField: nextFieldForAsk,

questionBudget

},

missingOrdered,

data: dataClone // Os steps e o renderer usam esses dados para pular perguntas já preenchidas e adaptar o texto

};

return ctx;

}



// Render via IA + sanitize (obedece directive; não decide step)

async function render(perfil, chatId, ctx) {

try {

const askField = ctx?.funil?.step || null;

if (!askField) {
// Fallback seguro — caso não haja step atual, retorna mensagem final do determinístico
return renderDeterministico(perfil, chatId, { final_message: true });
}

// Usa o renderer unificado (humano/curto, com 2 perguntas na primeira resposta) como padrão;
// se indisponível, fallback no step engine.
let text = '';

if (renderUnico) {
text = renderUnico(ctx);
} else {
const out = await stepEngine.runStep(ctx, askField, 1); // versão 1 default
text = out.ask || '';
if (sanitizeAnswerUnico) {
  text = sanitizeAnswerUnico(text, ctx);
}
}

// Após renderização, persistimos no estado possíveis alterações de flags/audit feitas durante o render
const flagsPatch = {};
if (ctx.flags && ctx.flags.greetDone) flagsPatch.greetDone = true;
if (ctx.flags && ctx.flags.explainedOrcamentoOnce) flagsPatch.explainedOrcamentoOnce = true;

const auditPatch = {};
if (ctx.audit && Array.isArray(ctx.audit.lastIAFingerprints)) {
  auditPatch.lastIAFingerprints = ctx.audit.lastIAFingerprints.slice(0, 2);
}

if (Object.keys(flagsPatch).length > 0 || Object.keys(auditPatch).length > 0) {
const patchObj = {};
if (Object.keys(flagsPatch).length > 0) patchObj.flags = flagsPatch;
if (Object.keys(auditPatch).length > 0) patchObj.audit = auditPatch;
patch(perfil, chatId, patchObj);
}

flowLog(perfil, chatId, 'render_ok', { provider: renderUnico ? 'render_unico' : 'step_engine', ask: askField, length: String(text || '').length });

return { text: String(text || ''), sanitized: false };

} catch (e) {

const msg = (e && e.message) || String(e);

if (/sanitize_invalidated_ask/i.test(msg)) {

flowLog(perfil, chatId, 'error_render_sanitize_invalidated', { error: msg });

throw e;

}

flowLog(perfil, chatId, 'error_render_engine', { error: msg });

throw e;

}

}



// Render determinístico (fallback estrito ao directive)

function renderDeterministico(perfil, chatId, directive) {

const ask = directive && directive.ask_field || null;

const next = directive && directive.ask_next_field || null;

const saudacao = directive && directive.saudacao;

const include_orcamento = directive && directive.include_orcamento;



const parts = [];

if (saudacao) parts.push('Oi!');



if (include_orcamento) {

parts.push('Faço o primeiro atendimento e repasso seus dados ao motorista.');

parts.push('Quem passa o orçamento é o motorista no WhatsApp assim que coletarmos seus dados.');

}



const askMap = {

telefone: 'Pode me passar o seu WhatsApp com DDD?',

itens: 'O que você precisa transportar?',

endereco_saida: 'Qual é o endereço de saída? Pode ser bairro ou ponto de referência.',

endereco_destino: 'Qual é o endereço de destino? Pode ser bairro ou ponto de referência.',

ajudante: 'Vai precisar de ajudante para carregar?',

descricao: 'Deseja adicionar alguma observação?'

};



if (ask && askMap[ask]) parts.push(askMap[ask]);

if (next && askMap[next]) parts.push(askMap[next]);



// Mensagem final (TTL)

if (directive && directive.final_message) {

parts.length = 0;

parts.push('Perfeito! Já repassei seu pedido ao motorista — ele vai te chamar no WhatsApp em alguns minutinhos para combinar os detalhes e informar o orçamento.');

parts.push('Qualquer coisa, fico por aqui.');

}



const text = parts.join(' ').replace(/\s+/g, ' ').trim();

flowLog(perfil, chatId, 'render_ok', { provider: 'deterministico', length: text.length, sanitized: false });

return { text };

}



// Queue (driver chamará este método antes de enfileirar localmente)

function computeEarliestSendAt(perfil, chatId, { lastClientTs } = {}) {

const base = Number(lastClientTs || now());

const jitterMs = jitter(REPLY_MIN_MS, REPLY_MAX_MS);

return base + jitterMs;

}

function queue(perfil, chatId, { texto, directive, cursorSig, earliestSendAt }) {

const c = get(perfil, chatId);

const scheduleAt = Number(earliestSendAt || 0) > 0 ? Number(earliestSendAt) : null;

const patchObj = {

schedule: { nextAllowedSendAt: scheduleAt },

cursor: { ia: { queuedSig: String(cursorSig || '') } },

audit: { lastEnqueueAt: now() }

};

patch(perfil, chatId, patchObj);

flowLog(perfil, chatId, 'queue_ok', {

earliestSendAt: scheduleAt,

key: `reply|${chatId}|${sha1(String(texto||'')).slice(0,8)}|${now()}`,

origin: 'reply',

directive: {

ask_field: directive && directive.ask_field || null,

ask_next_field: directive && directive.ask_next_field || null,

include_orcamento: !!(directive && directive.include_orcamento),

final_message: !!(directive && directive.final_message)

}

});

return true;

}

function ackQueued(perfil, chatId, cursorSig) {

// Opcional — mantém simetria, se quiser usar ack de fila

flowLog(perfil, chatId, 'ack_queue', { cursorSig: String(cursorSig || '') });

return true;

}



// Ack de envio — consolida envio, e congela se finalização

function ackSent(perfil, chatId, cursorSig) {

try {

patch(perfil, chatId, {

cursor: { ia: { sentSig: String(cursorSig || '') } },

audit: { lastSendAt: now() }

});

const c = get(perfil, chatId);



// Se finalização marcada por TTL: congela agora por FINAL_FREEZE_MS

if (c && c.flags && c.flags.finalizing === true) {

  const until = now() + FINAL_FREEZE_MS;

  freezeFinalization(perfil, chatId, until, 'ttl');

  patch(perfil, chatId, { flags: { finalizing: false } });

  flowLog(perfil, chatId, 'final_msg_sent', { until });

}



flowLog(perfil, chatId, 'ack_ok', { cursorSig: String(cursorSig || '') });

return true;



} catch (e) {

flowLog(perfil, chatId, 'error_ack', { error: (e && e.message) || String(e) });

return false;

}

}



// Congelamento por chat

function freezeFinalization(perfil, chatId, until, reason) {

const u = Number(until || 0);

patch(perfil, chatId, { freeze: { finalizationUntil: u, reason: String(reason || '') } });

flowLog(perfil, chatId, 'freeze', { until: u, reason: String(reason || '') });

return true;

}

function unfreeze(perfil, chatId) {

patch(perfil, chatId, { freeze: { finalizationUntil: null, reason: null } });

flowLog(perfil, chatId, 'unfreeze', {});

return true;

}



// Export da API (somente o solicitado)

module.exports = {

get,

patch,

ingestFromVirtus,

decideNext,

buildRenderContext,

render,

renderDeterministico,

queue,

ackQueued,

ackSent,

freezeFinalization,

unfreeze,

flowLog,

// opcional util para o driver janelar respostas:

computeEarliestSendAt

};

