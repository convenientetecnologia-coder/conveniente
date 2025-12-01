// scripts/virtus.js
/**
Runner do Virtus: Mantém uma aba do Messenger aberta/ativa/logada e atende automaticamente os chats Marketplace.
Arquitetura:
- 1 instância de Virtus por perfil (navegador), totalmente independente.
- Polling de novos chats a cada 30s por perfil.
- Atendimento contínuo 1–2 min por chat, por perfil, sem depender do tick de 30s.
- Persistência segura do histórico no Windows (write tmp -> unlink final -> rename/copy) + cache em memória 24h.
- Snapshot:
  - Se NÃO existir chats_respondidos.json: cria arquivo e marca TODOS <24h atuais como respondidos (não cria backlog antigo).
  - Se JÁ existir: retoma e enfileira somente <24h ainda não respondidos, sem marcar nada nesse momento.
- Anti-duplicação por ID com TTL de 24h (não usa DOM para decidir).
*/

// Carregar variáveis de ambiente PRIMEIRO (antes de qualquer verificação)
try {
  require('dotenv').config();
} catch (e) {
  // dotenv pode não estar instalado, mas tentamos carregar mesmo assim
}

const fs = require('fs/promises');
const fsRaw = require('fs'); // Necessário para uso síncrono dentro de getPerfilManifest
const path = require('path');
const crypto = require('crypto');
const { patchPage, ensureMinimizedWindowForPage } = require('./browser.js');
const utils = require('./utils.js');
const stepLog = require('./stepLog.js');
const chatLock = require('./chatLock.js');
const logger = require('./logger.js');
const manifestStore = require('./manifestStore.js');
const pedidos = require('./pedidosFretes.js');
const fileStore = require('./fileStore.js');

// === IA-FIRST MODE: chama LLM em toda mensagem nova do cliente ===
const AI_FIRST = false;

// Funções de dedupe de mensagem
function normalizeContent(s) {
  return String(s||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'')
     .replace(/[{}[\]]/g, ' ')
     .replace(/\s+/g,' ')
     .trim().toLowerCase();
}

