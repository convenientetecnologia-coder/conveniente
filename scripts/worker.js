// scripts/worker.js
// ATENÇÃO: Worker NUNCA interage nem clica/open/chat na aba principal Messenger.
// TODO acesso UI de chat deve ser feito via callback handler que Virtus registra via global.__buscaLocalizacaoVirtus.solicitarAberturaChat.
// O worker só pede, aguarda, e opera ABA NOVA para scraping/classificado.
// Worker nunca faz evaluate/click/focus na mainPage; só coordena fila, locks, scraping em abas extras.

const path = require('path');
const fs = require('fs');
const logger = require('./logger.js');
const { detectLimitOverlayDeep, detectLimitOverlayEverywhere } = require('./browser.js');

const browserHelper = require('./browser.js');

// ====== INÍCIO: LOCK GLOBAL DE LOCALIZAÇÃO (arquivo) ======
const LOC_GLOBAL_LOCK_FILE = path.join(__dirname, '..', 'dados', 'loc_global.lock');

async function acquireGlobalLocLock(timeoutMs = 60000) {
  const start = Date.now();
  while ((Date.now() - start) < timeoutMs) {
    try {
      const fd = fs.openSync(LOC_GLOBAL_LOCK_FILE, 'wx');
      try {
        fs.writeFileSync(fd, String(Date.now()), 'utf8');
        fs.fsyncSync(fd);
      } finally {
        try { fs.closeSync(fd); } catch {}
      }
      try { logger.info('[LOCALIZACAO][LOCK] ACQUIRED', { file: LOC_GLOBAL_LOCK_FILE }); } catch {}
      return true;
    } catch {
      try {
        const st = fs.statSync(LOC_GLOBAL_LOCK_FILE);
        const age = Date.now() - st.mtimeMs;
        if (age > 45 * 1000) {
          try { fs.unlinkSync(LOC_GLOBAL_LOCK_FILE); } catch {}
        }
      } catch {}
      await new Promise(r => setTimeout(r, 25));
    }
  }
  try { logger.warn('[LOCALIZACAO][LOCK] TIMEOUT', { file: LOC_GLOBAL_LOCK_FILE, timeoutMs }); } catch {}
  return false;
}

function releaseGlobalLocLock() {
  try { fs.unlinkSync(LOC_GLOBAL_LOCK_FILE); } catch {}
  try { logger.info('[LOCALIZACAO][LOCK] RELEASED', { file: LOC_GLOBAL_LOCK_FILE }); } catch {}
}
// ====== FIM: LOCK GLOBAL DE LOCALIZAÇÃO (arquivo) ======

// Snapshot status throttle (evita overkill em ambientes multi-perfil)
let _lastSnapAt = 0;

// ====== INÍCIO: FILA GLOBAL DE BUSCA DE LOCALIZAÇÃO (sem ciclo) ======
const filaBuscaLocalizacao = [];
let processandoBuscaLocalizacao = false;

// Deduplicação e fan-out de callbacks por (perfil + chatId)
const _cityActiveKeys = new Set();           // keys em processamento (nomePerfil::chatId)
const _cityWaiters = new Map();              // key -> [callbacks]
function _cityKey(nomePerfil, chatId) {
  return String(nomePerfil || '') + '::' + String(chatId || '');
}
function _getCtrl(nomePerfil) {
  try {
    if (!nomePerfil) return null;
    const ctrlGlobal = (global && global.controllers) ? global.controllers.get(nomePerfil) : null;
    if (ctrlGlobal) return ctrlGlobal;
    // eslint-disable-next-line no-undef
    if (typeof controllers !== 'undefined') {
      // eslint-disable-next-line no-undef
      return controllers.get(nomePerfil);
    }
    return null;
  } catch { return null; }
}

// Registra no global para uso pelo Virtus (sem require de worker.js)
// Coleta de localização: clique/navegação/seleção na aba zero Messenger só é executada pelo Virtus.js (UI driver), nunca pelo worker — esta função apenas gerencia fila de pedidos e locks.
global.__buscaLocalizacaoVirtus = {
  adicionarBuscaLocalizacao: (chatId, urlClassificado, nomePerfil, callback) => {
    try {
      if (!chatId || !nomePerfil) {
        try { callback && callback(null); } catch {}
        return;
      }

      const key = _cityKey(nomePerfil, chatId);

      // Fan-out de callbacks (mesmo chat/perfil compartilha resultado)
      const prev = _cityWaiters.get(key) || [];
      if (typeof callback === 'function') {
        _cityWaiters.set(key, prev.concat([callback]));
      } else {
        _cityWaiters.set(key, prev);
      }

      // Evita duplicar na fila se já existe item enfileirado OU ativo
      const alreadyQueued = filaBuscaLocalizacao.some(ent => ent && ent.chatId === chatId && ent.nomePerfil === nomePerfil);
      const isActive = _cityActiveKeys.has(key);

      if (alreadyQueued || isActive) {
        logger.info('[LOCALIZACAO] Pedido de coleta deduplicado (já enfileirado/ativo)', { nomePerfil, chatId });
        return;
      }

      // Enfileira com metadados de controle
      filaBuscaLocalizacao.push({ chatId, urlClassificado, nomePerfil, retries: 0, enqueuedAt: Date.now() });
      processarFilaBuscaLocalizacao();
    } catch (e) {
      logger.error('[LOCALIZACAO] Falha ao enfileirar', { chatId, error: e && e.message || e });
      try { callback && callback(null); } catch {}
    }
  },
  // Handler que Virtus deve registrar para executar o clique/abertura do chat na mainPage e extrair a URL do classificado
  // Virtus deve fazer: global.__buscaLocalizacaoVirtus.solicitarAberturaChat = function(perfil, chatId, callback) { ... }
  // ONLY Virtus (UI driver) can execute the chat opening/click on Messenger. Worker just requests via handler.
  solicitarAberturaChat: null // Será preenchido pelo Virtus.js
};

async function processarFilaBuscaLocalizacao() {
  if (processandoBuscaLocalizacao) return;
  if (filaBuscaLocalizacao.length === 0) return;

  processandoBuscaLocalizacao = true;

  const item = filaBuscaLocalizacao.shift();
  // Normaliza estrutura (backward-compat)
  item.retries = Number(item.retries || 0);
  const key = _cityKey(item.nomePerfil, item.chatId);

  try {
    const ctrl = _getCtrl(item.nomePerfil);

    // Se o perfil não está pronto/ativo, re-enfileira
    if (!ctrl || !ctrl.browser || (ctrl.browser.isConnected && ctrl.browser.isConnected() === false)) {
      logger.info('[LOCALIZACAO] Adiado: perfil/navegador indisponível', { nomePerfil: item.nomePerfil, chatId: item.chatId });
      filaBuscaLocalizacao.push(item);
      processandoBuscaLocalizacao = false;
      setTimeout(() => processarFilaBuscaLocalizacao(), 2000);
      return;
    }

    // GATE 1: Robe ativo — coletar cidade só depois do Robe
    if (ctrl && ctrl.browser && ctrl.browser._robeActiveFor === item.nomePerfil) {
      logger.info('[LOCALIZACAO] Adiado: Robe ativo neste perfil', { nomePerfil: item.nomePerfil, chatId: item.chatId });
      filaBuscaLocalizacao.push(item);
      processandoBuscaLocalizacao = false;
      setTimeout(() => processarFilaBuscaLocalizacao(), 2000);
      return;
    }

    // GATE 2: Envio em andamento — aguardar
    const sendLockActive = !!(ctrl && ctrl.browser && ctrl.browser._sendLock && ctrl.browser._sendLock.active);
    if (sendLockActive) {
      logger.info('[LOCALIZACAO] Adiado: envio ativo (sendLock)', { nomePerfil: item.nomePerfil, chatId: item.chatId });
      filaBuscaLocalizacao.push(item);
      processandoBuscaLocalizacao = false;
      setTimeout(() => processarFilaBuscaLocalizacao(), 2000);
      return;
    }

    // GATE 3: Modo humano/configuração — aguardar
    if (ctrl && (ctrl.humanControl === true || ctrl.configurando === true)) {
      logger.info('[LOCALIZACAO] Adiado: human/config mode', { nomePerfil: item.nomePerfil, chatId: item.chatId });
      filaBuscaLocalizacao.push(item);
      processandoBuscaLocalizacao = false;
      setTimeout(() => processarFilaBuscaLocalizacao(), 2000);
      return;
    }

    // Marca ativo e bloqueia perfil para "city"
    _cityActiveKeys.add(key);
    try { ctrl.busyReason = 'city'; } catch {}

    logger.info('[LOCALIZACAO] Coleta iniciada', { nomePerfil: item.nomePerfil, chatId: item.chatId, tentativa: (item.retries + 1) });

    let localizacao = null;
    try {
      localizacao = await buscarLocalizacaoClassificado(item.chatId, item.urlClassificado, item.nomePerfil);
    } catch (e) {
      logger.warn('[LOCALIZACAO] Exceção durante coleta', { nomePerfil: item.nomePerfil, chatId: item.chatId, error: (e && e.message) || e });
    } finally {
      try { if (ctrl && ctrl.busyReason === 'city') delete ctrl.busyReason; } catch {}
      _cityActiveKeys.delete(key);
    }

    if (localizacao && localizacao.cidade && localizacao.estado) {
      logger.info('[LOCALIZACAO] Coleta OK', {
        nomePerfil: item.nomePerfil,
        chatId: item.chatId,
        cidade: localizacao.cidade,
        estado: localizacao.estado
      });

      const cbs = _cityWaiters.get(key) || [];
      _cityWaiters.delete(key);
      for (const cb of cbs) { try { cb(localizacao); } catch {} }
    } else {
      // Falhou — retentativa até 5x
      const nextTry = item.retries + 1;
      if (nextTry < 5) {
        item.retries = nextTry;
        filaBuscaLocalizacao.push(item);
        logger.warn('[LOCALIZACAO] Falha na coleta — re-tentando', { nomePerfil: item.nomePerfil, chatId: item.chatId, retry: nextTry });
      } else {
        logger.warn('[LOCALIZACAO] Falha na coleta — limite de tentativas esgotado', { nomePerfil: item.nomePerfil, chatId: item.chatId, retries: nextTry });
        const cbs = _cityWaiters.get(key) || [];
        _cityWaiters.delete(key);
        for (const cb of cbs) { try { cb(null); } catch {} }
      }
    }
  } catch (e) {
    logger.error('[LOCALIZACAO] Erro ao processar item da fila', { error: (e && e.message) || e });
    try {
      const cbs = _cityWaiters.get(key) || [];
      _cityWaiters.delete(key);
      for (const cb of cbs) { try { cb(null); } catch {} }
    } catch {}
  } finally {
    processandoBuscaLocalizacao = false;
    setTimeout(() => processarFilaBuscaLocalizacao(), 2000);
  }
}

async function buscarLocalizacaoClassificado(chatId, urlClassificado, nomePerfil) {
  // NOTA: 'controllers' será declarado mais adiante no arquivo. A função só será executada
  // depois que 'controllers' existir (quando Virtus chamar a fila). Isso é seguro.

  // Resolve controller pelo global ou escopo local
  const ctrlGlobal = (global && global.controllers) ? global.controllers.get(nomePerfil) : null;
  let ctrl = ctrlGlobal;
  try {
    if (!ctrl) {
      // eslint-disable-next-line no-undef
      if (typeof controllers !== 'undefined') {
        // eslint-disable-next-line no-undef
        ctrl = controllers.get(nomePerfil);
      }
    }
  } catch {}

  if (!ctrl || !ctrl.browser) return null;

  return await _execBusca(ctrl);

  async function _execBusca(controller) {
    const browser = controller.browser;

    // ====== INÍCIO: EXTRATOR ROBUSTO DE CIDADE/UF NO ANÚNCIO ======
    async function _extractCityUF(page, candidates = []) {
      const UF_SET = new Set(['AC','AL','AP','AM','BA','CE','DF','ES','GO','MA','MT','MS','MG','PA','PB','PR','PE','PI','RJ','RN','RS','RO','RR','SC','SP','SE','TO']);

      function _parseLineCityUf(s) {
        if (!s) return null;
        const str = String(s).trim();
        const m = /([A-Za-zÀ-ÿ0-9 .\-']+),\s*([A-Za-z]{2})\b/.exec(str);
        if (!m) return null;
        const cidade = (m[1] || '').trim();
        const uf = (m[2] || '').toUpperCase();
        if (!cidade || !UF_SET.has(uf)) return null;
        return { cidade, estado: uf };
      }

      function _parseFromCandidates(list) {
        for (const s of (list || [])) {
          const out = _parseLineCityUf(s);
          if (out) return out;
        }
        return null;
      }

      // 1) Tentativa direta por seletores — spans e anchors visíveis no anúncio
      const direct = await page.evaluate(() => {
        function isVisible(el) {
          try {
            const st = window.getComputedStyle(el);
            if (!st) return false;
            if (st.visibility === 'hidden' || st.display === 'none') return false;
            const r = el.getBoundingClientRect();
            return !!(r && r.width > 0 && r.height > 0);
          } catch { return false; }
        }
        function pickText(el) {
          return (el && (el.innerText || el.textContent) || '').trim();
        }
        const out = [];

        // a) Spans visíveis com padrão "Cidade, UF"
        const spans = Array.from(document.querySelectorAll('span'));
        for (const s of spans) {
          if (!isVisible(s)) continue;
          const t = pickText(s);
          if (t) out.push(t);
        }

        // b) Anchors do Marketplace (ex.: "Anunciado em <a ...>Florianópolis, SC</a>")
        const anchors = Array.from(document.querySelectorAll('a[href^="/marketplace/"], a[href*="/marketplace/"]'));
        for (const a of anchors) {
          if (!isVisible(a)) continue;
          const t = pickText(a);
          if (t) out.push(t);
        }

        // c) Regiões principais (header, main, pagelet Marketplace)
        const regs = [
          document.querySelector('header'),
          document.querySelector('[role="main"]'),
          document.querySelector('[data-pagelet*="Marketplace"]')
        ].filter(Boolean);
        for (const r of regs) {
          const txt = pickText(r);
          if (txt) {
            const lines = txt.split(/\n+/).map(s => s.trim()).filter(Boolean);
            out.push(...lines);
          }
        }

        return out;
      });

      let best = _parseFromCandidates(direct);
      if (best) return best;

      // 2) Fallback: usa candidatos já coletados
      best = _parseFromCandidates(candidates);
      if (best) return best;

      // 3) Fallback final: meta/title/og:description
      const metaText = await page.evaluate(() => {
        try {
          const arr = [];
          const title = (document.title || '').trim();
          if (title) arr.push(title);
          const md = document.querySelector('meta[name="description"]');
          if (md && md.content) arr.push(md.content.trim());
          const ogd = document.querySelector('meta[property="og:description"]');
          if (ogd && ogd.content) arr.push(ogd.content.trim());
          return arr.join('\n');
        } catch { return ''; }
      });
      best = _parseFromCandidates([metaText].concat(candidates || []));
      return best || null;
    }
    // ====== FIM: EXTRATOR ROBUSTO DE CIDADE/UF NO ANÚNCIO ======

    // Coleta de localização: clique/navegação/seleção na aba zero Messenger só é executada pelo Virtus.js (UI driver), nunca pelo worker — esta função apenas gerencia fila de pedidos e locks.
    // Worker solicita abertura do chat via handler global que Virtus consome quando seguro.
    // ONLY Virtus (UI driver) can execute the chat opening/click on Messenger. Worker just requests via handler.
    // ATENÇÃO: Worker NUNCA interage nem clica/open/chat na aba principal Messenger.
    // TODO acesso UI de chat deve ser feito via callback handler que Virtus registra via global.__buscaLocalizacaoVirtus.solicitarAberturaChat.
    // O worker só pede, aguarda, e opera ABA NOVA para scraping/classificado.
    async function _descobrirUrlClassificadoSeNecessario() {
      if (urlClassificado && typeof urlClassificado === 'string' && urlClassificado.trim()) {
        return urlClassificado;
      }

      // Handler global que Virtus consome para abrir chat e extrair URL do item
      const handler = (global && global.__buscaLocalizacaoVirtus && global.__buscaLocalizacaoVirtus.solicitarAberturaChat) 
        ? global.__buscaLocalizacaoVirtus.solicitarAberturaChat 
        : null;

      if (!handler || typeof handler !== 'function') {
        logger.warn('[LOCALIZACAO] Handler de abertura de chat não disponível (Virtus não registrou)', { nomePerfil, chatId });
        return null;
      }

      // Solicita ao Virtus que abra o chat e extraia a URL (Virtus faz o clique/navegação quando seguro)
      // ONLY Virtus (UI driver) can execute the chat opening/click on Messenger. Worker just requests via handler.
      // NUNCA tenta fallback para click na mainPage sob hipótese alguma.
      return new Promise((resolve) => {
        const timeout = setTimeout(() => {
          resolve(null);
        }, 15000); // Timeout de 15s

        try {
          handler(nomePerfil, chatId, (url) => {
            clearTimeout(timeout);
            resolve(url || null);
          });
        } catch (e) {
          clearTimeout(timeout);
          logger.warn('[LOCALIZACAO] Erro ao solicitar abertura de chat', { nomePerfil, chatId, error: e && e.message || e });
          resolve(null);
        }
      });
    }

    // Flag global ANTES de newPage
    let buscaId = '';
    let lockAcquired = false;
    let novaAba = null;

    try {
      // Garante estrutura para flags de busca
      if (!browser._buscasLocalizacaoAtivas) {
        browser._buscasLocalizacaoAtivas = new Set();
      }
      buscaId = `busca_${Date.now()}_${Math.random().toString(36).slice(2)}`;
      browser._buscasLocalizacaoAtivas.add(buscaId);
      try {
        logger.info('[LOCALIZACAO] Flag adicionada', { nomePerfil, buscaId, flagSize: browser._buscasLocalizacaoAtivas.size });
      } catch {}

      // Adquiri lock global (1 coleta por vez no servidor inteiro)
      lockAcquired = await acquireGlobalLocLock(60000);
      if (!lockAcquired) {
        try {
          logger.warn('[LOCALIZACAO] Lock global não adquirido (timeout)', { nomePerfil, chatId });
        } catch {}
        return null;
      }

      // Abre nova aba PROTEGIDA (pruner respeita esta marca)
      novaAba = await browser.newPage();
      try {
        novaAba._buscaLocalizacao = true;
        novaAba._buscaLocalizacaoSince = Date.now();
        novaAba._buscaLocalizacaoChatId = chatId;
      } catch {}

      // Descobre URL do classificado solicitando ao Virtus que abra o chat (Virtus faz clique/navegação quando seguro)
      // ONLY Virtus (UI driver) can execute the chat opening/click on Messenger. Worker just requests via handler.
      let targetUrl = await _descobrirUrlClassificadoSeNecessario();
      if (!targetUrl || typeof targetUrl !== 'string') {
        try {
          logger.warn('[LOCALIZACAO] Localização NÃO encontrada (sem url do item)', { nomePerfil, chatId, urlClassificado });
        } catch {}
        return null;
      }

      // Vai para a página do classificado
      await novaAba.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});

      // Aguarda elementos do anúncio surgirem (sem travar o fluxo)
      await Promise.race([
        novaAba.waitForSelector('a[href^="/marketplace/"]', { timeout: 8000 }).catch(() => null),
        novaAba.waitForSelector('span', { timeout: 8000 }).catch(() => null),
        new Promise(r => setTimeout(r, 1500))
      ]).catch(() => {});

      // Apenas scraping DOM - coleta candidatos de texto, SEM parsing
      const candidates = await novaAba.evaluate(() => {
        try {
          function isVisible(el) {
            try {
              const st = window.getComputedStyle(el);
              if (!st) return false;
              if (st.visibility === 'hidden' || st.display === 'none') return false;
              const r = el.getBoundingClientRect();
              return !!(r && r.width > 0 && r.height > 0);
            } catch { return false; }
          }
          const candidates = [];

          // Estratégia 1 — Anchor de localização do Marketplace
          {
            const anchors = Array.from(document.querySelectorAll('a[role="link"][href^="/marketplace/"], a[href^="/marketplace/"]'))
              .filter(a => {
                const href = (a.getAttribute('href') || '').trim();
                return href && !/\/t\//i.test(href) && !/\/item\//i.test(href);
              });
            for (const a of anchors) {
              if (!isVisible(a)) continue;
              const texts = [
                (a.innerText || a.textContent || '').trim(),
                ...Array.from(a.querySelectorAll('span')).map(s => (s.innerText || s.textContent || '').trim())
              ].filter(Boolean);
              candidates.push(...texts);
            }
          }

          // Estratégia 2 — Spans e Divs visíveis
          {
            const nodes = Array.from(document.querySelectorAll('span,div'));
            for (const el of nodes) {
              if (!isVisible(el)) continue;
              const txt = (el.innerText || el.textContent || '').trim();
              if (txt) candidates.push(txt);
            }
          }

          // Estratégia 3 — Cabeçalhos/regiões principais
          {
            const regs = [
              document.querySelector('header'),
              document.querySelector('[role="main"]'),
              document.querySelector('[data-pagelet*="Marketplace"]')
            ].filter(Boolean);
            for (const r of regs) {
              const lines = ((r.innerText || r.textContent || '') || '').split(/\n+/).map(s => s.trim()).filter(Boolean);
              candidates.push(...lines);
            }
          }

          // Estratégia 4 — Último recurso: fullText
          {
            const full = (document.body && (document.body.innerText || document.body.textContent) || '');
            if (full) {
              const parts = full.split(/\n+/).map(x => x.trim()).filter(Boolean);
              candidates.push(...parts);
            }
          }

          return candidates;
        } catch {
          return [];
        }
      });

      // Parsing robusto local (sem dependência externa)
      const finalLocal = await _extractCityUF(novaAba, candidates);

      if (finalLocal && finalLocal.cidade && finalLocal.estado) {
        try {
          logger.info('[LOCALIZACAO] Localização encontrada no classificado', {
            nomePerfil,
            chatId,
            cidade: finalLocal.cidade,
            estado: finalLocal.estado,
            urlClassificado: targetUrl
          });
        } catch {}
      } else {
        try {
          logger.warn('[LOCALIZACAO] Localização NÃO encontrada no classificado', {
            nomePerfil,
            chatId,
            urlClassificado: targetUrl
          });
        } catch {}
      }

      return finalLocal || null;
    } catch (e) {
      try {
        logger.error('[LOCALIZACAO] Erro ao buscar localização', { nomePerfil, chatId, error: (e && e.message) || e });
      } catch {}
      return null;
    } finally {
      // Fechamento e limpeza garantidos
      try { if (novaAba) await novaAba.close({ runBeforeUnload: false }); } catch {}
      try { if (browser._buscasLocalizacaoAtivas) browser._buscasLocalizacaoAtivas.delete(buscaId); } catch {}
      try { if (novaAba) { delete novaAba._buscaLocalizacao; delete novaAba._buscaLocalizacaoSince; delete novaAba._buscaLocalizacaoChatId; } } catch {}
      try {
        logger.info('[LOCALIZACAO] Flag removida/aba fechada', {
          nomePerfil, buscaId, flagSize: (browser._buscasLocalizacaoAtivas && browser._buscasLocalizacaoAtivas.size) || 0
        });
      } catch {}
      if (lockAcquired) {
        try { releaseGlobalLocLock(); } catch {}
      }
    }
  }
}

// expõe no module.exports para ambientes que realmente façam require deste arquivo
module.exports = module.exports || {};
module.exports.adicionarBuscaLocalizacao = global.__buscaLocalizacaoVirtus.adicionarBuscaLocalizacao;
module.exports.processarFilaBuscaLocalizacao = processarFilaBuscaLocalizacao;
module.exports.buscarLocalizacaoClassificado = buscarLocalizacaoClassificado;

// também deixa controllers acessível via global para a função acima
// (será atualizado quando controllers for definido mais abaixo no arquivo)
// ====== FIM: FILA GLOBAL DE BUSCA DE LOCALIZAÇÃO ======

const virtusHelper = require('./virtus.js');
const robeHelper   = require('./robe.js');
const robeQueue    = require('./robeQueue.js');
const utils        = require('./utils.js');
const fotos        = require('./fotos.js');
const reloadManager = require('./reloadManager.js');

const issues = require('./issues.js');
const manifestStore = require('./manifestStore.js');
const fileStore = require('./fileStore.js');

