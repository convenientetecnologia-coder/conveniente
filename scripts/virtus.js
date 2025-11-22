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

// === Groq Direct Mode (Virtus → Groq API → Virtus) ===
const DIRECT_GROQ = (process.env.DIRECT_GROQ || '1') === '1';

// Verificação da chave será feita apenas quando necessário (lazy check)
// Isso evita erro no boot se o .env ainda não estiver configurado
let GROQ_API_KEY = null;
let GROQ_MODEL = null;
let GROQ_API_URL = null;

function verificarConfigGroq() {
  if (!GROQ_API_KEY) {
    GROQ_API_KEY = process.env.GROQ_API_KEY;
    GROQ_MODEL = process.env.GROQ_MODEL || 'llama-3.3-70b-versatile';
    GROQ_API_URL = process.env.GROQ_API_URL || 'https://api.groq.com/openai/v1/chat/completions';
    
    if (!GROQ_API_KEY) {
      logger.error('[GROQ] GROQ_API_KEY não configurada! Configure no arquivo .env');
      throw new Error('GROQ_API_KEY não configurada. Crie arquivo .env com GROQ_API_KEY=sua_chave');
    }
  }
  return { GROQ_API_KEY, GROQ_MODEL, GROQ_API_URL };
}

async function chamarGroqAPI(promptSystem, promptUser, { timeoutMs = 15000, retries = 2 } = {}) {
  // Verificar configuração antes de usar
  const config = verificarConfigGroq();
  const apiKey = config.GROQ_API_KEY;
  const model = config.GROQ_MODEL;
  const apiUrl = config.GROQ_API_URL;
  
  let lastErr = null;

  for (let i = 0; i <= retries; i++) {
    let ac = null;
    try {
      ac = new (global.AbortController || (() => {
        try { return require('abort-controller').AbortController; } catch { return null; }
      })())();
    } catch {}
    
    const t = ac ? setTimeout(() => { try { if (ac) ac.abort(); } catch {} }, timeoutMs) : null;

    try {
      const resp = await fetch(apiUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`
        },
        body: JSON.stringify({
          model: model,
          messages: [
            { role: 'system', content: promptSystem },
            { role: 'user', content: promptUser }
          ],
          temperature: 0.7,
          max_tokens: 700
        }),
        signal: ac ? ac.signal : undefined
      });

      if (t) clearTimeout(t);

      if (!resp.ok) {
        lastErr = new Error(`Groq API error: ${resp.status} ${resp.statusText}`);
        continue;
      }

      const data = await resp.json();
      const content = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content || '';

      if (!content || !String(content).trim()) {
        lastErr = new Error('Groq API retornou resposta vazia');
        continue;
      }

      return content.trim();
    } catch (e) {
      if (t) clearTimeout(t);
      lastErr = e;
    }
  }

  logger.error('[GROQ] Erro ao chamar API', { error: (lastErr && lastErr.message) || String(lastErr) });
  throw lastErr || new Error('groq_error');
}

// Prompt system (personalidade)
const PROMPT_SYSTEM = `
Você é o melhor atendente de mudanças e fretes do Brasil.

Personalidade:
- Super educado, gentil e caloroso
- Confiante e motivado
- Inteligente e rápido
- Gírias leves naturais do BR
- Positivo, animado e cria urgência boa
- Usa emojis na medida certa (😄🚚📲✨)
- Persistente agradável (sem ser chato)

CONTEXTO DA CONVERSA:
- Esta é uma conversa em andamento. Continue naturalmente, sem cumprimentos repetidos.
- NUNCA diga "Olá novamente" ou "Olá" se já houve mensagens anteriores. Vá direto ao ponto, de forma humana.
- Se já existe histórico, dê continuidade ao tema da última mensagem do cliente.

INTELIGÊNCIA E NATURALIDADE:
- NUNCA repita o que o cliente disse. Seja direto e inteligente.
- Confirme sem repetir. Ex.: Se o cliente disse "preciso levar 2 camas e algumas sacolas", NÃO responda "Você precisa levar 2 camas e poucas sacolas, é isso?". Em vez disso, responda: "Ah, entendi, levo sim! Só preciso do WhatsApp para continuar o atendimento 🚚📲".
- Evite redundâncias. Responda de forma prática e natural, como um humano experiente faria.

ESTRATÉGIA DE PEDIR WHATSAPP:
- Seu objetivo nº 1 é pegar o telefone (WhatsApp com DDD) de forma natural.
- Sempre dê a razão: "pra eu entender melhor e te passar o orçamento".
- Deixe claro que você é o atendente e "o meu motorista já vai te chamar" — isso cria urgência positiva. Exemplo: "Perfeito! Pra eu entender melhor e te passar o orçamento, me passa seu WhatsApp que o meu motorista já vai te chamar 🚚📲"

Objetivo nº 2: depois do telefone, colete rapidamente:
  - Precisa de ajudante?
  - Saída: casa ou apartamento? Com ou sem elevador?
  - Destino: casa ou apartamento? Com ou sem elevador?
  - Bairro de saída e de destino?
  - Itens/quantidade a transportar?

Regras gerais:
- Responda dúvidas e emende pedindo o zap de forma fluida.
- Se o cliente mandar telefone em qualquer formato, extraia imediatamente (com DDD).
- Após pegar o telefone, colete as informações adicionais de forma natural (uma ou duas por vez).
- Seja natural e humano. Não repita o que o cliente acabou de dizer.

REGRA ABSOLUTA:
- Se o cliente enviou uma mensagem nova (mesmo sem telefone), VOCÊ DEVE responder — sempre.
- Se o cliente mencionou itens, bairros, ajudante, ou outras informações, reconheça/avance e continue pedindo o WhatsApp para fechar o orçamento.

Formato JSON esperado (sem markdown, sem texto adicional):
{
  "resposta": "texto exato para enviar ao cliente",
  "telefone_extraido": "11999999999" ou null,
  "finalizado": true/false,
  "dados": {
    "ajudante": null|"...",
    "saida_tipo": null|"casa"|"apartamento",
    "saida_elevador": null|"sim"|"nao",
    "destino_tipo": null|"casa"|"apartamento",
    "destino_elevador": null|"sim"|"nao",
    "bairro_saida": null|"...",
    "bairro_destino": null|"...",
    "itens": null|"..."
  }
}

- "finalizado" = true apenas quando houver telefone válido com DDD.
- Retorne SOMENTE o JSON.
`.trim();

function montarPromptUser(cidade, historico) {
  const cid = cidade || 'não informada';
  const temHistorico = Array.isArray(historico) && historico.length > 0;
  const cabecalho = [
    `Contexto do atendimento:`,
    `- Cidade (referência): ${cid}`,
    ``,
    `Esta é uma conversa em andamento. Continue naturalmente, sem cumprimentos repetidos,`,
    `e sem repetir a cidade caso já exista histórico.`,
    ``,
    `Histórico completo (ordem temporal, autor: texto):`
  ];
  const linhas = [];
  for (const msg of (historico || [])) {
    const autor = (msg.autor === 'ia' || msg.autor === 'sistema') ? 'Atendente' : 'Cliente';
    linhas.push(`${autor}: ${msg.texto}`);
  }
  const rodape = [
    ``,
    `Gere a próxima resposta seguindo as regras e o formato JSON especificado.`
  ];
  return [...cabecalho, ...linhas, ...rodape].join('\n');
}

function parsearRespostaGroq(respostaTexto) {
  try {
    const match = String(respostaTexto || '').match(/\{[\s\S]*\}$/);
    if (!match) throw new Error('JSON não encontrado na resposta');

    const obj = JSON.parse(match[0]);
    const safeDados = obj.dados && typeof obj.dados === 'object' ? obj.dados : {};

    return {
      resposta: obj.resposta || '',
      telefone_extraido: obj.telefone_extraido || null,
      finalizado: obj.finalizado === true,
      dados: {
        ajudante: safeDados.ajudante ?? null,
        saida_tipo: safeDados.saida_tipo ?? null,
        saida_elevador: safeDados.saida_elevador ?? null,
        destino_tipo: safeDados.destino_tipo ?? null,
        destino_elevador: safeDados.destino_elevador ?? null,
        bairro_saida: safeDados.bairro_saida ?? null,
        bairro_destino: safeDados.bairro_destino ?? null,
        itens: safeDados.itens ?? null
      }
    };
  } catch (e) {
    logger.error('[GROQ] Erro ao parsear JSON', { error: e && e.message || e, raw: String(respostaTexto).slice(0, 300) });
    throw e;
  }
}

// Locks por perfil de input
const VIRTUS_INPUT_LOCKS = new Map();
function setVirtusInputLock(nome, v){ if (v) VIRTUS_INPUT_LOCKS.set(nome,true); else VIRTUS_INPUT_LOCKS.delete(nome); }
function isVirtusLocked(nome){ return VIRTUS_INPUT_LOCKS.has(nome); }

// Helpers globais de send-lock/contexto
function getBrowserFromPage(p) { try { return typeof p.browser === 'function' ? p.browser() : null; } catch { return null; } }
async function acquireSendGuard(p, chatId) { try { const b = getBrowserFromPage(p); if (b) b._sendLock = { active: true, owner: 'virtus', chatId, since: Date.now() }; } catch {} }
function releaseSendGuard(p) { try { const b = getBrowserFromPage(p); if (b && b._sendLock && b._sendLock.owner === 'virtus') b._sendLock.active = false; } catch {} }
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

// Debug flags por variável de ambiente
const VIRTUS_SCROLL_DEBUG = process.env && process.env.VIRTUS_SCROLL_DEBUG === '1';
const VIRTUS_DETAILED_DEBUG = process.env && process.env.VIRTUS_DEBUG === '1';

// Debounce de log "Browser morto, não é possível garantir page." — 1x/60s por perfil
const virtusDeadLogTimes = {}; // { [nome]: timestamp }

// TTL periódica para virtusDeadLogTimes (limpeza de entradas >24h)
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of Object.entries(virtusDeadLogTimes)) {
    if (now - v > 24 * 60 * 60 * 1000) delete virtusDeadLogTimes[k];
  }
}, 60 * 60 * 1000);

// Log de issues (robusto; falha silenciosa se o módulo não existir)
let issues = null;
try { issues = require('./issues.js'); } catch { issues = null; }

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function randomBetween(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

// Adicionado helper local para registrar issues
async function logIssue(nome, type, message) {
  try {
    if (issues && typeof issues.append === 'function') {
      await issues.append(nome, type, message);
    }
  } catch {
    // silencioso
  }
}

// ====== INÍCIO: Auxiliares Notificador/Messenger ======
function getSetAguardando(nomePerfil) {
  if (!aguardandoRespostaMap.has(nomePerfil)) aguardandoRespostaMap.set(nomePerfil, new Set());
  return aguardandoRespostaMap.get(nomePerfil);
}

async function identificarTipoServico(nomePerfil) {
  try {
    const man = await manifestStore.read(nomePerfil).catch(()=>null);
    // Se tiver flags específicas:
    if (man && man.automoveis === true) return 'automoveis';
    if (man && man.imoveis === true) return 'imoveis';
    // Se usa robeMode 'veiculos' => mapeia para automoveis
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

  // agenda envio em lote
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
      
      // Lê response uma única vez (body só pode ser lido uma vez)
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
        // requeue se falha
        fila.push(dadosChat);
      }
    } catch (e) {
      logger.error('[NOTIFICADOR] Falha ao enviar chat', { nomePerfil, chatId: dadosChat.chatId, error: e && e.message || e });
      // requeue se falha
      fila.push(dadosChat);
    }
  }));

  // Se ainda tem mais, agenda próximo lote
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
          // Sanitiza resposta antes de processar
          const respostaSan = sanitizarResposta(resp.resposta || '');
          
          // Gera chave única para deduplicação
          const key = `${resp.chat_id}||${hashResposta(respostaSan)}`;
          
          // Dedup: se já em fila/pendente, ignore
          if (perfilKeySet.has(key)) {
            logger.debug('[NOTIFICADOR] Resposta duplicada ignorada', { nomePerfil, chatId: resp.chat_id, key });
            continue;
          }
          
          if (!filaRespostas.has(nomePerfil)) filaRespostas.set(nomePerfil, []);
          filaRespostas.get(nomePerfil).push(resp);
          
          // Empilha para envio no Messenger, sanitizando e incluindo key
          if (!filaEnvioMessenger.has(nomePerfil)) filaEnvioMessenger.set(nomePerfil, []);
          filaEnvioMessenger.get(nomePerfil).push({ 
            chatId: resp.chat_id, 
            resposta: respostaSan, 
            key 
          });
          
          // Marca como pendente local (anti-duplicado)
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
      // Sanitiza resposta antes de enviar (garantia extra)
      const respostaFinal = sanitizarResposta(proximo.resposta);
      
      // envia de forma segura (abre chat, pega composer, envia)
      if (enviarRespostaMessengerSeguraFn) {
        await enviarRespostaMessengerSeguraFn(proximo.chatId, respostaFinal);
      }
      ultimaRespostaMessenger.set(nomePerfil, Date.now());

      // marca histórico respondido (somente agora!)
      if (marcarRespondidoFn) {
        await marcarRespondidoFn(proximo.chatId);
      } else {
        await marcarRespondido(nomePerfil, proximo.chatId);
      }
      
      // NOVO: Enviar ACK ao Notificador após confirmação de envio
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
      
      // remove do set aguardando
      try { const setA = getSetAguardando(nomePerfil); setA.delete(proximo.chatId); } catch {}

      // Libera a chave pending dedup (permite reprocessar se houver nova resposta diferente)
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
      
      // Mesmo em erro, libere a chave para permitir reprocessar em próxima iteração
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

// enviarRespostaMessengerSegura será implementada dentro do contexto do startVirtus

async function marcarRespondido(nomePerfil, chatId) {
  try {
    const agoraTs = agoraEpoch();
    const HIST_FILE = HIST_JSON_NAME(nomePerfil);
    let historicoLocal = {};
    try { historicoLocal = await readJson(HIST_FILE, {}); } catch {}
    historicoLocal[chatId] = agoraTs;
    await writeJsonAtomicFsync(HIST_FILE, historicoLocal);
    // Nota: setResponded só está disponível dentro do contexto do Virtus
    // Esta função é um fallback genérico
  } catch (e) {
    logger.error('[VIRTUS] marcarRespondido error', { nomePerfil, chatId, error: e && e.message || e });
  }
}

// Extrai a URL do classificado diretamente da pagina do chat
async function extrairUrlClassificado(page, chatId) {
  try {
    const url = await page.evaluate(() => {
      const fixAbsolute = (h) => (h && h.startsWith('http')) ? h : (h ? ('https://www.facebook.com' + h) : null);
      const anchors = Array.from(document.querySelectorAll('a'));
      // Prioriza /marketplace/item/
      for (const a of anchors) {
        const href = a.getAttribute('href') || a.href || '';
        if (href && href.includes('/marketplace/item/')) {
          if (!href.includes('/marketplace/t/')) return fixAbsolute(href);
        }
      }
      // Fallback: links do marketplace que não são t/ e não são profile
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

// Extrai TODO o histórico da conversa (mensagens do cliente e da IA) - VERSÃO CORRIGIDA
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

          // Heurística robusta: se for bolha do próprio usuário => alinhamento à direita/flex-end
          let isMine = false;
          try {
            const st = window.getComputedStyle(r);
            if (st && (st.justifyContent === 'flex-end' || st.textAlign === 'right')) {
              isMine = true;
            }
          } catch {}

          // Fallback textual
          const n = norm(txt);
          if (/\b(you\s+sent|voc[eê]\s+enviou)\b/i.test(n)) isMine = true;

          // Timestamp real pelo abbr mais próximo
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

      // Ordena por timestamp ascendente
      out.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
      return out;
    });

    return Array.isArray(historico) ? historico : [];
  } catch {
    return [];
  }
}

// Formata localização no padrão "Cidade (UF)" para a planilha Google
function formatarLocalizacaoParaPlanilha(localizacao) {
  if (!localizacao) return null;
  
  // Se já está no formato correto (string "Cidade (UF)"), retorna como está
  if (typeof localizacao === 'string') {
    return localizacao;
  }
  
  // Se é objeto { cidade, estado }
  if (localizacao && typeof localizacao === 'object') {
    const cidade = (localizacao.cidade || '').trim();
    const estado = (localizacao.estado || '').trim().toUpperCase();
    
    if (cidade && estado) {
      // Formata: "Cidade (UF)"
      return `${cidade} (${estado})`;
    }
    
    // Se só tem cidade, retorna cidade
    if (cidade) return cidade;
    
    // Se só tem estado, retorna estado
    if (estado) return estado;
  }
  
  return null;
}
// ====== FIM: Auxiliares Notificador/Messenger ======

// Carrega JSON de atendimento.json (array de respostas randomizáveis)
// IGNORADO: Respostas agora vêm do Notificador
let mensagensAtendimento = [];

function agoraEpoch() {
  return Math.floor(Date.now() / 1000);
}

const HIST_JSON_NAME = c => path.join(__dirname, '../dados/perfis', c, 'chats_respondidos.json');

// === INÍCIO: CONTROLE DE ESTADO DE CHAT (persistido APENAS em disco) ===
const CHAT_STATE_FILE = (perfil) => path.join(__dirname, '../dados/perfis', perfil, 'chats_state.json');

async function readJsonFsyncSafe(file, fb = {}) {
  try {
    const content = await fs.readFile(file, 'utf8');
    return JSON.parse(content);
  } catch {
    return fb;
  }
}

async function writeJsonFsyncAtomic(file, obj) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  const fd = await fsRaw.openSync(tmp, 'w');
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
  const st = await loadChatState(perfil);
  const prev = st[chatId] || {};
  st[chatId] = Object.assign({}, prev, patch || {}, { updatedAt: Date.now() });
  await saveChatState(perfil, st);
}

// Estados aceitos:
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
// === FIM: CONTROLE DE ESTADO DE CHAT ===

// ====== INÍCIO: Config Notificador e Filas ======
const NOTIFICADOR_URL = process.env.NOTIFICADOR_URL || 'https://c0nv3n13nt3t3cn0l0g14jesus.sa.ngrok.io';
const NOTIFICADOR_SERVIDOR = process.env.SERVIDOR_NOME || 'servidor1';

const NOTIFICADOR_ENVIO_LOTE_MS = parseInt(process.env.NOTIFICADOR_ENVIO_LOTE_MS || '10000', 10); // 10s
const NOTIFICADOR_POLLING_MS = parseInt(process.env.NOTIFICADOR_POLLING_MS || '5000', 10);       // 5s
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

// ====== INÍCIO: Deduplicação e Sanitização ======
// Dedup por perfil: chave = ${chatId}||${hashResposta}
const pendingKeysPorPerfil = new Map(); // nomePerfil -> Set(keys)

function getPendingSet(perfil) {
  if (!pendingKeysPorPerfil.has(perfil)) pendingKeysPorPerfil.set(perfil, new Set());
  return pendingKeysPorPerfil.get(perfil);
}

function hashResposta(s) {
  try { 
    const crypto = require('crypto');
    return crypto.createHash('sha256').update(String(s || '')).digest('hex');
  } catch { 
    return String(s || ''); 
  }
}

function sanitizarResposta(texto) {
  if (!texto || typeof texto !== 'string') return '';
  let t = texto;
  
  // Corrige encoding mojibake (OlÃ¡ -> Olá)
  if (/[ÃÂ]/.test(t)) {
    try {
      const fixed = Buffer.from(t, 'latin1').toString('utf8');
      if (/[áàâãéêíóôõúçÁÀÂÃÉÊÍÓÔÕÚÇ]/.test(fixed)) t = fixed;
    } catch {}
  }
  
  // Colapsa duplicatas excessivas de caracteres (OOlláá -> Ollá)
  t = t.replace(/(.)\1{2,}/g, '$1$1');
  
  // Remove espaços múltiplos
  t = t.replace(/\s{2,}/g, ' ');
  
  return t.trim();
}
// ====== FIM: Deduplicação e Sanitização ======

// ====== FIM: Config Notificador e Filas ======

// ======= ADIÇÃO: Pending Ledger Helpers & Heurística =======
const PENDING_JSON_NAME = c => path.join(__dirname, '../dados/perfis', c, 'chats_pending.json');

async function readJson(file, fb={}) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')); } catch { return fb; }
}
async function writeJsonAtomicFsync(file, obj){
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
// Heurística: detecta bubble "você enviou/you sent"
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
      // Se bubble fala em "agora", minutos, ou "há menos de 10min"
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

// Classificadores de tempo
// NOVO: Reduzido de 24h para 8h (menos scroll = menos RAM consumida)
function isVelho8h(tempoLabel) {
  if (!tempoLabel) return false;
  const t = String(tempoLabel)
    .normalize('NFD').replace(/[\u0300-\u036f]/g,'')
    .toLowerCase().trim();
  if (/\b(ontem|yesterday)\b/.test(t)) return true;
  if (/\b(\d+)\s*(seman|sem|weeks?|w)\b/.test(t)) return true;
  const mDias = t.match(/\b(\d+)\s*(d|dias?)\b/);
  if (mDias) { if (parseInt(mDias[1],10) >= 1) return true; }
  const mH = t.match(/\b(\d+)\s*(h|hora|horas|hours?)\b/);
  if (mH) { if (parseInt(mH[1],10) >= 8) return true; } // NOVO: 8h ao invés de 24h
  return false;
}
// Mantido para compatibilidade (mas não usado mais)
function isVelho24h(tempoLabel) {
  return isVelho8h(tempoLabel); // Usa a nova função
}
function isChatRecente(tempoLabel) {
  if (!tempoLabel) return false;
  const t = String(tempoLabel)
    .normalize('NFD').replace(/[\u0300-\u036f]/g,'')
    .toLowerCase().trim();
  if (isVelho8h(t)) return false; // NOVO: Usa isVelho8h
  if (/\b(agora|now)\b/.test(t)) return true;
  if (/\b\d+\s*(s|seg|secs?|seconds?)\b/.test(t)) return true;
  if (/\b\d+\s*(min|m|mins?|minutes?)\b/.test(t)) return true;
  const mH = t.match(/\b(\d+)\s*(h|hora|horas|hours?)\b/);
  if (mH) { if (parseInt(mH[1],10) < 24) return true; }
  return false;
}

// Extratores e coleta
function extraiIdDoHref(href) {
  try {
    const s = String(href || '');
    const pos = s.indexOf('/marketplace/t/');
    if (pos < 0) return null;
    const rest = s.slice(pos + '/marketplace/t/'.length);
    const id = rest.split(/[/?#]/)[0];
    return id && /^\d+$/.test(id) ? id : null;
  } catch { return null; }
}

async function coletaChatsMarketplaceTodos(page) {
  try {
    const items = await page.$$eval('a[href^="/marketplace/t/"]', els => {
      function _extraiId(href) {
        try {
          const s = String(href || '');
          const pos = s.indexOf('/marketplace/t/');
          const rest = s.slice(pos + '/marketplace/t/'.length);
          const id = rest.split(/[/?#]/)[0];
          return id && /^\d+$/.test(id) ? id : null;
        } catch { return null; }
      }
      function _extraiTempo(row) {
        if (!row) return '';
        try {
          const abbr = row.querySelector('abbr[aria-label]');
          if (abbr) {
            const t1 = (abbr.innerText || '').trim();
            if (t1) return t1;
            const t2 = (abbr.getAttribute('aria-label') || '').trim();
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
      const arr = els.map(el => {
        const href = el.getAttribute('href') || el.href || '';
        const id = _extraiId(href);
        const row = el.closest('div[role="row"]') || el.parentElement;
        const tempo = _extraiTempo(row);
        return { id, tempo, href };
      }).filter(o => o.id);
      const map = new Map();
      for (const it of arr) if (!map.has(it.id)) map.set(it.id, it);
      return Array.from(map.values());
    });
    return items;
  } catch (err) {
    if (VIRTUS_DETAILED_DEBUG) { logger.debug('[VIRTUS] Erro em coletaChatsMarketplaceTodos', { err: String(err) }); }
    return [];
  }
}

// Messenger helpers
async function garantirMarketplace(page, { timeoutMs = 25000 } = {}) {
  if (!page || typeof page.url !== 'function') throw new Error('Page inválida');
  let url = '';
  try { url = page.url() || ''; } catch {}
  if (!/messenger.com\/marketplace/i.test(url)) {
    try { await page.goto('https://www.messenger.com/marketplace', { waitUntil: 'domcontentloaded', timeout: timeoutMs }); } catch {}
  }
  // Cura fluxos de nonce/continuar
  try {
    const browserJs = require('./browser.js');
    if (browserJs && typeof browserJs.resolveNonceIfPresent === 'function') {
      await browserJs.resolveNonceIfPresent(page).catch(()=>{});
    }
    if (browserJs && typeof browserJs.clickContinuarComo === 'function') {
      await browserJs.clickContinuarComo(page, { timeout: 12000 }).catch(()=>{});
    }
  } catch {}
  // Espera robusta por UI
  const ok = await Promise.race([
    page.waitForFunction(() => {
      const hasAnchor = !!document.querySelector('a[href^="/marketplace/t/"]');
      const hasGrid = !!document.querySelector('div[role="grid"]') || !!document.querySelector('div[role="rowgroup"]');
      const hasRow = document.querySelectorAll('div[role="row"]').length > 0;
      return hasAnchor || hasGrid || hasRow;
    }, { timeout: timeoutMs }),
    page.waitForSelector('a[href^="/marketplace/t/"]', { timeout: timeoutMs }).catch(() => null)
  ]);
  if (!ok) throw new Error('Marketplace UI não ficou pronta a tempo');
}

// ========== INÍCIO DAS FUNÇÕES E GUARDRAILS SOLICITADAS ==========

/**
 * GUARD: manter top chats always visible to avoid drifting out of viewport.
 * Função utilitária para scrollar a lista de chats para o topo.
 * Executa direto via page.evaluate no Messenger.
 */
async function scrollChatsToTop(page, nome) {
  if (isVirtusLocked(nome)) return false;
  try {
    const b = getBrowserFromPage(page);
    if (b && b._sendLock && b._sendLock.active) return false;
  } catch {}
  if (!page) return false;
  try {
    const res = await page.evaluate(() => {
      // Procure vários elementos "scrolláveis"
      // 1. grid por role
      let grid = document.querySelector('div[role="grid"]');
      // 2. por data-virtualized e classes do FB
      if (!grid) grid = document.querySelector('div.x78zum5.xdt5ytf[data-virtualized="false"]');
      // 3. rowgroup
      if (!grid) grid = document.querySelector('div[role="rowgroup"]');
      // 4. fallback classe base
      if (!grid) grid = document.querySelector('div.x78zum5.xdt5ytf');
      // 5. heurística de altura
      if (!grid) grid = Array.from(document.querySelectorAll('div'))
        .find(d => d.scrollHeight > 400 && d.scrollHeight > d.clientHeight + 30);
      // 6. fallback body
      if (!grid) grid = document.body;
      if (!grid) return false;

      // Forçar scrollTop em grid e ancestrais
      grid.scrollTop = 0;
      let node = grid.parentElement;
      for (let i = 0; i < 4 && node; i++) {
        if (node.scrollHeight > node.clientHeight + 30) node.scrollTop = 0;
        node = node.parentElement;
      }

      // Tentativa extra: clicar em cima no topo para garantir foco no chat mais recente
      try {
        let firstA = grid.querySelector('a[role="link"], a[href^="/marketplace/t/"]');
        if (firstA) {
          firstA.focus && firstA.focus();
          // Eventual scrollIntoView + toTop
          firstA.scrollIntoView({block: "start", behavior: "smooth"});
        }
      } catch {}

      // Se scroll ainda não foi suficiente (scrollTop > 0 depois do set), repete
      setTimeout(() => { if (grid.scrollTop > 0) grid.scrollTop = 0; }, 250);

      return grid.scrollTop === 0;
    });
    return !!res;
  } catch (err) {
    return false;
  }
}

// ========== FIM DOS GUARDRAILS E FUNÇÕES NOVAS ==========

// ========== INÍCIO DA FUNÇÃO sendMessageSafe ==========
// Helpers para confirmação robusta de envio
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
        // tenta pegar "quando" em abbr/aria-label
        const lastEl = rows[lastIdx];
        let when = '';
        try {
          const abbr = lastEl.querySelector('abbr[aria-label]');
          if (abbr) when = (abbr.getAttribute('aria-label') || abbr.innerText || abbr.textContent || '').trim();
        } catch {}
        
        if (!when) {
          // fallback: procurar spans pequenos com "agora", "1 min", etc.
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
  // 0) Reobtenha o composer se campo for ausente ou suspeito
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
  if (!campo) throw new Error('composer_missing');

  // Valida URL antes de começar a digitar (hard check)
  try {
    const urlNow = (typeof p.url === 'function') ? (p.url() || '') : '';
    if (!urlNow.includes(`/marketplace/t/${chatId}/`)) {
      await logIssue(nome, 'mil_action', `virtus_context_abort: url_mismatch_before_type chat=${chatId} url="${urlNow}"`);
      return; // aborta o envio neste chat
    }
  } catch {}

  // Verificar contexto antes de digitar
  if (!(await assertOnChat(p, chatId, { timeoutMs: 0 }))) {
    await logIssue(nome, 'mil_action', `virtus_context_abort: before_type (chat ${chatId})`);
    return;
  }

  const ctrlKey = (process.platform === 'darwin') ? 'Meta' : 'Control';

  setVirtusInputLock(nome, true);
  try {
    // Foco real no composer
    await campo.click({ delay: 20 }).catch(()=>{});
    // Limpeza: Select All + Backspace/Delete
    try {
      await p.keyboard.down(ctrlKey);
      await p.keyboard.press('KeyA');
      await p.keyboard.up(ctrlKey);
    } catch {}
    try { await p.keyboard.press('Backspace'); } catch {}
    try { await p.keyboard.press('Delete'); } catch {}
    // Aguarda esvaziar (tolerante)
    await p.waitForFunction(
      el => ((el.innerText || el.textContent || '').trim().length === 0),
      { timeout: 1200 },
      campo
    ).catch(()=>{});

    // Digita uma única vez (sem execCommand/insertText)
    await p.keyboard.type(String(msg || ''), { delay: 0 });

    // Revalida URL antes de pressionar Enter (hard check)
    try {
      const urlNow2 = (typeof p.url === 'function') ? (p.url() || '') : '';
      if (!urlNow2.includes(`/marketplace/t/${chatId}/`)) {
        await clearComposerIfAny(p, campo);
        await logIssue(nome, 'mil_action', `virtus_context_abort: url_mismatch_before_enter chat=${chatId} url="${urlNow2}"`);
        return; // aborta o envio neste chat
      }
    } catch {}

    // Revalidar contexto antes do Enter
    if (!(await assertOnChat(p, chatId, { timeoutMs: 0 }))) {
      await clearComposerIfAny(p, campo);
      await logIssue(nome, 'mil_action', `virtus_context_abort: before_enter (chat ${chatId})`);
      return;
    }

    // NOVO: Confirmação ROBUSTA - tirar snapshot ANTES de enviar
    const expected = String(msg || '').trim();
    const before = await getMySentSnapshot(p);
    logger.debug('[MESSENGER] Snapshot antes do envio', { nome, chatId, beforeTotal: before.total });

    // Envia (um único Enter)
    await p.keyboard.press('Enter');
    logger.debug('[MESSENGER] Enter pressionado, aguardando confirmação robusta', { nome, chatId });

    // NOVO: Confirmação ROBUSTA - verificar que número de bolhas aumentou + texto coincide (SEM whenRecent)
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

            // considera "minhas" bolhas por alinhamento à direita ou presença do rótulo textual
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

        // confirmação: contagem aumentou E último texto contém (normalizado) o esperado
        return lastNorm.includes(expectedNorm);
      },
      { timeout: 12000 },
      before.total,
      expectedNorm
    ).catch(() => false);

    if (!sent) {
      logger.error('[MESSENGER] ❌ FALHA ROBUSTA: nova bolha não confirmada', { 
        nome, 
        chatId,
        beforeTotal: before.total
      });
      await logIssue(nome, 'virtus_send_failed', 'send_confirmation_robust_timeout');
      throw new Error('send_not_confirmed_robust');
    }

    logger.info('[MESSENGER] ✅ Mensagem confirmada (robusta)', {
      nome,
      chatId,
      beforeTotal: before.total,
      metodo: 'contagem_aumentou_texto_coincide'
    });

    // Marcar estado após envio bem-sucedido (APENAS disco)
    try {
      await setChatState(nome, chatId, {
        state: CHAT_STATES.AGUARDANDO,
        lastIATs: Date.now(),
        cooldownUntil: Date.now() + SENT_COOLDOWN_MS
      });
    } catch {}

  } finally {
    setVirtusInputLock(nome, false);
  }
}
// ========== FIM DA FUNÇÃO sendMessageSafe ==========

async function startVirtus(browser, nome, robeMeta = {}) {
  // Na primeira linha dentro de startVirtus, após argumentos:
  let requiredEpoch = 0;
  if (arguments.length >= 3 && arguments[2] && arguments[2].epoch != null) {
    requiredEpoch = arguments[2].epoch;
  }
  // Broker fence: sempre leia do browser._fenceEpochMap
  function epochOk() {
    try {
      if (browser && browser._fenceEpochMap && typeof browser._fenceEpochMap[nome] !== "undefined") {
        return browser._fenceEpochMap[nome] === requiredEpoch;
      }
      // Compat: se não definido, considera ok
      return true;
    } catch { return false; }
  }

  const attId = stepLog.attemptId();
  stepLog.appendJSONL(nome, 'virtus', { attempt: attId, step: 'start' });

  // ========== INÍCIO BLOCO FREEZER INSTRUÇÃO 1 ==========
  // Checagem ultra robusta de freezer
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
  // ========== FIM BLOCO FREEZER INSTRUÇÃO 1 ==========

  const log = (...args) => logger.info(args.join(' '), { nome });

  let running = true;
  let page = null;
  let fila = [];
  let historico = {};
  let chatAtivo = null;

  const HIST_FILE = HIST_JSON_NAME(nome);
  const NO_REPEAT_WINDOW_SEC = 72 * 3600; // 72h de bloqueio hardcoded para blindagem absoluta antiflood
  const POLL_INTERVAL_MS = 30_000; // polling de novos chats
  const MIN_REPLY_DELAY_MS = 0;
  const MAX_REPLY_DELAY_MS = 0;

  // cache em memória e timers
  const RESP_CACHE_MAX = 5000;
  function setResponded(id, ts) {
    if (!respondedCache.has(id) && respondedCache.size >= RESP_CACHE_MAX) {
      const first = respondedCache.keys().next().value;
      if (first !== undefined) respondedCache.delete(first);
    }
    respondedCache.set(id, ts);
  }
  const respondedCache = new Map();

  // ====== INÍCIO: Cooldown de Prova e Detecção de Novas Mensagens ======
  // Caches para evitar "martelar" o mesmo chat a cada loop
  const lastProbeMap = new Map(); // chatId -> Date.now() da última prova/checagem
  const lastClientTsMap = new Map(); // chatId -> ms do último cliente visto (memória local, opcional)

  function tsNum(x) {
    if (!x) return 0;
    const n = typeof x === 'number' ? x : Date.parse(x);
    return Number.isFinite(n) ? n : 0;
  }
  // ====== FIM: Cooldown de Prova e Detecção de Novas Mensagens ======

  // MILITAR: Timers unificados
  let filaInterval = null;
  let filaChatTimer = null;
  let scrollInterval = null; // Militar: cleaning interval to prevent interval leak

  let lastScrollToTop = 0;

  // trackers
  let saveChain = Promise.resolve();
  let filaLoopBusy = false;
  let recoverBackoffMs = 0;
  const failCounts = new Map();
  // Limpeza/cap failCounts — nunca deve passar de 1000
  function setFailCount(chatId, n) {
    if (!failCounts.has(chatId) && failCounts.size >= 1000) {
      const first = failCounts.keys().next().value;
      if (first !== undefined) failCounts.delete(first);
    }
    failCounts.set(chatId, n);
  }

  // Persistência segura no Windows
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
      // Fallback .tmp órfão
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
    // Garantir cap adicional do respondedCache
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
        // NÃO FECHAR EXTRAS se há busca ativa (BLOQUEIO CRÍTICO)
        try {
          if (browser._buscasLocalizacaoAtivas && browser._buscasLocalizacaoAtivas.size > 0) {
            // apenas retorna a main page disponível
            return page;
          }
        } catch {}

        try {
          if (browser && browser._robeActiveFor === nome) {
            // nada
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
          // cria nova aba
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
      if (!p) return [];
      try {
        if (!running || !epochOk()) return [];
        await garantirMarketplace(p);
      } catch (err) {
        logger.warn('Não está no Marketplace ou erro ao garantir Marketplace', { nome }, err);
        await sleep(5000);
        return [];
      }
      try {
        await Promise.race([
          p.waitForSelector('a[href^="/marketplace/t/"]', { timeout: 4000 }),
          p.waitForSelector('div[role="row"] span', { timeout: 4000 }),
        ]);
      } catch {}
      const todos = await coletaChatsMarketplaceTodos(p);
      const filtrados = todos.filter(c => c.id && isChatRecente(c.tempo));
      return filtrados;
    } catch (err) {
      logger.error('Erro ao coletar chats', { nome }, err);
      return [];
    }
  }

  // Reconciliação de pendências
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
          await p.goto(`https://www.messenger.com/marketplace/t/${chatId}/`, { waitUntil:'domcontentloaded', timeout: 20000 }).catch(()=>{});
          const looksSent = await wasRecentlySentByMe(p, 10*60*1000);
          if (looksSent) {
            // considera “committed”
            const tsNow = agoraEpoch();
            historico[chatId] = tsNow;
            setResponded(chatId, tsNow);
            await salvaHistorico();
            await pendingDel(nome, chatId);
          } else {
            // rollback: libera para reenvio
            await pendingDel(nome, chatId);
          }
        } catch { /* segue próximo */ }
      }
    } catch {}
  }

  async function initHistoricoSePreciso() {
    if (!running || !epochOk()) return;
    
    // NOVO: Desabilitar snapshot agressivo por padrão (pode habilitar via env var)
    const FIRST_BOOT_SNAPSHOT = process.env.VIRTUS_FIRST_BOOT_SNAPSHOT === '1';
    
    try {
      await fs.access(HIST_FILE);
      await carregaHistorico();
      await reconcilePendingsIfAny();
      log('Histórico existente carregado. Retomando pendentes <24h.');
      return;
    } catch {}

    // Snapshot agressivo desabilitado por padrão para não "matar" primeira onda de mensagens
    if (!FIRST_BOOT_SNAPSHOT) {
      log('[SNAPSHOT] Modo seguro: não marcando recents como respondidos no primeiro boot. (Defina VIRTUS_FIRST_BOOT_SNAPSHOT=1 para habilitar)');
      await carregaHistorico();
      await reconcilePendingsIfAny();
      return;
    }

    // Código antigo mantido apenas se FIRST_BOOT_SNAPSHOT estiver habilitado
    log('[SNAPSHOT] Primeiro boot sem histórico. Marcando <24h atuais como respondidos.');
    if (!running || !epochOk()) return;
    const p = await ensurePage();
    if (!p) { log('[SNAPSHOT] Falha ao garantir aba zero.'); return; }
    if (!running || !epochOk()) return;
    await garantirMarketplace(p);
    try {
      await Promise.race([
        p.waitForSelector('a[href^="/marketplace/t/"]', { timeout: 8000 }),
        p.waitForSelector('div[role="row"] span', { timeout: 8000 })
      ]);
    } catch {}
    try { await scrollListaAte8h(p, { maxMs: 90000, quietLoops: 3 }); } catch {}
    const todos = await coletaChatsMarketplaceTodos(p);
    const recentes = todos.filter(c => isChatRecente(c.tempo));
    const agora = agoraEpoch();
    historico = {};
    for (const chat of recentes) historico[chat.id] = agora;
    await salvaHistorico();
    await carregaHistorico();
    await reconcilePendingsIfAny();
    log(`[SNAPSHOT] Concluído. ${recentes.length} chats <24h marcados como respondidos no primeiro boot.`);
  }

  // NOVO: Reduzido de 24h para 8h (menos scroll = menos RAM consumida)
  async function scrollListaAte8h(page, { maxMs = 90000, quietLoops = 3 } = {}) {
    const t0 = Date.now();
    let semNovos = 0;
    let vistos = new Set();

    while ((Date.now() - t0) < maxMs) {
      const todos = await coletaChatsMarketplaceTodos(page);
      let houveNovo = false, viuAntigo = false;
      for (const c of todos) {
        if (!vistos.has(c.id)) { vistos.add(c.id); houveNovo = true; }
        if (isVelho8h(c.tempo)) viuAntigo = true; // NOVO: Usa isVelho8h
      }
      if (viuAntigo) break;
      if (!houveNovo) {
        semNovos += 1;
        if (semNovos >= quietLoops) break;
      } else {
        semNovos = 0;
      }
      try {
        const contSel = await page.evaluate(() => {
          const cands = ['div[role="grid"]','div[role="rowgroup"]','div.x78zum5.xdt5ytf'];
          for (const sel of cands) {
            const el = document.querySelector(sel);
            if (el && el.scrollHeight > el.clientHeight) return sel;
          }
          return 'body';
        });
        await page.evaluate((selector) => {
          const el = document.querySelector(selector) || document.scrollingElement || document.body;
          el.scrollTop = el.scrollHeight;
        }, contSel);
      } catch {
        try { await page.evaluate(() => window.scrollBy(0, Math.max(400, window.innerHeight * 0.8))); } catch {}
      }
      await sleep(800 + Math.floor(Math.random() * 500));
    }
    return Array.from(vistos);
  }

  async function atualizaFila() {
    let mudancaFila = false;
    const chatsNovos = await coletaChatsMarketplaceRecentes();
    let novosAti = 0;
    const agoraMs = Date.now();
    const aguard = getSetAguardando(nome);

    for (const c of chatsNovos) {
      const id = c.id;

      // Cooldown de 60s entre probes visuais
      const last = lastProbeMap.get(id) || 0;
      if ((agoraMs - last) < 60000) continue;

      // Não re-enfileirar se o chat está marcado como "aguardando_cliente" e cooldown ainda vigente
      try {
        const st = await getChatState(nome, id);
        if (st && st.state === CHAT_STATES.AGUARDANDO && st.cooldownUntil && st.cooldownUntil > Date.now()) {
          // está sob cooldown pós-envio; não enfileirar
          lastProbeMap.set(id, agoraMs);
          continue;
        }

        // INÍCIO PATCH: verificação persistida (disco) para evitar reenfileiramento sem novidade
        if (st && typeof st.lastCLIts === 'number' && typeof st.ultimoProbeCLIts === 'number' && st.lastCLIts === st.ultimoProbeCLIts) {
          // Sem mudança no último timestamp do cliente desde o último probe: NÃO enfileira
          lastProbeMap.set(id, agoraMs);
          continue;
        }

        // Não re-enfileirar chats em estado de erro_envio
        if (st && st.state === 'erro_envio') {
          // Não re-enfileira chats em estado de erro_envio (até que haja novidade real: nova mensagem do cliente)
          lastProbeMap.set(id, agoraMs);
          continue;
        }
        // FIM PATCH
      } catch {}

      if (!aguard.has(id) && !fila.includes(id)) {
        fila.push(id);
        lastProbeMap.set(id, agoraMs);
        novosAti++;
        log(`[FILA] Candidato ${id} enfileirado para inspeção de novas mensagens (${c.tempo})`);
        mudancaFila = true;
      }
    }

    if (novosAti > 0) {
      log(`[FILA] Atualizada: ${fila.length} chats pendentes para resposta.`);
    }
    return mudancaFila;
  }

  function scheduleNextIfIdle() {
    if (!running) return;
    if (chatAtivo) return;
    if (filaChatTimer) return;
    if (!fila.length) return;

    const next = fila[0];
    const delayMs = parseInt(process.env.VIRTUS_NEXT_CHAT_DELAY_MS || '2000', 10);
    logger.info('[FILA] Aguardando delay antes de processar próximo chat', { nome, chatId: next, delay: delayMs });
    filaChatTimer = setTimeout(async () => {
      try {
        if (!running || !epochOk()) return;
        // Revalida: se alguém setou chatAtivo nesse meio tempo, aborta e agenda novamente
        if (chatAtivo) {
          filaChatTimer = null;
          return scheduleNextIfIdle();
        }
        stepLog.appendJSONL(nome, 'virtus', { attempt: attId, step: 'schedule_reply', chatId: next });
        filaChatTimer = null;
        await responderChat(next);
        // Gap adicional para estabilidade entre chats
        setTimeout(scheduleNextIfIdle, Math.max(500, delayMs));
      } catch (e) {
        filaChatTimer = null;
        logger.error('[FILA] Erro no timer de atendimento', { nome, error: e && e.message || e });
        setTimeout(scheduleNextIfIdle, Math.max(500, delayMs));
      }
    }, delayMs);
  }

  async function responderChat(chatId) {
    if (!running || !epochOk()) return;
    // ========== INÍCIO BLOCO FREEZER INSTRUÇÃO 2 ==========
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
    // ========== FIM BLOCO FREEZER INSTRUÇÃO 2 ==========

    let _chatLockAcquired = false;
    try {
      // === INÍCIO GUARD DE VIDA NO RESPONDERCHAT ===
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
      // === FIM GUARD DE VIDA ===
      if (!chatId) return;

      // Lock de disco POR chatId!
      if (!chatLock.acquire(nome, chatId)) {
        stepLog.appendJSONL(nome, 'virtus', { step: 'skip_locked', chatId, attempt: attId });
        // logging adicional de lock fail
        stepLog.appendJSONL(nome, 'virtus', { step: 'chat_lock_busy', chatId, attempt: attId });
        try { await logIssue(nome, 'chat_lock_busy', `Falha ao adquirir lock para chat ${chatId}`); } catch {}
        fila = fila.filter(id => id !== chatId);
        chatAtivo = null;
        return;
      }
      _chatLockAcquired = true;
      
      logger.info('[CONTEXTO] Iniciando processamento', { nome, chatId });
      stepLog.appendJSONL(nome, 'virtus', { step: 'chat_lock_ok', chatId, attempt: attId });

      // Marcar estado como PENDENTE (APENAS disco)
      try {
        await setChatState(nome, chatId, { state: CHAT_STATES.PENDENTE });
      } catch {}

      // Ledger: adiciona pending imediatamente após adquirir lock
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
        await garantirMarketplace(p);

        // NOVO: Não bloquear baseado apenas em respondedCache
        // A verificação de "novas mensagens" será feita após coletar o histórico
        // Mantém apenas verificação de cooldown de prova (já feito em atualizaFila)

        let anchorSel = `a[href^="/marketplace/t/${chatId}"]`;
        await scrollChatsToTop(p, nome).catch(()=>{});
        await sleep(300);
        let found = await p.$(anchorSel);

        if (!found) {
          logger.warn(`Âncora do chatId ${chatId} não encontrada. Pulando para próximo chat.`, { nome, chatId });
          try { await pendingDel(nome, chatId); } catch {}
          fila = fila.filter(id => id !== chatId);
          chatAtivo = null;
          return;
        }

        await p.evaluate((sel) => {
          const el = document.querySelector(sel);
          if (el) {
            el.scrollIntoView({ behavior: 'auto', block: 'center', inline: 'center' });
            el.dispatchEvent(new MouseEvent('mousemove', { bubbles: true }));
            el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
            el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
            el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
          }
        }, anchorSel);

        let attempts = 0;
        let achou = false;
        let urlAtual = '';
        while (attempts < 8) {
          urlAtual = await p.evaluate(() => location.pathname);
          if (urlAtual.includes(`/marketplace/t/${chatId}`)) {
            achou = true;
            break;
          }
          await sleep(250);
          attempts++;
        }
        if (!achou) {
          logger.error(`Não entrou no chat correto após o click simulado. (urlAtual=${urlAtual}, esperado=${chatId})`, { nome, chatId });
          try { await pendingDel(nome, chatId); } catch {}
          fila = fila.filter(id => id !== chatId);
          chatAtivo = null;
          return;
        }

        // Ativa send-guard imediatamente após confirmar navegação correta
        await acquireSendGuard(p, chatId);

        if (await isChatBlocked(p)) {
          logger.warn('Chat bloqueado/indisponível, marcado respondido', { nome, chatId });
          try { await pendingDel(nome, chatId); } catch {}
          try { await logIssue(nome, 'virtus_blocked', `chat ${chatId} bloqueado/indisponível`); } catch {}
          fila = fila.filter(id => id !== chatId);
          chatAtivo = null;
          resetFail(chatId);
          return;
        }

        // Checagem de contexto antes de aguardar o composer
        if (!(await assertOnChat(p, chatId, { timeoutMs: 1200 }))) {
          try { await pendingDel(nome, chatId); } catch {}
          fila = fila.filter(id => id !== chatId);
          chatAtivo = null;
          await logIssue(nome, 'mil_action', `virtus_context_abort: url divergiu antes do envio (chat ${chatId})`);
          return;
        }

        let campo = await waitForComposer(p, 10000);
        if (!campo) {
          // sem reload imediato — ampliar a espera e tentar foco/scroll leve
          try { await p.evaluate(() => window.scrollBy(0, 120)); } catch {}
          campo = await waitForComposer(p, 8000);
        }
        if (!campo) {
          // último grace curto — sem reload
          await sleep(2000);
          campo = await waitForComposer(p, 3000);
        }

        if (!campo) {
          const fails = incFail(chatId);
          stepLog.appendJSONL(nome, 'virtus', { attempt: attId, step: 'composer_missing', chatId, failCount: fails });
          logger.error(`Composer indisponível para chat ${chatId}. Tentativas: ${fails}`, { nome, chatId });
          if (fails >= 2) {
            logger.warn(`${chatId} falhou 2x. Marcando como respondido para não travar fila.`, { nome, chatId });
            try { await pendingDel(nome, chatId); } catch {}
            try { await logIssue(nome, 'virtus_no_composer', `composer ausente após 2 tentativas (chat ${chatId})`); } catch {}
            resetFail(chatId);
          } else {
            try { await pendingDel(nome, chatId); } catch {}
          }
          fila = fila.filter(id => id !== chatId);
          chatAtivo = null;
          return;
        }
// REVALIDAÇÃO FINAL: verificação será feita após coletar histórico
// A lógica de "novas mensagens" substitui o gating por respondedCache

        resetFail(chatId);

        // 1. Extrai URL do classificado
        const urlClassificado = await extrairUrlClassificado(p, chatId);

        // 2. INÍCIO PATCH: Cache de localização por chat (persistida em disco)
        let localizacao = null;
        try {
          const stLoc = await getChatState(nome, chatId);
          if (stLoc && stLoc.cidade && stLoc.estado) {
            // Já temos cache persistido: NÃO buscar novamente
            localizacao = { cidade: stLoc.cidade, estado: stLoc.estado };
            logger.info('[LOCALIZACAO] Localização recuperada do cache', { 
              nome, 
              chatId, 
              cidade: localizacao.cidade, 
              estado: localizacao.estado 
            });
          } else {
            // Buscar apenas se não houver cache
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
        // FIM PATCH

        // Log detalhado sobre localização
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

        // 3. Identifica tipo de serviço
        const tipoServico = await identificarTipoServico(nome);

        // Marcar estado como GERANDO antes de coletar histórico
        try {
          await setChatState(nome, chatId, { state: CHAT_STATES.GERANDO });
        } catch {}

        // 4. Coleta TODO o histórico da conversa (mensagens do cliente e da IA)
        const historicoConversa = await extrairHistoricoConversa(p);
        
        logger.info('[CHAT] Histórico coletado', { 
          nome, 
          chatId, 
          totalMensagens: historicoConversa.length,
          mensagensCliente: historicoConversa.filter(m => m.autor === 'cliente').length,
          mensagensIA: historicoConversa.filter(m => m.autor === 'ia').length
        });

        // NOVO: Verificar se há mensagens novas do cliente após última resposta da IA
        // Determine última do cliente vs última da IA
        const ultimaIA = (() => {
          const iaMsgs = historicoConversa.filter(m => m.autor === 'ia');
          return iaMsgs.length ? iaMsgs[iaMsgs.length - 1] : null;
        })();

        const ultimaCliente = (() => {
          const cli = historicoConversa.filter(m => m.autor === 'cliente');
          return cli.length ? cli[cli.length - 1] : null;
        })();

        const tsIA = tsNum(ultimaIA && ultimaIA.timestamp);
        const tsCLI = tsNum(ultimaCliente && ultimaCliente.timestamp);

        // Atualizar timestamps no estado (APENAS disco)
        try {
          await setChatState(nome, chatId, {
            lastIATs: tsIA || 0,
            lastCLIts: tsCLI || 0
          });
        } catch {}

        // Se não há cliente, não há o que fazer
        if (!ultimaCliente) {
          log(`[SKIP] Chat ${chatId}: sem mensagem do cliente`);
          try {
            await setChatState(nome, chatId, { state: CHAT_STATES.AGUARDANDO, lastIATs: tsIA || 0 });
          } catch {}
          try { await pendingDel(nome, chatId); } catch {}
          fila = fila.filter(id => id !== chatId);
          chatAtivo = null;
          return;
        }

        // INÍCIO PATCH: Comparação de timestamps + conteúdo (persistida em disco)
        // Leitura do estado atual (persistido) para comparar conteúdo
        let estadoAnteriorChat = null;
        try { estadoAnteriorChat = await getChatState(nome, chatId); } catch {}
        const ultimaMsgAnterior = (estadoAnteriorChat && estadoAnteriorChat.ultimaMensagemClienteProcessada) || '';
        const ultimaMsgAtual = (ultimaCliente && ultimaCliente.texto) ? String(ultimaCliente.texto) : '';
        
        // Não tentar novamente se estiver marcado como erro_envio para a mesma mensagem do cliente
        if (estadoAnteriorChat && estadoAnteriorChat.state === 'erro_envio') {
          const curHash = hashResposta(ultimaMsgAtual);
          if (estadoAnteriorChat.ultimaMsgErroHash && estadoAnteriorChat.ultimaMsgErroHash === curHash) {
            log(`[SKIP] Chat ${chatId}: já marcado como erro_envio para esta mesma mensagem. Não tentar novamente.`);
            try { await pendingDel(nome, chatId); } catch {}
            fila = fila.filter(id => id !== chatId);
            chatAtivo = null;
            return;
          }
        }

        const haNovidadePorTimestamp = (!tsIA) || (tsCLI > tsIA);
        const haNovidadePorConteudo = (tsCLI >= (tsIA || 0)) && (ultimaMsgAtual && ultimaMsgAtual !== ultimaMsgAnterior);

        if (!(haNovidadePorTimestamp || haNovidadePorConteudo)) {
          log(`[SKIP] Chat ${chatId}: sem novidade por ts/conteúdo (tsCLI=${tsCLI} tsIA=${tsIA})`);
          try {
            await setChatState(nome, chatId, {
              state: CHAT_STATES.AGUARDANDO,
              lastIATs: tsIA || 0,
              ultimoProbeCLIts: tsCLI || 0
            });
          } catch {}
          try { await pendingDel(nome, chatId); } catch {}
          fila = fila.filter(id => id !== chatId);
          chatAtivo = null;
          return;
        }
        // FIM PATCH

        // OK: há novidade do cliente
        log(`[NOVO] Chat ${chatId}: há novidade do cliente (última cliente: ${new Date(tsCLI).toLocaleString()}, última IA: ${tsIA ? new Date(tsIA).toLocaleString() : 'nenhuma'})`);

        // NOVO: fluxo direto Groq (se DIRECT_GROQ ativo)
        if (DIRECT_GROQ) {
          try {
            logger.info('[CONTEXTO] Chamando Groq API', {
              nome,
              chatId,
              historicoLength: Array.isArray(historicoConversa) ? historicoConversa.length : 0
            });
            
            // Cidade preferencial: manifest.cidade > localizacao.cidade > null
            let cidadePreferida = null;
            try {
              const man = await manifestStore.read(nome).catch(()=>null);
              cidadePreferida = (man && man.cidade) ? man.cidade : null;
            } catch {}
            if (!cidadePreferida && localizacao && localizacao.cidade) {
              cidadePreferida = localizacao.cidade;
            }

            const promptUser = montarPromptUser(cidadePreferida, historicoConversa);
            const txt = await chamarGroqAPI(PROMPT_SYSTEM, promptUser);
            const parsed = parsearRespostaGroq(txt);

            // Atualiza dados coletados locais (cidade, telefone, cereja)
            atualizarDadosColetados(chatId, {
              cidade: cidadePreferida || null,
              telefone: parsed.telefone_extraido || null,
              dados: parsed.dados || {}
            });

            // Inicia timer se capturou telefone pela primeira vez
            const jaTinhaTimer = timersFechamento && timersFechamento.has(chatId);
            if (!jaTinhaTimer && parsed.telefone_extraido) {
              iniciarTimerFechamento(chatId, parsed.telefone_extraido);
            }

            // Reaproveitar a página atual e evitar reload/goto desnecessário
            const pAtual = await ensurePage().catch(() => null);
            if (!pAtual) throw new Error('page_unavailable_for_send');

            const okChat = await assertOnChat(pAtual, chatId, { timeoutMs: 1000 });
            if (!okChat) {
              const url0 = (typeof pAtual.url === 'function') ? (pAtual.url() || '') : '';
              if (!/\/marketplace\/t\//.test(url0)) {
                await pAtual.goto(`https://www.messenger.com/marketplace/t/${chatId}/`, { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(()=>{});
                await assertOnChat(pAtual, chatId, { timeoutMs: 5000 });
              }
            }

            // VALIDAÇÃO HARD: checa URL explícita
            const urlAtual = (typeof pAtual.url === 'function') ? (pAtual.url() || '') : '';
            if (!urlAtual.includes(`/marketplace/t/${chatId}/`)) {
              await logIssue(nome, 'mil_action', `context_mismatch_before_send url="${urlAtual}" chatId=${chatId}`);
              throw new Error('context_mismatch_before_send');
            }

            // Tente usar o composer já obtido anteriormente; se não existir, espere um pouco mais
            let campoEnvio = await waitForComposer(pAtual, 15000);
            if (!campoEnvio) {
              // sem reload automático — apenas mais um pequeno grace e tentativa de scroll
              try { await pAtual.evaluate(() => window.scrollBy(0, 100)); } catch {}
              campoEnvio = await waitForComposer(pAtual, 5000);
            }

            if (!campoEnvio) {
              // último grace, sem reload
              await sleep(3000);
              campoEnvio = await waitForComposer(pAtual, 3000);
            }

            if (!campoEnvio) throw new Error('composer_not_available_for_send');

            try {
              await setChatState(nome, chatId, { state: CHAT_STATES.ENVIANDO });
            } catch {}

            await sendMessageSafe(pAtual, campoEnvio, parsed.resposta, nome, chatId);

            await marcarRespondido(nome, chatId);

            try {
              await setChatState(nome, chatId, {
                ultimaMensagemClienteProcessada: ultimaMsgAtual,
                ultimoProbeCLIts: tsCLI || 0,
                lastIATs: Date.now()
              });
            } catch {}

            logger.info('[GROQ] Resposta enviada com sucesso', { chatId, finalizado: parsed.finalizado, tel: parsed.telefone_extraido });
          } catch (e) {
            logger.error('[GROQ] Falha no fluxo direto', { chatId, error: e && e.message || e });
            // Retry/backoff: registra tentativas e agenda reprocessamento
            try {
              const prev = await getChatState(nome, chatId);
              const attempts = (prev && prev.sendAttempts ? prev.sendAttempts : 0) + 1;
              const baseMin = 2; // 2min base
              const nextMs = Math.min(5 * 60 * 1000, Math.pow(2, attempts - 1) * baseMin * 60 * 1000); // max 5min

              if (attempts >= 3) {
                // Após 3 falhas, marca "erro_envio" e não tenta mais para esta mesma mensagem
                const msgHash = hashResposta(ultimaMsgAtual || '');
                await setChatState(nome, chatId, {
                  state: 'erro_envio',
                  sendAttempts: attempts,
                  ultimaMsgErroHash: msgHash,
                  ultimoProbeCLIts: tsCLI || 0
                });
                await logIssue(nome, 'virtus_send_failed', `erro_envio após ${attempts} tentativas (chat ${chatId})`);
              } else {
                // Backoff exponencial até 5min no estado AGUARDANDO
                await setChatState(nome, chatId, {
                  state: CHAT_STATES.AGUARDANDO,
                  sendAttempts: attempts,
                  cooldownUntil: Date.now() + nextMs,
                  ultimoProbeCLIts: tsCLI || 0
                });
                await logIssue(nome, 'virtus_send_failed', `retry_schedule attempt=${attempts} in=${Math.round(nextMs/1000)}s chat=${chatId}`);
              }
            } catch {}
            // encerra ciclo
            try { await pendingDel(nome, chatId); } catch {}
            fila = fila.filter(id => id !== chatId);
            chatAtivo = null;
            return;
          }
        } else {
          // Fluxo antigo: Notificador
          // 5. Formata localização no padrão "Cidade (UF)" para a planilha Google
          const localizacaoFormatada = formatarLocalizacaoParaPlanilha(localizacao);

          // 6. Adiciona na fila de envio para o notificador com TODO o histórico
          adicionarChatParaEnvio(nome, {
            chatId,
            tipoServico,
            historico: historicoConversa, // TODO o histórico da conversa
            localizacao: localizacaoFormatada,
            urlClassificado
          });

          // INÍCIO PATCH: Gravar última mensagem do cliente processada (persistida em disco) - caminho Notificador
          try {
            await setChatState(nome, chatId, {
              ultimaMensagemClienteProcessada: ultimaMsgAtual,
              ultimoProbeCLIts: tsCLI || 0
            });
          } catch {}
          // FIM PATCH
        }

        // Ledger: remove pending (chat foi processado)
        try { await pendingDel(nome, chatId); } catch {}
        fila = fila.filter(id => id !== chatId);
        chatAtivo = null;

      } catch (err) {
        const msgErr = (err && err.message) ? err.message : String(err);
        // Se alvo fechou, classificar corretamente e sair silenciosamente
        if (/Target closed|Protocol error.*Target closed|Session closed/i.test(msgErr)) {
          try { await logIssue(nome, 'browser_disconnected', `chat ${chatId}: target/page closed during send`); } catch {}
        } else {
          try { await logIssue(nome, 'virtus_send_failed', `chat ${chatId}: ${msgErr}`); } catch {}
        }
        logger.error('Erro ao responder chat', { nome, chatId }, err);
        // Rollback pending em caso de erro
        try { await pendingDel(nome, chatId); } catch {}
      }

      fila = fila.filter(id => id !== chatId);
      chatAtivo = null;
      if (VIRTUS_DETAILED_DEBUG) { log(`[DETAILED] ChatId ${chatId} removido da fila e finalizado.`); }
    } finally {
      // Garantia: nunca deixar pending zumbi
      try { await pendingDel(nome, chatId); } catch {}
      resetFail(chatId); // limpa failCounts quando fim do ciclo
      try { releaseSendGuard(p); } catch {}
      if (_chatLockAcquired) {
        try { chatLock.release(nome, chatId); } catch {}
        stepLog.appendJSONL(nome, 'virtus', { attempt: attId, step: 'chat_unlock', chatId });
      }
    }
  }

  // ========================
  // === BLOCO MODIFICADO ===
  // ========================
  async function filaManagerLoop() {
    if (!running || !epochOk()) return;
    // ========== INÍCIO BLOCO FREEZER INSTRUÇÃO 2 ==========
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
    // ========== FIM BLOCO FREEZER INSTRUÇÃO 2 ==========

    // === INÍCIO GUARD DE VIDA NO FILAMANAGERLOOP ===
    if (!browser || browser.isConnected?.() === false) {
      logger.error(`[VIRTUS][${nome}] Browser morto/desconectado — encerrando Virtus`, { nome });
      if (issues) try { await logIssue(nome, 'virtus_page_dead', 'browser morto/disconnected'); } catch {}
      running = false;
      if (filaInterval) clearInterval(filaInterval), filaInterval = null;
      if (filaChatTimer) clearTimeout(filaChatTimer), filaChatTimer = null;
      if (scrollInterval) clearInterval(scrollInterval), scrollInterval = null;
      return;
    }
    // Fim guard de vida browser

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


      // ======= INSTRUÇÃO: REMOVER BLOCO REVIVE AQUI =======
      /*
      // --- INÍCIO DETECTOR/REVIVE ---
      try {
        const reviveTimeoutMs = 1000;
        const jsTest = await Promise.race([
          p.evaluate(() => 1+41),
          new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), reviveTimeoutMs))
        ]);
      } catch (e) {
        try {
          log('[VIRTUS][REVIVE] Navegador detectado travado/sem resposta — abrindo aba fantasma para tentar reviver.');
          const tmp = await browser.newPage();
          setTimeout(() => { try { tmp.close(); } catch {} }, 1000);
        } catch (e2) {
        }
      }
      // --- FIM DETECTOR/REVIVE ---
      */
      // === BLOCO REMOVIDO CONFORME INSTRUÇÃO ===

      // Não dispare keepalive durante inserção de mensagem
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
          // Reforço após 800ms para garantir Messenger reativo
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
        // Reforço após 800ms para garantir Messenger reativo
        setTimeout(() => {
          if (!running || !epochOk()) return;
          try {
            const b = getBrowserFromPage(p);
            if (b && b._sendLock && b._sendLock.active) return;
          } catch {}
          scrollChatsToTop(p, nome);
        }, 800);
      } catch {}

      // ========== INÍCIO BLOCO ADICIONADO CONFORME INSTRUÇÃO ==========
      // Checagem de bloqueio temporário Messenger (DOM) — apenas LOG, congelamento é feito pelo nurseTick
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
          // Apenas LOG, não congele aqui! O nurseTick irá congelar.
          if (issues) try { await logIssue(nome, 'virtus_blocked', 'Messenger temporariamente bloqueado (Virtus/Marketplace)'); } catch {}
        }
      } catch {}
      // ========== FIM BLOCO ADICIONADO ==========

    } finally {
      filaLoopBusy = false;
    }
  }
  // ==== FIM BLOCO MODIFICADO ====

  // Controle de timer e dados por chat (escopo do perfil) - APENAS SE DIRECT_GROQ
  // Definido ANTES de responderChat() para estar acessível
  const timersFechamento = DIRECT_GROQ ? new Map() : null; // chatId -> { inicio, telefone, expirado }
  const dadosColetados = DIRECT_GROQ ? new Map() : null;   // chatId -> { cidade, telefone, ajudante, saida_tipo, saida_elevador, destino_tipo, destino_elevador, bairro_saida, bairro_destino, itens }
  const pedidosEnviados = DIRECT_GROQ ? new Set() : null;  // chatId já enviados

  function atualizarDadosColetados(chatId, { cidade = null, telefone = null, dados = {} } = {}) {
    if (!dadosColetados) return;
    if (!dadosColetados.has(chatId)) dadosColetados.set(chatId, {});
    const cur = dadosColetados.get(chatId);
    if (cidade && !cur.cidade) cur.cidade = cidade;
    if (telefone) cur.telefone = telefone;
    // dados cereja
    const keys = ['ajudante','saida_tipo','saida_elevador','destino_tipo','destino_elevador','bairro_saida','bairro_destino','itens'];
    for (const k of keys) {
      if (dados && dados[k] != null) cur[k] = dados[k];
    }
    dadosColetados.set(chatId, cur);
  }

  function iniciarTimerFechamento(chatId, telefone) {
    if (!timersFechamento) return;
    if (timersFechamento.has(chatId)) return; // não reinicia
    timersFechamento.set(chatId, { inicio: Date.now(), telefone, expirado: false });
    // 10 minutos depois, verifica
    setTimeout(() => verificarTimerExpirado(chatId), 10 * 60 * 1000);
    logger.info('[TIMER] Timer de 10min iniciado', { chatId, telefone });
  }

  async function verificarTimerExpirado(chatId) {
    if (!timersFechamento) return;
    const t = timersFechamento.get(chatId);
    if (!t || t.expirado) return;
    const decorrido = Date.now() - t.inicio;
    if (decorrido >= 10 * 60 * 1000) {
      t.expirado = true;
      timersFechamento.set(chatId, t);
      logger.info('[TIMER] Timer expirado — fechando pedido', { chatId });
      const dados = dadosColetados ? (dadosColetados.get(chatId) || {}) : {};
      try {
        await enviarPedidoParaNotificador(chatId, dados);
        if (pedidosEnviados) pedidosEnviados.add(chatId);
        await enviarMensagemFinal(chatId);
        await marcarRespondido(nome, chatId); // marca local
      } catch (e) {
        logger.error('[TIMER] Falha ao fechar pedido', { chatId, error: e && e.message || e });
      }
    }
  }

  async function enviarPedidoParaNotificador(chatId, dados) {
    if (!pedidosEnviados || pedidosEnviados.has(chatId)) return; // Enviar apenas 1x
    const payload = {
      servidor: NOTIFICADOR_SERVIDOR || 'servidor1',
      perfil: nome,
      chat_id: chatId,
      cidade: dados.cidade || null,
      telefone: dados.telefone || null,
      ajudante: dados.ajudante || null,
      saida_tipo: dados.saida_tipo || null,
      saida_elevador: dados.saida_elevador || null,
      destino_tipo: dados.destino_tipo || null,
      destino_elevador: dados.destino_elevador || null,
      bairro_saida: dados.bairro_saida || null,
      bairro_destino: dados.bairro_destino || null,
      itens: dados.itens || null,
      timestamp: Date.now()
    };
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
    const mensagem = 'Perfeito! Recebi todas as informações. Já vou processar seu pedido e te chamar no WhatsApp. Obrigado pela confiança! 🙌\n\nSiga nosso Instagram: @seu_instagram';
    let p = await ensurePage().catch(() => null);
    if (!p) return;
    try {
      await p.goto(`https://www.messenger.com/marketplace/t/${chatId}/`, { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(()=>{});
      const okOn = await assertOnChat(p, chatId, { timeoutMs: 5000 });
      if (!okOn) return;
      let campo = await waitForComposer(p, 8000);
      if (!campo) {
        await p.reload({ waitUntil: 'domcontentloaded', timeout: 12000 }).catch(()=>{});
        campo = await waitForComposer(p, 8000);
      }
      if (!campo) return;
      await sendMessageSafe(p, campo, mensagem, nome, chatId);
      logger.info('[MESSENGER] Mensagem final enviada', { chatId });
    } catch (e) {
      logger.warn('[MESSENGER] Falha ao enviar mensagem final', { chatId, error: e && e.message || e });
    }
  }

  async function runner() {
    const attId = stepLog.attemptId();

    // ========== INÍCIO BLOCO FREEZER INSTRUÇÃO 2 ==========
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
    // ========== FIM BLOCO FREEZER INSTRUÇÃO 2 ==========

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
        await garantirMarketplace(p, { timeoutMs: 25000 });
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
      } catch (err) {
        if (!running) return;
        logger.error('Falha ao garantir aba zero no startup Virtus', { nome }, err);
        await sleep(2500);
      }
    }
    if (!running || !epochOk()) return;
    await initHistoricoSePreciso();
    
    // Inicialização do Notificador (apenas se não estiver em modo DIRECT_GROQ)
    if (!DIRECT_GROQ) {
      try {
        await fazerHandshakeNotificador(nome);
        iniciarPollingRespostas(nome);
        
        // Implementa enviarRespostaMessengerSegura dentro do contexto do Virtus
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
            logger.debug('[MESSENGER] Tentativa de envio', { nome, chatId, attempt, maxTries: MAX_TRIES });
            
            await p.goto(`https://www.messenger.com/marketplace/t/${chatId}/`, { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
            
            const okOn = await assertOnChat(p, chatId, { timeoutMs: 5000 });
            if (!okOn) {
              throw new Error('chat_not_opened');
            }
            
            let campo = await waitForComposer(p, 10000);
            if (!campo) {
              try {
                await p.reload({ waitUntil: 'domcontentloaded', timeout: 12000 }).catch(() => {});
              } catch {}
              campo = await waitForComposer(p, 8000);
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
              // Aguardar antes de retry
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
      
      // Implementa marcarRespondido dentro do contexto do Virtus
      async function marcarRespondidoLocal(chatId) {
        try {
          const agoraTs = agoraEpoch();
          let historicoLocal = {};
          try { historicoLocal = await readJson(HIST_FILE, {}); } catch {}
          historicoLocal[chatId] = agoraTs;
          await writeJsonAtomicFsync(HIST_FILE, historicoLocal);
          // atualiza cache local do Virtus
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
    } else {
      // Modo DIRECT_GROQ: nada a fazer aqui (responderChat envia diretamente no Messenger)
      logger.info('[GROQ] Modo DIRECT_GROQ ativo', { nome });
    }
    
    filaInterval = setInterval(filaManagerLoop, POLL_INTERVAL_MS);
    filaManagerLoop();
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
      // ========== Limpeza para evitar leaks ==========
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