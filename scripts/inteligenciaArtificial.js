// inteligenciaArtificial.js

'use strict';

const fetch = global.fetch || require('node-fetch');

let stepLog = null; try { stepLog = require('./stepLog.js'); } catch {}

let issues = null; try { issues = require('./issues.js'); } catch {}

function pickTempByTask(task) {
const t = String(task || '').toLowerCase();
if (t === 'extract') return 0.0;
if (t === 'answer') return 0.6; // mais calor humano e variação controlada
return 0.9;
}

function pickTopPByTask(task) {
const t = String(task || '').toLowerCase();
if (t === 'extract') return 1.0;
if (t === 'answer') return 0.9; // reduz cauda e ajuda a manter objetividade
return 0.9;
}

function pickMaxTokensByTask(task) {
const t = String(task || '').toLowerCase();
if (t === 'extract') return 800;
if (t === 'answer') return 900; // Ajuste para burst mais humano/robusto
return 1200;
}

async function chatCompletion({ system, user, provider = 'groq', model, timeoutMs = 20000, retries = 2, task = 'answer' }) {
let lastErr = null;

const temperature = pickTempByTask(task);
const max_tokens = pickMaxTokensByTask(task);
const top_p = pickTopPByTask(task);
const presence_penalty = (String(task || '').toLowerCase() === 'answer') ? 0.1 : 0.0;
const frequency_penalty = (String(task || '').toLowerCase() === 'answer') ? 0.1 : 0.0;

for (let i = 0; i <= retries; i++) {
const Controller = global.AbortController || require('node-abort-controller');
const controller = new Controller();
const t = setTimeout(() => { try { controller.abort(); } catch {} }, timeoutMs);

try {
  if (provider === 'groq') {
    const apiKey = process.env.GROQ_API_KEY;
    const apiUrl = process.env.GROQ_API_URL || 'https://api.groq.com/openai/v1/chat/completions';
    const mdl =
      model
      || (task === 'extract'
        ? (process.env.GROQ_MODEL_EXTRACT || process.env.GROQ_MODEL)
        : (process.env.GROQ_MODEL_ANSWER || process.env.GROQ_MODEL));

    if (!apiKey || !mdl) throw new Error('GROQ_API_KEY ou modelo ausente');

    const resp = await fetch(apiUrl, {
      method: 'POST',
      headers: { 'Content-Type':'application/json', 'Authorization': `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: mdl,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user }
        ],
        temperature,
        top_p,
        presence_penalty,
        frequency_penalty,
        max_tokens
      }),
      signal: controller.signal
    });

    clearTimeout(t);

    if (!resp.ok) throw new Error(`Groq HTTP ${resp.status}`);

    const data = await resp.json();

    const content = data?.choices?.[0]?.message?.content || '';

    if (!content || !String(content).trim()) throw new Error('groq_empty');

    return String(content).trim();

  } else if (provider === 'openai') {
    const apiKey = process.env.OPENAI_API_KEY;
    const apiUrl = process.env.OPENAI_API_URL || 'https://api.openai.com/v1/chat/completions';
    const mdl = model || process.env.OPENAI_MODEL || 'gpt-3.5-turbo';

    if (!apiKey) throw new Error('OPENAI_API_KEY ausente');

    const resp = await fetch(apiUrl, {
      method: 'POST',
      headers: { 'Content-Type':'application/json', 'Authorization': `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: mdl,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user }
        ],
        temperature,
        top_p,
        presence_penalty,
        frequency_penalty,
        max_tokens
      }),
      signal: controller.signal
    });

    clearTimeout(t);

    if (!resp.ok) throw new Error(`OpenAI HTTP ${resp.status}`);

    const data = await resp.json();

    const content = data?.choices?.[0]?.message?.content || '';

    if (!content || !String(content).trim()) throw new Error('openai_empty');

    return String(content).trim();

  } else {
    clearTimeout(t);
    throw new Error(`provider_unsupported:${provider}`);
  }

} catch (e) {
  clearTimeout(t);
  lastErr = e;
  try {
    const errMsg = (e && e.message) || String(e);
    if (stepLog) {
      stepLog.appendJSONL('default', 'llm_chat_error_try', {
        provider,
        model: model || null,
        task,
        attempt: i + 1,
        retries,
        timeoutMs,
        error: errMsg,
        ts: Date.now()
      });
    }
  } catch {}
  await new Promise(r => setTimeout(r, 800));
}

}

if (issues && typeof issues.append === 'function') {
  try { await issues.append('default', 'llm_error_final', `provider=${provider} model=${model||''} task=${task} err=${(lastErr && lastErr.message) || lastErr}`); } catch {}
}
if (stepLog) {
  try {
    stepLog.appendJSONL('default', 'llm_error_final', {
      provider, model: model || null, task,
      error: (lastErr && lastErr.message) || String(lastErr || 'unknown'),
      ts: Date.now()
    });
  } catch {}
}

throw lastErr || new Error('llm_error');
}

module.exports = { chatCompletion };