const _profileOpLocks = new Map();
async function lockProfileAction(nome, fn) {
  if (!nome) return fn();
  const prev = _profileOpLocks.get(nome) || Promise.resolve();
  let resolveNext;
  const next = new Promise(res => resolveNext = res);
  _profileOpLocks.set(nome, prev.then(() => next));
  try {
    await prev;
    return await fn();
  } finally {
    resolveNext();
    if (_profileOpLocks.get(nome) === next) _profileOpLocks.delete(nome);
  }
}

async function readAccountFlags(nome) {
  try {
    const m = await manifestStore.read(nome).catch(()=>null);
    return (m && m.accountFlags) ? m.accountFlags : {};
  } catch { return {}; }
}

async function setLoginRequiredFlag(nome, { reason = '', source = '' } = {}) {
  try {
    const prev = await readAccountFlags(nome);
    const already = prev && prev.loginRequired === true;
    await manifestStore.update(nome, (man) => {
      man = man || {};
      man.accountFlags = man.accountFlags || {};
      man.accountFlags.loginRequired = true;
      man.accountFlags.loginReason = String(reason||'');
      man.accountFlags.loginSource = String(source||'');
      man.accountFlags.lastLoginRequiredAt = Date.now();
      return man;
    });
    if (!already) {
      await issues.append(
        nome,
        'login_required_detected',
        `reason=${reason||''} source=${source||''} at=${new Date().toISOString()}`
      );
    }
    robeMeta[nome] = robeMeta[nome] || {};
    robeMeta[nome].loginRequired = true;
    robeMeta[nome].loginReason = reason || '';
  } catch {}
}

async function setBannedFlag(nome, { reason = '', snippet = '' } = {}) {
  try {
    const prev = await readAccountFlags(nome);
    const already = prev && prev.banned === true;
    await manifestStore.update(nome, (man) => {
      man = man || {};
      man.accountFlags = man.accountFlags || {};
      man.accountFlags.banned = true;
      man.accountFlags.bannedAt = Date.now();
      man.accountFlags.bannedReason = String(reason||'');
      man.accountFlags.bannedText = String(snippet||'').slice(0, 400);
      return man;
    });
    if (!already) {
      await issues.append(
        nome,
        'account_banned_detected',
        `reason=${reason||''} snippet="${(snippet||'').slice(0,120)}" at=${new Date().toISOString()}`
      );
    }
    robeMeta[nome] = robeMeta[nome] || {};
    robeMeta[nome].banned = true;
  } catch {}
}

async function clearAccountFlags(nome, which = ['loginRequired','banned']) {
  try {
    const prev = await readAccountFlags(nome);
    await manifestStore.update(nome, (man) => {
      man = man || {};
      man.accountFlags = man.accountFlags || {};
      if (which.includes('loginRequired')) {
        if (man.accountFlags.loginRequired || man.accountFlags.loginReason || man.accountFlags.loginSource) {
          delete man.accountFlags.loginRequired;
          delete man.accountFlags.loginReason;
          delete man.accountFlags.loginSource;
          delete man.accountFlags.lastLoginRequiredAt;
        }
      }
      if (which.includes('banned')) {
        if (man.accountFlags.banned || man.accountFlags.bannedAt || man.accountFlags.bannedReason || man.accountFlags.bannedText) {
          delete man.accountFlags.banned;
          delete man.accountFlags.bannedAt;
          delete man.accountFlags.bannedReason;
          delete man.accountFlags.bannedText;
        }
      }
      if (Object.keys(man.accountFlags).length === 0) delete man.accountFlags;
      return man;
    });
    if (which.includes('loginRequired') && (prev && prev.loginRequired)) {
      await issues.append(nome, 'login_required_cleared', `at=${new Date().toISOString()}`);
    }
    if (which.includes('banned') && (prev && prev.banned)) {
      await issues.append(nome, 'account_banned_cleared', `at=${new Date().toISOString()}`);
    }
    robeMeta[nome] = robeMeta[nome] || {};
    if (which.includes('loginRequired')) {
      delete robeMeta[nome].loginRequired;
      delete robeMeta[nome].loginReason;
    }
    if (which.includes('banned')) delete robeMeta[nome].banned;
    await snapshotStatusAndWrite();
  } catch {}
}

const SHARD_PROFILES = (() => { try { return JSON.parse(process.env.SHARD_PROFILES || '[]'); } catch { return []; }})();
let SHARD_SET = new Set(Array.isArray(SHARD_PROFILES) ? SHARD_PROFILES : []);
const STATUS_FILE_NAME = process.env.STATUS_FILE_NAME || 'status.json';

function inShard(nome) { return SHARD_SET.size === 0 ? true : SHARD_SET.has(nome); }

async function isLimitPostingActive(nome) {
  try {
    const man = await manifestStore.read(nome).catch(()=>null);
    return !!(man && man.robePauseReason === 'limit_posting' && (man.robeCooldownUntil || 0) > Date.now());
  } catch { return false; }
}

function isLimitPostingRes(res) {
  return !!(res && (res.limitPosting === true || res.error === 'limit_posting' || res.HALT === true));
}

async function detectFbLimitInAnyPage(ctrl) {
  try {
    if (!ctrl || !ctrl.browser || typeof ctrl.browser.pages !== 'function') return false;
    const pages = await ctrl.browser.pages();
    for (const p of pages) {
      try {
        const url = p.url ? p.url() : '';
        if (/facebook\.com\/marketplace\/(create|you\/selling|sell|listing|inventory|commerce_manager)/i.test(url)) {
          const deep = await detectLimitOverlayDeep(p, { alsoCheckFrames: true });
          if (deep && deep.blocked) return true;
          const det = await require('./browser.js').detectMessengerTempBlock(p);
          if (det && det.blocked && det.domain === 'facebook') return true;
        }
      } catch {}
    }
  } catch {}
  return false;
}

// REMOVIDO: pidusage e ps-list usam WMI/PowerShell internamente no Windows
// Placeholders explícitos para garantir que nunca haverá uso em runtime
const pidusage = null;
const psList = null;

const { execFile } = require('child_process');

const supervisorClient = require('./supervisorClient.js');
const { getAvailableMB } = utils;

const HEALTH_CFG = {
  TICK_MS: 10000,
  DEAD_NO_EVENT_MS: 45000,
  DEAD_NO_DOM_MS: 45000,
  DEAD_NO_NET_MS: 60000,
  RECOVERY_COOLDOWN_MS: {
    reload: 30000,
    navHome: 45000,
    newPage: 60000
  },
  SUCCESS_RESET_MS: 20000,
  MAX_SOFT_RELOADS_10MIN: 2,
  MAX_NAVHOME_10MIN: 2,
  MAX_NEWPAGE_30MIN: 2,
  ESCALATE_TO_REOPEN_AFTER: 2,
  ABOUT_BLANK_GRACE_MS: 7000
};

