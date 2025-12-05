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
const { acquireFileLock, releaseFileLock } = require('./manifestStore.js');
const { masterExtractAnswer } = require('./inteligenciaArtificial.js');
const chatStateStore = require('./chatStateStore.js');
const notifierQueue = require('./notifierQueue.js');
const virtusFSM = {
  get(perfil, chatId){ return chatStateStore.get(perfil, chatId); },
  patch(perfil, chatId, patchObj){ return chatStateStore.patch(perfil, chatId, patchObj); },
  ingestFromVirtus(perfil, chatId, payload) {
    const s = chatStateStore.get(perfil, chatId);
    if (payload && payload.cursor) {
      s.cursor = s.cursor || {};
      s.cursor.client = s.cursor.client || {};
      s.cursor.client.count = Number(payload.cursor.count || 0);
      s.cursor.client.digest = String(payload.cursor.digest || '');
      s.cursor.client.lastTs = Number(payload.cursor.lastTs || 0);
      if (payload.cursor.contentSig !== undefined) {
        s.cursor.client.contentSig = String(payload.cursor.contentSig || '');
      }
    }
    return chatStateStore.patch(perfil, chatId, s);
  },
  ackQueued(){ return true; },
  ackSent(perfil, chatId, cursorSig) {
    const s = chatStateStore.get(perfil, chatId);
    s.cursor = s.cursor || {};
    s.cursor.ia = s.cursor.ia || {};
    s.cursor.ia.sentSig = String(cursorSig || '');
    return chatStateStore.patch(perfil, chatId, s);
  },
  flowLog(){ return true; },
  computeEarliestSendAt(perfil, chatId, { origin, lastClientTs } = {}) {
    const base = Number(lastClientTs || Date.now());
    const jitter = 30000 + Math.floor(Math.random() * 60000); // 30-90s
    return base + jitter;
  }
};
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
  const t0 = normalizeContent(s);
  const t = t0.replace(/[.,;:!?\u200B-\u200D\uFEFF]/g, '').trim();
  if (!t) return true;

  // Lixos comuns do Messenger/Marketplace
  if (t === 'inserir') return true;
  if (t.startsWith('mensagem nao lida')) return true;
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

    return false;

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

// REMOVIDO: bindPedidosEventsIfNeeded - toda orquestração agora via virtusFSM

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

// REMOVIDO: CHAT_STATE_PENDING, scheduleChatStateFlush - toda persistência agora via virtusFSM

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
            const key = id; // Usar só id para evitar spam de eventos por tempo que muda
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

function pickFinalMessageFromFile() {
  try {
    const file = path.join(__dirname, '..', 'dados', 'mensagemFinal.json');
    if (fsRaw.existsSync(file)) {
      const content = fsRaw.readFileSync(file, 'utf8');
      const data = JSON.parse(content);
      if (data.mensagem) return data.mensagem;
      if (Array.isArray(data) && data.length) {
        return data[Math.floor(Math.random() * data.length)];
      }
    }
  } catch {}
  return 'Perfeito! Já repassei seu pedido ao motorista — ele vai te chamar no WhatsApp em alguns minutinhos para combinar os detalhes e informar o orçamento. Qualquer coisa, fico por aqui. Aproveitando: se puder dar uma força, siga nossa página no Instagram 😊 @convenientetecnologia';
}

function masterJsonlPath(perfil, chatId) {
  const p = path.join(__dirname, '..', 'dados', 'perfis', String(perfil||'default'), 'chats');
  try { fsRaw.mkdirSync(p, { recursive: true }); } catch {}
  return path.join(p, `${chatId}.master.jsonl`);
}

function appendMasterJSONL(perfil, chatId, obj) {
  try {
    fsRaw.appendFileSync(masterJsonlPath(perfil, chatId), JSON.stringify({ ts: Date.now(), ...obj }) + '\n', 'utf8');
  } catch {}
}

function antiEchoReply(reply, lastClientText) {
  try {
    const a = (reply||'').toLowerCase().replace(/\s+/g,' ').trim();
    const b = (lastClientText||'').toLowerCase().replace(/\s+/g,' ').trim();
    if (!a || !b) return reply;
    if (a.includes(b) || b.includes(a)) {
      return reply.length > 200 ? reply.slice(0, 200) : reply; // corta eco massivo
    }
  } catch {}
  return reply;
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
    // Obtém lastTs e lista de mensagens recentes do FSM para deduplicação ultra forte
    let lastTs = 0;
    let chatLogRecent = [];
    try {
      let fsmState = null;
      try {
        fsmState = virtusFSM.get(perfil, chatId);
      } catch {}
      lastTs = (fsmState && fsmState.chatLogLastTs) || 0;
      chatLogRecent = Array.isArray(fsmState && fsmState.chatLogRecent) ? fsmState.chatLogRecent : [];
    } catch {}
    
    // Deduplicação ultra forte: grave só mensagens autor+texto que não estão na lista FSM.chatLogRecent
    // "Nenhuma mensagem encontrada." nunca vai para disco, logs ou campos
    const novos = (historicoArr||[]).filter(m => {
      // Filtra por timestamp
      if (Number(m.timestamp||0) <= lastTs) return false;
      
      // Filtra "Nenhuma mensagem encontrada."
      const texto = String(m && m.texto || '').trim();
      if (!texto || texto === 'Nenhuma mensagem encontrada.') return false;
      
      // Deduplicação por hash autor+texto normalizado
      const autor = String(m && m.autor || '');
      const textoNorm = normalizeContent(texto);
      const msgHash = sha1(`${autor}|${textoNorm}`);
      
      // Verifica se já está em chatLogRecent
      const alreadyExists = chatLogRecent.some(existing => {
        const existingHash = String(existing && existing.hash || '');
        return existingHash === msgHash;
      });
      
      return !alreadyExists;
    });
    
    if (!novos.length) return;
    
    await fs.mkdir(path.dirname(file), { recursive: true });
    const newRecent = [];
    
    for (const m of novos) {
      const rawToCheck = String(m && m.texto || '').trim();
      if (!rawToCheck || /^[\W_]+$/.test(rawToCheck)) continue;
      
      // Sanitiza mensagens antes de salvar (remove telefones completos)
      const mSanitizado = Object.assign({}, m);
      if (mSanitizado.texto) {
        mSanitizado.texto = removeTelefonesCompletosLoose(String(mSanitizado.texto || ''));
      }
      
      // Calcula hash para deduplicação
      const autor = String(m && m.autor || '');
      const textoNorm = normalizeContent(String(mSanitizado.texto || ''));
      const msgHash = sha1(`${autor}|${textoNorm}`);
      
      fsRaw.appendFileSync(file, JSON.stringify(mSanitizado)+'\n', 'utf8');
      
      // Adiciona à lista recente (janela deslizante, mantém últimas 100)
      newRecent.push({
        hash: msgHash,
        autor,
        textoNorm,
        timestamp: Number(m.timestamp || 0)
      });
    }
    
    // Atualiza chatLogRecent (janela deslizante)
    const allRecent = [...chatLogRecent, ...newRecent]
      .sort((a, b) => Number(a.timestamp || 0) - Number(b.timestamp || 0))
      .slice(-100); // Mantém últimas 100
    
    const maxTs = Math.max(...novos.map(m=>Number(m.timestamp||0)));
    // Atualiza via FSM
    try {
      await virtusFSM.patch(perfil, chatId, {
        chatLogLastTs: maxTs || Date.now(),
        chatLogRecent: allRecent
      });
    } catch {}
  } catch {}
}

