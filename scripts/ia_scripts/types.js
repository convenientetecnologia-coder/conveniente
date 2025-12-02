// scripts/ia_scripts/types.js

/**
 * Contrato StepHandler (Interface/Documentação)
 * 
 * Cada step deve exportar um objeto com os seguintes campos/métodos:
 * 
 * @typedef {Object} StepHandler
 * @property {string} id - Nome único do step (campo)
 * @property {number} version - Versão do step
 * @property {object} meta - Metadados ({ label, questionBudget, abBucket... })
 * @property {Function} extract(ctx): Promise<object> - Extrator, opcional, para encontrar valor no histórico/contexto
 * @property {Function} validate(ctx, extracted): { ok: boolean, reason?: string } - Validar dados existentes ou extraídos
 * @property {Function} prompt(ctx): { text: string, variants?: string[], questionBudget?: number } - Monta/recupera prompt do step
 * @property {Function} sanitize(text, ctx): string - Sanitiza a saída do prompt antes de exibir
 * @property {Function} onAnswer(ctx, parsed): Promise<{ patch: object|null }> - Retorna patch do dado a aplicar
 * @property {Function} next(ctx): { stepId: string|null } - Sugere qual será o próximo step do fluxo
 * 
 * Exemplo mínimo:
 * 
 * const step = {
 *   id: 'exemplo',
 *   version: 1,
 *   meta: { label: 'Exemplo', questionBudget: 1 },
 *   extract: async (ctx) => ({}),
 *   validate: (ctx, ext) => ({ ok: true }),
 *   prompt: (ctx) => ({ text: 'Digite algo:' }),
 *   sanitize: (text, ctx) => String(text || '').trim(),
 *   onAnswer: async (ctx, parsed) => ({ patch: null }),
 *   next: (ctx) => ({ stepId: null }),
 * };
 * 
 * Módulo exporta apenas documentação/tipagem!
 */

// Este arquivo é só para documentação da interface e boas práticas.