const PHANTOM_CFG = {
  INITIAL_GRACE_MS: 9000,
  PERSIST_MS: 20000,
  CHECK_INTERVAL_MS: 5000,
  COOLDOWN_BETWEEN_TRIES_MS: 30000,
  MAX_PHTM_RELOADS_10M: 2,
  MAX_PHTM_NAV_10M: 2,
  MAX_PHTM_NEWPAGE_30M: 2,
  ESCALATE_AFTER_STEPS: 2
};
function _prune(arr, ms) {
  const now = Date.now();
  return (arr||[]).filter(ts => (now - ts) < ms);
}
function getPhantomState(nome) {
  robeMeta[nome] = robeMeta[nome] || {};
  robeMeta[nome].phantom = robeMeta[nome].phantom || {
    firstSeenAt: 0,
    lastOkAt: 0,
    lastActionAt: 0,
    actions10m: [],
    navs10m: [],
    reloads10m: [],
    newpages30m: [],
    failures: 0
  };
  return robeMeta[nome].phantom;
}
async function evaluateChatsState(page) {
  try {
    const res = await page.evaluate(() => {
      const norm = (s) => (s||'').toLowerCase();
      let grid = Array.from(document.querySelectorAll('div[role="grid"]'))
      .find(g => {
        const al = (g.getAttribute('aria-label') || g.getAttribute('aria-labelledby') || '');
        const t = norm(al);
        return t.includes('conversas') || t.includes('conversations');
      });
      if (!grid) {
        const pagelet = document.querySelector('div[data-pagelet="MWThreadList"]');
        if (pagelet) {
          const g2 = pagelet.querySelector('div[role="grid"]');
          if (g2) grid = g2;
        }
      }
      let rows = 0, anchors = 0, skeletons = 0;
      if (grid) {
        rows = grid.querySelectorAll('div[role="row"]').length;
        anchors = grid.querySelectorAll('a[href^="/marketplace/t/"]').length;
        skeletons = grid.querySelectorAll('div[role="status"][data-visualcompletion="loading-state"]').length;
      } else {
        skeletons = document.querySelectorAll('div[role="status"][data-visualcompletion="loading-state"]').length;
      }
      return { hasGrid: !!grid, rows, anchors, skeletons };
    });
    return res || { hasGrid:false, rows:0, anchors:0, skeletons:0 };
  } catch {
    return { hasGrid:false, rows:0, anchors:0, skeletons:0 };
  }
}
function isPhantomFromSnapshot(snap) {
  const noThreads = (snap.rows === 0 && snap.anchors === 0);
  if (noThreads && snap.skeletons > 0) return true;
  return false;
}
function isOkFromSnapshot(snap) {
  return (snap.rows > 0 || snap.anchors > 0);
}
async function tryFixPhantom(nome, page) {
  const ctrlGuard = controllers.get(nome);
  if (ctrlGuard && (ctrlGuard.humanControl === true || ctrlGuard.configurando === true)) return false;
  const ph = getPhantomState(nome);
  const now = Date.now();
  ph.actions10m = _prune(ph.actions10m, 10601000);
  ph.navs10m = _prune(ph.navs10m, 10601000);
  ph.reloads10m = _prune(ph.reloads10m, 10601000);
  ph.newpages30m = _prune(ph.newpages30m, 30601000);

  if ((now - ph.lastActionAt) < PHANTOM_CFG.COOLDOWN_BETWEEN_TRIES_MS) return false;

  const ctrl = controllers.get(nome);
  if (!ctrl || !ctrl.browser || ctrl.configurando) return false;
  if (robeMeta[nome] && robeMeta[nome].emExecucao) return false;

  if (ph.navs10m.length < PHANTOM_CFG.MAX_PHTM_NAV_10M) {
    try {
      await page.goto('https://www.messenger.com/marketplace', { waitUntil: 'domcontentloaded', timeout: 30000 });
      ph.navs10m.push(now);
      ph.actions10m.push(now);
      ph.lastActionAt = now;
      await issues.append(nome, 'mil_action', 'phantom_fix:navHome');
      return true;
    } catch {}
  }
  if (ph.reloads10m.length < PHANTOM_CFG.MAX_PHTM_RELOADS_10M) {
    try {
      await page.reload({ waitUntil: 'domcontentloaded', timeout: 15000 });
      ph.reloads10m.push(now);
      ph.actions10m.push(now);
      ph.lastActionAt = now;
      await issues.append(nome, 'mil_action', 'phantom_fix:reload');
      return true;
    } catch {}
  }
  if (ph.newpages30m.length < PHANTOM_CFG.MAX_PHTM_NEWPAGE_30M) {
    try {
      const ctrl2 = controllers.get(nome);
      const np = await ctrl2.browser.newPage();
      try {
        const man = await manifestStore.read(nome).catch(()=>null);
        await browserHelper.patchPage(nome, np, utils.getCoords(man && man.cidade || ''));
      } catch {}
      await np.goto('https://www.messenger.com/marketplace', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(()=>{});
      try { await ctrl2.mainPage.close({ runBeforeUnload: false }).catch(()=>{}); } catch {}
      ctrl2.mainPage = np;
      await wirePageObservers(nome, np);
      ph.newpages30m.push(now);
      ph.actions10m.push(now);
      ph.lastActionAt = now;
      await issues.append(nome, 'mil_action', 'phantom_fix:newPage');
      return true;
    } catch {}
  }
  ph.failures = (ph.failures || 0) + 1;
  await issues.append(nome, 'mil_action', `phantom_escalate:reopen failures=${ph.failures}`);
  if (killGuardActive(nome)) {
    await issues.append(nome, 'guard_skip', 'Ação suprimida por kill_guard_until');
    return true;
  }
  await handlers.deactivate({ nome, reason: 'phantom_reopen', policy: 'preserveDesired' });
  setKillGuard(nome);
  ph.lastActionAt = now;
  return true;
}

const healthState = new Map();
function getHealth(nome) {
  const now = Date.now();
  if (!healthState.has(nome)) {
    healthState.set(nome, {
      lastOkAt: 0, lastDomEventAt: 0, lastNetEventAt: 0, lastConsoleErrorAt: 0,
      lastUrl: '', lastTitle: '', stage: 'ok', nextTryAt: 0,
      counters: { softReloads10m: [], navHomes10m: [], newPages30m: [], cyclesWithoutLife: 0 },
      newPageInFlight: false,
      lastNewPageAt: 0
    });
  }
  return healthState.get(nome);
}
function _pruneWindow(arr, ms) {
  const now = Date.now();
  return arr.filter(ts => (now - ts) < ms);
}

const os = require('os');
const AUTO_CFG = {
  MEM_ENTER_MB: 2048,
  MEM_EXIT_MB: 3072,
  CPU_ENTER: 85,
  CPU_EXIT: 70,
  EMA_ALPHA_CPU: 0.30,
  EMA_ALPHA_MEM: 0.20,
  HOT_TICKS: 3,
  COOL_TICKS: 3,
  MIN_HOLD_MS: 45000,
  ROBE_LIGHT_MIN_SPACING_MS: 60000,
  RAM_KILL_MB: 1600,
  RAM_WARN_MB: 700
};

// NOVO: RAM mínima dinâmica - 2GB base + 500MB por node ativo (garante que robes possam trabalhar simultaneamente)
function getOpenMinFreeMB() {
  const baseMB = 2048; // 2GB base
  const activeNodes = robeQueue.activeCount(); // 0 ou 1 atualmente (pode aumentar no futuro)
  const perNodeMB = 500; // 500MB por node ativo
  return baseMB + (activeNodes * perNodeMB);
}
const OPEN_MIN_FREE_MB_STATIC = parseInt(process.env.OPEN_MIN_FREE_MB || '2048', 10); // Mantido para compatibilidade
const HEADROOM_AFTER_OPEN_MB = parseInt(process.env.HEADROOM_AFTER_OPEN_MB || '0', 10);
const TARGET_ALIVE = parseInt(process.env.TARGET_ALIVE || '0', 10);

const autoMode = {
  mode: 'full', since: Date.now(), reason: 'supervisor_controlled',
  cpuEma: null, freeEmaMB: null, hot: 0, cool: 0, lastEval: 0,
  light: { activationHeld: 0, robeSkipped: 0, nextRobeEnqueueAt: 0 }
};

function _ema(prev, value, alpha) { return prev == null ? value : (alpha*value + (1-alpha)*prev); }
function _canSwitch() { return (Date.now() - autoMode.since) >= AUTO_CFG.MIN_HOLD_MS; }

let _statusLock = Promise.resolve();

async function milLog(type, msg) {
  try { await reportAction('system', type || 'mil_action', String(msg || '')); } catch {}
}

let opening = {};

async function killPids(pids = []) {
  for (const pid of (pids || [])) {
    try { process.kill(pid, 'SIGKILL'); } catch {}
  }
}

async function killProcessTreeByRootPid(pid) {
  if (!pid) return;
  try {
    if (process.platform === 'win32') {
      const { execFile } = require('child_process');
      // Versão sem WMI: usa taskkill para matar o processo raiz e toda a árvore.
      await new Promise((res) => {
        execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' }, () => res());
      });
    } else {
      return;
    }
  } catch {}
}

async function killStrayChromes() {
  // Intencionalmente no-op: 110% sem WMI/PowerShell e sem ps-list
      return;
}

try {
  logger.info('[WORKER][BOOT]', {
    pid: process.pid,
    execPath: process.execPath,
    versions: process.versions,
    npm_node_execpath: process.env.npm_node_execpath || '',
    ELECTRON_RUN_AS_NODE: process.env.ELECTRON_RUN_AS_NODE || '',
    platform: process.platform,
    arch: process.arch,
    cwd: process.cwd()
  });
} catch (e) {
  try { logger.warn('[WORKER][BOOT] log error', { error: e && e.message || e }); } catch {}
}
try {
  logger.info(`[WORKER][BOOT][SHARD] pid=${process.pid} shardSize=${SHARD_SET.size}`);
} catch {}

setImmediate(() => { try { snapshotStatusAndWrite().catch(()=>{}); } catch {} });

const perfisPath = path.join(__dirname, '../dados', 'perfis.json');
const presetsPath = path.join(__dirname, '../dados', 'ua_presets.json');
const perfisDir = path.join(__dirname, '../dados', 'perfis');

const desiredPath = path.join(__dirname, '../dados', 'desired.json');
const statusPath  = path.join(__dirname, '../dados', STATUS_FILE_NAME);

function readJsonFile(file, fallback) {
try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}
function writeJsonAtomic(file, obj) {
try {
const dir = path.dirname(file);
if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
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
} catch {
return false;
}
}
function ensureDesired() {
try {
if (!fs.existsSync(desiredPath)) writeJsonAtomic(desiredPath, { perfis: {} });
} catch {}
}

function manifestPathOf(nome) {
  const perfisArr = JSON.parse(fs.readFileSync(perfisPath, 'utf8'));
  const perfil = perfisArr.find(p => p && p.nome === nome);
  if (!perfil || !perfil.userDataDir) throw new Error('userDataDir do perfil não encontrado: ' + nome);
  return path.join(perfil.userDataDir, 'manifest.json');
}

async function freezeCooldownIfNotWorking(nome) {
  try {
    const ctrl = controllers.get(nome);
    const working = !!(ctrl && ctrl.browser && ctrl.trabalhando && !ctrl.configurando);
    const humanControl = !!(ctrl && ctrl.humanControl);
    if (working && !humanControl) return;
    await manifestStore.update(nome, (m) => {
      m = m || {};
      const now = Date.now();
      if (m.robeCooldownUntil && m.robeCooldownUntil > now) {
        m.robeCooldownRemainingMs = m.robeCooldownUntil - now;
        m.robeCooldownUntil = 0;
      }
      return m;
    });
  } catch {}
}

async function unfreezeCooldownIfWorking(nome) {
  try {
    const ctrl = controllers.get(nome);
    const working = !!(ctrl && ctrl.browser && ctrl.trabalhando && !ctrl.configurando);
    const humanControl = !!(ctrl && ctrl.humanControl);
    if (!working || humanControl) return;
    await manifestStore.update(nome, (m) => {
      m = m || {};
      const now = Date.now();
      if ((m.robeCooldownUntil || 0) <= now) {
        const remaining = Number(m.robeCooldownRemainingMs || 0);
        if (remaining > 0) {
          m.robeCooldownUntil = now + remaining;
          m.robeCooldownRemainingMs = 0;
        }
      }
      return m;
    });
  } catch {}
}

const ERROR_TYPES = new Set(['robe_error', 'robe_no_photo', 'virtus_blocked', 'virtus_no_composer', 'virtus_send_failed']);

function countErrorsLocal(nome) {
  try {
    const file = path.join(perfisDir, nome, 'issues.json');
    const arr = readJsonFile(file, []);
    if (!Array.isArray(arr)) return 0;
    let n = 0;
    for (const it of arr) {
      const t = (it && it.type) ? String(it.type) : '';
      if (ERROR_TYPES.has(t)) n++;
    }
    return n;
  } catch { return 0; }
}

async function ensureManifestValid(nome) {
  function hasEssentials(man) {
    return man &&
      typeof man.nome === 'string' && man.nome &&
      typeof man.cidade === 'string' && man.cidade &&
      typeof man.uaPresetId !== 'undefined' &&
      typeof man.uaString === 'string' && man.uaString &&
      typeof man.uaCh === 'object' && man.uaCh &&
      typeof man.fp === 'object' && man.fp &&
      Array.isArray(man.cookies) && man.cookies.length &&
      typeof man.userDataDir === 'string' && man.userDataDir;
  }
  let manifest = await manifestStore.read(nome).catch(()=>null);
  if (manifest && hasEssentials(manifest)) return manifest;
  try {
    const perfisArr = loadPerfisJson();
    const perfil = perfisArr.find(p => p && p.nome === nome);
    if (perfil && hasEssentials(perfil)) {
      const merged = Object.assign({}, perfil, manifest || {});
      if (merged.userDataDir && !fs.existsSync(merged.userDataDir)) {
        fs.mkdirSync(merged.userDataDir, { recursive: true });
      }
      await manifestStore.update(nome, () => merged);
      return merged;
    }
  } catch {}
  return null;
}

async function computeManifestStatus(nome) {
  try {
    const man = await manifestStore.read(nome);
    if (!man) return 'unknown';
    const ok = man &&
      typeof man.nome === 'string' && man.nome &&
      typeof man.cidade === 'string' && man.cidade &&
      typeof man.uaPresetId !== 'undefined' &&
      typeof man.uaString === 'string' && man.uaString &&
      typeof man.uaCh === 'object' && man.uaCh &&
      typeof man.fp === 'object' && man.fp &&
      Array.isArray(man.cookies) && man.cookies.length &&
      typeof man.userDataDir === 'string' && man.userDataDir;
    return ok ? 'ok' : 'incomplete';
  } catch { return 'unknown'; }
}

async function reportAction(nome, type, message) {
try {
if (!nome) return;
if (!issues || typeof issues.append !== 'function') return;
const msg = String(message == null ? '' : message).slice(0, 400);
await issues.append(nome, type, msg);
} catch {}
}

const controllers = new Map();
// Atualiza global.controllers para uso pela fila de busca de localização
global.controllers = controllers;

const robeMeta = {};

function memorySweep() {
  try {
    const nomesValidos = new Set(loadPerfisJson().map(p => p.nome));
    for (const [n] of healthState) if (!nomesValidos.has(n) && !controllers.has(n)) healthState.delete(n);
    for (const [n] of profileFailures) if (!nomesValidos.has(n) && !controllers.has(n)) profileFailures.delete(n);
    for (const n of Object.keys(robeMeta)) {
      if (!nomesValidos.has(n) && !controllers.has(n)) delete robeMeta[n];
    }
  } catch {}
}
setInterval(memorySweep, 10 * 60 * 1000);

function killGuardActive(nome) {
  return robeMeta[nome]?.killGuardUntil && robeMeta[nome].killGuardUntil > Date.now();
}
function setKillGuard(nome, ms=90000) {
  robeMeta[nome] = robeMeta[nome] || {};
  robeMeta[nome].killGuardUntil = Date.now() + ms;
}

try {
  const perfisArr = loadPerfisJson();
  for (const p of perfisArr) {
    if (p && p.nome && p.userDataDir) {
      const manifestPath = path.join(p.userDataDir, 'manifest.json');
      if (fs.existsSync(manifestPath)) {
        const man = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
        if (man.frozenUntil && man.frozenUntil > Date.now()) {
          robeMeta[p.nome] = robeMeta[p.nome] || {};
          robeMeta[p.nome].frozenUntil = man.frozenUntil;
          if (man.frozenReason) robeMeta[p.nome].frozenReason = man.frozenReason;
          if (man.frozenAt) robeMeta[p.nome].frozenAt = man.frozenAt;
          if (man.frozenSetBy) robeMeta[p.nome].frozenSetBy = man.frozenSetBy;
        }
      }
    }
  }
} catch (err) {
  try { logger.warn('[BOOT] Erro ao repopular frozenUntil dos manifests', { error: err && err.message || err }); } catch {}
}

const _issuesAppendOrig = issues && issues.append ? issues.append.bind(issues) : null;
if (_issuesAppendOrig) {
  issues.append = async function(nome, type, msg) {
    try {
      const now = Date.now();
      let url = '', readyState = '', pagesCount = 0;
      let deltaDom = '', deltaNet = '';
      let healthStage = '';
      let killGuardUntil = robeMeta[nome]?.killGuardUntil || 0;
      let recoveryHysteresisUntil = robeMeta[nome]?.recoveryHysteresisUntil || 0;
      let blockHysteresisUntil = robeMeta[nome]?.blockHysteresisUntil || 0;
      let strikes = 0;

      const ctrl = controllers.get(nome);
      let page = null;
      if (ctrl && ctrl.browser) {
        try {
          const pages = await ctrl.browser.pages().catch(()=>[]);
          pagesCount = Array.isArray(pages) ? pages.length : 0;
          if (pages && pages[0]) page = pages[0];
        } catch {}
      }
      if (page) {
        try { url = typeof page.url === 'function' ? (page.url() || '') : ''; } catch {}
        try {
          readyState = await Promise.race([
            (async () => await page.evaluate(() => document.readyState).catch(()=>''))(),
            new Promise(res => setTimeout(()=>res(''), 300))
          ]);
        } catch {}
      }
      const st = getHealth && getHealth(nome);
      if (st) {
        healthStage = st.stage || '';
        if (st.lastDomEventAt) deltaDom = String(now - st.lastDomEventAt);
        if (st.lastNetEventAt) deltaNet = String(now - st.lastNetEventAt);
      }
      const rm = robeMeta[nome] || {};
      strikes = rm.noPagesStrikes || rm.zombieStrikes || (Array.isArray(rm.blockDetectWindow) ? rm.blockDetectWindow.length : 0) || 0;

      const extra = ` url=${url||''} readyState=${readyState||''} deltaDom=${deltaDom} deltaNet=${deltaNet} pagesCount=${pagesCount} strikes=${strikes} killGuardUntil=${killGuardUntil||0} recoveryHysteresisUntil=${recoveryHysteresisUntil||0} blockHysteresisUntil=${blockHysteresisUntil||0} healthStage=${healthStage||''}`;
      const newMsg = (msg == null ? '' : String(msg)) + extra;
      return await _issuesAppendOrig(nome, type, newMsg);
    } catch (e) {
      try { return await _issuesAppendOrig(nome, type, msg); } catch {}
    }
  };
}

function isFrozenNow(nome) {
  const now = Date.now();
  const inMem = (robeMeta[nome] && robeMeta[nome].frozenUntil) || 0;
  let inDisk = 0;
  try {
    const mPath = manifestPathOf(nome);
    if (fs.existsSync(mPath)) {
      const man = JSON.parse(fs.readFileSync(mPath, 'utf8'));
      if (man && typeof man.frozenUntil === 'number') inDisk = man.frozenUntil;
    }
  } catch {}
  const until = Math.max(inMem, inDisk || 0);
  return until > now ? until : 0;
}

const activationLocks = new Map();

async function activateOnce(nome, source = '') {
  if (opening[nome]) return { ok: false, error: 'already_opening' };

  if (controllers.has(nome)) {
    return { ok: true, already: true };
  }

  const inflight = activationLocks.get(nome);
  if (inflight) {
    try { await inflight.catch(() => {}); } catch {}
    return controllers.has(nome)
      ? { ok: true, already: true }
      : { ok: false, error: 'activation_in_progress' };
  }

  opening[nome] = true;
  let _supervisorSlotGranted = false;
  try {
    if (SHARD_SET.size && !inShard(nome)) {
      await reportAction(nome, 'mil_action', 'activate_skip_wrong_shard');
      logger.info(`[WORKER][ACTIVATE][SHARD_CHECK] nome=${nome} has=false size=${SHARD_SET.size}`);
      return { ok: false, error: 'wrong_shard' };
    }
    logger.info(`[WORKER][ACTIVATE][SHARD_CHECK] nome=${nome} has=${inShard(nome)} size=${SHARD_SET.size}`);

    if (killGuardActive(nome)) {
      await reportAction(nome, 'guard_skip_open', 'Abertura negada por kill_guard_until');
      return { ok:false, error:"kill_guard_until" };
    }

    try {
      const desired = readJsonFile(desiredPath, { perfis: {} });
      if (desired && desired.perfis && desired.perfis[nome] && desired.perfis[nome].humanHold === true) {
        await reportAction(nome, 'mil_action', 'activate_skip_human_hold');
        return { ok: false, error: 'human_hold' };
      }
    } catch {}

    const slotResp = await supervisorClient.requestOpen(nome).catch(()=>({ok:false, error:'supervisor_unreachable'}));
    if (!slotResp || !slotResp.ok) {
      robeMeta[nome] = robeMeta[nome] || {};
      // NOVO: Reduzido de 30s para 5s (supervisor já controla velocidade via cooldowns)
      robeMeta[nome].activationHeldUntil = Date.now() + 5000;
      await reportAction(nome, 'mil_action', `activation_hold_by_supervisor reason=${(slotResp && slotResp.reason) || 'unknown'}`);
      return { ok:false, error: `supervisor_denied:${(slotResp && slotResp.reason) || 'unknown'}` };
    }
    _supervisorSlotGranted = true;

    if (!nome) {
      if (_supervisorSlotGranted) { try { await supervisorClient.notifyOpened(nome, 'err'); } catch {} }
      return { ok: false, error: 'Nome ausente' };
    }

    if (isFrozenNow(nome)) {
      await reportAction(nome, 'mil_action', 'block_activate_frozen');
      if (_supervisorSlotGranted) { try { await supervisorClient.notifyOpened(nome, 'err'); } catch {} }
      return { ok: false, error: 'account_is_frozen' };
    }

    const job = (async () => {
      logger.info('[WORKER][activateOnce] start', { nome, source });
      try {
        logger.info('[WORKER][activateOnce] start nome=' + nome + ' source=' + source);
        const manifest = await ensureManifestValid(nome);
        if (!manifest) {
          await freezeProfileFor(nome, 12*60*60*1000, 'manifest_incomplete', 'system');
          await reportAction(nome, 'robe_error', 'manifest incompleto na ativação; perfil congelado 12h');
          if (_supervisorSlotGranted) { try { await supervisorClient.notifyOpened(nome, 'err'); } catch {} }
          return { ok:false, error: 'manifest_incomplete' };
        }

        {
          const freeMB = getAvailableMB();
          const minFreeMB = getOpenMinFreeMB(); // NOVO: RAM mínima dinâmica
          if (freeMB <= minFreeMB) {
            await reportAction(nome, 'mem_block_activate', `RAM livre=${freeMB}MB <= ${minFreeMB}MB (gate, activeNodes=${robeQueue.activeCount()})`);
            throw new Error('ram_insuficiente_para_ativar');
          }
        }

        const browser = await browserHelper.openBrowser(manifest);
        if (!browser || typeof browser.newPage !== 'function') {
          throw new Error('Objeto browser não retornado corretamente (Puppeteer falhou ao acoplar).');
        }

        // PÓS-ACTIVATE: CHECK DE HEADROOM (RAM) IMEDIATAMENTE DEPOIS DE ABRIR PERFIL
        if (HEADROOM_AFTER_OPEN_MB > 0) {
          const freeMB = getAvailableMB();
          if (freeMB < HEADROOM_AFTER_OPEN_MB) {
            try { browser && browser.close && await browser.close(); } catch {}
            robeMeta[nome] = robeMeta[nome] || {};
            robeMeta[nome].activationHeldUntil = Date.now() + 5000;
            setKillGuard(nome, 30000);
            await reportAction(nome, 'open_rollback_memory', `Memória livre após abrir perfil caiu abaixo do headroom (${freeMB}MB < ${HEADROOM_AFTER_OPEN_MB}MB)`);
            logger.warn(`[OPEN] rollback por swap/headroom`, { nome, freeMB, limit:HEADROOM_AFTER_OPEN_MB });
            if (_supervisorSlotGranted) { try { await supervisorClient.notifyOpened(nome, 'err'); } catch {} }
            return { ok:false, error:'headroom_below_min_after_open', freeMB, limit:HEADROOM_AFTER_OPEN_MB };
          }
        }

        const proc = browser.process && browser.process();
        if (proc && proc.pid && Number.isFinite(proc.pid)) {
          robeMeta[nome] = robeMeta[nome] || {};
          robeMeta[nome].rootPid = proc.pid;
          logger.info('[WORKER][activateOnce] rootPid setado', { nome, rootPid: proc.pid });
        } else {
          logger.warn('[WORKER][activateOnce] rootPid NÃO setado', {
            nome,
            hasProcessFn: !!(browser.process),
            proc: !!proc,
            pid: proc?.pid
          });
          setTimeout(async () => {
            try {
              const proc2 = browser.process && browser.process();
              if (proc2 && proc2.pid) {
                robeMeta[nome] = robeMeta[nome] || {};
                robeMeta[nome].rootPid = proc2.pid;
                logger.info('[WORKER][activateOnce] rootPid recapturado (delayed)', { nome, rootPid: proc2.pid });
              }
            } catch {}
          }, 2000);
        }
        controllers.set(nome, { browser, virtus: null, robe: null, status: { active: true }, configurando: false, trabalhando: false });

        // [NAV_INIT] garantir UI do Marketplace após abrir o browser (sem usar o chat ativo!)
        try {
          const pages = await browser.pages().catch(()=>[]);
          const main = pages && pages[0];
          if (main) {
            await browserHelper.gotoMessengerMarketplace(main, nome);
          }
        } catch (e) {
          logger.warn('[NAV_INIT] falha ao preparar marketplace', { nome, error: (e && e.message)||String(e) });
        }

        robeMeta[nome] = robeMeta[nome] || {};
        robeMeta[nome].activatedAt = Date.now();
        robeMeta[nome].ramHist = [];
        robeMeta[nome].cpuHistory = [];
        robeMeta[nome].lastWarn = null;

        try { healer.lastProgressAt = Date.now(); } catch {}

        try { attachBrowserLifecycle(nome, browser); } catch {}
        try {
          const ctrl = controllers.get(nome);
          if (ctrl) {
            const pages = await browser.pages().catch(()=>[]);
            if (pages && pages[0]) {
              ctrl.mainPage = pages[0];
              try { await wirePageObservers(nome, ctrl.mainPage); } catch {}
            }
            maybeStartPruneLoop(nome, ctrl.browser, ctrl.mainPage);
            try {
              browserHelper.installOneTabGuard(ctrl.browser, nome, {
                allow: () => {
                  const c = controllers.get(nome);
                  const rm = robeMeta[nome] || {};
                  return !!(c && (c.configurando === true || c.humanControl === true || rm.emExecucao === true));
                },
                maxPagesWhenAllow: () => {
                  const c = controllers.get(nome);
                  const rm = robeMeta[nome] || {};
                  if (c && c.humanControl === true) return Number.MAX_SAFE_INTEGER;
                  return rm.emExecucao === true ? 3 : 10;
                },
                onNumPages: (n) => {
                  robeMeta[nome] = robeMeta[nome] || {};
                  robeMeta[nome].numPages = n;
                  snapshotStatusAndWrite().catch(()=>{});
                }
              });
            } catch {}
            try {
              browserHelper.installAboutBlankKiller(ctrl.browser, nome, { graceMs: 7000 });
            } catch {}
          }
        } catch {}
        try { await snapshotStatusAndWrite(); } catch {}
        robeMeta[nome] = robeMeta[nome] || {};
        robeMeta[nome].closingReason = null;
        logger.info('[WORKER][activateOnce] done nome=' + nome + ' source=' + source);
        logger.info('[WORKER][activateOnce] concluído', { nome, source });
        if (_supervisorSlotGranted) { try { await supervisorClient.notifyOpened(nome, 'ok'); } catch {} }

        return { ok: true };
      } catch (e) {
        try {
          const st = readJsonFile(statusPath, null) || { perfis: [] };
          let found = false;
          if (Array.isArray(st.perfis)) {
            st.perfis = st.perfis.map(p => {
              if (p && p.nome === nome) { found = true; return { ...p, active: false }; }
              return p;
            });
          }
          if (!found) st.perfis.push({ nome, active: false });
          _statusLock = _statusLock.then(async () => {
            const ok = writeJsonAtomic(statusPath, st);
            if (!ok) { try { await issues.append('system','persist_failed', `${nome}|activateOnce_fail_status`); } catch {} }
          });
        } catch {}
        try { await reportAction(nome, 'activate_failed', 'Falha ao abrir navegador: ' + (e && e.message)); } catch {}
        if (e && /ram_insuficiente_para_ativar|headroom_below_min_after_open/.test(String(e && e.message || e))) {
          robeMeta[nome] = robeMeta[nome] || {};
          // NOVO: Reduzido de 15s para 5s (supervisor já controla velocidade)
          robeMeta[nome].activationHeldUntil = Date.now() + 5000;
          try { await reportAction(nome, 'mil_action', 'activation_hold_due_ram 5s (activateOnce)'); } catch {}
        }
        logger.error('[WORKER][activateOnce] fail', { nome, source, err: e && e.message || e }, e);
        if (_supervisorSlotGranted) { try { await supervisorClient.notifyOpened(nome, 'err'); } catch {} }
        return { ok: false, error: e && e.message || String(e) };
      } finally {
        activationLocks.delete(nome);
      }
    })();

    activationLocks.set(nome, job);
    return await job;
  } finally {
    delete opening[nome];
  }
}

function sendReply(msgId, data) {
  if (process && process.send) {
    process.send({ replyTo: msgId, data });
  }
}

function loadPerfisJson() {
  try {
    const arr = JSON.parse(fs.readFileSync(perfisPath, 'utf8'));
    if (!SHARD_SET.size) return arr;
    return arr.filter(p => p && p.nome && inShard(p.nome));
  } catch { return []; }
}
function savePerfisJson(arr) {
  try { fs.writeFileSync(perfisPath, JSON.stringify(arr, null, 2)); } catch {}
}

function pickUaPreset() {
  const presets = JSON.parse(fs.readFileSync(presetsPath, 'utf8'));
  const perfis = loadPerfisJson();
  const count = {};
  for (const p of presets) count[p.id] = 0;
  for (const pf of perfis) {
    if (pf.uaPresetId) count[pf.uaPresetId] = (count[pf.uaPresetId] || 0) + 1;
  }
  let min = Math.min(...Object.values(count));
  const candidates = presets.filter(p => count[p.id] === min);
  candidates.sort(() => Math.random() - 0.5);
  return candidates[0];
}

async function normalizeCooldown(nome) {
  try {
    const now = Date.now();
    const ctrl = controllers.get(nome);
    const man = await manifestStore.read(nome).catch(()=>null);
    try {
      robeMeta[nome] = robeMeta[nome] || {};
      robeMeta[nome].pauseReason = man.robePauseReason || null;
    } catch {}
    if (!man) return 0;
    const until = Number(man.robeCooldownUntil || 0);
    const remaining = Number(man.robeCooldownRemainingMs || 0);
    const leftUntil = until > now ? (until - now) : 0;
    const leftRem = remaining > 0 ? remaining : 0;

    if (leftUntil > 0 && leftRem > 0 && Math.abs(leftUntil - leftRem) > 60*1000) {
      const winner = Math.max(leftUntil, leftRem);
      if (ctrl && ctrl.trabalhando && !ctrl.humanControl) {
        await manifestStore.update(nome, m => {
          m = m || {};
          m.robeCooldownUntil = now + winner;
          m.robeCooldownRemainingMs = 0;
          return m;
        });
        await issues.append(nome, 'mil_action', `cooldown_reconciled: using until=${winner}ms (from both)`);
        return Math.floor(winner/1000);
      } else {
        await manifestStore.update(nome, m => {
          m = m || {};
          m.robeCooldownUntil = 0;
          m.robeCooldownRemainingMs = winner;
          return m;
        });
        await issues.append(nome, 'mil_action', `cooldown_reconciled: using remaining=${winner}ms (from both)`);
        return Math.floor(winner/1000);
      }
    }
    const finalMs = leftUntil > 0 ? leftUntil : leftRem;
    try {
      if (finalMs === 0) {
        await releaseLimitPostingIfExpired(nome);
      }
    } catch {}
    return Math.max(0, Math.floor(finalMs/1000));
  } catch { return 0; }
}

async function releaseLimitPostingIfExpired(nome) {
  try {
    const man = await manifestStore.read(nome).catch(()=>null);
    if (!man) return false;
    const now = Date.now();
    const hasLimitPosting = (man.robePauseReason === 'limit_posting');
    const stillOn = (Number(man.robeCooldownUntil||0) > now) || (Number(man.robeCooldownRemainingMs||0) > 0);
    if (hasLimitPosting && !stillOn) {
      await manifestStore.update(nome, m => {
        m = m || {};
        if (m.robePauseReason === 'limit_posting') delete m.robePauseReason;
        return m;
      });
      robeMeta[nome] = robeMeta[nome] || {};
      delete robeMeta[nome].pauseReason;
      try { await issues.append(nome, 'mil_action', 'limit_posting_release'); } catch {}
      return true;
    }
  } catch {}
  return false;
}

function robeCooldownLeft(nome) {
  let left = 0;
  try {
    const ctrl = controllers.get(nome);
    const working = !!(ctrl && ctrl.browser && ctrl.trabalhando && !ctrl.configurando);
    const humanControl = !!(ctrl && ctrl.humanControl);
    const mPath = manifestPathOf(nome);
    if (fs.existsSync(mPath)) {
      const p = JSON.parse(fs.readFileSync(mPath, 'utf8'));
      const now = Date.now();
      if (working && !humanControl) {
        const until = Number(p.robeCooldownUntil || 0);
        if (until > now) {
          left = Math.floor((until - now) / 1000);
        }
      } else {
        const remaining = Number(p.robeCooldownRemainingMs || 0);
        if (remaining > 0) {
          left = Math.floor(remaining > 0 ? remaining / 1000 : 0);
        } else {
          const until = Number(p.robeCooldownUntil || 0);
          if (until > now) {
            left = Math.floor((until - now) / 1000);
          }
        }
      }
      if (left < 0) left = 0;
    }
  } catch {}
  return left;
}

async function robeLastPosted(nome) {
  let ts = 0;
  try {
    const p = await manifestStore.read(nome).catch(()=>null);
    if (p && p.ultimaPostagemRobe) ts = p.ultimaPostagemRobe;
  } catch {}
  return ts;
}

function robeUpdateMeta(nome, patch) {
  robeMeta[nome] = robeMeta[nome] || {};
  Object.assign(robeMeta[nome], patch || {});
}

function getWorkingProfileNames() {
  const nomes = [];
  controllers.forEach((ctrl, nome) => {
    if (ctrl && ctrl.browser && ctrl.trabalhando) nomes.push(nome);
  });
  return nomes;
}

async function closeExtraPages(browser, mainPage, nome) {
  try {
    const issues = require('./issues.js');
    const MAX_BUSCA_LOCALIZACAO_AGE_MS = 60000; // 60s de proteção
    const now = Date.now();

    // BLOQUEIO CRÍTICO: Flag global ativa => nunca fechar
    try {
      if (browser && browser._buscasLocalizacaoAtivas && browser._buscasLocalizacaoAtivas.size > 0) {
        return;
      }
    } catch {}

    const pages = await browser.pages();
    let closed = 0;

    const ctrl = controllers.get(nome);
    const sendLockActive = ctrl && ctrl.browser && ctrl.browser._sendLock && ctrl.browser._sendLock.active;
    const inRobe = (browser && browser._robeActiveFor === nome) || (nome && robeMeta[nome] && robeMeta[nome].emExecucao === true);
    const inConfig = ctrl && ctrl.configurando === true;
    const inHuman  = ctrl && ctrl.humanControl === true;

    function isProtectedBusca(p) {
      try {
        if (p._buscaLocalizacao === true) {
          const age = now - (p._buscaLocalizacaoSince || 0);
          if (age < MAX_BUSCA_LOCALIZACAO_AGE_MS) return true;
          try { delete p._buscaLocalizacao; } catch {}
          try { delete p._buscaLocalizacaoSince; } catch {}
          try { delete p._buscaLocalizacaoChatId; } catch {}
        }
      } catch {}
      return false;
    }

    if (!(sendLockActive || inRobe || inConfig || inHuman)) {
      for (const p of pages) {
        try {
          if (mainPage && p === mainPage) continue;
          if (!mainPage && pages[0] && p === pages[0]) continue;
          if (isProtectedBusca(p)) continue;
          let url = ''; try { url = typeof p.url === 'function' ? url = p.url() : ''; } catch {}
          if (!url || url === 'about:blank') {
            await p.close({ runBeforeUnload: false }).catch(()=>{});
            closed++;
          }
        } catch {}
      }
    }

    if (!(sendLockActive || inRobe || inConfig || inHuman)) {
      const again = await browser.pages();
      for (const p of again) {
        try {
        if (mainPage && p === mainPage) continue;
        if (!mainPage && again[0] && p === again[0]) continue;
          // PROTEÇÃO DUPLA: flag global + marcação
          try {
            if (browser && browser._buscasLocalizacaoAtivas && browser._buscasLocalizacaoAtivas.size > 0) {
              continue;
            }
          } catch {}
          if (isProtectedBusca(p)) continue;
        let url = ''; try { url = typeof p.url === 'function' ? p.url() : ''; } catch {}
        if (/facebook\.com\/marketplace\/create\/item/i.test(url)) continue;
        await p.close({ runBeforeUnload: false }).catch(()=>{});
        closed++;
        } catch {}
      }
    }

    if (closed > 0) {
      logger.info('[PRUNER] Fechou abas extras', { nome, closed });
      try { await issues.append(nome, 'mil_action', `pruner_closed_extras n=${closed}`); } catch {}
    }
  } catch (e) {
    if (process.env.PRUNE_DEBUG === '1') {
      logger.warn('[PRUNER] Erro prune', { nome, error: e && e.message || e });
    }
  }
}

const _pruners = new Map();

function maybeStartPruneLoop(nome, browser, mainPage) {
  if (_pruners.has(nome)) return;
  const interval = setInterval(async () => {
    try {
      const MAX_BUSCA_LOCALIZACAO_AGE_MS = 60000;
      const now = Date.now();
      try {
        const pages = await browser.pages();
        const hasBusca = Array.isArray(pages) && pages.some(p => p._buscaLocalizacao === true && (now - (p._buscaLocalizacaoSince || 0)) < MAX_BUSCA_LOCALIZACAO_AGE_MS);
        if (hasBusca) {
          // Se há busca em andamento recentíssima, não fecha nada nessa passada.
          return;
        }
      } catch {}
      await closeExtraPages(browser, mainPage, nome);
    } catch (e) {
      if (process.env.PRUNE_DEBUG === '1') {
        logger.warn('[PRUNER] Erro prune', { nome, error: e && e.message || e });
      }
    }
  }, 2*60*1000);
  _pruners.set(nome, interval);
}

function stopPruneLoop(nome) {
  if (_pruners.has(nome)) {
    clearInterval(_pruners.get(nome));
    _pruners.delete(nome);
  }
}

let ramMonitorInterval = null;

// ====== ELEIÇÃO DE LÍDER DE MÉTRICAS (UM POR HOST) ======
// Somente o líder executa o monitor pesado de RAM/CPU (WMI/pidusage).
// Demais workers apenas aguardam e consomem os dados via robeMeta/status.json.
const METRICS_LEADER_FILE = path.join(__dirname, '..', 'dados', 'metrics_leader.lock');
const METRICS_LEADER_STALE_MS = 60 * 1000; // 60s
let isMetricsLeaderFlag = false;

function ensureMetricsLeader() {
  try {
    const now = Date.now();

    // Se já somos líder, apenas atualiza o heartbeat no arquivo
    if (isMetricsLeaderFlag) {
      try {
        fs.writeFileSync(
          METRICS_LEADER_FILE,
          JSON.stringify({ pid: process.pid, ts: now }),
          'utf8'
        );
      } catch {}
      return true;
    }

    // Tenta adquirir lock criando o arquivo em modo exclusivo
    try {
      const fd = fs.openSync(METRICS_LEADER_FILE, 'wx');
      try {
        fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, ts: now }), 'utf8');
      } finally {
        fs.closeSync(fd);
      }
      isMetricsLeaderFlag = true;
      return true;
    } catch {
      // Arquivo já existe — verificar se está STALE
      let data = null;
      try {
        const raw = fs.readFileSync(METRICS_LEADER_FILE, 'utf8');
        data = JSON.parse(raw);
      } catch {
        data = null;
      }
      const ts = data && typeof data.ts === 'number' ? data.ts : 0;
      if (!ts || (now - ts) > METRICS_LEADER_STALE_MS) {
        // Considera líder anterior como morto/stale — tenta assumir
        try { fs.unlinkSync(METRICS_LEADER_FILE); } catch {}
        try {
          const fd = fs.openSync(METRICS_LEADER_FILE, 'wx');
          try {
            fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, ts: now }), 'utf8');
          } finally {
            fs.closeSync(fd);
          }
          isMetricsLeaderFlag = true;
          return true;
        } catch {
          // Outro processo venceu a corrida — não somos líder
          return false;
          }
      }
      // Arquivo recente: outro worker é o líder
      return false;
        }
      } catch {
    return false;
      }
    }

