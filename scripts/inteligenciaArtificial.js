'use strict';

const fetch = global.fetch || require('node-fetch');

async function chatCompletion({ system, user, provider = 'groq', model, timeoutMs = 15000, retries = 2 }) {
  let lastErr = null;

  for (let i = 0; i <= retries; i++) {
    const controller = new (global.AbortController || require('node-abort-controller'))();

    const t = setTimeout(() => { try { controller.abort(); } catch{} }, timeoutMs);

    try {
      if (provider === 'groq') {
        const apiKey = process.env.GROQ_API_KEY;
        const apiUrl = process.env.GROQ_API_URL || 'https://api.groq.com/openai/v1/chat/completions';
        const mdl = model || process.env.GROQ_MODEL;

        if (!apiKey || !mdl) throw new Error('GROQ_API_KEY/GROQ_MODEL ausentes');

        const resp = await fetch(apiUrl, {
          method: 'POST',
          headers: { 'Content-Type':'application/json', 'Authorization': `Bearer ${apiKey}` },
          body: JSON.stringify({
            model: mdl,
            messages: [
              { role: 'system', content: system },
              { role: 'user', content: user }
            ],
            temperature: 0.9,
            max_tokens: 1200
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
            temperature: 0.9,
            max_tokens: 1200
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
    }
  }

  throw lastErr || new Error('llm_error');
}

module.exports = { chatCompletion };

