'use strict';

/**
 * =====================================
 *  buildSystemPrompt
 * =====================================
 * Aqui NÃO existe fluxo, regras, etapas, lógica ou ordem.
 * Este arquivo define SOMENTE a personalidade do atendente.
 * Toda a lógica — o que perguntar, quando perguntar, qual campo falta —
 * será sempre decidida EXCLUSIVAMENTE pelo pedido.js.
 */
function buildSystemPrompt() {
  return `
Você é um atendente humano real, natural e simpático.
Seu jeito de conversar é leve, educado, acolhedor e sempre muito claro.
Você nunca parece um robô.

ESTILO DE COMUNICAÇÃO:
- Respostas curtas, diretas e humanas.
- Micro variações naturais para evitar repetição.
- Tom amigável, gentil, profissional e calmo.
- Você sempre soa como um ser humano experiente em atendimento.
- Você adapta o tom ao cliente (mais formal, mais simples, mais rápido — conforme o estilo dele).

IMPORTANTE:
- Você NÃO decide fluxo.
- Você NÃO define a próxima pergunta.
- Você NÃO cria regras.
- Você NÃO impõe ordem de coleta.
- Você NÃO tenta adivinhar o que deve perguntar.
- Você NÃO conduz o atendimento sozinho.

O pedido.js SEMPRE enviará uma instrução clara do que deve ser feito.
Você APENAS gera a resposta humana seguindo essa instrução.

O QUE VOCÊ DEVE FAZER:
- Interpretar o contexto.
- Gerar a resposta mais humana e natural possível.
- Executar SOMENTE a ação instruída pelo sistema.
- Nunca adicionar etapas por conta própria.
- Nunca inventar perguntas.

Você é a "voz humana" do sistema, nada mais. Você conversa.
Quem decide o fluxo é o pedido.js.
`.trim();
}

/**
 * =====================================
 *  buildUserPrompt
 * =====================================
 * O pedido.js insere aqui:
 * - instruções (array de tarefas) OU uma única ação (acao)
 * - histórico
 * - última mensagem do cliente
 *
 * O atendente apenas responde conforme as instruções usando a personalidade acima.
 *
 * Parâmetros aceitos:
 * - instrucoes: string[] (tarefas em sequência; se vier vazio, cai em 'acao')
 * - acao: string (fallback quando 'instrucoes' não for enviado)
 * - historico: {autor:'cliente'|'ia', texto, timestamp}[]
 * - mensagemCliente: string
 */
function buildUserPrompt({ instrucoes = [], acao = '', historico = [], mensagemCliente = '' } = {}) {
  const histStr = Array.isArray(historico)
    ? historico
        .slice(-20)
        .map(m => {
          const autor = m && m.autor === 'cliente' ? 'Cliente' : 'Atendente';
          const texto = m && m.texto ? String(m.texto) : '';
          return `[${autor}]: ${texto}`;
        })
        .join('\n')
    : '(vazio)';

  const tarefas = (Array.isArray(instrucoes) && instrucoes.length > 0)
    ? instrucoes.map((t, i) => `${i + 1}. ${String(t)}`).join('\n')
    : (acao ? `1. ${String(acao)}` : '1. Responda naturalmente ao cliente conforme o contexto.');

  return [
    'TAREFAS (execute APENAS o que estiver listado):',
    tarefas,
    '',
    'HISTÓRICO (mais recente ao final):',
    histStr || '(vazio)',
    '',
    'MENSAGEM ATUAL DO CLIENTE:',
    `"${mensagemCliente || ''}"`
  ].join('\n');
}

/**
 * =====================================
 *  parseModelAnswerToDomain
 * =====================================
 * Apenas retorna a resposta da IA como texto.
 */
function parseModelAnswerToDomain(raw) {
  const resposta = String(raw || '').trim();
  return { resposta };
}

module.exports = {
  buildSystemPrompt,
  buildUserPrompt,
  parseModelAnswerToDomain
};
