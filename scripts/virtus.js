'use strict';
const path = require('path');
const crypto = require('crypto');
const { patchPage } = require('./browser.js');
const utils = require('./utils.js');
const stepLog = require('./stepLog.js');
const { masterExtractAnswer } = require('./inteligenciaArtificial.js');
const chatStore = require('./chatStore.js');
const logger = require('./logger.js');

const POLL_MS = 4000; // Polling rápido
const COLLECT_DELAY_MS = 45000; // 45s para coletar msgs
const SEND_MIN_MS = 30000;
const SEND_MAX_MS = 90000;
const CLOSE_WHATSAPP_MS = 10 * 60 * 1000; // 10min após WhatsApp

let lastGlobalSendAt = 0;

function sleep(ms){ return new Promise(r=>setTimeout(r, ms)); }

function digestHistory(msgs){
  try{
    const slim = (Array.isArray(msgs)?msgs:[]).map(m=>({a:m.autor,t:String(m.texto||'').slice(0,120)}));
    return crypto.createHash('sha1').update(JSON.stringify(slim)).digest('hex');
  }catch{return null;}
}

async function ensurePage(browser, perfil){
  const pages = await browser.pages();
  let page = pages && pages[0];
  if (!page || page.isClosed()){
    page = await browser.newPage();
    const manifestStore = require('./manifestStore.js');
    const man = await manifestStore.read(perfil).catch(()=>null);
    const coords = utils.getCoords(man && man.cidade || '');
    await patchPage(perfil, page, coords);
  }
  return page;
}

async function gotoMarketplace(page){
  if (!/messenger\.com\/marketplace/i.test(page.url()||'')){
    await page.goto('https://www.messenger.com/marketplace', {waitUntil:'domcontentloaded', timeout:30000}).catch(()=>{});
  }
}

async function detectChats(page){
  try {
    const items = await page.$$eval('a[href^="/marketplace/t/"]', els => {
      function idFromHref(h){ const m = String(h||'').match(/\/marketplace\/t\/(\d+)/); return m?m[1]:null; }
      function tempo(row){
        if (!row) return '';
        const ab = row.querySelector && row.querySelector('abbr[aria-label]');
        if (ab) return (ab.innerText||ab.textContent||ab.getAttribute('aria-label')||'').trim();
        const spans = row.querySelectorAll ? row.querySelectorAll('span') : [];
        for (const s of spans){
          const t = (s.innerText||s.textContent||'').trim();
          if (/agora|s|min|m|h|hora|hour/i.test(t)) return t;
        }
        return '';
      }
      const out = [];
      for (const el of els){
        const id = idFromHref(el.getAttribute('href')||el.href||'');
        if (!id) continue;
        const row = el.closest('div[role="row"]') || el.parentElement;
        const tt = tempo(row);
        out.push({chatId:id, tempo:tt});
      }
      const map = new Map(); // dedup
      out.forEach(o=>{ if (!map.has(o.chatId)) map.set(o.chatId,o); });
      return Array.from(map.values());
    });
    return items;
  } catch {
    return [];
  }
}

function ageMsFromTempo(t){
  if (!t) return Number.MAX_SAFE_INTEGER;
  const s = String(t).toLowerCase();
  if (/agora|now/.test(s)) return 0;
  const mm = s.match(/(\d+)\s*(s|seg)/); if (mm) return parseInt(mm[1],10)*1000;
  const m2 = s.match(/(\d+)\s*(min|m)/); if (m2) return parseInt(m2[1],10)*60000;
  const h = s.match(/(\d+)\s*(h|hora)/); if (h) return parseInt(h[1],10)*3600000;
  return Number.MAX_SAFE_INTEGER;
}

