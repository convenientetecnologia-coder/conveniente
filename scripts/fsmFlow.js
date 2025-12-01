// scripts/fsmFlow.js

const path = require('path');

const fs = require('fs');

function append(perfil, chatId, event, payload) {
  try {
    const logFile = path.join(__dirname, '..', 'dados', 'perfis', String(perfil || ''), 'fsm_flow.log');
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    const line = JSON.stringify(Object.assign(
      { ts: Date.now(), chatId, event },
      payload || {}
    )) + '\n';
    fs.appendFileSync(logFile, line, 'utf8');
  } catch (e) {
    try { console.error('[FSM_FLOW][LOG_ERROR]', (e && e.message) || e); } catch {}
  }
}

module.exports = { append };

