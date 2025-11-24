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
const { patchPage, ensureMinimizedWindowForPage } = require('./browser.js');
const utils = require('./utils.js');
const stepLog = require('./stepLog.js');
const chatLock = require('./chatLock.js');
const logger = require('./logger.js');
const manifestStore = require('./manifestStore.js');

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

const { chatCompletion } = require('./inteligenciaArtificial.js');
const promptFretes = require('./promptFretes.js');

const VIRTUS_INPUT_LOCKS = new Map();
function setVirtusInputLock(nome, v){ if (v) VIRTUS_INPUT_LOCKS.set(nome,true); else VIRTUS_INPUT_LOCKS.delete(nome); }
function isVirtusLocked(nome){ return VIRTUS_INPUT_LOCKS.has(nome); }

function getBrowserFromPage(p) { try { return typeof p.browser === 'function' ? p.browser() : null; } catch { return null; } }
async function acquireSendGuard(p, chatId) { try { const b = getBrowserFromPage(p); if (b) b._sendLock = { active: true, owner: 'virtus', chatId, since: Date.now() }; } catch {} }
function releaseSendGuard(p) { try { const b = getBrowserFromPage(p); if (b && b._sendLock && b._sendLock.owner === 'virtus') b._sendLock.active = false; } catch {} }


function chatLogPath(perfil, chatId) {
  return path.join(__dirname, '..', 'dados', 'perfis', perfil, 'chats', `${chatId}.jsonl`);
}

async function appendChatHistoryLog(perfil, chatId, historicoArr) {
  try {
    const file = chatLogPath(perfil, chatId);
    const st = await getChatState(perfil, chatId).catch(()=>null);
    const lastTs = st && st.chatLogLastTs || 0;
    const novos = (historicoArr||[]).filter(m => Number(m.timestamp||0) > lastTs);
    if (!novos.length) return;
    const buf = CHAT_LOG_BUFFERS.get(file) || [];
    for (const m of novos) buf.push(JSON.stringify(m) + '\n');
    CHAT_LOG_BUFFERS.set(file, buf);
    const maxTs = Math.max(...novos.map(m=>Number(m.timestamp||0)));
    await setChatState(perfil, chatId, { chatLogLastTs: maxTs || Date.now() });
    scheduleChatLogFlush();
  } catch {}
}

async function appendIaLine(perfil, chatId, texto) {
  const obj = { autor:'ia', texto:String(texto||''), timestamp: Date.now() };
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

  const aguard = getSetAguardando(nomePerfil);
  try { aguard.add(dadosChat.chatId); } catch {}

  setTimeout(() => enviarLoteNotificador(nomePerfil), NOTIFICADOR_ENVIO_LOTE_MS);
}

async function enviarLoteNotificador(nomePerfil) {
  const fila = filaEnviarNotificador.get(nomePerfil) || [];
  if (fila.length === 0) return;
  const lote = fila.splice(0); // pega todos

  await Promise.all(lote.map(async (dadosChat) => {
    try {
      const payload = {
        servidor: NOTIFICADOR_SERVIDOR,
        chat_id: dadosChat.chatId,
        perfil: nomePerfil,
        tipo_servico: dadosChat.tipoServico,
        historico: dadosChat.historico || [], // TODO o histórico da conversa
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
        fila.push(dadosChat);
    }
  } catch (e) {
      logger.error('[NOTIFICADOR] Falha ao enviar chat', { nomePerfil, chatId: dadosChat.chatId, error: e && e.message || e });
      fila.push(dadosChat);
    }
  }));

  if (filaEnviarNotificador.get(nomePerfil).length > 0) {
    setTimeout(() => enviarLoteNotificador(nomePerfil), NOTIFICADOR_ENVIO_LOTE_MS);
  }
}

function iniciarPollingRespostas(nomePerfil) {
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
          
          if (!filaEnvioMessenger.has(nomePerfil)) filaEnvioMessenger.set(nomePerfil, []);
          filaEnvioMessenger.get(nomePerfil).push({ 
            chatId: resp.chat_id, 
            resposta: respostaSan, 
            key 
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

    try {
      const respostaFinal = String(proximo.resposta || '').trim();
      
      if (enviarRespostaMessengerSeguraFn) {
        await enviarRespostaMessengerSeguraFn(proximo.chatId, respostaFinal);
      }
      ultimaRespostaMessenger.set(nomePerfil, Date.now());

      if (marcarRespondidoFn) {
        await marcarRespondidoFn(proximo.chatId);
      } else {
        await marcarRespondido(nomePerfil, proximo.chatId);
      }
      
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
      
      try { const setA = getSetAguardando(nomePerfil); setA.delete(proximo.chatId); } catch {}

      try {
        if (proximo.key) {
          const setPend = getPendingSet(nomePerfil);
          setPend.delete(proximo.key);
          logger.debug('[MESSENGER] Chave dedup liberada', { nomePerfil, chatId: proximo.chatId, key: proximo.key });
        }
      } catch {}

      logger.info('[MESSENGER] Resposta enviada', { nomePerfil, chatId: proximo.chatId });
    } catch (e) {
      logger.error('[MESSENGER] Erro ao enviar resposta', { nomePerfil, chatId: proximo.chatId, error: e && e.message || e });
      
      try {
        if (proximo.key) {
          const setPend = getPendingSet(nomePerfil);
          setPend.delete(proximo.key);
          logger.debug('[MESSENGER] Chave dedup liberada após erro', { nomePerfil, chatId: proximo.chatId, key: proximo.key });
        }
      } catch {}
    }
  }, 2000);

  filaEnvioTimers.set(nomePerfil, id);
}

async function marcarRespondido(nomePerfil, chatId) {
  try {
    const agoraTs = agoraEpoch();
    const HIST_FILE = HIST_JSON_NAME(nomePerfil);
    let historicoLocal = {};
    try { historicoLocal = await readJson(HIST_FILE, {}); } catch {}
    historicoLocal[chatId] = agoraTs;
    await writeJsonAtomicFsync(HIST_FILE, historicoLocal);
  } catch (e) {
    logger.error('[VIRTUS] marcarRespondido error', { nomePerfil, chatId, error: e && e.message || e });
  }
}

async function extrairUrlClassificado(page, chatId) {
  try {
    const url = await page.evaluate(() => {
      const fixAbsolute = (h) => (h && h.startsWith('http')) ? h : (h ? ('https://www.facebook.com' + h) : null);
      const anchors = Array.from(document.querySelectorAll('a'));
      for (const a of anchors) {
        const href = a.getAttribute('href') || a.href || '';
        if (href && href.includes('/marketplace/item/')) {
          if (!href.includes('/marketplace/t/')) return fixAbsolute(href);
        }
      }
      for (const a of anchors) {
        const href = a.getAttribute('href') || a.href || '';
        if (href && href.includes('/marketplace/') && !href.includes('/marketplace/t/') && !href.includes('/marketplace/profile/')) {
          return fixAbsolute(href);
        }
      }
      return null;
    });
    return url || null;
  } catch { return null; }
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
          const txt = (r.innerText || r.textContent || '').trim();
          if (!txt) continue;

          let isMine = false;
          try {
            const st = window.getComputedStyle(r);
            if (st && (st.justifyContent === 'flex-end' || st.textAlign === 'right')) {
              isMine = true;
            }
          } catch {}

          const n = norm(txt);
          if (/\b(you\s+sent|voc[eê]\s+enviou)\b/i.test(n)) isMine = true;

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

          const textoLimpo = txt.replace(/^(você\s+enviou|you\s+sent)[:\s]*/i, '').trim();
          if (!textoLimpo) continue;

          out.push({
            texto: textoLimpo,
            autor: isMine ? 'ia' : 'cliente',
            timestamp: ts || Date.now()
          });
        } catch {}
      }

      out.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
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

const HIST_JSON_NAME = c => path.join(__dirname, '../dados/perfis', c, 'chats_respondidos.json');

const CHAT_STATE_FILE = (perfil) => path.join(__dirname, '../dados/perfis', perfil, 'chats_state.json');

const fileLocks = new Map(); // file -> { pid, timestamp }

