'use strict';

/**
 * flowFretes.js
 *
 * Responsável por decidir a PRÓXIMA AÇÃO do fluxo de atendimento,
 * com base na extração atual (extraction), no estado (state) e no histórico.
 *
 * ESTA CAMADA:
 * - NÃO chama GPT diretamente.
 * - NÃO envia mensagens.
 * - NÃO altera estado em disco (não grava FSM).
 *
 * Ela APENAS analisa:
 *   { perfil, chatId, state, extraction, historico, novasMensagens }
 * e retorna:
 *   { acao: string, instrucoesAcao: string[] }
 * ou null se nenhuma ação for necessária.
 *
 * A geração de texto final será feita por generateFreteReply(),
 * usando acao + instrucoesAcao.
 */

// Helpers internos simples

function digits(s) {
  return String(s || '').replace(/\D/g, '');
}

function isValidBRPhoneWithDDD(num) {
  try {
    const s = digits(num);
    if (!s) return false;
    if (s.length === 11) return /^[1-9]{2}9\d{8}$/.test(s);
    if (s.length === 10) return /^[1-9]{2}[2-9]\d{7}$/.test(s);
    return false;
  } catch {
    return false;
  }
}

function decidirProximaAcao({ perfil, chatId, state, extraction, historico, novasMensagens }) {
  const ex = extraction || {};
  const st = state || {};

  const tel = digits(ex.telefone || '');
  const ddd = digits(ex.ddd || '');
  const parcial = digits(ex.telefone_parcial || '');

  const telOk = !!tel && isValidBRPhoneWithDDD(tel);
  const hasParcialSemDDD = !telOk && !!parcial && parcial.length >= 8 && parcial.length <= 9 && !ddd;
  const hasDDDComParcialIncompleto = !telOk && !!ddd && !!parcial && !hasParcialSemDDD;

  const faltaItens = !ex.itens;
  const faltaSaida = !ex.endereco_saida;
  const faltaDestino = !ex.endereco_destino;

  const isNovoChat = !st.lastIARespondedAt;

  // Se já temos telefone completo e todos os campos básicos (itens/saída/destino), não há ação de fluxo
  if (telOk && !faltaItens && !faltaSaida && !faltaDestino) {
    return null;
  }

  /**
   * AÇÕES DE NOVO CHAT (primeira resposta)
   * Priorizam saudação + explicação + pedido de WhatsApp + próxima pergunta.
   */

  if (isNovoChat) {
    // CASO 1: Novo chat, sem telefone completo
    if (!telOk) {
      // 1.1 Novo chat + NENHUM telefone informado (sem ddd e sem parcial)
      if (!ddd && !parcial) {
        // 1.1.a Sem itens/saída/destino → pedir zap + item
        if (faltaItens && faltaSaida && faltaDestino) {
          return {
            acao: 'SAUDACAO_PEDIR_TEL_E_ITEM',
            instrucoesAcao: [
              '1) Cumprimente de forma simples (por exemplo, "Oi, tudo bem?").',
              '2) Deixe claro que você apenas anota o pedido e quem informa valores e chama no WhatsApp é o motorista.',
              '3) Peça educadamente o WhatsApp do cliente COM DDD.',
              '4) Pergunte o que ele precisa transportar.',
              '5) Não pergunte sobre endereços nem sobre ajudante.'
            ]
          };
        }

        // 1.1.b Já tem itens, mas falta endereço de saída
        if (!faltaItens && faltaSaida) {
          return {
            acao: 'SAUDACAO_PEDIR_TEL_E_SAIDA',
            instrucoesAcao: [
              '1) Cumprimente de forma simples.',
              '2) Explique brevemente que você apenas anota o pedido e quem informa valores e chama no WhatsApp é o motorista.',
              '3) Peça o WhatsApp do cliente COM DDD.',
              '4) Peça o endereço COMPLETO de saída para buscar o item (rua, número, complemento se houver).',
              '5) Não pergunte sobre destino nem sobre ajudante.'
            ]
          };
        }

        // 1.1.c Já tem itens e saída, mas falta destino
        if (!faltaItens && !faltaSaida && faltaDestino) {
          return {
            acao: 'SAUDACAO_PEDIR_TEL_E_DESTINO',
            instrucoesAcao: [
              '1) Cumprimente de forma simples.',
              '2) Explique brevemente que você apenas anota o pedido e quem informa valores e chama no WhatsApp é o motorista.',
              '3) Peça o WhatsApp do cliente COM DDD.',
              '4) Peça o endereço COMPLETO de destino para entrega (rua, número, complemento se houver).',
              '5) Não pergunte sobre ajudante.'
            ]
          };
        }

        // 1.1.d Situações mistas: por padrão, saudação + zap + item
        return {
          acao: 'SAUDACAO_PEDIR_TEL_E_ITEM',
          instrucoesAcao: [
            '1) Cumprimente de forma simples (por exemplo, "Oi, tudo bem?").',
            '2) Deixe claro que você apenas anota o pedido e quem informa valores e chama no WhatsApp é o motorista.',
            '3) Peça o WhatsApp do cliente COM DDD.',
            '4) Pergunte o que ele precisa transportar.',
            '5) Não pergunte sobre endereços nem sobre ajudante.'
          ]
        };
      }

      // 1.2 Novo chat + telefone PARCIAL SEM DDD (8–9 dígitos)
      if (hasParcialSemDDD) {
        // Se não sabemos itens, priorizar item junto com DDD
        if (faltaItens) {
          return {
            acao: 'SAUDACAO_PEDIR_DDD_E_ITEM',
            instrucoesAcao: [
              '1) Cumprimente de forma simples.',
              '2) Explique rapidamente que você apenas anota o pedido e quem informa valores e chama no WhatsApp é o motorista.',
              '3) Diga que já viu o número do cliente, mas faltou o DDD do WhatsApp, e peça para ele informar o DDD.',
              '4) Pergunte também o que ele precisa transportar.',
              '5) Não pergunte sobre endereços nem ajudante.'
            ]
          };
        }

        // Já temos itens, falta saída e/ou destino
        if (!faltaItens && faltaSaida) {
          return {
            acao: 'SAUDACAO_PEDIR_DDD_E_SAIDA',
            instrucoesAcao: [
              '1) Cumprimente de forma simples.',
              '2) Explique rapidamente que você apenas anota o pedido e quem informa valores e chama no WhatsApp é o motorista.',
              '3) Diga que já viu o número do cliente, mas faltou o DDD do WhatsApp, e peça para ele informar o DDD.',
              '4) Peça também o endereço COMPLETO de saída para buscar o item.',
              '5) Não pergunte sobre destino nem ajudante.'
            ]
          };
        }

        if (!faltaItens && !faltaSaida && faltaDestino) {
          return {
            acao: 'SAUDACAO_PEDIR_DDD_E_DESTINO',
            instrucoesAcao: [
              '1) Cumprimente de forma simples.',
              '2) Explique rapidamente que você apenas anota o pedido e quem informa valores e chama no WhatsApp é o motorista.',
              '3) Diga que já viu o número do cliente, mas faltou o DDD do WhatsApp, e peça para ele informar o DDD.',
              '4) Peça também o endereço COMPLETO de destino para entrega.',
              '5) Não pergunte sobre ajudante.'
            ]
          };
        }

        // Caso genérico com parcial sem DDD
        return {
          acao: 'SAUDACAO_PEDIR_DDD_E_ITEM',
          instrucoesAcao: [
            '1) Cumprimente de forma simples.',
            '2) Explique rapidamente que você apenas anota o pedido e quem informa valores e chama no WhatsApp é o motorista.',
            '3) Diga que já viu o número do cliente, mas faltou o DDD do WhatsApp, e peça para ele informar o DDD.',
            '4) Pergunte também o que ele precisa transportar.',
            '5) Não pergunte sobre endereços nem ajudante.'
          ]
        };
      }

      // 1.3 Novo chat + DDD presente + parcial inconsistente/incompleto
      if (hasDDDComParcialIncompleto) {
        return {
          acao: 'SAUDACAO_PEDIR_COMPLEMENTO_TEL',
          instrucoesAcao: [
            '1) Cumprimente de forma simples.',
            '2) Explique rapidamente que você apenas anota o pedido e quem informa valores e chama no WhatsApp é o motorista.',
            '3) Diga que já tem o DDD do cliente e parte do número, mas ainda faltam alguns dígitos para completar o WhatsApp.',
            '4) Peça que o cliente envie o número COMPLETO do WhatsApp com DDD (somente os dígitos).',
            '5) Não pergunte sobre itens nem endereços nesta mensagem.'
          ]
        };
      }
    }

    // CASO 2: Novo chat, MAS telefone já completo (cliente mandou zap logo de cara)
    if (telOk) {
      // Sem itens
      if (faltaItens) {
        return {
          acao: 'NOVO_COM_TEL_PEDIR_ITENS',
          instrucoesAcao: [
            '1) Cumprimente de forma simples.',
            '2) Reforce que você apenas anota o pedido e quem informa valores e chama no WhatsApp é o motorista.',
            '3) Diga que já anotou o WhatsApp dele.',
            '4) Pergunte o que ele precisa transportar.',
            '5) Não peça novamente o WhatsApp nem pergunte ainda sobre endereços ou ajudante.'
          ]
        };
      }

      // Com itens, falta saída
      if (!faltaItens && faltaSaida) {
        return {
          acao: 'NOVO_COM_TEL_PEDIR_SAIDA',
          instrucoesAcao: [
            '1) Cumprimente de forma simples.',
            '2) Reforce que você apenas anota o pedido e quem informa valores e chama no WhatsApp é o motorista.',
            '3) Diga que já anotou o WhatsApp dele.',
            '4) Peça o endereço COMPLETO de saída para buscar o item.',
            '5) Não peça novamente o WhatsApp nem pergunte ainda sobre destino ou ajudante.'
          ]
        };
      }

      // Com itens e saída, falta destino
      if (!faltaItens && !faltaSaida && faltaDestino) {
        return {
          acao: 'NOVO_COM_TEL_PEDIR_DESTINO',
          instrucoesAcao: [
            '1) Cumprimente de forma simples.',
            '2) Reforce que você apenas anota o pedido e quem informa valores e chama no WhatsApp é o motorista.',
            '3) Diga que já anotou o WhatsApp dele.',
            '4) Peça o endereço COMPLETO de destino para entrega.',
            '5) Não peça novamente o WhatsApp nem pergunte sobre ajudante.'
          ]
        };
      }

      // Telefone completo, itens/saída/destino todos preenchidos (já tratado lá em cima => null)
      // Se chegou aqui, use fallback neutro:
      return null;
    }
  }

  /**
   * A partir daqui: NÃO é mais novo chat (já houve resposta da IA antes)
   * Regras gerais de fluxo controlado.
   */

  // 3) Se telefone NÃO está completo, priorizar sempre completar o WhatsApp

  if (!telOk) {
    // 3.1 Sem DDD e sem parcial → pedir WhatsApp completo
    if (!ddd && !parcial) {
      // Escolhe próxima pergunta junto conforme dados faltantes
      if (faltaItens && faltaSaida && faltaDestino) {
        return {
          acao: 'PEDIR_TEL_E_ITEM',
          instrucoesAcao: [
            '1) Reforce que você apenas anota o pedido e quem informa valores e chama no WhatsApp é o motorista.',
            '2) Peça o WhatsApp do cliente COM DDD (somente os dígitos).',
            '3) Pergunte também o que ele precisa transportar.',
            '4) Não pergunte sobre endereços nem sobre ajudante.'
          ]
        };
      }

      if (!faltaItens && faltaSaida) {
        return {
          acao: 'PEDIR_TEL_E_SAIDA',
          instrucoesAcao: [
            '1) Reforce que você apenas anota o pedido e quem informa valores e chama no WhatsApp é o motorista.',
            '2) Peça o WhatsApp do cliente COM DDD (somente os dígitos).',
            '3) Peça também o endereço COMPLETO de saída para buscar o item.',
            '4) Não pergunte sobre destino nem ajudante.'
          ]
        };
      }

      if (!faltaItens && !faltaSaida && faltaDestino) {
        return {
          acao: 'PEDIR_TEL_E_DESTINO',
          instrucoesAcao: [
            '1) Reforce que você apenas anota o pedido e quem informa valores e chama no WhatsApp é o motorista.',
            '2) Peça o WhatsApp do cliente COM DDD (somente os dígitos).',
            '3) Peça também o endereço COMPLETO de destino para entrega.',
            '4) Não pergunte sobre ajudante.'
          ]
        };
      }

      // Fallback: pedir apenas o WhatsApp completo
      return {
        acao: 'PEDIR_TEL_COMPLETO',
        instrucoesAcao: [
          '1) Reforce que você apenas anota o pedido e quem informa valores e chama no WhatsApp é o motorista.',
          '2) Peça apenas o WhatsApp do cliente COM DDD (somente os dígitos).',
          '3) Não repita perguntas sobre itens ou endereços nesta mensagem.',
          '4) Não pergunte sobre ajudante.'
        ]
      };
    }

    // 3.2 Telefone parcial (8–9 dígitos) e sem DDD → pedir DDD + próxima pergunta
    if (hasParcialSemDDD) {
      if (faltaItens) {
        return {
          acao: 'PEDIR_DDD_E_ITEM',
          instrucoesAcao: [
            '1) Reforce que você apenas anota o pedido e quem informa valores e chama no WhatsApp é o motorista.',
            '2) Diga que já recebeu o número do cliente, mas faltou o DDD.',
            '3) Peça o DDD do WhatsApp.',
            '4) Pergunte também o que ele precisa transportar.',
            '5) Não pergunte sobre endereços nem ajudante.'
          ]
        };
      }

      if (!faltaItens && faltaSaida) {
        return {
          acao: 'PEDIR_DDD_E_SAIDA',
          instrucoesAcao: [
            '1) Reforce que você apenas anota o pedido e quem informa valores e chama no WhatsApp é o motorista.',
            '2) Diga que já recebeu o número do cliente, mas faltou o DDD.',
            '3) Peça o DDD do WhatsApp.',
            '4) Peça também o endereço COMPLETO de saída para buscar o item.',
            '5) Não pergunte sobre destino nem ajudante.'
          ]
        };
      }

      if (!faltaItens && !faltaSaida && faltaDestino) {
        return {
          acao: 'PEDIR_DDD_E_DESTINO',
          instrucoesAcao: [
            '1) Reforce que você apenas anota o pedido e quem informa valores e chama no WhatsApp é o motorista.',
            '2) Diga que já recebeu o número do cliente, mas faltou o DDD.',
            '3) Peça o DDD do WhatsApp.',
            '4) Peça também o endereço COMPLETO de destino para entrega.',
            '5) Não pergunte sobre ajudante.'
          ]
        };
      }

      return {
        acao: 'PEDIR_DDD_SIMPLES',
        instrucoesAcao: [
          '1) Reforce que você apenas anota o pedido e quem informa valores e chama no WhatsApp é o motorista.',
          '2) Diga que já recebeu o número do cliente, mas faltou o DDD.',
          '3) Peça APENAS o DDD do WhatsApp.',
          '4) Não pergunte sobre itens, endereços ou ajudante nesta mensagem.'
        ]
      };
    }

    // 3.3 Temos DDD e parcial, mas telefone não validou como completo (solicitar complemento)
    if (hasDDDComParcialIncompleto) {
      return {
        acao: 'PEDIR_COMPLEMENTO_TEL',
        instrucoesAcao: [
          '1) Reforce que você apenas anota o pedido e quem informa valores e chama no WhatsApp é o motorista.',
          '2) Diga que já tem o DDD e parte do número do cliente, mas ainda faltam alguns dígitos.',
          '3) Peça que ele envie o número COMPLETO do WhatsApp com DDD (somente os dígitos).',
          '4) Não pergunte sobre itens, endereços ou ajudante nesta mensagem.'
        ]
      };
    }
  }

  /**
   * 4) Telefone COMPLETO: agora só falta coletar o que estiver em aberto (itens/saída/destino),
   *    um de cada vez, SEM repetir telefone.
   */

  if (telOk) {
    if (faltaItens) {
      return {
        acao: 'PEDIR_ITEM',
        instrucoesAcao: [
          '1) Reforce rapidamente que você apenas anota o pedido e quem informa valores e chama no WhatsApp é o motorista.',
          '2) NÃO peça novamente o WhatsApp.',
          '3) Pergunte APENAS o que o cliente precisa transportar.',
          '4) Não pergunte sobre endereços nem ajudante.'
        ]
      };
    }

    if (!faltaItens && faltaSaida) {
      return {
        acao: 'PEDIR_SAIDA',
        instrucoesAcao: [
          '1) Reforce rapidamente que você apenas anota o pedido e quem informa valores e chama no WhatsApp é o motorista.',
          '2) NÃO peça novamente o WhatsApp.',
          '3) Peça APENAS o endereço COMPLETO de saída para buscar o item (rua, número, complemento se houver).',
          '4) Não pergunte sobre destino nem ajudante.'
        ]
      };
    }

    if (!faltaItens && !faltaSaida && faltaDestino) {
      return {
        acao: 'PEDIR_DESTINO',
        instrucoesAcao: [
          '1) Reforce rapidamente que você apenas anota o pedido e quem informa valores e chama no WhatsApp é o motorista.',
          '2) NÃO peça novamente o WhatsApp.',
          '3) Peça APENAS o endereço COMPLETO de destino para entrega (rua, número, complemento se houver).',
          '4) Não pergunte sobre ajudante.'
        ]
      };
    }
  }

  // 5) Se nenhuma regra específica bater, não fazer nada neste ciclo
  return null;
}

module.exports = { decidirProximaAcao };