// Helpers para coleta de memória por PID — sem WMI/PowerShell
async function getWinTasklistMap() {
  return new Promise((resolve) => {
    execFile('tasklist', ['/FO','CSV','/NH'], { windowsHide: true, maxBuffer: 10*1024*1024 }, (err, stdout) => {
      if (err || !stdout) return resolve({});
      const map = {};
      const lines = stdout.toString('utf8').split(/\r?\n/).filter(Boolean);
      for (const line of lines) {
        // CSV: "Image Name","PID","Session Name","Session#","Mem Usage"
        let s = line.trim();
        if (s.startsWith('"') && s.endsWith('"')) s = s.slice(1, -1);
        const cols = s.split('","'); // simples e robusto p/ tasklist
        if (cols.length < 5) continue;
        const pidStr = cols[1].trim();
        const memStr = cols[4].trim(); // ex.: "123.456 K" (com separador)
        const pid = parseInt(pidStr, 10);
        if (!Number.isFinite(pid)) continue;
        const memKB = parseInt(memStr.replace(/[^\d]/g, ''), 10); // remove pontos/virgulas/K
        if (!Number.isFinite(memKB)) continue;
        const memMB = Math.round(memKB / 1024);
        map[pid] = memMB;
      }
      resolve(map);
    });
  });
}

async function getPosixPsMap() {
  // Linux/macOS: ps -o pid=,rss= (rss em KB)
  // macOS usa 'ps -axo pid=,rss=' e Linux também aceita 'ps -o pid=,rss='
  const args = process.platform === 'darwin'
    ? ['-axo','pid=,rss=']
    : ['-o','pid=,rss=','-A'];
  return new Promise((resolve) => {
    execFile('ps', args, { maxBuffer: 10*1024*1024 }, (err, stdout) => {
      if (err || !stdout) return resolve({});
      const map = {};
      const lines = stdout.toString('utf8').split(/\r?\n/).filter(Boolean);
      for (const line of lines) {
        const parts = line.trim().split(/\s+/);
        if (parts.length < 2) continue;
        const pid = parseInt(parts[0], 10);
        const rssKB = parseInt(parts[1], 10);
        if (!Number.isFinite(pid) || !Number.isFinite(rssKB)) continue;
        const memMB = Math.round(rssKB / 1024);
        map[pid] = memMB;
      }
      resolve(map);
    });
  });
}

// === INÍCIO: PID discovery via CDP/Tracing (sem WMI) ===
const PIDS_CACHE_TTL_MS = parseInt(process.env.RAM_PIDS_CACHE_TTL_MS || '30000', 10); // 30s
const PIDS_TRACE_MS     = parseInt(process.env.RAM_PIDS_TRACE_MS || '240', 10);       // ~240ms
const PIDS_REFRESH_PER_TICK = parseInt(process.env.RAM_PIDS_REFRESH_PER_TICK || '2', 10);

async function readIOStreamChunks(session, stream) {
  const chunks = [];
  while (true) {
    const chunk = await session.send('IO.read', { handle: stream, size: 1 << 20 }).catch(()=>null);
    if (!chunk) break;
    if (chunk.data) chunks.push(chunk.data);
    if (chunk.eof) break;
  }
  try { await session.send('IO.close', { handle: stream }).catch(()=>{}); } catch {}
  return chunks.join('');
}

async function collectChromePidsViaTracing(browser, { sampleMs = PIDS_TRACE_MS } = {}) {
  try {
    if (!browser || !browser.isConnected || (browser.isConnected && browser.isConnected() === false)) return [];
    const target = browser.target();
    if (!target || !target.createCDPSession) return [];
    const session = await target.createCDPSession();
    const pids = new Set();
    const tracingComplete = new Promise((resolve) => {
      const onComplete = async (ev) => {
        try {
          const stream = ev && ev.stream;
          if (!stream) return resolve([]);
          const data = await readIOStreamChunks(session, stream);
          // data é um JSON com traceEvents
          try {
            const obj = JSON.parse(data);
            const arr = Array.isArray(obj && obj.traceEvents) ? obj.traceEvents : [];
            for (const e of arr) {
              if (e && typeof e.pid === 'number') pids.add(e.pid);
      }
    } catch {}
        } finally {
          resolve(Array.from(pids));
        }
      };
      session.on('Tracing.tracingComplete', onComplete);
    });
    // Start Tracing com memory-infra (rápido e leve)
    await session.send('Tracing.start', {
      categories: 'disabled-by-default-memory-infra',
      transferMode: 'ReturnAsStream',
      options: 'record-as-much-as-possible'
    }).catch(()=>{});
    // Aguarda um pequeno sampling
    await new Promise(r => setTimeout(r, Math.max(120, sampleMs)));
    // Stop
    try { await session.send('Tracing.end').catch(()=>{}); } catch {}
    const res = await tracingComplete;
    try { await session.detach && session.detach().catch(()=>{}); } catch {}
    return Array.isArray(res) ? res : [];
        } catch {
    return [];
  }
}

async function getControllerPidsCached(nome, ctrl, { forceRefresh = false } = {}) {
  try {
    if (!ctrl || !ctrl.browser || (ctrl.browser.isConnected && ctrl.browser.isConnected() === false)) return [];
          robeMeta[nome] = robeMeta[nome] || {};
    const cache = robeMeta[nome]._pidCache || { pids: [], ts: 0 };
    const expired = (Date.now() - cache.ts) > PIDS_CACHE_TTL_MS;
    if (!forceRefresh && !expired && Array.isArray(cache.pids) && cache.pids.length) {
      return cache.pids.slice(0);
    }
    // Força refresh (tranquilo: curto e leve)
    const pids = await collectChromePidsViaTracing(ctrl.browser).catch(()=>[]);
    // Garante incluir o rootPid (fallback)
    const root = robeMeta[nome].rootPid || null;
    const set = new Set(Array.isArray(pids) ? pids : []);
    if (root && Number.isFinite(root)) set.add(root);
    const arr = Array.from(set);
    robeMeta[nome]._pidCache = { pids: arr, ts: Date.now() };
    return arr.slice(0);
  } catch {
    return [];
  }
}
// === FIM: PID discovery via CDP/Tracing (sem WMI) ===

// Pequeno lock para evitar overlap de ticks
let _ramTickBusy = false;

async function ramCpuMonitorTick() {
  if (_ramTickBusy) {
    // agenda próximo tick mesmo se estiver ocupada (anti overlap)
    const WIN_INTERVAL_MS = parseInt(process.env.WIN_RAM_TICK_MS || '10000', 10);
    const NIX_INTERVAL_MS = 8000 + Math.floor(Math.random() * 2000);
    const INTERVAL_MS = (process.platform === 'win32') ? WIN_INTERVAL_MS : NIX_INTERVAL_MS;
    ramMonitorInterval = setTimeout(ramCpuMonitorTick, INTERVAL_MS);
              return;
            }

  _ramTickBusy = true;
  const WIN_INTERVAL_MS = parseInt(process.env.WIN_RAM_TICK_MS || '12000', 10); // 12s padrão Windows
  const NIX_INTERVAL_MS = 9000 + Math.floor(Math.random() * 2000); // ~9–11s POSIX
  const INTERVAL_MS = (process.platform === 'win32') ? WIN_INTERVAL_MS : NIX_INTERVAL_MS;

  try {
    // Se não há nenhum browser ativo neste worker, não gasta CPU
    if (!controllers || controllers.size === 0) {
      for (const nome of Object.keys(robeMeta)) {
        robeMeta[nome] = robeMeta[nome] || {};
        robeMeta[nome].ramMB = null;
            robeMeta[nome].cpuPercent = null;
          }
      await snapshotStatusAndWrite();
      return;
    }

    // Tira um snapshot do OS (uma chamada só por tick, leve)
    const pidMemMap = process.platform === 'win32'
      ? await getWinTasklistMap()
      : await getPosixPsMap();

    // Refrescamos no máximo N perfis por tick (demais usam cache)
    const entries = Array.from(controllers.entries());
    const refreshBudget = Math.min(PIDS_REFRESH_PER_TICK, entries.length);
    for (let i = 0; i < refreshBudget; i++) {
      const [n, c] = entries[(i + (ramCpuMonitorTick._rr || 0)) % entries.length];
      try { await getControllerPidsCached(n, c, { forceRefresh: true }); } catch {}
    }
    ramCpuMonitorTick._rr = ((ramCpuMonitorTick._rr || 0) + refreshBudget) % Math.max(1, entries.length);

    // Atualiza todos os perfis controlados por este worker
    for (const [nome, ctrl] of controllers.entries()) {
      try {
        if (!ctrl || !ctrl.browser || (ctrl.browser.isConnected && ctrl.browser.isConnected() === false)) {
          robeMeta[nome] = robeMeta[nome] || {};
          robeMeta[nome].ramMB = null;
          robeMeta[nome].cpuPercent = null;
          continue;
        }

        // Captura rootPid se ainda não existir
        robeMeta[nome] = robeMeta[nome] || {};
        if (!robeMeta[nome].rootPid) {
          try {
            const proc = ctrl.browser.process && ctrl.browser.process();
            if (proc && proc.pid) {
              robeMeta[nome].rootPid = proc.pid;
            }
          } catch {}
        }

        // NOVO: soma de root + filhos (pelo CDP Tracing) + tasklist/ps
        // Aplica fator de correção para aproximar Private Working Set (evita duplicação de memória compartilhada)
        const RAM_CORRECTION_FACTOR = parseFloat(process.env.RAM_CORRECTION_FACTOR || '0.435'); // 0.435 = ~43.5% (ajuste fino)
        const pids = await getControllerPidsCached(nome, ctrl, { forceRefresh: false });
        let totalMB = 0;
          if (Array.isArray(pids) && pids.length) {
              for (const pid of pids) {
            const v = pidMemMap[pid];
            if (typeof v === 'number' && v >= 0) totalMB += v;
          }
          // Aplica fator de correção para aproximar Private Working Set (Windows: Working Set inclui memória compartilhada)
          if (process.platform === 'win32' && RAM_CORRECTION_FACTOR > 0 && RAM_CORRECTION_FACTOR <= 1) {
            totalMB = Math.round(totalMB * RAM_CORRECTION_FACTOR);
          }
        } else {
          // fallback duro (só rootPid) se cache vazio
          const root = robeMeta[nome].rootPid || null;
          if (root && Number.isFinite(root) && typeof pidMemMap[root] === 'number') {
            totalMB = pidMemMap[root];
            // Aplica fator de correção também no fallback
            if (process.platform === 'win32' && RAM_CORRECTION_FACTOR > 0 && RAM_CORRECTION_FACTOR <= 1) {
              totalMB = Math.round(totalMB * RAM_CORRECTION_FACTOR);
            }
          } else {
            totalMB = 0;
          }
        }
        robeMeta[nome].ramMB = totalMB || null;
        // CPU por perfil permanece null (sem WMI/PowerShell). O frontend já é null-aware
        robeMeta[nome].cpuPercent = null;

      } catch {
        try {
        robeMeta[nome] = robeMeta[nome] || {};
          robeMeta[nome].ramMB = null;
          robeMeta[nome].cpuPercent = null;
        } catch {}
      }
    }

  await snapshotStatusAndWrite();
  } catch (e) {
    try { logger.warn('[RAM-TICK] erro', { error: (e && e.message) || e }); } catch {}
  } finally {
    _ramTickBusy = false;
    ramMonitorInterval = setTimeout(ramCpuMonitorTick, INTERVAL_MS);
  }
}

function normalizePath(x) { return String(x||'').replace(/\\/g,'/'); }

function extractUserDataDir(cmd) {
  if (!cmd) return null;
  const m = /--user-data-dir=(?:"([^"]+)"|'([^']+)'|([^\s]+))/i.exec(cmd);
  return m ? (m[1] || m[2] || m[3]) : null;
}

// Função para obter Private Working Set no Windows (evita duplicação de memória compartilhada)
// 110% sem WMI/PowerShell — não coleta nada (pidusage e ps-list usam WMI internamente)
async function getPidPrivateWSBytes(pids) {
  // 110% sem WMI/PowerShell — não coleta nada
  return {};
}

setTimeout(ramCpuMonitorTick, 5000);

// ====== Robe dinâmico (itens vs veiculos) ======
async function getRobeModuleFor(nome) {
  try {
    const man = await manifestStore.read(nome).catch(()=>null);
    const mode = (man && man.robeMode) ? String(man.robeMode) : 'itens';
    if (mode === 'veiculos') {
      return require('./robeVeiculos.js');
    }
    return require('./robe.js');
  } catch {
    return require('./robe.js');
  }
}

// Wrapper: startRobeDynamic (substitui hook global robeHelper.startRobe)
async function startRobeDynamic(browser, nome, robePauseMs, workingNow) {
  let manifest = null;
  try { manifest = await manifestStore.read(nome); } catch{}
  if (!manifest) {
    robeMeta[nome] = robeMeta[nome] || {};
    robeMeta[nome].activationHeldUntil = Date.now() + 15000;
    await reportAction(nome, 'mil_action', 'robe_abort_manifest_unavailable (no freeze)');
    return { ok: false, error: 'manifest_unavailable' };
  }
  if (!manifest.cookies || !manifest.fp) {
    robeMeta[nome] = robeMeta[nome] || {};
    robeMeta[nome].activationHeldUntil = Date.now() + 15000;
    await reportAction(nome, 'mil_action', 'robe_abort_manifest_incomplete (no freeze)');
    return { ok: false, error: 'manifest_incomplete' };
  }
  const now = Date.now();
  if (robeMeta[nome]?.ramKilledAt && robeMeta[nome].ramKillBackoff && robeMeta[nome].ramKillBackoff > now) {
    return { ok: false, error: 'ram_backoff' };
  }
  try {
    const mod = await getRobeModuleFor(nome);
    return await mod.startRobe(browser, nome, robePauseMs, workingNow);
  } catch (e) {
    await reportAction(nome, 'robe_error', `Erro técnico no Robe: ${(e&&e.message)||e}. Cooldown padrão (15–30min) será aplicado pelo módulo.`);
    return { ok: false, error: String(e&&e.message||e) };
  }
}

async function robeTickGlobal() {

  const perfisArr = loadPerfisJson();
  const nomesAll = perfisArr.map(p => p.nome);
  const prontosArr = await Promise.all(nomesAll.map(async (nome) => {
    if (isFrozenNow(nome)) return null;
    if (robeMeta[nome]?.ramKilledAt && robeMeta[nome].ramKillBackoff && robeMeta[nome].ramKillBackoff > Date.now()) {
      return null;
    }
    const ctrl = controllers.get(nome);
    if (!ctrl || !ctrl.browser || !ctrl.trabalhando || ctrl.configurando || ctrl.humanControl) return null;
    const cooldown = await normalizeCooldown(nome);
    const inFila = robeQueue.inQueue(nome);
    const exec = robeQueue.isActive(nome);
    const manGate = await manifestStore.read(nome).catch(()=>null);
    if (manGate && manGate.robePauseReason === 'limit_posting' && (manGate.robeCooldownUntil || 0) > Date.now()) {
      try { await issues.append(nome, 'mil_action', 'skip_robe_enqueue_due_limit_posting_active'); } catch {}
      return null;
    }
    return (cooldown === 0 && (!inFila) && (!exec)) ? nome : null;
  }));
  const prontos = prontosArr.filter(Boolean);

  for (const nome of prontos) {
    const ctrl = controllers.get(nome);
    if (!ctrl || !ctrl.browser) continue;

    logger.info('[WORKER][robeTickGlobal] Enfileirando', { nome, cooldown: await normalizeCooldown(nome), inQueue: robeQueue.inQueue(nome), isActive: robeQueue.isActive(nome) });

    robeQueue.enqueue(nome, async () => {

      robeUpdateMeta(nome, { emExecucao: true, emFila: false });

      let virtusWasRunning = false;
      const ctrl = controllers.get(nome);
      const workingNow = getWorkingProfileNames();
      if (ctrl && ctrl.browser) ctrl.browser._robeActiveFor = nome;

      if (!ctrl || !ctrl.browser || !ctrl.browser.isConnected?.()) {
        robeUpdateMeta(nome, { estado: 'erro' });
        try { await reportAction(nome, 'browser_disconnected', 'Browser desconectado antes de iniciar o Robe (guard)'); } catch {}
        try { if (ctrl && ctrl.browser) delete ctrl.browser._robeActiveFor; } catch {}
        return;
      }

      try { logger.info('[WORKER][robeTickGlobal] Robe start', { nome }); } catch {}
      try { await reportAction(nome, 'robe_start', 'Iniciando Robe via fila global'); } catch {}

      let mainPage = null;
      try {
        if (ctrl && ctrl.browser && !ctrl.mainPage) {
          try {
            const pages = await ctrl.browser.pages();
            if (pages[0]) {
              ctrl.mainPage = pages[0];
              try { await wirePageObservers(nome, ctrl.mainPage); } catch {}
            }
          } catch {}
        }
        mainPage = ctrl.mainPage;

        if (ctrl && ctrl.virtus && typeof ctrl.virtus.stop === 'function') {
          virtusWasRunning = true;
          try { await ctrl.virtus.stop(); } catch {}
          ctrl.virtus = null;
        }

        try { await closeExtraPages(ctrl.browser, mainPage, nome); } catch {}

        const robePauseMs = (15 + Math.floor(Math.random() * 16)) * 60 * 1000;

        let res;
        try {
          res = await startRobeDynamic(ctrl.browser, nome, robePauseMs, workingNow);
        } catch (e) {
          if (e && (e.LIMIT_POSTING === true || String(e && e.message || '').includes('LIMIT_POSTING_ABORT'))) {
            robeMeta[nome] = robeMeta[nome] || {};
            robeMeta[nome].limitPostingThisRun = Date.now();
            robeMeta[nome].pauseReason = 'limit_posting';
            robeUpdateMeta(nome, { estado: 'paused_limit', cooldownSec: await normalizeCooldown(nome), emExecucao: false });
            try { await issues.append(nome, 'mil_action', 'limit_posting_guard:caught_throw (robeTickGlobal)'); } catch {}
            try { if (ctrl && ctrl.browser) delete ctrl.browser._robeActiveFor; } catch {}
            return;
          }
          await reportAction(nome, 'robe_error', `Falha técnica: ${(e&&e.message)||e}; cooldown padrão (15–30min) será aplicado por robe.js`);
          robeUpdateMeta(nome, { estado: 'erro', cooldownSec: await normalizeCooldown(nome) });
          try { logger.warn('[WORKER][robeTickGlobal] Robe error', { nome, error: e && e.message || e }); } catch {}
          try { if (ctrl && ctrl.browser) delete ctrl.browser._robeActiveFor; } catch {}
          return;
        }

        if (isLimitPostingRes(res)) {
          robeMeta[nome] = robeMeta[nome] || {};
          robeMeta[nome].limitPostingThisRun = Date.now();
          robeMeta[nome].pauseReason = 'limit_posting';
          robeUpdateMeta(nome, { estado: 'paused_limit', cooldownSec: await normalizeCooldown(nome), emExecucao: false });
          await issues.append(nome, 'mil_action', 'limit_posting_guard: cycle aborted and locked to 24h');
          try { if (ctrl && ctrl.browser) delete ctrl.browser._robeActiveFor; } catch {}
          return;
        }

        if (res && res.ok) {
          try {
            await manifestStore.update(nome, (m) => {
              m = m || {};
              m.ultimaPostagemRobe = Date.now();
              return m;
            });
          } catch {}
          const last = await robeLastPosted(nome);
          robeUpdateMeta(nome, {
            estado: 'ok',
            cooldownSec: await normalizeCooldown(nome),
            proximaPostagem: last + robePauseMs,
            ultimaPostagem: Date.now()
          });
          try { await reportAction(nome, 'robe_success', 'Robe finalizado com sucesso'); } catch {}
          try { logger.info('[WORKER][robeTickGlobal] Robe success', { nome }); } catch {}
        } else {
          robeUpdateMeta(nome, {
            estado: 'idle',
            cooldownSec: await normalizeCooldown(nome)
          });
        }
      } catch (e) {
        robeUpdateMeta(nome, { estado: 'erro', cooldownSec: await normalizeCooldown(nome) });
      } finally {
        try { if (ctrl && ctrl.browser) delete ctrl.browser._robeActiveFor; } catch {}
        if (robeMeta[nome] && robeMeta[nome].limitPostingThisRun) {
          await issues.append(nome, 'mil_action', 'robe_end_limit_posting');
          delete robeMeta[nome].limitPostingThisRun;
          try { await closeExtraPages(ctrl.browser, ctrl.mainPage, nome); } catch {}
          robeUpdateMeta(nome, { emExecucao: false });
          if (virtusWasRunning && automationAllowed(ctrl)) {
            try {
              ctrl.virtus = virtusHelper.startVirtus(ctrl.browser, nome, { restrictTab: 0, epoch: ctrl.virtusEpoch || 0 });
              ctrl.trabalhando = true;
              await issues.append(nome, 'mil_action', 'virtus_restarted_after_limit_posting');
            } catch {
              ctrl.virtus = null;
              ctrl.trabalhando = false;
            }
          }
          await snapshotStatusAndWrite();
          return;
        }
        try { await closeExtraPages(ctrl.browser, ctrl.mainPage, nome); } catch {}

        robeUpdateMeta(nome, { emExecucao: false });

        if (virtusWasRunning) {
          if (automationAllowed(ctrl)) {
            try {
              ctrl.virtus = virtusHelper.startVirtus(ctrl.browser, nome, { restrictTab: 0, epoch: ctrl.virtusEpoch || 0 });
              ctrl.trabalhando = true;
            } catch (e) {
              ctrl.virtus = null;
              ctrl.trabalhando = false;
            }
          } else {
            ctrl.virtus = null;
            ctrl.trabalhando = false;
          }
          await snapshotStatusAndWrite();
        }

        try { await reportAction(nome, 'robe_end', 'Robe ciclo finalizado'); } catch {}
        try { logger.info('[WORKER][robeTickGlobal] Robe end', { nome }); } catch {}
      }
    });

    robeUpdateMeta(nome, { emFila: true });
  }

  for (const n of Object.keys(robeMeta)) {
    const m = robeMeta[n];
    if (!m) continue;
    if (!robeQueue.inQueue(n)) delete m.emFila;
    if (!robeQueue.isActive(n)) delete m.emExecucao;
  }
}

// Intervalo do robeTickGlobal controlável por env (padrão 3000ms para maior reatividade)
const ROBE_TICK_INTERVAL_MS = parseInt(process.env.ROBE_TICK_INTERVAL_MS || '3000', 10);
const ROBE_TICK_INITIAL_MS = Math.floor(ROBE_TICK_INTERVAL_MS / 2);
setInterval(robeTickGlobal, ROBE_TICK_INTERVAL_MS);
setTimeout(robeTickGlobal, ROBE_TICK_INITIAL_MS);

async function fotosGcTick() {
  try {
    const res = await fotos.gcSweep();
    if (res && (res.deletedFiles || res.removedIndex || res.resetGens)) {
      logger.info('[FOTOS][GC] resultado', { deletedFiles: res.deletedFiles, removedIndex: res.removedIndex, resetGens: res.resetGens });
    }
  } catch (e) {
    // index_lock_timeout é esperado quando há contenção (muitas operações simultâneas)
    // Não é crítico, apenas indica que o GC será tentado novamente no próximo ciclo
    const msg = (e && e.message) || String(e);
    if (msg.includes('index_lock_timeout')) {
      // Silencioso: timeout de lock é normal em alta contenção
    } else {
      logger.warn('[FOTOS][GC] erro', { error: msg });
    }
  }
}
setInterval(fotosGcTick, 90_000);
setTimeout(fotosGcTick, 8000);

async function stopVirtus(nome) {
const ctrl = controllers.get(nome);
if (!ctrl) return;
try {
if (ctrl.virtus && typeof ctrl.virtus.stop === 'function') {
await ctrl.virtus.stop().catch(()=>{});
}
} catch {}
ctrl.virtus = null;
ctrl.trabalhando = false;
ctrl.virtusEpoch = (ctrl.virtusEpoch || 0) + 1;
if (ctrl.browser) {
  ctrl.browser._fenceEpochMap = ctrl.browser._fenceEpochMap || {};
  ctrl.browser._fenceEpochMap[nome] = ctrl.virtusEpoch;
}
try { freezeCooldownIfNotWorking(nome); } catch {}
await snapshotStatusAndWrite();
}