async function acquireFileLock(file, timeoutMs = 5000) {
  const lockFile = file + '.lck';
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
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

const PROBE_RECHECK_MIN_MS = parseInt(process.env.VIRTUS_PROBE_RECHECK_MIN_MS || '60000', 10);  // mínimo entre enfileiramentos (anti-flood), default 60s
const PROBE_FORCE_OPEN_MS  = parseInt(process.env.VIRTUS_PROBE_FORCE_OPEN_MS  || '300000', 10); // forçar abertura do chat após X ms, default 5min


const NOTIFICADOR_URL = process.env.NOTIFICADOR_URL || 'https://c0nv3n13nt3t3cn0l0g14jesus.sa.ngrok.io';
const NOTIFICADOR_SERVIDOR = process.env.SERVIDOR_NOME || 'servidor1';

const NOTIFICADOR_ENVIO_LOTE_MS = parseInt(process.env.NOTIFICADOR_ENVIO_LOTE_MS || '10000', 10); // 10s
const NOTIFICADOR_POLLING_MS = parseInt(process.env.NOTIFICADOR_POLLING_MS || '1100', 10);
const MESSENGER_INTERVALO_MIN_MS = parseInt(process.env.MESSENGER_INTERVALO_MIN_MS || '30000', 10); // 30s
const MESSENGER_INTERVALO_MAX_MS = parseInt(process.env.MESSENGER_INTERVALO_MAX_MS || '60000', 10); // 60s

const filaEnviarNotificador = new Map();  // nomePerfil -> [ { chatId, tipoServico, mensagem, localizacao, urlClassificado } ]
const filaRespostas = new Map();          // nomePerfil -> [ { chat_id, resposta } ]
const filaEnvioMessenger = new Map();     // nomePerfil -> [ { chatId, resposta, key } ]
const ultimaRespostaMessenger = new Map();// nomePerfil -> timestamp
const aguardandoRespostaMap = new Map();  // nomePerfil -> Set(chatId)
const pollingIntervals = new Map();       // nomePerfil -> intervalId
const filaEnvioTimers = new Map();        // nomePerfil -> intervalId
const handshakesFeitos = new Set();       // Set(nomePerfil)

const pendingKeysPorPerfil = new Map(); // nomePerfil -> Set(keys)

function getPendingSet(perfil) {
  if (!pendingKeysPorPerfil.has(perfil)) pendingKeysPorPerfil.set(perfil, new Set());
  return pendingKeysPorPerfil.get(perfil);
}



const PENDING_JSON_NAME = c => path.join(__dirname, '../dados/perfis', c, 'chats_pending.json');

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
async function pendingAdd(perfil, chatId, attemptId) {
  const file = PENDING_JSON_NAME(perfil);
  const cur = await readJson(file, {});
  cur[chatId] = { attemptId, startedAt: Date.now() };
  await writeJsonAtomicFsync(file, cur);
}
async function pendingDel(perfil, chatId) {
  const file = PENDING_JSON_NAME(perfil);
  const cur = await readJson(file, {});
  if (cur[chatId]) { delete cur[chatId]; await writeJsonAtomicFsync(file, cur); }
}
async function pendingList(perfil) {
  const file = PENDING_JSON_NAME(perfil);
  return await readJson(file, {});
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
  if (/messenger.com\/marketplace/i.test(url)) {
    const ok = await page.evaluate(() => !!document.querySelector('a[href^="/marketplace/t/"]') || !!document.querySelector('div[role="row"]')).catch(()=>false);
    if (ok) return true;
  }
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
  
  try {
    const b = getBrowserFromPage(page);
    if (b && b._sendLock && b._sendLock.active) {
      logger.info('[VIRTUS][garantirMarketplace] sendLock ativo — não navegar/não recarregar.', nome ? { nome } : {});
      return;
    }
  } catch {}
  
  if (/messenger.com\/marketplace\/t\//i.test(urlNow)) {
    logger.info('[VIRTUS][garantirMarketplace] já está em página de chat — não navegar.', nome ? { nome } : {});
    return;
  }
  
  async function gotoInboxRobust(route) {
    try {
      logger.info(`[VIRTUS][garantirMarketplace] Tentando rota: ${route}`, nome ? { nome } : {});
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
        logger.info(`[VIRTUS][garantirMarketplace] UI pronta na rota: ${route}`, nome ? { nome } : {});
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
        logger.info('[VIRTUS][garantirMarketplace] UI já pronta na página atual');
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

    const toSend = String(msg || '');
    await p.keyboard.type(toSend, { delay: 0 });

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

    const expected = String(msg || '').trim();
    const before = await getMySentSnapshot(p);
    logger.debug('[MESSENGER] Snapshot antes do envio', { nome, chatId, beforeTotal: before.total });

    await p.keyboard.press('Enter');
    logger.debug('[MESSENGER] Enter pressionado, aguardando confirmação robusta', { nome, chatId });

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
      const composerEmpty = await p.evaluate(() => {
        const composers = Array.from(document.querySelectorAll('div[contenteditable="true"][role="textbox"]'));
        for (const comp of composers) {
          const txt = (comp.innerText || comp.textContent || '').trim();
          if (txt.length === 0) return true;
        }
        return false;
      }).catch(() => false);
      
      if (composerEmpty) {
        logger.warn('[MESSENGER] ⚠️ Confirmação robusta falhou, mas composer vazio (mensagem provavelmente enviada)', { 
          nome, 
          chatId,
          beforeTotal: before.total
        });
        mensagemEnviada = true; // Assume que enviou
      } else {
        logger.error('[MESSENGER] ❌ FALHA: mensagem não enviada (composer não vazio)', { 
          nome, 
          chatId,
          beforeTotal: before.total
        });
        await logIssue(nome, 'virtus_send_failed', 'send_confirmation_robust_timeout');
      }
    }
    
    if (mensagemEnviada) {
      logger.info('[MESSENGER] ✅ Mensagem confirmada (robusta ou composer vazio)', {
        nome,
        chatId,
        beforeTotal: before.total,
        metodo: sent ? 'contagem_aumentou_texto_coincide' : 'composer_vazio_fallback'
      });
    }

    if (mensagemEnviada) {
      try {
        await setChatState(nome, chatId, {
          state: CHAT_STATES.AGUARDANDO,
          lastIATs: Date.now()
        });
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
  let fila = [];
  let historico = {};
  let chatAtivo = null;

  const HIST_FILE = HIST_JSON_NAME(nome);
  const NO_REPEAT_WINDOW_SEC = 72 * 3600; // 72h de bloqueio hardcoded para blindagem absoluta antiflood
  const POLL_INTERVAL_MS = parseInt(process.env.VIRTUS_POLL_MS || '1000', 10);
  const MIN_REPLY_DELAY_MS = 0;
  const MAX_REPLY_DELAY_MS = 0;

  const RESP_CACHE_MAX = 5000;
  function setResponded(id, ts) {
    if (!respondedCache.has(id) && respondedCache.size >= RESP_CACHE_MAX) {
      const first = respondedCache.keys().next().value;
      if (first !== undefined) respondedCache.delete(first);
    }
    respondedCache.set(id, ts);
  }
  const respondedCache = new Map();

  const lastProbeMap = new Map(); // chatId -> Date.now() da última prova/checagem
  const lastClientTsMap = new Map(); // chatId -> ms do último cliente visto (memória local, opcional)

  function tsNum(x) {
    if (!x) return 0;
    const n = typeof x === 'number' ? x : Date.parse(x);
    return Number.isFinite(n) ? n : 0;
  }

  let filaInterval = null;
  let filaChatTimer = null;
  let scrollInterval = null; // Militar: cleaning interval to prevent interval leak

  let lastScrollToTop = 0;

  let saveChain = Promise.resolve();
  let filaLoopBusy = false;
  let recoverBackoffMs = 0;
  const failCounts = new Map();
  function setFailCount(chatId, n) {
    if (!failCounts.has(chatId) && failCounts.size >= 1000) {
      const first = failCounts.keys().next().value;
      if (first !== undefined) failCounts.delete(first);
    }
    failCounts.set(chatId, n);
  }

  async function salvaHistorico() {
    saveChain = saveChain.then(async () => {
      try {
        await fs.mkdir(path.dirname(HIST_FILE), { recursive: true });
        const tmp = HIST_FILE + '.tmp';
        const fd = await fs.open(tmp, 'w');
        try {
          await fd.writeFile(JSON.stringify(historico, null, 2), 'utf8');
          await fd.sync();
        } finally { await fd.close(); }
        try { await fs.unlink(HIST_FILE); } catch {}
        try { await fs.rename(tmp, HIST_FILE); }
        catch { await fs.copyFile(tmp, HIST_FILE); try { await fs.unlink(tmp); } catch {} }
      } catch (e) {
        logger.error('Erro ao salvar histórico Virtus', { nome }, e);
      }
    }).catch(err => logger.error('Erro em cadeia de salvamento Virtus', { nome }, err));
    return saveChain;
  }

  async function carregaHistorico() {
    try {
      const tmp = HIST_FILE + '.tmp';
      try { await fs.access(HIST_FILE); }
      catch {
        if (await fs.access(tmp).then(()=>true).catch(()=>false)) {
          try { await fs.rename(tmp, HIST_FILE); }
          catch { await fs.copyFile(tmp, HIST_FILE); try { await fs.unlink(tmp);} catch{} }
        }
      }
      const txt = await fs.readFile(HIST_FILE, 'utf-8');
      historico = JSON.parse(txt);
    } catch {
      historico = {};
    }
    respondedCache.clear();
    const agora = agoraEpoch();
    for (const id of Object.keys(historico)) {
      const ts = Number(historico[id]) || 0;
      if (ts && (agora - ts) < NO_REPEAT_WINDOW_SEC) {
        setResponded(id, ts);
      }
    }
  }

  function limpaHistoricoVelho() {
    let mudanca = false;
    const agora = agoraEpoch();
    Object.keys(historico).forEach(id => {
      const ts = Number(historico[id]) || 0;
      if (!ts || (agora - ts) >= NO_REPEAT_WINDOW_SEC) {
        delete historico[id];
        respondedCache.delete(id);
        mudanca = true;
        log(`Histórico limpo: ${id} removido (>24h)`);
      }
    });
    while (respondedCache.size > RESP_CACHE_MAX) {
      const first = respondedCache.keys().next().value;
      if (first !== undefined) respondedCache.delete(first);
      mudanca = true;
    }
    return mudanca;
  }

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
          if (st && (st.state === CHAT_STATES.AGUARDANDO || st.state === CHAT_STATES.ENVIADO)) {
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
        logger.info(`[VIRTUS][${nome}] timeout curto aguardando anchors/rows`);
      }

      const todos = await coletaChatsMarketplaceTodos(p);
      logger.info(`[VIRTUS][${nome}] coletaTodos: ${todos.length} itens`);

      const idsColetados = new Set(todos.map(c => c.id));
      for (const chatRespondido of chatsRespondidosParaVerificar) {
        if (!idsColetados.has(chatRespondido.id)) {
          todos.push(chatRespondido);
          logger.info(`[VIRTUS][${nome}] Chat já respondido adicionado para verificação: ${chatRespondido.id}`);
        }
      }

      return todos;
    } catch (err) {
      logger.error(`[VIRTUS][${nome}] Erro em coletaChatsMarketplaceRecentes(): ${(err && err.message) || err}`, {}, err);
      return [];
    }
  }

  async function reconcilePendingsIfAny() {
    if (!running || !epochOk()) return;
    try {
      const pend = await pendingList(nome);
      const keys = Object.keys(pend||{});
      if (!keys.length) return;
      const p = await ensurePage();
      if (!p) return;
      for (const chatId of keys) {
        const rec = pend[chatId] || {};
        const age = Date.now() - (rec.startedAt || 0);
        if (age < 8*60*1000) continue; // deixa “aquecendo” 8min antes de reconciliar
        try {
          if (!running || !epochOk()) return;
          const urlNow = (typeof p.url === 'function') ? (p.url() || '') : '';
          if (!chatUrlMatches(urlNow, chatId)) {
            continue; // Skip se não está no chat correto (sem navegação)
          }
          const looksSent = await wasRecentlySentByMe(p, 10*60*1000);
          if (looksSent) {
            const tsNow = agoraEpoch();
            historico[chatId] = tsNow;
            setResponded(chatId, tsNow);
            await salvaHistorico();
            await pendingDel(nome, chatId);
          } else {
            await pendingDel(nome, chatId);
          }
        } catch {  }
      }
    } catch {}
  }

  async function initHistoricoSePreciso() {
    if (!running || !epochOk()) return;
    
    const FIRST_BOOT_SNAPSHOT = (process.env.VIRTUS_FIRST_BOOT_SNAPSHOT ?? '0') === '1';
    
    try {
      await fs.access(HIST_FILE);
      await carregaHistorico();
      await reconcilePendingsIfAny();
      logger.info('[SNAPSHOT] Histórico existente carregado. Retomando pendentes <24h.', { nome });
      return;
    } catch {}

    if (!FIRST_BOOT_SNAPSHOT) {
      logger.info('[SNAPSHOT] Modo seguro: não marcando recents como respondidos no primeiro boot. (Defina VIRTUS_FIRST_BOOT_SNAPSHOT=1 para habilitar)', { nome });
      await carregaHistorico();
      await reconcilePendingsIfAny();
      return;
    }

    logger.info('[SNAPSHOT] Primeiro boot sem histórico. Coletando chats >=24h para marcar como respondidos.', { nome });
    if (!running || !epochOk()) return;
    const p = await ensurePage();
    if (!p) { logger.warn('[SNAPSHOT] Falha ao garantir aba zero.', { nome }); return; }
    if (!running || !epochOk()) return;
    await maybeGuaranteeMarketplaceFast(p, nome);
    await maybeGuaranteeMarketplaceFast(p, nome);
    try {
      await Promise.race([
        p.waitForSelector('a[href^="/marketplace/t/"]', { timeout: 8000 }),
        p.waitForSelector('div[role="row"] span', { timeout: 8000 })
      ]);
    } catch {}
    const todos = await coletaChatsMarketplaceTodos(p);
    const agora = agoraEpoch();
    historico = {};
    for (const chat of todos) historico[chat.id] = agora;
    await salvaHistorico();
    await carregaHistorico();
    await reconcilePendingsIfAny();
    logger.info(`[SNAPSHOT] Concluído. ${todos.length} chats marcados como respondidos no primeiro boot.`, { nome });
  }


  async function atualizaFila() {
    let mudancaFila = false;
    const chatsNovos = await coletaChatsMarketplaceRecentes();
    logger.info(`[FILA][${nome}] recebidos da coleta: ${chatsNovos.length}`);

    const aguard = getSetAguardando(nome);
    const agoraMs = Date.now();
    const ERROR_TTL_MS = parseInt(process.env.VIRTUS_ERROR_TTL_MS || '1800000', 10); // 30min padrão

    let pLimitImport;
    try {
      pLimitImport = require('p-limit');
    } catch {
      pLimitImport = null;
    }
    const pLimit = pLimitImport && (pLimitImport.default || pLimitImport);
    const limit = pLimit ? pLimit(8) : (fn) => fn();

    await Promise.all(chatsNovos.map(c => limit(async () => {
      const id = c.id;

      let st = null;
      try { st = await getChatState(nome, id); } catch {}
      const jaFoiRespondido = st && (st.state === CHAT_STATES.AGUARDANDO || st.state === CHAT_STATES.ENVIADO);
      
      if (jaFoiRespondido) {
        if (aguard.has(id)) {
          logger.info(`[FILA][${nome}] skip ${id} — aguardando resposta do notificador`);
          return;
        }
        if (fila.includes(id)) {
          logger.info(`[FILA][${nome}] skip ${id} — já está na fila`);
          return;
        }
        fila.push(id);
        lastProbeMap.set(id, agoraMs);
        logger.info(`[FILA][${nome}] Chat já respondido re-enfileirado para verificar novas mensagens: ${id}`);
        mudancaFila = true;
        return;
      }

      if (fila.includes(id)) {
        logger.info(`[FILA][${nome}] skip ${id} — já está na fila aguardando processamento`);
        return;
      }
      
      const last = lastProbeMap.get(id) || 0;

      const lastProbeAt = (st && typeof st.lastProbeAt === 'number') ? st.lastProbeAt : 0;
      const forceOpen = (!st) || (agoraMs - lastProbeAt >= PROBE_FORCE_OPEN_MS);
      
      if (
        !forceOpen &&
        st &&
        typeof st.lastCLIts === 'number' &&
        typeof st.ultimoProbeCLIts === 'number' &&
        st.lastCLIts === st.ultimoProbeCLIts
      ) {
        lastProbeMap.set(id, agoraMs);
        logger.info(`[FILA][${nome}] skip ${id} — sem avanço (lastCLIts==ultimoProbeCLIts) e TTL < ${PROBE_FORCE_OPEN_MS}ms`);
        return;
      }
      
      if (st && st.state === 'erro_envio') {
        logger.info(`[FILA][${nome}] ${id} estava em erro_envio — será testado novamente (fila permissiva).`);
      }

      if (aguard.has(id)) {
        logger.info(`[FILA][${nome}] skip ${id} — aguardando resposta do notificador`);
        return;
      }
      if (fila.includes(id)) {
        logger.info(`[FILA][${nome}] skip ${id} — já está na fila aguardando processamento`);
        return;
      }

      try {
        await setChatState(nome, id, {
          state: CHAT_STATES.PENDENTE,
          createdAt: Date.now(),
          lastProbeAt: Date.now() // NOVO: registramos a última sondagem
        });
      } catch {}

      try {
        const man = await manifestStore.read(nome).catch(()=>null);
        const cid = man && man.cidade || null;
        if (cid) {
          await setChatState(nome, id, { perfilCidade: String(cid) });
        }
      } catch {}

      fila.push(id);
      lastProbeMap.set(id, agoraMs);
      logger.info(`[FILA][${nome}] Candidato ${id} enfileirado (${c.tempo})`);
      mudancaFila = true;
    })));

    if (mudancaFila) {
      logger.info(`[FILA][${nome}] Atualizada: ${fila.length} chats pendentes`);
    }
    return mudancaFila;
  }

  function scheduleNextIfIdle() {
    if (!running) {
      logger.debug('[FILA] Sistema não está rodando', { nome });
      return;
    }
    if (chatAtivo) {
      logger.debug('[FILA] Chat ativo, aguardando...', { nome, chatAtivo });
      return;
    }
    if (filaChatTimer) {
      logger.debug('[FILA] Timer já agendado, aguardando...', { nome, filaChatTimer });
      return;
    }
    if (!fila.length) {
      logger.debug('[FILA] Fila vazia', { nome });
      return;
    }

    const next = fila.shift(); // Remove da fila imediatamente
    if (!next) {
      logger.warn('[FILA] Chat removido da fila mas era null/undefined', { nome });
      return;
    }
    
    chatAtivo = next;

    const delayMs = (() => {
      const env = process.env.VIRTUS_NEXT_CHAT_DELAY_MS;
      if (typeof scheduleNextIfIdle._firstRun === 'undefined') {
        scheduleNextIfIdle._firstRun = false;
        return 0; // roda o primeiro chat imediatamente
      }
      const parsed = parseInt(env, 10);
      return Number.isFinite(parsed) ? parsed : 0;
    })();
    logger.info('[FILA] Preparando atendimento do próximo chat', { nome, chatId: next, delay: delayMs, filaRestante: fila.length });
    filaChatTimer = setTimeout(async () => {
      try {
        filaChatTimer = null; // Limpa timer imediatamente
        
        if (!running || !epochOk()) {
          chatAtivo = null; // Libera chatAtivo
          fila.unshift(next); // Re-enfileira
          logger.warn('[FILA] Sistema não está rodando ou epoch inválido, re-enfileirando', { nome, chatId: next });
          return;
        }
        
        if (chatAtivo !== next) {
          logger.warn('[FILA] Chat ativo mudou, re-enfileirando', { nome, chatId: next, chatAtivo });
          fila.unshift(next); // Re-enfileira no início
          return scheduleNextIfIdle();
        }
        
        stepLog.appendJSONL(nome, 'virtus', { attempt: attId, step: 'schedule_reply', chatId: next });
      await responderChat(next);
        
        chatAtivo = null;
        
        setTimeout(scheduleNextIfIdle, Math.max(200, delayMs));
      } catch (e) {
        filaChatTimer = null;
        chatAtivo = null; // Libera chatAtivo em caso de erro
        logger.error('[FILA] Erro no timer de atendimento', { nome, chatId: next, error: e && e.message || e, stack: e && e.stack });
        fila.unshift(next);
        setTimeout(scheduleNextIfIdle, Math.max(200, delayMs));
      }
    }, delayMs);
  }

  async function responderChat(chatId) {
    logger.info('[RESPONDER] Iniciando responderChat', { nome, chatId, filaLength: fila.length, chatAtivo });
    
    let _chatLockAcquired = false;
    try {
      if (!running || !epochOk()) {
        logger.warn('[RESPONDER] Sistema não está rodando ou epoch inválido', { nome, chatId, running, epochOk: epochOk() });
        return;
      }
      const responderStartedAt = Date.now();
    let manifestFrozenUntil = 0;
    try {
      const manifest = await manifestStore.read(nome);
      manifestFrozenUntil = typeof manifest?.frozenUntil === 'number' ? manifest.frozenUntil : 0;
    } catch {}
    if (manifestFrozenUntil && manifestFrozenUntil > Date.now()) {
      running = false;
      if (filaInterval) clearInterval(filaInterval), filaInterval = null;
      if (filaChatTimer) clearTimeout(filaChatTimer), filaChatTimer = null;
      if (scrollInterval) clearInterval(scrollInterval), scrollInterval = null;
      logger.warn(`[VIRTUS][${nome}] virtus_stop_frozen window — congelado até ${new Date(manifestFrozenUntil).toISOString()}`, { nome });
      return;
    }
      if (VIRTUS_DETAILED_DEBUG) { log(`[DETAILED] Início responderChat: ${chatId}`); }
      if (!browser || browser.isConnected?.() === false) {
        logger.error(`[VIRTUS][${nome}] Browser morto/desconectado — encerrando Virtus`, { nome });
        if (issues) try { await logIssue(nome, 'virtus_page_dead', 'browser morto/disconnected'); } catch {}
        running = false;
        if (filaInterval) clearInterval(filaInterval), filaInterval = null;
        if (filaChatTimer) clearTimeout(filaChatTimer), filaChatTimer = null;
        if (scrollInterval) clearInterval(scrollInterval), scrollInterval = null;
        return;
      }
      let p = await ensurePage();
      if (!p || (p.isClosed && p.isClosed())) {
        logger.error(`[VIRTUS][${nome}] Page fechada/desconectada — encerrando Virtus`, { nome });
        if (issues) try { await logIssue(nome, 'virtus_page_dead', 'page closed/disconnected'); } catch {}
        running = false;
        if (filaInterval) clearInterval(filaInterval), filaInterval = null;
        if (filaChatTimer) clearTimeout(filaChatTimer), filaChatTimer = null;
        if (scrollInterval) clearInterval(scrollInterval), scrollInterval = null;
        return;
      }
      if (!chatId) {
        logger.warn('[RESPONDER] chatId inválido', { nome, chatId });
        chatAtivo = null; // Libera chatAtivo antes de retornar
        return;
      }

      if (chatAtivo && chatAtivo !== chatId) {
        logger.warn('[RESPONDER] Outro chat já está sendo processado (chatAtivo)', { nome, chatId, chatAtivo });
        return;
      }
      
      chatAtivo = chatId;

      logger.info('[RESPONDER] Tentando adquirir lock', { nome, chatId });
      
      if (!chatLock.acquire(nome, chatId)) {
        logger.warn('[RESPONDER] Falha ao adquirir lock - tentando forçar liberação', { nome, chatId });
        try {
          chatLock.release(nome, chatId);
          await new Promise(r => setTimeout(r, 100));
          if (chatLock.acquire(nome, chatId)) {
            logger.info('[RESPONDER] Lock adquirido após forçar liberação', { nome, chatId });
            _chatLockAcquired = true;
          } else {
            logger.warn('[RESPONDER] Falha ao adquirir lock mesmo após forçar liberação', { nome, chatId });
        stepLog.appendJSONL(nome, 'virtus', { step: 'skip_locked', chatId, attempt: attId });
            stepLog.appendJSONL(nome, 'virtus', { step: 'chat_lock_busy', chatId, attempt: attId });
            try { await logIssue(nome, 'chat_lock_busy', `Falha ao adquirir lock para chat ${chatId} mesmo após forçar liberação`); } catch {}
            fila = fila.filter(id => id !== chatId);
            return;
          }
        } catch (e) {
          logger.error('[RESPONDER] Erro ao tentar forçar liberação de lock', { nome, chatId, error: e && e.message || e });
          stepLog.appendJSONL(nome, 'virtus', { step: 'skip_locked', chatId, attempt: attId });
        stepLog.appendJSONL(nome, 'virtus', { step: 'chat_lock_busy', chatId, attempt: attId });
        try { await logIssue(nome, 'chat_lock_busy', `Falha ao adquirir lock para chat ${chatId}`); } catch {}
        fila = fila.filter(id => id !== chatId);
        return;
      }
      } else {
      _chatLockAcquired = true;
        logger.info('[RESPONDER] Lock adquirido com sucesso', { nome, chatId });
      }
      
      try {
        await setChatState(nome, chatId, { lastProbeAt: Date.now() });
      } catch {}
      lastProbeMap.set(chatId, Date.now());
      
      logger.info('[CONTEXTO] Iniciando processamento', { nome, chatId });
      stepLog.appendJSONL(nome, 'virtus', { step: 'chat_lock_ok', chatId, attempt: attId });

      try {
        await setChatState(nome, chatId, { state: CHAT_STATES.PENDENTE });
      } catch {}

      const attemptId2 = stepLog.attemptId();
      try { await pendingAdd(nome, chatId, attemptId2); } catch {}

      chatAtivo = chatId;

      try {
        p = await ensurePage();
        if (!p) {
          try { await pendingDel(nome, chatId); } catch {}
          fila = fila.filter(id => id !== chatId);
          chatAtivo = null;
          return;
        }
        if (!running || !epochOk()) { try { await pendingDel(nome, chatId); } catch {} fila = fila.filter(id => id !== chatId); chatAtivo = null; return; }
        logger.info('[NAVEGACAO] Garantindo Marketplace UI', { nome, chatId });
        await maybeGuaranteeMarketplaceFast(p, nome);
        logger.info('[NAVEGACAO] Marketplace UI garantida', { nome, chatId });

        let urlNow = (typeof p.url === 'function') ? (p.url() || '') : '';
        if (!chatUrlMatches(urlNow, chatId)) {
          logger.info('[NAVEGACAO] Abrindo chat pela primeira vez', { nome, chatId });
        let anchorSel = `a[href^="/marketplace/t/${chatId}"]`;
        await scrollChatsToTop(p, nome).catch(()=>{});
        await sleep(300);
        let found = await p.$(anchorSel);

          if (found) {
            try {
        await p.evaluate((sel) => {
          const el = document.querySelector(sel);
                if (el) el.scrollIntoView({ behavior: 'instant', block: 'center', inline: 'center' });
        }, anchorSel);
              await Promise.race([
                p.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 15000 }).catch(()=>{}),
                (async () => { await p.$eval(anchorSel, el => el.click()); })()
              ]);
              await sleep(1000); // Aguarda navegação
            } catch (e) {
              logger.warn('[NAVEGACAO] Falha ao clicar no anchor, tentando goto direto', { nome, chatId, error: e && e.message || e });
            }
          }
          
          urlNow = (typeof p.url === 'function') ? (p.url() || '') : '';
          if (!chatUrlMatches(urlNow, chatId)) {
            try {
              await p.goto(`https://www.messenger.com/marketplace/t/${chatId}/`, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(()=>{});
              await sleep(1000);
              urlNow = (typeof p.url === 'function') ? (p.url() || '') : '';
            } catch (e) {
              logger.warn('[NAVEGACAO] Falha ao navegar para o chat', { nome, chatId, error: e && e.message || e });
            }
          }
          
          if (!chatUrlMatches(urlNow, chatId) || !(await assertOnChat(p, chatId, { timeoutMs: 2000 }))) {
            logger.warn('[VIRTUS] Não foi possível abrir o chat. Abortando atendimento.', { nome, chatId, urlNow });
            const prev = await getChatState(nome, chatId).catch(()=>null);
            const attempts = (prev && prev.sendAttempts ? prev.sendAttempts : 0) + 1;
            await setChatState(nome, chatId, {
              state: CHAT_STATES.AGUARDANDO,
              sendAttempts: attempts,
              cooldownUntil: Date.now() + Math.min(60000, 20000 * attempts),
              lastProbeAt: Date.now()
            });
          try { await pendingDel(nome, chatId); } catch {}
          fila = fila.filter(id => id !== chatId);
          chatAtivo = null;
          return;
          }
        } else {
          if (!(await assertOnChat(p, chatId, { timeoutMs: 0 }))) {
            logger.warn('[VIRTUS] Contexto do chat não corresponde. Abortando atendimento.', { nome, chatId, urlNow });
            const prev = await getChatState(nome, chatId).catch(()=>null);
            const attempts = (prev && prev.sendAttempts ? prev.sendAttempts : 0) + 1;
            await setChatState(nome, chatId, {
              state: CHAT_STATES.AGUARDANDO,
              sendAttempts: attempts,
              cooldownUntil: Date.now() + Math.min(60000, 20000 * attempts),
              lastProbeAt: Date.now()
            });
            try { await pendingDel(nome, chatId); } catch {}
            fila = fila.filter(id => id !== chatId);
            chatAtivo = null;
            return;
          }
        }

        if (await isChatBlocked(p)) {
          logger.info('[SKIP] Chat bloqueado/indisponível', { nome, chatId });
          logger.warn('Chat bloqueado/indisponível, marcado respondido', { nome, chatId });
          try { await pendingDel(nome, chatId); } catch {}
          try { await logIssue(nome, 'virtus_blocked', `chat ${chatId} bloqueado/indisponível`); } catch {}
          fila = fila.filter(id => id !== chatId);
          chatAtivo = null;
          resetFail(chatId);
          return;
        }

        if (!(await assertOnChat(p, chatId, { timeoutMs: 1200 }))) {
          try { await pendingDel(nome, chatId); } catch {}
          fila = fila.filter(id => id !== chatId);
          chatAtivo = null;
          await logIssue(nome, 'mil_action', `virtus_context_abort: url divergiu antes do envio (chat ${chatId})`);
          return;
        }

        let campo = await waitForComposer(p, 10000);
        if (!campo) {
          logger.info('[COMPOSER] Composer não encontrado, tentando refocus sem reload', { nome, chatId });
          const campo2 = await refocusComposerNoReload(p, chatId, anchorSel);
          if (campo2) {
            campo = campo2;
            logger.info('[COMPOSER] Refocus bem-sucedido', { nome, chatId });
          } else {
            logger.warn('[COMPOSER] indisponível (sem reload) — agendando cooldown', { nome, chatId });
            const prev = await getChatState(nome, chatId).catch(()=>null);
            const attempts = (prev && prev.sendAttempts ? prev.sendAttempts : 0) + 1;
            await setChatState(nome, chatId, {
              state: CHAT_STATES.AGUARDANDO,
              sendAttempts: attempts,
              cooldownUntil: Date.now() + Math.min(60000, 20000 * attempts),
              ultimoProbeCLIts: Date.now(),
              lastProbeAt: Date.now()
            });
            try { await pendingDel(nome, chatId); } catch {}
            fila = fila.filter(id => id !== chatId);
            chatAtivo = null;
            return;
          }
        }

            resetFail(chatId);

        const urlClassificado = await extrairUrlClassificado(p, chatId);

        let localizacao = null;
        try {
          const stLoc = await getChatState(nome, chatId);
          if (stLoc && stLoc.cidade && stLoc.estado) {
            localizacao = { cidade: stLoc.cidade, estado: stLoc.estado };
            logger.info('[LOCALIZACAO] Localização recuperada do cache', { 
              nome, 
              chatId, 
              cidade: localizacao.cidade, 
              estado: localizacao.estado 
            });
          } else {
            localizacao = await new Promise((resolve) => {
              try {
                const buscador = (global && global.__buscaLocalizacaoVirtus) ? global.__buscaLocalizacaoVirtus : null;
                if (buscador && typeof buscador.adicionarBuscaLocalizacao === 'function' && urlClassificado) {
                  buscador.adicionarBuscaLocalizacao(chatId, urlClassificado, nome, resolve);
                } else {
                  resolve(null);
                }
              } catch { resolve(null); }
            });
            if (localizacao && localizacao.cidade && localizacao.estado) {
              try {
                await setChatState(nome, chatId, {
                  cidade: localizacao.cidade,
                  estado: localizacao.estado
                });
              } catch {}
            }
          }
        } catch {
          localizacao = null;
        }

        if (localizacao && localizacao.cidade && localizacao.estado) {
          logger.info('[LOCALIZACAO] Localização encontrada', { 
            nome, 
            chatId, 
            cidade: localizacao.cidade, 
            estado: localizacao.estado 
          });
        } else {
          logger.warn('[LOCALIZACAO] Localização NÃO encontrada', { nome, chatId, urlClassificado });
        }

        const tipoServico = await identificarTipoServico(nome);

        try {
          await setChatState(nome, chatId, { state: CHAT_STATES.GERANDO });
        } catch {}

        logger.info('[COLETA] Iniciando coleta de histórico', { nome, chatId });
        const historicoConversa = await extrairHistoricoConversa(p);
        
        await appendChatHistoryLog(nome, chatId, historicoConversa);
        
        logger.info('[COLETA] Histórico coletado', { 
          nome, 
          chatId, 
          totalMensagens: historicoConversa.length,
          mensagensCliente: historicoConversa.filter(m => m.autor === 'cliente').length,
          mensagensIA: historicoConversa.filter(m => m.autor === 'ia').length
        });


        const stPrev = await getChatState(nome, chatId).catch(()=>null);

        const ultimaIA = (() => {
          const iaMsgs = historicoConversa.filter(m => m.autor === 'ia');
          return iaMsgs.length ? iaMsgs[iaMsgs.length - 1] : null;
        })();

        const ultimaCliente = (() => {
          const cli = historicoConversa.filter(m => m.autor === 'cliente');
          return cli.length ? cli[cli.length - 1] : null;
        })();

        const pAtual = await ensurePage().catch(()=>null);

        {
          try {
            logger.info('[CONTEXTO] Chamando Groq API', {
              nome,
              chatId,
              historicoLength: Array.isArray(historicoConversa) ? historicoConversa.length : 0
            });
            
            let cidadePreferida = null;
            try {
              const man = await manifestStore.read(nome).catch(()=>null);
              cidadePreferida = (man && man.cidade) ? man.cidade : null;
            } catch {}
            if (!cidadePreferida && localizacao && localizacao.cidade) {
              cidadePreferida = localizacao.cidade;
            }

            if (Date.now() - responderStartedAt > 30000) {
              await setChatState(nome, chatId, { state: 'erro_envio', erroTimestamp: Date.now() });
              logger.warn('[RESPOSTA] Deadline por chat excedido — abortando com erro_envio', { nome, chatId });
              return;
            }
            
            const domain = promptFretes;
            
            const systemPrompt = domain.buildSystemPrompt();
            const userPrompt = domain.buildUserPrompt({ cidade: cidadePreferida, historico: historicoConversa });
            
            let parsed;
            try {
              const modelRawResp = await chatCompletion({ system: systemPrompt, user: userPrompt, provider: 'groq' });
              parsed = domain.parseModelAnswerToDomain(modelRawResp);
            } catch (e) {
              logger.error('[GROQ] Erro ao chamar IA ou parsear resposta', { nome, chatId, error: e && e.message || e });
            try { await pendingDel(nome, chatId); } catch {}
              fila = fila.filter(id => id !== chatId);
              chatAtivo = null;
              return;
            }

            atualizarDadosColetados(chatId, {
              cidade: cidadePreferida || null,
              telefone: parsed.telefone_extraido || null,
              dados: parsed.dados || {}
            });


            const pAtual = await ensurePage().catch(() => null);
            if (!pAtual) {
              logger.warn('[GROQ] Page indisponível', { nome, chatId });
              await setChatState(nome, chatId, { state: 'erro_envio', erroTimestamp: Date.now() });
              try { await pendingDel(nome, chatId); } catch {}
          fila = fila.filter(id => id !== chatId);
          chatAtivo = null;
          return;
        }

            let urlNow = (typeof pAtual.url === 'function') ? (pAtual.url() || '') : '';
            if (!chatUrlMatches(urlNow, chatId) || !(await assertOnChat(pAtual, chatId, { timeoutMs: 0 }))) {
              logger.warn('[GROQ] URL/contexto não corresponde (sem navegação). Cooldown.', { nome, chatId, urlNow });
              const prev = await getChatState(nome, chatId).catch(()=>null);
              const attempts = (prev && prev.sendAttempts ? prev.sendAttempts : 0) + 1;
              await setChatState(nome, chatId, {
                state: CHAT_STATES.AGUARDANDO,
                sendAttempts: attempts,
                cooldownUntil: Date.now() + Math.min(60000, 20000 * attempts),
                lastProbeAt: Date.now()
              });
    try { await pendingDel(nome, chatId); } catch {}
    fila = fila.filter(id => id !== chatId);
    chatAtivo = null;
    return;
  }

            let campoEnvio = await waitForComposer(pAtual, 10000);
            if (!campoEnvio) {
              logger.info('[GROQ] Composer não encontrado, tentando refocus', { nome, chatId });
              campoEnvio = await refocusComposerNoReload(pAtual, chatId, anchorSel);
            }

            if (!campoEnvio) {
              logger.warn('[GROQ] Composer indisponível após refocus - marcando cooldown', { nome, chatId });
              const prev = await getChatState(nome, chatId).catch(()=>null);
              const attempts = (prev && prev.sendAttempts ? prev.sendAttempts : 0) + 1;
              await setChatState(nome, chatId, {
                state: 'erro_envio',
                erroTimestamp: Date.now(),
                sendAttempts: attempts,
                cooldownUntil: Date.now() + Math.min(60000, 20000 * attempts),
                ultimoProbeCLIts: Date.now(),
                lastProbeAt: Date.now()
              });
              try { await pendingDel(nome, chatId); } catch {}
              fila = fila.filter(id => id !== chatId);
              chatAtivo = null;
              return;
            }

            const respostaFinal = String(parsed.resposta || '').trim();
            
            try {
              await setChatState(nome, chatId, { state: CHAT_STATES.ENVIANDO });
            } catch {}

            await acquireSendGuard(pAtual, chatId);
            try {
              await setChatState(nome, chatId, {
                ultimaRespostaEnviada: respostaFinal,
                lastProbeAt: Date.now()
              });
              
              await sendMessageSafe(pAtual, campoEnvio, respostaFinal, nome, chatId);
              await appendIaLine(nome, chatId, respostaFinal);
              
              await marcarRespondido(nome, chatId);
              
              // Se finalizado, processa finalização (IA já validou)
              if (parsed.finalizado === true) {
                try {
                  // Cancela timer se existir
                  if (timersFechamento.has(chatId)) {
                    cancelarTimerFechamento(chatId);
                  }
                  
                  // Verifica se já foi enviado (anti-duplicidade)
                  if (!pedidosEnviados.has(chatId)) {
                    await enviarPedidoParaNotificador(chatId, {
                      cidade: cidadePreferida || null,
                      telefone: parsed.telefone_extraido,
                      ...parsed.dados
                    });
                    pedidosEnviados.add(chatId);
                    await enviarMensagemFinal(chatId);
                    await setChatState(nome, chatId, { state: CHAT_STATES.FINALIZADO });
                  }
                } catch (e) {
                  logger.error('[FINALIZACAO] Erro ao finalizar chat', { nome, chatId, error: e && e.message || e });
                }
              }
            } finally {
              releaseSendGuard(pAtual);
            }

            try {
              await setChatState(nome, chatId, {
                lastIATs: Date.now(),
                lastProbeAt: Date.now(),
                state: CHAT_STATES.AGUARDANDO
              });
        } catch {}

            logger.info('[GROQ] Resposta enviada com sucesso', { chatId, finalizado: parsed.finalizado, tel: parsed.telefone_extraido });
          } catch (e) {
            logger.error('[GROQ] Falha no fluxo direto', { chatId, error: e && e.message || e });
            try {
              const prev = await getChatState(nome, chatId);
              const attempts = (prev && prev.sendAttempts ? prev.sendAttempts : 0) + 1;
              const baseMin = 2; // 2min base
              const nextMs = Math.min(5 * 60 * 1000, Math.pow(2, attempts - 1) * baseMin * 60 * 1000); // max 5min

              if (attempts >= 3) {
                await setChatState(nome, chatId, {
                  state: 'erro_envio',
                  sendAttempts: attempts,
                  erroTimestamp: Date.now(),
                  ultimoProbeCLIts: Date.now()
                });
                await logIssue(nome, 'virtus_send_failed', `erro_envio após ${attempts} tentativas (chat ${chatId})`);
              } else {
                await setChatState(nome, chatId, {
                  state: CHAT_STATES.AGUARDANDO,
                  sendAttempts: attempts,
                  cooldownUntil: Date.now() + nextMs,
                  ultimoProbeCLIts: Date.now()
                });
                await logIssue(nome, 'virtus_send_failed', `retry_schedule attempt=${attempts} in=${Math.round(nextMs/1000)}s chat=${chatId}`);
              }
            } catch {}
            try { await pendingDel(nome, chatId); } catch {}
            fila = fila.filter(id => id !== chatId);
            chatAtivo = null;
            return;
          }
        }
        
        {
          const localizacaoFormatada = formatarLocalizacaoParaPlanilha(localizacao);

          adicionarChatParaEnvio(nome, {
            chatId,
            tipoServico,
            historico: historicoConversa, // TODO o histórico da conversa
            localizacao: localizacaoFormatada,
            urlClassificado
          });

        }

        try { await pendingDel(nome, chatId); } catch {}
        fila = fila.filter(id => id !== chatId);
        chatAtivo = null;
        
        try { 
          await setChatState(nome, chatId, { lastProbeAt: Date.now() }); 
        } catch {}

      } catch (err) {
        const msgErr = (err && err.message) ? err.message : String(err);
        if (/Target closed|Protocol error.*Target closed|Session closed/i.test(msgErr)) {
          try { await logIssue(nome, 'browser_disconnected', `chat ${chatId}: target/page closed during send`); } catch {}
        } else {
          try { await logIssue(nome, 'virtus_send_failed', `chat ${chatId}: ${msgErr}`); } catch {}
        }
        logger.error('Erro ao responder chat', { nome, chatId }, err);
        try { await pendingDel(nome, chatId); } catch {}
        try { 
          await setChatState(nome, chatId, { lastProbeAt: Date.now() }); 
        } catch {}
      }

      fila = fila.filter(id => id !== chatId);
      if (VIRTUS_DETAILED_DEBUG) { log(`[DETAILED] ChatId ${chatId} removido da fila e finalizado.`); }
    } finally {
      if (chatAtivo === chatId) {
        chatAtivo = null;
        logger.info('[RESPONDER] chatAtivo liberado no finally', { nome, chatId });
      }
      
      try { 
        chatLock.release(nome, chatId);
      if (_chatLockAcquired) {
          logger.info('[RESPONDER] Lock liberado no finally', { nome, chatId });
        } else {
          logger.debug('[RESPONDER] Tentativa de liberar lock no finally (não estava adquirido)', { nome, chatId });
        }
      } catch (e) {
        logger.warn('[RESPONDER] Erro ao liberar lock no finally', { nome, chatId, error: e && e.message || e });
      }
      
      if (_chatLockAcquired) {
        stepLog.appendJSONL(nome, 'virtus', { attempt: attId, step: 'chat_unlock', chatId });
      }
      
      try { await pendingDel(nome, chatId); } catch {}
      resetFail(chatId); // limpa failCounts quando fim do ciclo
      try { 
        const p = await ensurePage().catch(()=>null);
        if (p) releaseSendGuard(p); 
      } catch {}
    }
  }

  async function filaManagerLoop() {
    if (!running || !epochOk()) return;
    logger.info(`[FILA] tick — running=${running} fila=${fila.length} chatAtivo=${chatAtivo || '-'}`, { nome });
    let manifestFrozenUntil = 0;
    try {
      const manifest = await manifestStore.read(nome);
      manifestFrozenUntil = typeof manifest?.frozenUntil === 'number' ? manifest.frozenUntil : 0;
    } catch {}
    if (manifestFrozenUntil && manifestFrozenUntil > Date.now()) {
      running = false;
      if (filaInterval) clearInterval(filaInterval), filaInterval = null;
      if (filaChatTimer) clearTimeout(filaChatTimer), filaChatTimer = null;
      if (scrollInterval) clearInterval(scrollInterval), scrollInterval = null;
      logger.warn(`[VIRTUS][${nome}] virtus_stop_frozen window — congelado até ${new Date(manifestFrozenUntil).toISOString()}`, { nome });
      return;
    }

    if (!browser || browser.isConnected?.() === false) {
      logger.error(`[VIRTUS][${nome}] Browser morto/desconectado — encerrando Virtus`, { nome });
      if (issues) try { await logIssue(nome, 'virtus_page_dead', 'browser morto/disconnected'); } catch {}
      running = false;
      if (filaInterval) clearInterval(filaInterval), filaInterval = null;
      if (filaChatTimer) clearTimeout(filaChatTimer), filaChatTimer = null;
      if (scrollInterval) clearInterval(scrollInterval), scrollInterval = null;
      return;
    }

    if (filaLoopBusy) return;
    filaLoopBusy = true;
    try {
      const p = await ensurePage();
      if (!p || (p.isClosed && p.isClosed())) {
        logger.error(`[VIRTUS][${nome}] Page fechada/desconectada — encerrando Virtus`, { nome });
        if (issues) try { await logIssue(nome, 'virtus_page_dead', 'page closed/disconnected'); } catch {}
        running = false;
        if (filaInterval) clearInterval(filaInterval), filaInterval = null;
        if (filaChatTimer) clearTimeout(filaChatTimer), filaChatTimer = null;
        if (scrollInterval) clearInterval(scrollInterval), scrollInterval = null;
        return;
      }

      if (!isVirtusLocked(nome)) {
        try {
          await p.evaluate(() => {
            window.dispatchEvent(new Event('focus'));
            document.dispatchEvent(new MouseEvent('mousemove', {bubbles:true}));
            document.dispatchEvent(new Event('visibilitychange'));
            if (window && document && document.body) {
              const evt = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'Control', code: 'ControlLeft' });
              document.body.dispatchEvent(evt);
            }
          });
        } catch {}
      }

      if (limpaHistoricoVelho()) await salvaHistorico();

      const b = getBrowserFromPage(p);
      if (b && b._sendLock && b._sendLock.active) {
        const age = Date.now() - (b._sendLock.since || 0);
        if (age > 45000) {
          logger.warn('[FILA] sendLock ativo há >45s — liberando por watchdog', { nome });
          b._sendLock.active = false;
        } else {
          logger.info('[FILA] sendLock ativo — skip garantirMarketplace nesta iteração.', { nome });
          return;
        }
      }
      await maybeGuaranteeMarketplaceFast(p, nome);

      await atualizaFila();
      scheduleNextIfIdle();
      resetRecoverBackoff();

      if (scrollInterval == null) {
        scrollInterval = setInterval(async () => {
          if (!running || !epochOk()) return;
          try {
            const ok = await scrollChatsToTop(p, nome);
            if (VIRTUS_SCROLL_DEBUG) { log('[SCROLL TOP]', ok ? 'OK' : 'FAIL'); }
            if (ok) {
              lastScrollToTop = Date.now();
            }
          } catch {}
          setTimeout(() => {
            if (!running || !epochOk()) return;
            try {
              const b = getBrowserFromPage(p);
              if (b && b._sendLock && b._sendLock.active) return;
            } catch {}
            scrollChatsToTop(p, nome);
          }, 800);
        }, 30000);
      }
      try {
        const scrolled = await scrollChatsToTop(p, nome);
        if (VIRTUS_SCROLL_DEBUG) { log('[SCROLL TOP]', scrolled ? 'OK' : 'FAIL'); }
        if (scrolled) {
          lastScrollToTop = Date.now();
        }
        setTimeout(() => {
          if (!running || !epochOk()) return;
          try {
            const b = getBrowserFromPage(p);
            if (b && b._sendLock && b._sendLock.active) return;
          } catch {}
          scrollChatsToTop(p, nome);
        }, 800);
      } catch {}

      try {
        const det = await p.evaluate(() => {
          const norm = s => (s || '').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase();
          const texts = Array.from(document.querySelectorAll('h1,h2,span,div')).map(el => norm(el.innerText || el.textContent || ''));
          const hasBlocked =
            texts.some(t =>
              t.includes('voce esta bloqueado temporariamente') ||
              t.includes('você está bloqueado temporariamente') ||
              t.includes('youre temporarily blocked') ||
              t.includes('you’re temporarily blocked') ||
              t.includes('temporarily blocked')
            );
          return { blocked: hasBlocked };
        });
        if (det && det.blocked) {
          if (issues) try { await logIssue(nome, 'virtus_blocked', 'Messenger temporariamente bloqueado (Virtus/Marketplace)'); } catch {}
        }
      } catch {}

      if (!chatAtivo) scheduleNextIfIdle();

    } finally {
      filaLoopBusy = false;
      
    }
  }

  const timersFechamento = new Map(); // chatId -> { inicio, telefone, expirado, expiraEm, timerId }
  const dadosColetados = new Map();   // chatId -> { cidade, telefone, ajudante, saida_tipo, saida_elevador, destino_tipo, destino_elevador, bairro_saida, bairro_destino, itens }
  const pedidosEnviados = new Set();  // chatId já enviados

  async function atualizarDadosColetados(chatId, { cidade = null, telefone = null, dados = {} } = {}) {
    if (!dadosColetados) return;
    if (!dadosColetados.has(chatId)) dadosColetados.set(chatId, {});
    const cur = dadosColetados.get(chatId);
    if (cidade && !cur.cidade) cur.cidade = cidade;
    if (telefone) cur.telefone = telefone;
    const keys = ['ajudante','saida_tipo','saida_elevador','destino_tipo','destino_elevador','bairro_saida','bairro_destino','itens','data_hora'];
    for (const k of keys) {
      if (dados && dados[k] != null) cur[k] = dados[k];
    }
    dadosColetados.set(chatId, cur);
    try {
      await setChatState(nome, chatId, {
        dadosColetados: cur,
        updatedAt: Date.now()
      });
    } catch {}

    // Verifica WhatsApp e campos completos
    const temWhats = !!(cur.telefone && promptFretes.isValidBRPhoneWithDDD(cur.telefone));
    const completos = temWhats &&
      !!(cur.itens && cur.bairro_saida && cur.bairro_destino &&
      (cur.ajudante != null) && (cur.saida_tipo != null) && (cur.destino_tipo != null));

    // Se WhatsApp chegou, faltam campos, e timer NÃO existe: inicia timer
    if (temWhats && !completos && !timersFechamento.has(chatId)) {
      await iniciarTimerFechamento(chatId, cur.telefone);
    }

    // Se WhatsApp chegou E TODOS os campos foram preenchidos: cancela timer e envia imediatamente
    if (temWhats && completos) {
      if (timersFechamento.has(chatId)) {
        cancelarTimerFechamento(chatId);
      }
      if (!pedidosEnviados.has(chatId)) {
        try {
          await enviarPedidoParaNotificador(chatId, cur);
          pedidosEnviados.add(chatId);
          await enviarMensagemFinal(chatId);
          await marcarRespondido(nome, chatId);
          await setChatState(nome, chatId, { state: CHAT_STATES.FINALIZADO });
        } catch (e) {
          logger.error('[FINALIZACAO] Erro ao finalizar chat', { nome, chatId, error: e && e.message || e });
        }
      }
    }
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
    logger.info('[TIMER] Timer de 10min iniciado', { chatId, telefone });
  }

  function cancelarTimerFechamento(chatId) {
    const t = timersFechamento.get(chatId);
    if (t && t.timerId) {
      try { clearTimeout(t.timerId); } catch {}
    }
    timersFechamento.delete(chatId);
    try {
      setChatState(nome, chatId, { timerCancelledAt: Date.now() });
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

    const dados = dadosColetados ? (dadosColetados.get(chatId) || {}) : {};
    const tel = dados.telefone || t.telefone || null;

    if (!tel || !promptFretes.isValidBRPhoneWithDDD(tel)) {
      logger.info('[TIMER] Expirado, mas sem WhatsApp válido — nada será enviado', { chatId });
      timersFechamento.delete(chatId);
      return;
    }

    if (pedidosEnviados && pedidosEnviados.has(chatId)) {
      timersFechamento.delete(chatId);
      return;
    }

    try {
      await enviarPedidoParaNotificador(chatId, { ...dados, telefone: tel });
      if (pedidosEnviados) pedidosEnviados.add(chatId);
      await enviarMensagemFinal(chatId);
      await marcarRespondido(nome, chatId);
      logger.info('[TIMER] Timer expirado — pedido parcial enviado', { chatId });
    } catch (e) {
      logger.error('[TIMER] Falha ao fechar pedido', { chatId, error: e && e.message || e });
    } finally {
      timersFechamento.delete(chatId);
    }
  }

  async function resumeTimers() {
    if (!timersFechamento) return;
    try {
      const allStates = await loadChatState(nome);
      const agora = Date.now();
      for (const [chatId, state] of Object.entries(allStates)) {
        if (!state || !state.timerExpiresAt) continue;
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
          logger.info('[TIMER] Timer restaurado', { chatId, restante: Math.round(restante / 1000) + 's' });
        }
        if (state.dadosColetados && dadosColetados) {
          dadosColetados.set(chatId, state.dadosColetados);
        }
      }
    } catch (e) {
      logger.warn('[TIMER] Erro ao restaurar timers', { error: e && e.message || e });
    }
  }


  const _parcialCooldown = new Map(); // chatId -> lastSent
  async function enviarPedidoParcialSeHabilitado(chatId) {
    try {
      if (String(process.env.NOTIFICADOR_ENVIAR_PARCIAL || '0') !== '1') return;
      const now = Date.now();
      const last = _parcialCooldown.get(chatId) || 0;
      if ((now - last) < 5000) return; // 5s de cooldown
      const dados = dadosColetados && dadosColetados.get(chatId) || {};
      const payload = promptFretes.buildFinalOrderPayload(nome, chatId, dados, NOTIFICADOR_SERVIDOR);
      payload.parcial = true;
      const urlFinal = `${NOTIFICADOR_URL}/api/pedidos`;
      await fetch(urlFinal, {
        method: 'POST',
        headers: { 'Content-Type':'application/json' },
        body: JSON.stringify(payload)
      }).catch(()=>{});
      _parcialCooldown.set(chatId, now);
      logger.info('[NOTIFICADOR] Pedido parcial enviado', { chatId, perfil: nome });
    } catch {}
  }

  async function enviarPedidoParaNotificador(chatId, dados) {
    if (!pedidosEnviados || pedidosEnviados.has(chatId)) return; // evita duplicar
    const payload = promptFretes.buildFinalOrderPayload(nome, chatId, dados, NOTIFICADOR_SERVIDOR);
    const urlFinal = `${NOTIFICADOR_URL}/api/pedidos`;
    const resp = await fetch(urlFinal, {
      method: 'POST',
      headers: { 'Content-Type':'application/json' },
      body: JSON.stringify(payload)
    });
    if (!resp.ok) {
      const txt = await resp.text().catch(()=> '');
      throw new Error(`Notificador error ${resp.status}: ${txt}`);
    }
    logger.info('[NOTIFICADOR] Pedido final enviado', { chatId, perfil: nome });
  }

  async function enviarMensagemFinal(chatId) {
    const dados = dadosColetados && dadosColetados.get(chatId) || {};
    const mensagem = promptFretes.buildFinalMessage({}, dados);
    
    let p = await ensurePage().catch(() => null);
    if (!p) {
      logger.warn('[MENSAGEM_FINAL] Page indisponível', { nome, chatId });
      return;
    }
    try {
      const expectedPath = `/marketplace/t/${chatId}/`;
      let urlNow = (typeof p.url === 'function') ? (p.url() || '') : '';
      if (!urlNow.includes(expectedPath)) {
        logger.warn('[MENSAGEM_FINAL] URL não corresponde ao chat - abortando', { nome, chatId, urlNow });
        return;
      }
      
      const okOn = await assertOnChat(p, chatId, { timeoutMs: 2000 });
      if (!okOn) {
        logger.warn('[MENSAGEM_FINAL] Chat não confirmado - abortando', { nome, chatId });
        return;
      }
      
      let campo = await waitForComposer(p, 8000);
      if (!campo) {
        logger.info('[MENSAGEM_FINAL] Composer não encontrado, tentando refocus', { nome, chatId });
        const anchorSel = `a[href^="/marketplace/t/${chatId}"]`;
        campo = await refocusComposerNoReload(p, chatId, anchorSel);
      }
      
      if (!campo) {
        logger.warn('[MENSAGEM_FINAL] Composer indisponível após refocus', { nome, chatId });
        return;
      }
      
      await sendMessageSafe(p, campo, mensagem, nome, chatId);
      logger.info('[MESSENGER] Mensagem final enviada', { chatId });
    } catch (e) {
      logger.warn('[MESSENGER] Falha ao enviar mensagem final', { chatId, error: e && e.message || e });
    }
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
      if (filaInterval) clearInterval(filaInterval), filaInterval = null;
      if (filaChatTimer) clearTimeout(filaChatTimer), filaChatTimer = null;
      if (scrollInterval) clearInterval(scrollInterval), scrollInterval = null;
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
        
        function onNewChatDetected({ id, tempo }) {
          const chatId = id;
          const now = Date.now();
          if (respondedCache && respondedCache.has(chatId)) return;
          const last = lastProbeMap.get(chatId) || 0;
          if ((now - last) < Math.min(PROBE_RECHECK_MIN_MS, 1000)) return;
          lastProbeMap.set(chatId, now);
          if (!fila.includes(chatId) && !aguardandoRespostaMap.get(nome)?.has(chatId)) {
            fila.push(chatId);
            scheduleNextIfIdle();
          }
        }
        await installChatFeedObserver(p, nome, onNewChatDetected);
      } catch (err) {
        if (!running) return;
        logger.error('Falha ao garantir aba zero no startup Virtus', { nome }, err);
        await sleep(2500);
      }
    }
    if (!running || !epochOk()) return;
    await initHistoricoSePreciso();
    
    try {
      await fazerHandshakeNotificador(nome);
      iniciarPollingRespostas(nome);
      
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
              await sendMessageSafe(p, campo, String(resposta || ''), nome, chatId);
              return true;
            }
          } catch {}
          
          logger.debug('[MESSENGER] Tentativa de envio', { nome, chatId, attempt, maxTries: MAX_TRIES });
          
          let urlNow = (typeof p.url === 'function') ? (p.url() || '') : '';
          if (!chatUrlMatches(urlNow, chatId)) {
            logger.warn('[MESSENGER] URL não corresponde ao chat - abortando', { nome, chatId, urlNow });
            throw new Error('chat_not_on_correct_url');
          }
          
          const okOn = await assertOnChat(p, chatId, { timeoutMs: 2000 });
          if (!okOn) {
            throw new Error('chat_not_opened');
          }
          
          let campo = await waitForComposer(p, 10000);
          if (!campo) {
            logger.info('[MESSENGER] Composer não encontrado, tentando refocus', { nome, chatId });
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
          
          await sendMessageSafe(p, campo, String(resposta || ''), nome, chatId);
          
          logger.info('[MESSENGER] ✅✅✅ Enviada (robusta)', { nome, chatId, attempt });
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
        throw lastErr;
      }
      
      return false;
    }
    
    async function marcarRespondidoLocal(chatId) {
      try {
        const agoraTs = agoraEpoch();
        let historicoLocal = {};
        try { historicoLocal = await readJson(HIST_FILE, {}); } catch {}
        historicoLocal[chatId] = agoraTs;
        await writeJsonAtomicFsync(HIST_FILE, historicoLocal);
        setResponded(chatId, agoraTs);
        await salvaHistorico();
      } catch (e) {
        logger.error('[VIRTUS] marcarRespondido error', { nome, chatId, error: e && e.message || e });
      }
    }
    
      iniciarFilaEnvioMessenger(nome, enviarRespostaMessengerSeguraLocal, marcarRespondidoLocal);
    } catch (e) {
      logger.warn('[NOTIFICADOR] falha init filas/handshake (modo legado)', { nome, error: e && e.message || e });
    }
    
    filaInterval = setInterval(filaManagerLoop, POLL_INTERVAL_MS);
    filaManagerLoop();
    
    setTimeout(() => {
      if (running && epochOk()) {
        logger.info('[FILA] Kick inicial (3s) — forçando atualização de fila', { nome });
        atualizaFila().catch(() => {});
      }
    }, 3000);
    
    setTimeout(() => {
      if (running && epochOk()) {
        logger.info('[FILA] Kick inicial (10s) — forçando atualização de fila', { nome });
        atualizaFila().catch(() => {});
      }
    }, 10000);
  }

  runner();

  return {
    stop: async () => {
      stepLog.appendJSONL(nome, 'virtus', { attempt: attId, step: 'stop' });
      running = false;
      if (filaInterval) clearInterval(filaInterval), filaInterval = null;
      if (filaChatTimer) clearTimeout(filaChatTimer), filaChatTimer = null;
      if (scrollInterval) clearInterval(scrollInterval), scrollInterval = null;
      let pages = [];
      try { pages = await browser.pages(); } catch {}
      if (robeMeta && typeof nome !== "undefined") {
        if (!robeMeta[nome]) robeMeta[nome] = {};
        robeMeta[nome].numPages = pages.length;
      }
      delete virtusDeadLogTimes[nome];
      try { respondedCache.clear(); } catch {}
      try { fila = []; } catch {}
      try { failCounts.clear(); } catch {}
      try { historico = {}; } catch {}
    }
  };
}

module.exports = {
  startVirtus
};