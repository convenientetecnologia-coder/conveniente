// scripts/eventStream.js
/*
 * EVENT STREAM LOCAL SUPERVISOR <-> WORKER
 * Arquivo de log append-only, com locks, suporta push de evento por múltiplos processos,
 * leitura bulk, rotação, consumo por offset, ACK e replay.
 */

'use strict';
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'dados');
const STREAM_FILE = path.join(DATA_DIR, 'event_stream.jsonl');   // Append-only log (JSON por linha)
const META_FILE = path.join(DATA_DIR, 'event_stream.meta.json'); // guarda último offset lido/acknowledged
const _LOCK = { saving: Promise.resolve() };

// Escreve um evento no stream (linha JSON), retorna offset da linha.
async function pushEvent(evt) {
  const line = JSON.stringify({ ...evt, ts: Date.now() }) + '\n';
  return new Promise((resolve, reject) => {
    _LOCK.saving = _LOCK.saving.then(() =>
      new Promise((r2) => {
        fs.appendFile(STREAM_FILE, line, (err) => {
          if (err) { reject(err); r2(); return; }
          resolve(true); r2();
        });
      })
    ).catch(()=>{});
  });
}

// Lê eventos (bulk), por offset de linha/opcional count máximo
function readEvents({from = 0, max = 1000} = {}) {
  if (!fs.existsSync(STREAM_FILE)) return [];
  const lines = fs.readFileSync(STREAM_FILE, 'utf8').split('\n').filter(Boolean);
  return lines.slice(from, from + max).map((l, idx) => {
    try { return { ...JSON.parse(l), offset: from + idx }; }
    catch { return null; }
  }).filter(Boolean);
}

// Grava último offset acknowledged pelo consumidor (usado por Supervisor para persistir progresso)
function ackTo(offset) {
  fs.writeFileSync(META_FILE, JSON.stringify({ lastAck: offset, ts: Date.now() }));
}

// Lê último offset acknowledged
function getAck() {
  if (!fs.existsSync(META_FILE)) return 0;
  try {
    const j = JSON.parse(fs.readFileSync(META_FILE, 'utf8'));
    return j && typeof j.lastAck === 'number' ? j.lastAck : 0;
  } catch { return 0; }
}

// Utilitário para consumir eventos novos não-acknowledged
function getNewEvents(max=1000) {
  const from = getAck();
  const evts = readEvents({from, max});
  return evts;
}

// Roda rotação (backup) se arquivo ficou muito grande (ex: >10MB) ou por admin
function rotate({force=false, maxBytes=10*1024*1024}={}) {
  if (!fs.existsSync(STREAM_FILE)) return false;
  const st = fs.statSync(STREAM_FILE);
  if (st.size < maxBytes && !force) return false;
  const backupFn = STREAM_FILE + '.' + Date.now();
  fs.copyFileSync(STREAM_FILE, backupFn);
  fs.writeFileSync(STREAM_FILE, '');
  return true;
}

// Limpa stream e ack (replay total)
function reset() {
  if (fs.existsSync(STREAM_FILE)) fs.unlinkSync(STREAM_FILE);
  if (fs.existsSync(META_FILE)) fs.unlinkSync(META_FILE);
}

module.exports = {
  pushEvent,      // pushEvent(evt): Promise
  readEvents,     // readEvents({from, max})
  ackTo,          // ackTo(offset)
  getAck,         // getAck()
  getNewEvents,   // getNewEvents(max)
  rotate,         // rotate({force, maxBytes})
  reset           // reset()
};