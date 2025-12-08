// scripts/virtusAtendimento.js

'use strict';

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

const chatLock = require('./chatLock.js');
const stepLog = require('./stepLog.js');
const logger = require('./logger.js');
const { masterExtractAnswer } = require('./inteligenciaArtificial.js');
const dom = require('./virtusDom.js'); // garantirMarketplace, clickChatInFeed, ensureConversationReady, scrapeChatHistory, waitForComposer, sendMessageSafe
const commitClient = require('./commitClient.js');

function now(){ return Date.now(); }
function jsonReadSafe(file, fb){ try { return JSON.parse(fs.readFileSync(file,'utf8')); } catch { return fb; } }
async function jsonWriteAtomic(file, obj){
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  const fd = await fsp.open(tmp, 'w');
  try {
    await fd.writeFile(JSON.stringify(obj, null, 2), 'utf8');
    await fd.sync();
  } finally { await fd.close(); }
  try { await fsp.unlink(file); } catch {}
  try { await fsp.rename(tmp, file); }
  catch { await fsp.copyFile(tmp, file); try { await fsp.unlink(tmp);} catch {} }
}

class VirtusOrchestrator {
  constructor(browser, perfil, {
    collectDelayMs = 45000,                 // 45s timer por chat novo
    collectWindowMs = 10*60*1000,           // 10min janela coleta pós-whatsapp
    globalTimeoutMs = 60*60*1000,           // 60min timeout global do ciclo
    minSendDelayMs = 30000,                 // 30s delay min entre envios
    maxSendDelayMs = 90000,                 // 90s delay max entre envios
    noRepeat72hMs = 72*3600*1000,           // 72h blindagem anti-eco
    commitClient = null
  } = {}) {
    this.browser = browser;
    this.perfil = perfil;
    this.collectDelayMs = collectDelayMs;
    this.collectWindowMs = collectWindowMs;
    this.globalTimeoutMs = globalTimeoutMs;
    this.minSendDelayMs = minSendDelayMs;
    this.maxSendDelayMs = maxSendDelayMs;
    this.noRepeat72hMs = noRepeat72hMs;
    this.commitClient = commitClient || { async commitPedido(){ return { ok: true }; } };

    this.baseDir = path.join(__dirname, '..', 'dados', 'perfis', perfil, 'atendimento');
    this.stateFile = path.join(this.baseDir, 'atend_state.json');
    this.queueFile = path.join(this.baseDir, 'atend_queue.json');
    this.noRepeatFile = path.join(this.baseDir, 'respondidos72h.json');

    this.state = { chats: {} };             // chatId -> state
    this.sendQueue = [];                    // persistida
    this.respondidos72h = {};               // persistida

    this.timers = new Map();                // chatId -> { coleta, janela, global }
    this.sendWorkerActive = false;
    this.running = false;
  }

  async start() {
    await this._load();
    this.running = true;
    // recovery: rearm timers existentes conforme deadlines
    await this._recoverTimers();
    // restart send worker
    this._processSendQueue().catch(()=>{});
    stepLog.appendJSONL(this.perfil, 'virtus', { step: 'orchestrator_start' });
  }

  async stop() {
    this.running = false;
    // limpa timers
    for (const t of this.timers.values()) {
      try { if (t.coleta) clearTimeout(t.coleta);} catch {}
      try { if (t.janela) clearTimeout(t.janela);} catch {}
      try { if (t.global) clearTimeout(t.global);} catch {}
    }
    this.timers.clear();
    stepLog.appendJSONL(this.perfil, 'virtus', { step: 'orchestrator_stop' });
  }

  // Persistência
  async _load() {
    this.state = jsonReadSafe(this.stateFile, { chats: {} }) || { chats: {} };
    this.sendQueue = jsonReadSafe(this.queueFile, []) || [];
    this.respondidos72h = jsonReadSafe(this.noRepeatFile, {}) || {};
  }
  async _saveState() { await jsonWriteAtomic(this.stateFile, this.state); }
  async _saveQueue() { await jsonWriteAtomic(this.queueFile, this.sendQueue); }
  async _saveNoRepeat() { await jsonWriteAtomic(this.noRepeatFile, this.respondidos72h); }