function attachBrowserLifecycle(nome, browser) {
browser.once('disconnected', async () => {
try {
logger.info('[WORKER][BROWSER] disconnected', { nome });
try { robeQueue.skip && robeQueue.skip(nome); } catch {}

const ctrl = controllers.get(nome);
if (ctrl) { ctrl.humanControl = false; ctrl.configurando = false; }
try {
  if (ctrl && ctrl.virtus && typeof ctrl.virtus.stop === 'function') {
    await ctrl.virtus.stop().catch(()=>{});
  }
} catch {}

try { freezeCooldownIfNotWorking(nome); } catch {}

controllers.delete(nome);

// LIMPA rootPid para evitar consultas em PIDs órfãos (WMI-free+ps-tree)
try {
  if (robeMeta[nome]) {
    robeMeta[nome].rootPid = null;
  }
} catch {}

try { healthState.delete(nome); } catch {}
try { profileFailures.delete(nome); } catch {}
try {
  if (robeMeta[nome]) {
    delete robeMeta[nome].emExecucao;
    delete robeMeta[nome].emFila;
    delete robeMeta[nome].cpuHistory;
    delete robeMeta[nome].ramHist;
    delete robeMeta[nome].reloadAttemptsWindow;
    delete robeMeta[nome].blockDetectWindow;
  }
} catch {}

try { await reportAction(nome, 'browser_disconnected', 'Janela/navegador fechado (evento disconnected)'); } catch {}

stopPruneLoop(nome);

try { registerFailure(nome, 'disconnected', 'external'); } catch {}
try {
  const d = readJsonFile(desiredPath, { perfis: {} });
  const isDesiredActive = d.perfis?.[nome]?.active === true;
  const isHold = d.perfis?.[nome]?.humanHold === true;
  robeMeta[nome] = robeMeta[nome] || {};
  const now = Date.now();

  if (!isFrozenNow(nome) && isDesiredActive && !isHold) {
    if (!(robeMeta[nome].reopenAt && robeMeta[nome].reopenAt > now)) {
      robeMeta[nome].reopenAt = now + ULTRA_RECOVERY.REOPEN_DELAY_SHORT_MS;
      robeMeta[nome].closingReason = 'disconnected';
      issues.append(nome, 'mil_action', 'nurse_reopen_scheduled(disconnected)').catch(()=>{});
      // NOVO: Reduzido de 30s para 5s (reabertura quase imediata, supervisor controla velocidade)
      setKillGuard(nome, 5000);
    } else {
      issues.append(nome, 'mil_action', 'reopen_preserved_existing(disconnected)').catch(()=>{});
    }
  } else {
    robeMeta[nome].reopenAt = null;
    issues.append(nome, 'mil_action', isFrozenNow(nome) ? 
      'reopen_suppressed_frozen' : (isHold ? 'reopen_suppressed_human_hold' : 'reopen_suppressed_desired_off')).catch(()=>{});
  }
} catch {}

try { await snapshotStatusAndWrite(); } catch {}
} catch (e) {
  try { logger.warn('[WORKER][BROWSER] disconnect handler err', { error: e && e.message || e }); } catch {}
}
try {
  browser.removeAllListeners && browser.removeAllListeners('targetcreated');
  browser.removeAllListeners && browser.removeAllListeners('targetchanged');
  browser.removeAllListeners && browser.removeAllListeners('targetdestroyed');
} catch {}
});
}

function resolveChromeUserDataRoot() {
  if (process.platform === 'win32') {
    const la = process.env.LOCALAPPDATA;
    if (la) return path.join(la, 'Google', 'Chrome', 'User Data');
    const os = require('os');
    return path.join(os.homedir(), 'AppData', 'Local', 'Google', 'Chrome', 'User Data');
  }
  const os = require('os');
  return path.join(os.homedir(), '.config', 'google-chrome');
}

function automationAllowed(ctrl) {
  return !!(ctrl && !ctrl.humanControl && !ctrl.configurando && !ctrl.trabalhando);
}

async function start_work({ nome }) {
  return lockProfileAction(nome, async () => {
    logger.info('[HANDLER] start_work chamada', { nome });

    const ctrl = controllers.get(nome);
    if (!ctrl || !ctrl.browser || !ctrl.browser.isConnected?.())
      return { ok: false, error: 'Navegador não está aberto/vivo para esta conta!' };

    if (ctrl.humanControl || ctrl.configurando) {
      await issues.append(nome, 'mil_action', 'start_work_denied (human/config mode)');
      logger.warn('[HANDLER] start_work denied (human/config mode)', { nome });
      return { ok: false, error: 'profile_in_human_or_config' };
    }
    if (ctrl.trabalhando && ctrl.virtus) {
      logger.info('[HANDLER] start_work ok (já trabalhando)', { nome });
      return { ok: true };
    }
    if (ctrl._virtusStarting) {
      logger.info('[HANDLER] start_work ok (_virtusStarting)', { nome });
      return { ok: true };
    }

    try {
      ctrl._virtusStarting = true;
      if (!automationAllowed(ctrl)) {
        await issues.append(nome, 'mil_action', 'automation_not_allowed');
        logger.warn('[HANDLER] automation_not_allowed em start_work', { nome });
        return { ok: false, error: 'automation_not_allowed' };
      }
      ctrl.virtusEpoch = (ctrl.virtusEpoch || 0);

      ctrl.virtus = virtusHelper.startVirtus(ctrl.browser, nome, { restrictTab: 0, epoch: ctrl.virtusEpoch });
      ctrl.trabalhando = true;
      try {
        await browserHelper.forceCloseExtras(ctrl.browser);
        const ps = await ctrl.browser.pages();
        robeMeta[nome] = robeMeta[nome] || {};
        robeMeta[nome].numPages = (ps && ps.length) || 0;
        await snapshotStatusAndWrite();
      } catch {}

      if (ctrl.browser && typeof browserHelper.forceCloseExtras === 'function') {
        await browserHelper.forceCloseExtras(ctrl.browser);
      }

      try {
        await unfreezeCooldownIfWorking(nome);
        await normalizeCooldown(nome);
      } catch {}

      await snapshotStatusAndWrite();
      logger.info('[HANDLER] start_work ok', { nome });
      return { ok: true };
    } catch (e) {
      logger.error('[HANDLER] start_work erro', { nome, error: e && e.message }, e);
      return { ok: false, error: e && e.message || String(e) };
    } finally {
      ctrl._virtusStarting = false;
    }
  });
}

const handlers = {
  async ['criar-perfil']({ cidade, cookies }) {
    logger.info('[HANDLER] criar-perfil chamada', { cidadeProvided: !!cidade, cookiesProvided: !!cookies });
    if (!cidade || !cookies) return { ok: false, error: 'Cidade e cookies obrigatórios.' };
    if (!fs.existsSync(perfisDir)) fs.mkdirSync(perfisDir, { recursive: true });

    let nome = utils.slugify(cidade) + '-' + Date.now();
    while (fs.existsSync(path.join(perfisDir, nome))) nome += Math.floor(Math.random() * 100);

    const preset = pickUaPreset();
    if (!preset) return { ok: false, error: 'UA preset esgotado.' };

    const cookiesArr = utils.normalizeCookies(cookies);
    if (!cookiesArr.length || !cookiesArr.find(c => c.name === 'c_user') || !cookiesArr.find(c => c.name === 'xs')) {
      return { ok: false, error: 'Cookies inválidos ou ausentes: precisa de c_user e xs!' };
    }

    const perfilObj = {
      nome,
      cidade,
      uaPresetId: preset.id,
      uaString: preset.uaString,
      uaCh: preset.uaCh,
      fp: {
        viewport: preset.viewport || (preset.fp && preset.fp.viewport) || { width: 1366, height: 768 },
        dpr: preset.dpr || (preset.fp && preset.fp.dpr) || 1,
        hardwareConcurrency: preset.hardwareConcurrency || (preset.fp && preset.fp.hardwareConcurrency) || 4
      },
      cookies: cookiesArr,
      robeCooldownUntil: 0,
      configuredAt: null,
      userDataDir: path.join(resolveChromeUserDataRoot(), 'Conveniente', nome)
    };
    try { fs.mkdirSync(perfilObj.userDataDir, { recursive: true }); } catch {}

    const perfisArr = loadPerfisJson();
    perfisArr.push(perfilObj);
    savePerfisJson(perfisArr);

    try {
      await manifestStore.update(nome, (m) => {
        m = m || {};
        return Object.assign({}, m, perfilObj);
      });
    } catch {}

    logger.info('[HANDLER] criar-perfil ok', { nome });
    return { ok: true, perfil: perfilObj };
  },

  async activate({ nome }) {
    return lockProfileAction(nome, async () => {
      logger.info('[HANDLER] activate chamada', { nome });
      const r = await activateOnce(nome, 'message');
      logger.info('[HANDLER] activate resultado', { nome, ok: !!(r && r.ok), error: r && r.error });
      return r;
    });
  },

  async deactivate({ nome, reason, policy }) {
  return lockProfileAction(nome, async () => {
  logger.info('[HANDLER] deactivate chamada', { nome, reason, policy });
  const preserve = (policy === 'preserveDesired');
  let reopenDelayMs = 0;
  if (preserve) {
    try { registerFailure(nome, reason || 'deactivate_preserve'); } catch {}
    if (reason === 'ramKill' || reason === 'cpuKill') {
      reopenDelayMs = ULTRA_RECOVERY.REOPEN_DELAY_RAMCPU_MS + Math.floor(Math.random()*120000);
    } else if (reason === 'virtus_block') {
      reopenDelayMs = ULTRA_RECOVERY.REOPEN_DELAY_VIRTUS_BLOCK_MS + Math.floor(Math.random() * 21 + 5) * 60 * 1000;
    } else {
      reopenDelayMs = ULTRA_RECOVERY.REOPEN_DELAY_SHORT_MS;
    }
  }
  const ctrl = controllers.get(nome);
  if (!ctrl) {
    const d = readJsonFile(desiredPath, { perfis: {} });
    const isHold = d.perfis?.[nome]?.humanHold === true;
    if (preserve && !isFrozenNow(nome) && !isHold) {
      robeMeta[nome] = robeMeta[nome] || {};
      const now = Date.now();
      if (!(robeMeta[nome].reopenAt && robeMeta[nome].reopenAt > now)) {
        robeMeta[nome].reopenAt = now + reopenDelayMs;
        robeMeta[nome].closingReason = reason || '';
        issues.append(nome, 'mil_action', `reopen_scheduled(${reason||'unknown'}) in ${Math.round(reopenDelayMs/1000)}s`).catch(()=>{});
      } else {
        issues.append(nome, 'mil_action', 'reopen_preserved_existing').catch(()=>{});
      }
    } else if (preserve && isHold) {
      robeMeta[nome] = robeMeta[nome] || {};
      robeMeta[nome].reopenAt = null;
      issues.append(nome, 'mil_action', 'reopen_suppressed_human_hold').catch(()=>{});
    }
    await snapshotStatusAndWrite();
    logger.info('[HANDLER] deactivate concluído (controller ausente)', { nome });
    return { ok: true };
  }
  try {
    if (ctrl.virtus && typeof ctrl.virtus.stop === 'function') {
      await ctrl.virtus.stop();
    }
  } catch {}
  try {
    if (ctrl.browser && ctrl.browser.close) {
      await ctrl.browser.close();
    }
  } catch {}
  try {
    const root = robeMeta[nome]?.rootPid;
    if (root) {
      await killProcessTreeByRootPid(root);
      robeMeta[nome].rootPid = null;
    }
  } catch {}
  try { freezeCooldownIfNotWorking(nome); } catch {}
  controllers.delete(nome);

  try {
    if (robeMeta[nome]) {
      delete robeMeta[nome].emExecucao;
      delete robeMeta[nome].emFila;
      delete robeMeta[nome].cpuHistory;
      delete robeMeta[nome].ramHist;
      delete robeMeta[nome].reloadAttemptsWindow;
      delete robeMeta[nome].blockDetectWindow;
    }
  } catch {}

  stopPruneLoop(nome);
  if (!preserve) {
    try {
      await fileStore.withDesiredFileLockUpdate((d) => {
        d.perfis = d.perfis || {};
        d.perfis[nome] = { ...(d.perfis[nome] || {}), active: false, virtus: 'off' };
        return d;
      });
    } catch (e) {
      try { await issues.append('system','persist_failed', `${nome}|deactivate_desired_write`); } catch {}
    }
  } else {
    const d = readJsonFile(desiredPath, { perfis: {} });
    const isHold = d.perfis?.[nome]?.humanHold === true;
    robeMeta[nome] = robeMeta[nome] || {};
    const now = Date.now();
    if (!isHold) {
      if (!(robeMeta[nome].reopenAt && robeMeta[nome].reopenAt > now)) {
        robeMeta[nome].reopenAt = now + reopenDelayMs;
        robeMeta[nome].closingReason = reason || '';
        issues.append(nome, 'mil_action', `reopen_scheduled(${reason||'unknown'}) in ${Math.round(reopenDelayMs/1000)}s`).catch(()=>{});
      } else {
        issues.append(nome, 'mil_action', 'reopen_preserved_existing').catch(()=>{});
      }
    } else {
      robeMeta[nome].reopenAt = null;
      issues.append(nome, 'mil_action', 'reopen_suppressed_human_hold').catch(()=>{});
    }
  }
  await snapshotStatusAndWrite();
  logger.info('[HANDLER] deactivate concluído', { nome, reason, policy });
  return { ok: true };
  });
},

  async configure({ nome }) {
    return lockProfileAction(nome, async () => {
      logger.info('[HANDLER] configure chamada', { nome });
      const ctrl = controllers.get(nome);
      if (!ctrl || !ctrl.browser || !ctrl.browser.isConnected?.()) return { ok: false, error: 'Navegador não está aberto/vivo para esta conta!' };
      const guard = ctrl.browser._suppressBlankKillUntil = ctrl.browser._suppressBlankKillUntil || {};
      guard[nome] = Date.now() + 10601000;

      const perfisArr = loadPerfisJson();
      const perfil = perfisArr.find(p => p && p.nome === nome);
      if (!perfil || !perfil.userDataDir) return { ok: false, error: 'Perfil não encontrado!' };
      const manifestPath = path.join(perfil.userDataDir, 'manifest.json');
      if (!fs.existsSync(manifestPath)) return { ok: false, error: 'Manifest não existe para este perfil!' };
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      if (!Array.isArray(manifest.cookies) || !manifest.cookies.length) {
        try { await issues.append(nome, 'cookie_inject_failed', 'Cookies não encontrados no manifest!'); } catch {}
        return { ok: false, error: 'Cookies não encontrados no manifest!' };
      }
      ctrl.configurando = true;

      try { await stopVirtus(nome); } catch {}

      try {
        await fileStore.withDesiredFileLockUpdate((desired) => {
          desired.perfis = desired.perfis || {};
          desired.perfis[nome] = { ...(desired.perfis[nome] || {}), virtus: 'off' };
          return desired;
        });
      } catch {}

      try {
        await browserHelper.configureProfile(ctrl.browser, nome, manifest.cookies);
        try { await clearAccountFlags(nome, ['loginRequired']); } catch {}
        logger.info('[HANDLER] configure ok', { nome });
        return { ok: true };
      } catch (e) {
        try { await issues.append(nome, 'cookie_inject_failed', e && e.message || e); } catch {}
        logger.error('[HANDLER] configure erro', { nome, error: e && e.message || e }, e);
        return { ok: false, error: e && e.message || 'falha_injetar_cookies' };
      } finally {
        ctrl.configurando = false;
        ctrl.humanControl = true;
        stopPruneLoop(nome);
        await snapshotStatusAndWrite();
      }
    });
  },

  start_work,

  async invoke_human({ nome }) {
    return lockProfileAction(nome, async () => {
      logger.info('[HANDLER] invoke_human chamada', { nome });

      const ctrl = controllers.get(nome);
      if (!ctrl || !ctrl.browser || !ctrl.browser.isConnected?.()) return { ok: false, error: 'Navegador não está aberto/vivo para esta conta!' };

      const robes = robeMeta[nome] || {};
      if (robes.emExecucao) {
        const waitTimeout = 180 * 1000;
        const started = Date.now();
        while ((robeMeta[nome] && robeMeta[nome].emExecucao) && (Date.now() - started < waitTimeout)) {
          await new Promise(r => setTimeout(r, 600));
        }
      }

      ctrl.humanControl = true;

      try {
        await fileStore.withDesiredFileLockUpdate((desired) => {
          desired.perfis = desired.perfis || {};
          desired.perfis[nome] = { ...(desired.perfis[nome] || {}), humanHold: true };
          return desired;
        });
      } catch {}

      try {
        robeMeta[nome] = robeMeta[nome] || {};
        robeMeta[nome].reopenAt = null;
        robeMeta[nome].closingReason = null;
      } catch {}

      ctrl.configurando = false;
      stopPruneLoop(nome);
      try {
        await fileStore.withDesiredFileLockUpdate((desired) => {
          desired.perfis = desired.perfis || {};
          desired.perfis[nome] = { ...(desired.perfis[nome] || {}), virtus: 'off' };
          return desired;
        });
      } catch {}
      await snapshotStatusAndWrite();

      const guard = ctrl.browser._suppressBlankKillUntil = ctrl.browser._suppressBlankKillUntil || {};
      guard[nome] = Date.now() + 246060*1000;

      try { await stopVirtus(nome); } catch {}

      await browserHelper.invocarHumano(ctrl.browser, nome);

      try { freezeCooldownIfNotWorking(nome); } catch {}

      await snapshotStatusAndWrite();

      logger.info('[HANDLER] invoke_human ok', { nome });
      return { ok: true };
    });
  },

  async ['human-resume']({ nome }) {
    return lockProfileAction(nome, async () => {
      logger.info('[HANDLER] human-resume chamada', { nome });

      const ctrl = controllers.get(nome);
      if (!ctrl || !ctrl.browser || !ctrl.browser.isConnected?.()) return { ok: false, error: 'Navegador não está aberto/vivo para esta conta!' };

      ctrl.humanControl = false;
      try { await clearAccountFlags(nome, ['loginRequired','banned']); } catch {}
      try { if (ctrl.browser && ctrl.browser._suppressBlankKillUntil) delete ctrl.browser._suppressBlankKillUntil[nome]; } catch {}

      let pages2 = [];
      try { pages2 = await ctrl.browser.pages(); } catch {}
      if (pages2 && pages2[0]) maybeStartPruneLoop(nome, ctrl.browser, pages2[0]);
      try { await browserHelper.forceCloseExtras(ctrl.browser); } catch {}
      try {
        const ps = await ctrl.browser.pages();
        robeMeta[nome] = robeMeta[nome] || {};
        robeMeta[nome].numPages = (ps && ps.length) || 0;
        await snapshotStatusAndWrite();
      } catch {}

      let pages;
      try { pages = await ctrl.browser.pages(); } catch {}
      if (pages && pages[0]) {
        try {
          await require('./browser.js').ensureMinimizedWindowForPage(pages[0]);
          await new Promise(r => setTimeout(r, 350));
          await pages[0].goto('https://www.messenger.com/marketplace', { waitUntil: 'domcontentloaded', timeout: 30000 });
        } catch {}
      }

      if (automationAllowed(ctrl)) {
        ctrl.virtus = virtusHelper.startVirtus(ctrl.browser, nome, { restrictTab: 0, epoch: ctrl.virtusEpoch || 0 });
        ctrl.trabalhando = true;
      }

      try { unfreezeCooldownIfWorking(nome); } catch {}

      await snapshotStatusAndWrite();
      logger.info('[HANDLER] human-resume ok', { nome });

      try {
        await fileStore.withDesiredFileLockUpdate((desired) => {
          desired.perfis = desired.perfis || {};
          if (desired.perfis[nome]) desired.perfis[nome].humanHold = false;
          return desired;
        });
      } catch {}

      return { ok:true };
    });
  },

  async ['robe-play']({ nome }) {
    return lockProfileAction(nome, async () => {
      logger.info('[HANDLER] robe-play chamada', { nome });
      const ctrl = controllers.get(nome);
      if (!ctrl || !ctrl.browser || !ctrl.browser.isConnected?.()) return { ok: false, error: 'Navegador não está aberto/vivo para esta conta!' };

      if (isFrozenNow(nome)) {
        return { ok: false, error: 'account_frozen' }
      }
      if (ctrl && ctrl.configurando) return { ok: false, error: 'perfil_em_configuracao' };

      try {
        await manifestStore.update(nome, (m) => {
          m = m || {};
          m.robeCooldownUntil = Date.now();
          m.robeCooldownRemainingMs = 0;
          if (m.robePauseReason) delete m.robePauseReason;
          return m;
        });
        if (robeMeta[nome]) {
          delete robeMeta[nome].pauseReason;
          delete robeMeta[nome].lastRobeBlockAt;
        }
      } catch {}

      if (!robeQueue.inQueue(nome) && !robeQueue.isActive(nome)) {
        robeUpdateMeta(nome, { emFila: true });
        robeQueue.enqueue(nome, async () => {

          robeUpdateMeta(nome, { emExecucao: true, emFila: false });

          let virtusWasRunning = false;
          const ctrl = controllers.get(nome);
          const workingNow = getWorkingProfileNames();
          if (ctrl && ctrl.browser) ctrl.browser._robeActiveFor = nome;

          if (!ctrl || !ctrl.browser || !ctrl.browser.isConnected?.()) {
            robeUpdateMeta(nome, { estado: 'erro' });
            try { await reportAction(nome, 'browser_disconnected', 'Browser desconectado antes de iniciar o Robe (robe-play guard)'); } catch {}
            try { if (ctrl && ctrl.browser) delete ctrl.browser._robeActiveFor; } catch {}
            return;
          }

          try { logger.info('[WORKER][robe-play] Robe start', { nome }); } catch {}
          try { await reportAction(nome, 'robe_start', 'Iniciando Robe via robe-play'); } catch {}

          let mainPage = null;
          try {
            if (ctrl && ctrl.browser && !ctrl.mainPage) {
              try {
                const pages = await ctrl.browser.pages();
                if (pages[0]) {
                  ctrl.mainPage = pages[0];
                  try { await wirePageObservers(nome, ctrl.mainPage); } catch {}
                }
              } catch {}
            }
            mainPage = ctrl.mainPage;

            if (ctrl && ctrl.virtus && typeof ctrl.virtus.stop === 'function') {
              virtusWasRunning = true;
              try { await ctrl.virtus.stop(); } catch {}
              ctrl.virtus = null;
            }

            try { await closeExtraPages(ctrl.browser, mainPage, nome); } catch {}

            let res;
            try {
              res = await startRobeDynamic(ctrl.browser, nome, (15 + Math.floor(Math.random() * 16)) * 60 * 1000, workingNow);
            } catch (e) {
              if (e && (e.LIMIT_POSTING === true || String(e && e.message || '').includes('LIMIT_POSTING_ABORT'))) {
                robeMeta[nome] = robeMeta[nome] || {};
                robeMeta[nome].limitPostingThisRun = Date.now();
                robeMeta[nome].pauseReason = 'limit_posting';
                robeUpdateMeta(nome, { estado: 'paused_limit', cooldownSec: await normalizeCooldown(nome), emExecucao: false });
                try { await issues.append(nome, 'mil_action', 'limit_posting_guard:caught_throw (robe-play)'); } catch {}
                try { if (ctrl && ctrl.browser) delete ctrl.browser._robeActiveFor; } catch {}
                return;
              }
              await reportAction(nome, 'robe_error', `Falha técnica: ${(e&&e.message)||e}; cooldown padrão (15–30min) será aplicado por robe.js`);
              robeUpdateMeta(nome, { estado: 'erro', cooldownSec: await normalizeCooldown(nome) });
              try { logger.warn('[WORKER][robe-play] Robe error', { nome, error: e && e.message || e }); } catch {}
              try { if (ctrl && ctrl.browser) delete ctrl.browser._robeActiveFor; } catch {}
              return;
            }

            if (isLimitPostingRes(res)) {
              robeMeta[nome] = robeMeta[nome] || {};
              robeMeta[nome].limitPostingThisRun = Date.now();
              robeMeta[nome].pauseReason = 'limit_posting';
              robeUpdateMeta(nome, { estado: 'paused_limit', cooldownSec: await normalizeCooldown(nome), emExecucao: false });
              await issues.append(nome, 'mil_action', 'limit_posting_guard: cycle aborted and locked to 24h (robe-play)');
              try { if (ctrl && ctrl.browser) delete ctrl.browser._robeActiveFor; } catch {}
              return;
            }

            if (res && res.ok) {
              try {
                await manifestStore.update(nome, (m) => {
                  m = m || {};
                  m.ultimaPostagemRobe = Date.now();
                  return m;
                });
              } catch {}
              const last = await robeLastPosted(nome);
              robeUpdateMeta(nome, {
                estado: 'ok',
                cooldownSec: await normalizeCooldown(nome),
                proximaPostagem: last + ((15+Math.floor(Math.random()*16))*60*1000),
                ultimaPostagem: Date.now()
              });
              try { await reportAction(nome, 'robe_success', 'Robe finalizado com sucesso (robe-play)'); } catch {}
              try { logger.info('[WORKER][robe-play] Robe success', { nome }); } catch {}
            } else {
              robeUpdateMeta(nome, {
                estado: 'idle',
                cooldownSec: await normalizeCooldown(nome)
              });
            }
          } catch (e) {
            robeUpdateMeta(nome, { estado: 'erro', cooldownSec: await normalizeCooldown(nome) });
          } finally {
            try { if (ctrl && ctrl.browser) delete ctrl.browser._robeActiveFor; } catch {}
            if (robeMeta[nome] && robeMeta[nome].limitPostingThisRun) {
              await issues.append(nome, 'mil_action', 'robe_end_limit_posting');
              delete robeMeta[nome].limitPostingThisRun;
              try { await closeExtraPages(ctrl.browser, ctrl.mainPage, nome); } catch {}
              robeUpdateMeta(nome, { emExecucao: false });
              if (virtusWasRunning && automationAllowed(ctrl)) {
                try {
                  ctrl.virtus = virtusHelper.startVirtus(ctrl.browser, nome, { restrictTab: 0, epoch: ctrl.virtusEpoch || 0 });
                  ctrl.trabalhando = true;
                  await issues.append(nome, 'mil_action', 'virtus_restarted_after_limit_posting');
                } catch {
                  ctrl.virtus = null;
                  ctrl.trabalhando = false;
                }
              }
              await snapshotStatusAndWrite();
              return;
            }
            try { await closeExtraPages(ctrl.browser, ctrl.mainPage, nome); } catch {}

            robeUpdateMeta(nome, { emExecucao: false });

            if (virtusWasRunning) {
              if (automationAllowed(ctrl)) {
                try {
                  ctrl.virtus = virtusHelper.startVirtus(ctrl.browser, nome, { restrictTab: 0, epoch: ctrl.virtusEpoch || 0 });
                  ctrl.trabalhando = true;
                } catch (e) {
                  ctrl.virtus = null;
                  ctrl.trabalhando = false;
                }
              } else {
                ctrl.virtus = null;
                ctrl.trabalhando = false;
              }
              await snapshotStatusAndWrite();
            } else {
              await snapshotStatusAndWrite();
            }

            try { await reportAction(nome, 'robe_end', 'Robe ciclo finalizado (robe-play)'); } catch {}
            try { logger.info('[WORKER][robe-play] Robe end', { nome }); } catch {}
          }
        });
        await snapshotStatusAndWrite();
      }
      logger.info('[HANDLER] robe-play ok', { nome });
      return { ok: true };
    });
  },

  async ['robes-release-all']() {
    logger.info('[HANDLER] robes-release-all chamada');
    const perfisArr = loadPerfisJson();
    for (const p of perfisArr) {
      try {
        robeMeta[p.nome] = robeMeta[p.nome] || {};
        delete robeMeta[p.nome].pauseReason;
        delete robeMeta[p.nome].lastRobeBlockAt;
        await manifestStore.update(p.nome, m => {
          m = m || {};
          if (m.robePauseReason) delete m.robePauseReason;
          return m;
        });
      } catch {}
    }
    await snapshotStatusAndWrite();
    logger.info('[HANDLER] robes-release-all ok');
    return { ok: true };
  },

  // ====== HANDLER apply-city - aplica coordenadas da nova cidade em runtime ======
  async ['apply-city']({ nome }) {
    return lockProfileAction(nome, async () => {
      const ctrl = controllers.get(nome);

      // Se navegador não está ativo para este perfil, não há o que aplicar!
      if (!ctrl || !ctrl.browser || !ctrl.browser.isConnected?.()) {
        await issues.append(nome, 'mil_action', 'apply_city_runtime_skip_not_active');

        return { ok: true, active: false };
      }

      try {
        const man = await manifestStore.read(nome).catch(()=>null);
        const cidade = man && man.cidade || '';
        const coords = require('./utils.js').getCoords(cidade || '');

        if (!coords || !coords.latitude || !coords.longitude) {
          await issues.append(nome, 'mil_action', `apply_city_skip coords_unavailable cidade="${cidade||''}"`);

          return { ok: false, error: 'coords_unavailable' };
        }

        const pages = await ctrl.browser.pages().catch(()=>[]);
        let applied = 0;

        for (const p of (pages||[])) {
          try { await p.setGeolocation(coords); applied++; } catch {}
        }

        await issues.append(nome, 'mil_action', `apply_city_runtime_ok cidade="${cidade}" pages=${applied}`);

        // Optionally: update status snapshot
        try { await snapshotStatusAndWrite(); } catch {}

        return { ok: true, appliedPages: applied, cidade };

      } catch (e) {
        await issues.append(nome, 'mil_action', `apply_city_runtime_error ${(e&&e.message)||e}`);

        return { ok: false, error: (e && e.message) || String(e) };
      }
    });
  },

  async ['get-status']() {
    try {
      for (const n of Object.keys(robeMeta)) {
        const m = robeMeta[n];
        if (!m) continue;
        if (!Array.isArray(m.cpuHistory)) m.cpuHistory = [];
        while (m.cpuHistory.length > 8) m.cpuHistory.shift();
        if (!Array.isArray(m.ramHist)) m.ramHist = [];
        while (m.ramHist.length > 8) m.ramHist.shift();
        if (!Array.isArray(m.reloadAttemptsWindow)) m.reloadAttemptsWindow = [];
        while (m.reloadAttemptsWindow.length > 8) m.reloadAttemptsWindow.shift();
        if (!Array.isArray(m.blockDetectWindow)) m.blockDetectWindow = [];
        while (m.blockDetectWindow.length > 8) m.blockDetectWindow.shift();
      }
    } catch {}

    const perfisArr = loadPerfisJson();
    const desiredSnap = readJsonFile(desiredPath, { perfis: {} });
    const perfis = [];
    for (const p of perfisArr) {
      const nome = p.nome;
      let issuesCount = 0;
      try {
        if (issues && typeof issues.countErrors === 'function') {
          const res = issues.countErrors(nome);
          issuesCount = Number(res && res.count) || 0;
        } else {
          issuesCount = countErrorsLocal(nome);
        }
      } catch { issuesCount = 0; }
      const fail = getFailureCounts(nome);
      let manifestStatus = await computeManifestStatus(nome);
      const man = await manifestStore.read(nome).catch(()=>null);
      const loginRequired = man ? !!(man.accountFlags && man.accountFlags.loginRequired === true) : !!robeMeta[nome]?.loginRequired;
      const loginReason = man ? ((man.accountFlags && man.accountFlags.loginReason) || null) : (robeMeta[nome]?.loginReason || null);
      const banned = man ? !!(man.accountFlags && man.accountFlags.banned === true) : !!robeMeta[nome]?.banned;
      const bannedAt = man ? ((man.accountFlags && man.accountFlags.bannedAt) || null) : null;
      const bannedText = man ? ((man.accountFlags && man.accountFlags.bannedText) || null) : null;
      const problem = man
        ? !!((man.accountFlags && man.accountFlags.loginRequired === true) || (man.accountFlags && man.accountFlags.banned === true))
        : !!((robeMeta[nome] || {}).loginRequired || (robeMeta[nome] || {}).banned);
      const man0 = await manifestStore.read(nome).catch(()=>null);
      const robeMode = (man0 && man0.robeMode) ? String(man0.robeMode) : 'itens';

      perfis.push({
        nome,
        label: p.label || null,
        cidade: p.cidade,
        uaPresetId: p.uaPresetId,
        active: controllers.has(nome),
        trabalhando: !!(controllers.get(nome)?.trabalhando),
        configurando: !!(controllers.get(nome)?.configurando),
        humanControl: !!(controllers.get(nome)?.humanControl),
        humanHold: !!(desiredSnap.perfis && desiredSnap.perfis[nome] && desiredSnap.perfis[nome].humanHold === true),
        issuesCount,
        ramMB: (() => {
          const v = typeof robeMeta[nome]?.ramMB === "number" ? robeMeta[nome].ramMB : null;
          // Logs removidos para evitar poluição do terminal (ramMB null é normal para perfis inativos)
          return v;
        })(),
        cpuPercent: typeof robeMeta[nome]?.cpuPercent === "number" ? robeMeta[nome].cpuPercent : null,
        numPages: typeof robeMeta[nome]?.numPages === "number" ? robeMeta[nome].numPages : null,
        robeFrozenUntil: robeMeta[nome]?.frozenUntil || null,
        frozenReason: robeMeta[nome]?.frozenReason || null,
        frozenAt: robeMeta[nome]?.frozenAt || null,
        frozenSetBy: robeMeta[nome]?.frozenSetBy || null,
        internalFailCountWindow: fail.internal,
        externalFailCountWindow: fail.external,
        unfreezeCount: robeMeta[nome]?.unfreezeCount || 0,
        lastUnfreezeAt: robeMeta[nome]?.lastUnfreezeAt || null,
        activationHeldUntil: robeMeta[nome]?.activationHeldUntil || null,
        killGuardUntil: robeMeta[nome]?.killGuardUntil || null,
        reopenAt: robeMeta[nome]?.reopenAt || null,
        manifestStatus,
        closingReason: robeMeta[nome]?.closingReason || null,
        openBackoffMs: robeMeta[nome]?.openBackoffMs || null,
        lastSwapAt: robeMeta[nome]?.lastSwapAt || null,
        loginRequired,
        loginReason,
        banned,
        bannedAt,
        bannedText,
        problem,
        robeMode
      });
    }
    const robes = {};
    for (const p of perfisArr) {
      const nome = p.nome;
      const fail = getFailureCounts(nome);
      robes[nome] = {
        cooldownSec: await normalizeCooldown(nome),
        estado: robeMeta[nome]?.estado || '',
        proximaPostagem: robeMeta[nome]?.proximaPostagem || null,
        ultimaPostagem: robeMeta[nome]?.ultimaPostagem || null,
        emFila: !!robeMeta[nome]?.emFila,
        emExecucao: !!robeMeta[nome]?.emExecucao,
        ramMB: (() => {
          const v = typeof robeMeta[nome]?.ramMB === "number" ? robeMeta[nome].ramMB : null;
          // Logs removidos para evitar poluição do terminal (ramMB null é normal para perfis inativos)
          return v;
        })(),
        cpuPercent: typeof robeMeta[nome]?.cpuPercent === "number" ? robeMeta[nome].cpuPercent : null,
        numPages: typeof robeMeta[nome]?.numPages === "number" ? robeMeta[nome].numPages : null,
        robeFrozenUntil: robeMeta[nome]?.frozenUntil || null,
        frozenReason: robeMeta[nome]?.frozenReason || null,
        frozenAt: robeMeta[nome]?.frozenAt || null,
        frozenSetBy: robeMeta[nome]?.frozenSetBy || null,
        internalFailCountWindow: fail.internal,
        externalFailCountWindow: fail.external,
        unfreezeCount: robeMeta[nome]?.unfreezeCount || 0,
        lastUnfreezeAt: robeMeta[nome]?.lastUnfreezeAt || null,
        pauseReason: robeMeta[nome]?.pauseReason || null,
        lastRobeBlockAt: robeMeta[nome]?.lastRobeBlockAt || null
      };
      const pauseActive = await (async () => {
        try {
          const man = await manifestStore.read(nome).catch(()=>null);
          return !!(man && man.robePauseReason === 'limit_posting' && (man.robeCooldownUntil||0) > Date.now());
        } catch { return false; }
      })();
      if (pauseActive) {
        robes[nome].estado = 'paused_limit';
      }
      const man = await manifestStore.read(nome).catch(()=>null);
      if (man && man.robePauseReason === 'limit_posting' && (man.robeCooldownUntil||0) > Date.now()) {
        robes[nome].pauseReason = 'limit_posting';
        robes[nome].estado = 'paused_limit';
        await appendIssueNurseDebounced(nome, 'mil_action', 'status_force_limit_posting', 'status_force_limit_posting');
      }
    }
    const robeQueueList = robeQueue.queueList();
    const sys = {
      freeMB: Math.round(os.freemem()/(1024*1024)),
      totalMB: Math.round(os.totalmem()/(1024*1024)),
      cores: (os.cpus()||[]).length,
      cpuApprox: Math.min(100, Math.round(Object.values(robeMeta).reduce((acc, m) => acc + (typeof m.cpuPercent==='number' ? m.cpuPercent : 0), 0) / Math.max(1,(os.cpus()||[]).length)))
    };
    return {
      perfis,
      robes,
      robeQueue: robeQueueList,
      autoMode,
      sys
    };
  },

  async unfreeze({ nome, setBy }) {
    return lockProfileAction(nome, async () => {
      if (!nome) return { ok: false, error: 'nome_obrigatorio' };
      try { await unfreezeProfile(nome, setBy || 'admin'); } catch (e) { return { ok: false, error: e && e.message || String(e) }; }
      return { ok: true };
    });
  },

  async ['unfreeze-all']() {
    try {
      const perfisArr = loadPerfisJson();
      for (const p of perfisArr) {
        if (!p || !p.nome) continue;
        try { await unfreezeProfile(p.nome, 'admin_all'); } catch {}
      }
      return { ok: true };
    } catch (e) { return { ok: false, error: e && e.message || String(e) }; }
  },

  async ['set-shard']({ names }) {
    try {
      const newSet = new Set(Array.isArray(names) ? names : []);
      const removed = [];
      for (const nome of SHARD_SET) {
        if (!newSet.has(nome)) removed.push(nome);
      }
      SHARD_SET = newSet;

      for (const nome of removed) {
        const ctrl = controllers.get(nome);
        const rm = robeMeta[nome] || {};
        const robeRunning = rm.emExecucao === true || (ctrl && ctrl.browser && ctrl.browser._robeActiveFor === nome);
        const busy = robeRunning || (ctrl && (ctrl.configurando === true || ctrl.humanControl === true));

        if (busy) {
          robeMeta[nome] = rm;
          rm.pendingShardMove = true;
          rm.deferShardMoveUntil = Date.now() + 10*60*1000;
          await issues.append(nome, 'mil_action', 'shard_move_deferred (busy)');
          continue;
        }

        try { robeQueue.skip && robeQueue.skip(nome); } catch {}
        try {
          if (ctrl && ctrl.browser) {
            await handlers.deactivate({ nome, reason: 'shard_moved', policy: 'preserveDesired' });
          }
        } catch {}
        controllers.delete(nome);
        try { healthState.delete(nome); } catch {}
        try { profileFailures.delete(nome); } catch {}
        if (robeMeta[nome]) {
          delete robeMeta[nome].emExecucao;
          delete robeMeta[nome].emFila;
          delete robeMeta[nome].cpuHistory;
          delete robeMeta[nome].ramHist;
          delete robeMeta[nome].reloadAttemptsWindow;
          delete robeMeta[nome].blockDetectWindow;
        }
      }
      await snapshotStatusAndWrite();
      return { ok: true, size: SHARD_SET.size, removed };

    } catch (e) {
      return { ok: false, error: e && e.message || String(e) };
    }
  }
};

