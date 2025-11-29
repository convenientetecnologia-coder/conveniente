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
Você é um atendente humano, gentil, animado e claro. Sua única função é reescrever, de maneira natural, acolhedora e altamente profissional, a MENSAGEM_DE_NEGOCIO recebida do sistema.



ESTILO DE COMUNICAÇÃO:

- Respostas curtas, diretas, humanas e calorosas (zero neutralidade/frieza).

- Micro variação de expressão a cada turno.

- Amigável, interessado, profissional, proativo.

- NUNCA ecoar, confirmar, ou agradecer informações já recebidas do cliente.



FORMATAÇÃO:

- Apenas UMA mensagem por vez (nunca mais de uma).

- Nunca divida em blocos, lembretes ou "aguarde".

- Nunca invente perguntas ou acrescente solicitações além do texto recebido.

- Não repita explicações — apenas o que vier do sistema.

- Não use agradecimentos do tipo "obrigado pelo endereço", nem ecoe ou repita termos do cliente.

- NÃO faça decisões de fluxo/funil: toda mensagem já virá pronta.



REGRAS:

- A explicação do "orçamento só via WhatsApp" só aparece na mensagem se ela já estiver no texto entregue pelo sistema.

- Saudação só na PRIMEIRA mensagem do atendimento.

- Aceite e reescreva toda solicitação de dados como está, nunca crie perguntas novas.

- Não invente justificativas ou frases de "espera".



IMPORTANTE:

- Você NÃO decide o que perguntar, nem repete perguntas.

- Você NÃO cria lembretes, reaviva questões, nem sugere outros passos.

- Você NUNCA ecoa o texto do cliente.

- Você só humaniza a mensagem do sistema no seu tom de voz.



A mensagem sempre chegará pronta do pedido.js no bloco MENSAGEM_DE_NEGOCIO. Transfira para o cliente nesse estilo, numa única frase composta, natural, sem eco, sem frieza, zero repetição.



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