  // Adicionado por watchers da UI
  async onNewChatDetected(chatId, tsLabel = null) {
    if (!this.running) return;
    if (!chatId) return;
    // 72h guard
    const tsPrev = this.respondidos72h[chatId] || 0;
    if (tsPrev && (now() - tsPrev) < this.noRepeat72hMs) {
      stepLog.appendJSONL(this.perfil, 'virtus', { step: 'blocked_72h', chatId });
      return;
    }
    const st = this.state.chats[chatId];
    if (!st) {
      // cria estado base
      this.state.chats[chatId] = {
        estado: 'novo',
        tsCriacao: now(),
        tsUltimaMsg: now(),
        tsTimeoutGlobal: now() + this.globalTimeoutMs,
        janelaColetaAte: null,
        mensagens: [],
        attemptId: null,
        retries: 0,
        pendingCommit: false,
        final: null,
        bloqueadoAte: 0
      };
      await this._saveState();
      this._armColetaTimer(chatId, this.collectDelayMs);
      this._armGlobalTimer(chatId);
      stepLog.appendJSONL(this.perfil, 'virtus', { step: 'add_chat', chatId, collectInMs: this.collectDelayMs });
    } else {
      // refresh last seen
      st.tsUltimaMsg = now();
      await this._saveState();
    }
  }

  _armColetaTimer(chatId, delayMs) {
    const rec = this._ensureTimers(chatId);
    if (rec.coleta) clearTimeout(rec.coleta);
    rec.coleta = setTimeout(() => this._doColeta(chatId).catch(()=>{}), Math.max(0, delayMs));
  }

  _armJanelaTimer(chatId, delayMs) {
    const rec = this._ensureTimers(chatId);
    if (rec.janela) clearTimeout(rec.janela);
    rec.janela = setTimeout(() => this._finalizeWindow(chatId).catch(()=>{}), Math.max(0, delayMs));
  }

  _armGlobalTimer(chatId) {
    const st = this.state.chats[chatId];
    if (!st) return;
    const msLeft = (st.tsTimeoutGlobal || now()) - now();
    const rec = this._ensureTimers(chatId);
    if (rec.global) clearTimeout(rec.global);
    rec.global = setTimeout(() => this._finalizeGlobal(chatId).catch(()=>{}), Math.max(0, msLeft));
  }

  _ensureTimers(chatId) {
    let rec = this.timers.get(chatId);
    if (!rec) { rec = { coleta:null, janela:null, global:null }; this.timers.set(chatId, rec); }
    return rec;
  }

  async _doColeta(chatId) {
    if (!this.running) return;
    const st = this.state.chats[chatId];
    if (!st) return;
    if (st.estado === 'finalizado') return;
    st.estado = 'coletando';
    st.attemptId = stepLog.attemptId();
    await this._saveState();
    stepLog.appendJSONL(this.perfil, 'virtus', { step: 'coleta_begin', chatId, attempt: st.attemptId });

    // garantir marketplace, abrir chat, scrape histórico
    const p = await this._ensurePage(); if (!p) return;
    await dom.garantirMarketplace(p).catch(()=>{});
    const opened = await dom.clickChatInFeed(p, chatId, { timeoutMs: 20000, attemptId: st.attemptId, nome: this.perfil });
    if (!opened) {
      stepLog.appendJSONL(this.perfil, 'virtus', { step: 'coleta_open_fail', chatId, attempt: st.attemptId });
      // Rearme uma nova coleta em 60-120s
      this._armColetaTimer(chatId, 60000);
      return;
    }
    await dom.ensureConversationReady(p, chatId, { timeoutMs: 15000 }).catch(()=>{});
    const historico = await dom.scrapeChatHistory(p).catch(()=>[]);
    st.mensagens = historico || [];
    await this._saveState();

    // IA
    stepLog.appendJSONL(this.perfil, 'virtus', { step: 'llm_start', chatId, len: st.mensagens.length });
    const out = await masterExtractAnswer({
      perfil: this.perfil,
      chatId,
      mensagens: st.mensagens,
      contexto: {},
      respond: true
    });
    if (!out || !out.control || !out.control.shouldReply || !out.answer) {
      stepLog.appendJSONL(this.perfil, 'virtus', { step: 'llm_noop', chatId });
      // Se nada a dizer, rearme coleta em 3–5min
      this._armColetaTimer(chatId, 180000 + Math.floor(Math.random()*120000));
      return;
    }
    // Atualiza extração
    const ext = out.extraction || {};
    const te = ext && ext.telefone;
    if (te && !st.tsWhatsAppColetado) {
      st.tsWhatsAppColetado = now();
      st.janelaColetaAte = now() + this.collectWindowMs;
      this._armJanelaTimer(chatId, this.collectWindowMs);
    }
    await this._saveState();

    // Enfileira envio
    await this._enqueueSend(chatId, out.answer, st.attemptId);
    st.estado = 'fila_resposta';
    await this._saveState();

    // Rearme uma nova coleta mais tarde para continuar extração enquanto janela está aberta
    if (st.janelaColetaAte) {
      const msLeft = st.janelaColetaAte - now();
      const wiggle = Math.min(msLeft/2, 120000);
      this._armColetaTimer(chatId, Math.max(60000, wiggle)); // coleta incremental
    } else {
      // sem telefone ainda, re-coleta em 4–6min
      this._armColetaTimer(chatId, 240000 + Math.floor(Math.random()*120000));
    }
  }