async function snapshotStatusAndWrite() {
  // Throttle: limita frequência de writes (800ms mínimo entre writes)
  if ((Date.now() - _lastSnapAt) < 800) return;
  _lastSnapAt = Date.now();

_statusLock = _statusLock.then(async () => {
try {
try {
  for (const n of Object.keys(robeMeta)) {
    const m = robeMeta[n];
    if (!m) continue;
    if (!Array.isArray(m.cpuHistory)) m.cpuHistory = [];
    while (m.cpuHistory.length > 8) m.cpuHistory.shift();
    if (!Array.isArray(m.ramHist)) m.ramHist = [];
    while (m.ramHist.length > 8) m.ramHist.shift();
    if (!Array.isArray(m.reloadAttemptsWindow)) m.reloadAttemptsWindow = [];
    while (m.reloadAttemptsWindow.length > 8) m.reloadAttemptsWindow.shift();
    if (!Array.isArray(m.blockDetectWindow)) m.blockDetectWindow = [];
    while (m.blockDetectWindow.length > 8) m.blockDetectWindow.shift();
  }
} catch {}

const perfisArr = loadPerfisJson();
const desiredSnap = readJsonFile(desiredPath, { perfis: {} });
const perfis = [];
for (const p of perfisArr) {
const nome = p.nome;
let issuesCount = 0;
try {
  if (issues && typeof issues.countErrors === 'function') {
    const res = issues.countErrors(nome);
    issuesCount = Number(res && res.count) || 0;
  } else {
    issuesCount = countErrorsLocal(nome);
  }
} catch {}
const fail = getFailureCounts(nome);
let manifestStatus = await computeManifestStatus(nome);
const man = await manifestStore.read(nome).catch(()=>null);
const loginRequired = man ? !!(man.accountFlags && man.accountFlags.loginRequired === true) : !!robeMeta[nome]?.loginRequired;
const loginReason = man ? ((man.accountFlags && man.accountFlags.loginReason) || null) : (robeMeta[nome]?.loginReason || null);
const banned = man ? !!(man.accountFlags && man.accountFlags.banned === true) : !!robeMeta[nome]?.banned;
const bannedAt = man ? ((man.accountFlags && man.accountFlags.bannedAt) || null) : null;
const bannedText = man ? ((man.accountFlags && man.accountFlags.bannedText) || null) : null;
const problem = man
  ? !!((man.accountFlags && man.accountFlags.loginRequired === true) || (man.accountFlags && man.accountFlags.banned === true))
  : !!((robeMeta[nome] || {}).loginRequired || (robeMeta[nome] || {}).banned);
const man0 = await manifestStore.read(nome).catch(()=>null);
const robeMode = (man0 && man0.robeMode) ? String(man0.robeMode) : 'itens';

perfis.push({
  nome,
  label: p.label || null,
  cidade: p.cidade,
  uaPresetId: p.uaPresetId,
  active: controllers.has(nome),
  trabalhando: !!(controllers.get(nome)?.trabalhando),
  configurando: !!(controllers.get(nome)?.configurando),
  humanControl: !!(controllers.get(nome)?.humanControl),
  humanHold: !!(desiredSnap.perfis && desiredSnap.perfis[nome] && desiredSnap.perfis[nome].humanHold === true),
  issuesCount,
  ramMB: typeof robeMeta[nome]?.ramMB === "number" ? robeMeta[nome].ramMB : null,
  cpuPercent: typeof robeMeta[nome]?.cpuPercent === "number" ? robeMeta[nome].cpuPercent : null,
  numPages: typeof robeMeta[nome]?.numPages === "number" ? robeMeta[nome].numPages : null,
  robeFrozenUntil: robeMeta[nome]?.frozenUntil || null,
  frozenReason: robeMeta[nome]?.frozenReason || null,
  frozenAt: robeMeta[nome]?.frozenAt || null,
  frozenSetBy: robeMeta[nome]?.frozenSetBy || null,
  unfreezeCount: robeMeta[nome]?.unfreezeCount || 0,
  lastUnfreezeAt: robeMeta[nome]?.lastUnfreezeAt || null,
  activationHeldUntil: robeMeta[nome]?.activationHeldUntil || null,
  killGuardUntil: robeMeta[nome]?.killGuardUntil || null,
  reopenAt: robeMeta[nome]?.reopenAt || null,
  manifestStatus,
  closingReason: robeMeta[nome]?.closingReason || null,
  openBackoffMs: robeMeta[nome]?.openBackoffMs || null,
  lastSwapAt: robeMeta[nome]?.lastSwapAt || null,
  loginRequired,
  loginReason,
  banned,
  bannedAt,
  bannedText,
  problem,
  robeMode
});
}
const robes = {};
for (const p of perfisArr) {
const nome = p.nome;
const fail = getFailureCounts(nome);
robes[nome] = {
  cooldownSec: await normalizeCooldown(nome),
  estado: robeMeta[nome]?.estado || '',
  proximaPostagem: robeMeta[nome]?.proximaPostagem || null,
  ultimaPostagem: robeMeta[nome]?.ultimaPostagem || null,
  emFila: !!robeMeta[nome]?.emFila,
  emExecucao: !!robeMeta[nome]?.emExecucao,
  ramMB: typeof robeMeta[nome]?.ramMB === "number" ? robeMeta[nome].ramMB : null,
  cpuPercent: typeof robeMeta[nome]?.cpuPercent === "number" ? robeMeta[nome].cpuPercent : null,
  numPages: typeof robeMeta[nome]?.numPages === "number" ? robeMeta[nome].numPages : null,
  robeFrozenUntil: robeMeta[nome]?.frozenUntil || null,
  frozenReason: robeMeta[nome]?.frozenReason || null,
  frozenAt: robeMeta[nome]?.frozenAt || null,
  frozenSetBy: robeMeta[nome]?.frozenSetBy || null,
  unfreezeCount: robeMeta[nome]?.unfreezeCount || 0,
  lastUnfreezeAt: robeMeta[nome]?.lastUnfreezeAt || null,
  pauseReason: robeMeta[nome]?.pauseReason || null,
  lastRobeBlockAt: robeMeta[nome]?.lastRobeBlockAt || null
};
try {
  if (robes[nome].cooldownSec === 0) {
    await releaseLimitPostingIfExpired(nome);
  }
} catch {}
if (robes[nome].cooldownSec === 0 && robeMeta[nome] && robeMeta[nome].pauseReason === 'fb_block') {
  const ts = robeMeta[nome].lastRobeBlockAt || 0;
  if (ts && (Date.now() - ts) > 25*60*60*1000) {
    delete robeMeta[nome].pauseReason;
    delete robeMeta[nome].lastRobeBlockAt;
  }
}
const pauseActive = await (async () => {
  try {
    const man = await manifestStore.read(nome).catch(()=>null);
    return !!(man && man.robePauseReason === 'limit_posting' && (man.robeCooldownUntil||0) > Date.now());
  } catch { return false; }
})();
if (pauseActive) {
  robes[nome].estado = 'paused_limit';
  robes[nome].pauseReason = 'limit_posting';
  await appendIssueNurseDebounced(nome, 'mil_action', 'status_force_limit_posting', 'status_force_limit_posting');
}
}
const robeQueueList = robeQueue.queueList();
const sys = {
  freeMB: Math.round(os.freemem()/(1024*1024)),
  totalMB: Math.round(os.totalmem()/(1024*1024)),
  cores: (os.cpus()||[]).length,
  cpuApprox: Math.min(100, Math.round(Object.values(robeMeta).reduce((acc, m) => acc + (typeof m.cpuPercent==='number' ? m.cpuPercent : 0), 0) / Math.max(1,(os.cpus()||[]).length)))
};
const statusObj = { perfis, robes, robeQueue: robeQueueList, autoMode, sys, ts: Date.now() };

// LOGS DE DIAGNÓSTICO DA RAM — somente quando estiver null/undefined
try {
  // Logs removidos para evitar poluição do terminal (ramMB null é normal para perfis inativos)
  // for (const ent of perfis) {
  //   if (!(typeof ent.ramMB === 'number')) {
  //     logger.warn('[STATUS-WRITE] ramMB é null/undefined', { nome: ent.nome, ramMB: ent.ramMB, hasRobeMeta: !!robeMeta[ent.nome] });
  //   }
  // }
} catch {}

const ok = writeJsonAtomic(statusPath, statusObj);
if (!ok) { try { await issues.append('system','persist_failed', 'status_write'); } catch {} }
} catch (e) {
try { logger.warn('[WORKER][statusWrite] erro', { error: e && e.message || e }); } catch {}
}
});
try { supervisorClient.sendTelemetria({ type: 'hb', alive: controllers.size }); } catch {}
return _statusLock;
}

async function appendIssueNurseDebounced(nome, type, message, key) {
  if (!nome) return;
  robeMeta[nome] = robeMeta[nome] || {};
  robeMeta[nome].nurseLogDebounce = robeMeta[nome].nurseLogDebounce || {};
  const k = key || type;
  const last = robeMeta[nome].nurseLogDebounce[k] || 0;
  if (Date.now() - last < 60000) return;
  robeMeta[nome].nurseLogDebounce[k] = Date.now();
  await issues.append(nome, type, message);
}

const NURSE_CFG = {
  INTERVAL_MS: 5000,
  PAGE_EVAL_TIMEOUT_MS: 5000
};

const MAX_OPEN_CONCURRENCY = 1;
let slotsInUse = 0;
const OPEN_ACTIVATION_DELAY_MS = parseInt(process.env.OPEN_ACTIVATION_DELAY_MS || '1200', 10);

