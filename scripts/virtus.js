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
const audit = stepLog.audit;
const chatLock = require('./chatLock.js');
const logger = require('./logger.js');
const manifestStore = require('./manifestStore.js');
const { acquireFileLock, releaseFileLock } = require('./manifestStore.js');
const { masterExtractAnswer } = require('./inteligenciaArtificial.js');
const chatStateStore = require('./chatStateStore.js');
const notifierQueue = require('./notifierQueue.js');
const fetch = global.fetch || require('node-fetch');

// Mutex de navegação por perfil
const NAV_LOCKS = new Map();
const NAV_LOCK_START_TIMES = new Map(); // perfil -> startTime
const NAV_LOCK_RELEASES = new Map(); // perfil -> release function
async function withNavLock(perfil, fn) {
  if (!NAV_LOCKS.has(perfil)) NAV_LOCKS.set(perfil, Promise.resolve());
  const prev = NAV_LOCKS.get(perfil);
  let release;
  const ticket = new Promise(res => (release = res));
  NAV_LOCKS.set(perfil, prev.then(() => ticket));
  const t0 = Date.now();
  NAV_LOCK_START_TIMES.set(perfil, t0);
  NAV_LOCK_RELEASES.set(perfil, release);
  audit(perfil, 'virtus', 'info', 'navlock_acquire', { ts: t0 });
  try {
    await prev;
    return await fn();
  } finally {
    release();
    const took = Date.now() - t0;
    audit(perfil, 'virtus', 'info', 'navlock_release', { tookMs: took });
    NAV_LOCK_START_TIMES.delete(perfil);
    NAV_LOCK_RELEASES.delete(perfil);
    if (NAV_LOCKS.get(perfil) === ticket) NAV_LOCKS.delete(perfil);
  }
}

// Guardião NAV_INTENT para permitir clique somente dentro de job válido
const NAV_INTENT = new Map();
function setNavIntent(perfil, intent) {
  if (!intent) { NAV_INTENT.delete(perfil); return; }
  NAV_INTENT.set(perfil, { ...intent, setAt: Date.now() });
}
function getNavIntent(perfil) {
  return NAV_INTENT.get(perfil) || null;
}

// processQueueByPerfil e enqueueProcess removidos - agora usando fila única em disco

// REMOVIDO: MinHeap, sendHeapByPerfil, heapKeyByChat - agora usando filas em disco