  async _enqueueSend(chatId, answer, attemptId) {
    // persistente
    const already = this.sendQueue.find(i => i.chatId === chatId && i.answer === answer);
    if (already) return;
    this.sendQueue.push({
      chatId, answer,
      attemptId: attemptId || stepLog.attemptId(),
      retries: 0,
      backoffUntil: 0,
      enqueuedAt: now()
    });
    await this._saveQueue();
    stepLog.appendJSONL(this.perfil, 'virtus', { step: 'queued_send', chatId, answerLen: String(answer||'').length });
    this._processSendQueue().catch(()=>{});
  }

  async _processSendQueue() {
    if (this.sendWorkerActive) return;
    this.sendWorkerActive = true;
    try {
      while (this.running && this.sendQueue.length > 0) {
        const item = this.sendQueue[0];
        const { chatId } = item;
        if (item.backoffUntil && item.backoffUntil > now()) {
          await new Promise(r => setTimeout(r, item.backoffUntil - now()));
        }
        // 72h guard antes de enviar
        const tsPrev = this.respondidos72h[chatId] || 0;
        if (tsPrev && (now() - tsPrev) < this.noRepeat72hMs) {
          stepLog.appendJSONL(this.perfil, 'virtus', { step: 'send_skip_blocked72h', chatId });
          this.sendQueue.shift();
          await this._saveQueue();
          continue;
        }
        stepLog.appendJSONL(this.perfil, 'virtus', { step: 'send_dequeued', chatId });
        let p = await this._ensurePage();
        let acquired = false;
        try {
          if (!p) throw new Error('page_unavailable');
          acquired = chatLock.acquire(this.perfil, chatId);
          if (!acquired) throw new Error('chat_lock_busy');

          await dom.garantirMarketplace(p).catch(()=>{});
          const opened = await dom.clickChatInFeed(p, chatId, { timeoutMs: 20000, nome: this.perfil });
          if (!opened) throw new Error('open_failed');

          const campo = await dom.waitForComposer(p, 10000);
          if (!campo) throw new Error('composer_missing');

          await dom.sendMessageSafe(p, campo, item.answer, this.perfil, chatId);

          // jitter entre envios (respeitando requisitos 30–90s)
          const delay = this.minSendDelayMs + Math.floor(Math.random()*(this.maxSendDelayMs - this.minSendDelayMs));
          await new Promise(r => setTimeout(r, delay));

          // marca no state: respondido (nesta rodada)
          const st = this.state.chats[chatId];
          if (st) {
            st.estado = 'respondido';
            await this._saveState();
          }

          // tira do queue
          this.sendQueue.shift();
          await this._saveQueue();
          stepLog.appendJSONL(this.perfil, 'virtus', { step: 'send_ok', chatId });
        } catch (e) {
          const msg = (e && e.message) || String(e);
          stepLog.appendJSONL(this.perfil, 'virtus', { step: 'send_fail', chatId, error: msg });
          // Requeue com backoff exponencial – nunca drop
          item.retries = (item.retries || 0) + 1;
          const backoff = Math.min(30*60*1000, Math.pow(2, Math.min(item.retries, 8)) * 1000);
          item.backoffUntil = now() + backoff;
          await this._saveQueue();
          // não shift; apenas aguardar backoff
          await new Promise(r => setTimeout(r, 1000));
        } finally {
          if (acquired) chatLock.release(this.perfil, chatId);
        }
      }
    } finally {
      this.sendWorkerActive = false;
    }
  }