async function appendIaLine(perfil, chatId, texto) {
  const textoSanitizado = sanitizeOutgoing(removeTelefonesCompletosLoose(String(texto||'')));
  const obj = { autor:'ia', texto: textoSanitizado, timestamp: Date.now() };
  const file = chatLogPath(perfil, chatId);
  try { fsRaw.mkdirSync(path.dirname(file), { recursive: true }); fsRaw.appendFileSync(file, JSON.stringify(obj)+'\n', 'utf8'); } catch {}
  // Atualiza via FSM ao invés de setChatState
  try {
    await virtusFSM.patch(perfil, chatId, { chatLogLastTs: obj.timestamp });
  } catch {}
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

// REMOVIDO: clearFreezeIfTelefoneOk - freeze agora gerenciado pelo virtusFSM

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

// REMOVIDO: nextMissingField - campos ajudante, missing, descrição removidos
// function nextMissingField(dc = {}) {
//   if (!dc.itens) return 'itens';
//   if (!dc.endereco_saida) return 'endereco_saida';
//   if (!dc.endereco_destino) return 'endereco_destino';
//   if (typeof dc.ajudante !== 'boolean') return 'ajudante';
//   return null;
// }

// REMOVIDO: getAskCounts, bumpAskCount, montarRespostaForcadaWhatsAppSemDDD - agora gerenciado pelo virtusFSM

// REMOVIDO: detectAskedFieldFromText - campos ajudante removidos
// function detectAskedFieldFromText(t) {
//   const n = normTxt(t);
//   // Endereço de saída
//   if (/(endereco|endereço).*(sa[ií]da|retirada)|onde\s+(buscar|retirar)|local\s+de\s+retirada/.test(n)) return 'endereco_saida';
//   // Endereço de destino
//   if (/(endereco|endereço).*(destino|entrega)|para\s+onde|local\s+de\s+entrega/.test(n)) return 'endereco_destino';
//   if (/ajudante/.test(n)) return 'ajudante';
//   if (/itens?|o que\s+(levar|transportar)/.test(n)) return 'itens';
//   return null;
// }


function normTxt(s) {
  try { return String(s||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase(); }
  catch { return String(s||'').toLowerCase(); }
}
function extractBairro(text, pattern) {
  const m = pattern.exec(text);
  if (!m) return null;
  return String(m[1] || '').trim().replace(/[\s,.;:!?]+$/,'');
}

// REMOVIDO: interpretYesNo - campo ajudante removido
// function interpretYesNo(raw) {
//   const t = normTxt(raw || '');
//   if (/^(sim|isso|claro|afirmativo)\b/.test(t)) return true;
//   if (/\b(vou precisar|com ajudante)\b/.test(t)) return true;
//   if (/^(nao|não|n)\b/.test(t)) return false;
//   if (/\b(sem ajudante|nao vou precisar|não vou precisar|dispenso)\b/.test(t)) return false;
//   return null;
// }



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
      
      // Localização sempre do manifest
      const man = await manifestStore.read(nomePerfil).catch(()=>null);
      const cidade = man && man.cidade || null;
      const uf = man && man.estado || null;
      const localizacao = cidade && uf ? `${cidade} (${uf})` : (cidade || null);
      
      const payload = {
        servidor: NOTIFICADOR_SERVIDOR,
        chat_id: dadosChat.chatId,
        perfil: nomePerfil,
        tipo_servico: dadosChat.tipoServico,
        historico: historicoSanitizado,
        localizacao: localizacao || null,
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

function iniciarFilaEnvioMessenger(nomePerfil, enviarRespostaMessengerSeguraFn, marcarRespondidoFn, getUrlNowFn) {
  if (filaEnvioTimers.has(nomePerfil)) return;

  // Callback de URL para logging diários, nunca depende de ensurePage diretamente
  const getUrlNow = getUrlNowFn || (async () => {
    try {
      const p = await ensurePage().catch(() => null);
      return (p && typeof p.url === 'function') ? (p.url() || '') : '';
    } catch {
      return '';
    }
  });

  const id = setInterval(async () => {
    const fila = filaEnvioMessenger.get(nomePerfil) || [];
    if (fila.length === 0) return;

    const agora = Date.now();
    const ultima = ultimaRespostaMessenger.get(nomePerfil) || 0;
    const intervaloAleatorio = MESSENGER_INTERVALO_MIN_MS + Math.floor(Math.random() * (MESSENGER_INTERVALO_MAX_MS - MESSENGER_INTERVALO_MIN_MS));
    const tempoDesdeUltima = agora - ultima;
    if (tempoDesdeUltima < intervaloAleatorio) {
      const proximo = fila[0];
      if (proximo) {
        stepLog.appendJSONL(nomePerfil, 'virtus', {
          step: 'messenger_send_defer_random',
          chatId: proximo.chatId,
          remainingMs: intervaloAleatorio - tempoDesdeUltima,
          ts: agora
        });
      }
      return;
    }

    // Fila FIFO estrita: primeiro da fila, nunca saltar
    // Só envia o primeiro se já passou o earliestSendAt
    const proximo = fila[0];
    if (!proximo) return;
    
    // Verifica se earliestSendAt já passou
    if (typeof proximo.earliestSendAt === 'number' && proximo.earliestSendAt > agora) {
      return; // Ainda não é hora de enviar
    }
    
    // Remove da fila (FIFO)
    fila.shift();

    try {
      const respostaFinal = String(proximo.resposta || '').trim();
      
      // BLOQUEIO: Verifica freeze antes de enviar qualquer mensagem via FSM
      let fsmState = null;
      try {
        try {
          fsmState = virtusFSM.get(nomePerfil, proximo.chatId);
        } catch {}
      } catch {}
      
      // Verifica freeze e schedule antes de enviar
      const freezeUntil = (fsmState && fsmState.freeze && fsmState.freeze.finalizationUntil) ? Number(fsmState.freeze.finalizationUntil) : 0;
      if (freezeUntil > Date.now() && proximo.origin !== 'finalize') {
        logger.info('[QUEUE] Ignorado devido a bloqueio de 72h', { nomePerfil: nomePerfil, chatId: proximo.chatId, freezeUntil });
        virtusFSM.flowLog(nomePerfil, proximo.chatId, 'queue_defer_frozen', {
          earliestSendAt: proximo.earliestSendAt || null,
          now: Date.now(),
          freezeUntil
        });
        fila.push(proximo);
        return;
      }
      // para origin == 'finalize', envie normalmente!
      
      const scheduleAt = (fsmState && fsmState.schedule && fsmState.schedule.nextAllowedSendAt) ? Number(fsmState.schedule.nextAllowedSendAt) : 0;
      if (scheduleAt > Date.now()) {
        virtusFSM.flowLog(nomePerfil, proximo.chatId, 'queue_defer_earliest', {
          earliestSendAt: scheduleAt,
          now: Date.now()
        });
        fila.push(proximo);
        return;
      }
      
      // Logs ultra detalhados: messenger_send_attempt
      stepLog.appendJSONL(nomePerfil, 'virtus', {
        step: 'messenger_send_attempt',
        chatId: proximo.chatId,
        origin: proximo.origin || '',
        cursorSig: proximo.cursorSig || '',
        ts: agora
      });
      
      let ok = true;
      let attempts = (proximo.__tries || 0) + 1;
      let urlNow = '';
      
      if (enviarRespostaMessengerSeguraFn) {
        ok = await enviarRespostaMessengerSeguraFn(proximo.chatId, respostaFinal);
      }
      
      if (!ok) {
        proximo.__tries = attempts;
        urlNow = await getUrlNow();
        
        // Logs ultra detalhados: messenger_send_fail
        stepLog.appendJSONL(nomePerfil, 'virtus', {
          step: 'messenger_send_fail',
          chatId: proximo.chatId,
          attempts: proximo.__tries,
          url: urlNow,
          ts: Date.now()
        });
        
        virtusFSM.flowLog(nomePerfil, proximo.chatId, 'error_send', {
          reason: 'send_failed',
          attempts: proximo.__tries,
          url: urlNow,
          hasComposer: false,
          cursorSig: proximo.cursorSig || '',
          snapshot: {
            freeze: (fsmState && fsmState.freeze) || {},
            schedule: (fsmState && fsmState.schedule) || {}
          }
        });
        
        // Em caso de erro, refile esse no topo da fila, com earliestSendAt para 5s no futuro (não trava, não trava a ordem)
        const MAX_RETRIES = parseInt(process.env.MESSENGER_MAX_RETRIES || '2', 10);
        if (proximo.__tries < MAX_RETRIES) {
          proximo.earliestSendAt = agora + 5000; // 5s no futuro
          fila.unshift(proximo); // Refile no topo (FIFO preservado)
          logger.warn('[QUEUE] requeue_after_send_fail', { nomePerfil, chatId: proximo.chatId, tries: proximo.__tries, newEarliest: proximo.earliestSendAt });
        } else {
          // Limite de tentativas, após o qual loga e dropa o item
          logger.error('[QUEUE] drop_after_max_retries', { nomePerfil, chatId: proximo.chatId, maxRetries: MAX_RETRIES });
          stepLog.appendJSONL(nomePerfil, 'virtus', {
            step: 'messenger_send_dropped',
            chatId: proximo.chatId,
            attempts: proximo.__tries,
            ts: Date.now()
          });
        }
        if (proximo.key) getPendingSet(nomePerfil).delete(proximo.key);
        return;
      }
      
      // Logs ultra detalhados: messenger_send_ok
      urlNow = await getUrlNow();
      stepLog.appendJSONL(nomePerfil, 'virtus', {
        step: 'messenger_send_ok',
        chatId: proximo.chatId,
        url: urlNow,
        ts: Date.now()
      });

      ultimaRespostaMessenger.set(nomePerfil, Date.now());

      if (marcarRespondidoFn) {
        await marcarRespondidoFn(proximo.chatId);
      } else {
        await marcarRespondido(nomePerfil, proximo.chatId);
      }

      // Log send_ok e ACK no FSM
      try {
        virtusFSM.flowLog(nomePerfil, proximo.chatId, 'send_ok', {
          attempts: 1,
          url: urlNow,
          hasComposer: true,
          cursorSig: proximo.cursorSig || ''
        });
        await virtusFSM.ackSent(nomePerfil, proximo.chatId, proximo.cursorSig || '');
        
        // Logs ultra detalhados: ACK
        stepLog.appendJSONL(nomePerfil, 'virtus', {
          step: 'messenger_ack',
          chatId: proximo.chatId,
          cursorSig: proximo.cursorSig || '',
          ts: Date.now()
        });
      } catch (e) {
        logger.warn('[FSM][ACK] Falha ao logar send_ok/ackSent: ' + ((e && e.message) || e), { nomePerfil, chatId: proximo.chatId });
      }
      
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
    await virtusFSM.patch(nomePerfil, chatId, { lastIARespondedAt: Date.now() });
  } catch (e) {
    logger.error('[VIRTUS] marcarRespondido error', { nomePerfil, chatId, error: e && e.message || e });
  }
}

// [REMOVIDO: extrairUrlClassificado — scraping de URL não necessário, localização vem do manifest]

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


// REMOVIDO: Todas as funções de chat state local (CHAT_STATE_FILE, loadChatState, saveChatState, getChatState, setChatState, flushChatStateNow, CHAT_STATES)
// Toda persistência agora via virtusFSM

const SENT_COOLDOWN_MS = 60 * 1000; // mínimo de 60s



const NOTIFICADOR_URL = process.env.NOTIFICADOR_URL || 'https://c0nv3n13nt3t3cn0l0g14jesus.sa.ngrok.io';
const NOTIFICADOR_SERVIDOR = process.env.SERVIDOR_NOME || 'servidor1';

const NOTIFICADOR_OUTBOUND = String(process.env.NOTIFICADOR_OUTBOUND || '0') === '1'; // 0 = desativado (padrão)
const NOTIFICADOR_HISTORICO = String(process.env.NOTIFICADOR_HISTORICO || '0') === '1'; // 0 = não envia histórico (padrão)

const NOTIFICADOR_ENVIO_LOTE_MS = parseInt(process.env.NOTIFICADOR_ENVIO_LOTE_MS || '10000', 10); // 10s
const NOTIFICADOR_POLLING_MS = parseInt(process.env.NOTIFICADOR_POLLING_MS || '1100', 10);
const MESSENGER_INTERVALO_MIN_MS = parseInt(process.env.MESSENGER_INTERVALO_MIN_MS || '30000', 10); // 30s
const MESSENGER_INTERVALO_MAX_MS = parseInt(process.env.MESSENGER_INTERVALO_MAX_MS || '90000', 10); // 90s

// Janela de espera por conversa (antes de responder o cliente)
const WAIT_BEFORE_REPLY_MIN_MS = parseInt(process.env.WAIT_BEFORE_REPLY_MIN_MS || '30000', 10); // 30s
const WAIT_BEFORE_REPLY_MAX_MS = parseInt(process.env.WAIT_BEFORE_REPLY_MAX_MS || '90000', 10); // 90s

// Blindagem de chamadas à IA: evitar flood de tokens/tentativas excessivas
const LLM_ATTEMPT_TTL_MS = parseInt(process.env.VIRTUS_LLM_ATTEMPT_TTL_MS || '60000', 10);      // 1 min (60s)
const LLM_RETRY_BACKOFF_MS = parseInt(process.env.VIRTUS_LLM_RETRY_BACKOFF_MS || '60000', 10); // 1 min (60s)

const VIRTUS_FINAL_MSG_MAX_TRIES = parseInt(process.env.VIRTUS_FINAL_MSG_MAX_TRIES || '2', 10); // tentativas no envio da mensagem final
const VIRTUS_FINAL_MSG_RETRY_MIN_MS = parseInt(process.env.VIRTUS_FINAL_MSG_RETRY_MIN_MS || '600', 10); // 600ms
const VIRTUS_FINAL_MSG_RETRY_MAX_MS = parseInt(process.env.VIRTUS_FINAL_MSG_RETRY_MAX_MS || '900', 10); // 900ms

const MAX_CHAT_AGE_MS = parseInt(process.env.VIRTUS_CHAT_MAX_AGE_MS || '28800000', 10); // 8h
const SCAN_INTERVAL_MS = parseInt(process.env.VIRTUS_SCAN_MS || '5000', 10); // 5s
const SCAN_NAV_TIMEOUT_MS = 30000; // 30s para navegar no chat

const COLETA_FINAL_MS = parseInt(process.env.VIRTUS_COLETA_FINAL_MS || '600000', 10); // 10min
const FINALIZACAO_FREEZE_MS = parseInt(process.env.VIRTUS_FINAL_FREEZE_MS || '259200000', 10); // 72h

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

const filaEnviarNotificador = new Map();  // nomePerfil -> [ { chatId, tipoServico, mensagem, localizacao } ]
const filaRespostas = new Map();          // nomePerfil -> [ { chat_id, resposta } ]
const filaEnvioMessenger = new Map();     // nomePerfil -> [ { chatId, resposta, key } ]
const ultimaRespostaMessenger = new Map();// nomePerfil -> timestamp
const aguardandoRespostaMap = new Map();  // nomePerfil -> Set(chatId)

// TTL de aguardando notificador (Virtus)
const aguardTimers = new Map(); // nomePerfil -> Map(chatId -> timeoutId)

const finalizationTimers = new Map(); // nomePerfil -> Map(chatId -> timeoutId)
const finalizingSetByPerfil = new Map(); // nomePerfil -> Set(chatId)

// Guard de reentrância: nunca roda dois scans em paralelo para o mesmo perfil
const scanRunningByPerfil = new Map(); // nomePerfil -> boolean

// Timers de coleta (45s após evento)
const collectTimers = new Map(); // nomePerfil -> Map(chatId -> timeoutId)

// SLA watchdog timers (6 minutos após timer_fire)
const slaWatchdogTimers = new Map(); // nomePerfil -> Map(chatId -> timeoutId)

function getFinalizationMap(perfil) {
  if (!finalizationTimers.has(perfil)) finalizationTimers.set(perfil, new Map());
  return finalizationTimers.get(perfil);
}

function getFinalizingSet(perfil) {
  if (!finalizingSetByPerfil.has(perfil)) finalizingSetByPerfil.set(perfil, new Set());
  return finalizingSetByPerfil.get(perfil);
}

function clearFinalizationTimer(perfil, chatId) {
  try {
    const m = getFinalizationMap(perfil);
    if (m.has(chatId)) { clearTimeout(m.get(chatId)); m.delete(chatId); }
  } catch {}
}

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
    if (!payload) return { ok: false, status: 'dropped' };

    // Snapshot de estado atual do chat via FSM
    let fsmState = null;
    try {
      try {
        fsmState = virtusFSM.get(nomePerfil, chatId);
      } catch {}
    } catch {}

    // Bloqueio de finalize duplicado
    if (origin === 'finalize') {
      if (fsmState && fsmState.finalization && fsmState.finalization.closingMessageQueued) {
        try {
          stepLog.appendJSONL(nomePerfil, 'virtus', { step: 'queue_skip_finalize_duplicate', chatId });
        } catch {}
        return { ok: false, status: 'dropped' };
      }
    }

    const cCount = Number((typeof cursorCountOverride === 'number') ? cursorCountOverride : ((fsmState && fsmState.cursor && fsmState.cursor.client && fsmState.cursor.client.count) || 0));
    const cDigest = (typeof cursorDigestOverride === 'string') ? cursorDigestOverride : ((fsmState && fsmState.cursor && fsmState.cursor.client && fsmState.cursor.client.digest) || '');

    const sig = String(cursorSig || (cCount && cDigest ? `${cCount}|${cDigest}` : ''));

    // earliestSendAt para replyReady, ancorado NO lastClientTsOverride
    let earliestSendAt = undefined;

    if (origin === 'finalize') {
      let anchor = 0;
      try {
        const stForAnchor = virtusFSM.get(nomePerfil, chatId);
        anchor = Number(stForAnchor && stForAnchor.data && stForAnchor.data.lastClientTs) || Date.now();
      } catch {}
      const jitter = virtusFSM.computeEarliestSendAt
        ? virtusFSM.computeEarliestSendAt(nomePerfil, chatId, { origin: 'finalize', lastClientTs: anchor })
        : (anchor + WAIT_BEFORE_REPLY_MIN_MS + Math.floor(Math.random() * (WAIT_BEFORE_REPLY_MAX_MS - WAIT_BEFORE_REPLY_MIN_MS + 1)));
      earliestSendAt = jitter;
      try { stepLog.appendJSONL(nomePerfil, 'virtus', { step: 'queue_set_earliest_finalize', chatId, sig, anchor, earliestSendAt, origin: 'finalize', ts: Date.now() }); } catch {}
    }

    if (!filaEnvioMessenger.has(nomePerfil)) filaEnvioMessenger.set(nomePerfil, []);
    const fila = filaEnvioMessenger.get(nomePerfil);

    // Merge-in-place de replyReady e monotonic earliest
    if (origin === 'replyReady') {
      const idx = fila.findIndex(it => it && it.chatId === chatId && it.origin === 'replyReady');
      const anchor = (typeof lastClientTsOverride === 'number' && lastClientTsOverride > 0)
        ? lastClientTsOverride
        : Date.now();
      const jitter = WAIT_BEFORE_REPLY_MIN_MS + Math.floor(Math.random() * (WAIT_BEFORE_REPLY_MAX_MS - WAIT_BEFORE_REPLY_MIN_MS + 1));
      const newEarliest = anchor + jitter;
      if (idx >= 0) {
        const existing = fila[idx];
        const mergedEarliest = Math.min(Number(existing.earliestSendAt || newEarliest), Number(newEarliest));
        existing.resposta = payload;
        existing.cursorCount = cCount;
        existing.cursorDigest = cDigest;
        existing.cursorSig = sig || existing.cursorSig || '';
        existing.lastClientTs = lastClientTsOverride || existing.lastClientTs || 0;
        existing.earliestSendAt = mergedEarliest;
        try {
          stepLog.appendJSONL(nomePerfil, 'virtus', {
            step: 'queue_merge_update',
            chatId, sig, cCount, cDigest,
            earliestSendAt: mergedEarliest, ts: Date.now()
          });
          logger.info('[QUEUE] merge_update', { nomePerfil, chatId, sig, cCount, cDigest, earliestSendAt: mergedEarliest });
        } catch {}
        return { ok: true, status: 'merged' };
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
      return { ok: false, status: 'dropped' };
    }

    try {
      const stSent = virtusFSM.get(nomePerfil, chatId);
      const alreadySentSig = String(stSent && stSent.cursor && stSent.cursor.ia && stSent.cursor.ia.sentSig || '');
      if (sig && alreadySentSig && sig === alreadySentSig) {
        stepLog.appendJSONL(nomePerfil, 'virtus', { step: 'queue_skip_already_sent_sig', chatId, sig, origin, ts: Date.now() });
        return { ok: false, status: 'dropped' };
      }
    } catch {}

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

    // Marca closingMessageQueued se for finalize
    if (origin === 'finalize') {
      try {
        await virtusFSM.patch(nomePerfil, chatId, {
          finalization: { ...(fsmState && fsmState.finalization || {}), closingMessageQueued: true }
        });
      } catch {}
    }

    try { stepLog.appendJSONL(nomePerfil, 'virtus', { step: 'queue_add', chatId, sig, cCount, cDigest, origin, earliestSendAt, ts: Date.now() }); } catch {}
    try { logger.info('[QUEUE] add', { nomePerfil, chatId, sig, cCount, cDigest, origin, earliestSendAt }); } catch {}
    return { ok: true, status: 'enqueued' };

  } catch {
    return { ok: false, status: 'dropped' };
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
      // DEDUPE: verifica se a mensagem é semelhante à última enviada (via FSM)
      try {
        let fsmState = null;
        try {
          fsmState = virtusFSM.get(nome, chatId);
        } catch {}
        // Dedupe baseado em cursorSig do FSM, não em texto
      } catch {}

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
      // NOVO: registra imediatamente a linha 'ia' no JSONL para blindar o histórico em disco
      try {
        await appendIaLine(nome, chatId, safeMsg);
      } catch {}
    }

  } finally {
    setVirtusInputLock(nome, false);
  }
}

async function sendPedidoToNotificador(perfil, payload) {
  // 100% via notifierQueue - nunca envia diretamente à API, nunca joga fora em memória
  const ok = await notifierQueue.enqueuePedido(perfil, payload);
  if (ok) {
    stepLog.appendJSONL(perfil, 'virtus', { step: 'notifier_queue_add', chatId: payload.chat_id, ts: Date.now() });
  }
  return ok;
}

async function finalizePedido(perfil, chatId, contexto) {
  const finalizing = getFinalizingSet(perfil);
  if (finalizing.has(chatId)) return;
  finalizing.add(chatId);

  try {
    const already = await loadPedidoSent(perfil, chatId).catch(()=> null);
    if (already) return;

    let state = null; try { state = virtusFSM.get(perfil, chatId); } catch {}
    if (state && state.finalizado) return;

    // Extrai o estado do chat mais recente
    const historicoArray = await (async () => {
      try {
        const file = chatLogPath(perfil, chatId);
        const lines = fsRaw.existsSync(file) ? fsRaw.readFileSync(file,'utf8').trim().split(/\r?\n+/).map(l => JSON.parse(l)) : [];
        return lines;
      } catch { return []; }
    })();

    // Localização sempre do manifest
    const man = await manifestStore.read(perfil).catch(()=>null);
    const cidade = man && man.cidade || null;
    const uf = man && man.estado || null;
    const localizacao = cidade && uf ? `${cidade} (${uf})` : (cidade || null);

    // NUNCA chamar IA no timer/finalização - usar apenas dados já salvos
    let extraction = {};
    try {
      const state = virtusFSM.get(perfil, chatId);
      extraction = (state && state.data && state.data.extraction) || {};
    } catch {}
    const tel = String(extraction && extraction.telefone || '').trim();

    if (!isValidBRPhoneWithDDD(tel)) {
      logger.warn('[FINALIZE] Abortado — telefone ausente/ inválido (sem DDD)', { perfil, chatId, rawTelefone: tel || null });
      stepLog.appendJSONL(perfil, 'virtus', {
        step: 'finalization_skip_no_valid_phone',
        chatId,
        rawTelefone: tel || null
      });
      if (issues && typeof issues.append === 'function') {
        await issues.append(perfil, 'finalize_abort_no_whatsapp', `chat=${chatId}`);
      }
      return;
    }

    const item = extraction.item || 'não informado';
    const endSaida = extraction.endereco_saida || 'não informado';
    const endDestino = extraction.endereco_destino || 'não informado';

    const payload = {
      chat_id: chatId,
      whatsapp: tel, // Campo whatsapp (não telefone/nome antigo)
      item,
      endereco_saida: endSaida,
      endereco_destino: endDestino,
      localizacao: localizacao || null,
      cidade,
      estado: uf,
      timestamp: new Date().toISOString()
    };

    // Nunca espera resposta síncrona do notificador! Apenas joga na fila persistente/outbox e retorna
    const ok = await sendPedidoToNotificador(perfil, payload);
    if (ok) {
      await appendPedidoAudit(perfil, chatId, 'enqueued_outbox', {
        telefone: maskPhoneLog(tel),
        cidade,
        estado: uf
      });
    }
    if (!ok) {
      logger.warn('[FINALIZE] Falha ao enfileirar pedido no notifierQueue', { perfil, chatId });
      for (let i = 1; i <= 3; i++) {
        await sleep(500 * i);
        const ok2 = await sendPedidoToNotificador(perfil, payload);
        if (ok2) {
          await appendPedidoAudit(perfil, chatId, 'enqueued_outbox_retry_ok', { attempt: i });
          break;
        } else if (i === 3) {
          await appendPedidoAudit(perfil, chatId, 'enqueued_outbox_fail', { attempts: 3 });
          if (issues && typeof issues.append === 'function') await issues.append(perfil, 'finalize_outbox_write_fail', `chat=${chatId}`);
          return;
        }
      }
    }
    
    // Não remove, não apaga, não considera concluído antes do callback de ACK
    // markPedidoSent será chamado pelo callback de ACK do notificador

    // Mensagem final ao cliente (DO SISTEMA, não da IA)
    try {
      let st = null; try { st = virtusFSM.get(perfil, chatId); } catch {}
      const alreadyQueued = st && st.finalization && st.finalization.closingMessageQueued;
      if (!alreadyQueued) {
        const finalMsg = pickFinalMessageFromFile();
        await queueMessengerSend(perfil, {
          chatId,
          resposta: finalMsg,
          key: `finalize_msg|${chatId}|${sha1(finalMsg)}|${Date.now()}`,
          origin: 'finalize'
        });
        const now = Date.now();
        // Bloqueio indefinido (10 anos) para não monitorar/reentrar
        const lockUntil = Date.now() + FINALIZACAO_FREEZE_MS;
        await virtusFSM.patch(perfil, chatId, {
          finalization: Object.assign({}, st && st.finalization || {}, {
            closingMessageQueued: true,
            closedAt: now,
            lockUntil
          }),
          finalizado: true,
          freeze: Object.assign({}, st && st.freeze || {}, {
            finalizationUntil: lockUntil
          })
        });
      }
    } catch (e) {
      logger.warn('[FINALIZE] Falha ao enfileirar mensagem final', { perfil, chatId, error: (e && e.message) || e });
    }

    clearFinalizationTimer(perfil, chatId);

    logger.info('[FINALIZE] Pedido concluído e notificado', { perfil, chatId, telefone: maskPhoneLog(tel) });
  } finally {
    getFinalizingSet(perfil).delete(chatId);
  }
}

async function armFinalizationTimerIfNeeded(perfil, chatId, historicoSan, contexto) {
  try {
    const already = await loadPedidoSent(perfil, chatId).catch(()=>null);
    if (already) return;

    let st = null; try { st = virtusFSM.get(perfil, chatId); } catch {}
    if (st && st.finalizado) return;

    if (st && st.finalization && st.finalization.startedAt && st.finalization.deadlineAt) {
      const now = Date.now();
      const delay = Math.max(0, Number(st.finalization.deadlineAt) - now);
      const map = getFinalizationMap(perfil);
      if (!map.has(chatId)) {
        const tid = setTimeout(() => finalizePedido(perfil, chatId, contexto || {}), delay);
        map.set(chatId, tid);
        stepLog.appendJSONL(perfil, 'virtus', { step: 'finalization_timer_rearmed', chatId, delay, ts: now });
      }
      return;
    }

    // NUNCA chamar IA no timer/finalização - usar apenas dados já salvos
    let extraction = {};
    try {
      const st = virtusFSM.get(perfil, chatId);
      extraction = (st && st.data && st.data.extraction) || {};
    } catch {}
    const tel = String(extraction && extraction.telefone || '').trim();
    if (!isValidBRPhoneWithDDD(tel)) {
      stepLog.appendJSONL(perfil, 'virtus', {
        step: 'finalization_timer_skip_no_valid_phone',
        chatId,
        rawTelefone: tel || null
      });
      return;
    }

    const startedAt = Date.now();
    const deadlineAt = startedAt + COLETA_FINAL_MS;
    await virtusFSM.patch(perfil, chatId, {
      finalization: Object.assign({}, st && st.finalization || {}, {
        telefone: tel,
        startedAt,
        deadlineAt
      })
    });

    const map = getFinalizationMap(perfil);
    clearFinalizationTimer(perfil, chatId);
    const tid = setTimeout(() => finalizePedido(perfil, chatId, contexto || {}), COLETA_FINAL_MS);
    map.set(chatId, tid);

    stepLog.appendJSONL(perfil, 'virtus', {
      step: 'finalization_timer_started',
      chatId,
      startedAt,
      deadlineAt,
      telMasked: maskPhoneLog(tel),
      ts: Date.now()
    });
  } catch (e) {
    logger.warn('[FINALIZE] arm_timer erro', { perfil, chatId, error: (e && e.message) || e });
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
          if (browser && browser._robeActiveFor === nome) {
          } else {
            const allPages = await browser.pages();
            if (Array.isArray(allPages) && allPages.length > 1) {
              for (let i = allPages.length - 1; i >= 1; i--) {
                const p = allPages[i];
                try {
                  let u = '';
                  try { u = await p.url(); } catch {}
                  if (/facebook.com\/marketplace\/create\/item/i.test(u)) continue; // NUNCA fechar create item
                  try { await p.close({ runBeforeUnload:false }).catch(()=>{}); } catch {}
                } catch {}
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

  // Funções auxiliares para timer de coleta e SLA
  function getCollectTimerMap(perfil) {
    if (!collectTimers.has(perfil)) collectTimers.set(perfil, new Map());
    return collectTimers.get(perfil);
  }

  function getSlaWatchdogMap(perfil) {
    if (!slaWatchdogTimers.has(perfil)) slaWatchdogTimers.set(perfil, new Map());
    return slaWatchdogTimers.get(perfil);
  }

  function clearCollectTimer(perfil, chatId) {
    try {
      const m = getCollectTimerMap(perfil);
      if (m.has(chatId)) { clearTimeout(m.get(chatId)); m.delete(chatId); }
    } catch {}
  }

  function clearSlaWatchdog(perfil, chatId) {
    try {
      const m = getSlaWatchdogMap(perfil);
      if (m.has(chatId)) { clearTimeout(m.get(chatId)); m.delete(chatId); }
    } catch {}
  }

  async function scanAndProcessChats(nome) {
    // Guard de reentrância: nunca roda dois scans em paralelo para o mesmo perfil
    if (scanRunningByPerfil.get(nome)) {
      return; // Já está rodando
    }
    scanRunningByPerfil.set(nome, true);

    try {
      const p = await ensurePage().catch(()=>null);
      if (!p) {
        scanRunningByPerfil.set(nome, false);
        return;
      }

      try { await maybeGuaranteeMarketplaceFast(p, nome); } catch {}

      const lista = await coletaChatsMarketplaceTodos(p);
      if (!Array.isArray(lista) || !lista.length) {
        scanRunningByPerfil.set(nome, false);
        return;
      }

      for (const it of lista) {
        const chatId = String(it.id || '').trim();
        if (!chatId) continue;

        let fsmState = null;
        try { fsmState = virtusFSM.get(nome, chatId); } catch {}
        const now = Date.now();
        let finalLockUntil = fsmState && fsmState.freeze && fsmState.freeze.finalizationUntil ? Number(fsmState.freeze.finalizationUntil) : 0;
        let finalLocked = finalLockUntil > now;

        // Obtém schedule e openAt
        const schedule = fsmState && fsmState.schedule || {};
        const collectSchedule = schedule.collect || {};
        const openAt = Number(collectSchedule.openAt || 0);

        // BLINDAGEM: se openAt já existe (herdado/estado antigo) mas discoveredAt não existe, corrige para manter pipeline íntegro.
        if ((!fsmState || !fsmState.discoveredAt) && openAt > 0) {
          await virtusFSM.patch(nome, chatId, { discoveredAt: Date.now() });
          // Atualiza fsmState para refletir a mudança
          try { fsmState = virtusFSM.get(nome, chatId); } catch {}
          // Prossiga, não marque isNewChat true para não rearma/limpar timer.
        }

        // BLINDAGEM PARA NOVO CHAT: marca discoveredAt na detecção real e só uma vez,
        // NUNCA rearma o timer se já estiver marcado. Corrige bug de rearme eterno.
        const isNewChat = (!fsmState || !fsmState.discoveredAt) && !(openAt > 0);
        
        if (isNewChat) {
          stepLog.appendJSONL(nome, 'virtus', { step: 'chat_detected', chatId, ts: now });
          const timerOpenAt = now + 45000;
          await virtusFSM.patch(nome, chatId, {
            discoveredAt: now,
            schedule: {
              ...(schedule || {}),
              collect: { ...(collectSchedule || {}), openAt: timerOpenAt, startedAt: now }
            }
          });
          stepLog.appendJSONL(nome, 'virtus', { step: 'timer_start', chatId, openAt: timerOpenAt, ts: now });
          
          // Armamento idempotente, nunca rearma se já existe timer
          if (!getCollectTimerMap(nome).has(chatId)) {
            const delay = Math.max(0, timerOpenAt - Date.now());
            const timerId = setTimeout(() => {
              stepLog.appendJSONL(nome, 'virtus', { step: 'timer_fire', chatId, ts: Date.now() });
              clearSlaWatchdog(nome, chatId);
              const slaTimeout = 6 * 60 * 1000;
              const slaTimerId = setTimeout(() => {
                try {
                  const state = virtusFSM.get(nome, chatId);
                  const hasResponse = state && state.lastIARespondedAt && (Date.now() - state.lastIARespondedAt) < slaTimeout;
                  if (!hasResponse) {
                    stepLog.appendJSONL(nome, 'virtus', {
                      step: 'pending_sla_breach',
                      chatId,
                      timerFiredAt: timerOpenAt,
                      now: Date.now(),
                      elapsedMs: Date.now() - timerOpenAt,
                      hasResponse: false
                    });
                  }
                } catch {}
              }, slaTimeout);
              getSlaWatchdogMap(nome).set(chatId, slaTimerId);
            }, delay);
            getCollectTimerMap(nome).set(chatId, timerId);
          }
          continue;
        }

        // Verifica se há mensagem nova (detectada via mudança de cursor)
        // Isso será verificado mais abaixo, mas primeiro verifica se openAt já venceu
        if (openAt > 0 && now < openAt) {
          // Ainda dentro do timer, não processa coleta real
          continue;
        }

        // Se openAt venceu ou não existe, verifica se há mudança real
        // (isso será feito na lógica de coleta abaixo)

        // Early return pós-finalização (anti-loop pós-fechamento)
        if (fsmState && (fsmState.finalizado === true || (fsmState.finalization && fsmState.finalization.closingMessageQueued))) {
          stepLog.appendJSONL(nome, 'virtus', { step: 'skip_after_finalization', chatId });
          const historicoConversaEarly = await extrairHistoricoConversa(p).catch(() => []);
          const historicoSanEarly = sanitizeHistoricoRecords(historicoConversaEarly, "");
          const clientMsgsEarly = historicoSanEarly.filter(m => m && m.autor === 'cliente' && String(m.texto || '').trim());
          const lastClientTsEarly = clientMsgsEarly.length ? Number(clientMsgsEarly[clientMsgsEarly.length - 1].timestamp || 0) : 0;
          const clientCountEarly = clientMsgsEarly.length;
          const clientDigestEarly = clientCountEarly
            ? sha1(clientMsgsEarly.slice(-10).map(m => normalizeContent(m.texto || '')).join('|'))
            : '';
          function uniqSeqNormEarly(list) {
            const out = []; let prev = '';
            for (const m of (list || [])) {
              const t = normalizeContent(String(m && m.texto || ''));
              if (!t) continue;
              if (t !== prev) out.push(t);
              prev = t;
            }
            return out;
          }
          const semDigestArrEarly = uniqSeqNormEarly(clientMsgsEarly).slice(-10);
          const clientContentSigEarly = sha1(semDigestArrEarly.join('|'));
          await virtusFSM.patch(nome, chatId, {
            cursor: { client: { count: clientCountEarly, digest: clientDigestEarly, contentSig: clientContentSigEarly, lastTs: lastClientTsEarly } },
            lastScanAt: Date.now(), lastCLIts: lastClientTsEarly
          });
          continue;
        }

        // BARREIRA DE COLETA (45s): Só processa coleta real se openAt venceu ou não existe
        if (openAt > 0 && now < openAt) {
          // Ainda dentro do timer, não processa coleta real
          continue;
        }

        // Timer venceu ou não existe - processa coleta real
        if (openAt > 0) {
          stepLog.appendJSONL(nome, 'virtus', { step: 'timer_fire', chatId, openAt, now, ts: now });
          // Limpa timer quando consumir
          clearCollectTimer(nome, chatId);
          await virtusFSM.patch(nome, chatId, {
            schedule: {
              ...schedule,
              collect: {
                ...collectSchedule,
                openAt: 0
              }
            }
          });
        }

        stepLog.appendJSONL(nome, 'virtus', { step: 'collect_start', chatId, ts: now });

        // Abre chat e coleta histórico (coleta real)
        const urlNow = (typeof p.url === 'function') ? (p.url() || '') : '';
        if (!chatUrlMatches(urlNow, chatId)) {
          await openChatByClick(p, chatId, { timeoutMs: 8000, retries: 2 });
        }

        const historicoConversa = await extrairHistoricoConversa(p);
        // Deduplicação: nunca aceite mensagens "Nenhuma mensagem encontrada."
        const historicoFiltered = (historicoConversa || []).filter(m => {
          const texto = String(m && m.texto || '').trim();
          return texto && texto !== 'Nenhuma mensagem encontrada.';
        });
        const historicoSan = sanitizeHistoricoRecords(historicoFiltered, "");
        if (!Array.isArray(historicoSan) || !historicoSan.length) {
          const clientMsgsEmpty = [];
          const lastClientTsEmpty = 0;
          const clientCountEmpty = 0;
          const clientDigestEmpty = '';
          const clientContentSigEmpty = '';
          const lastClientNormEmpty = '';
          await virtusFSM.patch(nome, chatId, {
            cursor: { client: { count: clientCountEmpty, digest: clientDigestEmpty, contentSig: clientContentSigEmpty, lastTs: lastClientTsEmpty } },
            data: { ...(fsmState && fsmState.data || {}), lastClientNorm: lastClientNormEmpty, lastClientTs: lastClientTsEmpty || Date.now() },
            lastScanAt: now
          });
          continue;
        }

        // Deduplicação ultra forte no histórico gravado em disco
        await appendChatHistoryLog(nome, chatId, historicoSan);
        
        stepLog.appendJSONL(nome, 'virtus', { step: 'collect_done', chatId, historicoCount: historicoSan.length, ts: Date.now() });
        
        const clientMsgs = historicoSan.filter(m => m && m.autor === 'cliente' && String(m.texto || '').trim());
        const lastClientTs = clientMsgs.length ? Number(clientMsgs[clientMsgs.length - 1].timestamp || 0) : 0;

        // Se FECHADO e freeze válido, ignora e LOGA:
        if (finalLocked) {
          logger.info("Ignorado devido a bloqueio de 72h, chatId=" + chatId, { nomePerfil: nome, chatId, finalLockUntil });
          try {
            stepLog.appendJSONL(nome, 'virtus', { step: 'skip_locked_72h', chatId, finalLockUntil, ts: now });
            const clientCountLock = clientMsgs.length;
            const clientDigestLock = clientCountLock
              ? sha1(clientMsgs.slice(-10).map(m => normalizeContent(m.texto || '')).join('|'))
              : '';
            function uniqSeqNormLock(list) {
              const out = []; let prev = '';
              for (const m of (list || [])) {
                const t = normalizeContent(String(m && m.texto || ''));
                if (!t) continue;
                if (t !== prev) out.push(t);
                prev = t;
              }
              return out;
            }
            const semDigestArrLock = uniqSeqNormLock(clientMsgs).slice(-10);
            const clientContentSigLock = sha1(semDigestArrLock.join('|'));
            const lastClientNormLock = clientCountLock ? normalizeContent(clientMsgs[clientCountLock - 1].texto || '') : '';
            await virtusFSM.patch(nome, chatId, {
              cursor: { client: { count: clientCountLock, digest: clientDigestLock, contentSig: clientContentSigLock, lastTs: lastClientTs || 0 } },
              data: { ...(fsmState && fsmState.data || {}), lastClientNorm: lastClientNormLock, lastClientTs: lastClientTs || Date.now() },
              lastScanAt: now, lastCLIts: lastClientTs || 0
            });
          } catch {}
          continue;
        }

        // Auto-unlock depois do freeze:
        if (fsmState && fsmState.finalizado && !finalLocked) {
          try {
            await virtusFSM.patch(nome, chatId, {
              finalizado: false,
              finalization: Object.assign({}, fsmState.finalization || {}, { unlockedAt: now }),
              freeze: Object.assign({}, fsmState.freeze || {}, { finalizationUntil: 0 })
            });
            logger.info('[SCAN] auto_unlock_72h', { nome, chatId, ts: now });
            stepLog.appendJSONL(nome, 'virtus', { step: 'auto_unlock_72h', chatId, ts: now });
          } catch {}
          fsmState = virtusFSM.get(nome, chatId);
        }

        try {
          if (!fsmState || !fsmState.discoveredAt) {
            try {
              await virtusFSM.patch(nome, chatId, { discoveredAt: Date.now() });
            } catch {}
          }

          try {
            await armFinalizationTimerIfNeeded(nome, chatId, historicoSan, {});
          } catch {}

          // Filtra somente mensagens do cliente (sanitizadas)
          const clientMsgs = historicoSan.filter(m => m && m.autor === 'cliente' && String(m.texto || '').trim());

          // Janela de 8 horas
          const lastClientTs = clientMsgs.length ? Number(clientMsgs[clientMsgs.length - 1].timestamp || 0) : 0;
          if (!lastClientTs || (Date.now() - lastClientTs) > MAX_CHAT_AGE_MS) {
            try {
              const clientCountAge = clientMsgs.length;
              const clientDigestAge = clientCountAge
                ? sha1(clientMsgs.slice(-10).map(m => normalizeContent(m.texto || '')).join('|'))
                : '';
              function uniqSeqNormAge(list) {
                const out = []; let prev = '';
                for (const m of (list || [])) {
                  const t = normalizeContent(String(m && m.texto || ''));
                  if (!t) continue;
                  if (t !== prev) out.push(t);
                  prev = t;
                }
                return out;
              }
              const semDigestArrAge = uniqSeqNormAge(clientMsgs).slice(-10);
              const clientContentSigAge = sha1(semDigestArrAge.join('|'));
              const lastClientNormAge = clientCountAge ? normalizeContent(clientMsgs[clientCountAge - 1].texto || '') : '';
              await virtusFSM.patch(nome, chatId, {
                cursor: { client: { count: clientCountAge, digest: clientDigestAge, contentSig: clientContentSigAge, lastTs: lastClientTs || 0 } },
                data: { ...(fsmState && fsmState.data || {}), lastClientNorm: lastClientNormAge, lastClientTs: lastClientTs || Date.now() },
                lastScanAt: Date.now(),
                lastCLIts: lastClientTs || 0
              });
            } catch {}
            continue;
          }

          // Prefetch de localização (não bloqueia)
          try {
            let fsmState = null;
          try {
            fsmState = virtusFSM.get(nome, chatId);
          } catch {}
            if (!(fsmState && fsmState.cidade && fsmState.estado)) {
              await ensureLocationPrefetch(chatId);
            }
          } catch {}

          // Cursor determinístico do cliente: count + digest (últimas 10 mensagens normalizadas)
          const clientCount = clientMsgs.length;
          const clientDigest = clientCount
            ? sha1(clientMsgs.slice(-10).map(m => normalizeContent(m.texto || '')).join('|'))
            : '';
          const clientLastNorm = clientCount ? normalizeContent(clientMsgs[clientCount - 1].texto || '') : '';

          // Controle de mudança real do cliente (contentSig) - anti-loop por spam
          function uniqSeqNorm(list) {
            const out = []; let prev = '';
            for (const m of (list || [])) {
              const t = normalizeContent(String(m && m.texto || ''));
              if (!t) continue;
              if (t !== prev) out.push(t);
              prev = t;
            }
            return out;
          }
          const semDigestArr = uniqSeqNorm(clientMsgs).slice(-10);
          const clientContentSig = sha1(semDigestArr.join('|'));

          // Obtém cursor anterior do FSM
          let prevCount = 0;
          let prevDigest = '';
          let prevContentSig = '';
          try {
            let fsmState = null;
          try {
            fsmState = virtusFSM.get(nome, chatId);
          } catch {}
            prevCount = Number((fsmState && fsmState.cursor && fsmState.cursor.client && fsmState.cursor.client.count) || 0);
            prevDigest = String((fsmState && fsmState.cursor && fsmState.cursor.client && fsmState.cursor.client.digest) || '');
            prevContentSig = String((fsmState && fsmState.cursor && fsmState.cursor.client && fsmState.cursor.client.contentSig) || '');
          } catch {}

          const changed = !!clientContentSig && clientContentSig !== prevContentSig;

          try {
            logger.info('[SCAN] cursor_eval', { nome, chatId, prevCount, prevDigest, clientCount, clientDigest, changed });
            stepLog.appendJSONL(nome, 'virtus_scan', { phase: 'cursor_eval', chatId, prevCount, prevDigest, clientCount, clientDigest, changed, ts: Date.now() });
      } catch {}
      
          // Se há mudança (mensagem nova)
          if (changed) {
            if (openAt > 0 && now < openAt) {
              // Se ainda está dentro da primeira janela (já armada no chat_detected/msg_new_detected), só aguarda e NÃO rearma schedule.collect.openAt.
              stepLog.appendJSONL(nome, 'virtus', {
                step: 'msg_new_detected_defer_until_timer',
                chatId, openAt, now, clientContentSig, ts: now
              });
              await virtusFSM.patch(nome, chatId, {
                cursor: { client: { count: clientCount, digest: clientDigest, contentSig: clientContentSig, lastTs: lastClientTs } },
                data: { ...(fsmState && fsmState.data || {}), lastClientNorm: clientLastNorm, lastClientTs: lastClientTs || Date.now() },
                lastScanAt: now, lastCLIts: lastClientTs
              });
              continue;
            }
            // BLINDAGEM CRÍTICA: Se openAt === 0 (ou não existe), o timer já disparou (timer_fire).
            // NUNCA rearme schedule.collect.openAt aqui! Siga para schedule.llm (janela IA).
            // O pipeline deve fluir para IA → fila Messenger → resposta, SEM abrir nova espera de 45s.
          }
      
          if (!changed) {
            // Atualiza cursor no FSM
            try {
              await virtusFSM.patch(nome, chatId, {
                cursor: { client: { count: clientCount, digest: clientDigest, contentSig: clientContentSig, lastTs: lastClientTs } },
                data: { ...(fsmState && fsmState.data || {}), lastClientNorm: clientLastNorm, lastClientTs: lastClientTs || Date.now() },
                lastScanAt: Date.now(),
                lastCLIts: lastClientTs
              });
            } catch {}
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
          let lastClientNormPrev = '';
          try {
            let fsmState = null;
          try {
            fsmState = virtusFSM.get(nome, chatId);
          } catch {}
            lastClientNormPrev = String(((fsmState && fsmState.data && fsmState.data.lastClientNorm) || ''));
          } catch {}
          
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
            // Atualiza cursor no FSM
            try {
              await virtusFSM.patch(nome, chatId, {
                cursor: { client: { count: clientCount, digest: clientDigest, contentSig: clientContentSig, lastTs: lastClientTs } },
                data: { ...(fsmState && fsmState.data || {}), lastClientNorm: clientLastNorm, lastClientTs: lastClientTs || Date.now() },
                lastScanAt: Date.now(),
                lastCLIts: lastClientTs
              });
            } catch {}
            continue;
          }

          // Pipeline FSM: ingestFromVirtus
          try {
            logger.info('[SCAN] ingest_call', { nome, chatId, cCount: clientCount, cDigest: clientDigest });
            stepLog.appendJSONL(nome, 'virtus_scan', { phase: 'ingest_call', chatId, cCount: clientCount, cDigest: clientDigest, ts: Date.now() });
          } catch {}

          await virtusFSM.ingestFromVirtus(nome, chatId, {
            historico: historicoSan,
            novasMsgs: novasFiltradas,
            cursor: { count: clientCount, digest: clientDigest, contentSig: clientContentSig, lastTs: lastClientTs },
            contexto: {}
          });

          try {
            // ===== BARREIRA DE COLETA 45s: CICLO DE VIDA =====
            // Objetivo: Anti-spam, espera de mensagem real do cliente antes de chamar IA
            // 
            // Ciclo de vida:
            // 1. Após detectar changed === true para o chat, cria/atualiza em schedule.llm:
            //    - pendingSig: clientContentSig (signature do conteúdo atual)
            //    - collectUntil: lastClientTs + 45000ms (ou maior se já rodando janela)
            //    - anchorTs: lastClientTs (timestamp de referência)
            // 2. Se ainda está dentro da janela de coleta (Date.now() < collectUntil), não chama IA
            //    e apenas atualiza cursor/estado, logando "collect_wait_extend"
            // 3. Só roda IA se:
            //    - Date.now() >= schedule.llm.collectUntil
            //    - O signature (clientContentSig) não mudou desde o início da janela (pendingSig)
            // 4. Após IA rodar, zera a janela e registra:
            //    - lastConsumedSig = clientContentSig
            //    - inflightSig = null
            //    - pendingSig = null
            // 
            // Logs: stepLog deve registrar "collect_wait_start", "collect_wait_extend", "llm_call_start", "llm_call_end"
            // Motivo: Garantir que não chamamos IA para cada mensagem isolada, mas aguardamos 45s para coletar
            // todas as mensagens do cliente antes de processar. Isso reduz spam de chamadas IA e melhora
            // a qualidade da extração ao ter contexto completo.
            // ===================================================
            const stateBefore = virtusFSM.get(nome, chatId);
            const schedule = stateBefore && stateBefore.schedule || {};
            const collectSchedule = schedule.collect || {};
            const llmSchedule = schedule.llm || {};
            const now = Date.now();
            const COLLECT_WAIT_MS = 45000; // 45s
            
            // BLINDAGEM CRÍTICA: Verifica se já passou pelo timer_fire (openAt === 0 significa que timer já disparou)
            // Se alreadyWaited === true, NÃO reinicia nova espera de 45s, permite que IA rode imediatamente
            const alreadyWaited = !!(collectSchedule && collectSchedule.startedAt && Number(collectSchedule.openAt || 0) === 0);
            
            stepLog.appendJSONL(nome, 'virtus', {
              step: 'ingest_call_gate',
              chatId,
              alreadyWaited,
              openAt: Number(collectSchedule.openAt || 0),
              ts: now
            });
            
            // Verifica se está dentro da janela de coleta
            const collectUntil = Number(llmSchedule.collectUntil || 0);
            const pendingSig = String(llmSchedule.pendingSig || '');
            const anchorTs = Number(llmSchedule.anchorTs || 0);
            
            if (collectUntil > now && pendingSig === clientContentSig) {
              // Ainda dentro da janela de coleta, apenas atualiza cursor/estado
              stepLog.appendJSONL(nome, 'virtus', {
                step: 'collect_wait_extend',
                chatId,
                collectUntil,
                pendingSig,
                remainingMs: collectUntil - now
              });
              await virtusFSM.patch(nome, chatId, {
                cursor: { client: { count: clientCount, digest: clientDigest, contentSig: clientContentSig, lastTs: lastClientTs } },
                data: { ...(stateBefore && stateBefore.data || {}), lastClientNorm: clientLastNorm, lastClientTs: lastClientTs || Date.now() },
                lastScanAt: now,
                lastCLIts: lastClientTs
              });
              continue;
            }
            
            // Inicia ou estende janela de coleta se necessário
            // BLINDAGEM: Se alreadyWaited === true, newCollectUntil = now (sem nova espera de 45s)
            if (!llmSchedule.pendingSig || llmSchedule.pendingSig !== clientContentSig) {
              const newCollectUntil = alreadyWaited ? now : Math.max(collectUntil, lastClientTs + COLLECT_WAIT_MS);
              await virtusFSM.patch(nome, chatId, {
                schedule: {
                  ...schedule,
                  llm: {
                    pendingSig: clientContentSig,
                    collectUntil: newCollectUntil,
                    anchorTs: lastClientTs
                  }
                }
              });
              stepLog.appendJSONL(nome, 'virtus', {
                step: 'collect_wait_start',
                chatId,
                pendingSig: clientContentSig,
                collectUntil: newCollectUntil,
                anchorTs: lastClientTs,
                remainingMs: newCollectUntil - now
              });
              
              // Se ainda não passou a janela, apenas atualiza cursor e continua
              if (newCollectUntil > now) {
                await virtusFSM.patch(nome, chatId, {
                  cursor: { client: { count: clientCount, digest: clientDigest, contentSig: clientContentSig, lastTs: lastClientTs } },
                  data: { ...(stateBefore && stateBefore.data || {}), lastClientNorm: clientLastNorm, lastClientTs: lastClientTs || Date.now() },
                  lastScanAt: now,
                  lastCLIts: lastClientTs
                });
                continue;
              }
            }
            
            // Verifica se a signature mudou desde o início da janela
            if (llmSchedule.pendingSig && llmSchedule.pendingSig !== clientContentSig) {
              // Signature mudou, reinicia janela (mas não se já passou pelo timer_fire)
              const newCollectUntil = alreadyWaited ? now : (lastClientTs + COLLECT_WAIT_MS);
              await virtusFSM.patch(nome, chatId, {
                schedule: {
                  ...schedule,
                  llm: {
                    pendingSig: clientContentSig,
                    collectUntil: newCollectUntil,
                    anchorTs: lastClientTs
                  }
                }
              });
              stepLog.appendJSONL(nome, 'virtus', {
                step: 'collect_wait_restart',
                chatId,
                oldSig: llmSchedule.pendingSig,
                newSig: clientContentSig,
                collectUntil: newCollectUntil
              });
              
              if (newCollectUntil > now) {
                await virtusFSM.patch(nome, chatId, {
                  cursor: { client: { count: clientCount, digest: clientDigest, contentSig: clientContentSig, lastTs: lastClientTs } },
                  data: { ...(stateBefore && stateBefore.data || {}), lastClientNorm: clientLastNorm, lastClientTs: lastClientTs || Date.now() },
                  lastScanAt: now,
                  lastCLIts: lastClientTs
                });
                continue;
              }
            }
            
            // Passou a barreira de coleta, pode chamar IA
            
            // Blindagem: não chamar IA novamente para o mesmo conteúdo
            const nowTs = Date.now();
            const llmScheduleNow = (stateBefore && stateBefore.schedule && stateBefore.schedule.llm) || {};
            const lastConsumedSig = String(llmScheduleNow.lastConsumedSig || '');
            const lastAttemptSig = String(llmScheduleNow.lastAttemptSig || '');
            const lastAttemptAt  = Number(llmScheduleNow.lastAttemptAt || 0);
            const retryAfter     = Number(llmScheduleNow.retryAfter || 0);
            
            if (lastConsumedSig === clientContentSig) {
              stepLog.appendJSONL(nome, 'virtus', { step: 'llm_call_skip_already_consumed', chatId, sig: clientContentSig });
              await virtusFSM.patch(nome, chatId, {
                cursor: { client: { count: clientCount, digest: clientDigest, contentSig: clientContentSig, lastTs: lastClientTs } },
                data: { ...(stateBefore && stateBefore.data || {}), lastClientNorm: clientLastNorm, lastClientTs: lastClientTs || nowTs },
                lastScanAt: nowTs, lastCLIts: lastClientTs
              });
              continue;
            }
            
            if (retryAfter > nowTs && lastAttemptSig === clientContentSig) {
              stepLog.appendJSONL(nome, 'virtus', {
                step: 'llm_call_skip_retry_window', chatId, sig: clientContentSig, retryAfter, remainingMs: retryAfter - nowTs
              });
              await virtusFSM.patch(nome, chatId, {
                cursor: { client: { count: clientCount, digest: clientDigest, contentSig: clientContentSig, lastTs: lastClientTs } },
                data: { ...(stateBefore && stateBefore.data || {}), lastClientNorm: clientLastNorm, lastClientTs: lastClientTs || nowTs },
                lastScanAt: nowTs, lastCLIts: lastClientTs
              });
              continue;
            }
            
            if (lastAttemptSig === clientContentSig && (nowTs - lastAttemptAt) < LLM_ATTEMPT_TTL_MS) {
              stepLog.appendJSONL(nome, 'virtus', {
                step: 'llm_call_skip_recent_attempt', chatId, sig: clientContentSig, lastAttemptAt, elapsedMs: nowTs - lastAttemptAt
              });
              await virtusFSM.patch(nome, chatId, {
                cursor: { client: { count: clientCount, digest: clientDigest, contentSig: clientContentSig, lastTs: lastClientTs } },
                data: { ...(stateBefore && stateBefore.data || {}), lastClientNorm: clientLastNorm, lastClientTs: lastClientTs || nowTs },
                lastScanAt: nowTs, lastCLIts: lastClientTs
              });
              continue;
            }
            
            // Lock por chat/inflightSig na chamada da IA, para impedir qualquer token/consulta duplicada
            const lockAcquired = await chatLock.acquire(nome, chatId, 30000); // 30s timeout
            if (!lockAcquired) {
              stepLog.appendJSONL(nome, 'virtus', {
                step: 'llm_call_skip_lock',
                chatId,
                reason: 'lock_not_acquired',
                ts: Date.now()
              });
              // Atualiza cursor e continua
              await virtusFSM.patch(nome, chatId, {
                cursor: { client: { count: clientCount, digest: clientDigest, contentSig: clientContentSig, lastTs: lastClientTs } },
                data: { ...(stateBefore && stateBefore.data || {}), lastClientNorm: clientLastNorm, lastClientTs: lastClientTs || Date.now() },
                lastScanAt: Date.now(),
                lastCLIts: lastClientTs
              });
              continue;
            }

            let llmRes = null;
            const llmStartAt = Date.now();
            
            try {
              // Atualiza inflightSig, lastAttemptSig, lastAttemptAt antes de chamar IA
              await virtusFSM.patch(nome, chatId, {
                schedule: {
                  ...schedule,
                  llm: {
                    ...llmSchedule,
                    inflightSig: clientContentSig,
                    lastAttemptSig: clientContentSig,
                    lastAttemptAt: Date.now(),
                    retryAfter: 0
                  }
                }
              });

              stepLog.appendJSONL(nome, 'virtus', {
                step: 'llm_call_start',
                chatId,
                pendingSig: clientContentSig,
                inflightSig: clientContentSig,
                ts: Date.now()
              });
              
              llmRes = await masterExtractAnswer({ perfil: nome, chatId, mensagens: historicoSan, contexto: {}, respond: true });
            
              stepLog.appendJSONL(nome, 'virtus', {
                step: 'llm_call_end',
                chatId,
                consumedSig: clientContentSig,
                tookMs: llmRes.meta && llmRes.meta.tookMs || null,
                ts: Date.now()
              });
              
              // Após IA rodar com sucesso, zera a janela e registra lastConsumedSig
              await virtusFSM.patch(nome, chatId, {
                schedule: {
                  ...schedule,
                  llm: {
                    lastConsumedSig: clientContentSig,
                    inflightSig: null,
                    pendingSig: null,
                    collectUntil: 0,
                    anchorTs: 0,
                    retryAfter: 0,
                    lastAttemptSig: clientContentSig,
                    lastAttemptAt: Date.now()
                  }
                }
              });
            } catch (e) {
              stepLog.appendJSONL(nome, 'virtus', { step: 'llm_call_error', chatId, error: (e && e.message) || String(e), ts: Date.now() });
              
              // Em caso de erro, define retryAfter para evitar flood
              await virtusFSM.patch(nome, chatId, {
                schedule: {
                  ...schedule,
                  llm: {
                    ...(llmSchedule || {}),
                    inflightSig: null,
                    lastAttemptSig: clientContentSig,
                    lastAttemptAt: Date.now(),
                    retryAfter: Date.now() + LLM_RETRY_BACKOFF_MS
                  }
                }
              });
              
              throw e;
            } finally {
              // Sempre libera o lock
              try {
                chatLock.release(nome, chatId);
              } catch {}
            }

            // A PARTIR DAQUI, use SEMPRE llmRes, nunca "llm"
            if (!llmRes) {
              stepLog.appendJSONL(nome, 'virtus', { step: 'llm_result_missing', chatId, ts: Date.now() });
              continue;
            }

            // Persistência da extração (para finalização futura e consistência)
            const mergedData = Object.assign({}, stateBefore.data || {}, { extraction: llmRes.extraction || {} });
            virtusFSM.patch(nome, chatId, { data: mergedData });
            
            // Logs ultra detalhados de ciclo
            appendMasterJSONL(nome, chatId, {
              kind: 'master_request',
              systemPromptLength: llmRes.meta && llmRes.meta.systemPromptLength || null,
              tokens: llmRes.meta && llmRes.meta.tokens || null,
              tookMs: llmRes.meta && llmRes.meta.tookMs || null
            });

            // Log apenas com campos permitidos: localizacao, whatsapp, item, endereco_saida, endereco_destino
            const extractionLog = {};
            if (llmRes.extraction) {
              if (llmRes.extraction.telefone) extractionLog.telefone = llmRes.extraction.telefone;
              if (llmRes.extraction.item) extractionLog.item = llmRes.extraction.item;
              if (llmRes.extraction.endereco_saida) extractionLog.endereco_saida = llmRes.extraction.endereco_saida;
              if (llmRes.extraction.endereco_destino) extractionLog.endereco_destino = llmRes.extraction.endereco_destino;
            }
            appendMasterJSONL(nome, chatId, { kind: 'master_cycle', extraction: extractionLog, control: llmRes.control, tookMs: llmRes.meta && llmRes.meta.tookMs });

            // Detectar se os 4 campos obrigatórios estão completos: whatsapp, item, endereco_saida, endereco_destino
            const extraction = llmRes.extraction || {};
            const tel = String(extraction.telefone || '').trim();
            const hasWhatsApp = isValidBRPhoneWithDDD(tel);
            const hasItem = !!(extraction.item && String(extraction.item).trim());
            const hasSaida = !!(extraction.endereco_saida && String(extraction.endereco_saida).trim());
            const hasDestino = !!(extraction.endereco_destino && String(extraction.endereco_destino).trim());

            if (hasWhatsApp && hasItem && hasSaida && hasDestino) {
              // Campos completos - finalizar imediatamente, NÃO enfileirar resposta da IA
              stepLog.appendJSONL(nome, 'virtus', { step: 'auto_finalize_all_fields_complete', chatId });
              await finalizePedido(nome, chatId, {});
              continue;
            }

            const shouldAnswer = !!(llmRes && llmRes.control && llmRes.control.shouldReply);
            let reply = (llmRes && llmRes.answer) ? String(llmRes.answer) : null;

            // Anti-eco reforçado
            const lastClient = (novasFiltradas && novasFiltradas.length) ? novasFiltradas[novasFiltradas.length - 1] : null;
            if (reply && lastClient && lastClient.texto) {
              reply = antiEchoReply(reply, lastClient.texto);
            }

            if (shouldAnswer && reply) {
              // Debounce por askField - anti-pergunta repetida
              const DEBOUNCE_MS = parseInt(process.env.VIRTUS_ASK_DEBOUNCE_MS || '45000', 10);
              const askField = (llmRes && llmRes.control && llmRes.control.askField) || null;
              const stateBeforeDebounce = virtusFSM.get(nome, chatId);
              const lastAskedField = (stateBeforeDebounce && stateBeforeDebounce.schedule && stateBeforeDebounce.schedule.lastAskedField) || null;
              const lastAskedAt = (stateBeforeDebounce && stateBeforeDebounce.schedule && stateBeforeDebounce.schedule.lastAskedAt) || 0;
              if (askField && lastAskedField === askField && (Date.now() - lastAskedAt) < DEBOUNCE_MS) {
                stepLog.appendJSONL(nome, 'virtus', { step: 'ask_debounce_skip', chatId, askField, sinceMs: Date.now() - lastAskedAt });
                await virtusFSM.patch(nome, chatId, {
                  cursor: { client: { count: clientCount, digest: clientDigest, contentSig: clientContentSig, lastTs: lastClientTs } }
                });
                continue;
              }

              const cursorSig = `${clientCount}|${clientDigest}`;
              const earliest = virtusFSM.computeEarliestSendAt ? virtusFSM.computeEarliestSendAt(nome, chatId, { origin: 'reply', lastClientTs }) : undefined;

              await virtusFSM.ackQueued(nome, chatId, cursorSig);
              
              const queueResult = await queueMessengerSend(nome, {
                chatId,
                resposta: reply,
                key: `master|${chatId}|${sha1(reply)}|${Date.now()}`,
                earliestSendAt: earliest,
                origin: 'replyReady',
                cursorSig,
                lastClientTsOverride: lastClientTs
              });
              
              stepLog.appendJSONL(nome, 'virtus', {
                step: 'reply_enqueued',
                chatId,
                status: queueResult && queueResult.status || 'unknown',
                earliestSendAt: earliest || null,
                cursorSig,
                ts: Date.now()
              });
              
              // NUNCA ackSent aqui.
              if (queueResult && queueResult.status === 'enqueued') {
                appendMasterJSONL(nome, chatId, { kind: 'master_enqueued', replySize: reply.length, earliestSendAt: earliest || null, cursorSig });
              }
              // Atualiza lastAskedField e lastAskedAt no FSM
              if (askField) {
                await virtusFSM.patch(nome, chatId, {
                  schedule: { ...(stateBeforeDebounce && stateBeforeDebounce.schedule || {}), lastAskedField: askField, lastAskedAt: Date.now() }
                });
              }
              
              // Log ciclo final: atendido/respondido
              stepLog.appendJSONL(nome, 'virtus', {
                step: 'ciclo_final',
                chatId,
                status: 'respondido',
                hasReply: !!reply,
                askField: askField || null,
                ts: Date.now()
              });
            } else {
              // Log ciclo final: atendido mas sem resposta
              stepLog.appendJSONL(nome, 'virtus', {
                step: 'ciclo_final',
                chatId,
                status: 'atendido',
                hasReply: false,
                shouldReply: shouldAnswer,
                ts: Date.now()
              });
            }
          } catch (e) {
            logger.error('[MASTER] cycle error', { nome, chatId, error: (e&&e.message)||e });
            appendMasterJSONL(nome, chatId, { kind: 'master_error', error: (e&&e.message)||String(e) });
            stepLog.appendJSONL(nome, 'virtus', {
              step: 'ciclo_final',
              chatId,
              status: 'erro',
              error: (e&&e.message)||String(e),
              ts: Date.now()
            });
          }

        } catch (e) {
          logger.warn('[SCAN] Falha ao processar chat', { nome, chatId, error: (e && e.message) || String(e) });
        }
      }
    } catch (e) {
      logger.warn('[SCAN] erro geral', { nome, error: (e && e.message) || String(e) });
    } finally {
      // Sempre libera o guard de reentrância
      scanRunningByPerfil.set(nome, false);
    }
  }

  // REMOVIDO: timersFechamento, dadosColetados, pedidosEnviados, enviarPedidoParaNotificador, enviarMensagemFinal
  // Toda lógica de business agora gerenciada pelo virtusFSM


  async function ensureLocationPrefetch(chatId) {
    try {
      const man = await manifestStore.read(nome).catch(()=>null);
      const cidade = man && man.cidade || null;
      const estado = man && man.estado || null;
      if (cidade) {
        await virtusFSM.patch(nome, chatId, { cidade, estado });
      }
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
          // Prefetch de localização do manifest
          ensureLocationPrefetch(chatId).catch(() => {});
        }
        await installChatFeedObserver(p, nome, onNewChatDetected);

        // [REMOVIDO: Handler de localização — localização vem do manifest]
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
      let attempts = 0;
      let urlNow = '';
      let hasComposer = false;
      
      for (let attempt = 1; attempt <= MAX_TRIES; attempt++) {
        attempts = attempt;
        let p = await ensurePage().catch(() => null);
        if (!p) {
          lastErr = new Error('page_unavailable');
          if (attempt === MAX_TRIES) break;
          await new Promise(r => setTimeout(r, 600 + Math.floor(Math.random() * 400)));
          continue;
        }
        
        try {
          try {
            urlNow = (p && typeof p.url === 'function') ? (p.url() || '') : '';
            const okChat = chatUrlMatches(urlNow, chatId);
            let campo = null;
            hasComposer = false;
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
              // Log send_ok
              virtusFSM.flowLog(nome, chatId, 'send_ok', {
                attempts: attempt,
                url: urlNow,
                hasComposer: true,
                cursorSig: ''
              });
              return true;
            }
          } catch {}
          
          
          urlNow = (typeof p.url === 'function') ? (p.url() || '') : '';
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
          
          hasComposer = true;
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
          
          // Log send_ok
          virtusFSM.flowLog(nome, chatId, 'send_ok', {
            attempts: attempt,
            url: urlNow,
            hasComposer: true,
            cursorSig: ''
          });
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
        const reason = msgErr.includes('composer') ? 'composer_not_found' : (msgErr.includes('context') ? 'context_mismatch' : 'other');
        // Log error_send
        try {
          let fsmState = null;
          try {
            fsmState = virtusFSM.get(nome, chatId);
          } catch {}
          virtusFSM.flowLog(nome, chatId, 'error_send', {
            reason: reason,
            attempts: attempts,
            url: urlNow,
            hasComposer: hasComposer,
            cursorSig: '',
            snapshot: {
              freeze: (fsmState && fsmState.freeze) || {},
              schedule: (fsmState && fsmState.schedule) || {}
            }
          });
        } catch {}
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
        await virtusFSM.patch(nome, chatId, { lastIARespondedAt: Date.now() });
      } catch (e) {
        logger.error('[VIRTUS] marcarRespondido error', { nome, chatId, error: e && e.message || e });
      }
    }
    
        // Callback de URL para logging diários, nunca depende de ensurePage diretamente
        const getUrlNowFn = async () => {
          try {
            const p = await ensurePage().catch(() => null);
            return (p && typeof p.url === 'function') ? (p.url() || '') : '';
          } catch {
            return '';
          }
        };
        iniciarFilaEnvioMessenger(nome, enviarRespostaMessengerSeguraLocal, marcarRespondidoLocal, getUrlNowFn);
        
        // Inicializa o worker da fila persistente do notificador para o perfil
        notifierQueue.ensureWorker(nome, {
          url: NOTIFICADOR_URL,
          servidor: NOTIFICADOR_SERVIDOR,
          logger,
          stepLog,
          onJobOk: async (perfilCb, job) => {
            if (job && job.kind === 'pedido') {
              try { 
                await markPedidoSent(perfilCb, job.payload.chat_id, job.payload, 'virtus_finalizacao');
              } catch (e) {
                logger.warn('[NOTIFIER_QUEUE] markPedidoSent fail', { perfil: perfilCb, chatId: job && job.payload && job.payload.chat_id, error: e && e.message || e });
              }
            }
          }
        });
      // REMOVIDO: bindPedidosEventsIfNeeded - toda orquestração agora via virtusFSM
    } catch (e) {
      logger.warn('[NOTIFICADOR] falha init filas/handshake (modo legado)', { nome, error: e && e.message || e });
    }
    
    // REMOVIDO: resumeTimers - timers agora gerenciados pelo virtusFSM
    
    // Varredura contínua e imediata (sem locks de atendimento)
    setInterval(() => scanAndProcessChats(nome), SCAN_INTERVAL_MS);
    scanAndProcessChats(nome);
  }

  runner();

  return {
    stop: async () => {
      stepLog.appendJSONL(nome, 'virtus', { attempt: attId, step: 'stop' });
      running = false;
      
      // Limpeza de timers/intervalos órfãos
      const tPoll = pollingIntervals.get(nome);
      if (tPoll) { clearInterval(tPoll); pollingIntervals.delete(nome); }
      const tFila = filaEnvioTimers.get(nome);
      if (tFila) { clearInterval(tFila); filaEnvioTimers.delete(nome); }
      
      // Para o worker da fila persistente do notificador
      notifierQueue.stopWorker(nome);
      
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
  startVirtus,
  markPedidoSent
};