function nearEqual(a, b) {
  const na = normalizeContent(a), nb = normalizeContent(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  if (na.includes(nb) || nb.includes(na)) return true;
  return Math.abs(na.length - nb.length) <= 5 && (na.includes(nb) || nb.includes(na));
}

function isNoiseNorm(n) {
  const s = String(n || '').trim();
  if (!s) return true;
  // Normaliza
  const t = normalizeContent(s);
  if (!t) return true;

  // Lixos comuns do Messenger/Marketplace
  if (t === 'inserir') return true;
  if (t === 'mensagem nao lida' || t === 'mensagem não lida') return true;
  if (/^\d{1,2}:\d{2}$/.test(t)) return true;              // "03:26"
  if (/^(hoje|ontem)\b/.test(t)) return true;
  if (/^\s*[·•]\s*$/.test(s)) return true;                 // bullet solto
  if (/^voce:|^v[oó]ce:|^you:/.test(t)) return true;       // prefixos de autoria no texto
  if (/^voce\s+enviou\b|^you\s+sent\b/.test(t)) return true;
  if (/^\W+$/.test(s)) return true;                        // só sinais
  // Marcas do cabeçalho "Conveniente …" (curtas)
  if (/\bconveniente\b/.test(t) && t.length <= 80) return true;

  // Linhas curtas com tempo relativo, sem conteúdo semântico
  if (/\b(min|mins?|minuto|minutos|hora|horas|day|days|dia|dias)\b/.test(t) && t.length <= 40) return true;

  // Status de mensagem (enviado, entregue, visto, etc)
  if (/^(enviado|enviada|sent|delivered|visto|visualizado|lida|seen)$/.test(t)) return true;
  if (/\b(you\s+sent|voc[eê]\s+enviou)\b/.test(t)) return true;

  return false;
}

function semanticallyRelevant(m) {
  try {
    if (!m || !m.texto) return false;
    const t = normalizeContent(String(m.texto || ''));
    if (!t) return false;

    // Telefone/partials (8–11 dígitos) é sempre novidade
    if (/\b\d{8,11}\b/.test(t)) return true;

    // Pergunta nova
    if (/[?？]/.test(m.texto)) return true;

    // Palavras-chave de endereço (aceita informal)
    if (/\b(rua|avenida|av\.|rodovia|estrada|bairro|kobrasol|centro|mercado|shopping|posto|parque)\b/.test(t)) return true;

    // Itens comuns de frete/mudança
    if (/\b(cama|sofa|sof[aá]|guarda\-roupa|geladeira|fog[aã]o|moveis|móveis|colch[aã]o|mesa|cadeira|máquina|lavar|secadora)\b/.test(t)) return true;

    // "Disponível?" isolado ou variações curtas sem mais conteúdo NÃO são novidade
    if ((/disponivel|disponível/.test(t)) && t.length < 40) return false;

    return true;

  } catch {
    return false;
  }
}

function explodeAndFilterLines(entry, ultimaIaNorm) {
  const out = [];
  const ts = Number(entry && entry.timestamp || Date.now());
  const autor = entry && entry.autor === 'ia' ? 'ia' : 'cliente';
  const raw = String(entry && entry.texto || '');

  const parts = raw.split(/\r?\n+/).map(s => s.trim()).filter(Boolean);

  for (const line of parts) {
    const ln = normalizeContent(line);
    if (!ln) continue;

    // "Você:"/"You:" no início: trata como IA somente se a autoria já vier 'ia'
    if (/^voce:|^v[oó]ce:|^you:/.test(ln)) {
      if (autor === 'ia') out.push({ autor: 'ia', texto: line, timestamp: ts });
      continue; // se não for IA, ignora a linha (Messenger ecoa prefixo)
    }

    // Ruído
    if (isNoiseNorm(ln)) continue;

    // Anti-eco: se for mensagem do cliente idêntica à última IA enviada, ignore
    if (autor === 'cliente' && ultimaIaNorm) {
      if (nearEqual(ln, ultimaIaNorm)) continue;
    }

    out.push({ autor, texto: line, timestamp: ts });
  }

  return out;
}

function sanitizeHistoricoRecords(historico, ultimaIaNorm) {
  const rows = Array.isArray(historico) ? historico : [];
  const exploded = [];

  for (const e of rows) {
    const items = explodeAndFilterLines(e, ultimaIaNorm);
    for (const it of items) exploded.push(it);
  }

  // Ordena e garante monotonicidade
  exploded.sort((a,b) => (Number(a.timestamp||0) - Number(b.timestamp||0)));
  for (let i=1;i<exploded.length;i++) {
    if (Number(exploded[i].timestamp) <= Number(exploded[i-1].timestamp)) {
      exploded[i].timestamp = Number(exploded[i-1].timestamp) + 1;
    }
  }

  // Dedup curta janela por autor: mensagens iguais em <=2.5s viram ruído
  const dedup = [];
  const lastByAutor = { ia: {norm:'', ts:0}, cliente:{norm:'', ts:0} };
  for (const m of exploded) {
    const n = normalizeContent(m.texto);
    if (!n) continue;
    const prev = lastByAutor[m.autor] || { norm:'', ts:0 };
    const delta = Math.abs(Number(m.timestamp||0) - Number(prev.ts||0));
    if (prev.norm && nearEqual(n, prev.norm) && delta <= 2500) continue;
    dedup.push(m);
    lastByAutor[m.autor] = { norm:n, ts: Number(m.timestamp||0) };
  }

  return dedup;
}

// Vinculação de eventos do orquestrador por perfil — evita múltiplos listeners
const __pedidosEventBound = new Set();

function bindPedidosEventsIfNeeded(nome, enviarPedidoParaNotificadorFn, enviarRespostaMessengerSeguraFn, marcarRespondidoFn) {
  if (__pedidosEventBound.has(nome)) return;
  __pedidosEventBound.add(nome);

  // Envio de pedido (completo/incompleto) -> envia ao notificador e respeita freeze (marcado pelo orquestrador)
  pedidos.events.on('orderSent', async ({ perfil, chatId, tipo, payload }) => {
    try {
      if (perfil !== nome) return; // evento de outro perfil
      try {
        await enviarPedidoParaNotificadorFn(chatId, payload);
      } catch (e) {
        try { await issues.append(perfil, 'order_sent_notifier_fail', (e && e.message) || String(e)); } catch {}
      }
      try { await issues.append(perfil, 'pedidos_freeze_window_enter', `chat=${chatId}`); } catch {}
    } catch {}
  });

  // Ping único de inatividade pedindo WhatsApp
  pedidos.events.on('inactivityPing', async ({ perfil, chatId, texto }) => {
    try {
      if (perfil !== nome) return;
      const payload = String(texto || 'Perfeito, já encaminhei seu contato ao motorista. Ele te chama no WhatsApp em alguns minutinhos para passar o orçamento certinho. Qualquer coisa, é só responder aqui.').trim();
      await queueMessengerSend(nome, {
        chatId,
        resposta: payload,
        key: `inactivity|${chatId}|${sha1(payload)}|${Date.now()}`,
        fromNotifier: false,
        origin: 'inactivityPing'
      });
    } catch {}
  });

  pedidos.events.on('handoffToHuman', async ({ perfil, chatId, reason }) => {
    try {
      if (perfil !== nome) return;
      const texto = 'Para te atender com todos os detalhes, preciso que você envie o seu WhatsApp. Assim, o motorista te chama direto no Whats e tira todas as suas dúvidas. Fico por aqui caso precise de algo mais ou queira continuar.';
      await queueMessengerSend(nome, {
        chatId,
        resposta: texto,
        key: `handoff|${chatId}|${sha1(texto)}|${Date.now()}`,
        fromNotifier: false,
        origin: 'handoffToHuman'
      });
          } catch {}
  });

  // Resposta pronta pelo pedidos.js -> enviar no Messenger (com gate por cursor)
  pedidos.events.on('replyReady', async ({ perfil, chatId, texto, cursorCount, cursorDigest, cursorSig, lastClientTs }) => {
    try {
      if (perfil !== nome) return;
      const payload = String(texto || '').trim();
      if (!payload) return;

      const evCount = Number(cursorCount || 0);
      const evDigest = String(cursorDigest || '');
      const evSig = String(cursorSig || (evCount && evDigest ? `${evCount}|${evDigest}` : ''));
      const evLastTs = Number(lastClientTs || 0) || undefined;

      // Throttle por cursorSig (já existente — não modifique)
      let stCur = await getChatState(nome, chatId).catch(()=>null);
      const lastEvMap = (stCur && stCur.lastReplyEvMap) || {};
      const nowMs = Date.now();
      if (evSig && lastEvMap[evSig] && (nowMs - lastEvMap[evSig]) < 2000) {
        await stepLog.appendJSONL(nome, 'virtus', { step: 'reply_throttle_same_cursor', chatId, evSig });
        logger.info('[REPLY] throttle_same_cursor', { nome, chatId, evSig });
        return;
      }
      if (evSig) {
        lastEvMap[evSig] = nowMs;
        await setChatState(nome, chatId, { lastReplyEvMap: lastEvMap });
      }

      // Gate fallback por repliedCursor* permanece igual

      const cCount = Number(stCur && stCur.clientCursorCount || 0);
      const cDigest = stCur && stCur.clientCursorDigest || '';
      const rCount = Number(stCur && stCur.repliedCursorCount || 0);
      const rDigest = stCur && stCur.repliedCursorDigest || '';

      if (cCount && cDigest && rCount === cCount && rDigest && rDigest === cDigest) {
        await stepLog.appendJSONL(nome, 'virtus', { step: 'reply_skip_same_cursor', chatId, cCount, cDigest });
        logger.info('[REPLY] skip_same_cursor(fallback)', { nome, chatId, cCount, cDigest });
        return;
      }

      // Enfileira resposta — passe lastClientTsOverride!
      const queuedOk = await queueMessengerSend(nome, {
        chatId,
        resposta: payload,
        key: `replyReady|${chatId}|${sha1(payload)}|${Date.now()}`,
        fromNotifier: false,
        origin: 'replyReady',
        cursorSig: evSig,
        cursorCountOverride: evCount || undefined,
        cursorDigestOverride: evDigest || undefined,
        lastClientTsOverride: evLastTs
      });

      if (queuedOk) {
        try { pedidos.ackReplyQueued(nome, chatId, evSig); } catch {}
      }

      logger.info('[REPLY] queued', { nome, chatId, evSig });

    } catch {}
  });
}

const CHAT_LOG_BUFFERS = new Map();  // file -> [line]
let CHAT_LOG_FLUSH_TIMER = null;

function scheduleChatLogFlush() {
  if (CHAT_LOG_FLUSH_TIMER) return;
  CHAT_LOG_FLUSH_TIMER = setTimeout(async () => {
    const entries = Array.from(CHAT_LOG_BUFFERS.entries());
    CHAT_LOG_BUFFERS.clear();
    CHAT_LOG_FLUSH_TIMER = null;
    for (const [file, lines] of entries) {
      try {
        await fs.mkdir(path.dirname(file), { recursive: true });
        fsRaw.appendFileSync(file, lines.join(''), 'utf8');
      } catch {}
    }
  }, 200);
}

const CHAT_STATE_PENDING = new Map(); // perfil -> { chatId -> patch acumulado }
let CHAT_STATE_FLUSH_TIMER = null;
function scheduleChatStateFlush() {
  if (CHAT_STATE_FLUSH_TIMER) return;
  CHAT_STATE_FLUSH_TIMER = setTimeout(async () => {
    const copy = new Map(CHAT_STATE_PENDING);
    CHAT_STATE_PENDING.clear();
    CHAT_STATE_FLUSH_TIMER = null;
    for (const [perfil, map] of copy.entries()) {
      try {
        const st = await readJsonFsyncSafe(CHAT_STATE_FILE(perfil), {});
        for (const [chatId, patch] of map.entries()) {
          st[chatId] = Object.assign({}, st[chatId] || {}, patch, { updatedAt: Date.now() });
        }
        await writeJsonFsyncAtomic(CHAT_STATE_FILE(perfil), st);
      } catch {}
    }
  }, 200);
}

async function installChatFeedObserver(page, nome, onChat) {
  if (!page || page._virtusChatObserverInstalled) return;
  page._virtusChatObserverInstalled = true;

  await page.exposeFunction('__virtusOnNewChat', (payload) => {
    try {
      if (!payload || !payload.id) return;
      onChat && onChat(payload);
    } catch {}
  });

  await page.evaluateOnNewDocument(() => {
    (function(){
      const seen = new Set();
      function extractId(href) {
        try {
          const s = String(href || '');
          const pos = s.indexOf('/marketplace/t/');
          if (pos < 0) return null;
          const rest = s.slice(pos + '/marketplace/t/'.length);
          const id = rest.split(/[/?#]/)[0];
          return id && /^\d+$/.test(id) ? id : null;
        } catch { return null; }
      }
      function labelOf(row) {
        try {
          const abbr = row && row.querySelector && row.querySelector('abbr[aria-label]');
          if (abbr) {
            return (abbr.getAttribute('aria-label') || abbr.innerText || abbr.textContent || '').trim();
          }
          const sp = row && row.querySelector && row.querySelector('span');
          if (sp) return (sp.innerText || sp.textContent || '').trim();
        } catch {}
        return '';
      }
      function scan(root) {
        try {
          const anchors = Array.from(root.querySelectorAll('a[href^="/marketplace/t/"]'));
          for (const a of anchors) {
            const id = extractId(a.getAttribute('href') || a.href || '');
            if (!id) continue;
            const row = a.closest('div[role="row"]') || a.parentElement || document.body;
            const tempo = labelOf(row);
            const key = id + '|' + tempo;
            if (seen.has(key)) continue;
            seen.add(key);
            (window.__virtusOnNewChat && window.__virtusOnNewChat({ id, tempo })) || null;
          }
        } catch {}
      }
      const obs = new MutationObserver((muts) => {
        try {
          for (const m of muts) {
            if (m.addedNodes && m.addedNodes.length) {
              m.addedNodes.forEach(n => {
                if (n && n.querySelectorAll) scan(n);
              });
            }
          }
        } catch {}
      });
      window.addEventListener('DOMContentLoaded', () => {
        try {
          const root = document.querySelector('div[role="grid"]') || document.body;
          if (root) scan(root);
          obs.observe(document.body, { childList: true, subtree: true });
        } catch {}
      });
    })();
  });
}


const VIRTUS_INPUT_LOCKS = new Map();
function setVirtusInputLock(nome, v){ if (v) VIRTUS_INPUT_LOCKS.set(nome,true); else VIRTUS_INPUT_LOCKS.delete(nome); }
function isVirtusLocked(nome){ return VIRTUS_INPUT_LOCKS.has(nome); }

function getBrowserFromPage(p) { try { return typeof p.browser === 'function' ? p.browser() : null; } catch { return null; } }
async function acquireSendGuard(p, chatId) { try { const b = getBrowserFromPage(p); if (b) b._sendLock = { active: true, owner: 'virtus', chatId, since: Date.now() }; } catch {} }
function releaseSendGuard(p) { try { const b = getBrowserFromPage(p); if (b && b._sendLock && b._sendLock.owner === 'virtus') b._sendLock.active = false; } catch {} }


function chatLogPath(perfil, chatId) {
  return path.join(__dirname, '..', 'dados', 'perfis', perfil, 'chats', `${chatId}.jsonl`);
}

// Helpers de idempotência persistente e log forense
function pedidoSentFile(perfil, chatId) {
  return path.join(__dirname, '..', 'dados', 'perfis', perfil, 'chats', `${chatId}.pedido.json`);
}

function pedidoAuditLog(perfil) {
  return path.join(__dirname, '..', 'dados', 'perfis', perfil, 'pedidos_audit.jsonl');
}

function sha1(str) {
  return crypto.createHash('sha1').update(String(str), 'utf8').digest('hex');
}

async function loadPedidoSent(perfil, chatId) {
  try { return JSON.parse(fsRaw.readFileSync(pedidoSentFile(perfil, chatId), 'utf8')); } catch { return null; }
}

async function writeJsonAtomicFsyncStrict(file, obj) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  const fd = fsRaw.openSync(tmp, 'w');
  try {
    fsRaw.writeFileSync(fd, JSON.stringify(obj, null, 2), 'utf8');
    fsRaw.fsyncSync(fd);
  } finally { fsRaw.closeSync(fd); }
  try { fsRaw.unlinkSync(file); } catch {}
  try { fsRaw.renameSync(tmp, file); }
  catch { fsRaw.copyFileSync(tmp, file); try { fsRaw.unlinkSync(tmp); } catch {} }
}

async function markPedidoSent(perfil, chatId, payload, source) {
  const file = pedidoSentFile(perfil, chatId);
  const rec = { sentAt: Date.now(), source, payloadHash: sha1(JSON.stringify(payload)), payload };
  await writeJsonAtomicFsyncStrict(file, rec);
  const auditData = { source, cidade: payload && payload.cidade };
  if (payload && payload.telefone) auditData.telefone = maskPhoneLog(payload.telefone);
  await appendPedidoAudit(perfil, chatId, 'sent_ok', auditData);
}

async function appendPedidoAudit(perfil, chatId, event, data) {
  try {
    await fs.mkdir(path.dirname(pedidoAuditLog(perfil)), { recursive: true });
    fsRaw.appendFileSync(pedidoAuditLog(perfil), JSON.stringify({
      ts: Date.now(), chatId, event, ...((data && typeof data === 'object') ? data : { info: String(data||'') })
    }) + '\n', 'utf8');
  } catch {}
  try { await issues.append(perfil, 'pedido_audit', `${event} chat=${chatId} ${data ? JSON.stringify(data).slice(0,200) : ''}`); } catch {}
}

async function appendChatHistoryLog(perfil, chatId, historicoArr) {
  try {
    const file = chatLogPath(perfil, chatId);
    const st = await getChatState(perfil, chatId).catch(()=>null);
    const lastTs = st && st.chatLogLastTs || 0;
    const novos = (historicoArr||[]).filter(m => Number(m.timestamp||0) > lastTs);
    if (!novos.length) return;
    await fs.mkdir(path.dirname(file), { recursive: true });
    for (const m of novos) {
      // Sanitiza mensagens antes de salvar (remove telefones completos)
      const mSanitizado = Object.assign({}, m);
      if (mSanitizado.texto) {
        mSanitizado.texto = removeTelefonesCompletosLoose(String(mSanitizado.texto || ''));
      }
      fsRaw.appendFileSync(file, JSON.stringify(mSanitizado)+'\n', 'utf8');
    }
    const maxTs = Math.max(...novos.map(m=>Number(m.timestamp||0)));
    await setChatState(perfil, chatId, { chatLogLastTs: maxTs || Date.now() });
  } catch {}
}

async function appendIaLine(perfil, chatId, texto) {
  const textoSanitizado = sanitizeOutgoing(removeTelefonesCompletosLoose(String(texto||'')));
  const obj = { autor:'ia', texto: textoSanitizado, timestamp: Date.now() };
  const file = chatLogPath(perfil, chatId);
  try { fsRaw.mkdirSync(path.dirname(file), { recursive: true }); fsRaw.appendFileSync(file, JSON.stringify(obj)+'\n', 'utf8'); } catch {}
  try { await setChatState(perfil, chatId, { chatLogLastTs: obj.timestamp }); } catch {}
}


async function assertOnChat(p, chatId, { timeoutMs = 0 } = {}) {
  const t0 = Date.now();
  while (true) {
    const ok = await p.evaluate((id) => {
      try { return (location && typeof location.pathname === 'string') ? location.pathname.includes('/marketplace/t/' + id) : false; }
      catch { return false; }
    }, chatId).catch(() => false);
    if (ok) return true;
    if (!timeoutMs || (Date.now() - t0) >= timeoutMs) return false;
    await sleep(120);
  }
}
async function clearComposerIfAny(p, campo) {
  try {
    if (!campo) return;
    const ctrlKey = (process.platform === 'darwin') ? 'Meta' : 'Control';
    try { await campo.click({ delay: 20 }); } catch {}
    try { await p.keyboard.down(ctrlKey); await p.keyboard.press('KeyA'); await p.keyboard.up(ctrlKey); } catch {}
    try { await p.keyboard.press('Backspace'); } catch {}
    try { await p.keyboard.press('Delete'); } catch {}
  } catch {}
}

const VIRTUS_SCROLL_DEBUG = process.env && process.env.VIRTUS_SCROLL_DEBUG === '1';
const VIRTUS_DETAILED_DEBUG = process.env && process.env.VIRTUS_DEBUG === '1';

const virtusDeadLogTimes = {}; // { [nome]: timestamp }

setInterval(() => {
  const now = Date.now();
  for (const [k, v] of Object.entries(virtusDeadLogTimes)) {
    if (now - v > 24 * 60 * 60 * 1000) delete virtusDeadLogTimes[k];
  }
}, 60 * 60 * 1000);

let issues = null;
try { issues = require('./issues.js'); } catch { issues = null; }

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function chatUrlMatches(url, chatId) {
  try {
    const u = String(url || '');
    const re = new RegExp(`/marketplace/t/${chatId}(?:[/?#]|$)`);
    return re.test(u);
  } catch { return false; }
}

function randomBetween(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

// === INÍCIO: HELPERS DE ATENDIMENTO (NÃO REMOVER) ===
function hasPriceIntent(s) {
  const t = String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  return /(pre[cç]o|valor|quanto\s+(custa|fica|sai)|cobra|or[cç]amento)/i.test(t);
}

function maskPhoneLog(d) {
  try {
    const s = String(d || '').replace(/\D/g, '');
    if (s.length < 4) return '';
    if (s.length === 10 || s.length === 11) {
      const ddd = s.slice(0,2);
      const last4 = s.slice(-4);
      return `${ddd}****${last4}`;
    }
    if (s.length >= 8) return `**${s.slice(-4)}`;
    return '';
  } catch { return '****'; }
}

function removeTelefonesCompletos(texto) {
  try { return String(texto||'').replace(/\b\d{8,11}\b/g, '******'); } catch { return String(texto||''); }
}

function removeTelefonesCompletosLoose(s) {
  try {
    let x = String(s||'');
    x = x.replace(/\b(?:\+?55\s*)?(?:\(?[1-9]{2}\)?[\s.\-()]?)?(?:9?\d{4}[\s.\-()]?\d{4})\b/g, '*');
    x = x.replace(/\b\d{3}\.?\d{3}\.?\d{3}-?\d{2}\b/g, '[dados omitidos]'); // CPF
    x = x.replace(/\b\d{2}\.?\d{3}\.?\d{3}\/?\d{4}-?\d{2}\b/g, '[dados omitidos]'); // CNPJ
    x = x.replace(/\b(?:\d[\s.\-()]?){8,11}\b/g, '**'); // generic
    return x;
  } catch { return String(s||''); }
}

function isValidBRPhoneWithDDD(d) {
  try {
    const s = String(d || '').replace(/\D/g, '');
    if (s.length === 11) return /^[1-9]{2}9\d{8}$/.test(s);
    if (s.length === 10) return /^[1-9]{2}[2-9]\d{7}$/.test(s);
    return false;
  } catch {
    return false;
  }
}

function extractPlainTextFromMaybeJSON(raw) {
  try {
    let s = String(raw == null ? '' : raw);
    if (!s) return '';

    // Se contiver um objeto JSON, tenta parsear e pegar "resposta"
    const m = s.match(/\{[\s\S]*\}/);
    if (m && m[0]) {
      try {
        const obj = JSON.parse(m[0]);
        if (obj && typeof obj.resposta === 'string' && obj.resposta.trim()) {
          return obj.resposta.replace(/\r?\n+/g, ' ').trim();
        }
      } catch {}
    }

    // Se tiver a chave "resposta" no texto, extrai via regex
    const r = s.match(/"resposta"\s*:\s*"((?:\\.|[^"\\])*)"/i);
    if (r && r[1]) {
      return r[1].replace(/\\"/g, '"').replace(/\r?\n+/g, ' ').trim();
    }

    // Se parecer JSON (chaves/colchetes), remova e achate
    if (/^\s*[{[]/.test(s) || /"dados"\s*:/.test(s)) {
      s = s.replace(/[{}[\]]/g, ' ').replace(/"[^"]*"\s*:/g, ' ').replace(/\r?\n+/g, ' ');
    }

    // Achatar quebras de linha por segurança
    s = s.replace(/\r?\n+/g, ' ').replace(/\s+/g, ' ').trim();
    return s;

  } catch {
    return String(raw || '').replace(/\r?\n+/g, ' ').trim();
  }
}

function nextMissingField(dc = {}) {
  if (!dc.itens) return 'itens';
  if (!dc.endereco_saida) return 'endereco_saida';
  if (!dc.endereco_destino) return 'endereco_destino';
  if (typeof dc.ajudante !== 'boolean') return 'ajudante';
  return null;
}

async function getAskCounts(perfil, chatId) {
  const st = await getChatState(perfil, chatId).catch(()=>null);
  return (st && st.dadosMeta && st.dadosMeta.askCounts) ? st.dadosMeta.askCounts : {};
}
async function bumpAskCount(perfil, chatId, field) {
  if (!field) return;
  const st = await getChatState(perfil, chatId).catch(()=>({}));
  const meta = Object.assign({}, (st && st.dadosMeta) || {});
  meta.askCounts = meta.askCounts || {};
  meta.askCounts[field] = (meta.askCounts[field] || 0) + 1;
  await setChatState(perfil, chatId, { dadosMeta: meta });
}

function montarRespostaForcadaWhatsAppSemDDD(dados, askCounts = {}) {
  const telOk = !!(dados && dados.telefone && isValidBRPhoneWithDDD(dados.telefone));
  const temParcial = !!(dados && dados.telefone_parcial);
  const temDDD = !!(dados && dados.ddd);

  // Se já tem telefone válido, não peça nada
  if (telOk) return null;

  // Caso seja parcial sem DDD, peça APENAS o DDD
  if (temParcial && !temDDD) {
    const frasesDDD = [
      'Perfeito! Pode me informar o DDD?',
      'Certo! Me passa só o DDD, por favor?',
      'Legal! Qual o DDD?'
    ];
    return frasesDDD[(askCounts.ddd || 0) % frasesDDD.length];
  }

  // Caso contrário, peça APENAS o WhatsApp (nunca "com DDD")
  const frasesWpp = [
    'Quem informa o valor é o motorista. Pode me passar o seu WhatsApp?',
    'O orçamento é passado pelo motorista. Me manda seu WhatsApp?',
    'O motorista informa o valor. Me passa o seu WhatsApp, por favor?'
  ];
  return frasesWpp[(askCounts.telefone || 0) % frasesWpp.length];
}

function detectAskedFieldFromText(t) {
  const n = normTxt(t);
  // Endereço de saída
  if (/(endereco|endereço).*(sa[ií]da|retirada)|onde\s+(buscar|retirar)|local\s+de\s+retirada/.test(n)) return 'endereco_saida';
  // Endereço de destino
  if (/(endereco|endereço).*(destino|entrega)|para\s+onde|local\s+de\s+entrega/.test(n)) return 'endereco_destino';
  if (/ajudante/.test(n)) return 'ajudante';
  if (/itens?|o que\s+(levar|transportar)/.test(n)) return 'itens';
  return null;
}


function normTxt(s) {
  try { return String(s||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase(); }
  catch { return String(s||'').toLowerCase(); }
}
function extractBairro(text, pattern) {
  const m = pattern.exec(text);
  if (!m) return null;
  return String(m[1] || '').trim().replace(/[\s,.;:!?]+$/,'');
}

function interpretYesNo(raw) {
  const t = normTxt(raw || '');
  if (/^(sim|isso|claro|afirmativo)\b/.test(t)) return true;
  if (/\b(vou precisar|com ajudante)\b/.test(t)) return true;
  if (/^(nao|não|n)\b/.test(t)) return false;
  if (/\b(sem ajudante|nao vou precisar|não vou precisar|dispenso)\b/.test(t)) return false;
  return null;
}



function sanitizeOutgoing(text) {
  try {
    let s = String(text == null ? '' : text);
    s = s.replace(/[\u200B-\u200D\uFEFF]/g, '');     // Zero-width
    s = s.replace(/[ \t]+/g, ' ');                   // Espaços múltiplos
    s = s.replace(/\s+([,.!?;:])/g, '$1');           // Espaço antes de pontuação
    s = s.replace(/([,.!?;:]){2,}/g, '$1');          // Pontuação repetida
    return s.trim();
  } catch {
    return String(text || '').trim();
  }
}


function getNewClientMessagesSince(historico, cutTs) {
  try {
    const base = Number(cutTs || 0);
    return (historico || []).filter(m => m && m.autor === 'cliente' && Number(m.timestamp || 0) >= base);
  } catch {
    return [];
  }
}

function detectProtestText(t) {
  const n = String(t || '').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase();
  return (
    /ja falei|já falei|ja passei|já passei|olha acima|leia acima|vc nao leu|você nao leu|você é burro|voce e burro|pare de perguntar|para de perguntar|nao insista|não insista|de novo|ta me tirando|vc é burro|vc ta doido|porra|pqp/i.test(n)
  );
}

function detectClientDoubt(msg) {
  const patterns = [
    /como assim/i,
    /n[ãa]o entendi/i,
    /explica/i,
    /o que (é|eh|significa)/i,
    /não ficou claro/i,
    /n[ãa]o sei/i,
    /não compreendi/i,
    /não peguei/i,
    /poderia explicar/i,
    /que significa/i
  ];
  const text = String(msg || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  return patterns.some(rx => rx.test(text));
}

function hasAvailabilityIntent(text) {
  const t = String(text||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase();
  return /disponivel|disponível|ainda tem|tem ainda|esta disponivel|está disponivel|ta disponivel|tá disponivel/.test(t);
}


async function waitForSendLockRelease(p, maxMs = 15000) {
  try {
    const b = getBrowserFromPage(p);
    const start = Date.now();
    while (true) {
      if (!b || !b._sendLock || !b._sendLock.active) return true;
      if ((Date.now() - start) > maxMs) return false;
      await sleep(120);
    }
  } catch { return true; }
}

// === FIM: HELPERS DE ATENDIMENTO (NÃO REMOVER) ===

async function logIssue(nome, type, message) {
  try {
    if (issues && typeof issues.append === 'function') {
      await issues.append(nome, type, message);
    }
  } catch {
  }
}

function getSetAguardando(nomePerfil) {
  if (!aguardandoRespostaMap.has(nomePerfil)) aguardandoRespostaMap.set(nomePerfil, new Set());
  return aguardandoRespostaMap.get(nomePerfil);
}

async function identificarTipoServico(nomePerfil) {
  try {
    const man = await manifestStore.read(nomePerfil).catch(()=>null);
    if (man && man.automoveis === true) return 'automoveis';
    if (man && man.imoveis === true) return 'imoveis';
    if (man && String(man.robeMode || '').toLowerCase() === 'veiculos') return 'automoveis';
    return 'fretes';
  } catch {
    return 'fretes';
  }
}

async function fazerHandshakeNotificador(nomePerfil) {
  if (handshakesFeitos.has(nomePerfil)) return;
  const tipoServico = await identificarTipoServico(nomePerfil);
  try {
    await fetch(`${NOTIFICADOR_URL}/api/virtus/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        servidor: NOTIFICADOR_SERVIDOR,
        tipo_servico: tipoServico,
        perfil: nomePerfil
      })
    });
    logger.info('[NOTIFICADOR] Handshake realizado', { nomePerfil, tipoServico });
    handshakesFeitos.add(nomePerfil);
  } catch (e) {
    logger.error('[NOTIFICADOR] Erro no handshake', { nomePerfil, error: e && e.message || e });
  }
}

function adicionarChatParaEnvio(nomePerfil, dadosChat) {
  if (!filaEnviarNotificador.has(nomePerfil)) {
    filaEnviarNotificador.set(nomePerfil, []);
  }
  filaEnviarNotificador.get(nomePerfil).push(dadosChat);

  try { markAguardando(nomePerfil, dadosChat.chatId); } catch {}

  setTimeout(() => enviarLoteNotificador(nomePerfil), NOTIFICADOR_ENVIO_LOTE_MS);
}

async function enviarLoteNotificador(nomePerfil) {
  const fila = filaEnviarNotificador.get(nomePerfil) || [];
  if (fila.length === 0) return;
  const lote = fila.splice(0); // pega todos

  await Promise.all(lote.map(async (dadosChat) => {
    try {
      // Sanitiza histórico antes de enviar (remove telefones completos)
      const historicoSanitizado = (dadosChat.historico || []).map(m => {
        const mSanitizado = Object.assign({}, m);
        if (mSanitizado.texto) {
          mSanitizado.texto = removeTelefonesCompletosLoose(String(mSanitizado.texto || ''));
        }
        return mSanitizado;
      });
      
      const payload = {
        servidor: NOTIFICADOR_SERVIDOR,
        chat_id: dadosChat.chatId,
        perfil: nomePerfil,
        tipo_servico: dadosChat.tipoServico,
        historico: historicoSanitizado,
        localizacao: dadosChat.localizacao, // Formato: "Cidade (UF)" - ex: "Florianopolis (SC)"
        url_classificado: dadosChat.urlClassificado,
        timestamp: new Date().toISOString()
      };
      
      const urlCompleta = `${NOTIFICADOR_URL}/api/virtus/chat`;
      
      logger.info('[NOTIFICADOR] Enviando chat', { 
        nomePerfil, 
        chatId: dadosChat.chatId,
        historicoSize: payload.historico.length,
        localizacao: payload.localizacao,
        tipoServico: payload.tipo_servico,
        url: urlCompleta,
        servidor: payload.servidor
      });
      
      const response = await fetch(urlCompleta, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      
      const responseText = await response.text().catch(() => '');
      let responseData = null;
      try {
        responseData = responseText ? JSON.parse(responseText) : null;
      } catch {
        responseData = null;
      }
      
      if (response.ok && responseData && responseData.ok === true) {
        logger.info('[NOTIFICADOR] Chat enviado com sucesso', { nomePerfil, chatId: dadosChat.chatId });
        
        // Limpa aguardando de imediato após POST ok
        try {
          const s = getSetAguardando(nomePerfil);
          s.delete(dadosChat.chatId);
          clearAguardTimer(nomePerfil, dadosChat.chatId);
          // Libere também lastProbeAt, se for preciso para fila (dependendo de sua implementação)
          const st = await getChatState(nomePerfil, dadosChat.chatId).catch(()=>null);
          if (st) {
            await setChatState(nomePerfil, dadosChat.chatId, { lastProbeAt: Date.now() - (parseInt(process.env.NOTIFICADOR_AWAIT_TTL_MS||'15000',10)+1000) });
          }
        } catch {}
      } else {
        logger.error('[NOTIFICADOR] Erro ao enviar chat', { 
          nomePerfil, 
          chatId: dadosChat.chatId, 
          status: response.status,
          statusText: response.statusText,
          url: urlCompleta,
          response: responseData,
          responseText: responseText.substring(0, 500) // Primeiros 500 chars
        });
        
        // Sempre libera o aguardando em caso de erro
        try {
          const s = getSetAguardando(nomePerfil);
          s.delete(dadosChat.chatId);
          clearAguardTimer(nomePerfil, dadosChat.chatId);
        } catch {}
        
        // Em caso de 404, NÃO reempilha
        if (response && response.status === 404) {
          logger.warn('[NOTIFICADOR] 404 - não reempilhando chat', { nomePerfil, chatId: dadosChat.chatId });
        } else {
          // Para erros 5xx/transitórios, reempilha mas SEM adicionar novamente ao aguardando
          fila.push(dadosChat);
        }
      }
    } catch (e) {
      logger.error('[NOTIFICADOR] Falha ao enviar chat', { nomePerfil, chatId: dadosChat.chatId, error: e && e.message || e });
      
      // Sempre libera o aguardando em caso de falha de rede
      try {
        const s = getSetAguardando(nomePerfil);
        s.delete(dadosChat.chatId);
        clearAguardTimer(nomePerfil, dadosChat.chatId);
      } catch {}
      
      // Não reempilha em erros definitivos de rede
    }
  }));

  if (filaEnviarNotificador.get(nomePerfil).length > 0) {
    setTimeout(() => enviarLoteNotificador(nomePerfil), NOTIFICADOR_ENVIO_LOTE_MS);
  }
}

function iniciarPollingRespostas(nomePerfil) {
  if (!NOTIFICADOR_OUTBOUND) return;
  if (pollingIntervals.has(nomePerfil)) return;
  const id = setInterval(async () => {
    try {
      const response = await fetch(`${NOTIFICADOR_URL}/api/virtus/respostas?servidor=${encodeURIComponent(NOTIFICADOR_SERVIDOR)}&perfil=${encodeURIComponent(nomePerfil)}`);
      const data = await response.json().catch(()=>null);
      if (data && data.ok === true && Array.isArray(data.respostas)) {
        const perfilKeySet = getPendingSet(nomePerfil);
        
        for (const resp of data.respostas) {
          const respostaSan = String(resp.resposta || '').trim();
          
          const key = `${resp.chat_id}||${respostaSan}`;
          
          if (perfilKeySet.has(key)) {
            logger.debug('[NOTIFICADOR] Resposta duplicada ignorada', { nomePerfil, chatId: resp.chat_id, key });
            continue;
          }
          
          if (!filaRespostas.has(nomePerfil)) filaRespostas.set(nomePerfil, []);
          filaRespostas.get(nomePerfil).push(resp);
          
          await queueMessengerSend(nomePerfil, {
            chatId: resp.chat_id, 
            resposta: respostaSan, 
            key,
            fromNotifier: true,
            origin: 'notifier_polling'
          });
          
          perfilKeySet.add(key);
          
          logger.debug('[NOTIFICADOR] Resposta adicionada à fila', { nomePerfil, chatId: resp.chat_id, key });
        }
      }
    } catch (e) {
      logger.error('[NOTIFICADOR] Erro no polling', { nomePerfil, error: e && e.message || e });
    }
  }, NOTIFICADOR_POLLING_MS);
  pollingIntervals.set(nomePerfil, id);
}

function iniciarFilaEnvioMessenger(nomePerfil, enviarRespostaMessengerSeguraFn, marcarRespondidoFn) {
  if (filaEnvioTimers.has(nomePerfil)) return;

  const id = setInterval(async () => {
    const fila = filaEnvioMessenger.get(nomePerfil) || [];
    if (fila.length === 0) return;

    const agora = Date.now();
    const ultima = ultimaRespostaMessenger.get(nomePerfil) || 0;
    const intervaloAleatorio = MESSENGER_INTERVALO_MIN_MS + Math.floor(Math.random() * (MESSENGER_INTERVALO_MAX_MS - MESSENGER_INTERVALO_MIN_MS));
    const tempoDesdeUltima = agora - ultima;
    if (tempoDesdeUltima < intervaloAleatorio) return;

    const proximo = fila.shift();
    if (!proximo) return;

    // Gating por janela de espera (20–60s após a última mensagem do cliente), apenas para replyReady
    try {
      const agoraCheck = Date.now();
      if (proximo.origin === 'replyReady' && typeof proximo.earliestSendAt === 'number' && agoraCheck < proximo.earliestSendAt) {
        const restante = proximo.earliestSendAt - agoraCheck;

        // Reposiciona no fim da fila e aguarda próxima iteração
        fila.push(proximo);

        try {
          stepLog.appendJSONL(nomePerfil, 'virtus', {
            step: 'queue_defer_earliest',
            chatId: proximo.chatId,
            earliestSendAt: proximo.earliestSendAt,
            remainingMs: restante,
            ts: Date.now()
          });
          logger.info('[QUEUE] defer_earliest', { nomePerfil, chatId: proximo.chatId, earliestSendAt: proximo.earliestSendAt, remainingMs: restante });
        } catch {}

        return; // não envia agora; aguardará a próxima passada do loop

      }
    } catch {}

    try {
      const respostaFinal = String(proximo.resposta || '').trim();
      
      // DEDUPE textual: se a última resposta enviada é igual, ACK (se for do notificador) e skip
      const st = await getChatState(nomePerfil, proximo.chatId).catch(() => null);
      const lastIA = (st && st.ultimaRespostaEnviada) ? st.ultimaRespostaEnviada : '';
      if (lastIA && normalizeContent(lastIA) === normalizeContent(respostaFinal)) {
        if (proximo.fromNotifier) {
        try {
          await fetch(`${NOTIFICADOR_URL}/api/virtus/ack`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              servidor: NOTIFICADOR_SERVIDOR,
              perfil: nomePerfil,
              chat_id: proximo.chatId
            })
          });
        } catch {}
        }
        try { stepLog.appendJSONL(nomePerfil, 'virtus', { step: 'notifier_dedupe_skip', chatId: proximo.chatId }); } catch {}
        try { if (proximo.key) getPendingSet(nomePerfil).delete(proximo.key); } catch {}
        return;
      }
      
      // GATE por cursor do cliente (idêntico ao replyReady)
      const cCount = Number(st && st.clientCursorCount || 0);
      const cDigest = st && st.clientCursorDigest || '';
      const rCount = Number(st && st.repliedCursorCount || 0);
      const rDigest = st && st.repliedCursorDigest || '';
      if (cCount && cDigest && rCount === cCount && rDigest && rDigest === cDigest) {
        if (proximo.fromNotifier) {
        try {
          await fetch(`${NOTIFICADOR_URL}/api/virtus/ack`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              servidor: NOTIFICADOR_SERVIDOR,
              perfil: nomePerfil,
              chat_id: proximo.chatId
            })
          });
            logger.info('[NOTIFICADOR] ACK enviado (skip por cursor)', { nomePerfil, chatId: proximo.chatId });
        } catch (e) {
            logger.warn('[NOTIFICADOR] Falha ao ACK (skip por cursor)', { nomePerfil, chatId: proximo.chatId, error: e && e.message || e });
          }
        }
        try { if (proximo.key) getPendingSet(nomePerfil).delete(proximo.key); } catch {}
        return;
      }
      
      let ok = true;
      if (enviarRespostaMessengerSeguraFn) {
        ok = await enviarRespostaMessengerSeguraFn(proximo.chatId, respostaFinal);
      }
      if (!ok) {
        proximo.__tries = (proximo.__tries || 0) + 1;
        if (proximo.__tries <= 2) {
          fila.push(proximo); // requeue preserving earliestSendAt
          logger.warn('[QUEUE] requeue_after_send_fail', { nomePerfil, chatId: proximo.chatId, tries: proximo.__tries });
        } else {
          logger.error('[QUEUE] drop_after_max_retries', { nomePerfil, chatId: proximo.chatId });
        }
        if (proximo.key) getPendingSet(nomePerfil).delete(proximo.key);
        return;
      }

      ultimaRespostaMessenger.set(nomePerfil, Date.now());

      if (marcarRespondidoFn) {
        await marcarRespondidoFn(proximo.chatId);
      } else {
        await marcarRespondido(nomePerfil, proximo.chatId);
      }

      // Atualiza lastIATs e repliedCursor* COM SNAPSHOT DO ITEM
      try {
        await setChatState(nomePerfil, proximo.chatId, {
          lastIATs: Date.now(),
          repliedCursorCount: (typeof proximo.cursorCount === 'number') ? proximo.cursorCount : 0,
          repliedCursorDigest: proximo.cursorDigest || ''
        });
        if (typeof flushChatStateNow === 'function') {
          await flushChatStateNow(nomePerfil);
        }
      } catch (e) {
        logger.warn('[NOTIFICADOR][CURSOR] Falha ao atualizar repliedCursor*: ' + ((e && e.message) || e), { nomePerfil, chatId: proximo.chatId });
      }
      
      try { pedidos.ackReplySent(nomePerfil, proximo.chatId, proximo.cursorSig || ''); } catch {}
      
      // ACK somente se veio do notificador
      if (proximo.fromNotifier) {
      try {
        await fetch(`${NOTIFICADOR_URL}/api/virtus/ack`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            servidor: NOTIFICADOR_SERVIDOR,
            perfil: nomePerfil,
            chat_id: proximo.chatId
          })
        });
        logger.info('[NOTIFICADOR] ACK enviado', { nomePerfil, chatId: proximo.chatId });
      } catch (e) {
        logger.warn('[NOTIFICADOR] Falha ao enviar ACK (será reofertado após TTL do lock)', {
          nomePerfil, chatId: proximo.chatId, error: e && e.message || e
        });
        }
      }
      
      try { const setA = getSetAguardando(nomePerfil); setA.delete(proximo.chatId); } catch {}
      try { clearAguardTimer(nomePerfil, proximo.chatId); } catch {}

      try {
        if (proximo.key) {
          const setPend = getPendingSet(nomePerfil);
          setPend.delete(proximo.key);
        }
      } catch {}

    } catch (e) {
      logger.error('[MESSENGER] Erro ao enviar resposta', { nomePerfil, chatId: proximo.chatId, error: e && e.message || e });
      
      try {
        if (proximo.key) {
          const setPend = getPendingSet(nomePerfil);
          setPend.delete(proximo.key);
        }
      } catch {}
    }
  }, 2000);

  filaEnvioTimers.set(nomePerfil, id);
}

async function marcarRespondido(nomePerfil, chatId) {
  try {
    await setChatState(nomePerfil, chatId, { lastIARespondedAt: Date.now() });
    await flushChatStateNow(nomePerfil);
  } catch (e) {
    logger.error('[VIRTUS] marcarRespondido error', { nomePerfil, chatId, error: e && e.message || e });
  }
}

async function extrairUrlClassificado(page, chatId) {
  try {
    const url = await page.evaluate(() => {
      const fixAbsolute = (h) => (h && h.startsWith('http')) ? h : (h ? ('https://www.facebook.com' + h) : null);
      const as = Array.from(document.querySelectorAll('a[href]'));

      // 1) Preferir a página do item do Marketplace (mais informativa)
      for (const a of as) {
        const href = a.getAttribute('href') || a.href || '';
        if (!href) continue;
        if (href.includes('/marketplace/item/') && !href.includes('/marketplace/t/')) {
          return fixAbsolute(href);
        }
      }

      // 2) Se não houver item, usar o perfil do comprador ("View buyer"/"Ver comprador")
      //    Ex.: https://www.facebook.com/marketplace/profile/...
      //    Procura primeiro por aria-label, depois por qualquer /marketplace/profile/
      const headerProfileAnchor =
        document.querySelector('a[aria-label*="View buyer" i]') ||
        document.querySelector('a[aria-label*="Ver comprador" i]') ||
        null;

      if (headerProfileAnchor) {
        const h = headerProfileAnchor.getAttribute('href') || headerProfileAnchor.href || '';
        if (h && h.includes('/marketplace/profile/') && !h.includes('/marketplace/t/')) {
          return fixAbsolute(h);
        }
      }

      for (const a of as) {
        const href = a.getAttribute('href') || a.href || '';
        if (!href) continue;
        if (href.includes('/marketplace/profile/') && !href.includes('/marketplace/t/')) {
          return fixAbsolute(href);
        }
      }

      // 3) Fallback: qualquer outro /marketplace/ que não seja do chat (/t/)
      for (const a of as) {
        const href = a.getAttribute('href') || a.href || '';
        if (!href) continue;
        if (href.includes('/marketplace/') && !href.includes('/marketplace/t/')) {
          return fixAbsolute(href);
        }
      }

      return null;
    });
    return url || null;
  } catch {
    return null;
  }
}

async function extrairHistoricoConversa(page) {
  try {
    const historico = await page.evaluate(() => {
      function norm(s) {
        try {
          return (s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
        } catch {
          return String(s || '').toLowerCase().trim();
        }
      }

      function parseAbbrToTs(el) {
        try {
          const raw = (el.getAttribute('aria-label') || el.innerText || el.textContent || '').trim();
          const t = norm(raw);
          const now = Date.now();

          if (!t) return 0;
          if (/\bagora\b|just now|now/i.test(raw)) return now;
          
          let m = t.match(/\b(\d+)\s*(s|seg|second|seconds?)\b/);
          if (m) return now - (parseInt(m[1], 10) * 1000);
          
          m = t.match(/\b(\d+)\s*(min|mins?|minute|minuto)\b/);
          if (m) return now - (parseInt(m[1], 10) * 60000);
          
          m = t.match(/\b(\d+)\s*(h|hora|horas|hour|hours?)\b/);
          if (m) return now - (parseInt(m[1], 10) * 3600000);
          
          m = t.match(/\b(\d+)\s*(d|dia|dias|day|days)\b/);
          if (m) return now - (parseInt(m[1], 10) * 86400000);
          
          if (/\bontem\b|yesterday\b/.test(t)) return now - 86400000;
          
          const dp = Date.parse(raw);
          if (Number.isFinite(dp)) return dp;
          
          return 0;
        } catch {
          return 0;
        }
      }

      const rows = Array.from(document.querySelectorAll('div[role="row"],div[role="article"],div[data-testid]')).slice(-200);
      const out = [];

      for (const r of rows) {
        try {
          const rawTxt = (r.innerText || r.textContent || '').trim();
          if (!rawTxt) continue;

          let isMine = false;
          try {
            const st = window.getComputedStyle(r);
            if (st && (st.justifyContent === 'flex-end' || st.textAlign === 'right')) {
              isMine = true;
            }
          } catch {}

          const nraw = norm(rawTxt);
          if (/\b(you\s+sent|voc[eê]\s+enviou)\b/i.test(nraw)) isMine = true;
          if (/^\s*(voc[eê]:|voce:|you:)\b/i.test(rawTxt)) isMine = true; // NOVO: autoria por prefixo

          // Extrai timestamp do abbr
          let ts = 0;
          try {
            const ab = r.querySelector('abbr[aria-label]');
            if (ab) ts = parseAbbrToTs(ab);
            if (!ts) {
              const sps = Array.from(r.querySelectorAll('span')).slice(0, 10);
              for (const s of sps) {
                const ab2 = s.querySelector('abbr[aria-label]');
                if (ab2) {
                  ts = parseAbbrToTs(ab2);
                  if (ts) break;
                }
              }
            }
          } catch {}

          // Remove rótulos "você enviou/you sent" e também "Você:"/"You:"
          const textoLimpo = rawTxt
            .replace(/^(você\s+enviou|you\s+sent)[:\s]*/i, '')
            .replace(/^\s*(voc[eê]:|voce:|you:)\s*/i, '')
            .trim();

          if (!textoLimpo) continue;

          // Filtro bruto de ruído
          try {
            const stopNorm = (textoLimpo || '').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().trim();
            if (/^conveniente(?:\s+contingencia)?$/.test(stopNorm)) continue;
            if (stopNorm === 'inserir') continue;
            if (/^mensagem\s+nao\s+lida/.test(stopNorm)) continue;
            if (/^\d{1,2}:\d{2}$/.test(stopNorm)) continue;  // "03:26"
            if (/^(hoje|ontem)\b/.test(stopNorm)) continue;
            if (/^\s*[·•]\s*$/.test(textoLimpo)) continue;
            if (/^(enviado|enviada|sent|delivered|visto|visualizado|lida|seen)$/.test(stopNorm)) continue;
          } catch {}

          out.push({
            texto: textoLimpo,
            autor: isMine ? 'ia' : 'cliente',
            timestamp: ts || Date.now()
          });
        } catch {}
      }

      out.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
      
      // Monotonicidade de timestamps
      for (let i = 1; i < out.length; i++) {
        const prev = Number(out[i - 1].timestamp || 0);
        const cur  = Number(out[i].timestamp || 0);
        if (cur <= prev) {
          out[i].timestamp = prev + 1;
        }
      }
      
      return out;
    });

    return Array.isArray(historico) ? historico : [];
  } catch {
    return [];
  }
}



function formatarLocalizacaoParaPlanilha(localizacao) {
  if (!localizacao) return null;
  
  if (typeof localizacao === 'string') {
    return localizacao;
  }
  
  if (localizacao && typeof localizacao === 'object') {
    const cidade = (localizacao.cidade || '').trim();
    const estado = (localizacao.estado || '').trim().toUpperCase();
    
    if (cidade && estado) {
      return `${cidade} (${estado})`;
    }
    
    if (cidade) return cidade;
    
    if (estado) return estado;
  }
  
  return null;
}

let mensagensAtendimento = [];

function agoraEpoch() {
  return Math.floor(Date.now() / 1000);
}


const CHAT_STATE_FILE = (perfil) => path.join(__dirname, '../dados/perfis', perfil, 'chats_state.json');

const fileLocks = new Map(); // file -> { pid, timestamp }

async function acquireFileLock(file, timeoutMs = 5000) {
  const lockFile = file + '.lck';
  const start = Date.now();
  while ((Date.now() - start) < timeoutMs) {
    try {
      const fd = fsRaw.openSync(lockFile, 'wx'); // cria se não existe, falha se existe
      const pid = process.pid;
      const timestamp = Date.now();
      fsRaw.writeFileSync(fd, JSON.stringify({ pid, timestamp }), 'utf8');
      fsRaw.fsyncSync(fd);
      fsRaw.closeSync(fd);
      fileLocks.set(file, { pid, timestamp });
      return true;
    } catch (e) {
      try {
        const lockContent = fsRaw.readFileSync(lockFile, 'utf8');
        const lockData = JSON.parse(lockContent);
        if (Date.now() - lockData.timestamp > 30000) {
          try { fsRaw.unlinkSync(lockFile); } catch {}
          continue;
        }
      } catch {}
      await new Promise(r => setTimeout(r, 100)); // espera 100ms antes de tentar novamente
    }
  }
  return false;
}

async function releaseFileLock(file) {
  const lockFile = file + '.lck';
  try {
    if (fileLocks.has(file)) {
      fileLocks.delete(file);
    }
    if (fsRaw.existsSync(lockFile)) {
      fsRaw.unlinkSync(lockFile);
    }
  } catch {}
}

async function readJsonFsyncSafe(file, fb = {}) {
  const lockAcquired = await acquireFileLock(file, 5000);
  if (!lockAcquired) {
    logger.warn(`[LOCK] Timeout ao adquirir lock para ${file}`);
    return fb;
  }
  try {
    const content = await fs.readFile(file, 'utf8');
    return JSON.parse(content);
  } catch {
    return fb;
  } finally {
    await releaseFileLock(file);
  }
}

async function writeJsonFsyncAtomic(file, obj) {
  const lockAcquired = await acquireFileLock(file, 5000);
  if (!lockAcquired) {
    logger.warn(`[LOCK] Timeout ao adquirir lock para escrita em ${file}`);
    return false;
  }
  try {
    await fs.mkdir(path.dirname(file), { recursive: true });
    const tmp = file + '.tmp';
    const fd = fsRaw.openSync(tmp, 'w');
    try {
      fsRaw.writeFileSync(fd, JSON.stringify(obj, null, 2), 'utf8');
      fsRaw.fsyncSync(fd);
    } finally {
      fsRaw.closeSync(fd);
    }
    try {
      if (fsRaw.existsSync(file)) fsRaw.unlinkSync(file);
    } catch {}
    try {
      fsRaw.renameSync(tmp, file);
    } catch {
      try {
        fsRaw.copyFileSync(tmp, file);
        try { fsRaw.unlinkSync(tmp); } catch {}
      } catch {}
    }
    return true;
  } finally {
    await releaseFileLock(file);
  }
}

async function loadChatState(perfil) {
  return await readJsonFsyncSafe(CHAT_STATE_FILE(perfil), {});
}

async function saveChatState(perfil, st) {
  return await writeJsonFsyncAtomic(CHAT_STATE_FILE(perfil), st || {});
}

// [PATCH-3][CORRIGIDO] Flush imediato e seguro do state (mescla pendências do perfil antes de salvar)
async function flushChatStateNow(perfil) {
  try {
    // Coleta pendências deste perfil
    const pendMap = CHAT_STATE_PENDING.get(perfil);
    if (!pendMap || pendMap.size === 0) return true;

    // Snapshot e limpa as pendências deste perfil
    const localPend = Array.from(pendMap.entries()); // [ [chatId, patch], ... ]
    CHAT_STATE_PENDING.delete(perfil);

    // Carrega o state atual do disco
    const stAll = await loadChatState(perfil);

    // Aplica os patches pendentes
    for (const [chatId, patch] of localPend) {
      const cur = stAll[chatId] || {};
      stAll[chatId] = Object.assign({}, cur, patch || {}, { updatedAt: Date.now() });
    }

    // Fsync imediato
    await saveChatState(perfil, stAll);
    return true;

  } catch (e) {
    try { logger.warn('[VIRTUS][flushChatStateNow] erro: ' + ((e && e.message) || e), { perfil }); } catch {}
    return false;
  }
}

async function getChatState(perfil, chatId) {
  const st = await loadChatState(perfil);
  return st[chatId] || null;
}

async function setChatState(perfil, chatId, patch) {
  try {
    if (!CHAT_STATE_PENDING.has(perfil)) CHAT_STATE_PENDING.set(perfil, new Map());
    const m = CHAT_STATE_PENDING.get(perfil);
    const cur = m.get(chatId) || {};
    m.set(chatId, Object.assign(cur, patch || {}));
    scheduleChatStateFlush();
  } catch {}
}

const CHAT_STATES = Object.freeze({
  PENDENTE: 'pendente',
  COLETANDO: 'coletando_localizacao',
  GERANDO: 'gerando_resposta',
  ENVIANDO: 'enviando',
  ENVIADO: 'enviado',
  AGUARDANDO: 'aguardando_cliente',
  FINALIZADO: 'finalizado'
});

const SENT_COOLDOWN_MS = 60 * 1000; // mínimo de 60s



const NOTIFICADOR_URL = process.env.NOTIFICADOR_URL || 'https://c0nv3n13nt3t3cn0l0g14jesus.sa.ngrok.io';
const NOTIFICADOR_SERVIDOR = process.env.SERVIDOR_NOME || 'servidor1';

const NOTIFICADOR_OUTBOUND = String(process.env.NOTIFICADOR_OUTBOUND || '0') === '1'; // 0 = desativado (padrão)
const NOTIFICADOR_HISTORICO = String(process.env.NOTIFICADOR_HISTORICO || '0') === '1'; // 0 = não envia histórico (padrão)

const NOTIFICADOR_ENVIO_LOTE_MS = parseInt(process.env.NOTIFICADOR_ENVIO_LOTE_MS || '10000', 10); // 10s
const NOTIFICADOR_POLLING_MS = parseInt(process.env.NOTIFICADOR_POLLING_MS || '1100', 10);
const MESSENGER_INTERVALO_MIN_MS = parseInt(process.env.MESSENGER_INTERVALO_MIN_MS || '20000', 10); // 20s
const MESSENGER_INTERVALO_MAX_MS = parseInt(process.env.MESSENGER_INTERVALO_MAX_MS || '60000', 10); // 60s

// Janela de espera por conversa (antes de responder o cliente)
const WAIT_BEFORE_REPLY_MIN_MS = parseInt(process.env.WAIT_BEFORE_REPLY_MIN_MS || '20000', 10); // 20s
const WAIT_BEFORE_REPLY_MAX_MS = parseInt(process.env.WAIT_BEFORE_REPLY_MAX_MS || '60000', 10); // 60s

const VIRTUS_FINAL_MSG_MAX_TRIES = parseInt(process.env.VIRTUS_FINAL_MSG_MAX_TRIES || '2', 10); // tentativas no envio da mensagem final
const VIRTUS_FINAL_MSG_RETRY_MIN_MS = parseInt(process.env.VIRTUS_FINAL_MSG_RETRY_MIN_MS || '600', 10); // 600ms
const VIRTUS_FINAL_MSG_RETRY_MAX_MS = parseInt(process.env.VIRTUS_FINAL_MSG_RETRY_MAX_MS || '900', 10); // 900ms

const MAX_CHAT_AGE_MS = parseInt(process.env.VIRTUS_CHAT_MAX_AGE_MS || '28800000', 10); // 8h
const SCAN_INTERVAL_MS = parseInt(process.env.VIRTUS_SCAN_MS || '5000', 10); // 5s
const SCAN_NAV_TIMEOUT_MS = 30000; // 30s para navegar no chat

// Variáveis globais para controle de backoff e falhas
let recoverBackoffMs = 0;
const failCounts = new Map();
function setFailCount(chatId, n) {
  if (!failCounts.has(chatId) && failCounts.size >= 1000) {
    const first = failCounts.keys().next().value;
    if (first !== undefined) failCounts.delete(first);
  }
  failCounts.set(chatId, n);
}
let NAV_CLICK_ONLY = false; // Após boot, bloqueia qualquer navegação/reload na Aba 0 (Messenger)

const filaEnviarNotificador = new Map();  // nomePerfil -> [ { chatId, tipoServico, mensagem, localizacao, urlClassificado } ]
const filaRespostas = new Map();          // nomePerfil -> [ { chat_id, resposta } ]
const filaEnvioMessenger = new Map();     // nomePerfil -> [ { chatId, resposta, key } ]
const ultimaRespostaMessenger = new Map();// nomePerfil -> timestamp
const aguardandoRespostaMap = new Map();  // nomePerfil -> Set(chatId)

// TTL de aguardando notificador (Virtus)
const aguardTimers = new Map(); // nomePerfil -> Map(chatId -> timeoutId)

function markAguardando(nomePerfil, chatId) {
  const set = getSetAguardando(nomePerfil);
  set.add(chatId);
  if (!aguardTimers.has(nomePerfil)) aguardTimers.set(nomePerfil, new Map());
  const map = aguardTimers.get(nomePerfil);
  if (map.has(chatId)) { try { clearTimeout(map.get(chatId)); } catch {} }
  const ttlMs = parseInt(process.env.NOTIFICADOR_AWAIT_TTL_MS || '15000', 10);
  const tid = setTimeout(() => {
    try { set.delete(chatId); } catch {}
    try { map.delete(chatId); } catch {}
    logger.warn('[NOTIFICADOR] TTL expirado; liberando aguardando', { nomePerfil, chatId });
  }, ttlMs);
  map.set(chatId, tid);
}

function clearAguardTimer(nomePerfil, chatId) {
  try {
    const map = aguardTimers.get(nomePerfil);
    if (map && map.has(chatId)) { clearTimeout(map.get(chatId)); map.delete(chatId); }
  } catch {}
}
const pollingIntervals = new Map();       // nomePerfil -> intervalId
const filaEnvioTimers = new Map();        // nomePerfil -> intervalId
const handshakesFeitos = new Set();       // Set(nomePerfil)

async function queueMessengerSend(nomePerfil, { chatId, resposta, key, fromNotifier = false, origin = '', cursorSig = '', cursorCountOverride, cursorDigestOverride, lastClientTsOverride }) {
  try {
    const payload = String(resposta || '').trim();
    if (!payload) return false;

    // Snapshot de estado atual do chat
    const st = await getChatState(nomePerfil, chatId).catch(()=>null);

    const cCount = Number((typeof cursorCountOverride === 'number') ? cursorCountOverride : (st && st.clientCursorCount || 0));
    const cDigest = (typeof cursorDigestOverride === 'string') ? cursorDigestOverride : (st && st.clientCursorDigest || '');

    const sig = String(cursorSig || (cCount && cDigest ? `${cCount}|${cDigest}` : ''));

    if (!filaEnvioMessenger.has(nomePerfil)) filaEnvioMessenger.set(nomePerfil, []);
    const fila = filaEnvioMessenger.get(nomePerfil);

    // Coalescência por chatId: se for replyReady, apague todos os outros replyReady desse chat
    if (origin === 'replyReady') {
      for (let i = fila.length - 1; i >= 0; i--) {
        const it = fila[i];
        if (it && it.chatId === chatId && it.origin === 'replyReady') fila.splice(i, 1);
      }
    }

    // Dedupe por cursorSig (já existente, mantenha)
    const existeMesmoCursor = sig
      ? fila.some(it => it && it.chatId === chatId && it.cursorSig === sig)
      : fila.some(it =>
          it && it.chatId === chatId &&
          Number(it.cursorCount || 0) === cCount &&
          String(it.cursorDigest || '') === cDigest
        );

    if (existeMesmoCursor) {
      try {
        const step = sig ? 'queue_skip_same_cursor_sig' : 'queue_skip_same_cursor';
        stepLog.appendJSONL(nomePerfil, 'virtus', { step, chatId, sig, cCount, cDigest, origin });
      } catch {}
      try { logger.info('[QUEUE] skip_same_cursor', { nomePerfil, chatId, sig, cCount, cDigest, origin }); } catch {}
      return false;
    }

    // earliestSendAt para replyReady, ancorado NO lastClientTsOverride
    let earliestSendAt = undefined;
    if (origin === 'replyReady') {
      const anchor = (typeof lastClientTsOverride === 'number' && lastClientTsOverride > 0)
        ? lastClientTsOverride
        : Date.now();
      const jitter = WAIT_BEFORE_REPLY_MIN_MS + Math.floor(Math.random() * (WAIT_BEFORE_REPLY_MAX_MS - WAIT_BEFORE_REPLY_MIN_MS + 1));
      earliestSendAt = anchor + jitter;

      try {
        stepLog.appendJSONL(nomePerfil, 'virtus', {
          step: 'queue_set_earliest',
          chatId,
          sig,
          anchor,
          jitter,
          earliestSendAt,
          origin,
          ts: Date.now()
        });
        logger.info('[QUEUE] earliest_set', { nomePerfil, chatId, sig, anchor, jitter, earliestSendAt, origin });
      } catch {}
    }

    fila.push({
      chatId,
      resposta: payload,
      key: key || (`q|${chatId}|${sha1(payload)}|${Date.now()}`),
      fromNotifier: !!fromNotifier,
      cursorCount: cCount,
      cursorDigest: cDigest,
      cursorSig: sig || '',
      origin: origin || '',
      earliestSendAt, // pode ser undefined para mensagens que não são replyReady
      lastClientTs: lastClientTsOverride || 0
    });

    try { stepLog.appendJSONL(nomePerfil, 'virtus', { step: 'queue_add', chatId, sig, cCount, cDigest, origin, earliestSendAt, ts: Date.now() }); } catch {}
    try { logger.info('[QUEUE] add', { nomePerfil, chatId, sig, cCount, cDigest, origin, earliestSendAt }); } catch {}
    return true;

  } catch {
    return false;
  }
}

const pendingKeysPorPerfil = new Map(); // nomePerfil -> Set(keys)

function getPendingSet(perfil) {
  if (!pendingKeysPorPerfil.has(perfil)) pendingKeysPorPerfil.set(perfil, new Set());
  return pendingKeysPorPerfil.get(perfil);
}

// Throttle global entre envios por perfil (anti-spam 5–20s entre chats)




async function readJson(file, fb={}) {
  const lockAcquired = await acquireFileLock(file, 5000);
  if (!lockAcquired) {
    logger.warn(`[LOCK] Timeout ao adquirir lock para ${file}`);
    return fb;
  }
  try { return JSON.parse(await fs.readFile(file, 'utf8')); } catch { return fb; }
  finally { await releaseFileLock(file); }
}
async function writeJsonAtomicFsync(file, obj){
  const lockAcquired = await acquireFileLock(file, 5000);
  if (!lockAcquired) {
    logger.warn(`[LOCK] Timeout ao adquirir lock para escrita em ${file}`);
    return false;
  }
  try {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  const fd = await fs.open(tmp, 'w');
  try {
    await fd.writeFile(JSON.stringify(obj, null, 2), 'utf8');
    await fd.sync();
  } finally { await fd.close(); }
  try { await fs.unlink(file); } catch {}
  try { await fs.rename(tmp, file); }
  catch { await fs.copyFile(tmp, file); try { await fs.unlink(tmp);} catch{} }
    return true;
  } finally {
    await releaseFileLock(file);
  }
}
async function wasRecentlySentByMe(page, maxAgeMs=10*60*1000) {
  try {
    return await page.evaluate((maxMs) => {
      const norm = s => (s||'').toLowerCase();
      const bubbles = Array.from(document.querySelectorAll('div[role="row"],div[role="article"],div[data-testid]')).slice(-50);
      const me = bubbles.reverse().find(b => {
        const txt = norm(b.innerText||b.textContent||'');
        if (/(você|voce|you)\s*(enviou|sent)/.test(txt)) return true;
        const style = getComputedStyle(b);
        return style && (style.justifyContent==='flex-end' || style.textAlign==='right');
      });
      if (!me) return false;
      const t = (me.innerText||'').toLowerCase();
      if (/agora|now/.test(t)) return true;
      if (/\b\d+\s*(min|m|minuto)\b/.test(t)) return true;
      if (/\b(\d+)\s*(h|hora)/.test(t)) {
        const m = t.match(/\b(\d+)\s*(h|hora)/);
        if (m && parseInt(m[1],10) <= 2) return true;
      }
      return false;
    }, maxAgeMs);
  } catch { return false; }
}


function extraiIdDoHref(href) {
  try {
    const s = String(href || '');
    const pos = s.indexOf('/marketplace/t/');
    if (pos < 0) return null;
    const rest = s.slice(pos + '/marketplace/t/'.length);
    const id = rest.split(/[/?#]/)[0];
    return id && /^\d+$/.test(id) ? id : null;
  } catch { return null;   }
}

let lastGuaranteeAt = 0;
async function maybeGuaranteeMarketplaceFast(page, nome) {
  const url = (typeof page.url === 'function' ? page.url() : '') || '';

  // Se já estamos no Marketplace, só valida a presença de âncoras/rows
  if (/messenger.com\/marketplace/i.test(url)) {
    const ok = await page.evaluate(() =>
      !!document.querySelector('a[href^="/marketplace/t/"]') || !!document.querySelector('div[role="row"]')
    ).catch(()=>false);
    return !!ok;
  }

  // Após travar o modo CLICK-ONLY, NUNCA navega/reload
  if (NAV_CLICK_ONLY) return true;

  // Antes do lock, permite navegação para "colocar" a aba no Marketplace
  const now = Date.now();
  if ((now - lastGuaranteeAt) < 8000) return true;
  lastGuaranteeAt = now;
  await garantirMarketplace(page, { nome, allowNavigate: true });
  return true;
}

async function coletaChatsMarketplaceTodos(page) {
  try {
    const items = await page.$$eval('a[href], a[role="link"]', els => {
      function _extraiId(href) {
        try {
          const s = String(href || '');
          const pos = s.indexOf('/marketplace/t/');
          if (pos < 0) return null;
          const rest = s.slice(pos + '/marketplace/t/'.length);
          const id = rest.split(/[/?#]/)[0];
          return id && /^\d+$/.test(id) ? id : null;
        } catch { return null; }
      }
      function _extraiTempo(row) {
        if (!row) return '';
        const pickAbbr = () => {
        try {
          const abbr = row.querySelector('abbr[aria-label]');
          if (abbr) {
            const t1 = (abbr.innerText || '').trim();
            if (t1) return t1;
            const t2 = (abbr.getAttribute('aria-label') || '').trim();
            if (t2) return t2;
          }
          } catch {}
          return '';
        };
        const ab = pickAbbr();
        if (ab) return ab;
        try {
          const spans = Array.from(row.querySelectorAll('span'));
          for (const s of spans) {
            const txt = (s.innerText || s.textContent || '').trim();
            if (!txt) continue;
            if (/agora|now|just\snow/i.test(txt)) return txt;
            if (/\d+\s(s|seg|sec|secs?|seconds?|min|m|mins?|minutes?|hora|horas?|h|hours?|dia|dias?|d|seman|sem|weeks?|w)/i.test(txt)) return txt;
          }
        } catch {}
        return '';
      }
      const anchors = els.filter(a => {
        const href = a.getAttribute('href') || a.href || '';
        return !!href && href.includes('/marketplace/t/');
      });
      const arr = anchors.map(a => {
        const href = a.getAttribute('href') || a.href || '';
        const id = _extraiId(href);
        const row = a.closest('div[role="row"]') || a.parentElement;
        const tempo = _extraiTempo(row);
        return { id, tempo, href };
      }).filter(o => o.id);
      const map = new Map();
      for (const it of arr) if (!map.has(it.id)) map.set(it.id, it);
      return Array.from(map.values());
    });
    
    if (process.env.VIRTUS_FEED_DEBUG === '1') {
      try {
        const sample = items.slice(0, 8).map(i => ({ id: i.id, tempo: i.tempo, href: i.href }));
        console.log(`[VIRTUS][FEED_SAMPLE]`, sample);
      } catch {}
    }
    
    return items;
  } catch (err) {
    if (VIRTUS_DETAILED_DEBUG) { logger.debug('[VIRTUS] Erro em coletaChatsMarketplaceTodos', { err: String(err) }); }
    return [];
  }
}

async function garantirMarketplace(page, { timeoutMs = 25000, nome = null, allowNavigate = false } = {}) {
  if (!page || typeof page.url !== 'function') throw new Error('Page inválida');
  
  const urlNow = (typeof page.url === 'function') ? (page.url() || '') : '';
  try {
    const alreadyOk = await Promise.race([
      page.evaluate(() =>
        !!(
          document.querySelector('a[href^="/marketplace/t/"]') ||
          document.querySelector('div[role="row"]') ||
          document.querySelector('div[contenteditable="true"][role="textbox"]')
        )
      ).catch(()=>false),
      new Promise(r => setTimeout(()=>r(false), 800))
    ]);
    if (alreadyOk) return;
  } catch {}

  if (!allowNavigate) {
    try { logger.info('[VIRTUS][garantirMarketplace] safe-mode: skip navigation', nome ? { nome } : {}); } catch {}
    return;
  }
  
  // antes de navegar, respeitar locks/robe ativo
  try {
    const b = getBrowserFromPage(page);
    if (b && ((b._sendLock && b._sendLock.active) || (nome && b._robeActiveFor === nome))) {
      return;
    }
  } catch {}
  
  if (/messenger.com\/marketplace\/t\//i.test(urlNow)) {
    return;
  }
  
  async function gotoInboxRobust(route) {
    try {
      await page.goto(`https://www.messenger.com${route}`, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
      
  try {
    const browserJs = require('./browser.js');
    if (browserJs && typeof browserJs.resolveNonceIfPresent === 'function') {
      await browserJs.resolveNonceIfPresent(page).catch(()=>{});
    }
    if (browserJs && typeof browserJs.clickContinuarComo === 'function') {
      await browserJs.clickContinuarComo(page, { timeout: 12000 }).catch(()=>{});
    }
  } catch {}
      
  const ok = await Promise.race([
    page.waitForFunction(() => {
      const hasAnchor = !!document.querySelector('a[href^="/marketplace/t/"]');
      const hasRow = document.querySelectorAll('div[role="row"]').length > 0;
          return hasAnchor || hasRow;
        }, { timeout: 8000 }),
        page.waitForSelector('a[href^="/marketplace/t/"]', { timeout: 8000 }).catch(() => null),
        page.waitForSelector('div[role="row"]', { timeout: 8000 }).catch(() => null)
      ]);
      
      if (ok) {
        return true;
      } else {
        logger.warn(`[VIRTUS][garantirMarketplace] Rota ${route} não encontrou anchors/rows`, nome ? { nome } : {});
        return false;
      }
    } catch (e) {
      logger.warn(`[VIRTUS][garantirMarketplace] Erro ao tentar rota ${route}: ${e && e.message || e}`, nome ? { nome } : {});
      return false;
    }
  }
  
  let url = '';
  try { url = page.url() || ''; } catch {}
  
  if (/messenger.com\/marketplace/i.test(url)) {
    try {
      const hasAnchor = await page.$('a[href^="/marketplace/t/"]').catch(() => null);
      const hasRow = await page.$('div[role="row"]').catch(() => null);
      if (hasAnchor || hasRow) {
        return;
      }
    } catch {}
  }
  
  const rotas = [
    '/marketplace',
    '/marketplace/inbox'
  ];
  
  for (const rota of rotas) {
    const ok = await gotoInboxRobust(rota);
    if (ok) {
      return; // Sucesso, marketplace pronto
    }
  }
  
  logger.warn('[VIRTUS][garantirMarketplace] Nenhuma rota conseguiu carregar marketplace com anchors/rows', nome ? { nome } : {});
  throw new Error('Marketplace UI não ficou pronta a tempo em nenhuma rota');
}

async function scrollChatsToTop(page, nome) {
  if (isVirtusLocked(nome)) return true; // Não retorna false, apenas não clica
  try {
    const b = getBrowserFromPage(page);
    if (b && b._sendLock && b._sendLock.active) return true; // Não retorna false, apenas não clica
  } catch {}
  if (!page) return false;
  try {
    const res = await page.evaluate(() => {
      let grid = document.querySelector('div[role="grid"]');
      if (!grid) grid = document.querySelector('div.x78zum5.xdt5ytf[data-virtualized="false"]');
      if (!grid) grid = document.querySelector('div[role="rowgroup"]');
      if (!grid) grid = document.querySelector('div.x78zum5.xdt5ytf');
      if (!grid) grid = Array.from(document.querySelectorAll('div'))
        .find(d => d.scrollHeight > 400 && d.scrollHeight > d.clientHeight + 30);
      if (!grid) grid = document.body;
      if (!grid) return false;

      grid.scrollTop = 0;
      let node = grid.parentElement;
      for (let i = 0; i < 4 && node; i++) {
        if (node.scrollHeight > node.clientHeight + 30) node.scrollTop = 0;
        node = node.parentElement;
      }

      try {
        let firstA = grid.querySelector('a[role="link"], a[href^="/marketplace/t/"]');
        if (firstA) {
          firstA.focus && firstA.focus();
          firstA.scrollIntoView({block: "start", behavior: "smooth"});
        }
      } catch {}

      setTimeout(() => { if (grid.scrollTop > 0) grid.scrollTop = 0; }, 250);

      return grid.scrollTop === 0;
    });
    return !!res;
  } catch (err) {
    return false;
  }
}

async function openChatByClick(p, chatId, { timeoutMs = 8000, retries = 2 } = {}) {
  try {
    const sel = `a[href^="/marketplace/t/${chatId}"]`;
    try { await scrollChatsToTop(p, null); } catch {}
    for (let attempt = 0; attempt <= retries; attempt++) {
      let clicked = false;
      try {
        clicked = await p.evaluate((anchorSel) => {
          const a = document.querySelector(anchorSel);
          if (!a) return false;
          try { a.scrollIntoView({ block: 'center', behavior: 'instant' }); } catch {}
          a.click();
          return true;
        }, sel).catch(() => false);
      } catch {}

      if (!clicked) {
        try {
          const h = await p.$(sel).catch(()=>null);
          if (h) {
            await h.click({ delay: 20 });
            clicked = true;
          }
        } catch {}
      }

      if (clicked) {
        const ok = await assertOnChat(p, chatId, { timeoutMs }).catch(()=>false);
        if (ok) return true;
      }

      await sleep(250 + Math.floor(Math.random() * 200));
      try { await scrollChatsToTop(p, null); } catch {}
    }
  } catch {}
  return false;
}

function normalize(s) {
  try {
    return String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().toLowerCase();
  } catch {
    return String(s || '').trim().toLowerCase();
  }
}

async function getMySentSnapshot(p) {
  try {
    return await p.evaluate(() => {
      const norm = s => (s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
      const rows = Array.from(document.querySelectorAll('div[role="row"],div[role="article"],div[data-testid]'));
      let total = 0, lastText = '', lastWhen = '', lastIdx = -1;
      
      for (let i = 0; i < rows.length; i++) {
        const el = rows[i];
        const txt = (el.innerText || el.textContent || '').trim();
        const tnorm = norm(txt);
        const isMine = /\b(you\s+sent|voc[eê]\s+enviou)\b/.test(tnorm);
        
        if (isMine) {
          total++;
          lastText = txt;
          lastIdx = i;
        }
      }
      
      if (lastIdx >= 0) {
        const lastEl = rows[lastIdx];
        let when = '';
        try {
          const abbr = lastEl.querySelector('abbr[aria-label]');
          if (abbr) when = (abbr.getAttribute('aria-label') || abbr.innerText || abbr.textContent || '').trim();
        } catch {}
        
        if (!when) {
          const spans = lastEl ? Array.from(lastEl.querySelectorAll('span')) : [];
          for (const s of spans) {
            const t = (s.innerText || s.textContent || '').trim();
            if (/\b(agora|now|\d+\s*(s|seg|secs?|seconds?|min|mins?|minutes?))\b/i.test(t)) {
              when = t;
              break;
            }
          }
        }
        lastWhen = when;
      }
      
      return { total, lastText, lastWhen };
    });
  } catch {
    return { total: 0, lastText: '', lastWhen: '' };
  }
}

async function sendMessageSafe(p, campo, msg, nome, chatId) {
  try {
    // DEDUPE: verifica se a mensagem é semelhante à última enviada
    const stSend = await getChatState(nome, chatId).catch(()=>null);
    const lastSent = stSend && (stSend.ultimaRespostaEnviada || stSend.ultimaRespostaEnviadaNorm) || '';
    if (nearEqual(msg, lastSent)) {
      return; // Não envia mensagem duplicada
    }

    if (!campo || (await campo.evaluate(el => !el.isConnected).catch(()=>true))) {
      const sels = [
        'div[contenteditable="true"][role="textbox"]',
        'div[contenteditable="true"][aria-label]',
        'div[contenteditable="true"]',
        'div[role="combobox"][contenteditable="true"]',
        'div[aria-label="Mensagem"]',
        'div[aria-label*="mensagem"]'
      ];
      for (const sel of sels) {
        const h = await p.$(sel).catch(()=>null);
        if (h) {
          const ok = await h.evaluate(el => {
            const st = window.getComputedStyle(el);
            return el.isConnected && st && st.visibility !== 'hidden' && st.display !== 'none' && el.offsetParent !== null;
          }).catch(()=>false);
          if (ok) { campo = h; break; }
        }
      }
    }
  } catch {}
  if (!campo) {
    await logIssue(nome, 'mil_action', `virtus_no_composer chat=${chatId}`);
    return;
  }

  try {
    const urlNow = (typeof p.url === 'function') ? (p.url() || '') : '';
    if (!chatUrlMatches(urlNow, chatId)) {
      await logIssue(nome, 'mil_action', `virtus_context_abort: url_mismatch_before_type chat=${chatId} url="${urlNow}"`);
      return; // aborta o envio neste chat
    }
  } catch {}

  if (!(await assertOnChat(p, chatId, { timeoutMs: 0 }))) {
    await logIssue(nome, 'mil_action', `virtus_context_abort: before_type (chat ${chatId})`);
    return;
  }

  const ctrlKey = (process.platform === 'darwin') ? 'Meta' : 'Control';

  setVirtusInputLock(nome, true);
  try {
    await campo.click({ delay: 20 }).catch(()=>{});
    try {
      await p.keyboard.down(ctrlKey);
      await p.keyboard.press('KeyA');
      await p.keyboard.up(ctrlKey);
    } catch {}
    try { await p.keyboard.press('Backspace'); } catch {}
    try { await p.keyboard.press('Delete'); } catch {}
    await p.waitForFunction(
      el => ((el.innerText || el.textContent || '').trim().length === 0),
      { timeout: 1200 },
      campo
    ).catch(()=>{});

    const toSend = String(msg || '').replace(/\r?\n+/g, ' ');
    const safeMsg = sanitizeOutgoing(removeTelefonesCompletosLoose(toSend));
    const jitter = () => 8 + Math.floor(Math.random() * 7); // 8–14ms por caractere
    try {
      await campo.type(safeMsg, { delay: jitter() });
    } catch {
      await p.keyboard.type(safeMsg, { delay: jitter() }); // fallback
    }

    try {
      const urlNow2 = (typeof p.url === 'function') ? (p.url() || '') : '';
      if (!chatUrlMatches(urlNow2, chatId)) {
        await clearComposerIfAny(p, campo);
        await logIssue(nome, 'mil_action', `virtus_context_abort: url_mismatch_before_enter chat=${chatId} url="${urlNow2}"`);
        return; // aborta o envio neste chat
      }
    } catch {}

    if (!(await assertOnChat(p, chatId, { timeoutMs: 0 }))) {
      await clearComposerIfAny(p, campo);
      await logIssue(nome, 'mil_action', `virtus_context_abort: before_enter (chat ${chatId})`);
      return;
    }

    const expected = safeMsg.trim();
    const before = await getMySentSnapshot(p);

    await p.keyboard.press('Enter');

    function normalizeMsg(s) {
      try {
        return String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
      } catch {
        return String(s || '').trim().toLowerCase();
      }
    }

    const expectedNorm = normalizeMsg(expected);
    const sent = await p.waitForFunction(
      (beforeCount, expectedNorm) => {
        function getSnap() {
          const rows = Array.from(document.querySelectorAll('div[role="row"],div[role="article"],div[data-testid]'));
          let total = 0, lastText = '';

          for (let i = 0; i < rows.length; i++) {
            const el = rows[i];
            const txt = (el.innerText || el.textContent || '').trim();
            if (!txt) continue;

            let isMine = false;
            try {
              const st = window.getComputedStyle(el);
              if (st && (st.justifyContent === 'flex-end' || st.textAlign === 'right')) isMine = true;
            } catch {}

            const n = String(txt).toLowerCase();
            if (/\b(you\s+sent|voc[eê]\s+enviou)\b/i.test(n)) isMine = true;

            if (isMine) {
              total++;
              lastText = txt;
            }
          }

          return { total, lastText };
        }

        const snap = getSnap();
        if (snap.total <= beforeCount) return false;

        const lastNorm = String(snap.lastText || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\s+/g, ' ').trim().toLowerCase();

        return lastNorm.includes(expectedNorm);
      },
      { timeout: 12000 },
      before.total,
      expectedNorm
    ).catch(() => false);

    let mensagemEnviada = sent;
    if (!sent) {
      // Retry único com re-tipo (colar texto de novo) e Enter
      try {
        await clearComposerIfAny(p, campo);
        await p.waitForTimeout(300);
        const retryText = String(safeMsg);
        await campo.type(retryText, { delay: jitter() });
        await p.keyboard.press('Enter');
        const sentRetry = await p.waitForFunction((beforeCount, expectedNorm) => {
          function getSnap() {
            const rows = Array.from(document.querySelectorAll('div[role="row"],div[role="article"],div[data-testid]'));
            let total = 0, lastText = '';

            for (let i = 0; i < rows.length; i++) {
              const el = rows[i];
              const txt = (el.innerText || el.textContent || '').trim();
              if (!txt) continue;

              let isMine = false;
              try {
                const st = window.getComputedStyle(el);
                if (st && (st.justifyContent === 'flex-end' || st.textAlign === 'right')) isMine = true;
              } catch {}

              const n = String(txt).toLowerCase();
              if (/\b(you\s+sent|voc[eê]\s+enviou)\b/i.test(n)) isMine = true;

              if (isMine) {
                total++;
                lastText = txt;
              }
            }

            return { total, lastText };
          }

          const snap = getSnap();
          if (snap.total <= beforeCount) return false;

          const lastNorm = String(snap.lastText || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\s+/g, ' ').trim().toLowerCase();

          return lastNorm.includes(expectedNorm);
        }, { timeout: 12000 }, before.total, expectedNorm).catch(() => false);
        
        if (!sentRetry) {
          await logIssue(nome, 'virtus_send_failed', 'send_confirmation_failed_and_retry_failed');
          return; // ABORTA — NÃO loga "enviado"
        }
        mensagemEnviada = true;
      } catch {
        await logIssue(nome, 'virtus_send_failed', 'send_confirmation_retry_exception');
        return; // ABORTA
      }
    }
    
    if (mensagemEnviada) {
      // Armazena ultimaRespostaEnviada e ultimaRespostaEnviadaNorm após envio
      try {
        await setChatState(nome, chatId, {
          state: CHAT_STATES.AGUARDANDO,
          lastIATs: Date.now(),
          ultimaRespostaEnviada: safeMsg,
          ultimaRespostaEnviadaNorm: normalizeContent(safeMsg)
        });
      } catch {}

      // NOVO: registra imediatamente a linha 'ia' no JSONL para blindar o histórico em disco
      try {
        await appendIaLine(nome, chatId, safeMsg);
      } catch {}

    }

  } finally {
    setVirtusInputLock(nome, false);
  }
}

async function startVirtus(browser, nome, robeMeta = {}) {
  let requiredEpoch = 0;
  if (arguments.length >= 3 && arguments[2] && arguments[2].epoch != null) {
    requiredEpoch = arguments[2].epoch;
  }
  function epochOk() {
    try {
      if (browser && browser._fenceEpochMap && typeof browser._fenceEpochMap[nome] !== "undefined") {
        return browser._fenceEpochMap[nome] === requiredEpoch;
      }
      return true;
    } catch { return false; }
  }

  const attId = stepLog.attemptId();
  stepLog.appendJSONL(nome, 'virtus', { attempt: attId, step: 'start' });

  let manifestFrozenUntil = 0;
  try {
    const manifest = await manifestStore.read(nome);
    manifestFrozenUntil = typeof manifest?.frozenUntil === 'number' ? manifest.frozenUntil : 0;
  } catch {}
  if (manifestFrozenUntil && manifestFrozenUntil > Date.now()) {
    const log = (...args) => logger.info(args.join(' '), { nome });
    log(`[VIRTUS][${nome}] virtus_skip_frozen — perfil congelado até ${new Date(manifestFrozenUntil).toISOString()}`);
    if (issues) try { await logIssue(nome, 'virtus_skip_frozen', `perfil congelado até ${new Date(manifestFrozenUntil).toISOString()}`); } catch {}
    return { stop: async () => {} }; // Virtus runner no-op
  }

  const log = (...args) => logger.info(args.join(' '), { nome });

  let running = true;
  let page = null;

  let ensurePagePromise = null;
  let lastDeadLogAt = 0;

  async function ensurePage() {
    if (!running || !epochOk()) return null;
    if (ensurePagePromise) {
      try { return await ensurePagePromise; } catch { return null; }
    }
    ensurePagePromise = (async () => {
      if (!running || !epochOk()) return null;
      if (!browser || (browser.isConnected && browser.isConnected() === false)) {
        const now = Date.now();
        if (!virtusDeadLogTimes[nome] || now - virtusDeadLogTimes[nome] > 60000) {
          virtusDeadLogTimes[nome] = now;
          logger.warn('Browser morto, não é possível garantir page', { nome });
          if (issues) try { await logIssue(nome, 'virtus_page_dead', 'browser morto/disconnected'); } catch {}
        }
        return null;
      }
      try {
        let pages = await browser.pages();
        if (pages && pages[0]) {
          page = pages[0];
          if (page && typeof page.isClosed === 'function' && page.isClosed()) {
            page = null;
          }
        }
        try {
          if (browser._buscasLocalizacaoAtivas && browser._buscasLocalizacaoAtivas.size > 0) {
            return page;
          }
        } catch {}

        try {
          if (browser && browser._robeActiveFor === nome) {
          } else {
            const allPages = await browser.pages();
            if (Array.isArray(allPages) && allPages.length > 1) {
              const MAX_BUSCA_LOCALIZACAO_AGE_MS = 60000;
              const now = Date.now();
              for (let i = allPages.length - 1; i >= 1; i--) {
                const p = allPages[i];
                try {
                  if (p._buscaLocalizacao === true) {
                    const age = now - (p._buscaLocalizacaoSince || 0);
                    if (age < MAX_BUSCA_LOCALIZACAO_AGE_MS) {
                      continue; // protegido
                    }
                    try { delete p._buscaLocalizacao; } catch {}
                    try { delete p._buscaLocalizacaoSince; } catch {}
                    try { delete p._buscaLocalizacaoChatId; } catch {}
                  }
                } catch {}
                let u = '';
                try { u = await p.url(); } catch {}
                if (/facebook.com\/marketplace\/create\/item/i.test(u)) continue; // NUNCA fechar create item
                try { await p.close({ runBeforeUnload:false }).catch(()=>{}); } catch {}
              }
            }
          }
        } catch {}
        if (!page) {
          if (!running || !epochOk()) return null;
          const newP = await browser.newPage();
          try {
            const manifest = await manifestStore.read(nome);
            const coords = utils.getCoords((manifest && manifest.cidade) ? manifest.cidade : '');
            if (!running || !epochOk()) return null;
            await patchPage(nome, newP, coords);
            if (!running || !epochOk()) return null;
            await ensureMinimizedWindowForPage(newP);
          } catch (e) {
            logger.warn('ensurePage: falha patchPage/minimize na nova aba', { nome }, e);
          }
          try { newP.once && newP.once('close', () => { if (page === newP) page = null; }); } catch {}
          page = newP;
        }
        if (!running || !epochOk()) return null;
        if (!browser || (browser.isConnected && browser.isConnected() === false)) return null;
        if (page && typeof page.isClosed === 'function' && page.isClosed()) return null;

        try { page.removeAllListeners('dialog'); } catch {}
        try {
          page.on('dialog', async (dlg) => {
            try {
              const t = dlg.type && dlg.type();
              const m = (dlg.message && dlg.message()) || '';
              if (t === 'beforeunload' || /recarregar|atualizar|leave this page|continuar/i.test(m)) {
                await dlg.accept().catch(()=>{});
                stepLog.appendJSONL(nome, 'virtus', { attempt: attId, step: 'beforeunload_accept' });
              } else {
                await dlg.dismiss().catch(()=>{});
              }
            } catch {}
          });
        } catch {}

        return page;
      } catch (e) {
        logger.error('ensurePage falhou', { nome }, e);
        return null;
      }
    })();
    try { return await ensurePagePromise; }
    finally { ensurePagePromise = null; }
  }

  function bumpRecoverBackoff() {
    recoverBackoffMs = Math.min(32000, (recoverBackoffMs || 1000) * 2); // Backoff exponencial até 32s
  }
  function resetRecoverBackoff() {
    recoverBackoffMs = 0;
  }

  const COMPOSER_SELECTORS = [
    'div[contenteditable="true"][role="textbox"]',
    'div[contenteditable="true"][aria-label]',
    'div[contenteditable="true"]',
    'div[role="combobox"][contenteditable="true"]',
    'div[aria-label="Mensagem"]',
    'div[aria-label*="mensagem"]'
  ];

  const CHAT_BLOCKED_PATTERNS = [
    /vo[cç]e\s+n[aã]o\s+pode\s+enviar\s+mensagens/i,
    /mensagem\s+indispon[íi]vel/i,
    /vo[cç]e\s+n[aã]o\s+est[aá]\s+mais\s+neste\s+grupo/i,
    /vo[cç]e\s+saiu\s+do\s+grupo/i,
    /you\s+can[’']?t\s+send\s+messages/i,
    /message\s+unavailable/i
  ];
  const CHAT_BLOCKED_ALERT_SELECTOR = 'div[role="alert"]';

  async function isChatBlocked(p) {
    try {
      const alertExists = await p.$(CHAT_BLOCKED_ALERT_SELECTOR);
      if (alertExists) {
        const txt = await p.evaluate(el => (el.innerText || el.textContent || '').trim(), alertExists);
        if (txt && CHAT_BLOCKED_PATTERNS.some(rx => rx.test(txt))) return true;
      }
      const txts = await p.$$eval('div, span, h1, h2', els =>
        els.slice(0, 200).map(el => (el.innerText || el.textContent || '').trim()).filter(Boolean)
      );
      for (const t of txts) {
        if (CHAT_BLOCKED_PATTERNS.some(rx => rx.test(t))) return true;
      }
    } catch {}
    return false;
  }

  async function waitForComposer(p, timeoutMs = 10000) {
    const start = Date.now();
    while ((Date.now() - start) < timeoutMs) {
      for (const sel of COMPOSER_SELECTORS) {
        try {
          const h = await p.$(sel);
          if (h) {
            const ok = await p.evaluate(el => {
              const st = window.getComputedStyle(el);
              const vis = st && st.visibility !== 'hidden' && st.display !== 'none' && el.offsetParent !== null;
              const disabled = el.hasAttribute('disabled') || el.getAttribute('aria-disabled') === 'true';
              return vis && !disabled;
            }, h);
            if (ok) return h;
          }
        } catch {}
      }
      await sleep(250);
    }
    return null;
  }

  async function refocusComposerNoReload(p, chatId, anchorSel) {
    try {
      logger.info('[COMPOSER] Refocus (sem navegação)', { chatId });
      try { await p.evaluate(() => { try { window.scrollBy(0, 120); } catch {} }); } catch {}

      const campo = await waitForComposer(p, 5000);
      if (campo) return campo;

      try {
        await p.evaluate(() => { try { document.body && document.body.focus && document.body.focus(); } catch {} });
        await p.keyboard.press('Tab').catch(()=>{});
      } catch {}

      const campo2 = await waitForComposer(p, 3000);
      if (campo2) return campo2;
    } catch (e) {
      logger.warn('[COMPOSER] Refocus falhou (sem navegação)', { chatId, error: e && e.message || e });
    }
    return null;
  }

  function incFail(chatId) {
    const n = (failCounts.get(chatId) || 0) + 1;
    setFailCount(chatId, n);
    return n;
  }
  function resetFail(chatId) {
    failCounts.delete(chatId);
  }

  async function coletaChatsMarketplaceRecentes() {
    try {
      if (!running || !epochOk()) return [];
      const p = await ensurePage();
      if (!p) {
        logger.warn(`[VIRTUS][${nome}] ensurePage retornou null em coletaChatsMarketplaceRecentes()`);
        return [];
      }

      const chatsRespondidosParaVerificar = [];
      try {
        const todosEstados = await loadChatState(nome).catch(() => ({}));
        for (const [chatId, st] of Object.entries(todosEstados || {})) {
          if (st && (st.state === CHAT_STATES.AGUARDANDO || st.state === CHAT_STATES.ENVIADO || st.state === CHAT_STATES.PENDENTE)) {
            chatsRespondidosParaVerificar.push({ id: chatId, tempo: 'agora', jaRespondido: true });
          }
        }
      } catch {}

      try {
        await maybeGuaranteeMarketplaceFast(p, nome);
    } catch (err) {
        logger.warn(`[VIRTUS][${nome}] maybeGuaranteeMarketplaceFast falhou: ${(err && err.message) || err}`);
        await sleep(2000);
        return chatsRespondidosParaVerificar;
      }

      try {
        await Promise.race([
          p.waitForSelector('a[href^="/marketplace/t/"]', { timeout: 5000 }),
          p.waitForSelector('div[role="row"] span', { timeout: 5000 })
        ]);
      } catch {
      }

      const todos = await coletaChatsMarketplaceTodos(p);

      const idsColetados = new Set(todos.map(c => c.id));
      for (const chatRespondido of chatsRespondidosParaVerificar) {
        if (!idsColetados.has(chatRespondido.id)) {
          todos.push(chatRespondido);
        }
      }

      return todos;
    } catch (err) {
      logger.error(`[VIRTUS][${nome}] Erro em coletaChatsMarketplaceRecentes(): ${(err && err.message) || err}`, {}, err);
      return [];
    }
  }

  async function scanAndProcessChats(nome) {
    try {
      const p = await ensurePage().catch(()=>null);
      if (!p) return;

      try { await maybeGuaranteeMarketplaceFast(p, nome); } catch {}

      const lista = await coletaChatsMarketplaceTodos(p);
      if (!Array.isArray(lista) || !lista.length) return;

      for (const it of lista) {
        const chatId = String(it.id || '').trim();
        if (!chatId) continue;

        try {
          const stPrev = await getChatState(nome, chatId).catch(()=>null);
          if (stPrev && stPrev.state === CHAT_STATES.FINALIZADO) {
            await setChatState(nome, chatId, { lastScanAt: Date.now() });
            continue;
          }
          if (!stPrev || !stPrev.discoveredAt) {
            await setChatState(nome, chatId, { discoveredAt: Date.now() });
          }

          const urlNow = (typeof p.url === 'function') ? (p.url() || '') : '';
          if (!chatUrlMatches(urlNow, chatId)) {
            await openChatByClick(p, chatId, { timeoutMs: 8000, retries: 2 });
          }

          // Coleta a URL do classificado com o chat aberto (sem navegar)
          let classificadoUrl = null;
          try { classificadoUrl = await extrairUrlClassificado(p, chatId); } catch {}

          const historicoConversa = await extrairHistoricoConversa(p);

          // Constroi histórico sanitizado com base na última IA enviada
          const ultimaIaNorm = stPrev && stPrev.ultimaRespostaEnviadaNorm ? String(stPrev.ultimaRespostaEnviadaNorm) : '';
          const historicoSan = sanitizeHistoricoRecords(historicoConversa, ultimaIaNorm);

          if (!Array.isArray(historicoSan) || !historicoSan.length) {
            await setChatState(nome, chatId, { lastScanAt: Date.now() });
            continue;
          }

          // Persistência imediata do histórico sanitizado
          await appendChatHistoryLog(nome, chatId, historicoSan);

          // Filtra somente mensagens do cliente (sanitizadas)
          const clientMsgs = historicoSan.filter(m => m && m.autor === 'cliente' && String(m.texto || '').trim());

          // Janela de 8 horas
          const lastClientTs = clientMsgs.length ? Number(clientMsgs[clientMsgs.length - 1].timestamp || 0) : 0;
          if (!lastClientTs || (Date.now() - lastClientTs) > MAX_CHAT_AGE_MS) {
            await setChatState(nome, chatId, {
              lastScanAt: Date.now(),
              lastCLIts: lastClientTs || 0
            });
            continue;
          }

          // Prefetch de localização (não bloqueia)
          try {
            const stLoc = await getChatState(nome, chatId).catch(()=>null);
            if (!(stLoc && stLoc.cidade && stLoc.estado)) {
              await ensureLocationPrefetch(chatId, classificadoUrl || null);
            }
    } catch {}

          // Cursor determinístico do cliente: count + digest (últimas 10 mensagens normalizadas)
          const clientCount = clientMsgs.length;
          const clientDigest = clientCount
            ? sha1(clientMsgs.slice(-10).map(m => normalizeContent(m.texto || '')).join('|'))
            : '';
          const clientLastNorm = clientCount ? normalizeContent(clientMsgs[clientCount - 1].texto || '') : '';

          const prevCount = Number(stPrev && stPrev.clientCursorCount || 0);
          const prevDigest = stPrev && stPrev.clientCursorDigest || '';

          const changed =
            (clientCount > prevCount) ||
            (clientCount > 0 && clientCount === prevCount && clientDigest && prevDigest && clientDigest !== prevDigest);

          try {
            logger.info('[SCAN] cursor_eval', { nome, chatId, prevCount, prevDigest, clientCount, clientDigest, changed });
            stepLog.appendJSONL(nome, 'virtus_scan', { phase: 'cursor_eval', chatId, prevCount, prevDigest, clientCount, clientDigest, changed, ts: Date.now() });
      } catch {}
      
          if (!changed) {
            await setChatState(nome, chatId, {
              state: CHAT_STATES.AGUARDANDO,
              lastScanAt: Date.now(),
              clientCursorCount: clientCount,
              clientCursorDigest: clientDigest,
              clientLastNorm: clientLastNorm,
              lastCLIts: lastClientTs
            });
            continue;
          }

          // Delta de novas mensagens
          let novasMsgs = [];
          if (clientCount > prevCount) {
            novasMsgs = clientMsgs.slice(prevCount);
          } else {
            novasMsgs = [ clientMsgs[clientMsgs.length - 1] ].filter(Boolean);
          }

          // Gate reforçado: semântica + diferença real do último texto do cliente
          const lastClientNormPrev = (stPrev && stPrev.clientLastNorm) || '';
          const preFiltradas = (novasMsgs || []).filter(semanticallyRelevant);
          const novasFiltradas = preFiltradas.filter(m => {
            const t = normalizeContent(String(m && m.texto || ''));
            if (!t) return false;
            // Se é praticamente igual ao último texto conhecido do cliente, ignore
            if (lastClientNormPrev && (nearEqual(t, lastClientNormPrev) || t.includes(lastClientNormPrev) || lastClientNormPrev.includes(t))) {
              try { stepLog.appendJSONL(nome, 'virtus', { step: 'semantic_gate_skip', chatId, reason: 'near_equal_last', lastClientNormPrev }); } catch {}
              return false;
            }
            return true;
          });

          if (!novasFiltradas.length) {
            try {
              stepLog.appendJSONL(nome, 'virtus', { step: 'semantic_gate_skip', chatId, reason: 'no_semantic_delta', cCount: clientCount, cDigest: clientDigest });
            } catch {}
            await setChatState(nome, chatId, {
              state: CHAT_STATES.AGUARDANDO,
              lastScanAt: Date.now(),
              clientCursorCount: clientCount,
              clientCursorDigest: clientDigest,
              clientLastNorm: clientLastNorm,
              lastCLIts: lastClientTs
            });
            continue;
          }

          // Contexto de cidade
          let cidadeCtx = null;
          try {
            const man = await manifestStore.read(nome).catch(()=>null);
            cidadeCtx = (man && man.cidade) ? man.cidade : null;
          } catch {}
          if (!cidadeCtx) {
            const stLoc2 = await getChatState(nome, chatId).catch(()=>null);
            if (stLoc2 && stLoc2.cidade) cidadeCtx = stLoc2.cidade;
          }

          // Envia historicoSan (não bruto) para o orquestrador
          try {
            logger.info('[SCAN] ingest_call', { nome, chatId, cCount: clientCount, cDigest: clientDigest });
            stepLog.appendJSONL(nome, 'virtus_scan', { phase: 'ingest_call', chatId, cCount: clientCount, cDigest: clientDigest, ts: Date.now() });
            } catch {}

          await pedidos.ingestFromVirtus(nome, chatId, {
            historico: historicoSan,
            contexto: { cidade: cidadeCtx || null },
            novasMsgs: novasFiltradas,
            cursor: { count: clientCount, digest: clientDigest }
          });

          // Atualiza cursor do cliente APÓS ingest
            await setChatState(nome, chatId, {
              state: CHAT_STATES.AGUARDANDO,
            lastScanAt: Date.now(),
            clientCursorCount: clientCount,
            clientCursorDigest: clientDigest,
            clientLastNorm: clientLastNorm,
            lastCLIts: lastClientTs
          });

        } catch (e) {
          logger.warn('[SCAN] Falha ao processar chat', { nome, chatId, error: (e && e.message) || String(e) });
        }
      }
            } catch (e) {
      logger.warn('[SCAN] erro geral', { nome, error: (e && e.message) || String(e) });
    }
  }

  // Funções antigas de fila/debounce/gating removidas - agora usa scanAndProcessChats

  const timersFechamento = new Map(); // chatId -> { inicio, telefone, expirado, expiraEm, timerId }
  const dadosColetados = new Map();   // chatId -> { cidade, telefone, ajudante, endereco_saida, endereco_destino, itens }
  const pedidosEnviados = new Set();  // chatId já enviados

  // Função antiga scheduleNextIfIdle removida - substituída por scanAndProcessChats
  // Função antiga responderChat removida - substituída por scanAndProcessChats + pedidos.ingestFromVirtus
  // Função antiga maybeEnqueueDueChats removida - não é mais necessária
  // Função antiga filaManagerLoop removida - substituída por scanAndProcessChats

  async function inferEnderecosFromText(perfil, chatId, lastText, lastIaText) {
    if (!lastText) return;
    const st = await getChatState(perfil, chatId).catch(()=>null);
    const dc = (st && st.dadosColetados) ? st.dadosColetados : {};

    const asked = detectAskedFieldFromText(lastIaText || '');
    const cand = String(lastText || '').trim();

    if (!cand) return;

    // Aceite endereço informal (qualquer frase com pelo menos 4 chars, sem exigir padrão rua/av.)
    if (cand.length >= 4) {
      const patch = {};

      if (!dc.endereco_saida && (asked === 'endereco_saida' || (!dc.endereco_saida && asked === 'itens'))) {
        patch.endereco_saida = cand;
      } else if (!dc.endereco_destino && (asked === 'endereco_destino' || (!dc.endereco_destino && asked === 'endereco_saida'))) {
        patch.endereco_destino = cand;
      }

      if (Object.keys(patch).length) {
        await atualizarDadosColetados(chatId, { dados: patch });
        await pedidos.upsertFromIA(perfil, chatId, patch);
        try { await issues.append(perfil, 'mil_action', `infer_enderecos (informal) saida="${patch.endereco_saida||''}" destino="${patch.endereco_destino||''}"`); } catch {}
      }
    }
  }

  async function atualizarDadosColetados(chatId, { cidade = null, telefone = null, dados = {} } = {}) {
    if (!dadosColetados) return;
    if (!dadosColetados.has(chatId)) dadosColetados.set(chatId, {});
    const cur = dadosColetados.get(chatId);
    if (cidade && !cur.cidade) cur.cidade = cidade;
    if (telefone) {
      const dig = String(telefone || '').replace(/\D/g,'');
      if (dig.length >= 10 && dig.length <= 11) {
        cur.telefone = dig;
        delete cur.telefone_parcial;
      } else if (dig.length >= 8 && dig.length <= 9 && !cur.telefone) {
        cur.telefone_parcial = dig;
      }
    }
    const keys = ['ajudante','endereco_saida','endereco_destino','itens','data_hora','telefone_parcial'];
    for (const k of keys) {
      if (dados && dados[k] != null) {
        if (k === 'telefone_parcial') {
          const tp = String(dados[k]||'').replace(/\D/g,'');
          if (!cur.telefone && tp && (tp.length === 8 || tp.length === 9)) cur.telefone_parcial = tp;
          continue;
        }
        cur[k] = dados[k];
      }
    }
    dadosColetados.set(chatId, cur);
    try {
      await setChatState(nome, chatId, {
        dadosColetados: cur,
        updatedAt: Date.now()
      });
    } catch {}

    // Montagem automática de telefone (DDD + parcial) com persistência imediata segura
    try {
      const stNow = await getChatState(nome, chatId).catch(()=>null);
      const curDc = (stNow && stNow.dadosColetados) ? stNow.dadosColetados : (dadosColetados.get(chatId) || {});

      const temDDD = curDc && curDc.ddd && String(curDc.ddd).trim().length === 2;
      const temParcial = curDc && curDc.telefone_parcial && String(curDc.telefone_parcial).trim().length >= 8 && String(curDc.telefone_parcial).trim().length <= 9;
      const semTelefone = !curDc || !curDc.telefone;

      if (semTelefone && temDDD && temParcial) {
        const combinado = String(curDc.ddd).replace(/\D/g,'') + String(curDc.telefone_parcial).replace(/\D/g,'');
        if (isValidBRPhoneWithDDD(combinado)) {
          curDc.telefone = combinado;
          delete curDc.telefone_parcial;
          await setChatState(nome, chatId, { dadosColetados: curDc, lastWhatsReminderAt: Date.now() });
          await flushChatStateNow(nome);
          try {
            const dddMask = String(curDc.ddd).replace(/\D/g,'');
            const last4 = String(combinado).replace(/\D/g,'').slice(-4);
            await issues.append(nome, 'phone_compose_ok', `ddd=${dddMask} last4=${last4} chat=${chatId}`);
          } catch {}
        }
      }
    } catch {}

    // === FINAL: só falta telefone (whats) — delegação exclusiva ao orquestrador (pedidos.js). Nada de envio direto aqui. ===
    // intencionalmente vazio — o pedidos.js fará a pergunta de WhatsApp dentro da resposta consolidada.

    // Centraliza finalização no orquestrador
    try {
      await pedidos.upsertFromIA(nome, chatId, cur);
      await pedidos.finalizeIfReady(nome, chatId);
    } catch {}
  }

  async function iniciarTimerFechamento(chatId, telefone) {
    if (!timersFechamento) return;
    if (timersFechamento.has(chatId)) return; // não reinicia
    const inicio = Date.now();
    const expiraEm = inicio + (10 * 60 * 1000); // 10 minutos
    const timerId = setTimeout(() => verificarTimerExpirado(chatId), 10 * 60 * 1000);
    timersFechamento.set(chatId, { inicio, telefone, expirado: false, expiraEm, timerId });
    try {
      await setChatState(nome, chatId, {
        timerStartedAt: inicio,
        timerExpiresAt: expiraEm,
        timerTelefone: telefone,
        updatedAt: Date.now()
      });
    } catch {}
    await flushChatStateNow(nome);
    try {
      const dc = dadosColetados.get(chatId) || {};
      const telMask = telefone ? maskPhoneLog(telefone) : '';
      logger.info('[TIMER] timer_start', { chatId, cidade: dc.cidade || null, telefone: telMask });
      await issues.append(nome, 'mil_action', `timer_start chat=${chatId} cidade="${dc.cidade||''}" tel="${telMask||''}"`);
    } catch {}
  }

  function cancelarTimerFechamento(chatId) {
    const t = timersFechamento.get(chatId);
    if (t && t.timerId) { try { clearTimeout(t.timerId); } catch {} }
    timersFechamento.delete(chatId);
    try {
      setChatState(nome, chatId, {
        timerCancelledAt: Date.now(),
        timerExpiresAt: null,
        timerStartedAt: null,
        timerTelefone: null
      });
      appendPedidoAudit(nome, chatId, 'timer_cancelled', {});
    } catch {}
  }

  async function verificarTimerExpirado(chatId) {
    if (!timersFechamento) return;
    const t = timersFechamento.get(chatId);
    if (!t || t.expirado) return;

    const decorrido = Date.now() - t.inicio;
    if (decorrido < 10 * 60 * 1000) return;

    t.expirado = true;
    timersFechamento.set(chatId, t);

    const dados = (dadosColetados && dadosColetados.get(chatId)) || {};
    const tel = dados.telefone || t.telefone || null;
    const cidade = dados.cidade || null;

    try {
      const telMask = tel ? maskPhoneLog(tel) : '';
      logger.info('[TIMER] timer_expired', { chatId, cidade: cidade || null, telefone: telMask });
      await issues.append(nome, 'mil_action', `timer_expired chat=${chatId} cidade="${cidade||''}" tel="${telMask||''}"`);
    } catch {}

    await appendPedidoAudit(nome, chatId, 'timer_expired', { telOk: !!(tel && isValidBRPhoneWithDDD(tel)), cidadeOk: !!(cidade && String(cidade).trim()) });

    if (!tel || !isValidBRPhoneWithDDD(tel)) { timersFechamento.delete(chatId); return; }
    if (!cidade || !String(cidade).trim()) { timersFechamento.delete(chatId); return; }

    if (!chatLock.acquire(nome, chatId)) {
      await appendPedidoAudit(nome, chatId, 'timer_lock_busy_skip', {});
      timersFechamento.delete(chatId);
      return;
    }
    try {
      const already = await loadPedidoSent(nome, chatId);
      if (already) {
        await appendPedidoAudit(nome, chatId, 'timer_dedupe_skip', { sentAt: already.sentAt });
        timersFechamento.delete(chatId);
        return;
      }
      await enviarPedidoParaNotificador(chatId, { ...dados, telefone: tel, cidade });
      timersFechamento.delete(chatId);
    } finally {
      chatLock.release(nome, chatId);
    }
  }

  async function resumeTimers() {
    if (!timersFechamento || !dadosColetados) return;
    try {
      const allStates = await loadChatState(nome);
      const agora = Date.now();

      for (const [chatId, state] of Object.entries(allStates)) {
        if (state && state.dadosColetados) {
          dadosColetados.set(chatId, state.dadosColetados);
        }
      }

      for (const [chatId, state] of Object.entries(allStates)) {
        if (!state || !state.timerExpiresAt) continue;
        if (state.timerCancelledAt || state.state === CHAT_STATES.FINALIZADO) continue;

        const already = await loadPedidoSent(nome, chatId);
        if (already) continue; // não rearma timer já enviado

        const expiraEm = state.timerExpiresAt;
        if (expiraEm <= agora) {
          await verificarTimerExpirado(chatId);
        } else {
          const restante = expiraEm - agora;
          const timerId = setTimeout(() => verificarTimerExpirado(chatId), restante);
          timersFechamento.set(chatId, {
            inicio: state.timerStartedAt || (agora - (10 * 60 * 1000 - restante)),
            telefone: state.timerTelefone || null,
            expirado: false,
            expiraEm,
            timerId
          });
          await appendPedidoAudit(nome, chatId, 'timer_restored', { restanteMs: restante });
        }
      }

      const totalDados = dadosColetados ? dadosColetados.size : 0;
      const totalTimers = timersFechamento ? timersFechamento.size : 0;

    } catch (e) {
      logger.warn('[TIMER] Erro ao restaurar timers', { error: e && e.message || e });
    }
  }


  // REMOVIDO: enviarPedidoParcialSeHabilitado - função perigosa removida
  // Todos os envios agora passam por enviarPedidoParaNotificador com idempotência e validação completa

  async function enviarPedidoParaNotificador(chatId, dados) {
    const tel = dados && dados.telefone;
    const cidade = dados && dados.cidade;
    const auditData = { cidade };
    if (tel) auditData.telefone = maskPhoneLog(tel);
    await appendPedidoAudit(nome, chatId, 'send_attempt', auditData);

    if (!tel || !isValidBRPhoneWithDDD(tel)) {
      await appendPedidoAudit(nome, chatId, 'blocked_no_whatsapp', {});
      return;
    }
    if (!cidade || !String(cidade).trim()) {
      await appendPedidoAudit(nome, chatId, 'blocked_no_city', {});
      return;
    }

    logger.info('[NOTIF_SEND] preparando envio', { nome, chatId, telefone: maskPhoneLog(tel), cidade });

    let __acquired = false;
    for (let i = 0; i < 2; i++) {
      if (chatLock.acquire(nome, chatId)) { __acquired = true; break; }
      await sleep(250 + Math.floor(Math.random() * 200));
    }
    if (!__acquired) {
      await appendPedidoAudit(nome, chatId, 'lock_busy_skip', {});
      return;
    }
    try {
      const already = await loadPedidoSent(nome, chatId);
      if (already) {
        await appendPedidoAudit(nome, chatId, 'dedupe_skip', { sentAt: already.sentAt });
        return;
      }

      const payload = {
        servidor: NOTIFICADOR_SERVIDOR,
        perfil: nome,
        chat_id: chatId,
        telefone: tel,
        cidade: cidade,
        itens: dados.itens || null,
        endereco_saida: dados.endereco_saida || null,
        endereco_destino: dados.endereco_destino || null,
        ajudante: (typeof dados.ajudante === 'boolean') ? dados.ajudante : null,
        descricao: dados.descricao || null
      };

      const urlFinal = `${NOTIFICADOR_URL}/api/pedidos`;
      let resp = null, bodyText = '';
      try {
        resp = await fetch(urlFinal, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });
        bodyText = await resp.text().catch(()=> '');
      } catch (e) {
        await appendPedidoAudit(nome, chatId, 'send_fail_network', { error: e && e.message || String(e) });
        return;
      }

      if (resp && resp.ok) {
        await markPedidoSent(nome, chatId, payload, 'immediate_or_timer');
        logger.info('[NOTIF_SEND] enviado com sucesso', { nome, chatId, telefone: maskPhoneLog(tel), cidade });
        pedidosEnviados.add(chatId);
        await setChatState(nome, chatId, { state: CHAT_STATES.FINALIZADO, pedidoSentAt: Date.now() });
        await enviarMensagemFinal(chatId);
      } else {
        await appendPedidoAudit(nome, chatId, 'send_fail_http', { status: resp && resp.status, body: bodyText.slice(0,500) });
      }

    } finally {
      chatLock.release(nome, chatId);
    }
  }

  async function enviarMensagemFinal(chatId) {
    const msgBase = 'Perfeito! Já repassei seu pedido ao motorista — ele vai te chamar no WhatsApp em alguns minutinhos para combinar os detalhes e informar o orçamento. Qualquer coisa, fico por aqui.';
    const igCTA = [
      'Aproveitando: se puder dar uma força, siga nossa página no Instagram 😊',
      'https://www.instagram.com/convenientetecnologia',
      '@convenientetecnologia'
    ].join('\n');
    const mensagem = [msgBase, igCTA].join('\n\n');

    // Idempotência: não repetir se enviada recentemente
    try {
      const st = await getChatState(nome, chatId).catch(() => null);
      if (st && st.finalMsgSentAt && (Date.now() - Number(st.finalMsgSentAt)) < 10 * 60 * 1000) {
        logger.info('[MENSAGEM_FINAL] já enviada recentemente — skip', { nome, chatId });
        return;
      }
    } catch {}

    for (let attempt = 1; attempt <= VIRTUS_FINAL_MSG_MAX_TRIES; attempt++) {
      let p = await ensurePage().catch(() => null);
      if (!p) {
        logger.warn('[MENSAGEM_FINAL] Page indisponível', { nome, chatId, attempt });
        if (attempt < VIRTUS_FINAL_MSG_MAX_TRIES) {
          await sleep(randomBetween(VIRTUS_FINAL_MSG_RETRY_MIN_MS, VIRTUS_FINAL_MSG_RETRY_MAX_MS));
          continue;
        }
        return;
      }

      try {
        let urlNow2 = (typeof p.url === 'function') ? (p.url() || '') : '';
        if (!chatUrlMatches(urlNow2, chatId)) {
          await openChatByClick(p, chatId, { timeoutMs: 8000, retries: 2 });
        }
        const okOn = await assertOnChat(p, chatId, { timeoutMs: 2000 });
        if (!okOn) {
          logger.warn('[MENSAGEM_FINAL] Chat não confirmado', { nome, chatId, attempt });
          if (attempt < VIRTUS_FINAL_MSG_MAX_TRIES) {
            await sleep(randomBetween(VIRTUS_FINAL_MSG_RETRY_MIN_MS, VIRTUS_FINAL_MSG_RETRY_MAX_MS));
            continue;
          }
          return;
        }

        let campo = await waitForComposer(p, 8000);
        if (!campo) {
          const anchorSel = `a[href^="/marketplace/t/${chatId}"]`;
          campo = await refocusComposerNoReload(p, chatId, anchorSel);
        }

        if (!campo) {
          logger.warn('[MENSAGEM_FINAL] Composer indisponível após refocus', { nome, chatId, attempt });
          if (attempt < VIRTUS_FINAL_MSG_MAX_TRIES) {
            await sleep(randomBetween(VIRTUS_FINAL_MSG_RETRY_MIN_MS, VIRTUS_FINAL_MSG_RETRY_MAX_MS));
            continue;
          }
          return;
        }

        await waitForSendLockRelease(p, 12000);
        await acquireSendGuard(p, chatId);
        try {
          await sendMessageSafe(p, campo, removeTelefonesCompletosLoose(mensagem), nome, chatId);
          // Marca flag de mensagem final enviada (idempotência)
          try {
            await setChatState(nome, chatId, { finalMsgSentAt: Date.now() });
            await flushChatStateNow(nome);
          } catch {}
          return;
        } finally {
          releaseSendGuard(p);
        }
      } catch (e) {
        logger.warn('[MENSAGEM_FINAL] Falha ao enviar (tentativa)', { chatId, attempt, error: e && e.message || e });
        if (attempt < VIRTUS_FINAL_MSG_MAX_TRIES) {
          await sleep(randomBetween(VIRTUS_FINAL_MSG_RETRY_MIN_MS, VIRTUS_FINAL_MSG_RETRY_MAX_MS));
          continue;
        }
        return;
      }
    }
  }

  async function ensureLocationPrefetch(chatId, urlHint = null) {
    try {
      const st = await getChatState(nome, chatId).catch(() => null);
      if (st && st.cidade && st.estado) return;
      if (st && st.locFetchInFlight === true) return;

      try {
        await setChatState(nome, chatId, { locFetchInFlight: true, state: CHAT_STATES.COLETANDO, lastProbeAt: Date.now() });
      } catch {}

      // Se não veio URL, tenta obtê-la com o chat aberto por clique (sem navegação)
      if (!urlHint) {
        const p0 = await ensurePage().catch(() => null);
        if (p0) {
          const nowUrl = (typeof p0.url === 'function') ? (p0.url() || '') : '';
          if (!chatUrlMatches(nowUrl, chatId)) {
            await openChatByClick(p0, chatId, { timeoutMs: 6000, retries: 1 });
          }
          try { urlHint = await extrairUrlClassificado(p0, chatId); } catch {}
        }
      }

      const buscador = (global && global.__buscaLocalizacaoVirtus) ? global.__buscaLocalizacaoVirtus : null;
      if (!buscador || typeof buscador.adicionarBuscaLocalizacao !== 'function') {
        try { await setChatState(nome, chatId, { locFetchInFlight: false }); } catch {}
        return;
      }

      // Dispara worker (Aba 1) com o link (Aba 0 nunca navega)
      buscador.adicionarBuscaLocalizacao(chatId, urlHint || null, nome, async (loc) => {
        try {
          const patch = { locFetchInFlight: false };
          if (loc && loc.cidade && loc.estado) {
            patch.cidade = String(loc.cidade || '');
            patch.estado = String(loc.estado || '');
            patch.state = CHAT_STATES.PENDENTE;
          } else {
            patch.locWarnedNoLocation = true;
          }
          await setChatState(nome, chatId, patch);
        } catch {}
      });

    } catch {}
  }

  async function runner() {
    const attId = stepLog.attemptId();

    let manifestFrozenUntil = 0;
    try {
      const manifest = await manifestStore.read(nome);
      manifestFrozenUntil = typeof manifest?.frozenUntil === 'number' ? manifest.frozenUntil : 0;
    } catch {}
    if (manifestFrozenUntil && manifestFrozenUntil > Date.now()) {
      running = false;
      logger.warn(`[VIRTUS][${nome}] virtus_stop_frozen window — congelado até ${new Date(manifestFrozenUntil).toISOString()}`, { nome });
      return;
    }

    await sleep(2000);
    let ready = false;
    while (running && !ready) {
      if (!running || !epochOk()) return;
      try {
        if (!running || !epochOk()) return;
        const p = await ensurePage();
        if (!running || !epochOk()) return;
        if (!p) { await sleep(2500); continue; }
        if (p.url() === 'about:blank' || !/messenger\.com\/marketplace/i.test(p.url())) {
          try {
            if (!running || !epochOk()) return;
            await p.goto('https://www.messenger.com/marketplace', { waitUntil: 'domcontentloaded', timeout: 30000 });
          } catch {
            bumpRecoverBackoff(); if (recoverBackoffMs) await sleep(recoverBackoffMs); continue;
          }
        }
        if (!running || !epochOk()) return;
        await maybeGuaranteeMarketplaceFast(p, nome);
        try {
          const ok = await scrollChatsToTop(p, nome);
          setTimeout(() => {
            if (!running || !epochOk()) return;
            try {
              const b = getBrowserFromPage(p);
              if (b && b._sendLock && b._sendLock.active) return;
            } catch {}
            scrollChatsToTop(p, nome);
          }, 800);
        } catch {}
        ready = true;
        logger.info('Aba zero da Virtus iniciada e garantida: Marketplace pronta.', { nome });
        NAV_CLICK_ONLY = true;
        try { stepLog.appendJSONL(nome, 'virtus', { step: 'nav_click_only_lock_enabled' }); } catch {}
        
        function onNewChatDetected({ id, tempo }) {
          const chatId = id;
          const now = Date.now();
          // Não agenda atendimento ainda. Primeiro coleta cidade obrigatoriamente.
          setChatState(nome, chatId, { state: CHAT_STATES.COLETANDO, lastProbeAt: now, locFetchInFlight: true }).catch(()=>{});
          ensureLocationPrefetch(chatId, null).catch(() => {});
        }
        await installChatFeedObserver(p, nome, onNewChatDetected);
      } catch (err) {
        if (!running) return;
        logger.error('Falha ao garantir aba zero no startup Virtus', { nome }, err);
        await sleep(2500);
      }
    }
    if (!running || !epochOk()) return;
    
    try {
      await fazerHandshakeNotificador(nome);
      if (NOTIFICADOR_OUTBOUND) {
        iniciarPollingRespostas(nome);
      }
      
      async function enviarRespostaMessengerSeguraLocal(chatId, resposta) {
      const MAX_TRIES = 2;
      let lastErr = null;
      
      for (let attempt = 1; attempt <= MAX_TRIES; attempt++) {
        let p = await ensurePage().catch(() => null);
        if (!p) {
          lastErr = new Error('page_unavailable');
          if (attempt === MAX_TRIES) break;
          await new Promise(r => setTimeout(r, 600 + Math.floor(Math.random() * 400)));
          continue;
        }
        
        try {
          try {
            const urlNow = (p && typeof p.url === 'function') ? (p.url() || '') : '';
            const okChat = chatUrlMatches(urlNow, chatId);
            let campo = null;
            let hasComposer = false;
            if (okChat) {
              campo = await waitForComposer(p, 1500).catch(()=>null);
              hasComposer = !!campo;
            }
            if (okChat && hasComposer) {
              await waitForSendLockRelease(p, 12000);
              await acquireSendGuard(p, chatId);
              try {
                await sendMessageSafe(p, campo, String(resposta || ''), nome, chatId);
              } finally {
                releaseSendGuard(p);
              }
              return true;
            }
          } catch {}
          
          
          let urlNow = (typeof p.url === 'function') ? (p.url() || '') : '';
          if (!chatUrlMatches(urlNow, chatId)) {
            await openChatByClick(p, chatId, { timeoutMs: 8000, retries: 2 });
          }
          
          const okOn = await assertOnChat(p, chatId, { timeoutMs: 2000 });
          if (!okOn) {
            throw new Error('chat_not_opened');
          }
          
          let campo = await waitForComposer(p, 10000);
          if (!campo) {
            const anchorSel = `a[href^="/marketplace/t/${chatId}"]`;
            campo = await refocusComposerNoReload(p, chatId, anchorSel);
          }
          
          if (!campo) {
            throw new Error('composer_not_available');
          }
          
          await campo.focus();
          await new Promise(r => setTimeout(r, 120));
          
          if (!(await assertOnChat(p, chatId, { timeoutMs: 2000 }))) {
            throw new Error('context_lost');
          }
          
          await waitForSendLockRelease(p, 12000);
          await acquireSendGuard(p, chatId);
          try {
            await sendMessageSafe(p, campo, String(resposta || ''), nome, chatId);
          } finally {
            releaseSendGuard(p);
          }
          
          return true;
        } catch (err) {
          lastErr = err;
          const msgErr = (err && err.message) ? err.message : String(err);
          logger.warn('[MESSENGER] Tentativa falhou', { 
            nome, 
            chatId, 
            attempt, 
            maxTries: MAX_TRIES,
            error: msgErr 
          });
          
          if (attempt < MAX_TRIES) {
            await new Promise(r => setTimeout(r, 600 + Math.floor(Math.random() * 400)));
          }
        }
      }
      
      if (lastErr) {
        const msgErr = (lastErr && lastErr.message) ? lastErr.message : String(lastErr);
        logger.error('[MESSENGER] ❌ Erro ao enviar mensagem após todas as tentativas', { 
          nome, 
          chatId, 
          error: msgErr 
        }, lastErr);
        return false; // NÃO lança exceção; evita quebrar o pipeline
      }
      
      return false;
    }
    
    async function marcarRespondidoLocal(chatId) {
      try {
        await setChatState(nome, chatId, { lastIARespondedAt: Date.now() });
        await flushChatStateNow(nome);
      } catch (e) {
        logger.error('[VIRTUS] marcarRespondido error', { nome, chatId, error: e && e.message || e });
      }
    }
    
        iniciarFilaEnvioMessenger(nome, enviarRespostaMessengerSeguraLocal, marcarRespondidoLocal);
      bindPedidosEventsIfNeeded(nome, enviarPedidoParaNotificador, enviarRespostaMessengerSeguraLocal, marcarRespondidoLocal);
    } catch (e) {
      logger.warn('[NOTIFICADOR] falha init filas/handshake (modo legado)', { nome, error: e && e.message || e });
    }
    
    // Restaura dados coletados e timers do disco ao reiniciar
    try {
      await resumeTimers();
    } catch (e) {
      logger.warn('[VIRTUS] Erro ao restaurar dados/timers do disco', { nome, error: e && e.message || e });
    }
    
    // Varredura contínua e imediata (sem locks de atendimento)
    setInterval(() => scanAndProcessChats(nome), SCAN_INTERVAL_MS);
    scanAndProcessChats(nome);
  }

  runner();

  return {
    stop: async () => {
      stepLog.appendJSONL(nome, 'virtus', { attempt: attId, step: 'stop' });
      running = false;
      let pages = [];
      try { pages = await browser.pages(); } catch {}
      if (robeMeta && typeof nome !== "undefined") {
        if (!robeMeta[nome]) robeMeta[nome] = {};
        robeMeta[nome].numPages = pages.length;
      }
      delete virtusDeadLogTimes[nome];
    }
  };
}

module.exports = {
  startVirtus
};