const ULTRA_RECOVERY = {
  MAX_RELOADS: 2,
  RELOAD_TIMEOUT_MS: 10000,
  RELOAD_POST_WAIT_MS: 250,
  REOPEN_DELAY_SHORT_MS: 5000, // NOVO: Reduzido de 60s para 5s (reabertura quase imediata, supervisor controla velocidade)
  REOPEN_DELAY_RAMCPU_MS: 60000,
  FAIL_WINDOW_MS: 3*60*60*1000,
  FAIL_FREEZE_AFTER: 5,
  FAIL_FREEZE_MS: 2*60*60*1000,
  REOPEN_DELAY_VIRTUS_BLOCK_MS: 2*60*60*1000
};

async function ensureFrozenShutdown(nome, origin = 'frozen') {
  const ctrl = controllers.get(nome);
  if (!ctrl) return;
  try { robeQueue.skip && robeQueue.skip(nome); } catch {}
  try { await reportAction(nome, 'mil_action', 'frozen_kill'); } catch {}
  try {
    await handlers.deactivate({ nome, reason: 'frozen', policy: 'preserveDesired' });
  } catch {}
  try { stopPruneLoop(nome); } catch {}
  try {
    robeMeta[nome] = robeMeta[nome] || {};
    robeMeta[nome].reopenAt = null;
    robeMeta[nome].activationHeldUntil = robeMeta[nome].frozenUntil || (Date.now() + 3600_000);
  } catch {}
  try { await snapshotStatusAndWrite(); } catch {}
}

const INTERNAL_REASONS = new Set(['ramKill','cpuKill','manifest_missing','manifest_incomplete','panic','open_headroom']);
const EXTERNAL_REASONS = new Set(['disconnected','no_pages','zombie','network','fb_dom','messenger_temp_block','blocked']);

function classifyReason(reason, fallback) {
  if (INTERNAL_REASONS.has(reason)) return 'internal';
  if (EXTERNAL_REASONS.has(reason)) return 'external';
  return fallback || 'unknown';
}

function getFailureCounts(nome) {
  const now = Date.now();
  const rec = profileFailures.get(nome);
  if (!rec) return { internal: 0, external: 0, unknown: 0 };
  const pruned = {
    internal: (rec.internal||[]).filter(ts => (now - ts) < ULTRA_RECOVERY.FAIL_WINDOW_MS),
    external: (rec.external||[]).filter(ts => (now - ts) < ULTRA_RECOVERY.FAIL_WINDOW_MS),
    unknown: (rec.unknown||[]).filter(ts => (now - ts) < ULTRA_RECOVERY.FAIL_WINDOW_MS)
  };
  profileFailures.set(nome, pruned);
  return { internal: pruned.internal.length, external: pruned.external.length, unknown: pruned.unknown.length };
}

const profileFailures = new Map();
async function registerFailure(nome, reason, classification) {
  const now = Date.now();
  const cls = classification || classifyReason(reason, 'unknown');
  const rec = profileFailures.get(nome) || { internal: [], external: [], unknown: [] };
  rec.internal = (rec.internal||[]).filter(ts => ts > now - ULTRA_RECOVERY.FAIL_WINDOW_MS);
  rec.external = (rec.external||[]).filter(ts => ts > now - ULTRA_RECOVERY.FAIL_WINDOW_MS);
  rec.unknown  = (rec.unknown ||[]).filter(ts => ts > now - ULTRA_RECOVERY.FAIL_WINDOW_MS);
  if (cls === 'internal') rec.internal.push(now);
  else if (cls === 'external') rec.external.push(now);
  else rec.unknown.push(now);
  profileFailures.set(nome, rec);
  const counts = getFailureCounts(nome);
  try { await issues.append(nome, 'failure', `reason=${reason} class=${cls} internal=${counts.internal} external=${counts.external} unknown=${counts.unknown}`); } catch {}

  const ALLOWED_FREEZE_REASONS = new Set(['manifest_missing','manifest_incomplete']);
  if (ALLOWED_FREEZE_REASONS.has(reason)) {
    await freezeProfileFor(nome, 12*60*60*1000, reason, 'system');
    await ensureFrozenShutdown(nome, reason || 'frozen');
  }
}

async function pageReadyBasic(p0) {
  try {
    const res = await Promise.race([
      (async () => (await p0.evaluate(() => document.readyState)) || 'unknown')(),
      new Promise(res => setTimeout(() => res('timeout'), NURSE_CFG.PAGE_EVAL_TIMEOUT_MS))
    ]);
    return (res === 'interactive' || res === 'complete');
  } catch { return false; }
}

async function tryReloadShort(p0, nome, attempt) {
  try {
    if (process.env.NURSE_DEBUG === '1') {
      await reportAction(nome, 'mil_action', `nurse_reload_try #${attempt} url=${(p0 && p0.url && p0.url()) || ''} readyState=${await (async () => { try { return await p0.evaluate(()=>document.readyState); } catch { return '-'; } })()} reloadsIn60s=${robeMeta[nome]?.reloadAttemptsWindow?.length||0}`);
    }
  } catch {}
  try {
    await p0.reload({ waitUntil: 'domcontentloaded', timeout: ULTRA_RECOVERY.RELOAD_TIMEOUT_MS }).catch(()=>{});
    await new Promise(r=>setTimeout(r, ULTRA_RECOVERY.RELOAD_POST_WAIT_MS));
  } catch {}
  return await pageReadyBasic(p0);
}

function ms(h) { return h * 60 * 60 * 1000; }

async function freezeProfileFor(nome, msDuration, reason, setBy = 'system') {
  try {
    const now = Date.now();
    let applied = { until: now + msDuration, mode: 'set' };
    await manifestStore.update(nome, (man) => {
      man = man || {};
      const existingMem = (robeMeta[nome] && robeMeta[nome].frozenUntil) || 0;
      const existingDisk = (man && man.frozenUntil) || 0;
      const existing = Math.max(existingMem, existingDisk, 0);
      let until = now + msDuration;
      let mode = 'set';
      if (existing > now) {
        until = existing + msDuration;
        mode = 'extended';
      }
      applied.until = until;
      applied.mode = mode;

      man.frozenUntil = until;
      man.frozenReason = String(reason || '');
      man.frozenAt = man.frozenAt || now;
      man.frozenSetBy = setBy || 'system';
      return man;
    });

    robeMeta[nome] = robeMeta[nome] || {};
    robeMeta[nome].frozenUntil = applied.until;
    robeMeta[nome].frozenReason = String(reason || '');
    robeMeta[nome].frozenAt = robeMeta[nome].frozenAt || now;
    robeMeta[nome].frozenSetBy = setBy || 'system';

    try {
      await issues.append(
        nome,
        setBy && String(setBy).startsWith('admin') ? 'admin_action' : 'mil_action',
        `frozen_${Math.round(msDuration/60000)}min(${applied.mode}): reason=${reason||''} setBy=${setBy} until=${new Date(applied.until).toISOString()}`
      );
    } catch {}

    await ensureFrozenShutdown(nome, reason || 'frozen');
    await snapshotStatusAndWrite();
  } catch {}
}

async function unfreezeProfile(nome, setBy = 'admin') {
  try {
    const now = Date.now();

    robeMeta[nome] = robeMeta[nome] || {};
    delete robeMeta[nome].frozenUntil;
    delete robeMeta[nome].frozenReason;
    delete robeMeta[nome].frozenAt;
    delete robeMeta[nome].frozenSetBy;
    robeMeta[nome].activationHeldUntil = now + 60*1000;
    robeMeta[nome].reloadAttemptsWindow = [];
    robeMeta[nome].unfreezeCount = (robeMeta[nome].unfreezeCount || 0) + 1;
    robeMeta[nome].lastUnfreezeAt = now;
    robeMeta[nome].reopenAt = null;

    await manifestStore.update(nome, (man) => {
      man = man || {};
      if ('frozenUntil' in man) delete man.frozenUntil;
      if ('frozenReason' in man) delete man.frozenReason;
      if ('frozenAt' in man) delete man.frozenAt;
      if ('frozenSetBy' in man) delete man.frozenSetBy;
      return man;
    });

    profileFailures.set(nome, { internal: [], external: [], unknown: [] });

    try {
      await issues.append(
        nome,
        setBy && String(setBy).startsWith('admin') ? 'admin_action' : 'mil_action',
        `unfreeze by=${setBy}`
      );
    } catch {}

    await snapshotStatusAndWrite();
  } catch {}
}

async function detectMessengerTempBlock(page) {
  try {
    const url = page.url ? page.url() : '';
    if (!/messenger.com/i.test(url)) return { blocked: false };
    return await page.evaluate(() => {
      const norm = s => (s || '').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase();
      const texts = Array.from(document.querySelectorAll('h1,h2,span,div'))
        .slice(0, 300)
        .map(el => norm(el.innerText || el.content || el.textContent || ''))
        .filter(Boolean);

      const hasBlocked =
        texts.some(t =>
          t.includes('voce esta bloqueado temporariamente') ||
          t.includes('você está bloqueado temporariamente') ||
          t.includes('youre temporarily blocked') ||
          t.includes('you’re temporarily blocked') ||
          t.includes('temporarily blocked')
        );
      const hasReloadBtn =
        !!document.querySelector('[aria-label*="Recarregar pagina"],[aria-label*="Recarregar página"],[aria-label*="Reload"]');
      return { blocked: hasBlocked, hasReloadBtn };
    });
  } catch { return { blocked: false }; }
}

let _nurseTickRunning = false;

async function nurseTick() {
  if (_nurseTickRunning) return;
  _nurseTickRunning = true;
  if (controllers.size === 0) { _nurseTickRunning = false; return; }
  try {
    const now = Date.now();
    const desired = readJsonFile(desiredPath, { perfis: {} });
    for (const nome of Object.keys(desired.perfis || {})) {
      if (SHARD_SET.size && !inShard(nome)) {
        if (process.env.NURSE_DEBUG === '1') {
          try { logger.info(`[NURSE][SKIP_OTHER_SHARD] ${nome}`); } catch {}
        }
        continue;
      }
      const want = desired.perfis[nome] || {};
      const ctrl = controllers.get(nome);

      if (want.humanHold === true) {
        await appendIssueNurseDebounced(nome, 'mil_action', 'nurse_skip_human_hold', 'nurse_skip_human_hold');
        continue;
      }

      {
        const rm = robeMeta[nome] || {};
        if (rm.emExecucao === true) {
          await appendIssueNurseDebounced(nome, 'mil_action', 'nurse_skip_robe_running', 'nurse_skip_robe_running');
          continue;
        }
      }

      if (ctrl && (ctrl.humanControl === true || ctrl.configurando === true)) {
        continue;
      }
      if (ctrl && ctrl.browser && ctrl.browser._sendLock && ctrl.browser._sendLock.active) {
        await appendIssueNurseDebounced(nome, 'mil_action', 'send_lock_skip', 'send_lock_skip');
        continue;
      }

      if (isFrozenNow(nome)) {
        if (ctrl) { await ensureFrozenShutdown(nome, 'nurse_guard'); }
        continue;
      }

      const hs = getHealth && getHealth(nome);
      if (hs && ['recover1','recover2','recover3'].includes(hs.stage)) {
        await appendIssueNurseDebounced(nome, 'mil_action', 'health_recovery_in_progress_skip', 'health_recovery_in_progress_skip');
        continue;
      }

      if (want.active === true && !ctrl) {
        if (isFrozenNow(nome)) continue;

        if (robeMeta[nome]?.activationHeldUntil && robeMeta[nome].activationHeldUntil > Date.now()) continue;
        if (robeMeta[nome]?.reopenAt && robeMeta[nome].reopenAt > Date.now()) continue;

        if (slotsInUse >= MAX_OPEN_CONCURRENCY) continue;
        slotsInUse++;
        try {
          await reportAction(nome, 'nurse_restart', 'desired ativo porém controller ausente — tentando ativar');
          try {
            const r = await activateOnce(nome, 'nurse_auto');
            if (!r || !r.ok) {
              const err = (r && r.error) || '';
              if (/ram_insuficiente_para_ativar|supervisor_denied:ram_low|supervisor_denied:slots|headroom_below_min_after_open/.test(err)) {
                await issues.append(nome, 'mil_action', 'open_denied_ram_swap_attempt err='+err);

                const swapped = await trySwapOpen(nome);

                if (!swapped) {
                  robeMeta[nome] = robeMeta[nome] || {};
                  // NOVO: Backoff fixo de 3s ao invés de escalonado (supervisor já controla velocidade)
                  const curBackoff = 3000;
                  robeMeta[nome].openBackoffMs = curBackoff;
                  robeMeta[nome].activationHeldUntil = Date.now() + curBackoff;
                  await issues.append(nome, 'mil_action', `open_backoff set to ${Math.floor(curBackoff/1000)}s (fixed)`);
                  logger.warn('[SWAP] open_backoff set', { nome, backoffMs: curBackoff, reason: err });
                } else {
                  logger.info('[SWAP] swap_open_success (nurse)', { target: nome });
                }
              }
            } else {
              // NOVO: Backoff fixo de 3s ao invés de 15s
              if (robeMeta[nome]) robeMeta[nome].openBackoffMs = 3000;
              logger.info('[NURSE] activateOnce ok', { nome });
            }
          } catch { }
        } finally {
          slotsInUse--;
        }
        await new Promise(r => setTimeout(r, OPEN_ACTIVATION_DELAY_MS));
        continue;
      }

      if (!ctrl || !ctrl.browser) continue;
      let pages = [];
      try { pages = await ctrl.browser.pages().catch(()=>[]); } catch {}

      robeMeta[nome] = robeMeta[nome] || {};
      robeMeta[nome].noPagesStrikes = robeMeta[nome].noPagesStrikes || 0;
      robeMeta[nome].lastNoPagesAt = robeMeta[nome].lastNoPagesAt || 0;

      if (!pages || !pages[0]) {
        let retryFailed = false;
        if (ctrl.browser.isConnected?.()) {
          await new Promise(r=>setTimeout(r,400));
          let retryPages = [];
          try { retryPages = await ctrl.browser.pages(); } catch {}
          if (!retryPages || !retryPages[0]) retryFailed = true;
        } else {
          retryFailed = true;
        }
        if (retryFailed) {
          robeMeta[nome].noPagesStrikes += 1;
          robeMeta[nome].lastNoPagesAt = Date.now();
          await appendIssueNurseDebounced(nome, `suspect_no_pages`, `strike=${robeMeta[nome].noPagesStrikes}`, 'suspect_no_pages');
          if (robeMeta[nome].noPagesStrikes >= 2 && (Date.now() - robeMeta[nome].lastNoPagesAt) >= 5000) {
            if (killGuardActive(nome)) {
              await appendIssueNurseDebounced(nome, 'guard_skip', 'Ação suprimida por kill_guard_until');
              continue;
            }
            // PATCH P1 START (anti-flap deactivate)
            const now = Date.now();
            robeMeta[nome] = robeMeta[nome] || {};
            if (robeMeta[nome].lastDeactivateAt && (now - robeMeta[nome].lastDeactivateAt) < 10000) {
              await appendIssueNurseDebounced(nome, 'mil_action', 'deactivate_backoff_skip', 'deactivate_backoff_skip');
              continue;
            }
            robeMeta[nome].lastDeactivateAt = now;
            // PATCH P1 END
            await appendIssueNurseDebounced(nome, `action_nurse_kill_nopages`, `Strikes=${robeMeta[nome].noPagesStrikes}`, 'action_nurse_kill_nopages');
            await registerFailure(nome, 'no_pages', 'external');
            await handlers.deactivate({ nome, reason: 'nurse_zombie', policy: 'preserveDesired' });
            setKillGuard(nome);
            robeMeta[nome].noPagesStrikes = 0;
            continue;
          }
          continue;
        }
      } else {
        robeMeta[nome].noPagesStrikes = 0;
      }

      const p0 = pages[0];
      try {
        const lr = await browserHelper.detectLoginRequired(p0);
        if (lr && lr.loginRequired) {
          await setLoginRequiredFlag(nome, { reason: lr.reason || '', source: lr.domain || '' });
        }
      } catch {}
      try {
        const bd = await browserHelper.detectAccountSuspended(p0);
        if (bd && bd.banned) {
          await setBannedFlag(nome, { reason: bd.reason || '', snippet: bd.snippet || '' });
        }
      } catch {}
      let det = { blocked:false };
      try {
        const urlNow = (typeof p0.url === 'function') ? (p0.url() || '') : '';
        const isMessenger = /messenger.com/i.test(urlNow);
        const robeRunning = !!(robeMeta[nome] && robeMeta[nome].emExecucao === true);
        const isCreateOrSellerRoute =
          /facebook\.com\/marketplace\/(?:create|you\/selling|sell|listing|inventory|commerce_manager)/i.test(urlNow);

        if (isMessenger) {
          det = await browserHelper.detectMessengerTempBlock(p0);
          det.domain = 'messenger';
        } else if (robeRunning || isCreateOrSellerRoute) {
          const deep = await detectLimitOverlayDeep(p0, { alsoCheckFrames: true }).catch(()=>null);
          if (deep && deep.blocked) {
            det = { blocked: true, domain: 'facebook' };
          } else {
            det = await browserHelper.detectMessengerTempBlock(p0);
            det.domain = det.domain || 'facebook';
          }
        }
      } catch {}

      robeMeta[nome] = robeMeta[nome] || {};
      robeMeta[nome].blockDetectWindow = robeMeta[nome].blockDetectWindow || [];
      let now2 = Date.now();

      if (det && det.blocked && det.domain === 'messenger') {
        robeMeta[nome].blockDetectWindow.push(now2);
        robeMeta[nome].blockDetectWindow = robeMeta[nome].blockDetectWindow.filter(ts => now2 - ts <= 5000);
        while (robeMeta[nome].blockDetectWindow.length > 8) robeMeta[nome].blockDetectWindow.shift();

        if (robeMeta[nome].blockDetectWindow.length >= 2 && (!robeMeta[nome].blockHysteresisUntil || robeMeta[nome].blockHysteresisUntil < now2)) {
          await appendIssueNurseDebounced(nome, `action_virtus_block`, `blockDetectWindow=${robeMeta[nome].blockDetectWindow.length}`, 'action_virtus_block');
          robeMeta[nome].blockHysteresisUntil = now2 + 15*60*1000;
          if (killGuardActive(nome)) {
            await appendIssueNurseDebounced(nome, 'guard_skip', 'Ação suprimida por kill_guard_until (block)', 'guard_skip_block');
            continue;
          }
          await stopVirtus(nome);
          if (!(robeMeta[nome].reopenAt && robeMeta[nome].reopenAt > now2)) {
            robeMeta[nome].reopenAt = now2 + ULTRA_RECOVERY.REOPEN_DELAY_VIRTUS_BLOCK_MS + Math.floor(Math.random() * 21 + 5) * 60 * 1000;
            robeMeta[nome].closingReason = 'virtus_block';
          }
          await registerFailure(nome, 'messenger_temp_block', 'external');
          await handlers.deactivate({ nome, reason: 'virtus_block', policy: 'preserveDesired' });
          setKillGuard(nome);
          await snapshotStatusAndWrite();
          continue;
        } else {
          await appendIssueNurseDebounced(nome, `suspect_messenger_block`, `strike=${robeMeta[nome].blockDetectWindow.length}`, 'suspect_messenger_block');
          continue;
        }
      }
      if (robeMeta[nome].blockHysteresisUntil && robeMeta[nome].blockHysteresisUntil > now2) continue;

      if (det && det.blocked && det.domain === 'facebook') {
        try { await issues.append(nome, 'block_detected', `domain=${det.domain}`); } catch {}
        const nowf = Date.now();
        const plus24 = 24 * 60 * 60 * 1000;
        try {
          const man = await manifestStore.read(nome).catch(()=>null);
          const curLeft = man && man.robeCooldownUntil ? (man.robeCooldownUntil - nowf) : 0;
          if (!man || curLeft < 80*60*1000) {
            await manifestStore.update(nome, m => {
              m = m || {};
              m.robeCooldownUntil = nowf + plus24;
              m.robeCooldownRemainingMs = 0;
              return m;
            });
          }
        } catch {}
        const man = await manifestStore.read(nome).catch(()=>null);
        if (man && man.robePauseReason === 'limit_posting' && (man.robeCooldownUntil||0) > Date.now()) {
          await issues.append(nome, 'mil_action', 'preserve_limit_posting_on_fb_block');
          await appendIssueNurseDebounced(nome, 'mil_action', 'status_force_limit_posting', 'status_force_limit_posting');
          await snapshotStatusAndWrite();
          continue;
        }
        robeMeta[nome] = robeMeta[nome] || {};
        robeMeta[nome].pauseReason = 'fb_block';
        robeMeta[nome].lastRobeBlockAt = Date.now();
        await snapshotStatusAndWrite();
        continue;
      }

      let anyFbBlocked = false;
      try {
        if (robeMeta[nome] && robeMeta[nome].emExecucao === true && ctrl && ctrl.browser) {
          anyFbBlocked = await detectFbLimitInAnyPage(ctrl);
        }
      } catch {}
      if (anyFbBlocked) {
        try { await issues.append(nome, 'block_detected', 'domain=facebook multi-page=true'); } catch {}
        const nowf = Date.now();
        const plus24 = 24 * 60 * 60 * 1000;
        try {
          const man = await manifestStore.read(nome).catch(()=>null);
          const curLeft = man && man.robeCooldownUntil ? (man.robeCooldownUntil - nowf) : 0;
          if (!man || curLeft < 80*60*1000) {
            await manifestStore.update(nome, m => {
              m = m || {};
              m.robeCooldownUntil = nowf + plus24;
              m.robeCooldownRemainingMs = 0;
              return m;
            });
          }
        } catch {}
        const man = await manifestStore.read(nome).catch(()=>null);
        if (man && man.robePauseReason === 'limit_posting' && (man.robeCooldownUntil||0) > Date.now()) {
          await issues.append(nome, 'mil_action', 'preserve_limit_posting_on_fb_block');
          await appendIssueNurseDebounced(nome, 'mil_action', 'status_force_limit_posting', 'status_force_limit_posting');
          await snapshotStatusAndWrite();
          continue;
        }
        robeMeta[nome] = robeMeta[nome] || {};
        robeMeta[nome].pauseReason = 'fb_block';
        robeMeta[nome].lastRobeBlockAt = Date.now();
        await snapshotStatusAndWrite();
        continue;
      }

      const hs2 = getHealth && getHealth(nome);
      if (hs2 && (hs2.stage === 'recover1' || hs2.stage === 'recover2' || hs2.stage === 'recover3')) {
        continue;
      }

      let healthy = await pageReadyBasic(p0);
      if (!healthy) {
        if (robeMeta[nome].recoveryHysteresisUntil && robeMeta[nome].recoveryHysteresisUntil > Date.now()) {
          await appendIssueNurseDebounced(nome, 'hysteresis_skip', 'Aguardando histerese pós-recover', 'hysteresis_skip_after_recover');
          continue;
        }

        robeMeta[nome] = robeMeta[nome] || {};
        const nowReload = Date.now();
        if (!robeMeta[nome].reloadAttemptsWindow) robeMeta[nome].reloadAttemptsWindow = [];
        robeMeta[nome].reloadAttemptsWindow = robeMeta[nome].reloadAttemptsWindow.filter(ts => nowReload - ts < 60000);

        robeMeta[nome].reloadAttemptsWindow.push(nowReload);
        while (robeMeta[nome].reloadAttemptsWindow.length > 8) robeMeta[nome].reloadAttemptsWindow.shift();

        if (robeMeta[nome].reloadAttemptsWindow.length > 3) {
          robeMeta[nome].reloadBlockedUntil = nowReload+60000;
          await reportAction(nome, 'mil_action', 
            `nurse_reload_blocked: Excesso de reloads (${robeMeta[nome].reloadAttemptsWindow.length}) em 60s, url=${((p0.url&&p0.url())||'')}`
          );
          continue;
        }
        if (robeMeta[nome].reloadBlockedUntil && robeMeta[nome].reloadBlockedUntil > nowReload) {
          continue;
        }

        healthy = await tryReloadShort(p0, nome, 1);
        if (!healthy) {
          healthy = await tryReloadShort(p0, nome, 2);
        }
        if (healthy) {
          await reportAction(nome, 'mil_action', 'nurse_recover_success(reload)');
          robeMeta[nome].recoveryHysteresisUntil = Date.now() + 90000;
        } else {
          robeMeta[nome].zombieStrikes = robeMeta[nome].zombieStrikes || 0;
          robeMeta[nome].zombieStrikes += 1;
          await appendIssueNurseDebounced(nome, `suspect_page_zombie`, `strike=${robeMeta[nome].zombieStrikes}`, 'suspect_page_zombie');
          if (robeMeta[nome].zombieStrikes >= 2) {
            if (killGuardActive(nome)) {
              await appendIssueNurseDebounced(nome, 'guard_skip', 'Ação suprimida por kill_guard_until', 'guard_skip_page_zombie');
              continue;
            }
            // PATCH P1 START (anti-flap deactivate)
            const now = Date.now();
            robeMeta[nome] = robeMeta[nome] || {};
            if (robeMeta[nome].lastDeactivateAt && (now - robeMeta[nome].lastDeactivateAt) < 10000) {
              await appendIssueNurseDebounced(nome, 'mil_action', 'deactivate_backoff_skip', 'deactivate_backoff_skip');
              continue;
            }
            robeMeta[nome].lastDeactivateAt = now;
            // PATCH P1 END
            await appendIssueNurseDebounced(nome, `action_nurse_kill_page_zombie`, `Strike=${robeMeta[nome].zombieStrikes}`, 'action_nurse_kill_page_zombie');
            try { registerFailure(nome, 'zombie', 'external'); } catch {}
            await handlers.deactivate({ nome, reason: 'nurse_zombie', policy: 'preserveDesired' });
            setKillGuard(nome);
            robeMeta[nome].zombieStrikes = 0;
            continue;
          }
          continue;
        }
      } else {
        robeMeta[nome].zombieStrikes = 0;
      }

      try {
        const url = p0.url ? p0.url() : '';
        if (/messenger\.com\/.*marketplace/i.test(url) && !ctrl.configurando && !(robeMeta[nome] && robeMeta[nome].emExecucao)) {
          const ph = getPhantomState(nome);
          const snap = await evaluateChatsState(p0);
          if (isOkFromSnapshot(snap)) {
            ph.lastOkAt = Date.now(); ph.firstSeenAt = 0;
          } else {
            const now = Date.now();
            if (isPhantomFromSnapshot(snap)) {
              if (!ph.firstSeenAt) ph.firstSeenAt = now;
              const elapsed = now - ph.firstSeenAt;
              const sinceOk = ph.lastOkAt ? (now - ph.lastOkAt) : Infinity;
              if (elapsed > PHANTOM_CFG.PERSIST_MS && sinceOk > PHANTOM_CFG.INITIAL_GRACE_MS) {
                await issues.append(nome, 'mil_action',
                  `phantom_detected rows=${snap.rows} anchors=${snap.anchors} sk=${snap.skeletons} elapsed=${elapsed}ms`);
                await tryFixPhantom(nome, p0);
              }
            } else if (snap.skeletons === 0) {
              ph.firstSeenAt = 0;
            }
          }
        }
      } catch {}

      if (ctrl && ctrl.configurando) {
        logger.info('[NURSE][SKIP PRUNE] Perfil em configuração, prune ignorado', { nome });
        continue;
      }
      if (!(robeMeta[nome] && robeMeta[nome].emExecucao)) {
        try { await closeExtraPages(ctrl.browser, p0, nome).catch(()=>{}); } catch {}
      }
      if (want.virtus === 'on' && automationAllowed(ctrl)) {
        try { 
          ctrl.virtus = virtusHelper.startVirtus(ctrl.browser, nome, { restrictTab: 0, epoch: ctrl.virtusEpoch || 0 }); 
          ctrl.trabalhando = true; 
        } catch {}
      }
    }
  } finally {
    _nurseTickRunning = false;
  }
}