function clearAllChatJobs(perfil, chatId) {
  try { deleteJob(perfil, 'send', chatId); } catch {}
  try { deleteJob(perfil, 'collect', chatId); } catch {}
  try { clearFinalizationTimer(perfil, chatId); } catch {}
  try {
    const mapAg = aguardTimers.get(perfil);
    if (mapAg && mapAg.has(chatId)) { clearTimeout(mapAg.get(chatId)); mapAg.delete(chatId); }
    const setAg = aguardandoRespostaMap.get(perfil);
    if (setAg) setAg.delete(chatId);
  } catch {}
  try {
    const pend = pendingKeysPorPerfil.get(perfil);
    if (pend) {
      for (const k of Array.from(pend)) if (k.startsWith(chatId + '||') || k.includes('|' + chatId + '|')) pend.delete(k);
    }
  } catch {}
}

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
  ackQueued(perfil, chatId, cursorSig) {
    try {
      const s = chatStateStore.get(perfil, chatId) || {};
      const cur = s.cursor || {};
      const ia  = cur.ia || {};
      ia.queuedSig = String(cursorSig || '');
      return chatStateStore.patch(perfil, chatId, { cursor: { ...(cur||{}), ia } });
    } catch {
      return true;
    }
  },
  ackSent(perfil, chatId, cursorSig) {
    const s = chatStateStore.get(perfil, chatId);
    const cur = s.cursor || {};
    const ia  = cur.ia || {};
    ia.sentSig   = String(cursorSig || '');
    if (ia.queuedSig && ia.queuedSig === ia.sentSig) ia.queuedSig = '';
    return chatStateStore.patch(perfil, chatId, { cursor: { ...(cur||{}), ia } });
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

function sanitizeFeedPreview(s) {
  try {
    let t = String(s || '')
      .normalize('NFD').replace(/[\u0300-\u036f]/g,'')
      .toLowerCase();

    t = t.replace(/\b(agora|just\s*now|now|hoje|ontem|yesterday)\b/g, ' ');
    t = t.replace(/\b\d{1,2}:\d{2}\b/g, ' ');
    t = t.replace(/\b\d+\s*(s|seg|sec|secs?|seconds?|min|mins?|minute|minuto|minutos|h|hora|horas|d|dia|dias|sem|semana|semanas|week|weeks)\b/g, ' ');
    t = t.replace(/\b(voce:|v[oó]ce:|you:)\b/g, ' ');
    t = t.replace(/\b(voce\s+enviou|you\s+sent)\b/g, ' ');
    t = t.replace(/\b(mensagem\s+nao\s+lida)\b/g, ' ');
    t = t.replace(/\b(inserir|carregando\.\.\.|carregando)\b/g, ' ');
    t = t.replace(/\b(enviado|enviada|delivered|visto|visualizado|lida|seen)\b/g, ' ');
    t = t.replace(/[·•]/g, ' ');
    t = t.replace(/\s+/g, ' ').trim();
    return t;
  } catch {
    return String(s || '').trim();
  }
}

function isActionableFeedPreview(preview) {
  try {
    const n = sanitizeFeedPreview(preview || '');
    if (!n) return false;
    // Detecta ruídos comuns do preview do Marketplace (não aciona timers)
    if (/^marketplace\b/.test(n) && /\bnao\s+lidas?\b/.test(n)) return false;
    if (/^marketplace\b$/.test(n)) return false;
    return true;
  } catch {
    return true;
  }
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

  // Ruído mesmo no meio do texto
  if (/\b(carregando|carregando\.\.\.|inserir)\b/.test(t)) return true;
  if (/\b(voce:|v[oó]ce:|you:)\b/.test(t)) return true;
  if (/\b(voce\s+enviou|you\s+sent)\b/.test(t)) return true;
  if (/\b(mensagem\s+nao\s+lida)\b/.test(t)) return true;
  if (/\b(enviado|enviada|sent|delivered|visto|visualizado|lida|seen)\b/.test(t)) return true;
  if (/\b(hoje|ontem)\b/.test(t) && t.length <= 40) return true;
  if (/[·•]/g.test(s)) return true;
  if (/^\d{1,2}:\d{2}$/.test(t)) return true;

  // Lixos comuns do Messenger/Marketplace
  if (t === 'inserir') return true;
  if (t.startsWith('mensagem nao lida')) return true;
  if (/^\s*[·•]\s*$/.test(s)) return true;                 // bullet solto
  if (/^\W+$/.test(s)) return true;                        // só sinais
  // Marcas do cabeçalho "Conveniente …" (curtas)
  if (/\bconveniente\b/.test(t) && t.length <= 80) return true;

  // Linhas curtas com tempo relativo, sem conteúdo semântico
  if (/\b(min|mins?|minuto|minutos|hora|horas|day|days|dia|dias)\b/.test(t) && t.length <= 40) return true;

  return false;
}

function semanticallyRelevant(m) {
  try {
    if (!m || !m.texto) return false;
    const t = normalizeContent(String(m.texto || ''));
    if (!t) return false;

    // Mensagem do cliente é relevante exceto ruído explícito
    if (isNoiseNorm(t)) return false;

    // Sempre considerar relevante qualquer texto digitado pelo cliente
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

// REMOVIDO: installChatFeedObserver - não mais utilizado


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

async function ensureFinalClosingMessage(perfil, chatId, reason = '') {
  try {
    let st = null; try { st = virtusFSM.get(perfil, chatId); } catch {}
    const alreadyQueued = st && st.finalization && st.finalization.closingMessageQueued;
    if (alreadyQueued) {
      try { stepLog.appendJSONL(perfil, 'virtus', { step: 'finalize_closing_message_already', chatId, reason }); } catch {}
      return false;
    }
    const finalMsg = pickFinalMessageFromFile();
    const q = await queueMessengerSend(perfil, {
      chatId,
      resposta: finalMsg,
      key: `finalize_msg|${chatId}|${sha1(finalMsg)}|${Date.now()}`,
      origin: 'finalize'
    });
    const now = Date.now();
    const lockUntil = now + FINALIZACAO_FREEZE_MS;
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
    // REMOVIDO: clearFinalizationTimer e clearAllChatJobs - send final NUNCA deve ser apagado
    try { stepLog.appendJSONL(perfil, 'virtus', { step: 'finalize_closing_message_enqueued', chatId, origin: 'finalize', qStatus: q && q.status || 'unknown', reason }); } catch {}
    audit(perfil, 'virtus', 'info', 'finalize_closing_msg_enqueued', { chatId, reason });
    return true;
  } catch (e) {
    try { stepLog.appendJSONL(perfil, 'virtus', { step: 'finalize_closing_message_error', chatId, error: (e && e.message) || String(e), reason }); } catch {}
    return false;
  }
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

// === Helpers de filas em disco (coleta e envio) ===
function queuesBaseDir(perfil) {
  return path.join(__dirname, '..', 'dados', 'perfis', String(perfil || 'default'), 'queues');
}

// Fila única de jobs em disco
function jobQueueDir(perfil) {
  const d = path.join(queuesBaseDir(perfil), 'jobs');
  try { fsRaw.mkdirSync(d, { recursive: true }); } catch {}
  return d;
}

function jobPath(perfil, kind, chatId) {
  return path.join(jobQueueDir(perfil), `${kind}_${chatId}.json`);
}

function listJobs(perfil) {
  const dir = jobQueueDir(perfil);
  try {
    return fsRaw.readdirSync(dir).filter(f => f.endsWith('.json')).map(f => path.join(dir, f));
  } catch { return []; }
}

function loadJob(file) {
  try { return JSON.parse(fsRaw.readFileSync(file, 'utf8')); } catch { return null; }
}

async function enqueueJob(perfil, job) {
  const file = jobPath(perfil, job.kind, job.chatId);
  const lockPath = file + '.lck';
  let fd = null;
  try {
    fd = acquireFileLock(lockPath);
    const exists = fsRaw.existsSync(file);
    let finalDueAt;
    const isFast = !!(job.payload && job.payload.fast);
    if (exists) {
      // merge devido: mantém earliest dueAt, mescla as payloads
      const cur = JSON.parse(fsRaw.readFileSync(file, 'utf8'));
      const targetDue = Math.min(Number(cur.dueAt || job.dueAt), job.dueAt);
      if (!isFast && !(cur.payload && cur.payload.fast)) {
        const guard = Date.now() + MIN_REQUEUE_MS;
        finalDueAt = Math.max(targetDue, guard);
      } else {
        finalDueAt = Math.max(targetDue, Date.now() + 100);
      }
      cur.dueAt = finalDueAt;
      cur.payload = Object.assign({}, cur.payload || {}, job.payload || {});
      await writeJsonAtomicFsyncStrict(file, cur);
    } else {
      const targetDue = Number(job.dueAt);
      if (!isFast) {
        const guard = Date.now() + MIN_REQUEUE_MS;
        finalDueAt = Math.max(targetDue, guard);
      } else {
        finalDueAt = Math.max(targetDue, Date.now() + 100);
      }
      job.dueAt = finalDueAt;
      await writeJsonAtomicFsyncStrict(file, job);
    }
    if (finalDueAt > job.dueAt && !isFast) {
      stepLog.appendJSONL(perfil, 'virtus', { step: 'job_due_guard', kind: job.kind, chatId: job.chatId, original: job.dueAt, guarded: finalDueAt, ts: Date.now() });
    }
    if (isFast) {
      audit(perfil, 'virtus', 'info', 'job_enqueued_fast', { kind: job.kind, chatId: job.chatId, dueAt: new Date(finalDueAt).toISOString(), origin: job.payload?.origin||'' });
    } else {
      audit(perfil, 'virtus', 'info', 'job_enqueued', { kind: job.kind, chatId: job.chatId, dueAt: new Date(finalDueAt).toISOString(), origin: job.payload?.origin||'' });
    }
  } finally { 
    try { releaseFileLock(lockPath, fd); } catch {} 
  }
}

async function rescheduleJob(perfil, kind, chatId, nextDueAt, payloadMerge = {}) {
  const file = jobPath(perfil, kind, chatId);
  const lockPath = file + '.lck';
  let fd = null;
  try {
    fd = acquireFileLock(lockPath);
    const exists = fsRaw.existsSync(file);
    const cur = exists ? JSON.parse(fsRaw.readFileSync(file, 'utf8')) : { kind, chatId, dueAt: Number(nextDueAt), payload: {} };
    const isFast = !!(payloadMerge && payloadMerge.fast) || !!(cur.payload && cur.payload.fast);
    if (!isFast) {
      const guard = Date.now() + MIN_REQUEUE_MS;
      cur.dueAt = Math.max(Number(nextDueAt), guard);
    } else {
      cur.dueAt = Math.max(Number(nextDueAt), Date.now() + 100);
    }
    cur.payload = Object.assign({}, cur.payload || {}, payloadMerge || {});
    await writeJsonAtomicFsyncStrict(file, cur);
    if (cur.dueAt > nextDueAt && !isFast) {
      stepLog.appendJSONL(perfil, 'virtus', { step: 'job_due_guard', kind, chatId, original: nextDueAt, guarded: cur.dueAt, ts: Date.now() });
    }
    audit(perfil, 'virtus', 'info', 'job_rescheduled', { kind, chatId, dueAt: new Date(cur.dueAt).toISOString(), payloadKeys: Object.keys(cur.payload||{}).join(','), fast: isFast });
  } catch (e) {
    audit(perfil, 'virtus', 'error', 'job_reschedule_error', { kind, chatId, error: (e && e.message) || String(e) });
  } finally { 
    try { releaseFileLock(lockPath, fd); } catch {} 
  }
}

function deleteJob(perfil, kind, chatId) {
  const file = jobPath(perfil, kind, chatId);
  try { if (fsRaw.existsSync(file)) fsRaw.unlinkSync(file); } catch {}
}

function pickNextSend(perfil, now) {
  const jobs = listJobs(perfil).filter(f => path.basename(f).startsWith('send_'));
  let best = null, bestFile = null;
  for (const f of jobs) {
    const j = loadJob(f);
    if (!j) continue;
    if (Number(j.dueAt || 0) <= now) {
      if (!best) {
        best = j;
        bestFile = f;
      } else {
        const bestDue = Number(best.dueAt || 0);
        const jDue = Number(j.dueAt || 0);
        if (jDue < bestDue) {
          best = j;
          bestFile = f;
        } else if (jDue === bestDue) {
          // Desempate por queuedAt (FIFO)
          const bestQueued = Number(best.payload && best.payload.queuedAt || 0);
          const jQueued = Number(j.payload && j.payload.queuedAt || 0);
          if (jQueued > 0 && (bestQueued === 0 || jQueued < bestQueued)) {
            best = j;
            bestFile = f;
          }
        }
      }
    }
  }
  return best ? { job: best, file: bestFile } : null;
}

function pickNextCollect(perfil, now) {
  const jobs = listJobs(perfil).filter(f => path.basename(f).startsWith('collect_'));
  let best = null, bestFile = null;
  for (const f of jobs) {
    const j = loadJob(f);
    if (!j) continue;
    if (Number(j.dueAt || 0) <= now) {
      if (!best || Number(j.dueAt) < Number(best.dueAt)) { best = j; bestFile = f; }
    }
  }
  return best ? { job: best, file: bestFile } : null;
}

async function readJsonIfExists(file) {
  try {
    if (!fsRaw.existsSync(file)) return null;
    const txt = await fs.readFile(file, 'utf8').catch(()=>null);
    if (!txt) return null;
    return JSON.parse(txt);
  } catch { return null; }
}

async function writeJsonAtomic(file, obj) {
  return writeJsonAtomicFsyncStrict(file, obj);
}

async function deleteFileIfExists(file) {
  try { if (fsRaw.existsSync(file)) fsRaw.unlinkSync(file); } catch {}
}

function listJsonFilesSync(dir, prefix) {
  try {
    const all = fsRaw.readdirSync(dir);
    return all.filter(fn => fn.startsWith(prefix) && fn.endsWith('.json')).map(fn => path.join(dir, fn));
  } catch { return []; }
}

async function markPedidoSent(perfil, chatId, payload, source) {
  const file = pedidoSentFile(perfil, chatId);
  const rec = { sentAt: Date.now(), source, payloadHash: sha1(JSON.stringify(payload)), payload };
  await writeJsonAtomicFsyncStrict(file, rec);
  const auditData = { source, cidade: payload && payload.cidade };
  if (payload && payload.telefone) auditData.telefone = maskPhoneLog(payload.telefone);
  await appendPedidoAudit(perfil, chatId, 'sent_ok', auditData);
  try {
    await ensureFinalClosingMessage(perfil, chatId, `from_markPedidoSent_source=${String(source || '')}`);
  } catch {}
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
      
      // Filtro de ruído rigoroso antes de gravar (verifica ANYWHERE no texto)
      const textoNormCheck = normalizeContent(rawToCheck);
      const hasNoise = isNoiseNorm(textoNormCheck) || 
        /\b(voce:|você:|you:)\b/.test(textoNormCheck) ||
        /\b(mensagem\s+nao\s+lida)\b/.test(textoNormCheck) ||
        /\b(inserir)\b/.test(textoNormCheck) ||
        /\b(you\s+sent|você\s+enviou|voce\s+enviou)\b/.test(textoNormCheck) ||
        /\b(enviado|enviada|lida|seen|visualizado|delivered)\b/.test(textoNormCheck) ||
        /\b(hoje|ontem)\b/.test(textoNormCheck) ||
        /[·•]/.test(rawToCheck) ||
        /^\d{1,2}:\d{2}$/.test(textoNormCheck);
      if (hasNoise) {
        audit(perfil, 'virtus', 'warn', 'chatlog_drop_noise', { chatId, texto: rawToCheck.slice(0, 100), motivo: 'ruido_detectado' });
        continue;
      }
      
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
      try {
        if (!location || typeof location.pathname !== 'string') return false;
        return location.pathname.includes(`/marketplace/t/${id}`) || location.pathname.includes(`/marketplace/v/${id}`);
      }
      catch { return false; }
    }, chatId).catch(() => false);
    if (ok) return true;
    if (!timeoutMs || (Date.now() - t0) >= timeoutMs) return false;
    await sleep(120);
  }
}

async function getOpenChatIdStrict(p) {
  try {
    const info = await p.evaluate(() => {
      function extraiIdDoHref(href) {
        try {
          const s = String(href || '');
          const matchT = s.match(/\/marketplace\/t\/(\d+)/);
          const matchV = s.match(/\/marketplace\/v\/(\d+)/);
          const id = matchT ? matchT[1] : (matchV ? matchV[1] : null);
          return id && /^\d+$/.test(id) ? id : null;
        } catch { return null; }
      }
      const byUrl = (typeof location === 'object' && location && location.pathname) ? extraiIdDoHref(location.pathname) : null;
      let byDom = null;
      // procurar link ativo no INBOX (aria-current=page/current) OU na thread
      const active = document.querySelector('a[aria-current="page"][href^="/marketplace/t/"], a[aria-current="page"][href^="/marketplace/v/"]')
                  || document.querySelector('a[aria-current="true"][href^="/marketplace/t/"], a[aria-current="true"][href^="/marketplace/v/"]')
                  || document.querySelector('a[href^="/marketplace/t/"].x1i10hfl, a[href^="/marketplace/v/"].x1i10hfl'); // fallback
      if (active) byDom = extraiIdDoHref(active.getAttribute('href') || active.href || '');
      return { byUrl, byDom };
    });
    return info || { byUrl: null, byDom: null };
  } catch { return { byUrl: null, byDom: null }; }
}

async function assertOnChatStrict(p, chatId, { timeoutMs = 4500 } = {}) {
  const finalTimeout = Math.max(4500, timeoutMs);
  const t0 = Date.now();
  let lastByUrl = null, lastByDom = null;
  while (true) {
    const okUrl = await assertOnChat(p, chatId, { timeoutMs: 0 }).catch(()=>false);
    const { byUrl, byDom } = await getOpenChatIdStrict(p);
    lastByUrl = byUrl; lastByDom = byDom;
    const okDom = (byDom && byDom === String(chatId)) || false;
    // Contexto rigoroso: só retorna true se BYURL exato E BYDOM exato E IGUAIS ao chatId
    if (okUrl && okDom && String(lastByUrl) === String(chatId) && String(lastByDom) === String(chatId)) {
      try {
        stepLog.appendJSONL('GLOBAL', 'virtus', {
          step: 'assert_on_chat_end',
          chatId, ok: true, byUrl: lastByUrl, byDom: lastByDom, tookMs: Date.now()-t0
        });
      } catch {}
      return true;
    }
    if (!okUrl || !okDom || String(lastByUrl) !== String(chatId) || String(lastByDom) !== String(chatId)) {
      audit('GLOBAL', 'virtus', 'warn', 'nav_ctx_mismatch', { chatId, byUrl: lastByUrl, byDom: lastByDom, expected: String(chatId) });
    }
    if (!finalTimeout || (Date.now()-t0) >= finalTimeout) {
      try {
        stepLog.appendJSONL('GLOBAL', 'virtus', {
          step: 'assert_on_chat_end',
          chatId, ok: false, byUrl: lastByUrl, byDom: lastByDom, tookMs: Date.now()-t0
        });
      } catch {}
      return false;
    }
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
    const re = new RegExp(`/marketplace/(t|v)/${chatId}(?:[/?#]|$)`);
    return re.test(u);
  } catch { return false; }
}

function randomBetween(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

// === INÍCIO: HELPERS DE ATENDIMENTO (NÃO REMOVER) ===
// REMOVIDO: hasPriceIntent - não mais utilizado

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

// REMOVIDO: detectProtestText, detectClientDoubt, hasAvailabilityIntent - não mais utilizados


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


// iniciarFilaEnvioMessenger removida - agora usando startJobScheduler

async function marcarRespondido(nomePerfil, chatId) {
  try {
    await virtusFSM.patch(nomePerfil, chatId, { lastIARespondedAt: Date.now() });
  } catch (e) {
    logger.error('[VIRTUS] marcarRespondido error', { nomePerfil, chatId, error: e && e.message || e });
  }
}

// [REMOVIDO: extrairUrlClassificado — scraping de URL não necessário, localização vem do manifest]

function shortTxt(s){ try{ return String(s||'').replace(/\s+/g,' ').trim().slice(0,120);}catch{return String(s||'').slice(0,120);} }

async function extrairHistoricoConversa(page) {
  try {
    const hist = await page.evaluate(() => {
      function norm(s){ try { return (s||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().trim(); } catch { return String(s||'').toLowerCase().trim(); } }

      function parseAbbrToTs(el) {
        try {
          const raw = (el.getAttribute('aria-label') || el.innerText || el.textContent || '').trim();
          const t = norm(raw);
          const now = Date.now();
          if (!t) return 0;
          if (/\bagora\b|just now|now/i.test(t)) return now;
          let m = t.match(/\b(\d+)\s*(s|seg|second|seconds?)\b/); if (m) return now - (parseInt(m[1], 10) * 1000);
          m = t.match(/\b(\d+)\s*(min|mins?|minute|minuto)\b/);    if (m) return now - (parseInt(m[1], 10) * 60000);
          m = t.match(/\b(\d+)\s*(h|hora|horas|hour|hours?)\b/);   if (m) return now - (parseInt(m[1], 10) * 3600000);
          m = t.match(/\b(\d+)\s*(d|dia|dias|day|days)\b/);        if (m) return now - (parseInt(m[1], 10) * 86400000);
          if (/\bontem\b|yesterday\b/.test(t)) return now - 86400000;
          const dp = Date.parse(raw);
          return Number.isFinite(dp) ? dp : 0;
        } catch { return 0; }
      }

      function isNoise(t) {
        const s = norm(t).replace(/[.,;:!?\u200B-\u200D\uFEFF]/g, '').trim();
        if (!s) return true;
        if (/\b(inserir|carregando|mensagem\s+nao\s+lida|hoje|ontem)\b/.test(s)) return true;
        if (/^\d{1,2}:\d{2}$/.test(s)) return true;
        if (/\b(enviado|enviada|sent|delivered|visto|visualizado|lida|seen)\b/.test(s)) return true;
        if (/[·•]/.test(t)) return true;
        if (/\b(voce:|você:|you:)\b/.test(s)) return true;
        if (/\b(voce\s+enviou|você\s+enviou|you\s+sent)\b/.test(s)) return true;
        if (/^\W+$/.test(s)) return true;
        return false;
      }
      function isUiMine(row, textNorm) {
        try { if (row.querySelector('[data-testid*="outgoing"]')) return true; } catch {}
        if (/\b(voce:|você:|you:)\b/.test(textNorm)) return true;
        if (/\b(voce\s+enviou|você\s+enviou|you\s+sent)\b/.test(textNorm)) return true;
        try {
          const wrap = row.closest('[data-testid*="message"], [data-pagelet*="thread"]') || row;
          const st = window.getComputedStyle(wrap);
          if (st && (st.justifyContent === 'flex-end' || st.textAlign === 'right')) return true;
        } catch {}
        return false;
      }

      // 1) Composer (campo de digitação) como âncora
      const composer = document.querySelector('div[contenteditable="true"][role="textbox"], div[role="combobox"][contenteditable="true"], div[contenteditable="true"][aria-label]');
      if (!composer) return { out: [], dbg: { dbg_mainFound: false, dbg_gridFound: false, dbg_rowsScanned: 0, dbg_clientMsgs: 0, dbg_firstRowText: '' } };
      // 2) Container da conversa
      const convoRoot = composer.closest('div[role="main"]') || composer.closest('section') || composer.parentElement;
      if (!convoRoot) return { out: [], dbg: { dbg_mainFound: false, dbg_gridFound: false, dbg_rowsScanned: 0, dbg_clientMsgs: 0, dbg_firstRowText: '' } };
      // 3) Grid DENTRO da conversa
      const grid = convoRoot.querySelector('div[role="grid"][aria-label*="Mensagens na conversa"], div[aria-label*="Mensagens na conversa"][role="grid"], div[role="grid"][aria-label*="Messages"], div[aria-label*="Messages"][role="grid"]');
      if (!grid) return { out: [], dbg: { dbg_mainFound: false, dbg_gridFound: false, dbg_rowsScanned: 0, dbg_clientMsgs: 0, dbg_firstRowText: '' } };
      const rows = Array.from(grid.querySelectorAll('div[role="row"],div[role="article"],div[data-testid]')).slice(-220);

      const out = [];
      for (const row of rows) {
        const rawTxt = (row.innerText || row.textContent || '').trim();
          if (!rawTxt) continue;
        if (isNoise(rawTxt)) continue;

          // Nunca processar headings/divisores/status
          if (row.getAttribute && row.getAttribute('role') === 'heading') continue;
          if (!grid.contains(row)) continue;
          
          const nraw = norm(rawTxt);
          if (isUiMine(row, nraw)) continue; // só cliente

          let ts = 0;
          try {
          const ab = row.querySelector('abbr[aria-label]') || row.closest('*:has(abbr[aria-label])')?.querySelector('abbr[aria-label]');
            if (ab) ts = parseAbbrToTs(ab);
          } catch {}
        if (!ts) ts = Date.now();

        out.push({ texto: rawTxt.trim(), autor: 'cliente', timestamp: ts });
      }

      out.sort((a,b) => (a.timestamp||0)-(b.timestamp||0));
      for (let i=1;i<out.length;i++){
        const prev = Number(out[i-1].timestamp || 0);
        const cur  = Number(out[i].timestamp || 0);
        if (cur <= prev) out[i].timestamp = prev + 1;
      }

      // Estatística de depuração (retornamos junto, Virtus filtra abaixo)
      const dbg = {
        dbg_mainFound: !!composer,
        dbg_gridFound: !!grid,
        dbg_rowsScanned: rows.length,
        dbg_clientMsgs: out.length,
        dbg_firstRowText: rows.length ? (rows[0].innerText||rows[0].textContent||'').trim().slice(0,120) : ''
      };
      return { out, dbg };
    });

    const arr = Array.isArray(hist && hist.out) ? hist.out : [];
    // LOG forense da coleta
    try {
      stepLog.appendJSONL('GLOBAL', 'virtus', {
        step: 'extract_history_stats',
        dbg_mainFound: !!(hist && hist.dbg && hist.dbg.dbg_mainFound),
        dbg_gridFound: !!(hist && hist.dbg && hist.dbg.dbg_gridFound),
        dbg_rowsScanned: hist && hist.dbg && hist.dbg.dbg_rowsScanned || 0,
        dbg_clientMsgs: hist && hist.dbg && hist.dbg.dbg_clientMsgs || 0,
        dbg_firstRowText: hist && hist.dbg && shortTxt(hist.dbg.dbg_firstRowText) || ''
      });
    } catch {}
    return arr;
  } catch (e) {
    try {
      stepLog.appendJSONL('GLOBAL', 'virtus', {
        step: 'extract_history_exception',
        error: (e && e.message) || String(e)
      });
    } catch {}
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
const SCAN_NAV_TIMEOUT_MS = parseInt(process.env.SCAN_NAV_TIMEOUT_MS || '30000', 10); // 30s para navegar no chat

// Constantes globais de throttle/requeue
const MIN_REQUEUE_MS = Math.max(10000, parseInt(process.env.VIRTUS_MIN_REQUEUE_MS || '10000', 10));
const SEND_REQUEUE_MIN_MS = Math.max(MIN_REQUEUE_MS, parseInt(process.env.VIRTUS_SEND_REQUEUE_MIN_MS || '15000', 10));
const COLLECT_FAIL_PAUSE_MS = Math.max(600000, parseInt(process.env.VIRTUS_COLLECT_FAIL_PAUSE_MS || '600000', 10));
const COLLECT_THROTTLE_MS = Math.max(10000, parseInt(process.env.VIRTUS_COLLECT_THROTTLE_MS || '10000', 10));

const COLETA_FINAL_MS = parseInt(process.env.VIRTUS_COLETA_FINAL_MS || '600000', 10); // 10min
const FINALIZACAO_FREEZE_MS = parseInt(process.env.VIRTUS_FINAL_FREEZE_MS || '259200000', 10); // 72h
const VIRTUS_COLLECT_IDLE_MS = parseInt(process.env.VIRTUS_COLLECT_IDLE_MS || '0', 10); // repouso por chat pós-coleta (padrão 0)
const VIRTUS_COLLECT_GAP_MS = parseInt(process.env.VIRTUS_COLLECT_GAP_MS || '1500', 10); // espaçamento entre coletas (anti-spam)

// Claims/reaper/anti-drift/scan-blocked watchdog
const VIRTUS_CLAIM_STALE_MS = parseInt(process.env.VIRTUS_CLAIM_STALE_MS || '900000', 10); // 15min
const VIRTUS_CLAIM_HEARTBEAT_MS = parseInt(process.env.VIRTUS_CLAIM_HEARTBEAT_MS || '15000', 10); // 15s
const VIRTUS_COLLECT_ENQUEUE_MAX_WAIT_MS = parseInt(process.env.VIRTUS_COLLECT_ENQUEUE_MAX_WAIT_MS || '300000', 10); // 5min – anti-clock-drift
const SCAN_BLOCK_MAX_MS = parseInt(process.env.VIRTUS_SCAN_BLOCK_MAX_MS || '600000', 10); // 10min watchdog scanBlocked

// Variáveis globais para controle de backoff e falhas
// recoverBackoffMs, NAV_CLICK_ONLY removidos
const failCounts = new Map();
function setFailCount(chatId, n) {
  if (!failCounts.has(chatId) && failCounts.size >= 1000) {
    const first = failCounts.keys().next().value;
    if (first !== undefined) failCounts.delete(first);
  }
  failCounts.set(chatId, n);
}

const filaEnviarNotificador = new Map();  // nomePerfil -> [ { chatId, tipoServico, mensagem, localizacao } ]
const filaRespostas = new Map();          // nomePerfil -> [ { chat_id, resposta } ]
const filaEnvioMessenger = new Map();     // nomePerfil -> [ { chatId, resposta, key } ]
const ultimaRespostaMessenger = new Map();// nomePerfil -> timestamp
const aguardandoRespostaMap = new Map();  // nomePerfil -> Set(chatId)

// TTL de aguardando notificador (Virtus)
const aguardTimers = new Map(); // nomePerfil -> Map(chatId -> timeoutId)

const finalizationTimers = new Map(); // nomePerfil -> Map(chatId -> timeoutId)
const finalizingSetByPerfil = new Map(); // nomePerfil -> Set(chatId)

// Estruturas de controle por chat/perfil para fila de aguardos (45s), timers, dedup
const COLLECT_WAIT_MAP = new Map();          // perfil -> Map(chatId -> timeoutId)
const COLLECT_DUE_MAP = new Map();           // perfil -> Map(chatId -> dueAt)
const COLLECT_LAST_EVENT_TS = new Map();     // perfil -> Map(chatId -> lastEventTs)

function mapFor(map, perfil) {
  if (!map.has(perfil)) map.set(perfil, new Map());
  return map.get(perfil);
}

// --- Fila aguardando 45s antes da coleta (debounced, independente por chat) ---
function startCollectWait(perfil, chatId, reason, anchorTs) {
  const timers      = mapFor(COLLECT_WAIT_MAP, perfil);
  const dueMap      = mapFor(COLLECT_DUE_MAP, perfil);
  const eventTsMap  = mapFor(COLLECT_LAST_EVENT_TS, perfil);
  const now = Date.now();
  const lastEventTs = eventTsMap.get(chatId) || 0;
  // Cheque evt.ts > lastEventTs antes de resetar (minimiza resets por ruído)
  if (anchorTs && anchorTs <= lastEventTs) {
    return; // Ignora eventos antigos/ruído
  }
  const due = now + 45000;
  dueMap.set(chatId, due);
  eventTsMap.set(chatId, anchorTs || now);
  if (timers.has(chatId)) {
    clearTimeout(timers.get(chatId));
    audit(perfil, 'virtus', 'info', 'fila_coleta_reset', { chatId, dueAtISO: new Date(due).toISOString(), reason });
  } else {
    audit(perfil, 'virtus', 'info', 'fila_coleta_start', { chatId, dueAtISO: new Date(due).toISOString(), reason });
  }
  timers.set(chatId, setTimeout(async () => {
    try {
      // Guard para evitar race - só dispara se for realmente o último evento
      const curDue = dueMap.get(chatId) || 0;
      if (Date.now() < curDue) return;

      dueMap.delete(chatId);
      eventTsMap.delete(chatId);
      timers.delete(chatId);
      audit(perfil, 'virtus', 'info', 'coletado_job_enqueued', { chatId, origin: 'dom_event_coalesced' });
      await enqueueJob(perfil, { kind: 'collect', chatId, dueAt: Date.now(), payload: { origin: 'dom_event_coalesced', fast: true } });
    } catch(e){
      audit(perfil, 'virtus', 'error', 'coletado_job_enqueue_error', { chatId, err: String(e && e.message || e) });
    }
  }, 45000));
}


// scanBlockedByPerfil, isScanBlocked, setScanBlocked removidos
const sendInProgressByPerfil = new Map();
// REMOVIDO: collectPQByPerfil, collectIndexByPerfil - agora usando filas em disco
const collectRunnerTimers = new Map();    // nomePerfil -> intervalId
const lastCollectAtByPerfil = new Map();  // nomePerfil -> timestamp última coleta despachada

// Funções antigas de send/collect removidas - agora usando fila única via enqueueJob/deleteJob/pickNextSend/pickNextCollect

// REMOVIDO: runCollectForChat e startCollectRunner movidas para dentro de startVirtus para ter acesso a ensurePage

// Timers de coleta (45s após evento)
// REMOVIDO: collectTimers, slaWatchdogTimers - agora usando filas em disco

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

// Throttle e in-flight control por chat
const collectInFlightByPerfil = new Map();
const sendInFlightByPerfil = new Map();
const lastCollectAttemptAtByPerfil = new Map();
const lastSendAttemptAtByPerfil = new Map();

function getInFlightSet(map, perfil) {
  if (!map.has(perfil)) map.set(perfil, new Set());
  return map.get(perfil);
}

function getAttemptMap(map, perfil) {
  if (!map.has(perfil)) map.set(perfil, new Map());
  return map.get(perfil);
}

// Contador de falhas
const collectFailCounts = new Map();
function incCollectFail(perfil, chatId) {
  const k = `${perfil}::${chatId}`;
  const n = 1 + (collectFailCounts.get(k) || 0);
  collectFailCounts.set(k, n);
  return n;
}

function resetCollectFail(perfil, chatId) {
  collectFailCounts.delete(`${perfil}::${chatId}`);
}

function stripRedundantRecap(s) {
  try {
    let x = String(s || '');
    // Remove frases tipo "Perfeito, já anotei [...]" preservando só a pergunta.
    x = x.replace(/^(?:perfeito|certo|ótimo|otimo)[,!.\s]*(?:j[áa]\s+)?(?:anotei|registrei|notei|peguei|adicionei)[^?!.]*[.!\s]+/i, '').trim();
    // Remove qualquer "já anotei..." isolado
    x = x.replace(/^(?:j[áa]\s+)?(?:anotei|registrei|notei|peguei|adicionei)[^?!.]*[.!\s]+/i, '').trim();
    // Remove qualquer muleta "Perfeito" "Certo" "Ótimo" sozinha
    x = x.replace(/^(perfeito|certo|ótimo|otimo)[,!.\s]+/i, '').trim();
    return x;
  } catch { return s; }
}

async function queueMessengerSend(nomePerfil, { chatId, resposta, key, fromNotifier = false, origin = '', cursorSig = '', cursorCountOverride, cursorDigestOverride, lastClientTsOverride }) {
  try {
    let payload = String(resposta || '').trim();
    const sanitized = stripRedundantRecap(payload);
    if (sanitized) {
      resposta = sanitized;
      payload = String(resposta || '').trim();
    }
    if (!payload) {
      audit(nomePerfil, 'virtus', 'warn', 'queue_drop_empty', { chatId });
      return { ok: false, status: 'dropped' };
    }

    let fsmState = null;
    try { fsmState = virtusFSM.get(nomePerfil, chatId); } catch {}

    const isFinalize = (origin === 'finalize');
    if (isFinalize && fsmState && fsmState.finalization && fsmState.finalization.closingMessageQueued) {
      audit(nomePerfil, 'virtus', 'warn', 'queue_skip_finalize_duplicate', { chatId });
      return { ok: false, status: 'dropped' };
    }

    const cCount = Number((typeof cursorCountOverride === 'number') ? cursorCountOverride : ((fsmState && fsmState.cursor && fsmState.cursor.client && fsmState.cursor.client.count) || 0));
    const cDigest = (typeof cursorDigestOverride === 'string') ? cursorDigestOverride : ((fsmState && fsmState.cursor && fsmState.cursor.client && fsmState.cursor.client.digest) || '');
    let sig = String(cursorSig || (cCount && cDigest ? `${cCount}|${cDigest}` : ''));

    // Exigir cursorSig para origin !== 'finalize'
    if (origin !== 'finalize' && !sig) {
      // Tentar calcular do histórico se disponível
      try {
        const chatLogRecent = Array.isArray(fsmState?.chatLogRecent) ? fsmState.chatLogRecent : [];
        if (Array.isArray(chatLogRecent) && chatLogRecent.length > 0) {
          const lastClientMsgs = chatLogRecent.filter(m => m && m.autor === 'cliente').slice(-5);
          if (lastClientMsgs.length > 0) {
            const combined = lastClientMsgs.map(m => String(m.texto || '')).join('|');
            const digest = sha1(combined);
            const count = lastClientMsgs.length;
            sig = `${count}|${digest}`;
          }
        }
      } catch {}
      
      if (!sig) {
        audit(nomePerfil, 'virtus', 'warn', 'queue_drop_no_cursorSig', { chatId, origin });
        return { ok: false, status: 'dropped' };
      }
    }

    // DEDUPE contra já enviado/enfileirado
    const alreadySentSig = String(fsmState?.cursor?.ia?.sentSig || '');
    const alreadyQueuedSig = String(fsmState?.cursor?.ia?.queuedSig || '');
    const cmpSig = String(cursorSig || (cCount && cDigest ? `${cCount}|${cDigest}` : ''));
    if (cmpSig) {
      if (alreadySentSig && cmpSig === alreadySentSig && origin !== 'finalize') {
        audit(nomePerfil, 'virtus', 'info', 'queue_skip_already_sent_sig', { chatId, sig: cmpSig, origin });
        return { ok: false, status: 'dropped' };
      }
      if (alreadyQueuedSig && cmpSig === alreadyQueuedSig && origin !== 'finalize') {
        audit(nomePerfil, 'virtus', 'info', 'queue_skip_already_queued_sig', { chatId, sig: cmpSig, origin });
        return { ok: false, status: 'dropped' };
      }
    }

    let earliestSendAt = undefined;
    if (origin === 'finalize') {
      let anchor = 0;
      try {
        const stForAnchor = virtusFSM.get(nomePerfil, chatId);
        anchor = Number(stForAnchor && stForAnchor.data && stForAnchor.data.lastClientTs) || Date.now();
      } catch {}
      earliestSendAt = virtusFSM.computeEarliestSendAt ? virtusFSM.computeEarliestSendAt(nomePerfil, chatId, { origin: 'finalize', lastClientTs: anchor }) : (anchor + WAIT_BEFORE_REPLY_MIN_MS + Math.floor(Math.random() * (WAIT_BEFORE_REPLY_MAX_MS - WAIT_BEFORE_REPLY_MIN_MS + 1)));
    }

    // Calcula dueAt baseado em lastClientTsOverride
    const anchor = (typeof lastClientTsOverride === 'number' && lastClientTsOverride > 0) ? lastClientTsOverride : Date.now();
    const jitter = WAIT_BEFORE_REPLY_MIN_MS + Math.floor(Math.random() * (WAIT_BEFORE_REPLY_MAX_MS - WAIT_BEFORE_REPLY_MIN_MS + 1));
    const dueAt = earliestSendAt || (anchor + jitter);

    // Enfileira na fila única
    await enqueueJob(nomePerfil, {
      kind: 'send',
      chatId,
      dueAt: Number(dueAt),
      payload: { resposta: payload, cursorSig: sig, origin, queuedAt: Date.now() }
    });
    await virtusFSM.ackQueued(nomePerfil, chatId, sig);

    if (origin === 'finalize') {
      try {
        await virtusFSM.patch(nomePerfil, chatId, {
          finalization: { ...(fsmState && fsmState.finalization || {}), closingMessageQueued: true }
        });
      } catch {}
    }

    audit(nomePerfil, 'virtus', 'info', 'fila_envio_enqueued', { chatId, sig, origin, earliestSendAt: earliestSendAt ? new Date(earliestSendAt).toISOString() : null });
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




async function readJson(file, fb = {}) {
  const lockPath = file + '.lck'; let fd = null;
  try {
    fd = acquireFileLock(lockPath); // fd é retornado!
    const txt = await fs.readFile(file, 'utf8').catch(() => null);
    return txt ? JSON.parse(txt) : fb;
  } catch {
    return fb;
  } finally {
    try { releaseFileLock(lockPath, fd); } catch {}
  }
}

async function writeJsonAtomicFsync(file, obj) {
  const lockPath = file + '.lck'; let fd = null;
  try {
    fd = acquireFileLock(lockPath);
    await fs.mkdir(path.dirname(file), { recursive: true });
    const tmp = file + '.tmp';
    const f = await fs.open(tmp, 'w');
    try {
      await f.writeFile(JSON.stringify(obj, null, 2), 'utf8');
      await f.sync();
    } finally { await f.close(); }
    try { await fs.unlink(file); } catch {}
    try { await fs.rename(tmp, file); }
    catch { await fs.copyFile(tmp, file); try { await fs.unlink(tmp); } catch {} }
    return true;
  } catch {
    return false;
  } finally {
    try { releaseFileLock(lockPath, fd); } catch {}
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
    const matchT = s.match(/\/marketplace\/t\/(\d+)/);
    const matchV = s.match(/\/marketplace\/v\/(\d+)/);
    const id = matchT ? matchT[1] : (matchV ? matchV[1] : null);
    return id && /^\d+$/.test(id) ? id : null;
  } catch { return null;   }
}

let lastGuaranteeAt = 0;
async function maybeGuaranteeMarketplaceFast(page, nome) {
  const url = (typeof page.url === 'function' ? page.url() : '') || '';

  // Se já estamos no Marketplace, só valida a presença de âncoras/rows
  if (/messenger.com\/marketplace/i.test(url)) {
    const ok = await page.evaluate(() =>
      !!document.querySelector('a[href^="/marketplace/t/"], a[href^="/marketplace/v/"]') || !!document.querySelector('div[role="row"]')
    ).catch(()=>false);
    if (ok) {
      await ensureObserversInstalled(page, nome).catch(()=>{});
    }
    return !!ok;
  }

  // NAV_CLICK_ONLY removido

  // Antes do lock, permite navegação para "colocar" a aba no Marketplace
  const now = Date.now();
  if ((now - lastGuaranteeAt) < 8000) return true;
  lastGuaranteeAt = now;
  await garantirMarketplace(page, { nome, allowNavigate: true });
  await ensureObserversInstalled(page, nome).catch(()=>{});
  return true;
}

async function coletaChatsMarketplaceTodos(page) {
  try {
    const items = await page.evaluate(() => {
      function extraiId(href) {
        try {
          const s = String(href || '');
          const mT = s.match(/\/marketplace\/t\/(\d+)/);
          const mV = s.match(/\/marketplace\/v\/(\d+)/);
          const id = (mT && mT[1]) || (mV && mV[1]) || null;
          return id && /^\d+$/.test(id) ? id : null;
        } catch { return null; }
      }
      function extraiTempo(row) {
        if (!row) return '';
        try {
          const ab = row.querySelector('abbr[aria-label]');
          if (ab) {
            const t1 = (ab.innerText || '').trim();
            if (t1) return t1;
            const t2 = (ab.getAttribute('aria-label') || '').trim();
            if (t2) return t2;
          }
          const spans = Array.from(row.querySelectorAll('span'));
          for (const s of spans) {
            const txt = (s.innerText || s.textContent || '').trim();
            if (!txt) continue;
            if (/agora/i.test(txt)) return txt;
            if (/\d+\s*(s|min|m|seg|h|hora|hour|minute|minuto|dia|dias|d|sem|seman|week|w)/i.test(txt)) return txt;
          }
        } catch {}
        return '';
      }
      const within =
        document.querySelector('div[role="grid"]') ||
        document.querySelector('div[role="rowgroup"]') ||
        document.querySelector('div.x78zum5.xdt5ytf') ||
        document;
      const anchors = Array.from(within.querySelectorAll('a[href^="/marketplace/t/"], a[href^="/marketplace/v/"]'));
      const arr = anchors.map(a => {
        const href = a.getAttribute('href') || a.href || '';
        const id = extraiId(href);
        const row = a.closest('div[role="row"]') || a.parentElement;
        const tempo = extraiTempo(row);
        const preview = row ? ((row.innerText || row.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 400)) : '';
        return id ? { id, tempo, href, preview } : null;
      }).filter(Boolean);
      const map = new Map();
      for (const it of arr) if (!map.has(it.id)) map.set(it.id, it);
      return Array.from(map.values());
    });
    return items;
  } catch {
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
          document.querySelector('a[href^="/marketplace/t/"], a[href^="/marketplace/v/"]') ||
          document.querySelector('div[role="row"]') ||
          document.querySelector('div[contenteditable="true"][role="textbox"]')
        )
      ).catch(()=>false),
      new Promise(r => setTimeout(()=>r(false), 800))
    ]);
    if (alreadyOk) {
      await ensureObserversInstalled(page, nome).catch(()=>{});
      return;
    }
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
          const hasAnchor = !!document.querySelector('a[href^="/marketplace/t/"], a[href^="/marketplace/v/"]');
      const hasRow = document.querySelectorAll('div[role="row"]').length > 0;
          return hasAnchor || hasRow;
        }, { timeout: 8000 }),
        page.waitForSelector('a[href^="/marketplace/t/"], a[href^="/marketplace/v/"]', { timeout: 8000 }).catch(() => null),
        page.waitForSelector('div[role="row"]', { timeout: 8000 }).catch(() => null)
      ]);
      
      if (ok) {
        await ensureObserversInstalled(page, nome).catch(()=>{});
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
      const hasAnchor = await page.$('a[href^="/marketplace/t/"], a[href^="/marketplace/v/"]').catch(() => null);
      const hasRow = await page.$('div[role="row"]').catch(() => null);
      if (hasAnchor || hasRow) {
        await ensureObserversInstalled(page, nome).catch(()=>{});
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

// HELPERS PARA ABERTURA DE CHAT APENAS POR CLIQUE (NUNCA GOTO THREAD)

async function findChatAnchorById(page, chatId) {
  try {
    const anchor = await page.evaluate((id) => {
      const sel = [
        `a[href^="/marketplace/t/${id}"]`,
        `a[href^="/marketplace/v/${id}"]`,
        `div[role="row"] a[href*="/marketplace/t/${id}"]`,
        `div[role="row"] a[href*="/marketplace/v/${id}"]`
      ].join(',');
      const nodes = Array.from(document.querySelectorAll(sel));
      function isVisible(a){
        try {
          const st = window.getComputedStyle(a);
          const r = a.getBoundingClientRect();
          return a.offsetParent !== null && st.visibility !== 'hidden' && st.display !== 'none' && r.width > 0 && r.height > 0;
        } catch { return false; }
      }
      const a = nodes.find(isVisible) || nodes[0] || null;
      if (!a) return null;
      const target = a.closest('div[role="row"]') || a;
      const rect = target.getBoundingClientRect();
      return { href: a.getAttribute('href') || a.href || '', x: rect.x, y: rect.y, width: rect.width, height: rect.height, kind: a.href && a.href.includes('/marketplace/v/') ? 'v' : 't' };
    }, chatId);
    return anchor;
  } catch {
    return null;
  }
}

async function smartAnchorClick(page, chatId) {
  try {
    const clicked = await page.evaluate((id) => {
      const sels = [
        `a[href^="/marketplace/t/${id}"]`,
        `a[href^="/marketplace/v/${id}"]`,
        `div[role="row"] a[href*="/marketplace/t/${id}"]`,
        `div[role="row"] a[href*="/marketplace/v/${id}"]`
      ];
      let a = null;
      for (const s of sels) { const el = document.querySelector(s); if (el) { a = el; break; } }
      if (!a) return false;

      const row = a.closest('div[role="row"]') || a;
      try { row.scrollIntoView({ block: 'center', behavior: 'instant' }); } catch {}
      const r = row.getBoundingClientRect();
      const cx = r.left + Math.max(8, Math.floor(r.width/2));
      const cy = r.top  + Math.max(8, Math.floor(r.height/2));

      // Se há overlay/interstitial, despache ESC e feche botão "Fechar"
      const topEl = document.elementFromPoint(cx, cy);
      if (topEl && !row.contains(topEl) && !a.contains(topEl)) {
        document.dispatchEvent(new KeyboardEvent('keydown', {key:'Escape', code:'Escape', bubbles:true}));
        const closeBtn = document.querySelector('[aria-label*="Fechar"],[aria-label*="Close"],[data-testid*="close"]');
        if (closeBtn) { try { closeBtn.click(); } catch {} }
      }

      const opts = { bubbles:true, cancelable:true, view:window, clientX:cx, clientY:cy, button:0, pointerId:1, isPrimary:true };
      try { row.dispatchEvent(new PointerEvent('pointerdown', opts)); } catch {}
      try { row.dispatchEvent(new MouseEvent('mousedown', opts)); } catch {}
      try { row.dispatchEvent(new PointerEvent('pointerup', opts)); } catch {}
      try { row.dispatchEvent(new MouseEvent('mouseup', opts)); } catch {}
      try { row.dispatchEvent(new MouseEvent('click', opts)); } catch {}
      try { a.focus && a.focus(); } catch {}
      try { a.click && a.click(); } catch {}

      return true;
    }, chatId);
    if (clicked) await sleep(120);
    return clicked;
  } catch {
    return false;
  }
}

async function waitForChatContext(page, chatId, { timeoutMs = 6000 } = {}) {
  const t0 = Date.now();
  while (true) {
    try {
      const ok = await page.evaluate((id) => {
        const pathOk = (typeof location === 'object' && location && location.pathname) 
          ? (location.pathname.includes(`/marketplace/t/${id}`) || location.pathname.includes(`/marketplace/v/${id}`))
          : false;
        const composer = document.querySelector('div[contenteditable="true"][role="textbox"], div[role="combobox"][contenteditable="true"], div[contenteditable="true"][aria-label]');
        const composerOk = composer && window.getComputedStyle(composer).display !== 'none' && composer.offsetParent !== null;
        return pathOk && composerOk;
      }, chatId);
      if (ok) return true;
    } catch {}
    if ((Date.now() - t0) >= timeoutMs) return false;
    await sleep(120);
  }
}

async function isContentUnavailablePage(page) {
  try {
    const unavailable = await page.evaluate(() => {
      const hasComposer = !!document.querySelector('div[contenteditable="true"][role="textbox"], div[role="combobox"][contenteditable="true"]');
      if (hasComposer) return false; // Se há composer, estamos num chat funcional.

      const bodyText = (document.body?.innerText || document.body?.textContent || '').toLowerCase();
      const alertEl = document.querySelector('[role="alert"], [data-testid*="error"]');
      const alertText = (alertEl?.innerText || alertEl?.textContent || '').toLowerCase();

      const patterns = [
        'conteúdo não está disponível',
        'conteudo nao esta disponivel',
        "this content isn't available",
        'this content isnt available',
        'content is not available'
      ];

      const matchBody = patterns.some(p => bodyText.includes(p));
      const matchAlert = patterns.some(p => alertText.includes(p));

      return !!(matchBody || matchAlert);
    });
    return !!unavailable;
  } catch {
    return false;
  }
}

async function goBackToInboxIfNeeded(page, perfil) {
  try {
    const clicked = await page.evaluate(() => {
      const buttons = [
        ...Array.from(document.querySelectorAll('a, button, [role="button"]')).filter(el => {
          const text = (el.innerText || el.textContent || '').toLowerCase();
          return /voltar|back|caixa de entrada|inbox|início|home/i.test(text);
        }),
        document.querySelector('a[href*="/marketplace"], a[href*="/inbox"]'),
        document.querySelector('[aria-label*="Voltar"], [aria-label*="Back"], [aria-label*="Inbox"]')
      ];
      if (buttons.length > 0) {
        try {
          const btn = buttons[0];
          btn.scrollIntoView({ block: 'center', behavior: 'instant' });
          btn.click();
          return true;
        } catch {}
      }
      return false;
    });
    if (clicked) {
      await sleep(100);
      await sleep(1000);
      try {
        await garantirMarketplace(page, { nome: perfil, allowNavigate: true });
      } catch {}
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

async function onDomEvent(perfil, evt) {
  if (!evt || !evt.type) return;
  if (evt.type === 'feed_changed') {
    // Calcular feedSig corretamente com sanitizeFeedPreview
    const previewRaw = String(evt.preview || '').slice(0, 400);
    const cleaned = sanitizeFeedPreview(previewRaw);
    if (!cleaned || isNoiseNorm(cleaned)) {
      audit(perfil, 'virtus', 'warn', 'detec_feed_noise_drop', { chatId: evt.chatId, previewRaw: previewRaw.slice(0, 100) });
      return;
    }
    const feedSig = sha1(cleaned);
    audit(perfil, 'virtus', 'info', 'detec_event', { type: 'feed_changed', chatId: evt.chatId, feedSig });
    let state = null; try { state = virtusFSM.get(perfil, evt.chatId); } catch {}
    if (state && state.cursor && state.cursor.feed && state.cursor.feed.sig === feedSig) {
      audit(perfil, 'virtus', 'info', 'detec_feed_nochange', { chatId: evt.chatId, feedSig });
      return;
    }
    await virtusFSM.patch(perfil, evt.chatId, {
      cursor: { ...(state && state.cursor || {}), feed: { sig: feedSig, preview: previewRaw, seenAt: evt.ts || Date.now() } }
    });
    if (!state || !state.discoveredAt) {
      await virtusFSM.patch(perfil, evt.chatId, { discoveredAt: Date.now() });
    }
    audit(perfil, 'virtus', 'debug', 'feed_event_ignored', { chatId: evt.chatId, feedSig });
  } else if (evt.type === 'client_msg') {
    // Sanitizar timestamp para evitar NaN
    let evtTs = Number(evt.ts || Date.now());
    if (!Number.isFinite(evtTs) || evtTs <= 0) evtTs = Date.now();
    // Calcular msgSig no Node
    const textoNormRaw = String(evt.textoNorm || evt.texto || '');
    const textoNorm = normalizeContent(textoNormRaw);
    // Camada final de blindagem: verifica ruído ANYWHERE no texto
    const hasNoise = !textoNorm || isNoiseNorm(textoNorm) || 
      /\b(voce:|você:|you:)\b/.test(textoNorm) ||
      /\b(voce\s+enviou|você\s+enviou|you\s+sent)\b/.test(textoNorm) ||
      /\b(inserir|carregando|mensagem\s+nao\s+lida)\b/.test(textoNorm) ||
      /\b(enviado|enviada|sent|delivered|visto|visualizado|lida|seen)\b/.test(textoNorm) ||
      /\b(hoje|ontem)\b/.test(textoNorm) ||
      /[·•]/.test(textoNormRaw) ||
      /^\d{1,2}:\d{2}$/.test(textoNorm);
    if (hasNoise) {
      audit(perfil, 'virtus', 'warn', 'detec_client_noise_drop', { chatId: evt.chatId, texto: textoNormRaw.slice(0, 100), motivo: 'ruido_detectado' });
      return;
    }
    const msgSig = sha1(`cliente|${textoNorm}|${Math.floor(evtTs/10000)}`);
    audit(perfil, 'virtus', 'info', 'detec_event', { type: 'client_msg', chatId: evt.chatId, msgSig });
    let st = null;
    try { st = virtusFSM.get(perfil, evt.chatId); } catch {}
    const recentMsgSigs = (st && st.cursor && st.cursor.client && Array.isArray(st.cursor.client.recentMsgSigs)) ? st.cursor.client.recentMsgSigs : [];
    if (recentMsgSigs && recentMsgSigs.includes(msgSig)) {
      audit(perfil, 'virtus', 'warn', 'detec_ignored_dup_msgsig', { chatId: evt.chatId, msgSig });
      return;
    }
    await appendChatHistoryLog(perfil, evt.chatId, [{ autor: 'cliente', texto: evt.texto, timestamp: evtTs }]);
    // ATUALIZE recentMsgSigs e lastMsgSig no chatStateStore. Mantenha a janela em 50.
    await virtusFSM.patch(perfil, evt.chatId, {
      cursor: {
        ...(st && st.cursor || {}),
        client: {
          ...(st && st.cursor && st.cursor.client || {}),
          lastMsgSig: msgSig,
          recentMsgSigs: Array.from((recentMsgSigs || []).concat([msgSig])).slice(-50)
        }
      }
    });
    startCollectWait(perfil, evt.chatId, 'client_msg', evtTs);
  } else if (evt.type === 'thread_dedup_hit') {
    // Log de dedup hit do thread observer
    audit(perfil, 'virtus', 'info', 'thread_dedup_hit', { chatId: evt.chatId, sig: evt.sig, bucket: evt.bucket, textoHash: evt.textoHash });
  }
}

// Ponte de eventos do DOM para Node
async function installDomEventBridge(page, perfil) {
  async function safeExpose(name, fn) {
    try { await page.exposeFunction(name, fn);}
    catch (e) { const msg = String((e && e.message) || e); if (!/already exists|duplicate/i.test(msg)) throw e; }
  }
  await safeExpose('virtusEmit', async (evt) => onDomEvent(perfil, evt));
  await safeExpose('virtusSha1', (str) => sha1(str));
  // Futuro: toda navegação
  await page.evaluateOnNewDocument(() => {
    window.__virtusEmit = (e) => { try { if (window.virtusEmit) return window.virtusEmit(e); } catch {} };
    window.__virtusObserversInstalled = !!window.__virtusObserversInstalled;
    window.sha1 = window.virtusSha1 || ((s) => s);
  });
  // Documento atual (CRÍTICO)
  await page.evaluate(() => {
    window.__virtusEmit = (e) => { try { if (window.virtusEmit) return window.virtusEmit(e); } catch {} };
    window.sha1 = window.virtusSha1 || ((s) => s);
    window.__virtusBridgeNow = true;
  }).catch(()=>{});
  audit(perfil, 'virtus', 'info', 'dom_bridge_ready', { nowDoc: true });
}

async function installInboxObserver(page) {
  await page.evaluate(() => {
    if (window.__virtusInboxObs) return;
    window.__virtusInboxObs = true;
    const root = document.querySelector('div[role="grid"], div[role="rowgroup"], div.x78zum5.xdt5ytf') || document.body;
    if (!root) return;

    window.__virtusFeedSigById = window.__virtusFeedSigById || new Map();

    function norm(s) {
      try { return (s||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().trim(); }
      catch { return String(s||'').toLowerCase().trim(); }
    }
    function sanitizePreview(txt) {
      // Use a mesma lógica do sanitizeFeedPreview do backend inline
      let t = norm(txt);
      t = t.replace(/\b(agora|hoje|ontem|yesterday)\b/g, ' ');
      t = t.replace(/\b(voce:|v[oó]ce:|you:)\b/g, ' ');
      t = t.replace(/\b(voce\s+enviou|you\s+sent)\b/g, ' ');
      t = t.replace(/\b(mensagem\s+nao\s+lida)\b/g, ' ');
      t = t.replace(/\b(inserir|carregando\.\.\.|carregando)\b/g, ' ');
      t = t.replace(/\b(enviado|enviada|delivered|visto|visualizado|lida|seen)\b/g, ' ');
      t = t.replace(/[·•]/g, ' ');
      t = t.replace(/\b\d{1,2}:\d{2}\b/g, ' ');
      t = t.replace(/\b\d+\s*(s|seg|sec|mins?|minute|minuto|minutos|hour|hora|horas|d|dia|dias|week|weeks)\b/g, ' ');
      t = t.replace(/\s+/g, ' ').trim();
      return t;
    }
    function isPreviewNoise(p) {
      const n = sanitizePreview(p);
      if (!n) return true;
      if (n.length <= 2) return true;
      if (/^(enviado|lida|seen|visualizado)$/.test(n)) return true;
      return false;
    }

    function processRow(row) {
      try {
        const a = row.querySelector('a[href^="/marketplace/t/"], a[href^="/marketplace/v/"]');
        if (!a) return;
        const href = a.getAttribute('href') || a.href || '';
        const m = href.match(/\/marketplace\/[tv]\/(\d+)/);
        const id = m ? m[1] : null;
        if (!id) return;

        const rawPreview = (row.innerText || row.textContent || '').slice(0, 800);
        if (isPreviewNoise(rawPreview)) return;

        const cleaned = sanitizePreview(rawPreview);
        const sig = (window.sha1 ? window.sha1(cleaned) : cleaned);
        const last = window.__virtusFeedSigById.get(id);

        if (last === sig) return;
        window.__virtusFeedSigById.set(id, sig);

        window.__virtusEmit && window.__virtusEmit({
          type: 'feed_changed', chatId: id, preview: rawPreview, ts: Date.now()
        });
      } catch {}
    }

    const obs = new MutationObserver((records) => {
      const rows = new Set();
      for (const r of records) {
        if (r.target && r.target.closest) {
          const row = r.target.closest('div[role="row"]');
          if (row) rows.add(row);
        }
        for (const n of Array.from(r.addedNodes||[])) {
          if (!(n instanceof Element)) continue;
          const row = n.closest('div[role="row"]');
          if (row) rows.add(row);
        }
      }
      for (const row of rows) processRow(row);
    });
    obs.observe(root, { childList: true, subtree: true });

    // varredura inicial mínima
    const initRows = Array.from(root.querySelectorAll('div[role="row"]')).slice(0, 50);
    for (const r of initRows) processRow(r);
  });
}

async function installThreadObserver(page) {
  await page.evaluate(() => {
    if (window.__virtusThreadObs) return;
    window.__virtusThreadObs = true;

    // 1) Composer (campo de digitação)
    const composer = document.querySelector('div[contenteditable="true"][role="textbox"], div[role="combobox"][contenteditable="true"], div[contenteditable="true"][aria-label]');
    if (!composer) { window.__virtusThreadObs = false; return; }
    // 2) Container da conversa
    const convoRoot = composer.closest('div[role="main"]') || composer.closest('section') || composer.parentElement;
    if (!convoRoot) { window.__virtusThreadObs = false; return; }
    // 3) Grid DENTRO da conversa
    const grid = convoRoot.querySelector('div[role="grid"][aria-label*="Mensagens na conversa"], div[aria-label*="Mensagens na conversa"][role="grid"], div[role="grid"][aria-label*="Messages"], div[aria-label*="Messages"][role="grid"]');
    if (!grid) { window.__virtusThreadObs = false; return; }

    window.__virtusMsgSeen = window.__virtusMsgSeen || new Map();
    function nowMinBucket(ts) { return Math.floor((ts || Date.now()) / 10000); }
    function norm(s) { return (s||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().trim(); }
    function isUiMine(row, textNorm) {
      try { if (row.querySelector('[data-testid*="outgoing"]')) return true; } catch {}
      if (/\b(voce:|você:|you:)\b/.test(textNorm)) return true;
      if (/\b(voce\s+enviou|você\s+enviou|you\s+sent)\b/.test(textNorm)) return true;
      try {
        const wrap = row.closest('[data-testid*="message"], [data-pagelet*="thread"]') || row;
        const st = window.getComputedStyle(wrap);
        if (st && (st.justifyContent === 'flex-end' || st.textAlign === 'right')) return true;
      } catch {}
      return false;
    }
    function isThreadNoise(textNorm) {
      if (!textNorm) return true;
      if (/\b(inserir|carregando|mensagem\s+nao\s+lida|hoje|ontem)\b/.test(textNorm)) return true;
      if (/^\d{1,2}:\d{2}$/.test(textNorm)) return true;
      if (/\b(enviado|enviada|sent|delivered|visto|visualizado|lida|seen)\b/.test(textNorm)) return true;
      if (/[·•]/.test(textNorm)) return true;
      if (/^\W+$/.test(textNorm)) return true;
      return false;
    }
    function parseAbbrTs(row) {
      try {
        const abbr = row.querySelector('abbr[aria-label]');
        if (!abbr) return Date.now();
        const raw = abbr.getAttribute('aria-label') || abbr.innerText || abbr.textContent || '';
        const dp = Date.parse(raw); return Number.isFinite(dp) && dp > 0 ? dp : Date.now();
      } catch { return Date.now(); }
    }
    function emitRow(row) {
      if (!grid.contains(row)) return;
      if (row.getAttribute('role') === 'heading') return;
      const textoRaw = (row.innerText || row.textContent || '').trim();
      if (!textoRaw) return;
      const textoNorm = norm(textoRaw);
      if (isThreadNoise(textoNorm)) return;
      if (isUiMine(row, textoNorm)) return;
      const path = location && location.pathname || '';
      const m = path.match(/\/marketplace\/[tv]\/(\d+)/);
      const chatId = m ? m[1] : null;
      if (!chatId) return;
      const ts = parseAbbrTs(row);
      const sig = (window.sha1 ? window.sha1(`cliente|${textoNorm}|${nowMinBucket(ts)}`) : `${textoNorm}|${nowMinBucket(ts)}`);
      const map = window.__virtusMsgSeen.get(chatId) || new Map();
      if (map.has(sig)) return;
      map.set(sig, Date.now());
      for (const [k, v] of Array.from(map.entries())) { if (Date.now() - v > 180000) map.delete(k); }
      window.__virtusMsgSeen.set(chatId, map);
      window.__virtusEmit && window.__virtusEmit({ type: 'client_msg', chatId, texto: textoRaw, ts, textoNorm });
    }
    const obs = new MutationObserver((recs) => {
      const rows = new Set();
      for (const r of recs) {
        for (const n of Array.from(r.addedNodes || [])) {
          if (!(n instanceof Element)) continue;
          const row = n.closest && n.closest('div[role="row"],div[role="article"],div[data-testid]');
          if (row) rows.add(row);
        }
        if (r.target && r.target.closest) {
          const row = r.target.closest('div[role="row"],div[role="article"],div[data-testid]');
          if (row) rows.add(row);
        }
      }
      for (const row of rows) emitRow(row);
    });
    obs.observe(grid, { childList: true, subtree: true });
  });
}

async function ensureObserversInstalled(page, perfil) {
  await installInboxObserver(page).catch(()=>{});
  await installThreadObserver(page).catch(()=>{});
  const state = await page.evaluate(() => ({
    inboxObs: !!window.__virtusInboxObs,
    threadObs: !!window.__virtusThreadObs,
    hasEmit: typeof window.__virtusEmit === 'function',
    hasBinding: typeof window.virtusEmit === 'function'
  })).catch(()=>null);
  audit(perfil, 'virtus', 'info', 'observers_state', state || {});
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
        let firstA = grid.querySelector('a[role="link"], a[href^="/marketplace/t/"], a[href^="/marketplace/v/"]');
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

// REMOVIDO: openChatByUrl - não mais utilizado

// PROIBIDO GOTO THREAD: Esta função NUNCA usa page.goto para threads, apenas cliques na lista lateral
async function openChatByClick(p, perfil, chatId, { timeoutMs = 8000, retries = 1, scrollTries = 2, scrollStep = 700, jobContext = null } = {}) {
  const ctx = jobContext || getNavIntent(perfil);
  const jobKind = ctx && ctx.kind;
  const jobReady = !!(ctx && ctx.jobReady);
  const dueAt = ctx && ctx.dueAt ? new Date(ctx.dueAt).toISOString() : null;

  if (!jobKind || !jobReady) {
    audit(perfil, 'virtus', 'warn', 'open_chat_click_blocked_no_job', { chatId, hasCtx: !!ctx });
    return false;
  }

  audit(perfil, 'virtus', 'info', 'open_chat_click_start', { chatId, jobKind, jobReady, dueAt });
  
  // Garante marketplace na raiz
  try {
    await maybeGuaranteeMarketplaceFast(p, perfil).catch(()=>{});
    } catch {}

  // Role lista para cima
  try { await scrollChatsToTop(p, perfil); } catch {}
  await sleep(300);

  // Tenta encontrar a âncora
  for (let attempt = 0; attempt <= retries; attempt++) {
    audit(perfil, 'virtus', 'debug', 'open_chat_click_attempt', { chatId, attempt: attempt + 1 });
    
    const anchor = await findChatAnchorById(p, chatId);
    if (!anchor) {
      audit(perfil, 'virtus', 'debug', 'open_chat_anchor_not_found', { chatId });
      await sleep(250 + Math.floor(Math.random() * 200));
      continue;
    }
    
    // Clique na âncora
    const clicked = await smartAnchorClick(p, chatId);
    if (!clicked) {
      audit(perfil, 'virtus', 'debug', 'open_chat_anchor_click_fail', { chatId });
      await sleep(250 + Math.floor(Math.random() * 200));
      continue;
    }
    
    await sleep(500);
    
    // Verifica se apareceu tela de erro
    if (await isContentUnavailablePage(p)) {
      audit(perfil, 'virtus', 'warn', 'open_chat_content_unavailable', { chatId });
      await goBackToInboxIfNeeded(p, perfil);
      await sleep(1000);
      try { await scrollChatsToTop(p, perfil); } catch {}
      await sleep(300);
      continue;
    }
    
    // Aguarda contexto do chat (pathname + composer + DOM)
    const tAssert0 = Date.now();
    const ok = await assertOnChatStrict(p, chatId, { timeoutMs: Math.min(timeoutMs, 6000) });
    try {
      const ids = await getOpenChatIdStrict(p);
      stepLog.appendJSONL(perfil, 'virtus', {
        step: 'assert_on_chat_end',
        chatId,
        ok: !!ok,
        byUrl: ids && ids.byUrl || null,
        byDom: ids && ids.byDom || null,
        tookMs: Date.now() - tAssert0
      });
    } catch {}
      if (ok) {
      audit(perfil, 'virtus', 'info', 'open_chat_click_ok', { chatId });
      await ensureObserversInstalled(p, perfil).catch(()=>{});
      return true;
    }
    
    // Se assertOnChatStrict falha, tente hard-nav + retry
    const hardNav = await p.evaluate((id) => {
      const a = document.querySelector(`a[href^="/marketplace/t/${id}"], a[href^="/marketplace/v/${id}"], div[role="row"] a[href*="/marketplace/t/${id}"], div[role="row"] a[href*="/marketplace/v/${id}"]`);
      if (!a) return false;
      const href = a.getAttribute('href') || a.href || '';
      if (!href) return false;
      try { window.location.assign(href); return true; } catch { return false; }
    }, chatId).catch(()=>false);
    
    if (hardNav) {
      await sleep(1000);
      const okHard = await assertOnChatStrict(p, chatId, { timeoutMs: Math.min(timeoutMs, 6000) });
      if (okHard) {
        audit(perfil, 'virtus', 'info', 'open_chat_click_ok_hardnav', { chatId });
        await ensureObserversInstalled(p, perfil).catch(()=>{});
        return true;
      }
    }

    // Se ainda falhou, tenta goBackToInboxIfNeeded + garantirMarketplace + retry
    if (!ok && !hardNav) {
      audit(perfil, 'virtus', 'warn', 'open_chat_ctx_mismatch_retry', { chatId });
      await goBackToInboxIfNeeded(p, perfil);
      await sleep(1000);
      try {
        await garantirMarketplace(p, { nome: perfil, allowNavigate: true });
      } catch {}
      await sleep(500);
      const retryOk = await assertOnChatStrict(p, chatId, { timeoutMs: Math.min(timeoutMs, 6000) });
      if (retryOk) {
        audit(perfil, 'virtus', 'info', 'open_chat_click_ok_after_recovery', { chatId });
        await ensureObserversInstalled(p, perfil).catch(()=>{});
        return true;
      }
    }

    await sleep(250 + Math.floor(Math.random() * 200));
  }

  // Scroll para materializar itens da lista virtualizada
  for (let i = 0; i < scrollTries; i++) {
    audit(perfil, 'virtus', 'debug', 'open_chat_click_scroll_attempt', { chatId, scrollTry: i+1 });
    
    try {
      await p.evaluate((step) => {
        function gridEl() {
          return document.querySelector('div[role="grid"]')
            || document.querySelector('div[role="rowgroup"]')
            || document.querySelector('div.x78zum5.xdt5ytf')
            || document.scrollingElement
            || document.body;
        }
        const g = gridEl();
        if (g) {
          const next = Math.min((g.scrollTop || 0) + step, g.scrollHeight);
          g.scrollTop = next;
          try {
            const first = g.querySelector && g.querySelector('a[role="link"], a[href^="/marketplace/t/"], a[href^="/marketplace/v/"]');
            if (first) first.focus && first.focus();
          } catch {}
        }
      }, scrollStep).catch(()=>{});
    } catch {}
    
    await sleep(300);
    
    const anchor = await findChatAnchorById(p, chatId);
    if (!anchor) {
      audit(perfil, 'virtus', 'debug', 'open_chat_anchor_not_found', { chatId, scrollTry: i+1 });
      continue;
    }
    
    const clicked = await smartAnchorClick(p, chatId);
    if (!clicked) {
      audit(perfil, 'virtus', 'debug', 'open_chat_anchor_click_fail', { chatId, scrollTry: i+1 });
      continue;
    }
    
    await sleep(500);
    
    // Verifica se apareceu tela de erro
    if (await isContentUnavailablePage(p)) {
      audit(perfil, 'virtus', 'warn', 'open_chat_content_unavailable_scroll', { chatId, scrollTry: i+1 });
      await goBackToInboxIfNeeded(p, perfil);
      await sleep(1000);
      try { await scrollChatsToTop(p, perfil); } catch {}
      await sleep(300);
      continue;
    }
    
    const tAssert1 = Date.now();
    const ok = await assertOnChatStrict(p, chatId, { timeoutMs: Math.min(timeoutMs, 6000) });
    try {
      const ids = await getOpenChatIdStrict(p);
      stepLog.appendJSONL(perfil, 'virtus', {
        step: 'assert_on_chat_end',
        chatId,
        ok: !!ok,
        byUrl: ids && ids.byUrl || null,
        byDom: ids && ids.byDom || null,
        tookMs: Date.now() - tAssert1
      });
    } catch {}
      if (ok) {
      audit(perfil, 'virtus', 'info', 'open_chat_click_ok_after_scroll', { chatId, scrollTry: i+1 });
      await ensureObserversInstalled(p, perfil).catch(()=>{});
        return true;
      }
    
    // Fallback via SPA se a UI não mudou
    const hardNav = await p.evaluate((id) => {
      const a = document.querySelector(`a[href^="/marketplace/t/${id}"], a[href^="/marketplace/v/${id}"], div[role="row"] a[href*="/marketplace/t/${id}"], div[role="row"] a[href*="/marketplace/v/${id}"]`);
      if (!a) return false;
      const href = a.getAttribute('href') || a.href || '';
      if (!href) return false;
      try { window.location.assign(href); return true; } catch { return false; }
    }, chatId).catch(()=>false);
    
    if (hardNav) {
      await sleep(1000);
      const okHard = await assertOnChatStrict(p, chatId, { timeoutMs: Math.min(timeoutMs, 6000) });
      if (okHard) {
        audit(perfil, 'virtus', 'info', 'open_chat_click_ok_hardnav_scroll', { chatId, scrollTry: i+1 });
        await ensureObserversInstalled(p, perfil).catch(()=>{});
        return true;
      }
    }
    
    // Se ainda falhou no scroll, tenta goBackToInboxIfNeeded + garantirMarketplace + retry
    if (!ok && !hardNav) {
      audit(perfil, 'virtus', 'warn', 'open_chat_ctx_mismatch_retry_scroll', { chatId, scrollTry: i+1 });
      await goBackToInboxIfNeeded(p, perfil);
      await sleep(1000);
      try {
        await garantirMarketplace(p, { nome: perfil, allowNavigate: true });
      } catch {}
      await sleep(500);
      const retryOk = await assertOnChatStrict(p, chatId, { timeoutMs: Math.min(timeoutMs, 6000) });
      if (retryOk) {
        audit(perfil, 'virtus', 'info', 'open_chat_click_ok_after_recovery_scroll', { chatId, scrollTry: i+1 });
        await ensureObserversInstalled(p, perfil).catch(()=>{});
        return true;
      }
    }
    
  }
  
  // PROIBIDO GOTO THREAD: Nenhum fallback por page.goto para threads
  audit(perfil, 'virtus', 'warn', 'open_chat_click_timeout', { chatId, motivo: 'ctx_mismatch_ou_timeout' });
  // Requeue com razão ctx_mismatch
  try {
    const reAt = Date.now() + 10000;
    await rescheduleJob(perfil, 'collect', chatId, reAt, { reason: 'ctx_mismatch' });
    audit(perfil, 'virtus', 'warn', 'open_chat_requeue_ctx_mismatch', { chatId, reAt: new Date(reAt).toISOString() });
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
        'div[role="main"] div[contenteditable="true"][role="textbox"]',
        'div[role="main"] div[contenteditable="true"][aria-label]',
        'div[role="main"] div[contenteditable="true"]',
        'div[role="main"] div[role="combobox"][contenteditable="true"]',
        'div[role="main"] div[aria-label="Mensagem"]',
        'div[role="main"] div[aria-label*="mensagem"]'
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
    audit(nome, 'virtus', 'warn', 'send_abort_no_composer', { chatId });
    await logIssue(nome, 'mil_action', `virtus_no_composer chat=${chatId}`);
    return false;
  }

  try {
    const urlNow = (typeof p.url === 'function') ? (p.url() || '') : '';
    if (!chatUrlMatches(urlNow, chatId)) {
      audit(nome, 'virtus', 'warn', 'send_abort_url_mismatch_before_type', { chatId, urlNow });
      await logIssue(nome, 'mil_action', `virtus_context_abort: url_mismatch_before_type chat=${chatId} url="${urlNow}"`);
      return false; // aborta o envio neste chat
    }
  } catch {}

  if (!(await assertOnChatStrict(p, chatId, { timeoutMs: 0 }))) {
    audit(nome, 'virtus', 'warn', 'send_abort_not_on_chat_before_type', { chatId });
    await logIssue(nome, 'mil_action', `virtus_context_abort: before_type (chat ${chatId})`);
    return false;
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
    const safeMsg = sanitizeOutgoing(toSend);
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
        audit(nome, 'virtus', 'warn', 'send_abort_url_mismatch_before_enter', { chatId, urlNow2 });
        await logIssue(nome, 'mil_action', `virtus_context_abort: url_mismatch_before_enter chat=${chatId} url="${urlNow2}"`);
        return false; // aborta o envio neste chat
      }
    } catch {}

    if (!(await assertOnChatStrict(p, chatId, { timeoutMs: 0 }))) {
      await clearComposerIfAny(p, campo);
      audit(nome, 'virtus', 'warn', 'send_abort_not_on_chat_before_enter', { chatId });
      await logIssue(nome, 'mil_action', `virtus_context_abort: before_enter (chat ${chatId})`);
      return false;
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
          audit(nome, 'virtus', 'error', 'send_failed_confirmation_retry_failed', { chatId });
          await logIssue(nome, 'virtus_send_failed', 'send_confirmation_failed_and_retry_failed');
          return false; // ABORTA — NÃO loga "enviado"
        }
        mensagemEnviada = true;
      } catch (e) {
        audit(nome, 'virtus', 'error', 'send_failed_confirmation_retry_exception', { chatId, error: (e && e.message) || String(e) });
        await logIssue(nome, 'virtus_send_failed', 'send_confirmation_retry_exception');
        return false; // ABORTA
      }
    }
    
    if (mensagemEnviada) {
      // NOVO: registra imediatamente a linha 'ia' no JSONL para blindar o histórico em disco
      try {
        await appendIaLine(nome, chatId, safeMsg);
      } catch {}
      audit(nome, 'virtus', 'info', 'send_ok', { chatId });
      return true;
    }

    audit(nome, 'virtus', 'error', 'send_failed_confirmation', { chatId, reason: 'no_confirmation' });
    return false;
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
    if (already) {
      await ensureFinalClosingMessage(perfil, chatId, 'pedido_already_marked');
      return;
    }

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

    await ensureFinalClosingMessage(perfil, chatId, 'from_finalizePedido_after_outbox');
    // Só limpa job collect, send final NUNCA deve ser apagado
    try { deleteJob(perfil, 'collect', chatId); } catch {}

    logger.info('[FINALIZE] Pedido concluído e notificado', { perfil, chatId, telefone: maskPhoneLog(tel) });
  } finally {
    getFinalizingSet(perfil).delete(chatId);
  }
}

// REMOVIDO: armFinalizationTimerIfNeeded - timers agora gerenciados por filas em disco

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

        // Instalar observers DOM event-driven
        if (page) {
          try {
            await installDomEventBridge(page, nome);
            await installInboxObserver(page);
            await installThreadObserver(page);
          } catch (e) {
            logger.warn('ensurePage: falha ao instalar observers', { nome }, e);
          }
        }

        return page;
      } catch (e) {
        logger.error('ensurePage falhou', { nome }, e);
        return null;
      }
    })();
    try { return await ensurePagePromise; }
    finally { ensurePagePromise = null; }
  }

  // Funções que dependem de ensurePage devem estar após sua definição
  async function runCollectForChat(nome, chatId) {
    const now = Date.now();
    // Early log
    audit(nome, 'virtus', 'info', 'collect_start', { chatId });
    
    try {
      const st0 = (() => { try { return virtusFSM.get(nome, chatId) || {}; } catch { return {}; } })();
      // Compatibilidade: lê tokenSig de campos legados se existir, senão usa feed.sig
      const tokenSig0 = String(
        (st0.schedule && st0.schedule.collect && st0.schedule.collect.tokenSig) ||
        (st0.cursor && st0.cursor.feed && (st0.cursor.feed.pendingSig || st0.cursor.feed.sig)) ||
        ''
      );

      const p = await ensurePage().catch(()=>null);
      if (!p) {
        const tries = incCollectFail(nome, chatId);
        const wait = (tries >= 3) ? COLLECT_FAIL_PAUSE_MS : (MIN_REQUEUE_MS + Math.floor(Math.random()*5000));
        const reAt = Date.now() + wait;
        await rescheduleJob(nome, 'collect', chatId, reAt, { reason: 'no_page', tries });
        audit(nome, 'virtus', 'warn', 'collect_requeue_no_page', { chatId, reAt, tries });
        if (tries >= 3) {
          audit(nome, 'virtus', 'warn', 'collect_pause_3_fails', { chatId, pauseMs: COLLECT_FAIL_PAUSE_MS });
        }
        return { status: 'requeued' };
      }

      // NAV_LOCK ativo do open ao assert/collect
      const navRes = await withNavLock(nome, async () => {
        await maybeGuaranteeMarketplaceFast(p, nome).catch(()=>{});
      const urlNow = (typeof p.url === 'function') ? (p.url() || '') : '';
      if (!chatUrlMatches(urlNow, chatId)) {
          stepLog.appendJSONL(nome, 'virtus', { step: 'open_chat_click_begin', chatId, ts: Date.now() });
          await openChatByClick(p, nome, chatId, { timeoutMs: 6000, retries: 1, scrollTries: 2 });
        }
        const ok = await assertOnChatStrict(p, chatId, { timeoutMs: 6000 }).catch(()=>false);
        if (!ok) return { ok: false, historico: [] };
        const hist = await extrairHistoricoConversa(p);
        return { ok: true, historico: hist };
      });

      if (!navRes || !navRes.ok) {
        const tries = incCollectFail(nome, chatId);
        const wait = (tries >= 3) ? COLLECT_FAIL_PAUSE_MS : (MIN_REQUEUE_MS + Math.floor(Math.random()*5000));
        const reAt = Date.now() + wait;
        await rescheduleJob(nome, 'collect', chatId, reAt, { reason: 'not_on_target', tries });
        audit(nome, 'virtus', 'warn', 'collect_requeue_not_on_target', { chatId, reAt, tries });
        if (tries >= 3) {
          audit(nome, 'virtus', 'warn', 'collect_pause_3_fails', { chatId, pauseMs: COLLECT_FAIL_PAUSE_MS });
        }
        return { status: 'requeued' };
      }

      // Extrair histórico e sanitizar
      const historicoConversa = navRes.historico || [];
      const historicoFiltered = (historicoConversa || []).filter(m => String(m && m.texto || '').trim() && String(m.texto).trim() !== 'Nenhuma mensagem encontrada.');
      const historicoSan = sanitizeHistoricoRecords(historicoFiltered, "");
      
      // Logs RAW/sanitized após sucesso
      stepLog.appendJSONL(nome, 'virtus', { step: 'collect_raw_count', chatId, rawCount: historicoConversa.length, ts: Date.now() });
      stepLog.appendJSONL(nome, 'virtus', { step: 'collect_sanitized_count', chatId, sanitizedCount: historicoSan.length, ts: Date.now() });
      
      if (!Array.isArray(historicoSan) || !historicoSan.length) {
        const tries = incCollectFail(nome, chatId);
        const wait = (tries >= 3) ? COLLECT_FAIL_PAUSE_MS : (MIN_REQUEUE_MS + Math.floor(Math.random()*5000));
        const reAt = Date.now() + wait;
        await rescheduleJob(nome, 'collect', chatId, reAt, { reason: 'no_messages', tries });
        audit(nome, 'virtus', 'warn', 'collect_requeue_no_messages', { chatId, reAt, tries });
        if (tries >= 3) {
          audit(nome, 'virtus', 'warn', 'collect_pause_3_fails', { chatId, pauseMs: COLLECT_FAIL_PAUSE_MS });
        }
        return { status: 'requeued' };
      }

      await appendChatHistoryLog(nome, chatId, historicoSan);
      stepLog.appendJSONL(nome, 'virtus', { step: 'collect_done', chatId, historicoCount: historicoSan.length, ts: Date.now() });

      // Locks/congelamento de 72h (compatibilidade: lê de freeze legado se existir)
      let fsmState = null; try { fsmState = virtusFSM.get(nome, chatId); } catch {}
      const finalLockUntil = (fsmState && fsmState.freeze && fsmState.freeze.finalizationUntil) 
        ? Number(fsmState.freeze.finalizationUntil) 
        : ((fsmState && fsmState.finalization && fsmState.finalization.lockUntil) ? Number(fsmState.finalization.lockUntil) : 0);
      if (finalLockUntil > Date.now()) {
        const clientMsgsLock = historicoSan.filter(m => m.autor === 'cliente');
        const lastClientTs = clientMsgsLock.length ? Number(clientMsgsLock[clientMsgsLock.length - 1].timestamp || 0) : 0;
        const clientCountLock = clientMsgsLock.length;
        const clientDigestLock = clientCountLock ? sha1(clientMsgsLock.slice(-10).map(m => normalizeContent(m.texto || '')).join('|')) : '';
        const uniqSeq = (list)=>{ const o=[]; let prev=''; for(const m of list){ const t=normalizeContent(m.texto||''); if(t && t!==prev) o.push(t); prev=t; } return o; };
        const contentSigLock = sha1(uniqSeq(clientMsgsLock).slice(-10).join('|'));
        const lastClientNormLock = clientCountLock ? normalizeContent(clientMsgsLock[clientCountLock - 1].texto || '') : '';
        await virtusFSM.patch(nome, chatId, {
          cursor: { client: { count: clientCountLock, digest: clientDigestLock, contentSig: contentSigLock, lastTs: lastClientTs || 0 } },
          data: { ...(fsmState && fsmState.data || {}), lastClientNorm: lastClientNormLock, lastClientTs: lastClientTs || Date.now() },
          lastScanAt: now
        });
        audit(nome, 'virtus', 'info', 'collect_skip_finalization_lock', { chatId, lockUntil: finalLockUntil });
        return { status: 'done' };
      }

      if (fsmState && fsmState.finalizado && !(finalLockUntil > Date.now())) {
        await virtusFSM.patch(nome, chatId, {
          finalizado: false,
          finalization: Object.assign({}, fsmState.finalization || {}, { unlockedAt: now }),
          freeze: Object.assign({}, fsmState.freeze || {}, { finalizationUntil: 0 })
        });
        fsmState = virtusFSM.get(nome, chatId);
      }

      if (!fsmState || !fsmState.discoveredAt) {
        await virtusFSM.patch(nome, chatId, { discoveredAt: Date.now() });
      }

      // REMOVIDO: armFinalizationTimerIfNeeded
      try { 
        const manifest = await manifestStore.read(nome).catch(()=>null);
        if (manifest && manifest.cidade) {
          // Prefetch já feito via manifest
        }
      } catch {}

      const clientMsgs = historicoSan.filter(m => m.autor === 'cliente');
      // Verificar se existe bolha de cliente recente (recentMsgSigs)
      const recentMsgSigs = (fsmState && fsmState.cursor && fsmState.cursor.client && Array.isArray(fsmState.cursor.client.recentMsgSigs)) ? fsmState.cursor.client.recentMsgSigs : [];
      if (!recentMsgSigs || recentMsgSigs.length === 0) {
        audit(nome, 'virtus', 'warn', 'collect_skip_no_recent_msgsig', { chatId });
        deleteJob(nome, 'collect', chatId);
        return { status: 'done' };
      }
      const lastClientTs = clientMsgs.length ? Number(clientMsgs[clientMsgs.length - 1].timestamp || 0) : 0;
      if (!lastClientTs || (Date.now() - lastClientTs) > MAX_CHAT_AGE_MS) {
        const clientCountAge = clientMsgs.length;
        const clientDigestAge = clientCountAge ? sha1(clientMsgs.slice(-10).map(m => normalizeContent(m.texto || '')).join('|')) : '';
        const uniqSeq = (list)=>{ const o=[]; let prev=''; for(const m of list){ const t=normalizeContent(m.texto||''); if(t && t!==prev) o.push(t); prev=t; } return o; };
        const clientContentSigAge = sha1(uniqSeq(clientMsgs).slice(-10).join('|'));
        const lastClientNormAge = clientCountAge ? normalizeContent(clientMsgs[clientCountAge - 1].texto || '') : '';
        await virtusFSM.patch(nome, chatId, {
          cursor: { client: { count: clientCountAge, digest: clientDigestAge, contentSig: clientContentSigAge, lastTs: lastClientTs || 0 } },
          data: { ...(fsmState && fsmState.data || {}), lastClientNorm: lastClientNormAge, lastClientTs: lastClientTs || Date.now() },
          lastScanAt: Date.now()
        });
        audit(nome, 'virtus', 'info', 'collect_skip_old_chat', { chatId, lastClientTs });
        return { status: 'done' };
      }

      // Cursor/digest/contentSig
      const clientCount = clientMsgs.length;
      const clientDigest = clientCount ? sha1(clientMsgs.slice(-10).map(m => normalizeContent(m.texto || '')).join('|')) : '';
      const uniqSeq = (list)=>{ const o=[]; let prev=''; for(const m of list){ const t=normalizeContent(m.texto||''); if(t && t!==prev) o.push(t); prev=t; } return o; };
      const clientContentSig = sha1(uniqSeq(clientMsgs).slice(-10).join('|'));
      const clientLastNorm = clientCount ? normalizeContent(clientMsgs[clientCount - 1].texto || '') : '';
      let prevCount = 0, prevDigest = '', prevContentSig = '', lastClientNormPrev = '';
      try {
        const st = virtusFSM.get(nome, chatId);
        prevCount = Number(st && st.cursor && st.cursor.client && st.cursor.client.count || 0);
        prevDigest = String(st && st.cursor && st.cursor.client && st.cursor.client.digest || '');
        prevContentSig = String(st && st.cursor && st.cursor.client && st.cursor.client.contentSig || '');
        lastClientNormPrev = String(st && st.data && st.data.lastClientNorm || '');
      } catch {}

      const changed = !!clientContentSig && clientContentSig !== prevContentSig;

      // Semântica (filtro) — como já estava no código
      const novasMsgs = (clientCount > prevCount) ? clientMsgs.slice(prevCount) : [clientMsgs[clientMsgs.length - 1]].filter(Boolean);
      const preFiltradas = (novasMsgs || []).filter(semanticallyRelevant);
      const novasFiltradas = preFiltradas.filter(m => {
        const t = normalizeContent(String(m && m.texto || ''));
        if (!t) return false;
        if (lastClientNormPrev && (nearEqual(t, lastClientNormPrev) || t.includes(lastClientNormPrev) || lastClientNormPrev.includes(t))) return false;
        return true;
      });
      if (!novasFiltradas.length) {
        await virtusFSM.patch(nome, chatId, {
          cursor: { client: { count: clientCount, digest: clientDigest, contentSig: clientContentSig, lastTs: lastClientTs } },
          data: { ...(fsmState && fsmState.data || {}), lastClientNorm: clientLastNorm, lastClientTs: lastClientTs || Date.now() },
          lastScanAt: Date.now()
        });
        audit(nome, 'virtus', 'info', 'coletado_skip_no_new', { chatId, contentSig: clientContentSig, prevContentSig });
        return { status: 'done' };
      }

      // Chama IA UMA ÚNICA VEZ
      const stateBefore = virtusFSM.get(nome, chatId) || {};
      const lockAcquired = await chatLock.acquire(nome, chatId, 30000);
      if (!lockAcquired) {
        await virtusFSM.patch(nome, chatId, {
          cursor: { client: { count: clientCount, digest: clientDigest, contentSig: clientContentSig, lastTs: lastClientTs } },
          data: { ...(stateBefore.data || {}), lastClientNorm: clientLastNorm, lastClientTs: lastClientTs || Date.now() },
          lastScanAt: Date.now()
        });
        audit(nome, 'virtus', 'info', 'collect_lock_skip', { chatId });
        return { status: 'done' };
      }

      // Dedup por contentSig: só processa se lastLlmSig ≠ contentSig OU lastLlmAt expirado
      const lastLlmSig = String(stateBefore.cursor && stateBefore.cursor.ia && stateBefore.cursor.ia.lastLlmSig || '');
      const lastLlmAt = Number(stateBefore.cursor && stateBefore.cursor.ia && stateBefore.cursor.ia.lastLlmAt || 0);
      const llmExpired = (Date.now() - lastLlmAt) > LLM_ATTEMPT_TTL_MS;
      
      if (!llmExpired && lastLlmSig && lastLlmSig === clientContentSig) {
        await virtusFSM.patch(nome, chatId, {
          cursor: { client: { count: clientCount, digest: clientDigest, contentSig: clientContentSig, lastTs: lastClientTs } },
          data: { ...(stateBefore.data || {}), lastClientNorm: clientLastNorm, lastClientTs: lastClientTs || Date.now() },
          lastScanAt: Date.now()
        });
        try { chatLock.release(nome, chatId); } catch {}
        audit(nome, 'virtus', 'info', 'llm_skip_duplicate', { chatId, contentSig: clientContentSig, lastLlmSig });
        return { status: 'done' };
      }

      let llmRes = null;
      try {
        audit(nome, 'virtus', 'info', 'enviado_llm_start', { chatId, msgs: historicoSan.length, contentSig: clientContentSig });
        llmRes = await masterExtractAnswer({ perfil: nome, chatId, mensagens: historicoSan, contexto: {}, respond: true });
        audit(nome, 'virtus', 'info', 'enviado_llm_ok', { chatId, askField: llmRes?.control?.askField||null, shouldReply: !!llmRes?.control?.shouldReply, tookMs: llmRes.meta && llmRes.meta.tookMs || null });
      } catch (e) {
        stepLog.appendJSONL(nome, 'virtus', { step: 'llm_call_error', chatId, error: (e && e.message) || String(e), ts: Date.now() });
        throw e;
      } finally {
        try { chatLock.release(nome, chatId); } catch {}
      }

      if (!llmRes) {
        audit(nome, 'virtus', 'warn', 'collect_skip_no_llm_res', { chatId });
        return { status: 'done' };
      }

      // Reset contador de falhas quando IA é chamada com sucesso
      resetCollectFail(nome, chatId);

      // Atualizar lastLlmSig e lastLlmAt após sucesso
      const mergedData = Object.assign({}, stateBefore.data || {}, { extraction: llmRes.extraction || {} });
      await virtusFSM.patch(nome, chatId, {
        data: mergedData,
        cursor: {
          ...(stateBefore.cursor || {}),
          ia: {
            ...(stateBefore.cursor && stateBefore.cursor.ia || {}),
            lastLlmSig: clientContentSig,
            lastLlmAt: Date.now()
          }
        }
      });

      appendMasterJSONL(nome, chatId, { kind: 'master_request', systemPromptLength: llmRes.meta && llmRes.meta.systemPromptLength || null, tokens: llmRes.meta && llmRes.meta.tokens || null, tookMs: llmRes.meta && llmRes.meta.tookMs || null });

      const extraction = llmRes.extraction || {};
      const tel = String(extraction.telefone || '').trim();
      const hasWhatsApp = isValidBRPhoneWithDDD(tel);
      const hasItem = !!(extraction.item && String(extraction.item).trim());
      const hasSaida = !!(extraction.endereco_saida && String(extraction.endereco_saida).trim());
      const hasDestino = !!(extraction.endereco_destino && String(extraction.endereco_destino).trim());

      if (hasWhatsApp && hasItem && hasSaida && hasDestino) {
        stepLog.appendJSONL(nome, 'virtus', { step: 'auto_finalize_all_fields_complete', chatId });
        await finalizePedido(nome, chatId, {});
        return { status: 'done' };
      }

      const shouldAnswer = !!(llmRes && llmRes.control && llmRes.control.shouldReply);
      let reply = (llmRes && llmRes.answer) ? String(llmRes.answer) : null;
      const lastClient = (novasFiltradas && novasFiltradas.length) ? novasFiltradas[novasFiltradas.length - 1] : null;
      if (reply && lastClient && lastClient.texto) reply = antiEchoReply(reply, lastClient.texto);

      if (shouldAnswer && reply) {
        const DEBOUNCE_MS = parseInt(process.env.VIRTUS_ASK_DEBOUNCE_MS || '45000', 10);
        const stateBeforeDebounce = virtusFSM.get(nome, chatId);
        const lastAskedField = (stateBeforeDebounce && stateBeforeDebounce.schedule && stateBeforeDebounce.schedule.lastAskedField) || null;
        const lastAskedAt = (stateBeforeDebounce && stateBeforeDebounce.schedule && stateBeforeDebounce.schedule.lastAskedAt) || 0;
        const askField = (llmRes && llmRes.control && llmRes.control.askField) || null;

        if (askField && lastAskedField === askField && (Date.now() - lastAskedAt) < DEBOUNCE_MS) {
          stepLog.appendJSONL(nome, 'virtus', { step: 'ask_debounce_skip', chatId, askField, sinceMs: Date.now() - lastAskedAt });
          await virtusFSM.patch(nome, chatId, { cursor: { client: { count: clientCount, digest: clientDigest, contentSig: clientContentSig, lastTs: lastClientTs } } });
          return { status: 'done' };
        }

        const cursorSig = `${clientCount}|${clientDigest}`;
        const queueResult = await queueMessengerSend(nome, {
          chatId,
          resposta: reply,
          key: `master|${chatId}|${sha1(reply)}|${Date.now()}`,
          earliestSendAt: undefined,
          origin: 'replyReady',
          cursorSig,
          lastClientTsOverride: lastClientTs
        });

        // Log após enfileirar (dueAt calculado dentro de queueMessengerSend)
        const dueAt = lastClientTs + WAIT_BEFORE_REPLY_MIN_MS + Math.floor(Math.random() * (WAIT_BEFORE_REPLY_MAX_MS - WAIT_BEFORE_REPLY_MIN_MS + 1));
        audit(nome, 'virtus', 'info', 'reply_enqueued', { chatId, dueAt: new Date(dueAt).toISOString(), cursorSig, status: queueResult && queueResult.status || 'unknown' });
        if (askField) await virtusFSM.patch(nome, chatId, { schedule: { ...(stateBeforeDebounce && stateBeforeDebounce.schedule || {}), lastAskedField: askField, lastAskedAt: Date.now() } });
        stepLog.appendJSONL(nome, 'virtus', { step: 'ciclo_final', chatId, status: 'respondido', hasReply: true, askField: askField || null, ts: Date.now() });
      } else {
        stepLog.appendJSONL(nome, 'virtus', { step: 'ciclo_final', chatId, status: 'atendido', hasReply: false, shouldReply: shouldAnswer, ts: Date.now() });
      }

      // Atualiza cursor
        await virtusFSM.patch(nome, chatId, {
          cursor: {
          ...(fsmState && fsmState.cursor || {}),
          client: { count: clientCount, digest: clientDigest, contentSig: clientContentSig, lastTs: lastClientTs }
        },
        data: { ...(fsmState && fsmState.data || {}), extraction: llmRes.extraction || {}, lastClientNorm: clientLastNorm, lastClientTs: lastClientTs || Date.now() },
          lastScanAt: Date.now()
        });

      return { status: 'done' };
    } catch (e) {
      const errorMsg = (e && e.message) || String(e);
      audit(nome, 'virtus', 'error', 'run_collect_error', { chatId, error: errorMsg });
      return { status: 'error', error: errorMsg };
    }
  }

  // Worker único que processa send e collect em disco
  function startJobScheduler(perfil, enviarRespostaMessengerSeguraFn) {
    if (filaEnvioTimers.has(perfil)) {
      audit(perfil, 'virtus', 'info', 'scheduler_init_skip', { reason: 'already_running' });
      return;
    }
    
    // Constantes do scheduler (usar globais definidas no topo)
    const SCHED_TICK_MS = Math.max(1000, parseInt(process.env.VIRTUS_SCHED_TICK_MS || '1000', 10));
    
    audit(perfil, 'virtus', 'info', 'scheduler_init', {});
    let heartbeatCounter = 0;
    const id = setInterval(async () => {
      try {
        const now = Date.now();
        
        // Heartbeat e Watchdog a cada 60s
        heartbeatCounter++;
        const heartbeatInterval = Math.floor(60000 / SCHED_TICK_MS);
        if (heartbeatCounter >= heartbeatInterval) {
          heartbeatCounter = 0;
          audit(perfil, 'virtus', 'info', 'scheduler_heartbeat', { ts: new Date(now).toISOString() });
          
          // Watchdog: monitora jobs atrasados, locks presos, backlog
          try {
            const jobs = listJobs(perfil);
            const overdueJobs = jobs.filter(f => {
              const j = loadJob(f);
              if (!j) return false;
              const overdue = Number(j.dueAt || 0) <= (now - 60000); // > 1min atrasado
              return overdue;
            });
            if (overdueJobs.length > 0) {
              audit(perfil, 'virtus', 'warn', 'watchdog_overdue_jobs', { count: overdueJobs.length, jobs: overdueJobs.slice(0, 5).map(f => { const j = loadJob(f); return { kind: j?.kind, chatId: j?.chatId, dueAt: j?.dueAt }; }) });
            }
            
            // Watchdog: locks presos (NAV_LOCKS) - força release se > 60s
            if (NAV_LOCKS.has(perfil) && NAV_LOCK_START_TIMES.has(perfil)) {
              const lockStart = NAV_LOCK_START_TIMES.get(perfil) || now;
              const lockDuration = now - lockStart;
              if (lockDuration > 60000) {
                audit(perfil, 'virtus', 'error', 'navlock_force_release', { stuckMs: lockDuration });
                // Força release do lock
                try {
                  const releaseFn = NAV_LOCK_RELEASES.get(perfil);
                  if (releaseFn) releaseFn();
                  NAV_LOCK_START_TIMES.delete(perfil);
                  NAV_LOCK_RELEASES.delete(perfil);
                  NAV_LOCKS.delete(perfil);
                } catch {}
              } else {
                audit(perfil, 'virtus', 'warn', 'watchdog_nav_lock_active', { durationMs: lockDuration });
              }
            }
            
            // Watchdog: send guards presos
            try {
              const p = await ensurePage().catch(()=>null);
              if (p) {
                const b = getBrowserFromPage(p);
                if (b && b._sendLock && b._sendLock.active && (now - (b._sendLock.since || 0)) > 120000) {
                  audit(perfil, 'virtus', 'warn', 'watchdog_send_guard_stuck', { chatId: b._sendLock.chatId, since: b._sendLock.since, stuckMs: now - (b._sendLock.since || 0) });
                }
              }
            } catch {}
            
            // Watchdog: backlog de filas (jobs acumulados)
            const sendJobs = jobs.filter(f => path.basename(f).startsWith('send_'));
            const collectJobs = jobs.filter(f => path.basename(f).startsWith('collect_'));
            if (sendJobs.length > 10 || collectJobs.length > 20) {
              audit(perfil, 'virtus', 'warn', 'watchdog_queue_backlog', { sendCount: sendJobs.length, collectCount: collectJobs.length });
            }
          } catch (e) {
            audit(perfil, 'virtus', 'error', 'watchdog_error', { error: (e && e.message) || String(e) });
          }
        }

        // PRIORIDADE: SEND
        const s = pickNextSend(perfil, now);
        if (s) {
          const { job } = s;
          
          // Throttle e in-flight control para SEND
          const inFlightSend = getInFlightSet(sendInFlightByPerfil, perfil);
          const lastSendMap = getAttemptMap(lastSendAttemptAtByPerfil, perfil);
          
          if (inFlightSend.has(job.chatId)) {
            stepLog.appendJSONL(perfil, 'virtus', { step: 'send_skip_inflight', chatId: job.chatId, ts: now });
            return;
          }
          
          audit(perfil, 'virtus', 'info', 'fila_envio_pick', { chatId: job.chatId, dueAt: new Date(job.dueAt).toISOString(), tries: job.payload?.__tries||0 });
          
          const resposta = String(job.payload?.resposta || '').trim();
          if (!resposta) { 
            audit(perfil, 'virtus', 'warn', 'send_drop_empty', { chatId: job.chatId });
            deleteJob(perfil, 'send', job.chatId); 
            return; 
          }
          
          inFlightSend.add(job.chatId);
          lastSendMap.set(job.chatId, now);
          
          setNavIntent(perfil, { kind: 'send', chatId: job.chatId, jobReady: true, dueAt: job.dueAt });
          try {
          const ok = await enviarRespostaMessengerSeguraFn(job.chatId, resposta);
          if (ok) {
            await virtusFSM.ackSent(perfil, job.chatId, job.payload?.cursorSig || '');
              audit(perfil, 'virtus', 'info', 'enviado_usuario_ok', { chatId: job.chatId, cursorSig: job.payload?.cursorSig||'' });
            deleteJob(perfil, 'send', job.chatId);
          } else {
            // retry limitado disco
            job.payload = job.payload || {};
            job.payload.__tries = 1 + Number(job.payload.__tries || 0);
            if (job.payload.__tries > 2) {
                audit(perfil, 'virtus', 'error', 'enviado_usuario_fail', { chatId: job.chatId, tries: job.payload.__tries });
              deleteJob(perfil, 'send', job.chatId);
            } else {
                const next = Date.now() + SEND_REQUEUE_MIN_MS;
                audit(perfil, 'virtus', 'warn', 'send_requeue', { chatId: job.chatId, next: new Date(next).toISOString(), tries: job.payload.__tries });
                await rescheduleJob(perfil, 'send', job.chatId, next, job.payload);
            }
            }
          } finally {
            setNavIntent(perfil, null);
            inFlightSend.delete(job.chatId);
          }
          return;
        }

        // COLETA
        const c = pickNextCollect(perfil, now);
        if (c) {
          const { job } = c;
          
          // Throttle e in-flight control para COLLECT
          const inFlightCollect = getInFlightSet(collectInFlightByPerfil, perfil);
          const lastCollectMap = getAttemptMap(lastCollectAttemptAtByPerfil, perfil);
          
          if (inFlightCollect.has(job.chatId)) {
            stepLog.appendJSONL(perfil, 'virtus', { step: 'collect_skip_inflight', chatId: job.chatId, ts: now });
            return;
          }
          
          const lastC = lastCollectMap.get(job.chatId) || 0;
          if (now - lastC < COLLECT_THROTTLE_MS) {
            stepLog.appendJSONL(perfil, 'virtus', { step: 'collect_skip_throttle', chatId: job.chatId, sinceMs: now-lastC, minMs: COLLECT_THROTTLE_MS, ts: now });
            return;
          }
          
          audit(perfil, 'virtus', 'info', 'collect_pick', { chatId: job.chatId, dueAt: new Date(job.dueAt).toISOString() });
          
          inFlightCollect.add(job.chatId);
          lastCollectMap.set(job.chatId, now);
          
          setNavIntent(perfil, { kind: 'collect', chatId: job.chatId, jobReady: true, dueAt: job.dueAt });
          try {
            const result = await runCollectForChat(perfil, job.chatId).catch(e => ({ status: 'error', error: e && e.message || String(e) }));
            
            if (result && result.status === 'done') {
              audit(perfil, 'virtus', 'info', 'coletado_exec_ok', { chatId: job.chatId });
            } else if (result && result.status === 'requeued') {
              audit(perfil, 'virtus', 'info', 'coletado_exec_ok', { chatId: job.chatId, requeued: true });
            } else {
              audit(perfil, 'virtus', 'info', 'collect_done_scheduler', { chatId: job.chatId, status: result && result.status || 'unknown' });
            }
            
            if (result && result.status === 'requeued') {
              audit(perfil, 'virtus', 'info', 'collect_keep_job_requeued', { chatId: job.chatId, reason: 'requeued' });
            } else if (result && result.status === 'error') {
              // Sempre reschedule em caso de erro, nunca drop
              const tries = incCollectFail(perfil, job.chatId);
              const wait = (tries >= 3) ? COLLECT_FAIL_PAUSE_MS : (MIN_REQUEUE_MS + Math.floor(Math.random()*5000));
              const reAt = Date.now() + wait;
              await rescheduleJob(perfil, 'collect', job.chatId, reAt, { reason: 'error', tries, error: result.error });
              audit(perfil, 'virtus', 'warn', 'collect_requeue_error', { chatId: job.chatId, next: new Date(reAt).toISOString(), tries, error: result.error });
              if (tries >= 3) {
                audit(perfil, 'virtus', 'warn', 'collect_pause_3_fails', { chatId: job.chatId, pauseMs: COLLECT_FAIL_PAUSE_MS });
              }
            } else {
          deleteJob(perfil, 'collect', job.chatId);
            }
          } finally {
            setNavIntent(perfil, null);
            inFlightCollect.delete(job.chatId);
          }
        }
      } catch (e) {
        logger.warn('[JOB_SCHEDULER] erro', { perfil, error: (e && e.message) || String(e) });
      }
    }, SCHED_TICK_MS);
    filaEnvioTimers.set(perfil, id);
  }

  // REMOVIDO: bumpRecoverBackoff, resetRecoverBackoff - não mais utilizados

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

  // REMOVIDO: coletaChatsMarketplaceRecentes - não mais utilizado

  // REMOVIDO: getCollectTimerMap, getSlaWatchdogMap, clearCollectTimer, clearSlaWatchdog - agora usando filas em disco


  // REMOVIDO: timersFechamento, dadosColetados, pedidosEnviados, enviarPedidoParaNotificador, enviarMensagemFinal
  // Toda lógica de business agora gerenciada pelo virtusFSM

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
            await sleep(2500); continue;
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

        // [REMOVIDO: Handler de localização — localização vem do manifest]
      } catch (err) {
        if (!running) return;
        logger.error('Falha ao garantir aba zero no startup Virtus', { nome }, err);
        await sleep(2500);
      }
    }
    if (!running || !epochOk()) return;
    
    // Define função no escopo amplo do runner (antes de qualquer try)
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
        
        // NAV_LOCK e verificação de contexto antes de enviar
        try {
          const sendSuccess = await withNavLock(nome, async () => {
        await waitForSendLockRelease(p, 30000);
        await acquireSendGuard(p, chatId);
        try {
              // Verifica contexto antes de qualquer manipulação
            urlNow = (p && typeof p.url === 'function') ? (p.url() || '') : '';
              const { byUrl, byDom } = await getOpenChatIdStrict(p);
              const okUrl = chatUrlMatches(urlNow, chatId);
              const okDom = (byDom && byDom === String(chatId)) || false;
              
              if (okUrl && okDom) {
                audit(nome, 'virtus', 'info', 'send_context_verified', { chatId });
              } else {
                // Não está no chat correto, abre via clique
                audit(nome, 'virtus', 'info', 'send_nav', { chatId, reason: 'not_on_target_opening' });
                stepLog.appendJSONL(nome, 'virtus', { step: 'send_nav_open', chatId, urlNow, byDom, ts: Date.now() });
                await openChatByClick(p, nome, chatId, { timeoutMs: 7000, retries: 1, scrollTries: 2 });
                
                // Verifica novamente após abrir
                const okOn = await assertOnChatStrict(p, chatId, { timeoutMs: 6000 });
          if (!okOn) {
                  audit(nome, 'virtus', 'error', 'send_nav_fail', { chatId, reason: 'could_not_open' });
            throw new Error('chat_not_opened');
                }
          }
          
              // Agora está no chat correto, busca composer
          let campo = await waitForComposer(p, 10000);
          if (!campo) {
                const anchorSel = `a[href^="/marketplace/t/${chatId}"], a[href^="/marketplace/v/${chatId}"]`;
            campo = await refocusComposerNoReload(p, chatId, anchorSel);
          }
          
          if (!campo) {
                audit(nome, 'virtus', 'error', 'send_composer_fail', { chatId });
            throw new Error('composer_not_available');
          }
          
          hasComposer = true;
          await campo.focus();
          await new Promise(r => setTimeout(r, 120));
          
              // Verifica contexto novamente antes de enviar
              const finalCheck = await assertOnChatStrict(p, chatId, { timeoutMs: 6000 });
              if (finalCheck) {
                audit(nome, 'virtus', 'info', 'send_context_verified', { chatId });
              } else {
                audit(nome, 'virtus', 'error', 'send_context_lost', { chatId });
            throw new Error('context_lost');
          }
          
          await waitForSendLockRelease(p, 12000);
          await acquireSendGuard(p, chatId);
          try {
                const ok = await sendMessageSafe(p, campo, String(resposta || ''), nome, chatId);
                if (ok) {
          virtusFSM.flowLog(nome, chatId, 'send_ok', {
            attempts: attempt,
            url: urlNow,
            hasComposer: true,
            cursorSig: ''
          });
          return true;
                }
              } finally {
                releaseSendGuard(p);
              }
              return false;
            } finally {
              releaseSendGuard(p);
            }
          });
          
          if (sendSuccess) {
            return true;
          }
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
        } finally {
          releaseSendGuard(p);
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
    
    // Inicializa notificador (dentro de try separado)
    try {
      await fazerHandshakeNotificador(nome);
      if (NOTIFICADOR_OUTBOUND) {
      }
        
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
    } catch (e) {
      logger.warn('[NOTIFICADOR] falha init filas/handshake (modo legado)', { nome, error: e && e.message || e });
    }
    
    // REMOVIDO: resumeTimers - timers agora gerenciados pelo virtusFSM
    
    // Logs iniciais
    audit(nome, 'virtus', 'info', 'virtus_start', {});
    audit(nome, 'virtus', 'info', 'notificador_handshake', { outbound: NOTIFICADOR_OUTBOUND });
    
    // Inicia o scheduler único (apenas uma vez)
    startJobScheduler(nome, enviarRespostaMessengerSeguraLocal);
    audit(nome, 'virtus', 'info', 'virtus_scheduler_started', {});
    
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

function __dumpQueuesState(perfil) {
  try {
    const jobs = listJobs(perfil);
    const sendJobs = [];
    const collectJobs = [];
    const now = Date.now();
    
    for (const f of jobs) {
      const j = loadJob(f);
      if (!j) continue;
      const due = Number(j.dueAt || 0);
      const overdue = due <= now;
      const info = {
        chatId: j.chatId,
        kind: j.kind,
        dueAt: due,
        dueAtISO: new Date(due).toISOString(),
        overdue,
        overdueMs: overdue ? (now - due) : 0,
        tries: j.payload?.__tries || 0,
        reason: j.payload?.reason || null
      };
      if (j.kind === 'send') sendJobs.push(info);
      if (j.kind === 'collect') collectJobs.push(info);
    }
    
    sendJobs.sort((a, b) => a.dueAt - b.dueAt);
    collectJobs.sort((a, b) => a.dueAt - b.dueAt);
    
    return {
      perfil,
      ts: now,
      send: { total: sendJobs.length, overdue: sendJobs.filter(j => j.overdue).length, jobs: sendJobs },
      collect: { total: collectJobs.length, overdue: collectJobs.filter(j => j.overdue).length, jobs: collectJobs }
    };
  } catch (e) {
    return { perfil, error: (e && e.message) || String(e), ts: Date.now() };
  }
}

module.exports = {
  startVirtus,
  markPedidoSent,
  __dumpQueuesState,
  queueMessengerSend,
  getPendingSet
};