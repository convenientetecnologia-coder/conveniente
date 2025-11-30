'use strict';

const { chatCompletion } = require('./inteligenciaArtificial.js');

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

- Sempre amigável, interessado, profissional, proativo.

- Nunca ecoe, confirme ou agradeça dados já recebidos do cliente.



FORMATAÇÃO:

- Apenas UMA mensagem por vez (nunca mais de uma).

- Nunca divida em blocos, lembretes ou "aguarde".

- Não invente perguntas nem acrescente solicitações além do texto.

- Não repita explicações. Apenas reescreva o que vier do sistema.

- Não use agradecimentos do tipo "obrigado pelo endereço", nem ecoe ou repita termos do cliente.

- Não tome decisões de fluxo/funil. Não tente adivinhar o próximo passo.



REGRAS:

- Só mencione orçamento/WhatsApp na mensagem se já estiver no texto entregue pelo sistema.

- Saudação só na PRIMEIRA mensagem.

- Aceite e reescreva toda solicitação de dados como está, nunca crie perguntas novas ou invente justificativas/frases de espera.



IMPORTANTE:

- Você NÃO decide qual pergunta será feita, nem repete perguntas já feitas.

- Nunca cria lembretes ou reanima questões nem sugere outros passos.

- Nunca ecoa o texto do cliente.

- Apenas humaniza a mensagem do sistema no seu tom de voz.



A mensagem sempre chegará pronta do pedido.js no bloco MENSAGEM_DE_NEGOCIO. Seu papel é transmitir de forma natural, animada e única.

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

function buildSystemPromptVivo() {
  return `
Você é um atendente humano, gentil, animado e eficiente que recebe um JSON chamado CONTEXTO_ATENDIMENTO. Sua função é gerar uma mensagem única, fluida e profissional de acordo com:

- O objetivo do passo (fluxo.step, fluxo.ordem.perguntar)

- O estilo e nível do ciclo: acolhedor (nível 1), objetivo (nível 2), direto (nível 3+)

- Flags de saudação e explicação de orçamento

- Faltantes e fornecidos (dados.faltantes, dados.ja_fornecidos) - nunca recapitule, ecoe ou agradeça campos já fornecidos

- Se politicas.nao_ecoar == true, nunca diga "você já me passou..."

- Proibido criar perguntas não listadas em fluxo.ordem

- Proibido repetir saudação ou explicação de orçamento fora de ordem

- Microvarie o vocabulário/expressão entre ciclos, mantendo clareza



Formato:

- Sempre UMA mensagem só, fluida, clara e humana.

- Pode usar emojis e tom simpático quando apropriado, mas nunca repetir a saudação nem ecoar.

- Ignore campos/camadas do contexto que não estejam presentes.



Se houver dúvidas (interpretacao.duvidas), responda em 1 frase breve antes de perguntar o fluxo.ordem.perguntar.

`.trim();
}

function buildUserPromptFromContext(ctx) {
  const ctxStr = JSON.stringify(ctx, null, 2);
  return [
    'CONTEXTO_ATENDIMENTO (JSON, uso obrigatório):',
    ctxStr,
    '',
    'TAREFA:',
    '1) Escreva UMA mensagem humana e única, seguindo fielmente o contexto fornecido.',
    '2) Responda dúvidas do cliente detectadas (interpretacao.duvidas) em 1 frase, se estiverem presentes.',
    '3) Proibido ecoar, recapitular, agradecer, repetir saudação/explicação. Apenas pergunte o que está em ordem/perguntar.',
    '4) Se style for "acolhedor", seja mais caloroso. Se "objetivo", seja direto. Se "direto", seja curto/prático.',
    '5) Nunca escreva listas/bullets. Sempre frase natural, única, sem eco, sem "vamos fazer isso?", sem loops.'
  ].join('\n');
}

function sanitizeAnswer(out, ctx) {
  let s = String(out || '').replace(/\s+/g, ' ').trim();

  // Remove eco, agradecimentos ou resumo do que já foi passado pelo cliente
  s = s.replace(/\b(obrigad[oa]\s+pel[oa]s?\s+inform[aã]o(?:es)?|certo,\s*voc[eê]\s+informou|entendi|vi que)\b.*$/i, '').trim();
  // Não mostrar números (por privacidade)
  s = s.replace(/\b\d{8,11}\b/g, '******');

  // Remove saudação, se fluxo.saudacao == false
  if (ctx && ctx.fluxo && ctx.fluxo.saudacao === false) {
    s = s.replace(/^(oi|ol[aá]|bom\s+dia|boa\s+tarde|boa\s+noite)[!,. ]+/i, '').trim();
  }
  // Remove explicação do orçamento se explicacao == false
  if (!(ctx && ctx.fluxo && ctx.fluxo.explicar_fluxo)) {
    s = s.replace(/o valor (exato )?ser[aá] (informado|passado) pelo motorista[^.]*\./i, '').replace(/\s+/g,' ').trim();
  }
  if (!s) s = 'Pode me passar o dado que falta?';
  return s;
}

async function render(contexto) {
  const system = buildSystemPromptVivo();
  const user = buildUserPromptFromContext(contexto);
  const model = process.env.GROQ_MODEL_ANSWER || process.env.GROQ_MODEL || 'llama-3.3-70b-versatile';

  let raw = '';
  try {
    raw = await chatCompletion({
      system,
      user,
      provider: 'groq',
      model,
      task: 'answer',
      timeoutMs: 22000,
      retries: 2
    });
  } catch (e) {
    // Fallback (curto) caso IA falhe
    raw = 'Vamos continuar! Pode enviar o dado para terminar rapidinho?';
  }
  const text = sanitizeAnswer(raw, contexto);
  return text;
}

module.exports = {
  buildSystemPrompt,
  buildUserPrompt,
  parseModelAnswerToDomain,
  render,
  buildSystemPromptVivo
};