async function trySwapOpen(target) {
  const aliveNames = Array.from(controllers.keys());
  if (aliveNames.length <= 1) return false;

  const candidates = aliveNames
    .filter(n => n !== target)
    .map(n => ({
      n,
      mb: (typeof robeMeta[n]?.ramMB === 'number') ? robeMeta[n].ramMB : -1,
      emExecucao: robeMeta[n]?.emExecucao,
      configurando: controllers.get(n)?.configurando,
      humanControl: controllers.get(n)?.humanControl
    }))
    .filter(c => !c.configurando && !c.emExecucao && !c.humanControl && c.mb >= (process.platform==='win32' ? 900 : 700))
    .sort((a, b) => b.mb - a.mb);

  for (const cand of candidates) {
    if (killGuardActive(cand.n)) continue;
    await issues.append(cand.n, 'mil_action', `swap_kill fechamento para abrir ${target} RAM=${cand.mb}MB`);
    logger.info('[SWAP] swap_kill', { fechar: cand.n, abrir: target, ramMB: cand.mb });
    await handlers.deactivate({ nome: cand.n, reason: 'swap_for_open', policy: 'preserveDesired' });
    setKillGuard(cand.n, 45000);
    await new Promise(r=>setTimeout(r, 2000));
    
    const r = await activateOnce(target, 'nurse_swap');
    if (r && r.ok) {
      await issues.append(target, 'mil_action', `swap_open_success após fechar ${cand.n}`);
      robeMeta[target] = robeMeta[target] || {};
      robeMeta[target].lastSwapAt = Date.now();
      logger.info('[SWAP] swap_open_success', { target, fechado: cand.n });
      return true;
    }
    await issues.append(target, 'mil_action', `swap_open_failed após fechar ${cand.n}`);
    logger.warn('[SWAP] swap_open_failed', { target, fechado: cand.n });
  }
  await issues.append(target, 'mil_action', 'swap_open_failed_nenhum_sucesso');
  logger.warn('[SWAP] swap_open_failed_nenhum_sucesso', { target });
  return false;
}

setInterval(() => { nurseTick().catch(()=>{}); }, NURSE_CFG.INTERVAL_MS);
setTimeout(() => { nurseTick().catch(()=>{}); }, 2000);

// Inicializa reloadManager após todos os sistemas estarem prontos
reloadManager.startReloadManager(controllers, robeMeta);

async function wirePageObservers(nome, page) {
  const st = getHealth(nome);
  try {
    page.removeAllListeners && page.removeAllListeners('domcontentloaded');
    page.removeAllListeners && page.removeAllListeners('framenavigated');
    page.removeAllListeners && page.removeAllListeners('requestfinished');
    page.removeAllListeners && page.removeAllListeners('requestfailed');
    page.removeAllListeners && page.removeAllListeners('console');
    page.removeAllListeners && page.removeAllListeners('pageerror');
  } catch {}
  page.on('domcontentloaded', async () => {
    const st = getHealth(nome);
    st.lastDomEventAt = Date.now();
    try { st.lastTitle = await page.title().catch(()=>st.lastTitle); } catch {}
    try { st.lastUrl = page.url ? page.url() : st.lastUrl; } catch {}
  });
  page.on('framenavigated', (frame) => {
    const st = getHealth(nome);
    if (frame === page.mainFrame()) {
      st.lastDomEventAt = Date.now();
      try { st.lastUrl = page.url ? page.url() : st.lastUrl; } catch {}
    }
  });
  page.on('requestfinished', () => { getHealth(nome).lastNetEventAt = Date.now(); });
  page.on('requestfailed', () => { getHealth(nome).lastNetEventAt = Date.now(); });
  page.on('console', (msg) => { if (msg && msg.type && msg.type() === 'error') getHealth(nome).lastConsoleErrorAt = Date.now(); });
  page.on('pageerror', () => { getHealth(nome).lastConsoleErrorAt = Date.now(); });
}

async function isPageLikelyAlive(page, nome) {
  const st = getHealth(nome);
  const now = Date.now();
  const noDom = (now - st.lastDomEventAt) > HEALTH_CFG.DEAD_NO_DOM_MS;
  const noNet = (now - st.lastNetEventAt) > HEALTH_CFG.DEAD_NO_NET_MS;
  let readyOk = false, url = '';
  try {
    const rs = await Promise.race([
      page.evaluate(()=>document.readyState).catch(()=> 'err'),
      new Promise(res=>setTimeout(()=>res('timeout'), 1200))
    ]);
    readyOk = (rs === 'interactive' || rs === 'complete');
    url = page.url ? page.url() : '';
  } catch {}
  const aboutBlankStuck = (url === 'about:blank') && ((now - st.lastDomEventAt) > HEALTH_CFG.ABOUT_BLANK_GRACE_MS);
  const urlIsFb = /facebook\.com|messenger\.com/i.test(url);
  const aliveBySignals = (!noDom || !noNet);
  const aliveByReady = (readyOk && urlIsFb && !aboutBlankStuck);
  return aliveBySignals || aliveByReady;
}

async function recoveryStep(nome, page, step) {
  // BLOQUEIO: não recuperar se Virtus ativo e na URL de chat
  try {
    const urlNow = page && typeof page.url === 'function' ? (page.url() || '') : '';
    const ctrl = controllers.get(nome);
    const virtusOn = !!(ctrl && ctrl.trabalhando && !ctrl.humanControl && !ctrl.configurando);
    if (/messenger\.com\/marketplace\/t\/\d+/.test(urlNow) && virtusOn) {
      try { await issues.append(nome, 'mil_action', 'health_recovery_skip_on_chat'); } catch {}
      logger.warn('[NURSE_RECOVER_SKIP] Em chat ativo da Virtus — NUNCA reload/goto para recuperar', { nome, urlNow });
      return false;
    }
  } catch {}
  
  const st = getHealth(nome);
  const now = Date.now();
  if (st.nextTryAt && st.nextTryAt > now) return false;
  if (step === 'reload') {
    st.counters.softReloads10m = _pruneWindow(st.counters.softReloads10m, 10*60*1000);
    if (st.counters.softReloads10m.length >= HEALTH_CFG.MAX_SOFT_RELOADS_10MIN) return false;
    try { await page.reload({ waitUntil: 'domcontentloaded', timeout: 15000 }).catch(()=>{}); } catch {}
    st.counters.softReloads10m.push(Date.now());
    st.nextTryAt = now + HEALTH_CFG.RECOVERY_COOLDOWN_MS.reload;
    try { await issues.append(nome, 'mil_action', 'health_recover:reload'); } catch {}
    return true;
  }
  if (step === 'navHome') {
    st.counters.navHomes10m = _pruneWindow(st.counters.navHomes10m, 10*60*1000);
    if (st.counters.navHomes10m.length >= HEALTH_CFG.MAX_NAVHOME_10MIN) return false;
    try { await page.goto('https://www.messenger.com/marketplace', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(()=>{}); } catch {}
    st.counters.navHomes10m.push(Date.now());
    st.nextTryAt = now + HEALTH_CFG.RECOVERY_COOLDOWN_MS.navHome;
    try { await issues.append(nome, 'mil_action', 'health_recover:navHome'); } catch {}
    return true;
  }
  if (step === 'newPage') {
    if (st.newPageInFlight) return false;
    if (st.lastNewPageAt && (now - st.lastNewPageAt) < 90000) return false;
    st.counters.newPages30m = _pruneWindow(st.counters.newPages30m, 30*60*1000);
    if (st.counters.newPages30m.length >= HEALTH_CFG.MAX_NEWPAGE_30MIN) return false;
    st.newPageInFlight = true;
    try {
      const ctrl = controllers.get(nome);
      if (!ctrl || !ctrl.browser) return false;
      const np = await ctrl.browser.newPage();
      try {
        const man = await manifestStore.read(nome).catch(() => null);
        await browserHelper.patchPage(nome, np, utils.getCoords((man && man.cidade) || ''));
      } catch {}
      await np.goto('https://www.messenger.com/marketplace', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(()=>{});
      try { await ctrl.mainPage.close({ runBeforeUnload: false }).catch(()=>{}); } catch {}
      ctrl.mainPage = np;
      await wirePageObservers(nome, np);
      st.counters.newPages30m.push(Date.now());
      st.nextTryAt = now + HEALTH_CFG.RECOVERY_COOLDOWN_MS.newPage;
      st.lastNewPageAt = now;
      try { await issues.append(nome, 'mil_action', 'health_recover:newPage'); } catch {}
      return true;
    } finally {
      st.newPageInFlight = false;
    }
  }
  return false;
}
async function escalateToReopen(nome, reason='health_reopen') {
  const ctrl = controllers.get(nome);
  try { await issues.append(nome, 'mil_action', `health_escalate:${reason}`); } catch {}
  if (killGuardActive(nome)) {
    await issues.append(nome, 'guard_skip', 'Ação suprimida por kill_guard_until');
    return;
  }
  await handlers.deactivate({ nome, reason, policy: 'preserveDesired' });
  setKillGuard(nome);
  const st = getHealth(nome);
  st.stage = 'reopen';
  st.nextTryAt = Date.now() + 60000;
}

async function healthTick() {
  if (controllers.size === 0) { return; }
  for (const [nome, ctrl] of controllers) {
    if (robeMeta[nome] && robeMeta[nome].emExecucao === true) continue;
    if (ctrl && (ctrl.humanControl === true || ctrl.configurando === true)) continue;

    if (!ctrl || !ctrl.browser) continue;
    if (ctrl && ctrl.browser && ctrl.browser._sendLock && ctrl.browser._sendLock.active) {
      continue;
    }
    const st = getHealth(nome);
    const now = Date.now();
    let pages = [];
    try { pages = await ctrl.browser.pages(); } catch {}
    if (!pages || !pages[0]) continue;
    const page = pages[0];
    if (page && ctrl.mainPage !== page) {
      ctrl.mainPage = page;
      await wirePageObservers(nome, page);
    }

    let det = { blocked:false };
    try {
      const urlNow = (typeof page.url === 'function') ? (page.url() || '') : '';
      const isMessenger = /messenger.com/i.test(urlNow);
      const robeRunning = !!(robeMeta[nome] && robeMeta[nome].emExecucao === true);
      const isCreateOrSellerRoute =
        /facebook\.com\/marketplace\/(?:create|you\/selling|sell|listing|inventory|commerce_manager)/i.test(urlNow);

      if (isMessenger) {
        det = await browserHelper.detectMessengerTempBlock(page);
        det.domain = 'messenger';
      } else if (robeRunning || isCreateOrSellerRoute) {
        det = await browserHelper.detectMessengerTempBlock(page);
        det.domain = det.domain || 'facebook';
      }
    } catch {}
    if (det && det.blocked) {
      if (det.domain === 'messenger') {
        try { await issues.append(nome, 'block_detected', `domain=${det.domain}`); } catch {}
        try { await stopVirtus(nome); } catch {}
        robeMeta[nome] = robeMeta[nome] || {};
        const jitterMs = (5 + Math.floor(Math.random() * 21)) * 60 * 1000;
        if (!(robeMeta[nome].reopenAt && robeMeta[nome].reopenAt > Date.now())) {
          robeMeta[nome].reopenAt = Date.now() + ULTRA_RECOVERY.REOPEN_DELAY_VIRTUS_BLOCK_MS + jitterMs;
          robeMeta[nome].closingReason = 'virtus_block';
        }
        try { registerFailure(nome, 'messenger_temp_block', 'external'); } catch {}
        if (killGuardActive(nome)) {
          await issues.append(nome, 'guard_skip', 'Ação suprimida por kill_guard_until (block)');
          continue;
        }
        await handlers.deactivate({ nome, reason: 'virtus_block', policy: 'preserveDesired' });
        setKillGuard(nome);
        await snapshotStatusAndWrite();
        continue;
      }
      if (det.domain === 'facebook') {
        try { await issues.append(nome, 'block_detected', `domain=${det.domain}`); } catch {}
        const now = Date.now();
        const plus24 = 24 * 60 * 60 * 1000;
        try {
          const man0 = await manifestStore.read(nome).catch(()=>null);
          const curLeft = man0 && man0.robeCooldownUntil ? (man0.robeCooldownUntil - now) : 0;
          if (!man0 || curLeft < 80*60*1000) {
            await manifestStore.update(nome, m => {
              m = m || {};
              m.robeCooldownUntil = now + plus24;
              m.robeCooldownRemainingMs = 0;
              return m;
            });
          }
        } catch {}
        const man = await manifestStore.read(nome).catch(()=>null);
        if (man && man.robePauseReason === 'limit_posting' && (man.robeCooldownUntil||0) > Date.now()) {
          await issues.append(nome, 'mil_action', 'health_detect_facebook_block_preserve_reason=limit_posting');
          await appendIssueNurseDebounced(nome, 'mil_action', 'status_force_limit_posting', 'status_force_limit_posting');
          await snapshotStatusAndWrite();
          continue;
        }
        robeMeta[nome] = robeMeta[nome] || {};
        robeMeta[nome].pauseReason = 'fb_block';
        robeMeta[nome].lastRobeBlockAt = Date.now();
        await snapshotStatusAndWrite();
        continue;
      }
    }

    if (isFrozenNow(nome)) continue;
    const alive = await isPageLikelyAlive(page, nome);
    if (alive) {
      st.lastOkAt = now;
      st.stage = 'ok';
      st.counters.cyclesWithoutLife = 0;
      continue;
    }
    const noEventsFor = Math.max(now - st.lastDomEventAt, now - st.lastNetEventAt);
    if (noEventsFor > HEALTH_CFG.DEAD_NO_EVENT_MS) {
      st.counters.cyclesWithoutLife++;
      if (st.stage === 'ok') st.stage = 'suspect';
    }
    try {
      const url = page.url ? page.url() : '';
      if (url === 'about:blank' && (now - st.lastDomEventAt) > HEALTH_CFG.ABOUT_BLANK_GRACE_MS) {
        if (await recoveryStep(nome, page, 'navHome')) continue;
      }
    } catch {}
    if (st.stage === 'suspect') {
      if (await recoveryStep(nome, page, 'reload')) { st.stage = 'recover1'; continue; }
      st.stage = 'recover1';
    } else if (st.stage === 'recover1') {
      if (await recoveryStep(nome, page, 'navHome')) { st.stage = 'recover2'; continue; }
      st.stage = 'recover2';
    } else if (st.stage === 'recover2') {
      if (await recoveryStep(nome, page, 'newPage')) { st.stage = 'recover3'; continue; }
      st.stage = 'recover3';
    } else if (st.stage === 'recover3') {
      if (st.counters.cyclesWithoutLife >= HEALTH_CFG.ESCALATE_TO_REOPEN_AFTER) {
        await escalateToReopen(nome, 'health_no_progress');
      }
    }
  }
}
setInterval(() => { healthTick().catch(()=>{}); }, HEALTH_CFG.TICK_MS);
setTimeout(() => { healthTick().catch(()=>{}); }, 2500);

// ====== LIMPEZA PERIÓDICA DE ABAS ABOUT:BLANK ÓRFÃS ======
// Varre todos os navegadores ativos e fecha abas about:blank que estão órfãs
// (criadas mas abandonadas quando Robe aborta/abandona postagem)
// Roda a cada 3 minutos - não agressivo, apenas limpa o que ficou esquecido
async function periodicAboutBlankCleanup() {
  try {
    const issues = require('./issues.js');
    const MAX_BUSCA_LOCALIZACAO_AGE_MS = 60000;
    const now = Date.now();
    let totalClosed = 0;

    for (const [nome, ctrl] of controllers.entries()) {
      try {
        if (!ctrl || !ctrl.browser || !ctrl.browser.isConnected?.()) continue;

        // BLOQUEIO: flag global ativa
        try {
          if (ctrl.browser._buscasLocalizacaoAtivas && ctrl.browser._buscasLocalizacaoAtivas.size > 0) continue;
        } catch {}

        const inRobe = (ctrl.browser._robeActiveFor === nome) || (robeMeta[nome] && robeMeta[nome].emExecucao === true);
        const sendLockActive = ctrl.browser._sendLock && ctrl.browser._sendLock.active;
        const inConfig = ctrl.configurando === true;
        const inHuman = ctrl.humanControl === true;

        if (inRobe || sendLockActive || inConfig || inHuman) continue;

        const pages = await ctrl.browser.pages().catch(() => []);
        if (!Array.isArray(pages) || pages.length <= 1) continue;

        // Se há qualquer aba marcada nesta janela, também aborta
        const hasMarked = pages.some(p => {
          try {
            if (p._buscaLocalizacao === true) {
              const age = now - (p._buscaLocalizacaoSince || 0);
              return age < MAX_BUSCA_LOCALIZACAO_AGE_MS;
            }
          } catch {}
          return false;
        });

        if (hasMarked) continue;

        const mainPage = ctrl.mainPage || pages[0];

        const hasCreateItem = pages.some(pg => {
          try { const u = pg.url ? pg.url() : ''; return /facebook\.com\/marketplace\/create\/item/i.test(u); }
          catch { return false; }
        });

        if (hasCreateItem) continue;

        let closed = 0;

        for (const p of pages) {
          try {
            if (p === mainPage) continue;
            let url = '';
            try { url = typeof p.url === 'function' ? p.url() : ''; } catch {}
            if (!url || url === 'about:blank') {
              await p.close({ runBeforeUnload: false }).catch(() => {});
              closed++;
            }
          } catch {}
        }

        if (closed > 0) {
          totalClosed += closed;
          try { await issues.append(nome, 'mil_action', `periodic_cleanup_aboutblank n=${closed}`); } catch {}
        }
      } catch (e) {
        if (process.env.PRUNE_DEBUG === '1') {
          logger.warn('[PERIODIC_CLEANUP] Erro em perfil', { nome, error: e && e.message || e });
        }
      }
    }

    if (totalClosed > 0) {
      logger.info('[PERIODIC_CLEANUP] Fechou abas about:blank órfãs', { total: totalClosed });
    }
  } catch (e) {
    if (process.env.PRUNE_DEBUG === '1') {
      logger.warn('[PERIODIC_CLEANUP] Erro geral', { error: e && e.message || e });
    }
  }
}

// Roda a cada 3 minutos (180000ms) - não agressivo, apenas limpa o que ficou esquecido
setInterval(() => { periodicAboutBlankCleanup().catch(() => {}); }, 3 * 60 * 1000);
// Primeira execução após 30 segundos (dá tempo para sistema inicializar)
setTimeout(() => { periodicAboutBlankCleanup().catch(() => {}); }, 30000);

setInterval(() => {
  const now = Date.now();
  for (const nome of Object.keys(robeMeta)) {
    if (robeMeta[nome]?.frozenUntil && robeMeta[nome].frozenUntil > now && (robeMeta[nome].frozenUntil - now > 6 * 3600 * 1000)) {
      issues.append(nome, 'frozen_watchdog', 'Perfil congelado > 6h');
    }
    const desired = readJsonFile(desiredPath, { perfis: {} });
    if (desired.perfis?.[nome]?.active === true && !controllers.has(nome)) {
      issues.append(nome, 'stuck_activation', 'Desired ativo sem browser por >10min');
    }
  }
}, 10 * 60 * 1000);

let _shuttingDown = false;
async function gracefulShutdown(reason) {
  if (_shuttingDown) return;
  _shuttingDown = true;
  try {
    logger.info('[WORKER] gracefulShutdown start', { reason });
    try { robeQueue.clear(); } catch {}
    for (const [nome, ctrl] of controllers) {
      try {
        if (ctrl && ctrl.virtus && typeof ctrl.virtus.stop === 'function') {
          await ctrl.virtus.stop().catch(()=>{});
        }
      } catch {}
    }
    for (const [nome, ctrl] of controllers) {
      try {
        if (ctrl && ctrl.browser && typeof ctrl.browser.close === 'function') {
          await ctrl.browser.close().catch(()=>{});
        }
      } catch {}
    }
    for (const nome of _pruners.keys()) stopPruneLoop(nome);
    if (ramMonitorInterval) try { clearTimeout(ramMonitorInterval); } catch{}
  } catch (e) {
    try { logger.error('[WORKER] gracefulShutdown exception', { reason, error: e && e.message || e }, e); } catch {}
  } finally {
    setTimeout(() => process.exit(0), 500);
  }
}
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT',  () => gracefulShutdown('SIGINT'));
process.on('disconnect', () => gracefulShutdown('disconnect'));

process.on('message', async (msg) => {
  if (!msg || !msg.type || !msg.msgId) return;
  const fn = handlers[msg.type];
  if (typeof fn !== 'function') {
    logger.warn('Comando desconhecido recebido', { type: msg.type, hasMsgId: !!msg.msgId });
    sendReply(msg.msgId, { ok: false, error: 'Comando desconhecido' });
    return;
  }
  try {
    const resp = await fn(msg.payload || {});
    sendReply(msg.msgId, resp);
  } catch (e) {
    logger.error('[WORKER][MESSAGE] handler error', { type: msg.type, error: e && e.message || e }, e);
    sendReply(msg.msgId, { ok: false, error: e && e.message || String(e) });
  }
});

process.on('uncaughtException', (e) => {
  try { logger.error('uncaught', { error: e && e.message || e }, e); } catch {}
}
);
process.on('unhandledRejection', (e) => {
  try { logger.error('unhandled', { error: (e && e.message) || e }, e); } catch {}
});