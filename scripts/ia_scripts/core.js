// scripts/ia_scripts/core.js

const registry = require('./registry');
const flowDef = require('./flowDef');

/**
 * Retorna lista de campos obrigatórios não preenchidos, segundo flowDef.
 * @param {Object} data - Dados já coletados do cliente
 * @returns {Array} - Lista de campos pendentes da ordem/flowDef
 */
async function computeMissingByFlow(data) {
  const req = flowDef.required || [];
  const missing = [];
  if (!data) return req.slice();
  for (const k of req) {
    if (!data[k]) missing.push(k);
  }
  return missing;
}

/**
 * Indica próximo campo a ser perguntado, na ordem do flow, considerando respostas já no data.
 * @param {Object} data 
 * @returns {String|null} - Step/campo pendente, ou null se finalizado
 */
function nextFieldByOrder(data) {
  const flowOrder = flowDef.order || [];
  for (const k of flowOrder) {
    // Required: obrigatório não preenchido
    if (flowDef.required.includes(k) && (!data || !data[k])) return k;
    // Optionais/simples: ajudante (espera boolean), descricao (espera preenchido)
    if (k === "ajudante" && (typeof data.ajudante !== 'boolean')) return k;
    if (k === "descricao" && (!data || !data.descricao)) return k;
  }
  return null;
}

/**
 * Orquestra a execução de um step isolado.
 * @param {Object} ctx - Contexto do chat ({ perfil, chatId, data, flags, historico, ... })
 * @param {String} stepId - id do handler/step (ex.: telefone, itens, etc)
 * @param {Number} version - versão (default 1)
 * @returns {Object} { ask, next }
 */
async function runStep(ctx, stepId, version = 1) {
  const step = registry.get(stepId, version);
  if (!step) throw new Error('step_not_found:' + stepId + '@' + version);

  // 1) Extract (microextrator)
  let extracted = {};
  if (typeof step.extract === 'function') {
    try { extracted = await step.extract(ctx) || {}; } catch {}
  }

  // 2) Validate (data ou extraído)
  let val = { ok: true };
  if (typeof step.validate === 'function')
    val = step.validate(ctx, extracted);

  // 3) Prompt builder
  const promptObj = (typeof step.prompt === 'function') ? step.prompt(ctx) : { text: '' };
  let text = promptObj.text || '';
  // Sanitizar renderização
  text = (typeof step.sanitize === 'function') ? step.sanitize(text, ctx) : String(text);

  // 4) Decidir próximo passo (custom ou ordem default)
  let next = null;
  if (typeof step.next === 'function') next = step.next(ctx);
  else next = { stepId: nextFieldByOrder(ctx.data) };

  // 5) Retorno: pergunta, destino, (state para logs se quiser)
  return { ask: text, next, meta: step.meta || {}, prompt: promptObj, validate: val };
}

module.exports = {
  computeMissingByFlow,
  nextFieldByOrder,
  runStep,
  flowDef,
};