  async _finalizeWindow(chatId) {
    const st = this.state.chats[chatId]; if (!st) return;
    // finaliza após janela de coleta (se telefone presente)
    const isComplete = !!(st.tsWhatsAppColetado);
    st.final = isComplete ? 'completo' : 'incompleto';
    st.pendingCommit = true;
    await this._saveState();
    await this._commitChat(chatId);
  }

  async _finalizeGlobal(chatId) {
    const st = this.state.chats[chatId]; if (!st) return;
    if (st.estado === 'finalizado') return;
    // finalização por timeout global
    const isComplete = !!(st.tsWhatsAppColetado);
    st.final = isComplete ? 'completo' : 'incompleto';
    st.pendingCommit = true;
    await this._saveState();
    await this._commitChat(chatId);
  }

  async _commitChat(chatId) {
    const st = this.state.chats[chatId]; if (!st) return;
    if (!st.pendingCommit) return;

    const payload = {
      chatId,
      perfil: this.perfil,
      final: st.final || 'incompleto',
      mensagens: st.mensagens || [],
      tsCriacao: st.tsCriacao,
      tsWhatsAppColetado: st.tsWhatsAppColetado || null
    };

    try {
      const r = await this.commitClient.commitPedido(this.perfil, chatId, payload);
      if (!r || r.ok !== true) throw new Error((r && r.error) || 'commit_failed');
      // commit ok: marca 72h e finaliza
      this.respondidos72h[chatId] = now();
      await this._saveNoRepeat();

      st.estado = 'finalizado';
      st.pendingCommit = false;
      await this._saveState();

      // limpa timers e state
      const rec = this.timers.get(chatId);
      if (rec) {
        try { clearTimeout(rec.coleta); } catch {}
        try { clearTimeout(rec.janela); } catch {}
        try { clearTimeout(rec.global); } catch {}
        this.timers.delete(chatId);
      }
      stepLog.appendJSONL(this.perfil, 'virtus', { step: 'commit_ok', chatId, final: st.final });
      // opcional: remover do state para não crescer indefinidamente
      delete this.state.chats[chatId];
      await this._saveState();
    } catch (e) {
      const msg = (e && e.message) || String(e);
      stepLog.appendJSONL(this.perfil, 'virtus', { step: 'commit_fail', chatId, error: msg });
      // backoff para commit
      setTimeout(() => this._commitChat(chatId).catch(()=>{}), 30000);
    }
  }

  async _recoverTimers() {
    for (const [chatId, st] of Object.entries(this.state.chats || {})) {
      // rearm global
      this._armGlobalTimer(chatId);
      // rearm janela se aplicável
      if (st.janelaColetaAte && st.estado !== 'finalizado') {
        const left = st.janelaColetaAte - now();
        if (left <= 0) {
          // finaliza logo
          await this._finalizeWindow(chatId);
        } else {
          this._armJanelaTimer(chatId, left);
        }
      }
      // se nunca coletou IA, rearm coleta em 15–30s
      if (st.estado === 'novo' || st.estado === 'coletando' || st.estado === 'aguardando_ia' || st.estado === 'fila_resposta') {
        this._armColetaTimer(chatId, 15000 + Math.floor(Math.random()*15000));
      }
      // se pendingCommit (crash antes do commit), tenta commit
      if (st.pendingCommit) {
        this._commitChat(chatId).catch(()=>{});
      }
    }
  }

  async _ensurePage() {
    // retorna a main page, repete o que já existe em virtus.js
    try {
      const pages = await this.browser.pages();
      if (pages && pages[0]) return pages[0];
    } catch {}
    try {
      const np = await this.browser.newPage();
      return np;
    } catch {}
    return null;
  }
}

module.exports = { VirtusOrchestrator };