async function scrapeHistory(page){
  try{
    const msgs = await page.evaluate(()=>{
      const norm = s => (s||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').trim();
      const grid = document.querySelector('div[aria-label^="Mensagens"]') || document.querySelector('div[role="grid"][aria-label]');
      if (!grid) return [];
      const rows = Array.from(grid.querySelectorAll('div[role="row"]')).slice(-120);
      const out = [];
      for (const r of rows){
        const txts = Array.from(r.querySelectorAll('div[dir="auto"]')).map(el=>norm(el.innerText||el.textContent||'')).filter(Boolean);
        if (!txts.length) continue;
        const isMe = (() => {
          const t = norm(r.innerText||'');
          if (/v[oó]c[eê]\s+enviou|you\s+sent/.test(t)) return true;
          try { const st = getComputedStyle(r); if (st && (st.textAlign==='right' || st.justifyContent==='flex-end')) return true; } catch {}
          return false;
        })();
        for (const t of txts){
          out.push({ autor: isMe ? 'ia' : 'cliente', texto: t });
        }
      }
      return out;
    });
    return Array.isArray(msgs) ? msgs : [];
  } catch { return []; }
}

async function clickChat(page, chatId){
  const sel = `a[href^="/marketplace/t/${chatId}"]`;
  const a = await page.$(sel).catch(()=>null);
  if (!a) return false;
  await page.evaluate(el => {
    el.scrollIntoView({behavior:'auto',block:'center'});
    el.click();
  }, a);
  await page.waitForFunction(id => location.pathname.includes('/marketplace/t/'+id), {timeout:8000}, chatId).catch(()=>{});
  return true;
}

async function waitComposer(page){
  const sels = [
    'div[contenteditable="true"][role="textbox"]',
    'div[contenteditable="true"][aria-label]',
    'div[contenteditable="true"]'
  ];
  for (const sel of sels){
    const h = await page.$(sel).catch(()=>null);
    if (h) return h;
  }
  return null;
}

async function sendMessage(page, chatId, texto){
  const campo = await waitComposer(page);
  if (!campo) throw new Error('composer_missing');
  await campo.click().catch(()=>{});
  const ctrl = (process.platform==='darwin')?'Meta':'Control';
  await page.keyboard.down(ctrl); await page.keyboard.press('KeyA'); await page.keyboard.up(ctrl);
  await page.keyboard.press('Backspace').catch(()=>{});
  await page.keyboard.type(String(texto||''), {delay:0});
  await page.keyboard.press('Enter');
  await page.waitForTimeout(500);
}

function scheduleChatTimers(perfil, browser, timersMap, chatState, runCollect, runSend, runClose){
  const key = `${perfil}:${chatState.chatId}`;
  if (timersMap.has(key)){
    const prev = timersMap.get(key);
    clearTimeout(prev.collectT); clearTimeout(prev.sendT); clearTimeout(prev.closeT);
  }
  const collectMs = chatState.collectDueAt ? chatState.collectDueAt - Date.now() : null;
  const sendMs    = chatState.sendDueAt    ? chatState.sendDueAt    - Date.now() : null;
  const closeMs   = chatState.closeDueAt   ? chatState.closeDueAt   - Date.now() : null;
  const holder = {collectT:null, sendT:null, closeT:null};
  if (collectMs!=null){
    holder.collectT = setTimeout(()=>runCollect(chatState.chatId).catch(()=>{}), Math.max(0, collectMs));
  }
  if (sendMs!=null){
    holder.sendT = setTimeout(()=>runSend(chatState.chatId).catch(()=>{}), Math.max(0, sendMs));
  }
  if (closeMs!=null){
    holder.closeT = setTimeout(()=>runClose(chatState.chatId).catch(()=>{}), Math.max(0, closeMs));
  }
  timersMap.set(key, holder);
}

async function startVirtus(browser, perfil){
  const timers = new Map();
  const chatIndex = new Map();
  const page = await ensurePage(browser, perfil);
  await gotoMarketplace(page);

  // Carrega chats persistidos e reagenda
  for (const st of chatStore.listChats(perfil)){
    chatIndex.set(st.chatId, st);
  }

  async function newChat(chatId){
    if (chatIndex.has(chatId)) return;
    const state = {
      chatId, perfil,
      status: 'novo',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      lastClientTs: Date.now(),
      historyDigest: null,
      collectDueAt: Date.now() + COLLECT_DELAY_MS,
      sendDueAt: null,
      closeDueAt: null,
      sendRetries: 0,
      llm: null,
      logs: []
    };
    chatIndex.set(chatId, state);
    chatStore.saveChat(perfil, chatId, state);
    chatStore.appendLog(perfil, chatId, {step:'novo_detectado'});
    scheduleChatTimers(perfil, browser, timers, state, collectChat, sendChat, closeChat);
  }

  async function collectChat(chatId){
    const st = chatStore.loadChat(perfil, chatId);
    if (!st || st.status === 'fechado') return;
    st.status = 'coletando';
    chatStore.saveChat(perfil, chatId, st);
    chatStore.appendLog(perfil, chatId, {step:'collect_start'});
    const p = await ensurePage(browser, perfil);
    await gotoMarketplace(p);
    const ok = await clickChat(p, chatId);
    if (!ok){ chatStore.appendLog(perfil, chatId, {step:'collect_fail', reason:'click'}); return; }
    const hist = await scrapeHistory(p);
    if (!hist.length){ chatStore.appendLog(perfil, chatId, {step:'collect_fail', reason:'hist_vazio'}); return; }
    const dig = digestHistory(hist);
    if (st.historyDigest === dig){
      chatStore.appendLog(perfil, chatId, {step:'collect_skip_same_digest'});
    }
    const llm = await masterExtractAnswer({
      perfil, chatId, mensagens: hist, contexto:{}, respond:true
    });
    st.llm = llm || null;
    st.historyDigest = dig;
    st.status = 'pronto';
    st.sendDueAt = Date.now() + (SEND_MIN_MS + Math.floor(Math.random()*(SEND_MAX_MS-SEND_MIN_MS)));
    // Se whatsapp coletado, programa fechamento
    const hasWhatsapp = llm && llm.extraction && llm.extraction.telefone && /^\d{10,11}$/.test(String(llm.extraction.telefone));
    if (hasWhatsapp && !st.closeDueAt){
      st.closeDueAt = Date.now() + CLOSE_WHATSAPP_MS;
      chatStore.appendLog(perfil, chatId, {step:'deadline_10m_programado', closeAt: st.closeDueAt});
    }
    chatStore.saveChat(perfil, chatId, st);
    chatStore.appendLog(perfil, chatId, {step:'collect_done'});
    scheduleChatTimers(perfil, browser, timers, st, collectChat, sendChat, closeChat);
  }

  async function sendChat(chatId){
    const st = chatStore.loadChat(perfil, chatId);
    if (!st || st.status === 'fechado') return;
    if (!st.llm || !st.llm.answer){
      chatStore.appendLog(perfil, chatId, {step:'send_abort', reason:'sem_llm'});
      return;
    }
    const now = Date.now();
    if (now < lastGlobalSendAt){
      st.sendDueAt = lastGlobalSendAt;
      chatStore.saveChat(perfil, chatId, st);
      scheduleChatTimers(perfil, browser, timers, st, collectChat, sendChat, closeChat);
      return;
    }
    const p = await ensurePage(browser, perfil);
    await gotoMarketplace(p);
    const ok = await clickChat(p, chatId);
    if (!ok){
      st.sendRetries += 1;
      st.sendDueAt = Date.now() + 30000;
      chatStore.saveChat(perfil, chatId, st);
      chatStore.appendLog(perfil, chatId, {step:'send_requeue_click_fail'});
      scheduleChatTimers(perfil, browser, timers, st, collectChat, sendChat, closeChat);
      return;
    }
    try{
      await sendMessage(p, chatId, st.llm.answer);
      lastGlobalSendAt = Date.now() + (SEND_MIN_MS + Math.floor(Math.random()*(SEND_MAX_MS-SEND_MIN_MS)));
      st.status = 'respondido';
      st.sendDueAt = null;
      chatStore.saveChat(perfil, chatId, st);
      chatStore.appendLog(perfil, chatId, {step:'send_ok'});
    } catch(e){
      st.sendRetries += 1;
      st.sendDueAt = Date.now() + 30000;
      chatStore.saveChat(perfil, chatId, st);
      chatStore.appendLog(perfil, chatId, {step:'send_fail', error:(e&&e.message)||String(e)});
    }
    scheduleChatTimers(perfil, browser, timers, st, collectChat, sendChat, closeChat);
  }

  async function closeChat(chatId){
    const st = chatStore.loadChat(perfil, chatId);
    if (!st || st.status === 'fechado') return;
    st.status = 'fechado';
    st.closeDueAt = null;
    chatStore.saveChat(perfil, chatId, st);
    chatStore.appendLog(perfil, chatId, {step:'fechado_auto'});
  }

  async function tick(){
    const p = await ensurePage(browser, perfil);
    await gotoMarketplace(p);
    const chats = await detectChats(p);
    for (const c of chats){
      if (ageMsFromTempo(c.tempo) <= 5*60*1000){ // apenas recentes
        await newChat(c.chatId);
      }
    }
    // Reagendar qualquer timer vencido
    for (const st of chatStore.listChats(perfil)){
      if (st.status === 'fechado') continue;
      const now = Date.now();
      if (st.collectDueAt && st.collectDueAt <= now) { await collectChat(st.chatId); continue; }
      if (st.sendDueAt && st.sendDueAt <= now) { await sendChat(st.chatId); continue; }
      if (st.closeDueAt && st.closeDueAt <= now) { await closeChat(st.chatId); continue; }
      scheduleChatTimers(perfil, browser, timers, st, collectChat, sendChat, closeChat);
    }
  }

  // Reagendar todos na carga inicial
  for (const st of chatStore.listChats(perfil)){
    scheduleChatTimers(perfil, browser, timers, st, collectChat, sendChat, closeChat);
  }

  const poll = setInterval(()=>{ tick().catch(()=>{}); }, POLL_MS);

  return {
    stop: async ()=>{
      clearInterval(poll);
      timers.forEach(obj=>{
        if (obj.collectT) clearTimeout(obj.collectT);
        if (obj.sendT) clearTimeout(obj.sendT);
        if (obj.closeT) clearTimeout(obj.closeT);
      });
      timers.clear();
    }
  };
}

module.exports = { startVirtus };