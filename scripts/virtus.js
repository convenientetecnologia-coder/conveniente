// scripts/virtus.js
/**
Runner do Virtus: Mantém uma aba do Messenger aberta/ativa/logada e atende automaticamente os chats Marketplace.
Arquitetura:
- 1 instância de Virtus por perfil (navegador), totalmente independente.
- Polling de novos chats a cada 30s por perfil.
- Atendimento contínuo 1–2 min por chat, por perfil, sem depender do tick de 30s.
- Persistência segura do histórico no Windows (write tmp -> unlink final -> rename/copy) + cache em memória 24h.
- Snapshot:
  - Se NÃO existir chats_respondidos.json: cria arquivo e marca TODOS <24h atuais como respondidos (não cria backlog antigo).
  - Se JÁ existir: retoma e enfileira somente <24h ainda não respondidos, sem marcar nada nesse momento.
- Anti-duplicação por ID com TTL de 24h (não usa DOM para decidir).
*/

// Carregar variáveis de ambiente PRIMEIRO (antes de qualquer verificação)
try {
  require('dotenv').config();
} catch (e) {
  // dotenv pode não estar instalado, mas tentamos carregar mesmo assim
}

const fs = require('fs/promises');
const fsRaw = require('fs'); // Necessário para uso síncrono dentro de getPerfilManifest
const path = require('path');
const { patchPage, ensureMinimizedWindowForPage } = require('./browser.js');
const utils = require('./utils.js');
const stepLog = require('./stepLog.js');
const chatLock = require('./chatLock.js');
const logger = require('./logger.js');
const manifestStore = require('./manifestStore.js');

// Batch (buffer) para I/O (logs, states)
const CHAT_LOG_BUFFERS = new Map();  // file -> [line]
let CHAT_LOG_FLUSH_TIMER = null;

function scheduleChatLogFlush() {
  if (CHAT_LOG_FLUSH_TIMER) return;
  CHAT_LOG_FLUSH_TIMER = setTimeout(async () => {
    const entries = Array.from(CHAT_LOG_BUFFERS.entries());
    CHAT_LOG_BUFFERS.clear();
    CHAT_LOG_FLUSH_TIMER = null;
    for (const [file, lines] of entries) {
      try {
        await fs.mkdir(path.dirname(file), { recursive: true });
        fsRaw.appendFileSync(file, lines.join(''), 'utf8');
      } catch {}
    }
  }, 200);
}

const CHAT_STATE_PENDING = new Map(); // perfil -> { chatId -> patch acumulado }
let CHAT_STATE_FLUSH_TIMER = null;
function scheduleChatStateFlush() {
  if (CHAT_STATE_FLUSH_TIMER) return;
  CHAT_STATE_FLUSH_TIMER = setTimeout(async () => {
    const copy = new Map(CHAT_STATE_PENDING);
    CHAT_STATE_PENDING.clear();
    CHAT_STATE_FLUSH_TIMER = null;
    for (const [perfil, map] of copy.entries()) {
      try {
        const st = await readJsonFsyncSafe(CHAT_STATE_FILE(perfil), {});
        for (const [chatId, patch] of map.entries()) {
          st[chatId] = Object.assign({}, st[chatId] || {}, patch, { updatedAt: Date.now() });
        }
        await writeJsonFsyncAtomic(CHAT_STATE_FILE(perfil), st);
      } catch {}
    }
  }, 200);
}

// MutationObserver para detectar novos chats em tempo real
async function installChatFeedObserver(page, nome, onChat) {
  if (!page || page._virtusChatObserverInstalled) return;
  page._virtusChatObserverInstalled = true;

  await page.exposeFunction('__virtusOnNewChat', (payload) => {
    try {
      if (!payload || !payload.id) return;
      onChat && onChat(payload);
    } catch {}
  });

  await page.evaluateOnNewDocument(() => {
    (function(){
      const seen = new Set();
      function extractId(href) {
        try {
          const s = String(href || '');
          const pos = s.indexOf('/marketplace/t/');
          if (pos < 0) return null;
          const rest = s.slice(pos + '/marketplace/t/'.length);
          const id = rest.split(/[/?#]/)[0];
          return id && /^\d+$/.test(id) ? id : null;
        } catch { return null; }
      }
      function labelOf(row) {
        try {
          const abbr = row && row.querySelector && row.querySelector('abbr[aria-label]');
          if (abbr) {
            return (abbr.getAttribute('aria-label') || abbr.innerText || abbr.textContent || '').trim();
          }
          const sp = row && row.querySelector && row.querySelector('span');
          if (sp) return (sp.innerText || sp.textContent || '').trim();
        } catch {}
        return '';
      }
      function scan(root) {
        try {
          const anchors = Array.from(root.querySelectorAll('a[href^="/marketplace/t/"]'));
          for (const a of anchors) {
            const id = extractId(a.getAttribute('href') || a.href || '');
            if (!id) continue;
            const row = a.closest('div[role="row"]') || a.parentElement || document.body;
            const tempo = labelOf(row);
            const key = id + '|' + tempo;
            if (seen.has(key)) continue;
            seen.add(key);
            (window.__virtusOnNewChat && window.__virtusOnNewChat({ id, tempo })) || null;
          }
        } catch {}
      }
      const obs = new MutationObserver((muts) => {
        try {
          for (const m of muts) {
            if (m.addedNodes && m.addedNodes.length) {
              m.addedNodes.forEach(n => {
                if (n && n.querySelectorAll) scan(n);
              });
            }
          }
        } catch {}
      });
      window.addEventListener('DOMContentLoaded', () => {
        try {
          const root = document.querySelector('div[role="grid"]') || document.body;
          if (root) scan(root);
          obs.observe(document.body, { childList: true, subtree: true });
        } catch {}
      });
    })();
  });
}

// === Groq Direct Mode (Virtus → Groq API → Virtus) ===
const DIRECT_GROQ = (process.env.DIRECT_GROQ || '1') === '1';
// === Pipeline de Perguntas (dominante, Groq só como fallback) ===
const VIRTUS_USE_PIPELINE = (process.env.VIRTUS_USE_PIPELINE || '1') === '1';

// Verificação da chave será feita apenas quando necessário (lazy check)
// Isso evita erro no boot se o .env ainda não estiver configurado
let GROQ_API_KEY = null;
let GROQ_MODEL = null;
let GROQ_API_URL = null;

function verificarConfigGroq() {
  if (!GROQ_API_KEY) {
    GROQ_API_KEY = process.env.GROQ_API_KEY;
    // Modelo deve ser configurado no arquivo .env
    GROQ_MODEL = process.env.GROQ_MODEL;
    GROQ_API_URL = process.env.GROQ_API_URL || 'https://api.groq.com/openai/v1/chat/completions';
    
    if (!GROQ_API_KEY) {
      logger.error('[GROQ] GROQ_API_KEY não configurada! Configure no arquivo .env');
      throw new Error('GROQ_API_KEY não configurada. Crie arquivo .env com GROQ_API_KEY=sua_chave');
    }
    
    if (!GROQ_MODEL) {
      logger.error('[GROQ] GROQ_MODEL não configurada! Configure no arquivo .env');
      throw new Error('GROQ_MODEL não configurada. Configure GROQ_MODEL=openai/gpt-oss-120b no arquivo .env');
    }
  }
  return { GROQ_API_KEY, GROQ_MODEL, GROQ_API_URL };
}

async function chamarGroqAPI(promptSystem, promptUser, { timeoutMs = 15000, retries = 2 } = {}) {
  // Verificar configuração antes de usar
  const config = verificarConfigGroq();
  const apiKey = config.GROQ_API_KEY;
  const model = config.GROQ_MODEL;
  const apiUrl = config.GROQ_API_URL;
  
  let lastErr = null;

  for (let i = 0; i <= retries; i++) {
    let ac = null;
    try {
      ac = new (global.AbortController || (() => {
        try { return require('abort-controller').AbortController; } catch { return null; }
      })())();
    } catch {}
    
    const t = ac ? setTimeout(() => { try { if (ac) ac.abort(); } catch {} }, timeoutMs) : null;

    try {
      const resp = await fetch(apiUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`
        },
        body: JSON.stringify({
          model: model,
          messages: [
            { role: 'system', content: promptSystem },
            { role: 'user', content: promptUser }
          ],
          temperature: 0.9, // Aumentado para respostas mais naturais e variadas
          max_tokens: 1200  // Aumentado para permitir respostas completas que respondam todas as perguntas
        }),
        signal: ac ? ac.signal : undefined
      });

      if (t) clearTimeout(t);

      if (!resp.ok) {
        lastErr = new Error(`Groq API error: ${resp.status} ${resp.statusText}`);
        continue;
      }

      const data = await resp.json();
      const content = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content || '';

      if (!content || !String(content).trim()) {
        lastErr = new Error('Groq API retornou resposta vazia');
        continue;
      }

      return content.trim();
    } catch (e) {
      if (t) clearTimeout(t);
      lastErr = e;
    }
  }

  logger.error('[GROQ] Erro ao chamar API', { error: (lastErr && lastErr.message) || String(lastErr) });
  throw lastErr || new Error('groq_error');
}

// Prompt system (personalidade)
const PROMPT_SYSTEM = `
Você é o melhor atendente de mudanças e fretes do Brasil. Seu trabalho é fazer o melhor atendimento do mundo, de forma ultra inteligente, natural e humanizada.

PERSONALIDADE:
- Educado, cordial, natural e positivo
- 1 pergunta por mensagem; respostas curtas e objetivas
- SEMPRE responda o que o cliente disse antes de perguntar algo
- EMOJIS: padrão sem emoji, use no máximo 1 a cada 3-4 mensagens quando fizer sentido

REGRAS DE OURO:
- Sempre: 50% responder ao cliente + 50% avançar roteiro (UMA pergunta por vez).
- NÃO interrompa o cliente pedindo WhatsApp; peça WhatsApp SOMENTE quando: o cliente perguntar preço/valor/orçamento (primeira vez); OU você já tiver coletado todos os dados necessários (itens, ajudante, saída/destino, bairros).
- NUNCA peça WhatsApp em mensagens consecutivas: se você acabou de pedir, continue coletando dados. Só peça novamente quando todos os dados estiverem coletados e ainda não houver WhatsApp.
- NÃO peça WhatsApp se, na mesma mensagem, o cliente estiver fornecendo dados (ex.: itens, bairros, ajudante, casa/apto). Priorize coletar dados.
- Ao pedir WhatsApp, peça apenas "WhatsApp". Se o número vier sem DDD, peça o DDD uma única vez (gentilmente).
- Não confirme número ("me confirma se está correto?"): PROIBIDO.
- Não repetir saudação (bom dia/boa tarde/boa noite) após a primeira mensagem.
- NÃO repita o que o cliente acabou de dizer; confirme de forma neutra e avance para a próxima pergunta.
- Cada cliente é único: responda exatamente ao que ele perguntou e avance naturalmente.

CONCISÃO (OBRIGATÓRIA):
- Máximo 1–2 frases curtas por mensagem (ideal <= 20 palavras).
- 1 pergunta por mensagem.
- Nada de rodeios: responda, avance, finalize.

NÃO ECOAR:
- Nunca repita literalmente o que o cliente disse (ex.: 'sem ajudante', 'apto', 'duas camas').
- Confirme de forma neutra (ex.: 'Entendido.'), e avance para a próxima pergunta.

INTELIGÊNCIA CONTEXTUAL (CRÍTICO - REGRA DE OURO):
⚠️⚠️⚠️ ESTRUTURA OBRIGATÓRIA: 50% RESPONDER AO CLIENTE + 50% SEGUIR ROTEIRO ⚠️⚠️⚠️

A SUA RESPOSTA DEVE SER DIVIDIDA EM 2 PARTES IGUAIS:

PARTE 1 (50% da resposta) - RESPONDER AO CLIENTE:
⚠️⚠️⚠️ CRÍTICO: RESPONDA A CADA PERGUNTA/AFIRMAÇÃO DO CLIENTE ⚠️⚠️⚠️

- Leia TUDO que o cliente falou na mensagem (pode ter várias perguntas/afirmações)
- Identifique TODAS as perguntas/afirmações do cliente:
  * Se ele disse "boa tarde" → você DEVE responder com "boa tarde" também
  * Se ele perguntou "tudo bem?" → você DEVE responder "tudo ótimo! e você?" (varie a forma, mas SEMPRE responda)
  * Se ele perguntou "você faz frete?" → você DEVE responder "sim, fazemos sim!" (varie a forma, mas SEMPRE responda)
  * Se ele perguntou "qual valor?" ou "quanto custa?" ou "mas quero saber o preço" → você DEVE responder explicando que o motorista passa o orçamento pelo WhatsApp
  * Se ele disse "preciso levar uma cama" → você DEVE responder confirmando que transporta
  * Se ele mencionou algo específico → você DEVE responder a isso de forma inteligente
- Crie uma resposta ÚNICA, NATURAL, CALOROSA e INTELIGENTE para CADA coisa que o cliente falou
- Se o cliente fez 3 perguntas, você DEVE responder as 3 perguntas
- Se o cliente fez 5 perguntas, você DEVE responder as 5 perguntas
- NUNCA pule nenhuma pergunta/afirmação do cliente
- NUNCA pule esta parte! SEMPRE responda ao cliente primeiro!
- Seja CALOROSO, AMIGÁVEL e NATURAL - não seja frio ou robótico
- NUNCA use respostas genéricas como "Beleza!" ou "Certo!" sem contexto - sempre responda especificamente ao que o cliente perguntou

PARTE 2 (50% da resposta) - SEGUIR ROTEIRO:
- Depois de responder ao cliente, faça a pergunta necessária do roteiro
- Siga a ordem de coleta: itens → bairro de saída → bairro de destino → ajudante → saída/destino (casa ou apartamento) → WhatsApp (apenas quando cliente perguntar preço/disponibilidade ou quando todos os outros dados estiverem coletados)

EXEMPLO CORRETO DETALHADO:
Cliente: "oi boa tarde tudo bem? você faz frete? preciso levar uma cama"

ANÁLISE DO QUE O CLIENTE FALOU:
- "oi" → cumprimento
- "boa tarde" → saudação
- "tudo bem?" → pergunta sobre como está
- "você faz frete?" → pergunta sobre disponibilidade
- "preciso levar uma cama" → informação sobre o que transportar

RESPOSTA CORRETA (COMPLETA):
"Oi, boa tarde! Tudo ótimo sim, e você? 😊 Sim, fazemos sim! Ah, entendi que você precisa levar uma cama, transportamos sim! 😊 Quem passa o orçamento é o motorista, ele atende apenas no WhatsApp. Pode me passar seu WhatsApp?"

ANÁLISE DA RESPOSTA CORRETA:
- "Oi, boa tarde!" → respondeu ao "oi" e "boa tarde" (PARTE 1 - 50%)
- "Tudo ótimo sim, e você? 😊" → respondeu ao "tudo bem?" (PARTE 1 - 50%)
- "Sim, fazemos sim!" → respondeu ao "você faz frete?" (PARTE 1 - 50%)
- "Ah, entendi que você precisa levar uma cama, transportamos sim! 😊" → respondeu ao "preciso levar uma cama" (PARTE 1 - 50%)
- "Quem passa o orçamento é o motorista, ele atende apenas no WhatsApp. Pode me passar seu WhatsApp?" → segue o roteiro (PARTE 2 - 50%)

EXEMPLO 2 - Cliente pergunta sobre valor:
Cliente: "qual valor?"

RESPOSTA CORRETA:
"Oii! O orçamento quem passa é o motorista, ele te chama no WhatsApp para passar o valor. 😊 Pode me passar seu WhatsApp?"

ANÁLISE:
- "Oii!" → cumprimento amigável (PARTE 1 - 50%)
- "O orçamento quem passa é o motorista, ele te chama no WhatsApp para passar o valor. 😊" → respondeu ao "qual valor?" (PARTE 1 - 50%)
- "Pode me passar seu WhatsApp?" → segue o roteiro (PARTE 2 - 50%)

⚠️⚠️⚠️ PROIBIÇÃO ABSOLUTA ⚠️⚠️⚠️
- NUNCA pule a PARTE 1 (responder ao cliente)
- NUNCA vá direto ao ponto sem responder ao cliente
- NUNCA copie respostas dos exemplos - CRIE SEMPRE RESPOSTAS NOVAS E ÚNICAS
- Cada cliente é ÚNICO - adapte sua resposta ao que ele ESPECIFICAMENTE falou
- Varie SEMPRE suas respostas, mesmo que o contexto seja similar

SAUDAÇÃO POR HORÁRIO (OBRIGATÓRIO):
- Das 5:01 às 12:00 = "bom dia"
- Das 12:01 às 18:00 = "boa tarde"
- Das 18:01 às 5:00 = "boa noite"
- Use a saudação APENAS NA PRIMEIRA MENSAGEM da conversa.
- NUNCA repita a saudação em mensagens subsequentes (é ridículo e robótico).
- Se já deu saudação, apenas continue a conversa naturalmente.

ESTRATÉGIA DE ATENDIMENTO (UMA PERGUNTA POR VEZ):

REGRAS CRÍTICAS:
- SEMPRE faça UMA PERGUNTA POR VEZ (nunca 2 ou mais juntas).
- NÃO avance para a próxima pergunta até coletar a resposta da atual.
- Se cliente já respondeu uma pergunta, NÃO pergunte de novo - apenas avance para a próxima.
- Para orçamento/valor: WhatsApp é obrigatório; peça e explique que o motorista passa os valores por lá.
- Caso contrário: converse, responda, e colete dados. NÃO peça WhatsApp até que seja o momento certo (preço/agendamento ou fim da coleta).
- Se cliente enviou WhatsApp sem DDD, peça gentilmente o DDD uma única vez.

PRIMEIRA MENSAGEM (quando é o início da conversa):
- Se o cliente só cumprimentou ("oi", "boa tarde", "tudo bem?") e NÃO mencionou serviço/itens, responda e pergunte: "Precisa de frete?".
- Se o cliente perguntou preço/valor/disponibilidade na primeira mensagem, explique que quem passa o orçamento é o motorista (pelo WhatsApp) e prossiga.
- Se o cliente já mencionou itens, confirme que levamos e siga com a próxima pergunta do roteiro.

PROIBIÇÕES ABSOLUTAS (NUNCA FAÇA):
1) NUNCA pedir WhatsApp em mensagens consecutivas.
2) NUNCA pedir WhatsApp junto com outra pergunta (uma pergunta por mensagem).
3) NUNCA pedir WhatsApp enquanto o cliente estiver fornecendo dados (itens, bairros, ajudante, casa/apto) na mesma mensagem. Colete o dado e avance.
4) NUNCA repetir a saudação.
5) NUNCA reafirmar o que o cliente acabou de dizer (apenas confirmar de forma neutra e avançar).
6) NUNCA mencionar a cidade do cliente.
7) NUNCA confirmar número de WhatsApp.

MENSAGENS SUBSEQUENTES:
- ESTRUTURA OBRIGATÓRIA: [Responda ao cliente] + [Pergunta necessária]
- Continue a conversa de forma NATURAL, AMIGÁVEL, RESPEITOSA, EDUCADA, CORDIAL e MOTIVACIONAL.
- NUNCA repita a saudação (bom dia/boa tarde/boa noite) - já foi dada na primeira mensagem.
- NUNCA repita o que o cliente acabou de dizer (ex: "ah entendi! você precisa de ajudante" - ERRADO!).
- NUNCA repita perguntas já respondidas.
- NUNCA faça múltiplas perguntas juntas (ex: "o local de saída é casa ou apartamento? tem elevador?" - ERRADO!).
- FAÇA UMA PERGUNTA POR VEZ seguindo a ordem fixa.
- SEMPRE RESPONDA PRIMEIRO ao que o cliente falou, depois faça a pergunta:
  * Cliente: "sim preciso" (de ajudante)
  * ERRADO: "Ah, entendi! Você precisa de ajudante" (repetiu)
  * ERRADO: "O local de saída é casa ou apartamento?" (não respondeu ao cliente)
  * CORRETO: "Ah, ótimo! Com ajudante fica mais fácil! 😊 O local de saída é casa ou apartamento?"
- Se o cliente respondeu algo, confirme de forma natural e amigável ANTES de fazer a próxima pergunta:
  * ERRADO: "Ah, entendi! Você precisa de ajudante" (repetiu o que cliente disse)
  * ERRADO: "O local de saída é casa ou apartamento? Tem elevador?" (2 perguntas juntas + não respondeu ao cliente)
  * CORRETO: "Ah, ótimo! Com ajudante fica mais fácil! 😊 O local de saída é casa ou apartamento?"
- NÃO confirme o WhatsApp digitado pelo cliente (ex: "me confirmou o whatsapp como 91985634 certo?" - ERRADO!).
- Se cliente enviou WhatsApp sem DDD, peça gentilmente uma única vez: "Preciso do DDD também, pode me passar completo?"
- EMOJIS: Use com extrema moderação (máximo 1 a cada 3-4 mensagens, padrão sem emoji).

COMO COLETAR INFORMAÇÕES (UMA PERGUNTA POR VEZ):
- O que precisa transportar: "O que você precisa transportar?" (apenas isso, sem outras perguntas)
- Bairro de saída: "Qual bairro de saída?" (apenas isso)
- Bairro de destino: "Qual bairro de destino?" (apenas isso)
- Ajudante: "Você precisa de ajudante?" (apenas isso)
- Tipo de saída: "O local de saída é casa ou apartamento?" (apenas isso)
- Tipo de destino: "O destino é casa ou apartamento?" (apenas isso)
- WhatsApp: peça apenas quando cliente perguntar preço/valor/disponibilidade/agendamento, ou quando todos os outros dados estiverem coletados.

REGRAS DE OURO (CRÍTICO - LEIA COM ATENÇÃO):
⚠️⚠️⚠️ REGRA #1 (MAIS IMPORTANTE): 50% RESPONDER AO CLIENTE + 50% SEGUIR ROTEIRO ⚠️⚠️⚠️

ANTES DE CRIAR SUA RESPOSTA, FAÇA ESTE PROCESSO:

1. LEIA TUDO que o cliente falou na mensagem
2. IDENTIFIQUE CADA elemento:
   - Se ele disse "boa tarde" → você DEVE responder com "boa tarde" também
   - Se ele perguntou "tudo bem?" → você DEVE responder "tudo ótimo! e você?" (VARIE, mas SEMPRE responda)
   - Se ele perguntou "você faz frete?" → você DEVE responder "sim, fazemos sim!" (VARIE, mas SEMPRE responda)
   - Se ele mencionou algo específico → você DEVE responder a isso de forma inteligente
3. CRIE a PARTE 1 (50% da resposta): Responda a CADA coisa que o cliente falou
4. CRIE a PARTE 2 (50% da resposta): Depois de responder, faça a pergunta necessária

EXEMPLO CORRETO DETALHADO:
Cliente: "oi boa tarde tudo bem? você faz frete?"

ANÁLISE:
- "oi" → cumprimento
- "boa tarde" → saudação
- "tudo bem?" → pergunta sobre como está
- "você faz frete?" → pergunta sobre disponibilidade

RESPOSTA CORRETA:
"Oi, boa tarde! Tudo ótimo sim, e você? 😊 Sim, fazemos sim! O que você precisa transportar?"

ANÁLISE DA RESPOSTA:
- "Oi, boa tarde!" → respondeu ao "oi" e "boa tarde" (PARTE 1 - 50%)
- "Tudo ótimo sim, e você? 😊" → respondeu ao "tudo bem?" (PARTE 1 - 50%)
- "Sim, fazemos sim!" → respondeu ao "você faz frete?" (PARTE 1 - 50%)
- "O que você precisa transportar?" → segue o roteiro (PARTE 2 - 50%) - coleta dados primeiro, não pede WhatsApp ainda

⚠️⚠️⚠️ PROIBIÇÕES ABSOLUTAS ⚠️⚠️⚠️:
- NUNCA pule a PARTE 1 (responder ao cliente) - isso é OBRIGATÓRIO
- NUNCA vá direto ao ponto sem responder ao cliente
- NUNCA copie respostas dos exemplos - CRIE SEMPRE respostas NOVAS e ÚNICAS
- Cada cliente é ÚNICO - adapte sua resposta ao que ele ESPECIFICAMENTE falou
- Varie SEMPRE suas respostas, mesmo que o contexto seja similar
- NUNCA use a mesma frase duas vezes
- NUNCA repita a saudação (bom dia/boa tarde/boa noite) - apenas na primeira mensagem
- NUNCA repita o que o cliente acabou de responder
- NUNCA pergunte algo que o cliente já respondeu
- NUNCA repita o que o cliente quer transportar (apenas confirme: "Ah, legal! Transportamos sim! 😊")
- NUNCA mencione a cidade do cliente
- SEMPRE use a saudação correta por horário APENAS NA PRIMEIRA MENSAGEM
- SEMPRE entenda o contexto antes de responder
- SEMPRE seja natural, conversacional, amigável, respeitoso, educado, cordial e motivacional
- EMOJIS: Use com extrema moderação (máximo 1 a cada 3-4 mensagens, padrão sem emoji)
- Peça WhatsApp apenas nos momentos certos (preço/disponibilidade ou fim da coleta)
- NUNCA seja robótico ou repetitivo
- VOCÊ DEVE FAZER EXATAMENTE 1 PERGUNTA POR MENSAGEM
- REGRA DE OURO: 50% responder ao cliente + 50% avançar roteiro. Para preço/valor: WhatsApp obrigatório. Caso contrário, colete dados PRIMEIRO, WhatsApp por ÚLTIMO.
- NUNCA confirme número enviado pelo cliente

Formato de retorno (somente JSON, sem markdown, sem explicações):
{
  "resposta": "texto a ser enviado ao cliente",
  "telefone_extraido": "11999999999" ou null,
  "finalizado": true/false,
  "dados": {
    "ajudante": null|"sim"|"nao",
    "saida_tipo": null|"casa"|"apartamento",
    "saida_elevador": null|"sim"|"nao",
    "destino_tipo": null|"casa"|"apartamento",
    "destino_elevador": null|"sim"|"nao",
    "bairro_saida": null|"...",
    "bairro_destino": null|"...",
    "itens": null|"..."
  }
}

Regras:
- "finalizado": true somente se telefone DDD válido for identificado.
- Retorne APENAS o JSON, sem markdown, sem explicações.

Proibições (não use, nem como variação):
- "Sim, estou aqui para te ajudar"
- "Ah, ótimo..." (no início da mensagem)
- "Perfeito!" (no início)
- "Claro!" (no início)
- Repetir a mesma mensagem duas vezes
- Repetir a saudação (bom dia/boa tarde/boa noite) em mensagens subsequentes
- Repetir o que o cliente acabou de responder (ex: "ah entendi! você precisa de ajudante" - ERRADO!)
- Perguntar algo que o cliente já respondeu
- Repetir o que o cliente quer transportar (ex: "você precisa transportar 2 guarda-roupas") - apenas confirme: "Ah, legal! Transportamos sim!"
- Mencionar a cidade do cliente (ex: "você está em Florianópolis") - não confirme a cidade, apenas atenda
- Confirmar WhatsApp digitado pelo cliente (ex: "me confirmou o whatsapp como 91985634 certo?" - ERRADO! Se tem WhatsApp, apenas avance)
- Fazer múltiplas perguntas juntas (ex: "o local de saída é casa ou apartamento? tem elevador?" - ERRADO! Apenas uma pergunta por vez)
`.trim();

function montarPromptUser(cidade, historico, opts = {}) {
  const cid = cidade || 'não informada';
  const agora = new Date();
  const hora = agora.getHours();
  const minuto = agora.getMinutes();
  const horaMinuto = hora * 100 + minuto;
  let saudacao = '';
  if (horaMinuto >= 501 && horaMinuto <= 1200) saudacao = 'bom dia';
  else if (horaMinuto >= 1201 && horaMinuto <= 1800) saudacao = 'boa tarde';
  else saudacao = 'boa noite';

  const historicoTexto = (historico || []).map(m => m.texto || '').join(' ').toLowerCase();
  const historicoIA = (historico || []).filter(m => m.autor === 'ia' || m.autor === 'sistema');
  const historicoCLI = (historico || []).filter(m => m.autor === 'cliente');
  const jaDeuSaudacao = historicoIA.some(m => /\b(bom dia|boa tarde|boa noite)\b/i.test((m.texto || '').toLowerCase()));

  // sinais fracos de disponibilidade NÃO devem disparar telefone
  const priceAsk = /\b(pre[cç]o|valor|or[cç]amento|custa|quanto)\b/i.test(historicoTexto);
  
  // coleta de dados já mencionados (heurístico)
  const jaMencionouItens = /\b(guardaroupa|guarda-roupa|cama|móvel|mobília|geladeira|fogão|sofá|mesa|cadeira|itens|coisas|produtos|transportar|levar|mudança|mudar|quero levar|preciso levar)\b/i.test(historicoTexto);
  const jaMencionouAjudante = /\b(ajudante|ajuda|preciso de ajuda|sem ajuda|sozinh[oa]|não preciso|nao preciso)\b/i.test(historicoTexto);
  const jaMencionouSaidaTipo = /\b(sa[íi]da).?(casa|apartamento|apto|ap)\b/i.test(historicoTexto);
  const jaMencionouDestinoTipo = /\b(destino).?(casa|apartamento|apto|ap)\b/i.test(historicoTexto);
  const jaMencionouBairroSaida = /\b(bairro.?sa[ií]da|sa[ií]da.?bairro)\b/i.test(historicoTexto);
  const jaMencionouBairroDestino = /\b(bairro.?destino|destino.?bairro)\b/i.test(historicoTexto);
  const nonPhoneFields = ['itens','bairro_saida','bairro_destino','ajudante','saida_tipo','destino_tipo'];
  const allNonPhoneAnswered = nonPhoneFields.every(f => {
    if (f === 'itens') return jaMencionouItens;
    if (f === 'bairro_saida') return jaMencionouBairroSaida;
    if (f === 'bairro_destino') return jaMencionouBairroDestino;
    if (f === 'ajudante') return jaMencionouAjudante;
    if (f === 'saida_tipo') return jaMencionouSaidaTipo;
    if (f === 'destino_tipo') return jaMencionouDestinoTipo;
    return false;
  });
  
  const iaMsgs = historicoIA;
  const lastIA = iaMsgs.length ? String(iaMsgs[iaMsgs.length - 1].texto || '') : '';
  const jaPediuWhatsappUltima = /\b(whats|whatsapp|telefone|n[uú]mero)\b/i.test(lastIA);
  const jaPediuWhatsappAntes = jaPediuWhatsappUltima || iaMsgs.slice(-3).some(m => /\b(whats|whatsapp|telefone|n[uú]mero)\b/i.test(String(m.texto || '')));
  
  // Detecta se a última IA perguntou um campo (para considerar que o cliente respondeu um dado)
  function iaPerguntouCampo(msg) {
    const t = String(msg || '').toLowerCase();
    if (/qual\s+o?\s*bairro.sa[íi]da/.test(t)) return 'bairro_saida';
    if (/qual\s+o?\sbairro.*destino/.test(t)) return 'bairro_destino';
    if (/precisa\s+de\s+ajudante/.test(t)) return 'ajudante';
    if (/sa[ií]da.*casa|apartamento|apto|ap/.test(t)) return 'saida_tipo';
    if (/destino.*casa|apartamento|apto|ap/.test(t)) return 'destino_tipo';
    if (/o que voc[eê]\s+precisa\s+transportar|quais\s+itens/.test(t)) return 'itens';
    return null;
  }
  
  const ultIA = iaMsgs.length ? iaMsgs[iaMsgs.length - 1].texto || '' : '';
  const campoPerguntadoAntes = iaPerguntouCampo(ultIA);
  const ultCLI = historicoCLI.length ? String(historicoCLI[historicoCLI.length - 1].texto || '') : '';
  const forneceuDadoAgora = !!(campoPerguntadoAntes && ultCLI && !/\?\s*$/.test(ultCLI));
  
  // Telefone no histórico
  const temWhatsappComDDD = /\b(\d{2}\s?\d{8,9}|\d{11})\b/.test(historicoTexto);

  // PRIMEIRA MENSAGEM: perguntar itens (não "precisa de frete?")
  let proximaPergunta = '';
  if (!historicoIA.length && !jaMencionouItens) {
    proximaPergunta = 'itens';
  } else {
    // pedir telefone: somente se preço OU tudo coletado (NUNCA por disponibilidade genérica)
    const podePedirPhonePrimeiraVez = priceAsk && !jaPediuWhatsappAntes && !forneceuDadoAgora;
    const podePedirPhoneAoFinal = allNonPhoneAnswered && !jaPediuWhatsappUltima;

    if (!temWhatsappComDDD && (podePedirPhonePrimeiraVez || podePedirPhoneAoFinal)) {
      proximaPergunta = 'telefone';
    } else {
      const fila = ['itens','bairro_saida','bairro_destino','ajudante','saida_tipo','destino_tipo'];
      for (const f of fila) {
        if (f === 'itens' && !jaMencionouItens) { proximaPergunta = 'itens'; break; }
        if (f === 'bairro_saida' && !jaMencionouBairroSaida) { proximaPergunta = 'bairro_saida'; break; }
        if (f === 'bairro_destino' && !jaMencionouBairroDestino) { proximaPergunta = 'bairro_destino'; break; }
        if (f === 'ajudante' && !jaMencionouAjudante) { proximaPergunta = 'ajudante'; break; }
        if (f === 'saida_tipo' && !jaMencionouSaidaTipo) { proximaPergunta = 'saida_tipo'; break; }
        if (f === 'destino_tipo' && !jaMencionouDestinoTipo) { proximaPergunta = 'destino_tipo'; break; }
      }
      if (!proximaPergunta) proximaPergunta = '—';
    }
  }

  const cabecalho = [
    `Contexto do atendimento:`,
    `- Horário atual: ${agora.toLocaleString('pt-BR')} - ${jaDeuSaudacao ? `JÁ DEU SAUDAÇÃO - NUNCA repita "${saudacao}"` : `Use "${saudacao}" na saudação (APENAS SE FOR PRIMEIRA MENSAGEM)`}`,
    `- Cidade (referência interna apenas - NUNCA mencione ao cliente): ${cid}`,
    ``,
    `ORDEM FIXA DE COLETA (UMA PERGUNTA POR VEZ):`,
    `1. O que precisa transportar: ${jaMencionouItens ? '✅ COLETADO' : '❌ FALTA'}`,
    `2. Bairro de saída: ${jaMencionouBairroSaida ? '✅ COLETADO' : '❌ FALTA'}`,
    `3. Bairro de destino: ${jaMencionouBairroDestino ? '✅ COLETADO' : '❌ FALTA'}`,
    `4. Precisa de ajudante: ${jaMencionouAjudante ? '✅ COLETADO' : '❌ FALTA'}`,
    `5. Saída é casa ou apartamento: ${jaMencionouSaidaTipo ? '✅ COLETADO' : '❌ FALTA'}`,
    `6. Destino é casa ou apartamento: ${jaMencionouDestinoTipo ? '✅ COLETADO' : '❌ FALTA'}`,
    `7. WhatsApp: ${temWhatsappComDDD ? '✅ COLETADO' : '❌ FALTA (pedir apenas quando cliente perguntar preço OU no final)'}`,
    ``,
    `PRÓXIMA PERGUNTA A FAZER: ${proximaPergunta || '—'}`,
    ``,
    `PROIBIÇÕES ABSOLUTAS:`,
    `1. NUNCA repita a saudação se já foi dada`,
    `2. NUNCA repita o que o cliente acabou de responder`,
    `3. NUNCA repita o que o cliente quer transportar — apenas confirme que levamos`,
    `4. NUNCA mencione a cidade do cliente`,
    `5. NUNCA faça múltiplas perguntas juntas (apenas UMA por mensagem)`,
    `6. NUNCA confirme WhatsApp digitado ("confirma esse número...?")`,
    `7. NUNCA peça WhatsApp em mensagens consecutivas; se acabou de pedir, continue coletando dados`,
    `8. NUNCA peça WhatsApp enquanto o cliente está fornecendo dados na mesma mensagem; só no final ou ao perguntar preço/agendamento pela primeira vez`,
    ``,
    `ESTRUTURA OBRIGATÓRIA: [RESPONDA AO CLIENTE] + [PERGUNTA NECESSÁRIA]`,
    ``,
    `Histórico completo da conversa:`
  ];

  const linhas = [];
  for (const msg of (historico || [])) {
    const autor = (msg.autor === 'ia' || msg.autor === 'sistema') ? 'Atendente' : 'Cliente';
    const timestamp = msg.timestamp ? new Date(msg.timestamp).toLocaleString('pt-BR') : '';
    linhas.push(`${autor}${timestamp ? ' [' + timestamp + ']' : ''}: ${msg.texto}`);
  }

  const rodape = [
    ``,
    `ANÁLISE:`,
    `- O que o cliente JÁ mencionou?`,
    `- O que ainda FALTA coletar?`,
    `- Qual resposta NATURAL e INTELIGENTE agora?`,
    ``,
    `Retorne APENAS o JSON (sem markdown).`
  ];

  return [...cabecalho, ...linhas, ...rodape].join('\n');
}

function parsearRespostaGroq(respostaTexto) {
  try {
    let texto = String(respostaTexto || '').trim();
    
    // Remove markdown code blocks (```json ... ```)
    texto = texto.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/\s*```$/i, '').trim();
    
    // Tenta encontrar JSON (pode estar no início, meio ou fim)
    let match = texto.match(/\{[\s\S]*\}/);
    if (!match) {
      // Fallback: procura qualquer JSON na string
      match = texto.match(/\{.*\}/s);
    }
    if (!match) throw new Error('JSON não encontrado na resposta');

    const obj = JSON.parse(match[0]);
    const safeDados = obj.dados && typeof obj.dados === 'object' ? obj.dados : {};

    return {
      resposta: obj.resposta || '',
      telefone_extraido: obj.telefone_extraido || null,
      finalizado: obj.finalizado === true,
      dados: {
        ajudante: safeDados.ajudante ?? null,
        saida_tipo: safeDados.saida_tipo ?? null,
        saida_elevador: safeDados.saida_elevador ?? null,
        destino_tipo: safeDados.destino_tipo ?? null,
        destino_elevador: safeDados.destino_elevador ?? null,
        bairro_saida: safeDados.bairro_saida ?? null,
        bairro_destino: safeDados.bairro_destino ?? null,
        itens: safeDados.itens ?? null
      }
    };
  } catch (e) {
    logger.error('[GROQ] Erro ao parsear JSON', { error: e && e.message || e, raw: String(respostaTexto).slice(0, 300) });
    throw e;
  }
}

// Fallback robusto de telefone (BR). Extrai do texto bruto
// ATUALIZADO: Usa extractPhonesBRStrict do utils.js para validação ultra-rígida
function extrairTelefoneFallback(texto) {
  try {
    const phones = utils.extractPhonesBRStrict(texto);
    // Retorna o primeiro telefone válido encontrado (ou null)
    return phones.length > 0 ? phones[0] : null;
  } catch {
    return null;
  }
}

// Locks por perfil de input
const VIRTUS_INPUT_LOCKS = new Map();
function setVirtusInputLock(nome, v){ if (v) VIRTUS_INPUT_LOCKS.set(nome,true); else VIRTUS_INPUT_LOCKS.delete(nome); }
function isVirtusLocked(nome){ return VIRTUS_INPUT_LOCKS.has(nome); }

// Helpers globais de send-lock/contexto
function getBrowserFromPage(p) { try { return typeof p.browser === 'function' ? p.browser() : null; } catch { return null; } }
async function acquireSendGuard(p, chatId) { try { const b = getBrowserFromPage(p); if (b) b._sendLock = { active: true, owner: 'virtus', chatId, since: Date.now() }; } catch {} }
function releaseSendGuard(p) { try { const b = getBrowserFromPage(p); if (b && b._sendLock && b._sendLock.owner === 'virtus') b._sendLock.active = false; } catch {} }

// Sanitização (IA) anti-clichê
function sanitizeIAResponse(texto, historico) {
  let t = String(texto || '').trim();
  
  // Detecta se já houve saudação anteriormente por parte da IA
  const jaSaudou = Array.isArray(historico)
    ? historico.some(m => m.autor === 'ia' && /\b(bom dia|boa tarde|boa noite|ol[áa]|oii?)\b/i.test(String(m.texto || '')))
    : false;
  
  // Evita remover saudações amigáveis na primeira resposta
  const cliches = [
    /^sim[,!.\s]/i,
    /^ah[,!.\s]/i,
    /^ótimo[,!.\s]/i,
    /^perfeito[,!.\s]/i,
    /^claro[,!.\s]/i
  ];
  
  for (const rx of cliches) {
    t = t.replace(rx, '').trim();
  }
  
  // Remova "olá/oi" apenas se já houve saudação anteriormente
  if (jaSaudou) {
    t = t.replace(/^ol[áa][,!.\s]/i, '').trim();
    t = t.replace(/^oii?[,!.\s]/i, '').trim();
  }
  
  // Dedupe: evita repetir exatamente a última resposta da IA
  t = t.replace(/\s{2,}/g, ' ').trim();
  const ultIA = Array.isArray(historico) ? historico.filter(m => m.autor==='ia').slice(-1)[0] : null;
  if (ultIA && typeof ultIA.texto === 'string') {
    const prev = ultIA.texto.trim().toLowerCase();
    const cur = t.trim().toLowerCase();
    if (prev && cur && prev === cur) {
      // Evita repetir a mesma frase; faz variação mínima sem emoji nem ruído
      t = t + '.';
    }
  }
  if (t.length < 3) {
    // Nunca força emoji em mensagem curta
    t = 'Ok.';
  }
  return t;
}

// Log hard de histórico por chatId (em disco, JSONL por chat)
function chatLogPath(perfil, chatId) {
  return path.join(__dirname, '..', 'dados', 'perfis', perfil, 'chats', `${chatId}.jsonl`);
}

async function appendChatHistoryLog(perfil, chatId, historicoArr) {
  try {
    const file = chatLogPath(perfil, chatId);
    const st = await getChatState(perfil, chatId).catch(()=>null);
    const lastTs = st && st.chatLogLastTs || 0;
    const novos = (historicoArr||[]).filter(m => Number(m.timestamp||0) > lastTs);
    if (!novos.length) return;
    const buf = CHAT_LOG_BUFFERS.get(file) || [];
    for (const m of novos) buf.push(JSON.stringify(m) + '\n');
    CHAT_LOG_BUFFERS.set(file, buf);
    const maxTs = Math.max(...novos.map(m=>Number(m.timestamp||0)));
    await setChatState(perfil, chatId, { chatLogLastTs: maxTs || Date.now() });
    scheduleChatLogFlush();
  } catch {}
}

async function appendIaLine(perfil, chatId, texto) {
  const obj = { autor:'ia', texto:String(texto||''), timestamp: Date.now() };
  const file = chatLogPath(perfil, chatId);
  try { fsRaw.mkdirSync(path.dirname(file), { recursive: true }); fsRaw.appendFileSync(file, JSON.stringify(obj)+'\n', 'utf8'); } catch {}
  try { await setChatState(perfil, chatId, { chatLogLastTs: obj.timestamp }); } catch {}
}

// Pipeline de Perguntas - Helpers
const SECONDARY_FIELDS = [
  'ajudante',
  'saida_tipo',
  'saida_elevador',
  'destino_tipo',
  'destino_elevador',
  'bairro_saida',
  'bairro_destino',
  'itens'
];

const FIELD_LABELS = {
  'ajudante': 'Precisa de ajudante?',
  'saida_tipo': 'Saída é casa ou apartamento?',
  'saida_elevador': 'Saída tem elevador?',
  'destino_tipo': 'Destino é casa ou apartamento?',
  'destino_elevador': 'Destino tem elevador?',
  'bairro_saida': 'Qual bairro de saída?',
  'bairro_destino': 'Qual bairro de destino?',
  'itens': 'Quais itens e quantidades? (ex.: 2 camas, 10 sacolas)'
};

function choosePair(qaAsked, qaAnswered) {
  const askedSet = new Set(qaAsked || []);
  const answeredSet = new Set(Object.keys(qaAnswered || {}));
  const pending = SECONDARY_FIELDS.filter(f => !answeredSet.has(f) && !askedSet.has(f));
  
  if (pending.length === 0) return [];
  if (pending.length === 1) return pending;
  
  // Embaralha e pega 2
  const shuffled = [...pending].sort(() => Math.random() - 0.5);
  return shuffled.slice(0, 2);
}

function buildMessageFromQuestions(questions) {
  if (!questions || questions.length === 0) return '';
  const texts = questions.map(q => FIELD_LABELS[q] || q);
  if (texts.length === 1) return texts[0];
  return texts.join('\n');
}

function extractAnswersFromHistory(historico) {
  const answers = {};
  const textoCompleto = (historico || []).map(m => String(m.texto || '')).join(' ').toLowerCase();
  
  // Ajudante
  if (/precis[oa]|ajudante|ajuda|helper/i.test(textoCompleto)) {
    if (/sim|yes|precis[oa]/i.test(textoCompleto)) answers.ajudante = 'sim';
    else if (/n[ãa]o|no|não preciso/i.test(textoCompleto)) answers.ajudante = 'não';
  }
  
  // Saída/Destino tipo
  if (/sa[íi]da.*(casa|apartamento|apto)/i.test(textoCompleto)) {
    const match = textoCompleto.match(/sa[íi]da.*?(casa|apartamento|apto)/i);
    if (match) answers.saida_tipo = match[1].toLowerCase().includes('casa') ? 'casa' : 'apartamento';
  }
  if (/destino.*(casa|apartamento|apto)/i.test(textoCompleto)) {
    const match = textoCompleto.match(/destino.*?(casa|apartamento|apto)/i);
    if (match) answers.destino_tipo = match[1].toLowerCase().includes('casa') ? 'casa' : 'apartamento';
  }
  
  // Elevador
  if (/sa[íi]da.*elevador/i.test(textoCompleto)) {
    if (/sim|yes|tem/i.test(textoCompleto)) answers.saida_elevador = 'sim';
    else if (/n[ãa]o|no|sem/i.test(textoCompleto)) answers.saida_elevador = 'não';
  }
  if (/destino.*elevador/i.test(textoCompleto)) {
    if (/sim|yes|tem/i.test(textoCompleto)) answers.destino_elevador = 'sim';
    else if (/n[ãa]o|no|sem/i.test(textoCompleto)) answers.destino_elevador = 'não';
  }
  
  // Bairros
  const bairroMatch = textoCompleto.match(/(?:bairro|bairros?)[\s:]*([^,\.\n]+)/i);
  if (bairroMatch) {
    const parts = bairroMatch[1].split(/para|até|destino/i);
    if (parts[0]) answers.bairro_saida = parts[0].trim();
    if (parts[1]) answers.bairro_destino = parts[1].trim();
  }
  
  // Itens
  const itensMatch = textoCompleto.match(/(?:itens?|coisas?|m[óo]veis?)[\s:]*([^,\.\n]{10,})/i);
  if (itensMatch) answers.itens = itensMatch[1].trim();
  
  return answers;
}

// Pipeline de Perguntas - Função principal (VERSÃO ULTRA-BLINDADA)
const FLOW_ORDER = [
  'itens',
  'bairro_saida',
  'bairro_destino',
  'ajudante',
  'saida_tipo',
  'destino_tipo',
  'telefone'
];

const FIELD_PROMPTS = {
  telefone:        'Pode me passar seu WhatsApp? O motorista chama por lá.',
  itens:           'O que você precisa transportar? (ex.: 2 camas, 10 sacolas)',
  ajudante:        'Você precisa de ajudante?',
  saída_tipo:      'O local de saída é casa ou apartamento?',
  saida_tipo:      'O local de saída é casa ou apartamento?',
  destino_tipo:    'O destino é casa ou apartamento?',
  bairro_saida:    'Qual bairro de saída?',
  bairro_destino:  'Qual bairro de destino?',
  // Pseudo-campo exclusivo do prompt para PRIMEIRA MENSAGEM
  precisa_servico: 'Precisa de frete?'
};

function getOrInitFlowState(stPrev) {
  const fs = stPrev && stPrev.flow ? stPrev.flow : {
    greeted: false,
    asked: {},
    answered: {}
  };
  fs.asked = fs.asked || {};
  fs.answered = fs.answered || {};
  return fs;
}

function devePedirWhatsApp(historicoConversa, flow) {
  try {
    const utils = require('./utils.js');
    flow = flow || {};
    flow.answered = flow.answered || {};
    
    const hasPhone = utils.isValidBRPhoneWithDDD((flow.answered.telefone || '').toString());
    const txt = (historicoConversa || []).map(m => String(m.texto || '')).join(' ').toLowerCase();
    
    const askedPrice = /\b(pre[cç]o|valor|or[cç]amento|custa|quanto)\b/i.test(txt);
    
    const nonPhone = FLOW_ORDER.filter(f => f !== 'telefone');
    const allNonPhoneAnswered = nonPhone.every(f => !!flow.answered[f]);
    
    const iaMsgs = (historicoConversa || []).filter(m => (m.autor === 'ia' || m.autor === 'sistema'));
    const lastIA = iaMsgs.length ? String(iaMsgs[iaMsgs.length - 1].texto || '') : '';
    const askedWhatsLast = /\b(whats|whatsapp|telefone|n[uú]mero)\b/i.test(lastIA);
    const askedWhatsBefore = askedWhatsLast || iaMsgs.slice(-3).some(m => /\b(whats|whatsapp|telefone|n[uú]mero)\b/i.test(String(m.texto || '')));
    
    if (hasPhone) return false;
    if (flow.lastAsked === 'telefone' || askedWhatsLast) return false;
    if (flow.phoneAskedOnce === true && !allNonPhoneAnswered) return false;
    
    // Se a última pergunta da IA foi um campo e o cliente acabou de responder, não pedir telefone agora
    const cliMsgs = (historicoConversa || []).filter(m => m && m.autor === 'cliente');
    const lastCLI = cliMsgs.length ? String(cliMsgs[cliMsgs.length - 1].texto || '') : '';
    const lastIAText = lastIA.toLowerCase();
    const iaPediuCampoAntes =
      /qual\s+o?\s*bairro.*sa[ií]da/.test(lastIAText) ||
      /qual\s+o?\s*bairro.*destino/.test(lastIAText) ||
      /precisa\s+de\s+ajudante/.test(lastIAText) ||
      /sa[ií]da.*(casa|apartamento|apto|ap)/.test(lastIAText) ||
      /destino.*(casa|apartamento|apto|ap)/.test(lastIAText) ||
      /(o que voc[eê]\s+precisa\s+transportar|quais\s+itens)/.test(lastIAText);
    
    if (iaPediuCampoAntes && lastCLI && !/\?\s*$/.test(lastCLI)) return false;
    
    // Somente preço ou final da coleta
    if (askedPrice && !flow.phoneAskedOnce && !askedWhatsBefore) {
      return true;
    }
    if (allNonPhoneAnswered && !askedWhatsBefore) return true;
    
    return false;
  } catch {
    return false;
  }
}

function pickNextMissingField(flow, historicoConversa) {
  const nonPhone = FLOW_ORDER.filter(f => f !== 'telefone');
  const allNonPhoneAnswered = nonPhone.every(f => !!(flow.answered && flow.answered[f]));
  
  // PRIORIDADE 1: Se cliente acabou de fornecer dados, continue coletando (NÃO peça WhatsApp)
  const cliMsgs = (historicoConversa || []).filter(m => m && m.autor === 'cliente');
  const lastCLI = cliMsgs.length ? String(cliMsgs[cliMsgs.length - 1].texto || '') : '';
  const forneceuDadoAgora = /\b(cama|sof[aá]|guarda-?roupa|fog[aã]o|geladeira|mesa|cadeira|m[óo]vel|m[óo]veis|transportar|levar|preciso levar|preciso transportar|bairro|ajudante|ajuda|casa|apartamento|apto|ap\b)\b/i.test(lastCLI);
  
  // Se cliente acabou de fornecer dados, SEMPRE priorize coletar mais dados
  if (forneceuDadoAgora && !allNonPhoneAnswered) {
    for (const f of nonPhone) {
      if (!flow.answered[f]) return f;
    }
  }
  
  // PRIORIDADE 2: Verificar se deve pedir WhatsApp (só se não acabou de fornecer dados)
  const askPhoneNow = devePedirWhatsApp(historicoConversa, flow) || allNonPhoneAnswered;
  if (askPhoneNow && !forneceuDadoAgora) {
    // Nunca em mensagens consecutivas
    if (flow.lastAsked !== 'telefone') {
      return 'telefone';
    }
  }
  
  // PRIORIDADE 3: Coletar campos não-telefone faltantes
  for (const f of nonPhone) {
    if (!flow.answered[f]) return f;
  }
  
  return null;
}

function applyExtractedAnswers(flow, historicoConversa, utils) {
  const texto = (historicoConversa || []).map(m => (m && m.texto) || '').join(' ').toLowerCase();

  // 1) Telefone — robusto: tenta extrair direto, depois combinar DDD + número soltos
  const phones = utils.extractPhonesBRStrict(texto);
  if (phones && phones.length) {
    flow.answered.telefone = phones[0];
  } else {
    // Combina "ddd 48" + "91985634" ou "48 999999999" (ordem variável)
    const t = texto.replace(/[^\d\s]/g, ' ');
    // padrão: ddd + local
    let m = t.match(/\b(?:ddd\s*)?([1-9]{2})\D*([2-9]\d{7,8})\b/);
    if (!m) {
      // local + ddd
      m = t.match(/\b([2-9]\d{7,8})\D*(?:ddd\s*)?([1-9]{2})\b/);
    }
    if (m) {
      const ddd = m[1].length === 2 ? m[1] : m[2];
      const local = m[1].length >= 8 ? m[1] : m[2];
      const combinado = ddd + local;
      if (utils.isValidBRPhoneWithDDD(combinado)) {
        flow.answered.telefone = combinado;
      }
    }
  }

  // 2) Contextual (pega última pergunta da IA e última resposta do cliente)
  const iaMsgs = (historicoConversa || []).filter(m => m && (m.autor === 'ia' || m.autor === 'sistema'));
  const cliMsgs = (historicoConversa || []).filter(m => m && m.autor === 'cliente');
  const ultIA = iaMsgs.length ? iaMsgs[iaMsgs.length - 1] : null;
  const ultCLI = cliMsgs.length ? cliMsgs[cliMsgs.length - 1] : null;
  const iaTxt = (ultIA && String(ultIA.texto || '').toLowerCase()) || '';
  const cliTxt = (ultCLI && String(ultCLI.texto || '').trim().toLowerCase()) || '';

  // Helper: decide se resposta do cliente indica 'casa' ou 'apartamento'
  const casaOuAp = (txt) => {
    if (/\b(casa)\b/i.test(txt)) return 'casa';
    if (/\b(apto|ap|apart|apartamento)\b/i.test(txt)) return 'apartamento';
    return null;
  };

  // Helper: bairro plausível (1 a 3 palavras sem números, ex.: "pelotas", "aririu")
  const talvezBairro = (txt) => {
    const clean = txt.replace(/[^\p{L}\s-]/gu, '').trim(); // letras/hífens/espaços
    if (!clean) return null;
    const words = clean.split(/\s+/).filter(Boolean);
    if (words.length >= 1 && words.length <= 3 && /^[\p{L}\s-]+$/u.test(clean)) {
      return clean;
    }
    return null;
  };

  // 2a) Ajudante (se a última pergunta IA foi sobre ajudante)
  if (/ajudante|precisa de ajuda/i.test(iaTxt)) {
    if (/\b(sim|preciso|quero)\b/i.test(cliTxt)) flow.answered.ajudante = 'sim';
    else if (/\b(n[aã]o|nao|sem)\b/i.test(cliTxt)) flow.answered.ajudante = 'não';
  }

  // 2b) Saída casa/apto
  if (/sa[ií]da.*casa.apart/i.test(iaTxt) || /sa[ií]da.(casa|apto|apart)/i.test(iaTxt)) {
    const val = casaOuAp(cliTxt);
    if (val) flow.answered.saida_tipo = val;
  }

  // 2c) Destino casa/apto
  if (/destino.*casa.apart/i.test(iaTxt) || /destino.(casa|apto|apart)/i.test(iaTxt)) {
    const val = casaOuAp(cliTxt);
    if (val) flow.answered.destino_tipo = val;
  }

  // 2d) Bairro (saída/destino) — se a última pergunta foi bairro de saída/destino e cliente respondeu texto curto
  if (/bairro.*sa[ií]da/i.test(iaTxt)) {
    const b = talvezBairro(cliTxt);
    if (b) flow.answered.bairro_saida = b;
  }
  if (/bairro.*destino/i.test(iaTxt)) {
    const b = talvezBairro(cliTxt);
    if (b) flow.answered.bairro_destino = b;
  }

  // 3) Varreduras globais (fallbacks)
  if (/ajudante|ajuda/i.test(texto)) {
    if (/\b(sim|precis[oa]|quero)\b/i.test(texto)) flow.answered.ajudante = flow.answered.ajudante || 'sim';
    else if (/\b(n[aã]o|nao|sem)\b/i.test(texto)) flow.answered.ajudante = flow.answered.ajudante || 'não';
  }
  if (/sa[ií]da.(casa|apartamento|apto|ap)\b/i.test(texto)) {
    flow.answered.saida_tipo = flow.answered.saida_tipo || (/casa/i.test(texto) ? 'casa' : 'apartamento');
  }
  if (/destino.(casa|apartamento|apto|ap)\b/i.test(texto)) {
    flow.answered.destino_tipo = flow.answered.destino_tipo || (/casa/i.test(texto) ? 'casa' : 'apartamento');
  }
  const bx = texto.match(/\bbairro(s)?\b[:\s]*([^,.\n]+)/i);
  if (bx) {
    const clean = (bx[2] || '').trim();
    if (clean && !flow.answered.bairro_saida) flow.answered.bairro_saida = clean;
  }
  // Detecção de itens - mais robusta
  if (/transportar|levar|itens?|coisas?|m[óo]veis?|mudan[çc]a|cama|camas|sof[aá]|guarda-?roupa|fog[aã]o|geladeira|mesa|mesas|cadeira|cadeiras|m[óo]vel|m[óo]veis/i.test(texto)) {
    // Se ainda não tem itens coletados, pega o contexto relevante
    if (!flow.answered.itens) {
      // Tenta pegar a parte mais relevante (ex: "preciso levar uma cama")
      const match = texto.match(/(?:preciso|quero|vou|precisar|transportar|levar).{0,100}(?:cama|camas|sof[aá]|guarda-?roupa|fog[aã]o|geladeira|mesa|mesas|cadeira|cadeiras|m[óo]vel|m[óo]veis|itens?|coisas?)/i);
      if (match) {
        flow.answered.itens = match[0].trim();
      } else {
        const snippet = texto.slice(0, 180);
        flow.answered.itens = snippet;
      }
    }
  }

  // 4) Data/hora — sem nunca perguntar (apenas extrai)
  const dataHora = extractDataHoraPTBR(texto);
  flow.answered.data_hora = dataHora || flow.answered.data_hora || 'agora';

  // Sinaliza que precisamos do DDD se detectamos número local (8-9 dígitos) sem DDD
  if (!flow.answered.telefone) {
    const mLocal = texto.match(/\b([2-9]\d{7,8})\b/);
    if (mLocal && mLocal[1]) {
      flow.meta = flow.meta || {};
      flow.meta.needDDD = true;
    }
  }

  return flow;
}

function extractDataHoraPTBR(texto) {
  try {
    const t = String(texto || '').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase();

    const hoje = new Date();
    const dia = (d) => {
      const dt = new Date(hoje.getFullYear(), hoje.getMonth(), hoje.getDate() + d);
      return `${String(dt.getDate()).padStart(2,'0')}/${String(dt.getMonth()+1).padStart(2,'0')}`;
    };

    let diaRef = null;
    if (/\bhoje\b/.test(t)) diaRef = dia(0);
    else if (/\bagora\b/.test(t)) diaRef = dia(0);
    else if (/\bamanh[ãa]\b/.test(t)) diaRef = dia(1);
    else if (/\bdepois de amanh[ãa]\b/.test(t)) diaRef = dia(2);

    // Hora: "14h", "14:00", "às 14", "as 14", "2 da tarde", "dua tarde", "de manha/demanha", "de noite"
    let hora = null;
    const mHora = t.match(/\b(\d{1,2})(?:[:h]\s?(\d{2}))?\b/);
    if (mHora) {
      let h = parseInt(mHora[1],10);
      const mm = mHora[2] ? parseInt(mHora[2],10) : 0;
      if (h >= 0 && h <= 23) {
        hora = `${h}h`;
        if (mm && mm > 0) hora = `${h}:${String(mm).padStart(2,'0')}`;
      }
      // "da tarde/noite" => normaliza para 24h
      if ((/\bda tarde\b/.test(t) || /\btarde\b/.test(t)) && h >= 1 && h <= 11) hora = `${h+12}h`;
      if ((/\bda noite\b/.test(t) || /\bnoite\b/.test(t)) && h >= 1 && h <= 11) hora = `${h+12}h`;
    }

    if (!hora) {
      if (/\bde manh[ãa]\b|\bdemanha\b/.test(t)) hora = 'de manhã';
      else if (/\bde tarde\b|\btarde\b/.test(t)) hora = 'de tarde';
      else if (/\bde noite\b|\bnoite\b/.test(t)) hora = 'de noite';
    }

    if (!diaRef && !hora) return null;
    if (!diaRef) diaRef = dia(0); // sem dia -> assume hoje
    if (hora) return `${diaRef} - ${hora}`;
    return `${diaRef}`;

  } catch {
    return null;
  }
}

function buildNaturalPrefix(ultimaDoCliente) {
  if (!ultimaDoCliente) return '';
  const t = String(ultimaDoCliente || '').trim().toLowerCase();

  // Cumprimentos/estado
  if (/tudo bem|td bem|como est[aá]/i.test(t)) return 'Tudo bem, sim. ';

  // Evitar confirmar o mesmo termo (sem eco)
  if (/faz frete|fazem frete|dispon[ií]vel|voc[eê] faz|trabalha/i.test(t)) return '';
  if (/pre[cç]o|quanto custa|or[çc]amento|valor|custa/i.test(t)) return '';
  if (/ajudante|ajuda/i.test(t)) return '';
  if (/casa|apartamento|apto|ap\b/i.test(t)) return '';
  if (/bairro/i.test(t)) return '';

  // Mensagens sobre itens: evite repetir "transportamos"
  if (/cama|sof[aá]|guarda-?roupa|m[óo]vel|geladeira|fog[aã]o|mudan[çc]a|itens|coisas/i.test(t)) return '';

  // Caso genérico: confirme de forma neutra, sem eco
  return 'Entendido. ';
}

async function processarPipelinePerguntas(nome, chatId, historicoConversa, stPrev) {
  const utils = require('./utils.js');
  const flow = getOrInitFlowState(stPrev);
  flow.meta = flow.meta || {};
  flow.meta.needDDD = !!flow.meta.needDDD; // flag se só veio o número sem DDD
  applyExtractedAnswers(flow, historicoConversa, utils);

  const textoCompleto = (historicoConversa || []).map(m => String(m.texto || '')).join(' ').toLowerCase();
  const whatsappValido = utils.isValidBRPhoneWithDDD((flow.answered && flow.answered.telefone) || '');

  // Se precisamos só do DDD, peça uma única vez
  if (!whatsappValido && flow.meta.needDDD) {
    const ultimaCliente = (historicoConversa || []).filter(m => m.autor === 'cliente').slice(-1)[0];
    const prefixo = buildNaturalPrefix(ultimaCliente && ultimaCliente.texto);
    flow.lastAsked = 'telefone';
    flow.lastAskedAt = Date.now();
    flow.phoneAskedOnce = true;
    return {
      resposta: `${prefixo}Preciso do DDD também, pode me passar o número completo?`,
      telefone_extraido: null,
      finalizado: false,
      dados: flow.answered,
      qaAsked: Object.keys(flow.asked || {}),
      qaAnswered: flow.answered,
      flow
    };
  }

  // Próxima pergunta
  const next = pickNextMissingField(flow, historicoConversa);
  const askPhoneNow = (next === 'telefone');

  // Se é hora de pedir Whatsapp
  if (askPhoneNow && !whatsappValido) {
    // Não repetir caso a última pergunta já tenha sido telefone
    if (flow.lastAsked === 'telefone') {
      return {
        resposta: null,
        telefone_extraido: null,
        finalizado: false,
        dados: flow.answered,
        qaAsked: Object.keys(flow.asked || {}),
        qaAnswered: flow.answered,
        flow
      };
    }

    const ultimaCliente = (historicoConversa || []).filter(m => m.autor === 'cliente').slice(-1)[0];
    const prefixo = buildNaturalPrefix(ultimaCliente && ultimaCliente.texto);
    flow.asked = flow.asked || {};
    flow.asked.telefone = true;
    flow.lastAsked = 'telefone';
    flow.lastAskedAt = Date.now();
    flow.phoneAskedOnce = true;
    const nonPhone = FLOW_ORDER.filter(f => f !== 'telefone');
    const allNonPhoneAnswered = nonPhone.every(f => !!flow.answered[f]);
    const variante = allNonPhoneAnswered
      ? 'Perfeito! Já temos todos os dados. Agora só falta seu WhatsApp para o motorista te enviar o orçamento. Pode me passar?'
      : 'O motorista passa o orçamento e combina o horário pelo WhatsApp. Pode me passar seu WhatsApp?';

    return {
      resposta: `${prefixo}${variante}`,
      telefone_extraido: null,
      finalizado: false,
      dados: flow.answered,
      qaAsked: Object.keys(flow.asked || {}),
      qaAnswered: flow.answered,
      flow
    };
  }

  // Próxima pergunta (não-telefone)
  if (next && next !== 'telefone') {
    flow.asked = flow.asked || {};
    flow.asked[next] = true;
    flow.lastAsked = next;
    flow.lastAskedAt = Date.now();
    const ultimaCliente = (historicoConversa || []).filter(m => m.autor === 'cliente').slice(-1)[0];
    const prefixo = buildNaturalPrefix(ultimaCliente && ultimaCliente.texto);
    const pergunta = FIELD_PROMPTS[next] || 'Pode me detalhar, por favor?';

    return {
      resposta: `${prefixo}${pergunta}`,
      telefone_extraido: whatsappValido ? flow.answered.telefone : null,
      finalizado: false,
      dados: flow.answered,
      qaAsked: Object.keys(flow.asked),
      qaAnswered: flow.answered,
      flow
    };
  }

  // Todos os dados já coletados e ainda não tem WhatsApp
  if (!whatsappValido) {
    // Evita perguntar WhatsApp de novo consecutivo
    if (flow.lastAsked === 'telefone') {
      return {
        resposta: null,
        telefone_extraido: null,
        finalizado: false,
        dados: flow.answered,
        qaAsked: Object.keys(flow.asked || {}),
        qaAnswered: flow.answered,
        flow
      };
    }

    const ultimaCliente = (historicoConversa || []).filter(m => m.autor === 'cliente').slice(-1)[0];
    const prefixo = buildNaturalPrefix(ultimaCliente && ultimaCliente.texto);
    flow.asked = flow.asked || {};
    flow.asked.telefone = true;
    flow.lastAsked = 'telefone';
    flow.lastAskedAt = Date.now();
    flow.phoneAskedOnce = true;
    return {
      resposta: `${prefixo}Perfeito! Já temos todos os dados. Agora só falta seu WhatsApp para o motorista te enviar o orçamento. Pode me passar?`,
      telefone_extraido: null,
      finalizado: false,
      dados: flow.answered,
      qaAsked: Object.keys(flow.asked || {}),
      qaAnswered: flow.answered,
      flow
    };
  }

  // Nada a perguntar: finaliza se telefone válido
  return {
    resposta: null,
    telefone_extraido: flow.answered.telefone || null,
    finalizado: !!whatsappValido,
    dados: flow.answered,
    qaAsked: Object.keys(flow.asked || {}),
    qaAnswered: flow.answered,
    flow
  };
}
// Funções de enforcement (governança)
function stripPhoneConfirmation(txt) {
  let t = String(txt || '');
  t = t.replace(/me\s+confirmou\s+o\s+whats(app)?\s+como.*\?/ig, '');
  t = t.replace(/est[aá]\s+correto\s+seu\s+n[uú]mero.*\?/ig, '');
  return t.trim();
}

function ensureSingleQuestion(txt) {
  let s = String(txt || '');
  const firstQ = s.indexOf('?');
  if (firstQ < 0) return s;
  const before = s.slice(0, firstQ + 1);
  const after = s.slice(firstQ + 1).replace(/\?/g, '').trim(); // remove demais "?"
  return after ? `${before} ${after}` : before;
}

function removeRepeatedGreeting(txt) {
  let t = String(txt || '').trim();
  t = t.replace(/^(bom dia|boa tarde|boa noite)[,!\s-]*/i, '').trim();
  return t;
}

function enforceGovRulesOnText(txt, { alreadyGreeted = true } = {}) {
  let s = String(txt || '').trim();
  s = stripPhoneConfirmation(s);
  s = ensureSingleQuestion(s);
  // CRÍTICO: Só remove saudação repetida se for EXATAMENTE no início e já foi dada
  // Não remove se a saudação faz parte de uma resposta natural (ex: "Oi, boa tarde! Tudo ótimo!")
  if (alreadyGreeted) {
    // Só remove se for uma saudação isolada no início (ex: "Boa tarde! Me passa...")
    // Não remove se faz parte de uma resposta (ex: "Oi, boa tarde! Tudo ótimo!")
    const saudacaoIsolada = /^(bom dia|boa tarde|boa noite)[,!\s-]+(me|qual|o|a|você|teu|seu)/i;
    if (saudacaoIsolada.test(s)) {
      s = removeRepeatedGreeting(s);
    }
  }
  return s.trim();
}

async function assertOnChat(p, chatId, { timeoutMs = 0 } = {}) {
  const t0 = Date.now();
  while (true) {
    const ok = await p.evaluate((id) => {
      try { return (location && typeof location.pathname === 'string') ? location.pathname.includes('/marketplace/t/' + id) : false; }
      catch { return false; }
    }, chatId).catch(() => false);
    if (ok) return true;
    if (!timeoutMs || (Date.now() - t0) >= timeoutMs) return false;
    await sleep(120);
  }
}
async function clearComposerIfAny(p, campo) {
  try {
    if (!campo) return;
    const ctrlKey = (process.platform === 'darwin') ? 'Meta' : 'Control';
    try { await campo.click({ delay: 20 }); } catch {}
    try { await p.keyboard.down(ctrlKey); await p.keyboard.press('KeyA'); await p.keyboard.up(ctrlKey); } catch {}
    try { await p.keyboard.press('Backspace'); } catch {}
    try { await p.keyboard.press('Delete'); } catch {}
  } catch {}
}

// Debug flags por variável de ambiente
const VIRTUS_SCROLL_DEBUG = process.env && process.env.VIRTUS_SCROLL_DEBUG === '1';
const VIRTUS_DETAILED_DEBUG = process.env && process.env.VIRTUS_DEBUG === '1';

// Debounce de log "Browser morto, não é possível garantir page." — 1x/60s por perfil
const virtusDeadLogTimes = {}; // { [nome]: timestamp }

// TTL periódica para virtusDeadLogTimes (limpeza de entradas >24h)
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of Object.entries(virtusDeadLogTimes)) {
    if (now - v > 24 * 60 * 60 * 1000) delete virtusDeadLogTimes[k];
  }
}, 60 * 60 * 1000);

// Log de issues (robusto; falha silenciosa se o módulo não existir)
let issues = null;
try { issues = require('./issues.js'); } catch { issues = null; }

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function chatUrlMatches(url, chatId) {
  try {
    const u = String(url || '');
    const re = new RegExp(`/marketplace/t/${chatId}(?:[/?#]|$)`);
    return re.test(u);
  } catch { return false; }
}

function randomBetween(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

// Adicionado helper local para registrar issues
async function logIssue(nome, type, message) {
  try {
    if (issues && typeof issues.append === 'function') {
      await issues.append(nome, type, message);
    }
  } catch {
    // silencioso
  }
}

// ====== INÍCIO: Auxiliares Notificador/Messenger ======
function getSetAguardando(nomePerfil) {
  if (!aguardandoRespostaMap.has(nomePerfil)) aguardandoRespostaMap.set(nomePerfil, new Set());
  return aguardandoRespostaMap.get(nomePerfil);
}

async function identificarTipoServico(nomePerfil) {
  try {
    const man = await manifestStore.read(nomePerfil).catch(()=>null);
    // Se tiver flags específicas:
    if (man && man.automoveis === true) return 'automoveis';
    if (man && man.imoveis === true) return 'imoveis';
    // Se usa robeMode 'veiculos' => mapeia para automoveis
    if (man && String(man.robeMode || '').toLowerCase() === 'veiculos') return 'automoveis';
    return 'fretes';
  } catch {
    return 'fretes';
  }
}

async function fazerHandshakeNotificador(nomePerfil) {
  if (handshakesFeitos.has(nomePerfil)) return;
  const tipoServico = await identificarTipoServico(nomePerfil);
  try {
    await fetch(`${NOTIFICADOR_URL}/api/virtus/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        servidor: NOTIFICADOR_SERVIDOR,
        tipo_servico: tipoServico,
        perfil: nomePerfil
      })
    });
    logger.info('[NOTIFICADOR] Handshake realizado', { nomePerfil, tipoServico });
    handshakesFeitos.add(nomePerfil);
  } catch (e) {
    logger.error('[NOTIFICADOR] Erro no handshake', { nomePerfil, error: e && e.message || e });
  }
}

function adicionarChatParaEnvio(nomePerfil, dadosChat) {
  if (!filaEnviarNotificador.has(nomePerfil)) {
    filaEnviarNotificador.set(nomePerfil, []);
  }
  filaEnviarNotificador.get(nomePerfil).push(dadosChat);

  const aguard = getSetAguardando(nomePerfil);
  try { aguard.add(dadosChat.chatId); } catch {}

  // agenda envio em lote
  setTimeout(() => enviarLoteNotificador(nomePerfil), NOTIFICADOR_ENVIO_LOTE_MS);
}

async function enviarLoteNotificador(nomePerfil) {
  const fila = filaEnviarNotificador.get(nomePerfil) || [];
  if (fila.length === 0) return;
  const lote = fila.splice(0); // pega todos

  await Promise.all(lote.map(async (dadosChat) => {
    try {
      const payload = {
        servidor: NOTIFICADOR_SERVIDOR,
        chat_id: dadosChat.chatId,
        perfil: nomePerfil,
        tipo_servico: dadosChat.tipoServico,
        historico: dadosChat.historico || [], // TODO o histórico da conversa
        localizacao: dadosChat.localizacao, // Formato: "Cidade (UF)" - ex: "Florianopolis (SC)"
        url_classificado: dadosChat.urlClassificado,
        timestamp: new Date().toISOString()
      };
      
      const urlCompleta = `${NOTIFICADOR_URL}/api/virtus/chat`;
      
      logger.info('[NOTIFICADOR] Enviando chat', { 
        nomePerfil, 
        chatId: dadosChat.chatId,
        historicoSize: payload.historico.length,
        localizacao: payload.localizacao,
        tipoServico: payload.tipo_servico,
        url: urlCompleta,
        servidor: payload.servidor
      });
      
      const response = await fetch(urlCompleta, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      
      // Lê response uma única vez (body só pode ser lido uma vez)
      const responseText = await response.text().catch(() => '');
      let responseData = null;
      try {
        responseData = responseText ? JSON.parse(responseText) : null;
      } catch {
        responseData = null;
      }
      
      if (response.ok && responseData && responseData.ok === true) {
        logger.info('[NOTIFICADOR] Chat enviado com sucesso', { nomePerfil, chatId: dadosChat.chatId });
      } else {
        logger.error('[NOTIFICADOR] Erro ao enviar chat', { 
          nomePerfil, 
          chatId: dadosChat.chatId, 
          status: response.status,
          statusText: response.statusText,
          url: urlCompleta,
          response: responseData,
          responseText: responseText.substring(0, 500) // Primeiros 500 chars
        });
        // requeue se falha
        fila.push(dadosChat);
      }
    } catch (e) {
      logger.error('[NOTIFICADOR] Falha ao enviar chat', { nomePerfil, chatId: dadosChat.chatId, error: e && e.message || e });
      // requeue se falha
      fila.push(dadosChat);
    }
  }));

  // Se ainda tem mais, agenda próximo lote
  if (filaEnviarNotificador.get(nomePerfil).length > 0) {
    setTimeout(() => enviarLoteNotificador(nomePerfil), NOTIFICADOR_ENVIO_LOTE_MS);
  }
}

function iniciarPollingRespostas(nomePerfil) {
  if (pollingIntervals.has(nomePerfil)) return;
  const id = setInterval(async () => {
    try {
      const response = await fetch(`${NOTIFICADOR_URL}/api/virtus/respostas?servidor=${encodeURIComponent(NOTIFICADOR_SERVIDOR)}&perfil=${encodeURIComponent(nomePerfil)}`);
      const data = await response.json().catch(()=>null);
      if (data && data.ok === true && Array.isArray(data.respostas)) {
        const perfilKeySet = getPendingSet(nomePerfil);
        
        for (const resp of data.respostas) {
          // Sanitiza resposta antes de processar
          const respostaSan = sanitizarResposta(resp.resposta || '');
          
          // Gera chave única para deduplicação
          const key = `${resp.chat_id}||${hashResposta(respostaSan)}`;
          
          // Dedup: se já em fila/pendente, ignore
          if (perfilKeySet.has(key)) {
            logger.debug('[NOTIFICADOR] Resposta duplicada ignorada', { nomePerfil, chatId: resp.chat_id, key });
            continue;
          }
          
          if (!filaRespostas.has(nomePerfil)) filaRespostas.set(nomePerfil, []);
          filaRespostas.get(nomePerfil).push(resp);
          
          // Empilha para envio no Messenger, sanitizando e incluindo key
          if (!filaEnvioMessenger.has(nomePerfil)) filaEnvioMessenger.set(nomePerfil, []);
          filaEnvioMessenger.get(nomePerfil).push({ 
            chatId: resp.chat_id, 
            resposta: respostaSan, 
            key 
          });
          
          // Marca como pendente local (anti-duplicado)
          perfilKeySet.add(key);
          
          logger.debug('[NOTIFICADOR] Resposta adicionada à fila', { nomePerfil, chatId: resp.chat_id, key });
        }
      }
    } catch (e) {
      logger.error('[NOTIFICADOR] Erro no polling', { nomePerfil, error: e && e.message || e });
    }
  }, NOTIFICADOR_POLLING_MS);
  pollingIntervals.set(nomePerfil, id);
}

function iniciarFilaEnvioMessenger(nomePerfil, enviarRespostaMessengerSeguraFn, marcarRespondidoFn) {
  if (filaEnvioTimers.has(nomePerfil)) return;

  const id = setInterval(async () => {
    const fila = filaEnvioMessenger.get(nomePerfil) || [];
    if (fila.length === 0) return;

    const agora = Date.now();
    const ultima = ultimaRespostaMessenger.get(nomePerfil) || 0;
    const intervaloAleatorio = MESSENGER_INTERVALO_MIN_MS + Math.floor(Math.random() * (MESSENGER_INTERVALO_MAX_MS - MESSENGER_INTERVALO_MIN_MS));
    const tempoDesdeUltima = agora - ultima;
    if (tempoDesdeUltima < intervaloAleatorio) return;

    const proximo = fila.shift();
    if (!proximo) return;

    try {
      // Sanitiza resposta antes de enviar (garantia extra)
      const respostaFinal = sanitizarResposta(proximo.resposta);
      
      // envia de forma segura (abre chat, pega composer, envia)
      if (enviarRespostaMessengerSeguraFn) {
        await enviarRespostaMessengerSeguraFn(proximo.chatId, respostaFinal);
      }
      ultimaRespostaMessenger.set(nomePerfil, Date.now());

      // marca histórico respondido (somente agora!)
      if (marcarRespondidoFn) {
        await marcarRespondidoFn(proximo.chatId);
      } else {
        await marcarRespondido(nomePerfil, proximo.chatId);
      }
      
      // NOVO: Enviar ACK ao Notificador após confirmação de envio
      try {
        await fetch(`${NOTIFICADOR_URL}/api/virtus/ack`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            servidor: NOTIFICADOR_SERVIDOR,
            perfil: nomePerfil,
            chat_id: proximo.chatId
          })
        });
        logger.info('[NOTIFICADOR] ACK enviado', { nomePerfil, chatId: proximo.chatId });
      } catch (e) {
        logger.warn('[NOTIFICADOR] Falha ao enviar ACK (será reofertado após TTL do lock)', {
          nomePerfil, chatId: proximo.chatId, error: e && e.message || e
        });
      }
      
      // remove do set aguardando
      try { const setA = getSetAguardando(nomePerfil); setA.delete(proximo.chatId); } catch {}

      // Libera a chave pending dedup (permite reprocessar se houver nova resposta diferente)
      try {
        if (proximo.key) {
          const setPend = getPendingSet(nomePerfil);
          setPend.delete(proximo.key);
          logger.debug('[MESSENGER] Chave dedup liberada', { nomePerfil, chatId: proximo.chatId, key: proximo.key });
        }
      } catch {}

      logger.info('[MESSENGER] Resposta enviada', { nomePerfil, chatId: proximo.chatId });
    } catch (e) {
      logger.error('[MESSENGER] Erro ao enviar resposta', { nomePerfil, chatId: proximo.chatId, error: e && e.message || e });
      
      // Mesmo em erro, libere a chave para permitir reprocessar em próxima iteração
      try {
        if (proximo.key) {
          const setPend = getPendingSet(nomePerfil);
          setPend.delete(proximo.key);
          logger.debug('[MESSENGER] Chave dedup liberada após erro', { nomePerfil, chatId: proximo.chatId, key: proximo.key });
        }
      } catch {}
    }
  }, 2000);

  filaEnvioTimers.set(nomePerfil, id);
}

// enviarRespostaMessengerSegura será implementada dentro do contexto do startVirtus

async function marcarRespondido(nomePerfil, chatId) {
  try {
    const agoraTs = agoraEpoch();
    const HIST_FILE = HIST_JSON_NAME(nomePerfil);
    let historicoLocal = {};
    try { historicoLocal = await readJson(HIST_FILE, {}); } catch {}
    historicoLocal[chatId] = agoraTs;
    await writeJsonAtomicFsync(HIST_FILE, historicoLocal);
    // Nota: setResponded só está disponível dentro do contexto do Virtus
    // Esta função é um fallback genérico
  } catch (e) {
    logger.error('[VIRTUS] marcarRespondido error', { nomePerfil, chatId, error: e && e.message || e });
  }
}

// Extrai a URL do classificado diretamente da pagina do chat
async function extrairUrlClassificado(page, chatId) {
  try {
    const url = await page.evaluate(() => {
      const fixAbsolute = (h) => (h && h.startsWith('http')) ? h : (h ? ('https://www.facebook.com' + h) : null);
      const anchors = Array.from(document.querySelectorAll('a'));
      // Prioriza /marketplace/item/
      for (const a of anchors) {
        const href = a.getAttribute('href') || a.href || '';
        if (href && href.includes('/marketplace/item/')) {
          if (!href.includes('/marketplace/t/')) return fixAbsolute(href);
        }
      }
      // Fallback: links do marketplace que não são t/ e não são profile
      for (const a of anchors) {
        const href = a.getAttribute('href') || a.href || '';
        if (href && href.includes('/marketplace/') && !href.includes('/marketplace/t/') && !href.includes('/marketplace/profile/')) {
          return fixAbsolute(href);
        }
      }
      return null;
    });
    return url || null;
  } catch { return null; }
}

// Extrai TODO o histórico da conversa (mensagens do cliente e da IA) - VERSÃO CORRIGIDA
async function extrairHistoricoConversa(page) {
  try {
    const historico = await page.evaluate(() => {
      function norm(s) {
        try {
          return (s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
        } catch {
          return String(s || '').toLowerCase().trim();
        }
      }

      function parseAbbrToTs(el) {
        try {
          const raw = (el.getAttribute('aria-label') || el.innerText || el.textContent || '').trim();
          const t = norm(raw);
          const now = Date.now();

          if (!t) return 0;
          if (/\bagora\b|just now|now/i.test(raw)) return now;
          
          let m = t.match(/\b(\d+)\s*(s|seg|second|seconds?)\b/);
          if (m) return now - (parseInt(m[1], 10) * 1000);
          
          m = t.match(/\b(\d+)\s*(min|mins?|minute|minuto)\b/);
          if (m) return now - (parseInt(m[1], 10) * 60000);
          
          m = t.match(/\b(\d+)\s*(h|hora|horas|hour|hours?)\b/);
          if (m) return now - (parseInt(m[1], 10) * 3600000);
          
          m = t.match(/\b(\d+)\s*(d|dia|dias|day|days)\b/);
          if (m) return now - (parseInt(m[1], 10) * 86400000);
          
          if (/\bontem\b|yesterday\b/.test(t)) return now - 86400000;
          
          const dp = Date.parse(raw);
          if (Number.isFinite(dp)) return dp;
          
          return 0;
        } catch {
          return 0;
        }
      }

      const rows = Array.from(document.querySelectorAll('div[role="row"],div[role="article"],div[data-testid]')).slice(-200);
      const out = [];

      for (const r of rows) {
        try {
          const txt = (r.innerText || r.textContent || '').trim();
          if (!txt) continue;

          // Heurística robusta: se for bolha do próprio usuário => alinhamento à direita/flex-end
          let isMine = false;
          try {
            const st = window.getComputedStyle(r);
            if (st && (st.justifyContent === 'flex-end' || st.textAlign === 'right')) {
              isMine = true;
            }
          } catch {}

          // Fallback textual
          const n = norm(txt);
          if (/\b(you\s+sent|voc[eê]\s+enviou)\b/i.test(n)) isMine = true;

          // Timestamp real pelo abbr mais próximo
          let ts = 0;
          try {
            const ab = r.querySelector('abbr[aria-label]');
            if (ab) ts = parseAbbrToTs(ab);
            if (!ts) {
              const sps = Array.from(r.querySelectorAll('span')).slice(0, 10);
              for (const s of sps) {
                const ab2 = s.querySelector('abbr[aria-label]');
                if (ab2) {
                  ts = parseAbbrToTs(ab2);
                  if (ts) break;
                }
              }
            }
          } catch {}

          const textoLimpo = txt.replace(/^(você\s+enviou|you\s+sent)[:\s]*/i, '').trim();
          if (!textoLimpo) continue;

          out.push({
            texto: textoLimpo,
            autor: isMine ? 'ia' : 'cliente',
            timestamp: ts || Date.now()
          });
        } catch {}
      }

      // Ordena por timestamp ascendente
      out.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
      return out;
    });

    return Array.isArray(historico) ? historico : [];
  } catch {
    return [];
  }
}

// Formata localização no padrão "Cidade (UF)" para a planilha Google
// ====== FUNÇÕES AUXILIARES: BURST TIMER, PACE E DEDUP ======

// Map para armazenar timers de quiet window por chat
const quietWindowTimers = new Map(); // chatId -> { timer, lastReset }

/**
 * Aguarda uma janela de quietude (sem novas mensagens do cliente) antes de responder
 * @param {string} nome - Nome do perfil
 * @param {string} chatId - ID do chat
 * @param {number} quietMs - Tempo de quietude necessário em ms (padrão 20000 = 20s)
 * @param {object} opts - { page, getHistoricoFn }
 * @returns {Promise<boolean>} - true se passou o período de quietude, false se foi interrompido
 */
async function waitQuietWindow(nome, chatId, quietMs = 20000, { page, getHistoricoFn } = {}) {
  const key = `${nome}:${chatId}`;
  const now = Date.now();
  
  // Captura timestamp da última mensagem do cliente no início
  let lastClientTs = 0;
  if (getHistoricoFn && page) {
    try {
      const historicoInicial = await getHistoricoFn();
      const ultimaClienteInicial = historicoInicial && historicoInicial.filter(m => m.autor === 'cliente').pop();
      if (ultimaClienteInicial && ultimaClienteInicial.timestamp) {
        lastClientTs = ultimaClienteInicial.timestamp;
      }
    } catch {}
  }
  
  // Se já existe um timer ativo, cancela e reseta
  const existing = quietWindowTimers.get(key);
  if (existing && existing.timer) {
    clearTimeout(existing.timer);
  }
  
  // Inicia novo timer com verificação periódica
  return new Promise((resolve) => {
    let checkInterval = null;
    const timer = setTimeout(async () => {
      if (checkInterval) clearInterval(checkInterval);
      quietWindowTimers.delete(key);
      resolve(true);
    }, quietMs);
    
    // Verifica periodicamente se houve nova mensagem (a cada 2s)
    checkInterval = setInterval(async () => {
      if (getHistoricoFn && page) {
        try {
          const historicoAtual = await getHistoricoFn();
          const ultimaCliente = historicoAtual && historicoAtual.filter(m => m.autor === 'cliente').pop();
          if (ultimaCliente && ultimaCliente.timestamp) {
            // Se houve nova mensagem após o início do timer, cancela e rejeita
            if (ultimaCliente.timestamp > lastClientTs) {
              if (checkInterval) clearInterval(checkInterval);
              clearTimeout(timer);
              quietWindowTimers.delete(key);
              resolve(false);
            }
          }
        } catch {}
      }
    }, 2000);
    
    quietWindowTimers.set(key, { timer, lastReset: now, checkInterval });
  });
}

/**
 * Calcula o pace (velocidade) do cliente baseado no histórico
 * @param {Array} historico - Histórico de mensagens
 * @returns {number} - Delay em ms (5-15s padrão, até 25s se cliente é lento)
 */
function calcularPaceCliente(historico) {
  if (!historico || !Array.isArray(historico)) return randomBetween(5000, 15000);
  
  const mensagensCliente = historico.filter(m => m.autor === 'cliente');
  if (mensagensCliente.length < 2) return randomBetween(5000, 15000);
  
  // Calcula intervalo médio entre mensagens do cliente
  const intervalos = [];
  for (let i = 1; i < mensagensCliente.length; i++) {
    const prev = mensagensCliente[i - 1].timestamp || 0;
    const curr = mensagensCliente[i].timestamp || 0;
    if (curr > prev) intervalos.push(curr - prev);
  }
  
  if (intervalos.length === 0) return randomBetween(5000, 15000);
  
  const mediaIntervalo = intervalos.reduce((a, b) => a + b, 0) / intervalos.length;
  
  // Se cliente responde rápido (< 10s), usa delay padrão (5-15s)
  // Se cliente responde lento (> 30s), usa delay maior (15-25s)
  if (mediaIntervalo < 10000) {
    return randomBetween(5000, 15000);
  } else if (mediaIntervalo > 30000) {
    return randomBetween(15000, 25000);
  } else {
    // Interpolação linear entre 5-15s e 15-25s
    const ratio = (mediaIntervalo - 10000) / 20000; // 0 a 1
    const minDelay = 5000 + (ratio * 10000); // 5s a 15s
    const maxDelay = 15000 + (ratio * 10000); // 15s a 25s
    return randomBetween(minDelay, maxDelay);
  }
}

/**
 * Deduplicação rigorosa: verifica se a resposta é muito similar às últimas 3 respostas IA
 * @param {string} respostaNova - Nova resposta gerada
 * @param {Array} historico - Histórico de mensagens
 * @returns {string} - Resposta ajustada se necessário (com variação forçada)
 */
function aplicarDedupResposta(respostaNova, historico) {
  if (!historico || !Array.isArray(historico)) return respostaNova;
  
  const respostasIA = historico
    .filter(m => m.autor === 'ia')
    .slice(-3) // Últimas 3 respostas IA
    .map(m => (m.texto || '').trim().toLowerCase());
  
  if (respostasIA.length === 0) return respostaNova;
  
  const respostaNorm = respostaNova.trim().toLowerCase();
  
  // Verifica similaridade (se > 90% similar, apenas loga - não força variação genérica)
  // A IA deve criar respostas únicas naturalmente, não forçar prefixos genéricos
  for (const respAntiga of respostasIA) {
    const similaridade = calcularSimilaridade(respostaNorm, respAntiga);
    if (similaridade > 0.9) {
      // Apenas loga - não força variação genérica que torna robótico
      logger.warn('[DEDUP] Resposta muito similar detectada - IA deve criar resposta mais única', { 
        similaridade: Math.round(similaridade * 100) + '%',
        respostaAntiga: respAntiga.substring(0, 50),
        respostaNova: respostaNorm.substring(0, 50)
      });
      // Retorna a resposta original - confia na IA para criar respostas únicas
      return respostaNova;
    }
  }
  
  return respostaNova;
}

/**
 * Calcula similaridade entre duas strings (0 a 1)
 */
function calcularSimilaridade(str1, str2) {
  if (!str1 || !str2) return 0;
  const longer = str1.length > str2.length ? str1 : str2;
  const shorter = str1.length > str2.length ? str2 : str1;
  if (longer.length === 0) return 1.0;
  
  // Distância de Levenshtein simplificada
  const distancia = levenshteinDistance(str1, str2);
  return 1 - (distancia / longer.length);
}

/**
 * Calcula distância de Levenshtein entre duas strings
 */
function levenshteinDistance(str1, str2) {
  const matrix = [];
  for (let i = 0; i <= str2.length; i++) {
    matrix[i] = [i];
  }
  for (let j = 0; j <= str1.length; j++) {
    matrix[0][j] = j;
  }
  for (let i = 1; i <= str2.length; i++) {
    for (let j = 1; j <= str1.length; j++) {
      if (str2.charAt(i - 1) === str1.charAt(j - 1)) {
        matrix[i][j] = matrix[i - 1][j - 1];
      } else {
        matrix[i][j] = Math.min(
          matrix[i - 1][j - 1] + 1,
          matrix[i][j - 1] + 1,
          matrix[i - 1][j] + 1
        );
      }
    }
  }
  return matrix[str2.length][str1.length];
}

// ====== FIM FUNÇÕES AUXILIARES ======

function formatarLocalizacaoParaPlanilha(localizacao) {
  if (!localizacao) return null;
  
  // Se já está no formato correto (string "Cidade (UF)"), retorna como está
  if (typeof localizacao === 'string') {
    return localizacao;
  }
  
  // Se é objeto { cidade, estado }
  if (localizacao && typeof localizacao === 'object') {
    const cidade = (localizacao.cidade || '').trim();
    const estado = (localizacao.estado || '').trim().toUpperCase();
    
    if (cidade && estado) {
      // Formata: "Cidade (UF)"
      return `${cidade} (${estado})`;
    }
    
    // Se só tem cidade, retorna cidade
    if (cidade) return cidade;
    
    // Se só tem estado, retorna estado
    if (estado) return estado;
  }
  
  return null;
}
// ====== FIM: Auxiliares Notificador/Messenger ======

// Carrega JSON de atendimento.json (array de respostas randomizáveis)
// IGNORADO: Respostas agora vêm do Notificador
let mensagensAtendimento = [];

function agoraEpoch() {
  return Math.floor(Date.now() / 1000);
}

const HIST_JSON_NAME = c => path.join(__dirname, '../dados/perfis', c, 'chats_respondidos.json');

// === INÍCIO: CONTROLE DE ESTADO DE CHAT (persistido APENAS em disco) ===
const CHAT_STATE_FILE = (perfil) => path.join(__dirname, '../dados/perfis', perfil, 'chats_state.json');

// Lock de arquivo (com .lck)
const fileLocks = new Map(); // file -> { pid, timestamp }

async function acquireFileLock(file, timeoutMs = 5000) {
  const lockFile = file + '.lck';
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const fd = fsRaw.openSync(lockFile, 'wx'); // cria se não existe, falha se existe
      const pid = process.pid;
      const timestamp = Date.now();
      fsRaw.writeFileSync(fd, JSON.stringify({ pid, timestamp }), 'utf8');
      fsRaw.fsyncSync(fd);
      fsRaw.closeSync(fd);
      fileLocks.set(file, { pid, timestamp });
      return true;
    } catch (e) {
      // Lock já existe, verifica se está stale (>30s)
      try {
        const lockContent = fsRaw.readFileSync(lockFile, 'utf8');
        const lockData = JSON.parse(lockContent);
        if (Date.now() - lockData.timestamp > 30000) {
          // Lock stale, remove
          try { fsRaw.unlinkSync(lockFile); } catch {}
          continue;
        }
      } catch {}
      await new Promise(r => setTimeout(r, 100)); // espera 100ms antes de tentar novamente
    }
  }
  return false;
}

async function releaseFileLock(file) {
  const lockFile = file + '.lck';
  try {
    if (fileLocks.has(file)) {
      fileLocks.delete(file);
    }
    if (fsRaw.existsSync(lockFile)) {
      fsRaw.unlinkSync(lockFile);
    }
  } catch {}
}

async function readJsonFsyncSafe(file, fb = {}) {
  const lockAcquired = await acquireFileLock(file, 5000);
  if (!lockAcquired) {
    logger.warn(`[LOCK] Timeout ao adquirir lock para ${file}`);
    return fb;
  }
  try {
    const content = await fs.readFile(file, 'utf8');
    return JSON.parse(content);
  } catch {
    return fb;
  } finally {
    await releaseFileLock(file);
  }
}

async function writeJsonFsyncAtomic(file, obj) {
  const lockAcquired = await acquireFileLock(file, 5000);
  if (!lockAcquired) {
    logger.warn(`[LOCK] Timeout ao adquirir lock para escrita em ${file}`);
    return false;
  }
  try {
    await fs.mkdir(path.dirname(file), { recursive: true });
    const tmp = file + '.tmp';
    const fd = fsRaw.openSync(tmp, 'w');
    try {
      fsRaw.writeFileSync(fd, JSON.stringify(obj, null, 2), 'utf8');
      fsRaw.fsyncSync(fd);
    } finally {
      fsRaw.closeSync(fd);
    }
    try {
      if (fsRaw.existsSync(file)) fsRaw.unlinkSync(file);
    } catch {}
    try {
      fsRaw.renameSync(tmp, file);
    } catch {
      try {
        fsRaw.copyFileSync(tmp, file);
        try { fsRaw.unlinkSync(tmp); } catch {}
      } catch {}
    }
    return true;
  } finally {
    await releaseFileLock(file);
  }
}

async function loadChatState(perfil) {
  return await readJsonFsyncSafe(CHAT_STATE_FILE(perfil), {});
}

async function saveChatState(perfil, st) {
  return await writeJsonFsyncAtomic(CHAT_STATE_FILE(perfil), st || {});
}

async function getChatState(perfil, chatId) {
  const st = await loadChatState(perfil);
  return st[chatId] || null;
}

async function setChatState(perfil, chatId, patch) {
  try {
    if (!CHAT_STATE_PENDING.has(perfil)) CHAT_STATE_PENDING.set(perfil, new Map());
    const m = CHAT_STATE_PENDING.get(perfil);
    const cur = m.get(chatId) || {};
    m.set(chatId, Object.assign(cur, patch || {}));
    scheduleChatStateFlush();
  } catch {}
}

// Estados aceitos:
const CHAT_STATES = Object.freeze({
  PENDENTE: 'pendente',
  COLETANDO: 'coletando_localizacao',
  GERANDO: 'gerando_resposta',
  ENVIANDO: 'enviando',
  ENVIADO: 'enviado',
  AGUARDANDO: 'aguardando_cliente',
  FINALIZADO: 'finalizado'
});

const SENT_COOLDOWN_MS = 60 * 1000; // mínimo de 60s
// === FIM: CONTROLE DE ESTADO DE CHAT ===

// ====== INÍCIO: Config Probe e TTL de Revalidação ======
const PROBE_RECHECK_MIN_MS = parseInt(process.env.VIRTUS_PROBE_RECHECK_MIN_MS || '60000', 10);  // mínimo entre enfileiramentos (anti-flood), default 60s
const PROBE_FORCE_OPEN_MS  = parseInt(process.env.VIRTUS_PROBE_FORCE_OPEN_MS  || '300000', 10); // forçar abertura do chat após X ms, default 5min

// Quiet-window configurável (evita travar primeira resposta)
const VIRTUS_FIRST_REPLY_QUIET_MS = parseInt(process.env.VIRTUS_FIRST_REPLY_QUIET_MS || '0', 10);    // default 0ms (primeira resposta instantânea)
const VIRTUS_NEXT_REPLY_QUIET_MS  = parseInt(process.env.VIRTUS_NEXT_REPLY_QUIET_MS  || '5000', 10); // default 5s (respostas subsequentes)
// ====== FIM: Config Probe e TTL de Revalidação ======

// ====== INÍCIO: Config Notificador e Filas ======
const NOTIFICADOR_URL = process.env.NOTIFICADOR_URL || 'https://c0nv3n13nt3t3cn0l0g14jesus.sa.ngrok.io';
const NOTIFICADOR_SERVIDOR = process.env.SERVIDOR_NOME || 'servidor1';

const NOTIFICADOR_ENVIO_LOTE_MS = parseInt(process.env.NOTIFICADOR_ENVIO_LOTE_MS || '10000', 10); // 10s
const NOTIFICADOR_POLLING_MS = parseInt(process.env.NOTIFICADOR_POLLING_MS || '1100', 10);
const MESSENGER_INTERVALO_MIN_MS = parseInt(process.env.MESSENGER_INTERVALO_MIN_MS || '30000', 10); // 30s
const MESSENGER_INTERVALO_MAX_MS = parseInt(process.env.MESSENGER_INTERVALO_MAX_MS || '60000', 10); // 60s

const filaEnviarNotificador = new Map();  // nomePerfil -> [ { chatId, tipoServico, mensagem, localizacao, urlClassificado } ]
const filaRespostas = new Map();          // nomePerfil -> [ { chat_id, resposta } ]
const filaEnvioMessenger = new Map();     // nomePerfil -> [ { chatId, resposta, key } ]
const ultimaRespostaMessenger = new Map();// nomePerfil -> timestamp
const aguardandoRespostaMap = new Map();  // nomePerfil -> Set(chatId)
const pollingIntervals = new Map();       // nomePerfil -> intervalId
const filaEnvioTimers = new Map();        // nomePerfil -> intervalId
const handshakesFeitos = new Set();       // Set(nomePerfil)

// ====== INÍCIO: Deduplicação e Sanitização ======
// Dedup por perfil: chave = ${chatId}||${hashResposta}
const pendingKeysPorPerfil = new Map(); // nomePerfil -> Set(keys)

function getPendingSet(perfil) {
  if (!pendingKeysPorPerfil.has(perfil)) pendingKeysPorPerfil.set(perfil, new Set());
  return pendingKeysPorPerfil.get(perfil);
}

function hashResposta(s) {
  try { 
    const crypto = require('crypto');
    return crypto.createHash('sha256').update(String(s || '')).digest('hex');
  } catch { 
    return String(s || ''); 
  }
}

function sanitizarResposta(texto) {
  if (!texto || typeof texto !== 'string') return '';
  let t = texto;
  
  // Corrige encoding mojibake (OlÃ¡ -> Olá)
  if (/[ÃÂ]/.test(t)) {
    try {
      const fixed = Buffer.from(t, 'latin1').toString('utf8');
      if (/[áàâãéêíóôõúçÁÀÂÃÉÊÍÓÔÕÚÇ]/.test(fixed)) t = fixed;
    } catch {}
  }
  
  // Colapsa duplicatas excessivas de caracteres (OOlláá -> Ollá)
  t = t.replace(/(.)\1{2,}/g, '$1$1');
  
  // Remove espaços múltiplos
  t = t.replace(/\s{2,}/g, ' ');
  
  return t.trim();
}
// ====== FIM: Deduplicação e Sanitização ======

// ====== FIM: Config Notificador e Filas ======

// ======= ADIÇÃO: Pending Ledger Helpers & Heurística =======
const PENDING_JSON_NAME = c => path.join(__dirname, '../dados/perfis', c, 'chats_pending.json');

async function readJson(file, fb={}) {
  const lockAcquired = await acquireFileLock(file, 5000);
  if (!lockAcquired) {
    logger.warn(`[LOCK] Timeout ao adquirir lock para ${file}`);
    return fb;
  }
  try { return JSON.parse(await fs.readFile(file, 'utf8')); } catch { return fb; }
  finally { await releaseFileLock(file); }
}
async function writeJsonAtomicFsync(file, obj){
  const lockAcquired = await acquireFileLock(file, 5000);
  if (!lockAcquired) {
    logger.warn(`[LOCK] Timeout ao adquirir lock para escrita em ${file}`);
    return false;
  }
  try {
    await fs.mkdir(path.dirname(file), { recursive: true });
    const tmp = file + '.tmp';
    const fd = await fs.open(tmp, 'w');
    try {
      await fd.writeFile(JSON.stringify(obj, null, 2), 'utf8');
      await fd.sync();
    } finally { await fd.close(); }
    try { await fs.unlink(file); } catch {}
    try { await fs.rename(tmp, file); }
    catch { await fs.copyFile(tmp, file); try { await fs.unlink(tmp);} catch{} }
    return true;
  } finally {
    await releaseFileLock(file);
  }
}
async function pendingAdd(perfil, chatId, attemptId) {
  const file = PENDING_JSON_NAME(perfil);
  const cur = await readJson(file, {});
  cur[chatId] = { attemptId, startedAt: Date.now() };
  await writeJsonAtomicFsync(file, cur);
}
async function pendingDel(perfil, chatId) {
  const file = PENDING_JSON_NAME(perfil);
  const cur = await readJson(file, {});
  if (cur[chatId]) { delete cur[chatId]; await writeJsonAtomicFsync(file, cur); }
}
async function pendingList(perfil) {
  const file = PENDING_JSON_NAME(perfil);
  return await readJson(file, {});
}
// Heurística: detecta bubble "você enviou/you sent"
async function wasRecentlySentByMe(page, maxAgeMs=10*60*1000) {
  try {
    return await page.evaluate((maxMs) => {
      const norm = s => (s||'').toLowerCase();
      const bubbles = Array.from(document.querySelectorAll('div[role="row"],div[role="article"],div[data-testid]')).slice(-50);
      const me = bubbles.reverse().find(b => {
        const txt = norm(b.innerText||b.textContent||'');
        if (/(você|voce|you)\s*(enviou|sent)/.test(txt)) return true;
        const style = getComputedStyle(b);
        return style && (style.justifyContent==='flex-end' || style.textAlign==='right');
      });
      if (!me) return false;
      // Se bubble fala em "agora", minutos, ou "há menos de 10min"
      const t = (me.innerText||'').toLowerCase();
      if (/agora|now/.test(t)) return true;
      if (/\b\d+\s*(min|m|minuto)\b/.test(t)) return true;
      if (/\b(\d+)\s*(h|hora)/.test(t)) {
        const m = t.match(/\b(\d+)\s*(h|hora)/);
        if (m && parseInt(m[1],10) <= 2) return true;
      }
      return false;
    }, maxAgeMs);
  } catch { return false; }
}

// Classificadores de tempo
// NOVO: Reduzido de 24h para 8h (menos scroll = menos RAM consumida)
function isVelho8h(tempoLabel) {
  if (!tempoLabel) return false;
  const t = String(tempoLabel)
    .normalize('NFD').replace(/[\u0300-\u036f]/g,'')
    .toLowerCase().trim();

  // Semanas sempre velho
  if (/\b(seman|sem|weeks?|w)\b/.test(t)) return true;

  // Dias: >=1 velho
  const mDias = t.match(/\b(\d+)\s*(d|dia|dias)\b/);
  if (mDias) {
    const n = parseInt(mDias[1], 10);
    if (Number.isFinite(n) && n >= 1) return true;
  }

  // Horas: >=8 velho
  const mH = t.match(/\b(\d+)\s*(h|hora|horas|hours?)\b/);
  if (mH) {
    const n = parseInt(mH[1], 10);
    if (Number.isFinite(n) && n >= 8) return true;
    return false;
  }

  // Minutos/segundos/"agora" nunca velho
  if (/\b(agora|now|just\snow)\b/.test(t)) return false;
  if (/\b(\d+)\s(s|seg|sec|secs?|seconds?)\b/.test(t)) return false;
  if (/\b(\d+)\s*(min|mins?|m|minuto|minutos|minutes?)\b/.test(t)) return false;

  // Fallback: NÃO marque como velho se não entender — considerar recente
  return false;
}
// Função corrigida para checar >=24h de fato
function isVelho24h(tempoLabel) {
  if (!tempoLabel) return false;
  const t = String(tempoLabel)
    .normalize('NFD').replace(/[\u0300-\u036f]/g,'')
    .toLowerCase().trim();

  // Semanas sempre velho
  if (/\b(seman|sem|weeks?|w)\b/.test(t)) return true;

  // Dias: >=1 velho
  const mDias = t.match(/\b(\d+)\s*(d|dia|dias)\b/);
  if (mDias) {
    const n = parseInt(mDias[1], 10);
    if (Number.isFinite(n) && n >= 1) return true;
  }

  // Horas: >=24 velho
  const mH = t.match(/\b(\d+)\s*(h|hora|horas|hours?)\b/);
  if (mH) {
    const n = parseInt(mH[1], 10);
    if (Number.isFinite(n) && n >= 24) return true;
    return false;
  }

  // Minutos/segundos/"agora" nunca velho
  if (/\b(agora|now|just\snow)\b/.test(t)) return false;
  if (/\b(\d+)\s(s|seg|sec|secs?|seconds?)\b/.test(t)) return false;
  if (/\b(\d+)\s*(min|mins?|m|minuto|minutos|minutes?)\b/.test(t)) return false;

  // Fallback: NÃO marque como velho se não entender — considerar recente
  return false;
}
function isChatRecente(tempoLabel) {
  if (!tempoLabel) return false;
  const t = String(tempoLabel)
    .normalize('NFD').replace(/[\u0300-\u036f]/g,'')
    .toLowerCase().trim();

  if (isVelho8h(t)) return false;

  if (/\b(agora|now|just\snow)\b/.test(t)) return true;
  if (/\b(\d+)\s(s|seg|sec|secs?|seconds?)\b/.test(t)) return true;
  if (/\b(\d+)\s*(min|mins?|m|minuto|minutos|minutes?)\b/.test(t)) return true;

  const mH = t.match(/\b(\d+)\s*(h|hora|horas|hours?)\b/);
  if (mH) {
    const n = parseInt(mH[1], 10);
    if (Number.isFinite(n)) {
      // <8h = recente (limite do sistema)
      return n < 8;
    }
  }

  // Fallback otimista: se não entendeu, considerar recente
  return true;
}

// Extratores e coleta
function extraiIdDoHref(href) {
  try {
    const s = String(href || '');
    const pos = s.indexOf('/marketplace/t/');
    if (pos < 0) return null;
    const rest = s.slice(pos + '/marketplace/t/'.length);
    const id = rest.split(/[/?#]/)[0];
    return id && /^\d+$/.test(id) ? id : null;
  } catch { return null;   }
}

let lastGuaranteeAt = 0;
async function maybeGuaranteeMarketplaceFast(page, nome) {
  const url = (typeof page.url === 'function' ? page.url() : '') || '';
  if (/messenger.com\/marketplace/i.test(url)) {
    const ok = await page.evaluate(() => !!document.querySelector('a[href^="/marketplace/t/"]') || !!document.querySelector('div[role="row"]')).catch(()=>false);
    if (ok) return true;
  }
  const now = Date.now();
  if ((now - lastGuaranteeAt) < 8000) return true;
  lastGuaranteeAt = now;
  await garantirMarketplace(page, { nome, allowNavigate: true });
  return true;
}

async function coletaChatsMarketplaceTodos(page) {
  try {
    const items = await page.$$eval('a[href], a[role="link"]', els => {
      function _extraiId(href) {
        try {
          const s = String(href || '');
          const pos = s.indexOf('/marketplace/t/');
          if (pos < 0) return null;
          const rest = s.slice(pos + '/marketplace/t/'.length);
          const id = rest.split(/[/?#]/)[0];
          return id && /^\d+$/.test(id) ? id : null;
        } catch { return null; }
      }
      function _extraiTempo(row) {
        if (!row) return '';
        const pickAbbr = () => {
          try {
            const abbr = row.querySelector('abbr[aria-label]');
            if (abbr) {
              const t1 = (abbr.innerText || '').trim();
              if (t1) return t1;
              const t2 = (abbr.getAttribute('aria-label') || '').trim();
              if (t2) return t2;
            }
          } catch {}
          return '';
        };
        const ab = pickAbbr();
        if (ab) return ab;
        try {
          const spans = Array.from(row.querySelectorAll('span'));
          for (const s of spans) {
            const txt = (s.innerText || s.textContent || '').trim();
            if (!txt) continue;
            if (/agora|now|just\snow/i.test(txt)) return txt;
            if (/\d+\s(s|seg|sec|secs?|seconds?|min|m|mins?|minutes?|hora|horas?|h|hours?|dia|dias?|d|seman|sem|weeks?|w)/i.test(txt)) return txt;
          }
        } catch {}
        return '';
      }
      const anchors = els.filter(a => {
        const href = a.getAttribute('href') || a.href || '';
        return !!href && href.includes('/marketplace/t/');
      });
      const arr = anchors.map(a => {
        const href = a.getAttribute('href') || a.href || '';
        const id = _extraiId(href);
        const row = a.closest('div[role="row"]') || a.parentElement;
        const tempo = _extraiTempo(row);
        return { id, tempo, href };
      }).filter(o => o.id);
      const map = new Map();
      for (const it of arr) if (!map.has(it.id)) map.set(it.id, it);
      return Array.from(map.values());
    });
    
    if (process.env.VIRTUS_FEED_DEBUG === '1') {
      try {
        const sample = items.slice(0, 8).map(i => ({ id: i.id, tempo: i.tempo, href: i.href }));
        console.log(`[VIRTUS][FEED_SAMPLE]`, sample);
      } catch {}
    }
    
    return items;
  } catch (err) {
    if (VIRTUS_DETAILED_DEBUG) { logger.debug('[VIRTUS] Erro em coletaChatsMarketplaceTodos', { err: String(err) }); }
    return [];
  }
}

// Messenger helpers
async function garantirMarketplace(page, { timeoutMs = 25000, nome = null, allowNavigate = false } = {}) {
  if (!page || typeof page.url !== 'function') throw new Error('Page inválida');
  
  const urlNow = (typeof page.url === 'function') ? (page.url() || '') : '';
  try {
    const alreadyOk = await Promise.race([
      page.evaluate(() =>
        !!(
          document.querySelector('a[href^="/marketplace/t/"]') ||
          document.querySelector('div[role="row"]') ||
          document.querySelector('div[contenteditable="true"][role="textbox"]')
        )
      ).catch(()=>false),
      new Promise(r => setTimeout(()=>r(false), 800))
    ]);
    if (alreadyOk) return;
  } catch {}

  if (!allowNavigate) {
    try { logger.info('[VIRTUS][garantirMarketplace] safe-mode: skip navigation', nome ? { nome } : {}); } catch {}
    return;
  }
  
  // NO TOPO: checagem de sendLock
  try {
    const b = getBrowserFromPage(page);
    if (b && b._sendLock && b._sendLock.active) {
      logger.info('[VIRTUS][garantirMarketplace] sendLock ativo — não navegar/não recarregar.', nome ? { nome } : {});
      return;
    }
  } catch {}
  
  if (/messenger.com\/marketplace\/t\//i.test(urlNow)) {
    logger.info('[VIRTUS][garantirMarketplace] já está em página de chat — não navegar.', nome ? { nome } : {});
    return;
  }
  
  // Função helper para tentar uma rota e verificar se está pronta
  async function gotoInboxRobust(route) {
    try {
      logger.info(`[VIRTUS][garantirMarketplace] Tentando rota: ${route}`, nome ? { nome } : {});
      await page.goto(`https://www.messenger.com${route}`, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
      
      // Cura fluxos de nonce/continuar
      try {
        const browserJs = require('./browser.js');
        if (browserJs && typeof browserJs.resolveNonceIfPresent === 'function') {
          await browserJs.resolveNonceIfPresent(page).catch(()=>{});
        }
        if (browserJs && typeof browserJs.clickContinuarComo === 'function') {
          await browserJs.clickContinuarComo(page, { timeout: 12000 }).catch(()=>{});
        }
      } catch {}
      
      // Verifica se encontrou anchor de thread ou rows
      const ok = await Promise.race([
        page.waitForFunction(() => {
          const hasAnchor = !!document.querySelector('a[href^="/marketplace/t/"]');
          const hasRow = document.querySelectorAll('div[role="row"]').length > 0;
          return hasAnchor || hasRow;
        }, { timeout: 8000 }),
        page.waitForSelector('a[href^="/marketplace/t/"]', { timeout: 8000 }).catch(() => null),
        page.waitForSelector('div[role="row"]', { timeout: 8000 }).catch(() => null)
      ]);
      
      if (ok) {
        logger.info(`[VIRTUS][garantirMarketplace] UI pronta na rota: ${route}`, nome ? { nome } : {});
        return true;
      } else {
        logger.warn(`[VIRTUS][garantirMarketplace] Rota ${route} não encontrou anchors/rows`, nome ? { nome } : {});
        return false;
      }
    } catch (e) {
      logger.warn(`[VIRTUS][garantirMarketplace] Erro ao tentar rota ${route}: ${e && e.message || e}`, nome ? { nome } : {});
      return false;
    }
  }
  
  let url = '';
  try { url = page.url() || ''; } catch {}
  
  // Se já está no marketplace, verifica se está pronto
  if (/messenger.com\/marketplace/i.test(url)) {
    try {
      const hasAnchor = await page.$('a[href^="/marketplace/t/"]').catch(() => null);
      const hasRow = await page.$('div[role="row"]').catch(() => null);
      if (hasAnchor || hasRow) {
        logger.info('[VIRTUS][garantirMarketplace] UI já pronta na página atual');
        return;
      }
    } catch {}
  }
  
  // Tenta as rotas em ordem (removida rota incorreta /marketplace/you/selling/messages)
  const rotas = [
    '/marketplace',
    '/marketplace/inbox'
  ];
  
  for (const rota of rotas) {
    const ok = await gotoInboxRobust(rota);
    if (ok) {
      return; // Sucesso, marketplace pronto
    }
  }
  
  // Se nenhuma rota funcionou, loga warning e não prossegue
  logger.warn('[VIRTUS][garantirMarketplace] Nenhuma rota conseguiu carregar marketplace com anchors/rows', nome ? { nome } : {});
  throw new Error('Marketplace UI não ficou pronta a tempo em nenhuma rota');
}

// ========== INÍCIO DAS FUNÇÕES E GUARDRAILS SOLICITADAS ==========

/**
 * GUARD: manter top chats always visible to avoid drifting out of viewport.
 * Função utilitária para scrollar a lista de chats para o topo.
 * Executa direto via page.evaluate no Messenger.
 */
async function scrollChatsToTop(page, nome) {
  if (isVirtusLocked(nome)) return true; // Não retorna false, apenas não clica
  try {
    const b = getBrowserFromPage(page);
    if (b && b._sendLock && b._sendLock.active) return true; // Não retorna false, apenas não clica
  } catch {}
  if (!page) return false;
  try {
    const res = await page.evaluate(() => {
      // Procure vários elementos "scrolláveis"
      // 1. grid por role
      let grid = document.querySelector('div[role="grid"]');
      // 2. por data-virtualized e classes do FB
      if (!grid) grid = document.querySelector('div.x78zum5.xdt5ytf[data-virtualized="false"]');
      // 3. rowgroup
      if (!grid) grid = document.querySelector('div[role="rowgroup"]');
      // 4. fallback classe base
      if (!grid) grid = document.querySelector('div.x78zum5.xdt5ytf');
      // 5. heurística de altura
      if (!grid) grid = Array.from(document.querySelectorAll('div'))
        .find(d => d.scrollHeight > 400 && d.scrollHeight > d.clientHeight + 30);
      // 6. fallback body
      if (!grid) grid = document.body;
      if (!grid) return false;

      // Forçar scrollTop em grid e ancestrais
      grid.scrollTop = 0;
      let node = grid.parentElement;
      for (let i = 0; i < 4 && node; i++) {
        if (node.scrollHeight > node.clientHeight + 30) node.scrollTop = 0;
        node = node.parentElement;
      }

      // Tentativa extra: clicar em cima no topo para garantir foco no chat mais recente
      try {
        let firstA = grid.querySelector('a[role="link"], a[href^="/marketplace/t/"]');
        if (firstA) {
          firstA.focus && firstA.focus();
          // Eventual scrollIntoView + toTop
          firstA.scrollIntoView({block: "start", behavior: "smooth"});
        }
      } catch {}

      // Se scroll ainda não foi suficiente (scrollTop > 0 depois do set), repete
      setTimeout(() => { if (grid.scrollTop > 0) grid.scrollTop = 0; }, 250);

      return grid.scrollTop === 0;
    });
    return !!res;
  } catch (err) {
    return false;
  }
}

// ========== FIM DOS GUARDRAILS E FUNÇÕES NOVAS ==========

// ========== INÍCIO DA FUNÇÃO sendMessageSafe ==========
// Helpers para confirmação robusta de envio
function normalize(s) {
  try {
    return String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().toLowerCase();
  } catch {
    return String(s || '').trim().toLowerCase();
  }
}

async function getMySentSnapshot(p) {
  try {
    return await p.evaluate(() => {
      const norm = s => (s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
      const rows = Array.from(document.querySelectorAll('div[role="row"],div[role="article"],div[data-testid]'));
      let total = 0, lastText = '', lastWhen = '', lastIdx = -1;
      
      for (let i = 0; i < rows.length; i++) {
        const el = rows[i];
        const txt = (el.innerText || el.textContent || '').trim();
        const tnorm = norm(txt);
        const isMine = /\b(you\s+sent|voc[eê]\s+enviou)\b/.test(tnorm);
        
        if (isMine) {
          total++;
          lastText = txt;
          lastIdx = i;
        }
      }
      
      if (lastIdx >= 0) {
        // tenta pegar "quando" em abbr/aria-label
        const lastEl = rows[lastIdx];
        let when = '';
        try {
          const abbr = lastEl.querySelector('abbr[aria-label]');
          if (abbr) when = (abbr.getAttribute('aria-label') || abbr.innerText || abbr.textContent || '').trim();
        } catch {}
        
        if (!when) {
          // fallback: procurar spans pequenos com "agora", "1 min", etc.
          const spans = lastEl ? Array.from(lastEl.querySelectorAll('span')) : [];
          for (const s of spans) {
            const t = (s.innerText || s.textContent || '').trim();
            if (/\b(agora|now|\d+\s*(s|seg|secs?|seconds?|min|mins?|minutes?))\b/i.test(t)) {
              when = t;
              break;
            }
          }
        }
        lastWhen = when;
      }
      
      return { total, lastText, lastWhen };
    });
  } catch {
    return { total: 0, lastText: '', lastWhen: '' };
  }
}

async function sendMessageSafe(p, campo, msg, nome, chatId) {
  // 0) Reobtenha o composer se campo for ausente ou suspeito
  try {
    if (!campo || (await campo.evaluate(el => !el.isConnected).catch(()=>true))) {
      const sels = [
        'div[contenteditable="true"][role="textbox"]',
        'div[contenteditable="true"][aria-label]',
        'div[contenteditable="true"]',
        'div[role="combobox"][contenteditable="true"]',
        'div[aria-label="Mensagem"]',
        'div[aria-label*="mensagem"]'
      ];
      for (const sel of sels) {
        const h = await p.$(sel).catch(()=>null);
        if (h) {
          const ok = await h.evaluate(el => {
            const st = window.getComputedStyle(el);
            return el.isConnected && st && st.visibility !== 'hidden' && st.display !== 'none' && el.offsetParent !== null;
          }).catch(()=>false);
          if (ok) { campo = h; break; }
        }
      }
    }
  } catch {}
  if (!campo) {
    await logIssue(nome, 'mil_action', `virtus_no_composer chat=${chatId}`);
    return;
  }

  // Valida URL antes de começar a digitar (hard check)
  try {
    const urlNow = (typeof p.url === 'function') ? (p.url() || '') : '';
    if (!chatUrlMatches(urlNow, chatId)) {
      await logIssue(nome, 'mil_action', `virtus_context_abort: url_mismatch_before_type chat=${chatId} url="${urlNow}"`);
      return; // aborta o envio neste chat
    }
  } catch {}

  // Verificar contexto antes de digitar
  if (!(await assertOnChat(p, chatId, { timeoutMs: 0 }))) {
    await logIssue(nome, 'mil_action', `virtus_context_abort: before_type (chat ${chatId})`);
    return;
  }

  const ctrlKey = (process.platform === 'darwin') ? 'Meta' : 'Control';

  setVirtusInputLock(nome, true);
  try {
    // Foco real no composer
    await campo.click({ delay: 20 }).catch(()=>{});
    // Limpeza: Select All + Backspace/Delete
    try {
      await p.keyboard.down(ctrlKey);
      await p.keyboard.press('KeyA');
      await p.keyboard.up(ctrlKey);
    } catch {}
    try { await p.keyboard.press('Backspace'); } catch {}
    try { await p.keyboard.press('Delete'); } catch {}
    // Aguarda esvaziar (tolerante)
    await p.waitForFunction(
      el => ((el.innerText || el.textContent || '').trim().length === 0),
      { timeout: 1200 },
      campo
    ).catch(()=>{});

    // Digita uma única vez (sem execCommand/insertText) - COM SANITIZAÇÃO
    const stGreet = await getChatState(nome, chatId).catch(()=>null);
    const greetedFlag = !!(stGreet && stGreet.flow && stGreet.flow.greeted);
    const toSend = enforceGovRulesOnText(String(msg || ''), { alreadyGreeted: greetedFlag });
    await p.keyboard.type(toSend, { delay: 0 });

    // Revalida URL antes de pressionar Enter (hard check)
    try {
      const urlNow2 = (typeof p.url === 'function') ? (p.url() || '') : '';
      if (!chatUrlMatches(urlNow2, chatId)) {
        await clearComposerIfAny(p, campo);
        await logIssue(nome, 'mil_action', `virtus_context_abort: url_mismatch_before_enter chat=${chatId} url="${urlNow2}"`);
        return; // aborta o envio neste chat
      }
    } catch {}

    // Revalidar contexto antes do Enter
    if (!(await assertOnChat(p, chatId, { timeoutMs: 0 }))) {
      await clearComposerIfAny(p, campo);
      await logIssue(nome, 'mil_action', `virtus_context_abort: before_enter (chat ${chatId})`);
      return;
    }

    // NOVO: Confirmação ROBUSTA - tirar snapshot ANTES de enviar
    const expected = String(msg || '').trim();
    const before = await getMySentSnapshot(p);
    logger.debug('[MESSENGER] Snapshot antes do envio', { nome, chatId, beforeTotal: before.total });

    // ATRASO HUMANO REAL ENTRE RESPOSTAS (5-15 segundos)
    const minD = parseInt(process.env.VIRTUS_REPLY_MIN_MS || '5000', 10); // 5s
    const maxD = parseInt(process.env.VIRTUS_REPLY_MAX_MS || '15000', 10); // 15s
    const delay = Math.max(0, Math.min(maxD, Math.floor(Math.random()*(maxD-minD+1))+minD));
    logger.debug('[MESSENGER] Delay humano antes de enviar', { nome, chatId, delayMs: delay });
    await new Promise(r=>setTimeout(r, delay));

    // Envia (um único Enter)
    await p.keyboard.press('Enter');
    logger.debug('[MESSENGER] Enter pressionado, aguardando confirmação robusta', { nome, chatId });

    // NOVO: Confirmação ROBUSTA - verificar que número de bolhas aumentou + texto coincide (SEM whenRecent)
    function normalizeMsg(s) {
      try {
        return String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
      } catch {
        return String(s || '').trim().toLowerCase();
      }
    }

    const expectedNorm = normalizeMsg(expected);
    const sent = await p.waitForFunction(
      (beforeCount, expectedNorm) => {
        function getSnap() {
          const rows = Array.from(document.querySelectorAll('div[role="row"],div[role="article"],div[data-testid]'));
          let total = 0, lastText = '';

          for (let i = 0; i < rows.length; i++) {
            const el = rows[i];
            const txt = (el.innerText || el.textContent || '').trim();
            if (!txt) continue;

            // considera "minhas" bolhas por alinhamento à direita ou presença do rótulo textual
            let isMine = false;
            try {
              const st = window.getComputedStyle(el);
              if (st && (st.justifyContent === 'flex-end' || st.textAlign === 'right')) isMine = true;
            } catch {}

            const n = String(txt).toLowerCase();
            if (/\b(you\s+sent|voc[eê]\s+enviou)\b/i.test(n)) isMine = true;

            if (isMine) {
              total++;
              lastText = txt;
            }
          }

          return { total, lastText };
        }

        const snap = getSnap();
        if (snap.total <= beforeCount) return false;

        const lastNorm = String(snap.lastText || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\s+/g, ' ').trim().toLowerCase();

        // confirmação: contagem aumentou E último texto contém (normalizado) o esperado
        return lastNorm.includes(expectedNorm);
      },
      { timeout: 12000 },
      before.total,
      expectedNorm
    ).catch(() => false);

    let mensagemEnviada = sent;
    if (!sent) {
      // Verificação adicional: talvez a mensagem foi enviada mas a confirmação falhou
      // Verifica se o composer foi esvaziado (indicativo de envio)
      const composerEmpty = await p.evaluate(() => {
        const composers = Array.from(document.querySelectorAll('div[contenteditable="true"][role="textbox"]'));
        for (const comp of composers) {
          const txt = (comp.innerText || comp.textContent || '').trim();
          if (txt.length === 0) return true;
        }
        return false;
      }).catch(() => false);
      
      if (composerEmpty) {
        // Composer vazio = mensagem provavelmente foi enviada, mesmo sem confirmação robusta
        logger.warn('[MESSENGER] ⚠️ Confirmação robusta falhou, mas composer vazio (mensagem provavelmente enviada)', { 
          nome, 
          chatId,
          beforeTotal: before.total
        });
        mensagemEnviada = true; // Assume que enviou
      } else {
        // Composer ainda tem texto = mensagem não foi enviada
        logger.error('[MESSENGER] ❌ FALHA: mensagem não enviada (composer não vazio)', { 
          nome, 
          chatId,
          beforeTotal: before.total
        });
        await logIssue(nome, 'virtus_send_failed', 'send_confirmation_robust_timeout');
        // Não lança erro - apenas loga e continua (evita bloquear o sistema)
        // Mas não marca como enviado
      }
    }
    
    // Só marca como enviado se realmente enviou (ou composer vazio)
    if (mensagemEnviada) {
      logger.info('[MESSENGER] ✅ Mensagem confirmada (robusta ou composer vazio)', {
        nome,
        chatId,
        beforeTotal: before.total,
        metodo: sent ? 'contagem_aumentou_texto_coincide' : 'composer_vazio_fallback'
      });
    }

    // Marcar estado após envio (apenas se realmente enviou)
    if (mensagemEnviada) {
      try {
        // Atualiza lastIATs mas NÃO bloqueia com cooldown longo - permite continuidade da conversa
        // O cooldown só serve para evitar spam, não para bloquear respostas subsequentes
        await setChatState(nome, chatId, {
          state: CHAT_STATES.AGUARDANDO,
          lastIATs: Date.now()
          // Removido cooldownUntil aqui - será aplicado apenas se necessário (evitar spam)
        });
      } catch {}
    }

  } finally {
    setVirtusInputLock(nome, false);
  }
}
// ========== FIM DA FUNÇÃO sendMessageSafe ==========

async function startVirtus(browser, nome, robeMeta = {}) {
  // Na primeira linha dentro de startVirtus, após argumentos:
  let requiredEpoch = 0;
  if (arguments.length >= 3 && arguments[2] && arguments[2].epoch != null) {
    requiredEpoch = arguments[2].epoch;
  }
  // Broker fence: sempre leia do browser._fenceEpochMap
  function epochOk() {
    try {
      if (browser && browser._fenceEpochMap && typeof browser._fenceEpochMap[nome] !== "undefined") {
        return browser._fenceEpochMap[nome] === requiredEpoch;
      }
      // Compat: se não definido, considera ok
      return true;
    } catch { return false; }
  }

  const attId = stepLog.attemptId();
  stepLog.appendJSONL(nome, 'virtus', { attempt: attId, step: 'start' });

  // ========== INÍCIO BLOCO FREEZER INSTRUÇÃO 1 ==========
  // Checagem ultra robusta de freezer
  let manifestFrozenUntil = 0;
  try {
    const manifest = await manifestStore.read(nome);
    manifestFrozenUntil = typeof manifest?.frozenUntil === 'number' ? manifest.frozenUntil : 0;
  } catch {}
  if (manifestFrozenUntil && manifestFrozenUntil > Date.now()) {
    const log = (...args) => logger.info(args.join(' '), { nome });
    log(`[VIRTUS][${nome}] virtus_skip_frozen — perfil congelado até ${new Date(manifestFrozenUntil).toISOString()}`);
    if (issues) try { await logIssue(nome, 'virtus_skip_frozen', `perfil congelado até ${new Date(manifestFrozenUntil).toISOString()}`); } catch {}
    return { stop: async () => {} }; // Virtus runner no-op
  }
  // ========== FIM BLOCO FREEZER INSTRUÇÃO 1 ==========

  const log = (...args) => logger.info(args.join(' '), { nome });

  let running = true;
  let page = null;
  let fila = [];
  let historico = {};
  let chatAtivo = null;

  const HIST_FILE = HIST_JSON_NAME(nome);
  const NO_REPEAT_WINDOW_SEC = 72 * 3600; // 72h de bloqueio hardcoded para blindagem absoluta antiflood
  const POLL_INTERVAL_MS = parseInt(process.env.VIRTUS_POLL_MS || '1000', 10);
  const MIN_REPLY_DELAY_MS = 0;
  const MAX_REPLY_DELAY_MS = 0;

  // cache em memória e timers
  const RESP_CACHE_MAX = 5000;
  function setResponded(id, ts) {
    if (!respondedCache.has(id) && respondedCache.size >= RESP_CACHE_MAX) {
      const first = respondedCache.keys().next().value;
      if (first !== undefined) respondedCache.delete(first);
    }
    respondedCache.set(id, ts);
  }
  const respondedCache = new Map();

  // ====== INÍCIO: Cooldown de Prova e Detecção de Novas Mensagens ======
  // Caches para evitar "martelar" o mesmo chat a cada loop
  const lastProbeMap = new Map(); // chatId -> Date.now() da última prova/checagem
  const lastClientTsMap = new Map(); // chatId -> ms do último cliente visto (memória local, opcional)

  function tsNum(x) {
    if (!x) return 0;
    const n = typeof x === 'number' ? x : Date.parse(x);
    return Number.isFinite(n) ? n : 0;
  }
  // ====== FIM: Cooldown de Prova e Detecção de Novas Mensagens ======

  // MILITAR: Timers unificados
  let filaInterval = null;
  let filaChatTimer = null;
  let scrollInterval = null; // Militar: cleaning interval to prevent interval leak

  let lastScrollToTop = 0;

  // trackers
  let saveChain = Promise.resolve();
  let filaLoopBusy = false;
  let recoverBackoffMs = 0;
  const failCounts = new Map();
  // Limpeza/cap failCounts — nunca deve passar de 1000
  function setFailCount(chatId, n) {
    if (!failCounts.has(chatId) && failCounts.size >= 1000) {
      const first = failCounts.keys().next().value;
      if (first !== undefined) failCounts.delete(first);
    }
    failCounts.set(chatId, n);
  }

  // Persistência segura no Windows
  async function salvaHistorico() {
    saveChain = saveChain.then(async () => {
      try {
        await fs.mkdir(path.dirname(HIST_FILE), { recursive: true });
        const tmp = HIST_FILE + '.tmp';
        const fd = await fs.open(tmp, 'w');
        try {
          await fd.writeFile(JSON.stringify(historico, null, 2), 'utf8');
          await fd.sync();
        } finally { await fd.close(); }
        try { await fs.unlink(HIST_FILE); } catch {}
        try { await fs.rename(tmp, HIST_FILE); }
        catch { await fs.copyFile(tmp, HIST_FILE); try { await fs.unlink(tmp); } catch {} }
      } catch (e) {
        logger.error('Erro ao salvar histórico Virtus', { nome }, e);
      }
    }).catch(err => logger.error('Erro em cadeia de salvamento Virtus', { nome }, err));
    return saveChain;
  }

  async function carregaHistorico() {
    try {
      // Fallback .tmp órfão
      const tmp = HIST_FILE + '.tmp';
      try { await fs.access(HIST_FILE); }
      catch {
        if (await fs.access(tmp).then(()=>true).catch(()=>false)) {
          try { await fs.rename(tmp, HIST_FILE); }
          catch { await fs.copyFile(tmp, HIST_FILE); try { await fs.unlink(tmp);} catch{} }
        }
      }
      const txt = await fs.readFile(HIST_FILE, 'utf-8');
      historico = JSON.parse(txt);
    } catch {
      historico = {};
    }
    respondedCache.clear();
    const agora = agoraEpoch();
    for (const id of Object.keys(historico)) {
      const ts = Number(historico[id]) || 0;
      if (ts && (agora - ts) < NO_REPEAT_WINDOW_SEC) {
        setResponded(id, ts);
      }
    }
  }

  function limpaHistoricoVelho() {
    let mudanca = false;
    const agora = agoraEpoch();
    Object.keys(historico).forEach(id => {
      const ts = Number(historico[id]) || 0;
      if (!ts || (agora - ts) >= NO_REPEAT_WINDOW_SEC) {
        delete historico[id];
        respondedCache.delete(id);
        mudanca = true;
        log(`Histórico limpo: ${id} removido (>24h)`);
      }
    });
    // Garantir cap adicional do respondedCache
    while (respondedCache.size > RESP_CACHE_MAX) {
      const first = respondedCache.keys().next().value;
      if (first !== undefined) respondedCache.delete(first);
      mudanca = true;
    }
    return mudanca;
  }

  let ensurePagePromise = null;
  let lastDeadLogAt = 0;

  async function ensurePage() {
    if (!running || !epochOk()) return null;
    if (ensurePagePromise) {
      try { return await ensurePagePromise; } catch { return null; }
    }
    ensurePagePromise = (async () => {
      if (!running || !epochOk()) return null;
      if (!browser || (browser.isConnected && browser.isConnected() === false)) {
        const now = Date.now();
        if (!virtusDeadLogTimes[nome] || now - virtusDeadLogTimes[nome] > 60000) {
          virtusDeadLogTimes[nome] = now;
          logger.warn('Browser morto, não é possível garantir page', { nome });
          if (issues) try { await logIssue(nome, 'virtus_page_dead', 'browser morto/disconnected'); } catch {}
        }
        return null;
      }
      try {
        let pages = await browser.pages();
        if (pages && pages[0]) {
          page = pages[0];
          if (page && typeof page.isClosed === 'function' && page.isClosed()) {
            page = null;
          }
        }
        // NÃO FECHAR EXTRAS se há busca ativa (BLOQUEIO CRÍTICO)
        try {
          if (browser._buscasLocalizacaoAtivas && browser._buscasLocalizacaoAtivas.size > 0) {
            // apenas retorna a main page disponível
            return page;
          }
        } catch {}

        try {
          if (browser && browser._robeActiveFor === nome) {
            // nada
          } else {
            const allPages = await browser.pages();
            if (Array.isArray(allPages) && allPages.length > 1) {
              const MAX_BUSCA_LOCALIZACAO_AGE_MS = 60000;
              const now = Date.now();
              for (let i = allPages.length - 1; i >= 1; i--) {
                const p = allPages[i];
                try {
                  if (p._buscaLocalizacao === true) {
                    const age = now - (p._buscaLocalizacaoSince || 0);
                    if (age < MAX_BUSCA_LOCALIZACAO_AGE_MS) {
                      continue; // protegido
                    }
                    try { delete p._buscaLocalizacao; } catch {}
                    try { delete p._buscaLocalizacaoSince; } catch {}
                    try { delete p._buscaLocalizacaoChatId; } catch {}
                  }
                } catch {}
                let u = '';
                try { u = await p.url(); } catch {}
                if (/facebook.com\/marketplace\/create\/item/i.test(u)) continue; // NUNCA fechar create item
                try { await p.close({ runBeforeUnload:false }).catch(()=>{}); } catch {}
              }
            }
          }
        } catch {}
        if (!page) {
          if (!running || !epochOk()) return null;
          // cria nova aba
          const newP = await browser.newPage();
          try {
            const manifest = await manifestStore.read(nome);
            const coords = utils.getCoords((manifest && manifest.cidade) ? manifest.cidade : '');
            if (!running || !epochOk()) return null;
            await patchPage(nome, newP, coords);
            if (!running || !epochOk()) return null;
            await ensureMinimizedWindowForPage(newP);
          } catch (e) {
            logger.warn('ensurePage: falha patchPage/minimize na nova aba', { nome }, e);
          }
          try { newP.once && newP.once('close', () => { if (page === newP) page = null; }); } catch {}
          page = newP;
        }
        if (!running || !epochOk()) return null;
        if (!browser || (browser.isConnected && browser.isConnected() === false)) return null;
        if (page && typeof page.isClosed === 'function' && page.isClosed()) return null;

        try { page.removeAllListeners('dialog'); } catch {}
        try {
          page.on('dialog', async (dlg) => {
            try {
              const t = dlg.type && dlg.type();
              const m = (dlg.message && dlg.message()) || '';
              if (t === 'beforeunload' || /recarregar|atualizar|leave this page|continuar/i.test(m)) {
                await dlg.accept().catch(()=>{});
                stepLog.appendJSONL(nome, 'virtus', { attempt: attId, step: 'beforeunload_accept' });
              } else {
                await dlg.dismiss().catch(()=>{});
              }
            } catch {}
          });
        } catch {}

        return page;
      } catch (e) {
        logger.error('ensurePage falhou', { nome }, e);
        return null;
      }
    })();
    try { return await ensurePagePromise; }
    finally { ensurePagePromise = null; }
  }

  function bumpRecoverBackoff() {
    recoverBackoffMs = Math.min(32000, (recoverBackoffMs || 1000) * 2); // Backoff exponencial até 32s
  }
  function resetRecoverBackoff() {
    recoverBackoffMs = 0;
  }

  const COMPOSER_SELECTORS = [
    'div[contenteditable="true"][role="textbox"]',
    'div[contenteditable="true"][aria-label]',
    'div[contenteditable="true"]',
    'div[role="combobox"][contenteditable="true"]',
    'div[aria-label="Mensagem"]',
    'div[aria-label*="mensagem"]'
  ];

  const CHAT_BLOCKED_PATTERNS = [
    /vo[cç]e\s+n[aã]o\s+pode\s+enviar\s+mensagens/i,
    /mensagem\s+indispon[íi]vel/i,
    /vo[cç]e\s+n[aã]o\s+est[aá]\s+mais\s+neste\s+grupo/i,
    /vo[cç]e\s+saiu\s+do\s+grupo/i,
    /you\s+can[’']?t\s+send\s+messages/i,
    /message\s+unavailable/i
  ];
  const CHAT_BLOCKED_ALERT_SELECTOR = 'div[role="alert"]';

  async function isChatBlocked(p) {
    try {
      const alertExists = await p.$(CHAT_BLOCKED_ALERT_SELECTOR);
      if (alertExists) {
        const txt = await p.evaluate(el => (el.innerText || el.textContent || '').trim(), alertExists);
        if (txt && CHAT_BLOCKED_PATTERNS.some(rx => rx.test(txt))) return true;
      }
      const txts = await p.$$eval('div, span, h1, h2', els =>
        els.slice(0, 200).map(el => (el.innerText || el.textContent || '').trim()).filter(Boolean)
      );
      for (const t of txts) {
        if (CHAT_BLOCKED_PATTERNS.some(rx => rx.test(t))) return true;
      }
    } catch {}
    return false;
  }

  async function waitForComposer(p, timeoutMs = 10000) {
    const start = Date.now();
    while ((Date.now() - start) < timeoutMs) {
      for (const sel of COMPOSER_SELECTORS) {
        try {
          const h = await p.$(sel);
          if (h) {
            const ok = await p.evaluate(el => {
              const st = window.getComputedStyle(el);
              const vis = st && st.visibility !== 'hidden' && st.display !== 'none' && el.offsetParent !== null;
              const disabled = el.hasAttribute('disabled') || el.getAttribute('aria-disabled') === 'true';
              return vis && !disabled;
            }, h);
            if (ok) return h;
          }
        } catch {}
      }
      await sleep(250);
    }
    return null;
  }

  async function refocusComposerNoReload(p, chatId, anchorSel) {
    try {
      logger.info('[COMPOSER] Refocus (sem navegação)', { chatId });
      try { await p.evaluate(() => { try { window.scrollBy(0, 120); } catch {} }); } catch {}

      // Apenas requery do composer e pequenas tentativas de focus/tab
      const campo = await waitForComposer(p, 5000);
      if (campo) return campo;

      try {
        await p.evaluate(() => { try { document.body && document.body.focus && document.body.focus(); } catch {} });
        await p.keyboard.press('Tab').catch(()=>{});
      } catch {}

      const campo2 = await waitForComposer(p, 3000);
      if (campo2) return campo2;
    } catch (e) {
      logger.warn('[COMPOSER] Refocus falhou (sem navegação)', { chatId, error: e && e.message || e });
    }
    return null;
  }

  function incFail(chatId) {
    const n = (failCounts.get(chatId) || 0) + 1;
    setFailCount(chatId, n);
    return n;
  }
  function resetFail(chatId) {
    failCounts.delete(chatId);
  }

  async function coletaChatsMarketplaceRecentes() {
    try {
      if (!running || !epochOk()) return [];
      const p = await ensurePage();
      if (!p) {
        logger.warn(`[VIRTUS][${nome}] ensurePage retornou null em coletaChatsMarketplaceRecentes()`);
        return [];
      }

      // CRÍTICO: Primeiro, verificar chats já respondidos que podem ter novas mensagens
      // Esses chats devem ser sempre verificados, independente do tempo
      const chatsRespondidosParaVerificar = [];
      try {
        const todosEstados = await loadChatState(nome).catch(() => ({}));
        for (const [chatId, st] of Object.entries(todosEstados || {})) {
          if (st && (st.state === CHAT_STATES.AGUARDANDO || st.state === CHAT_STATES.ENVIADO)) {
            // Chat já respondido - sempre verificar para novas mensagens
            chatsRespondidosParaVerificar.push({ id: chatId, tempo: 'agora', jaRespondido: true });
          }
        }
      } catch {}

      // 1) Garantir Marketplace (com logs) - versão otimizada
      try {
        await maybeGuaranteeMarketplaceFast(p, nome);
      } catch (err) {
        logger.warn(`[VIRTUS][${nome}] maybeGuaranteeMarketplaceFast falhou: ${(err && err.message) || err}`);
        await sleep(2000);
        // Mesmo se falhar, retorna chats já respondidos para verificar
        return chatsRespondidosParaVerificar;
      }

      // 2) Espera mínima por elementos do feed
      try {
        await Promise.race([
          p.waitForSelector('a[href^="/marketplace/t/"]', { timeout: 5000 }),
          p.waitForSelector('div[role="row"] span', { timeout: 5000 })
        ]);
      } catch {
        logger.info(`[VIRTUS][${nome}] timeout curto aguardando anchors/rows`);
      }

      // 3) Coleta inicial
      let todos = await coletaChatsMarketplaceTodos(p);
      logger.info(`[VIRTUS][${nome}] coletaTodos inicial: ${todos.length} itens`);

      // 4) Se nada encontrado ou poucos itens/nenhum recente, tentar scroll até 8h e recolher
      if (!todos || todos.length === 0) {
        logger.info(`[VIRTUS][${nome}] coleta vazia — ativando scrollListaAte8h()`);
        try {
          await scrollListaAte8h(p, { maxMs: 60000, quietLoops: 2 });
        } catch (e) {
          logger.warn(`[VIRTUS][${nome}] scrollListaAte8h falhou: ${(e && e.message) || e}`);
        }
        todos = await coletaChatsMarketplaceTodos(p);
        logger.info(`[VIRTUS][${nome}] coletaTodos após scroll: ${todos.length} itens`);
      }

      // 5) Filtra recentes (<=8h) com logs
      const filtrados = (todos || []).filter(c => c.id && isChatRecente(c.tempo));
      logger.info(`[VIRTUS][${nome}] filtrados recentes: ${filtrados.length} / ${todos.length}`);
      if (process.env.VIRTUS_FEED_DEBUG === '1') {
        for (const it of (todos || [])) {
          logger.info(`[VIRTUS][${nome}] CHAT FEED: id=${it.id} tempo="${it.tempo}" recent=${isChatRecente(it.tempo)}`);
        }
      }

      // CRÍTICO: Adiciona chats já respondidos para verificar novas mensagens
      // Esses chats são sempre verificados, independente do tempo
      const idsFiltrados = new Set(filtrados.map(c => c.id));
      for (const chatRespondido of chatsRespondidosParaVerificar) {
        if (!idsFiltrados.has(chatRespondido.id)) {
          filtrados.push(chatRespondido);
          logger.info(`[VIRTUS][${nome}] Chat já respondido adicionado para verificação: ${chatRespondido.id}`);
        }
      }

      return filtrados;
    } catch (err) {
      logger.error(`[VIRTUS][${nome}] Erro em coletaChatsMarketplaceRecentes(): ${(err && err.message) || err}`, {}, err);
      return [];
    }
  }

  // Reconciliação de pendências
  async function reconcilePendingsIfAny() {
    if (!running || !epochOk()) return;
    try {
      const pend = await pendingList(nome);
      const keys = Object.keys(pend||{});
      if (!keys.length) return;
      const p = await ensurePage();
      if (!p) return;
      for (const chatId of keys) {
        const rec = pend[chatId] || {};
        const age = Date.now() - (rec.startedAt || 0);
        if (age < 8*60*1000) continue; // deixa “aquecendo” 8min antes de reconciliar
        try {
          if (!running || !epochOk()) return;
          const urlNow = (typeof p.url === 'function') ? (p.url() || '') : '';
          if (!chatUrlMatches(urlNow, chatId)) {
            continue; // Skip se não está no chat correto (sem navegação)
          }
          const looksSent = await wasRecentlySentByMe(p, 10*60*1000);
          if (looksSent) {
            // considera “committed”
            const tsNow = agoraEpoch();
            historico[chatId] = tsNow;
            setResponded(chatId, tsNow);
            await salvaHistorico();
            await pendingDel(nome, chatId);
          } else {
            // rollback: libera para reenvio
            await pendingDel(nome, chatId);
          }
        } catch { /* segue próximo */ }
      }
    } catch {}
  }

  async function initHistoricoSePreciso() {
    if (!running || !epochOk()) return;
    
    // Por padrão deve ser '0' (sem snapshot)
    const FIRST_BOOT_SNAPSHOT = (process.env.VIRTUS_FIRST_BOOT_SNAPSHOT ?? '0') === '1';
    
    try {
      await fs.access(HIST_FILE);
      await carregaHistorico();
      await reconcilePendingsIfAny();
      logger.info('[SNAPSHOT] Histórico existente carregado. Retomando pendentes <24h.', { nome });
      return;
    } catch {}

    // Snapshot desabilitado por padrão
    if (!FIRST_BOOT_SNAPSHOT) {
      logger.info('[SNAPSHOT] Modo seguro: não marcando recents como respondidos no primeiro boot. (Defina VIRTUS_FIRST_BOOT_SNAPSHOT=1 para habilitar)', { nome });
      await carregaHistorico();
      await reconcilePendingsIfAny();
      return;
    }

    // Só chama snapshot se VIRTUS_FIRST_BOOT_SNAPSHOT=1, e só marca como respondido chats que estejam isVelho24h(chat.tempo) === true
    logger.info('[SNAPSHOT] Primeiro boot sem histórico. Coletando chats >=24h para marcar como respondidos.', { nome });
    if (!running || !epochOk()) return;
    const p = await ensurePage();
    if (!p) { logger.warn('[SNAPSHOT] Falha ao garantir aba zero.', { nome }); return; }
    if (!running || !epochOk()) return;
    await maybeGuaranteeMarketplaceFast(p, nome);
    await maybeGuaranteeMarketplaceFast(p, nome);
    try {
      await Promise.race([
        p.waitForSelector('a[href^="/marketplace/t/"]', { timeout: 8000 }),
        p.waitForSelector('div[role="row"] span', { timeout: 8000 })
      ]);
    } catch {}
    try { await scrollListaAte8h(p, { maxMs: 90000, quietLoops: 3 }); } catch {}
    const todos = await coletaChatsMarketplaceTodos(p);
    // CORREÇÃO: só marca como respondido chats que estejam isVelho24h(chat.tempo) === true
    const velhos = todos.filter(c => isVelho24h(c.tempo));
    const agora = agoraEpoch();
    historico = {};
    for (const chat of velhos) historico[chat.id] = agora;
    await salvaHistorico();
    await carregaHistorico();
    await reconcilePendingsIfAny();
    logger.info(`[SNAPSHOT] Concluído. ${velhos.length} chats >=24h marcados como respondidos no primeiro boot.`, { nome });
  }

  // NOVO: Reduzido de 24h para 8h (menos scroll = menos RAM consumida)
  async function scrollListaAte8h(page, { maxMs = 90000, quietLoops = 3 } = {}) {
    const t0 = Date.now();
    let semNovos = 0;
    let vistos = new Set();

    while ((Date.now() - t0) < maxMs) {
      const todos = await coletaChatsMarketplaceTodos(page);
      let houveNovo = false, viuAntigo = false;
      for (const c of todos) {
        if (!vistos.has(c.id)) { vistos.add(c.id); houveNovo = true; }
        if (isVelho8h(c.tempo)) viuAntigo = true; // NOVO: Usa isVelho8h
      }
      if (viuAntigo) break;
      if (!houveNovo) {
        semNovos += 1;
        if (semNovos >= quietLoops) break;
      } else {
        semNovos = 0;
      }
      try {
        const contSel = await page.evaluate(() => {
          const cands = ['div[role="grid"]','div[role="rowgroup"]','div.x78zum5.xdt5ytf'];
          for (const sel of cands) {
            const el = document.querySelector(sel);
            if (el && el.scrollHeight > el.clientHeight) return sel;
          }
          return 'body';
        });
        await page.evaluate((selector) => {
          const el = document.querySelector(selector) || document.scrollingElement || document.body;
          el.scrollTop = el.scrollHeight;
        }, contSel);
      } catch {
        try { await page.evaluate(() => window.scrollBy(0, Math.max(400, window.innerHeight * 0.8))); } catch {}
      }
      await sleep(800 + Math.floor(Math.random() * 500));
    }
    return Array.from(vistos);
  }

  async function atualizaFila() {
    let mudancaFila = false;
    const chatsNovos = await coletaChatsMarketplaceRecentes();
    logger.info(`[FILA][${nome}] recebidos da coleta: ${chatsNovos.length}`);

    const aguard = getSetAguardando(nome);
    const agoraMs = Date.now();
    const ERROR_TTL_MS = parseInt(process.env.VIRTUS_ERROR_TTL_MS || '1800000', 10); // 30min padrão

    // Paralelização com p-limit
    let pLimitImport;
    try {
      pLimitImport = require('p-limit');
    } catch {
      pLimitImport = null;
    }
    const pLimit = pLimitImport && (pLimitImport.default || pLimitImport);
    const limit = pLimit ? pLimit(8) : (fn) => fn();

    await Promise.all(chatsNovos.map(c => limit(async () => {
      const id = c.id;

      // CRÍTICO: Verificar se chat já foi respondido ANTES de aplicar filtros
      let st = null;
      try { st = await getChatState(nome, id); } catch {}
      const jaFoiRespondido = st && (st.state === CHAT_STATES.AGUARDANDO || st.state === CHAT_STATES.ENVIADO);
      
      // Se já foi respondido, SEMPRE verificar (ignora filtro de tempo recente)
      // Isso garante que novas mensagens do cliente sejam detectadas mesmo se o chat "envelheceu"
      if (jaFoiRespondido) {
        // Chats já respondidos devem ser sempre verificados para novas mensagens
        // Ignora cooldown e filtro de tempo - sempre enfileira se não estiver na fila
        if (aguard.has(id)) {
          logger.info(`[FILA][${nome}] skip ${id} — aguardando resposta do notificador`);
          return;
        }
        if (fila.includes(id)) {
          logger.info(`[FILA][${nome}] skip ${id} — já está na fila`);
          return;
        }
        // Enfileira diretamente para verificar novas mensagens
        fila.push(id);
        lastProbeMap.set(id, agoraMs);
        logger.info(`[FILA][${nome}] Chat já respondido re-enfileirado para verificar novas mensagens: ${id}`);
        mudancaFila = true;
        return;
      }

      // CRÍTICO: Se o chat já está na fila, não fazer nada - ele já foi enfileirado e está aguardando processamento
      // Não aplicar cooldown nem re-probe para chats já enfileirados
      if (fila.includes(id)) {
        logger.info(`[FILA][${nome}] skip ${id} — já está na fila aguardando processamento`);
        return;
      }
      
      // Para chats novos que ainda não estão na fila, verificar se já foi processado recentemente
      // Mas apenas se não estiver na fila (já verificado acima)
      const last = lastProbeMap.get(id) || 0;
      // REMOVIDO: cooldown de re-probe que estava bloqueando chats novos
      // Se o chat não está na fila e não foi processado, deve ser enfileirado

      // TTL de força: mesmo sem mudança aparente, forçar abertura do chat após X minutos
      const lastProbeAt = (st && typeof st.lastProbeAt === 'number') ? st.lastProbeAt : 0;
      const forceOpen = (!st) || (agoraMs - lastProbeAt >= PROBE_FORCE_OPEN_MS);
      
      if (
        !forceOpen &&
        st &&
        typeof st.lastCLIts === 'number' &&
        typeof st.ultimoProbeCLIts === 'number' &&
        st.lastCLIts === st.ultimoProbeCLIts
      ) {
        // nenhum avanço desde último probe E ainda não bateu o TTL de força
        lastProbeMap.set(id, agoraMs);
        logger.info(`[FILA][${nome}] skip ${id} — sem avanço (lastCLIts==ultimoProbeCLIts) e TTL < ${PROBE_FORCE_OPEN_MS}ms`);
        return;
      }
      
      // Em atualizaFila, no bloco de erro_envio:
      if (st && st.state === 'erro_envio') {
        logger.info(`[FILA][${nome}] ${id} estava em erro_envio — será testado novamente (fila permissiva).`);
        // Continua!
      }

      if (aguard.has(id)) {
        logger.info(`[FILA][${nome}] skip ${id} — aguardando resposta do notificador`);
        return;
      }
      // CRÍTICO: Verificar se já está na fila ANTES de aplicar cooldown
      // Se já está na fila, não precisa enfileirar novamente
      if (fila.includes(id)) {
        logger.info(`[FILA][${nome}] skip ${id} — já está na fila aguardando processamento`);
        return;
      }

      // Registro mínimo imediato do chatId (robustez)
      try {
        await setChatState(nome, id, {
          state: CHAT_STATES.PENDENTE,
          createdAt: Date.now(),
          lastProbeAt: Date.now() // NOVO: registramos a última sondagem
        });
      } catch {}

      // Registro de cidade do perfil (se disponível)
      try {
        const man = await manifestStore.read(nome).catch(()=>null);
        const cid = man && man.cidade || null;
        if (cid) {
          await setChatState(nome, id, { perfilCidade: String(cid) });
        }
      } catch {}

      fila.push(id);
      lastProbeMap.set(id, agoraMs);
      logger.info(`[FILA][${nome}] Candidato ${id} enfileirado (${c.tempo})`);
      mudancaFila = true;
    })));

    if (mudancaFila) {
      logger.info(`[FILA][${nome}] Atualizada: ${fila.length} chats pendentes`);
    }
    return mudancaFila;
  }

  function scheduleNextIfIdle() {
    if (!running) {
      logger.debug('[FILA] Sistema não está rodando', { nome });
      return;
    }
    if (chatAtivo) {
      logger.debug('[FILA] Chat ativo, aguardando...', { nome, chatAtivo });
      return;
    }
    if (filaChatTimer) {
      logger.debug('[FILA] Timer já agendado, aguardando...', { nome, filaChatTimer });
      return;
    }
    if (!fila.length) {
      logger.debug('[FILA] Fila vazia', { nome });
      return;
    }

    // CRÍTICO: Remover o chat da fila ANTES de processar para evitar duplicação
    const next = fila.shift(); // Remove da fila imediatamente
    if (!next) {
      logger.warn('[FILA] Chat removido da fila mas era null/undefined', { nome });
      return;
    }
    
    // CRÍTICO: Marcar chatAtivo ANTES de agendar para evitar chamadas concorrentes
    chatAtivo = next;

    // Primeira execução SEM delay; próximas respeitam o env (default 0)
    const delayMs = (() => {
      const env = process.env.VIRTUS_NEXT_CHAT_DELAY_MS;
      if (typeof scheduleNextIfIdle._firstRun === 'undefined') {
        scheduleNextIfIdle._firstRun = false;
        return 0; // roda o primeiro chat imediatamente
      }
      const parsed = parseInt(env, 10);
      return Number.isFinite(parsed) ? parsed : 0;
    })();
    logger.info('[FILA] Preparando atendimento do próximo chat', { nome, chatId: next, delay: delayMs, filaRestante: fila.length });
    filaChatTimer = setTimeout(async () => {
      try {
        filaChatTimer = null; // Limpa timer imediatamente
        
        if (!running || !epochOk()) {
          chatAtivo = null; // Libera chatAtivo
          fila.unshift(next); // Re-enfileira
          logger.warn('[FILA] Sistema não está rodando ou epoch inválido, re-enfileirando', { nome, chatId: next });
          return;
        }
        
        // Verifica se ainda é o chat ativo (proteção extra)
        if (chatAtivo !== next) {
          logger.warn('[FILA] Chat ativo mudou, re-enfileirando', { nome, chatId: next, chatAtivo });
          fila.unshift(next); // Re-enfileira no início
          return scheduleNextIfIdle();
        }
        
        stepLog.appendJSONL(nome, 'virtus', { attempt: attId, step: 'schedule_reply', chatId: next });
        await responderChat(next);
        
        // Libera chatAtivo após processar
        chatAtivo = null;
        
        setTimeout(scheduleNextIfIdle, Math.max(200, delayMs));
      } catch (e) {
        filaChatTimer = null;
        chatAtivo = null; // Libera chatAtivo em caso de erro
        logger.error('[FILA] Erro no timer de atendimento', { nome, chatId: next, error: e && e.message || e, stack: e && e.stack });
        // Re-enfileira em caso de erro
        fila.unshift(next);
        setTimeout(scheduleNextIfIdle, Math.max(200, delayMs));
      }
    }, delayMs);
  }

  async function responderChat(chatId) {
    logger.info('[RESPONDER] Iniciando responderChat', { nome, chatId, filaLength: fila.length, chatAtivo });
    
    // CRÍTICO: try/finally deve envolver TODO o código para garantir liberação do lock e chatAtivo
    let _chatLockAcquired = false;
    try {
      if (!running || !epochOk()) {
        logger.warn('[RESPONDER] Sistema não está rodando ou epoch inválido', { nome, chatId, running, epochOk: epochOk() });
        return;
      }
      const responderStartedAt = Date.now();
      // ========== INÍCIO BLOCO FREEZER INSTRUÇÃO 2 ==========
      let manifestFrozenUntil = 0;
      try {
        const manifest = await manifestStore.read(nome);
        manifestFrozenUntil = typeof manifest?.frozenUntil === 'number' ? manifest.frozenUntil : 0;
      } catch {}
      if (manifestFrozenUntil && manifestFrozenUntil > Date.now()) {
        running = false;
        if (filaInterval) clearInterval(filaInterval), filaInterval = null;
        if (filaChatTimer) clearTimeout(filaChatTimer), filaChatTimer = null;
        if (scrollInterval) clearInterval(scrollInterval), scrollInterval = null;
        logger.warn(`[VIRTUS][${nome}] virtus_stop_frozen window — congelado até ${new Date(manifestFrozenUntil).toISOString()}`, { nome });
        return;
      }
      // ========== FIM BLOCO FREEZER INSTRUÇÃO 2 ==========
      // === INÍCIO GUARD DE VIDA NO RESPONDERCHAT ===
      if (VIRTUS_DETAILED_DEBUG) { log(`[DETAILED] Início responderChat: ${chatId}`); }
      if (!browser || browser.isConnected?.() === false) {
        logger.error(`[VIRTUS][${nome}] Browser morto/desconectado — encerrando Virtus`, { nome });
        if (issues) try { await logIssue(nome, 'virtus_page_dead', 'browser morto/disconnected'); } catch {}
        running = false;
        if (filaInterval) clearInterval(filaInterval), filaInterval = null;
        if (filaChatTimer) clearTimeout(filaChatTimer), filaChatTimer = null;
        if (scrollInterval) clearInterval(scrollInterval), scrollInterval = null;
        return;
      }
      let p = await ensurePage();
      if (!p || (p.isClosed && p.isClosed())) {
        logger.error(`[VIRTUS][${nome}] Page fechada/desconectada — encerrando Virtus`, { nome });
        if (issues) try { await logIssue(nome, 'virtus_page_dead', 'page closed/disconnected'); } catch {}
        running = false;
        if (filaInterval) clearInterval(filaInterval), filaInterval = null;
        if (filaChatTimer) clearTimeout(filaChatTimer), filaChatTimer = null;
        if (scrollInterval) clearInterval(scrollInterval), scrollInterval = null;
        return;
      }
      // === FIM GUARD DE VIDA ===
      if (!chatId) {
        logger.warn('[RESPONDER] chatId inválido', { nome, chatId });
        chatAtivo = null; // Libera chatAtivo antes de retornar
        return;
      }

      // CRÍTICO: Verificar se já está processando este chat (proteção contra chamadas concorrentes)
      // NOTA: chatAtivo já foi setado em scheduleNextIfIdle, então esta verificação não deve falhar
      // Mas mantemos como proteção extra
      if (chatAtivo && chatAtivo !== chatId) {
        logger.warn('[RESPONDER] Outro chat já está sendo processado (chatAtivo)', { nome, chatId, chatAtivo });
        return;
      }
      
      // Garante que chatAtivo está setado (proteção extra)
      chatAtivo = chatId;

      // Lock de disco POR chatId!
      logger.info('[RESPONDER] Tentando adquirir lock', { nome, chatId });
      
      // CRÍTICO: Se não conseguir adquirir lock, tenta forçar liberação de lock stale
      if (!chatLock.acquire(nome, chatId)) {
        logger.warn('[RESPONDER] Falha ao adquirir lock - tentando forçar liberação', { nome, chatId });
        // Tenta liberar lock stale (pode estar travado de tentativa anterior)
        try {
          chatLock.release(nome, chatId);
          // Aguarda um pouco e tenta novamente
          await new Promise(r => setTimeout(r, 100));
          if (chatLock.acquire(nome, chatId)) {
            logger.info('[RESPONDER] Lock adquirido após forçar liberação', { nome, chatId });
            _chatLockAcquired = true;
          } else {
            logger.warn('[RESPONDER] Falha ao adquirir lock mesmo após forçar liberação', { nome, chatId });
            stepLog.appendJSONL(nome, 'virtus', { step: 'skip_locked', chatId, attempt: attId });
            stepLog.appendJSONL(nome, 'virtus', { step: 'chat_lock_busy', chatId, attempt: attId });
            try { await logIssue(nome, 'chat_lock_busy', `Falha ao adquirir lock para chat ${chatId} mesmo após forçar liberação`); } catch {}
            fila = fila.filter(id => id !== chatId);
            return;
          }
        } catch (e) {
          logger.error('[RESPONDER] Erro ao tentar forçar liberação de lock', { nome, chatId, error: e && e.message || e });
          stepLog.appendJSONL(nome, 'virtus', { step: 'skip_locked', chatId, attempt: attId });
          stepLog.appendJSONL(nome, 'virtus', { step: 'chat_lock_busy', chatId, attempt: attId });
          try { await logIssue(nome, 'chat_lock_busy', `Falha ao adquirir lock para chat ${chatId}`); } catch {}
          fila = fila.filter(id => id !== chatId);
          return;
        }
      } else {
        _chatLockAcquired = true;
        logger.info('[RESPONDER] Lock adquirido com sucesso', { nome, chatId });
      }
      
      // NOVO: Registra lastProbeAt no início (antes de qualquer navegação)
      try {
        await setChatState(nome, chatId, { lastProbeAt: Date.now() });
      } catch {}
      lastProbeMap.set(chatId, Date.now());
      
      logger.info('[CONTEXTO] Iniciando processamento', { nome, chatId });
      stepLog.appendJSONL(nome, 'virtus', { step: 'chat_lock_ok', chatId, attempt: attId });

      // Marcar estado como PENDENTE (APENAS disco)
      try {
        await setChatState(nome, chatId, { state: CHAT_STATES.PENDENTE });
      } catch {}

      // Ledger: adiciona pending imediatamente após adquirir lock
      const attemptId2 = stepLog.attemptId();
      try { await pendingAdd(nome, chatId, attemptId2); } catch {}

      chatAtivo = chatId;

      try {
        p = await ensurePage();
        if (!p) {
          try { await pendingDel(nome, chatId); } catch {}
          fila = fila.filter(id => id !== chatId);
          chatAtivo = null;
          return;
        }
        if (!running || !epochOk()) { try { await pendingDel(nome, chatId); } catch {} fila = fila.filter(id => id !== chatId); chatAtivo = null; return; }
        logger.info('[NAVEGACAO] Garantindo Marketplace UI', { nome, chatId });
        await maybeGuaranteeMarketplaceFast(p, nome);
        logger.info('[NAVEGACAO] Marketplace UI garantida', { nome, chatId });

        // NOVO: Não bloquear baseado apenas em respondedCache
        // A verificação de "novas mensagens" será feita após coletar o histórico
        // Mantém apenas verificação de cooldown de prova (já feito em atualizaFila)

        // NAVEGAÇÃO INICIAL PARA ABRIR O CHAT (permitida apenas na primeira vez)
        let urlNow = (typeof p.url === 'function') ? (p.url() || '') : '';
        if (!chatUrlMatches(urlNow, chatId)) {
          // Precisa abrir o chat pela primeira vez
          logger.info('[NAVEGACAO] Abrindo chat pela primeira vez', { nome, chatId });
          let anchorSel = `a[href^="/marketplace/t/${chatId}"]`;
          await scrollChatsToTop(p, nome).catch(()=>{});
          await sleep(300);
          let found = await p.$(anchorSel);
          
          if (found) {
            // Tenta clicar no anchor para abrir o chat
            try {
              await p.evaluate((sel) => {
                const el = document.querySelector(sel);
                if (el) el.scrollIntoView({ behavior: 'instant', block: 'center', inline: 'center' });
              }, anchorSel);
              await Promise.race([
                p.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 15000 }).catch(()=>{}),
                (async () => { await p.$eval(anchorSel, el => el.click()); })()
              ]);
              await sleep(1000); // Aguarda navegação
            } catch (e) {
              logger.warn('[NAVEGACAO] Falha ao clicar no anchor, tentando goto direto', { nome, chatId, error: e && e.message || e });
            }
          }
          
          // Se ainda não está no chat, tenta goto direto (apenas na primeira vez)
          urlNow = (typeof p.url === 'function') ? (p.url() || '') : '';
          if (!chatUrlMatches(urlNow, chatId)) {
            try {
              await p.goto(`https://www.messenger.com/marketplace/t/${chatId}/`, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(()=>{});
              await sleep(1000);
              urlNow = (typeof p.url === 'function') ? (p.url() || '') : '';
            } catch (e) {
              logger.warn('[NAVEGACAO] Falha ao navegar para o chat', { nome, chatId, error: e && e.message || e });
            }
          }
          
          // Verifica se conseguiu abrir o chat
          if (!chatUrlMatches(urlNow, chatId) || !(await assertOnChat(p, chatId, { timeoutMs: 2000 }))) {
            logger.warn('[VIRTUS] Não foi possível abrir o chat. Abortando atendimento.', { nome, chatId, urlNow });
            const prev = await getChatState(nome, chatId).catch(()=>null);
            const attempts = (prev && prev.sendAttempts ? prev.sendAttempts : 0) + 1;
            await setChatState(nome, chatId, {
              state: CHAT_STATES.AGUARDANDO,
              sendAttempts: attempts,
              cooldownUntil: Date.now() + Math.min(60000, 20000 * attempts),
              lastProbeAt: Date.now()
            });
            try { await pendingDel(nome, chatId); } catch {}
            fila = fila.filter(id => id !== chatId);
            chatAtivo = null;
            return;
          }
        } else {
          // Já está no chat, apenas valida
          if (!(await assertOnChat(p, chatId, { timeoutMs: 0 }))) {
            logger.warn('[VIRTUS] Contexto do chat não corresponde. Abortando atendimento.', { nome, chatId, urlNow });
            const prev = await getChatState(nome, chatId).catch(()=>null);
            const attempts = (prev && prev.sendAttempts ? prev.sendAttempts : 0) + 1;
            await setChatState(nome, chatId, {
              state: CHAT_STATES.AGUARDANDO,
              sendAttempts: attempts,
              cooldownUntil: Date.now() + Math.min(60000, 20000 * attempts),
              lastProbeAt: Date.now()
            });
            try { await pendingDel(nome, chatId); } catch {}
            fila = fila.filter(id => id !== chatId);
            chatAtivo = null;
            return;
          }
        }


        if (await isChatBlocked(p)) {
          logger.info('[SKIP] Chat bloqueado/indisponível', { nome, chatId });
          logger.warn('Chat bloqueado/indisponível, marcado respondido', { nome, chatId });
          try { await pendingDel(nome, chatId); } catch {}
          try { await logIssue(nome, 'virtus_blocked', `chat ${chatId} bloqueado/indisponível`); } catch {}
          fila = fila.filter(id => id !== chatId);
          chatAtivo = null;
          resetFail(chatId);
          return;
        }

        // Checagem de contexto antes de aguardar o composer
        if (!(await assertOnChat(p, chatId, { timeoutMs: 1200 }))) {
          try { await pendingDel(nome, chatId); } catch {}
          fila = fila.filter(id => id !== chatId);
          chatAtivo = null;
          await logIssue(nome, 'mil_action', `virtus_context_abort: url divergiu antes do envio (chat ${chatId})`);
          return;
        }

        let campo = await waitForComposer(p, 10000);
        if (!campo) {
          // GARANTA: NUNCA RELOAD GOTO NA ABA PRINCIPAL DO CHAT
          logger.info('[COMPOSER] Composer não encontrado, tentando refocus sem reload', { nome, chatId });
          const campo2 = await refocusComposerNoReload(p, chatId, anchorSel);
          if (campo2) {
            campo = campo2;
            logger.info('[COMPOSER] Refocus bem-sucedido', { nome, chatId });
          } else {
            logger.warn('[COMPOSER] indisponível (sem reload) — agendando cooldown', { nome, chatId });
            const prev = await getChatState(nome, chatId).catch(()=>null);
            const attempts = (prev && prev.sendAttempts ? prev.sendAttempts : 0) + 1;
            await setChatState(nome, chatId, {
              state: CHAT_STATES.AGUARDANDO,
              sendAttempts: attempts,
              cooldownUntil: Date.now() + Math.min(60000, 20000 * attempts),
              ultimoProbeCLIts: tsCLI || 0,
              lastProbeAt: Date.now()
            });
            try { await pendingDel(nome, chatId); } catch {}
            fila = fila.filter(id => id !== chatId);
            chatAtivo = null;
            return;
          }
        }
// REVALIDAÇÃO FINAL: verificação será feita após coletar histórico
// A lógica de "novas mensagens" substitui o gating por respondedCache

        resetFail(chatId);

        // 1. Extrai URL do classificado
        const urlClassificado = await extrairUrlClassificado(p, chatId);

        // 2. INÍCIO PATCH: Cache de localização por chat (persistida em disco)
        let localizacao = null;
        try {
          const stLoc = await getChatState(nome, chatId);
          if (stLoc && stLoc.cidade && stLoc.estado) {
            // Já temos cache persistido: NÃO buscar novamente
            localizacao = { cidade: stLoc.cidade, estado: stLoc.estado };
            logger.info('[LOCALIZACAO] Localização recuperada do cache', { 
              nome, 
              chatId, 
              cidade: localizacao.cidade, 
              estado: localizacao.estado 
            });
          } else {
            // Buscar apenas se não houver cache
            localizacao = await new Promise((resolve) => {
              try {
                const buscador = (global && global.__buscaLocalizacaoVirtus) ? global.__buscaLocalizacaoVirtus : null;
                if (buscador && typeof buscador.adicionarBuscaLocalizacao === 'function' && urlClassificado) {
                  buscador.adicionarBuscaLocalizacao(chatId, urlClassificado, nome, resolve);
                } else {
                  resolve(null);
                }
              } catch { resolve(null); }
            });
            if (localizacao && localizacao.cidade && localizacao.estado) {
              try {
                await setChatState(nome, chatId, {
                  cidade: localizacao.cidade,
                  estado: localizacao.estado
                });
              } catch {}
            }
          }
        } catch {
          localizacao = null;
        }
        // FIM PATCH

        // Log detalhado sobre localização
        if (localizacao && localizacao.cidade && localizacao.estado) {
          logger.info('[LOCALIZACAO] Localização encontrada', { 
            nome, 
            chatId, 
            cidade: localizacao.cidade, 
            estado: localizacao.estado 
          });
        } else {
          logger.warn('[LOCALIZACAO] Localização NÃO encontrada', { nome, chatId, urlClassificado });
        }

        // 3. Identifica tipo de serviço
        const tipoServico = await identificarTipoServico(nome);

        // Marcar estado como GERANDO antes de coletar histórico
        try {
          await setChatState(nome, chatId, { state: CHAT_STATES.GERANDO });
        } catch {}

        // 4. Coleta TODO o histórico da conversa (mensagens do cliente e da IA)
        logger.info('[COLETA] Iniciando coleta de histórico', { nome, chatId });
        const historicoConversa = await extrairHistoricoConversa(p);
        
        await appendChatHistoryLog(nome, chatId, historicoConversa);
        
        logger.info('[COLETA] Histórico coletado', { 
          nome, 
          chatId, 
          totalMensagens: historicoConversa.length,
          mensagensCliente: historicoConversa.filter(m => m.autor === 'cliente').length,
          mensagensIA: historicoConversa.filter(m => m.autor === 'ia').length
        });

        // Em responderChat, após obter o histórico:
        const ultimaMsg = Array.isArray(historicoConversa) && historicoConversa.length
          ? historicoConversa[historicoConversa.length - 1]
          : null;
        if (!ultimaMsg || ultimaMsg.autor !== 'cliente') {
          logger.info(`[SKIP] Chat ${chatId}: última mensagem não é do cliente.`, { nome, chatId });
          try {
            await setChatState(nome, chatId, {
              state: CHAT_STATES.AGUARDANDO,
              lastProbeAt: Date.now()
            });
          } catch {}
          try { await pendingDel(nome, chatId); } catch {}
          fila = fila.filter(id => id !== chatId);
          chatAtivo = null;
          return;
        }

        // Hash/TS gating
        const stPrev = await getChatState(nome, chatId).catch(()=>null);

        const ultimaIA = (() => {
          const iaMsgs = historicoConversa.filter(m => m.autor === 'ia');
          return iaMsgs.length ? iaMsgs[iaMsgs.length - 1] : null;
        })();

        const ultimaCliente = (() => {
          const cli = historicoConversa.filter(m => m.autor === 'cliente');
          return cli.length ? cli[cli.length - 1] : null;
        })();

        const ultimaMsgClienteTexto = (ultimaCliente && ultimaCliente.texto) ? String(ultimaCliente.texto) : '';
        const lastClientHash = hashResposta(ultimaMsgClienteTexto);
        const lastClientHashAnterior = (stPrev && stPrev.lastClientHash) || null;

        // Índices ordem no histórico — decisor mais confiável do que timestamp
        const idxUltCliente = (() => {
          let idx = -1;
          for (let i = 0; i < historicoConversa.length; i++) {
            if (historicoConversa[i] && historicoConversa[i].autor === 'cliente') idx = i;
          }
          return idx;
        })();
        const idxUltIA = (() => {
          let idx = -1;
          for (let i = 0; i < historicoConversa.length; i++) {
            if (historicoConversa[i] && historicoConversa[i].autor === 'ia') idx = i;
          }
          return idx;
        })();

        const tsCLI = tsNum(ultimaCliente && ultimaCliente.timestamp);
        const prevIATs = Number((stPrev && stPrev.lastIATs) || 0);

        const mudouConteudo = (lastClientHashAnterior !== lastClientHash);
        // Cliente "vence" se ele está depois da última IA no histórico (por posição) ou se o ts do cliente é posterior ao último envio registrado
        const clienteVencePorOrdem = (idxUltCliente >= 0 && (idxUltIA < 0 || idxUltCliente > idxUltIA));
        const clienteVencePorTempo = (tsCLI > prevIATs);
        const clienteMaisRecenteQueIA = (clienteVencePorOrdem || clienteVencePorTempo);

        logger.info('[GATE] Avaliação do chat', {
          nome,
          chatId,
          mudouConteudo,
          idxUltCliente,
          idxUltIA,
          tsCLI,
          prevIATs,
          clienteVencePorOrdem,
          clienteVencePorTempo,
          clienteMaisRecenteQueIA
        });

        // Final gate com branch rastreável
        if (!mudouConteudo || !clienteMaisRecenteQueIA) {
          logger.info('[SKIP] Chat ' + chatId + ': gate não satisfeito', {
            nome,
            motivoMudouConteudo: mudouConteudo ? 'ok' : 'hash_cliente_igual',
            motivoRecencia: clienteMaisRecenteQueIA ? 'ok' : 'cliente_nao_vence(tempo/ordem)'
          });
          try {
            await setChatState(nome, chatId, {
              state: CHAT_STATES.AGUARDANDO,
              lastIATs: Number(stPrev && stPrev.lastIATs || 0),
              ultimoProbeCLIts: tsCLI || 0,
              lastProbeAt: Date.now()
            });
          } catch {}
          try { await pendingDel(nome, chatId); } catch {}
          fila = fila.filter(id => id !== chatId);
          chatAtivo = null;
          return;
        }

        // QUIET WINDOW inteligente: na primeira resposta NÃO espera; nas subsequentes, espera curto (configurável)
        const pAtual = await ensurePage().catch(()=>null);
        const isFirstReply = (idxUltIA < 0); // idxUltIA já calculado acima
        const quietMs = isFirstReply ? VIRTUS_FIRST_REPLY_QUIET_MS : VIRTUS_NEXT_REPLY_QUIET_MS;
        
        if (quietMs > 0) {
          let okQuiet = await waitQuietWindow(nome, chatId, quietMs, {
            page: pAtual,
            getHistoricoFn: async () => await extrairHistoricoConversa(pAtual)
          });
          if (!okQuiet) {
            // Houve mensagem do cliente durante a janela curta: reavalie histórico e CONTINUE (não aborta)
            logger.info('[BURST] Mensagem durante quiet window curta — reavaliando e seguindo', { nome, chatId, quietMs, isFirstReply });
            try {
              historicoConversa = await extrairHistoricoConversa(pAtual);
            } catch {}
            // segue fluxo normalmente; nada de return aqui
          }
        } else {
          logger.debug('[QUIET] Primeira resposta: quiet window desativada', { nome, chatId });
        }

        // OK: há novidade do cliente (passou quiet window ou é primeira resposta)
        const tsIA = tsNum(ultimaIA && ultimaIA.timestamp);
        logger.info(`[NOVO] Chat ${chatId}: há novidade do cliente (última cliente: ${new Date(tsCLI).toLocaleString()}, última IA: ${tsIA ? new Date(tsIA).toLocaleString() : 'nenhuma'})`, { nome, chatId });

        // CRÍTICO: Para primeira resposta, não espera; para subsequentes, espera pequena se configurado
        const WAIT_BEFORE_GENERATE_MS = parseInt(process.env.VIRTUS_WAIT_BEFORE_GENERATE_MS || '0', 10);
        const isFirstReplyTiming = (idxUltIA < 0);
        
        // Para respostas subsequentes (não a primeira), uma pequena espera dinâmica:
        if (!isFirstReplyTiming && WAIT_BEFORE_GENERATE_MS > 0) {
          logger.info(`[TIMING] Aguardando ${WAIT_BEFORE_GENERATE_MS}ms antes de gerar resposta (subsequente)...`, { nome, chatId });
          await sleep(WAIT_BEFORE_GENERATE_MS);
          // Re-extrai histórico após espera para pegar todas as mensagens do cliente
          try {
            historicoConversa = await extrairHistoricoConversa(pAtual);
            logger.info(`[TIMING] Histórico re-extraído após espera: ${historicoConversa.length} mensagens`, { nome, chatId });
          } catch {}
        } else {
          logger.debug(`[TIMING] Primeira resposta: sem espera (WAIT_BEFORE_GENERATE_MS=${WAIT_BEFORE_GENERATE_MS}ms)`, { nome, chatId });
        }

        // Pipeline de Perguntas (dominante) ou Groq (fallback)
        if (VIRTUS_USE_PIPELINE) {
          try {
            logger.info('[PIPELINE] Processando com pipeline de perguntas', { nome, chatId });
            
            const pipelineResult = await processarPipelinePerguntas(nome, chatId, historicoConversa, stPrev);
            
            // NOVO: se o pipeline respondeu null, NÃO cair no Groq. Apenas aguardar.
            if (pipelineResult && !pipelineResult.resposta) {
              try {
                await setChatState(nome, chatId, {
                  qaAsked: pipelineResult.qaAsked || [],
                  qaAnswered: pipelineResult.qaAnswered || {},
                  flow: pipelineResult.flow || {},
                  state: CHAT_STATES.AGUARDANDO,
                  lastProbeAt: Date.now()
                });
              } catch {}
              try { await pendingDel(nome, chatId); } catch {}
              fila = fila.filter(id => id !== chatId);
              chatAtivo = null;
              logger.info('[PIPELINE] Sem mensagem a enviar agora (aguardando).', { chatId });
              return;
            }
            
            if (!pipelineResult || !pipelineResult.resposta) {
              // Fallback: só se pipelineResult for nulo/indefinido (erro, por ex.).
              const telefoneFinal = pipelineResult?.telefone_extraido || null;
              if (telefoneFinal && pipelineResult?.finalizado) {
                logger.info('[PIPELINE] Todas informações coletadas COM WhatsApp, finalizando', { nome, chatId });
                const jaTinhaTimer = timersFechamento && timersFechamento.has(chatId);
                if (!jaTinhaTimer) {
                  iniciarTimerFechamento(chatId, telefoneFinal);
                }
                try {
                  await setChatState(nome, chatId, {
                    qaAsked: pipelineResult?.qaAsked || [],
                    qaAnswered: pipelineResult?.qaAnswered || {},
                    state: CHAT_STATES.FINALIZADO
                  });
                } catch {}
                try { await pendingDel(nome, chatId); } catch {}
                fila = fila.filter(id => id !== chatId);
                chatAtivo = null;
                return;
              } else {
                logger.info('[PIPELINE] Pipeline sem resposta; fallback para Groq', { nome, chatId });
              }
            }
            
            // Atualiza state com qaAsked e qaAnswered
            try {
              await setChatState(nome, chatId, {
                qaAsked: pipelineResult.qaAsked || [],
                qaAnswered: pipelineResult.qaAnswered || {}
              });
            } catch {}
            
            // Atualiza dados coletados
            let cidadePreferida = null;
            try {
              const man = await manifestStore.read(nome).catch(()=>null);
              cidadePreferida = (man && man.cidade) ? man.cidade : null;
            } catch {}
            if (!cidadePreferida && localizacao && localizacao.cidade) {
              cidadePreferida = localizacao.cidade;
            }
            atualizarDadosColetados(chatId, {
              cidade: cidadePreferida || null,
              telefone: pipelineResult.telefone_extraido || null,
              dados: pipelineResult.dados || {}
            });
            
            // Inicia timer se capturou telefone pela primeira vez
            const jaTinhaTimer = timersFechamento && timersFechamento.has(chatId);
            if (!jaTinhaTimer && pipelineResult.telefone_extraido) {
              iniciarTimerFechamento(chatId, pipelineResult.telefone_extraido);
            }
            
            // Reaproveitar a página atual - NUNCA reload/goto
            const pAtual = await ensurePage().catch(() => null);
            if (!pAtual) {
              logger.warn('[PIPELINE] Page indisponível', { nome, chatId });
              await setChatState(nome, chatId, { state: 'erro_envio', erroTimestamp: Date.now() });
              try { await pendingDel(nome, chatId); } catch {}
              fila = fila.filter(id => id !== chatId);
              chatAtivo = null;
              return;
            }
            
            // Verifica se está no chat correto - se não, apenas marca cooldown (não navega)
            let urlNow = (typeof pAtual.url === 'function') ? (pAtual.url() || '') : '';
            if (!chatUrlMatches(urlNow, chatId) || !(await assertOnChat(pAtual, chatId, { timeoutMs: 0 }))) {
              logger.warn('[PIPELINE] URL/contexto não corresponde (sem navegação). Cooldown.', { nome, chatId, urlNow });
              const prev = await getChatState(nome, chatId).catch(()=>null);
              const attempts = (prev && prev.sendAttempts ? prev.sendAttempts : 0) + 1;
              await setChatState(nome, chatId, {
                state: CHAT_STATES.AGUARDANDO,
                sendAttempts: attempts,
                cooldownUntil: Date.now() + Math.min(60000, 20000 * attempts),
                lastProbeAt: Date.now()
              });
              try { await pendingDel(nome, chatId); } catch {}
              fila = fila.filter(id => id !== chatId);
              chatAtivo = null;
              return;
            }
            
            // Tenta obter composer - se falhar, usa refocusComposerNoReload
            let campoEnvio = await waitForComposer(pAtual, 10000);
            if (!campoEnvio) {
              logger.info('[PIPELINE] Composer não encontrado, tentando refocus', { nome, chatId });
              campoEnvio = await refocusComposerNoReload(pAtual, chatId, anchorSel);
            }
            
            if (!campoEnvio) {
              logger.warn('[PIPELINE] Composer indisponível após refocus - marcando cooldown', { nome, chatId });
              const prev = await getChatState(nome, chatId).catch(()=>null);
              const attempts = (prev && prev.sendAttempts ? prev.sendAttempts : 0) + 1;
              await setChatState(nome, chatId, {
                state: 'erro_envio',
                erroTimestamp: Date.now(),
                sendAttempts: attempts,
                cooldownUntil: Date.now() + Math.min(60000, 20000 * attempts),
                ultimoProbeCLIts: tsCLI || 0,
                lastProbeAt: Date.now()
              });
              try { await pendingDel(nome, chatId); } catch {}
              fila = fila.filter(id => id !== chatId);
              chatAtivo = null;
              return;
            }
            
            try {
              await setChatState(nome, chatId, { state: CHAT_STATES.ENVIANDO });
            } catch {}
            
            // AQUISIÇÃO DO LOCK — "just-in-time locking"
            await acquireSendGuard(pAtual, chatId);
            try {
              // ENFORCEMENT: Aplicar regras de governança antes de enviar
              const stFlowPrev = await getChatState(nome, chatId).catch(()=>null);
              const flowPrev = (stFlowPrev && stFlowPrev.flow) ? stFlowPrev.flow : (pipelineResult.flow || { greeted: false, asked: {}, answered: {} });
              let respostaGov = enforceGovRulesOnText(pipelineResult.resposta, { alreadyGreeted: !!flowPrev.greeted });
              
              const utils = require('./utils.js');
              const telOk = utils.isValidBRPhoneWithDDD(pipelineResult.telefone_extraido || (flowPrev.answered && flowPrev.answered.telefone) || '');
              if (!telOk) {
                if (!/whats(app)?|telefone|n[uú]mero/i.test(respostaGov)) {
                  respostaGov = 'Pode me passar seu WhatsApp? O motorista chama por lá.';
                }
              }
              
              await setChatState(nome, chatId, {
                flow: flowPrev,
                ultimaRespostaEnviada: respostaGov,
                lastProbeAt: Date.now()
              });
              
              await sendMessageSafe(pAtual, campoEnvio, respostaGov, nome, chatId);
              await appendIaLine(nome, chatId, respostaGov);
              
              // Garantir greeted=true após primeira resposta
              try {
                const st = await getChatState(nome, chatId).catch(()=>null);
                const flowSt = (st && st.flow) ? st.flow : { greeted: false, asked: {}, answered: {} };
                if (!flowSt.greeted) {
                  flowSt.greeted = true;
                  await setChatState(nome, chatId, { flow: flowSt, lastProbeAt: Date.now() });
                }
              } catch {}
              
              await marcarRespondido(nome, chatId);
            } finally {
              // SEMPRE libera o lock, mesmo em caso de erro
              releaseSendGuard(pAtual);
            }
            
            // Após envio bem-sucedido, persista (CRÍTICO: atualiza ultimoProbeCLIts para permitir detecção de novas mensagens)
            try {
              // Re-extrai histórico para pegar o timestamp mais recente do cliente
              let tsCLIAtualizado = tsCLI || 0;
              try {
                const historicoAtualizado = await extrairHistoricoConversa(pAtual);
                const ultimaClienteAtualizada = historicoAtualizado && historicoAtualizado.filter(m => m.autor === 'cliente').pop();
                if (ultimaClienteAtualizada && ultimaClienteAtualizada.timestamp) {
                  tsCLIAtualizado = tsNum(ultimaClienteAtualizada.timestamp);
                }
              } catch {}
              
              await setChatState(nome, chatId, {
                ultimaMensagemClienteProcessada: ultimaMsgClienteTexto,
                ultimoProbeCLIts: tsCLIAtualizado, // Atualiza para permitir detecção de novas mensagens
                lastIATs: Date.now(),
                lastProbeAt: Date.now(),
                lastClientHash,
                state: CHAT_STATES.AGUARDANDO // Garante que está aguardando resposta do cliente
              });
            } catch {}
            
            logger.info('[PIPELINE] Resposta enviada com sucesso', { chatId, telefone: pipelineResult.telefone_extraido, perguntas: pipelineResult.qaAsked });
          } catch (e) {
            logger.error('[PIPELINE] Falha no pipeline', { chatId, error: e && e.message || e });
            // Retry/backoff similar ao Groq
            try {
              const prev = await getChatState(nome, chatId);
              const attempts = (prev && prev.sendAttempts ? prev.sendAttempts : 0) + 1;
              const baseMin = 2;
              const nextMs = Math.min(5 * 60 * 1000, Math.pow(2, attempts - 1) * baseMin * 60 * 1000);
              
              if (attempts >= 3) {
                await setChatState(nome, chatId, {
                  state: 'erro_envio',
                  sendAttempts: attempts,
                  erroTimestamp: Date.now(),
                  ultimoProbeCLIts: tsCLI || 0
                });
                await logIssue(nome, 'virtus_send_failed', `erro_envio após ${attempts} tentativas (chat ${chatId})`);
              } else {
                await setChatState(nome, chatId, {
                  state: CHAT_STATES.AGUARDANDO,
                  sendAttempts: attempts,
                  cooldownUntil: Date.now() + nextMs,
                  ultimoProbeCLIts: tsCLI || 0
                });
                await logIssue(nome, 'virtus_send_failed', `retry_schedule attempt=${attempts} in=${Math.round(nextMs/1000)}s chat=${chatId}`);
              }
            } catch {}
            try { await pendingDel(nome, chatId); } catch {}
            fila = fila.filter(id => id !== chatId);
            chatAtivo = null;
            return;
          }
        } else if (DIRECT_GROQ) {
          // Fallback: Groq (só se VIRTUS_USE_PIPELINE=0)
          try {
            logger.info('[CONTEXTO] Chamando Groq API', {
              nome,
              chatId,
              historicoLength: Array.isArray(historicoConversa) ? historicoConversa.length : 0
            });
            
            // Cidade preferencial: manifest.cidade > localizacao.cidade > null
            let cidadePreferida = null;
            try {
              const man = await manifestStore.read(nome).catch(()=>null);
              cidadePreferida = (man && man.cidade) ? man.cidade : null;
            } catch {}
            if (!cidadePreferida && localizacao && localizacao.cidade) {
              cidadePreferida = localizacao.cidade;
            }

            // Deadline check antes de chamar Groq
            if (Date.now() - responderStartedAt > 30000) {
              await setChatState(nome, chatId, { state: 'erro_envio', erroTimestamp: Date.now() });
              logger.warn('[RESPOSTA] Deadline por chat excedido — abortando com erro_envio', { nome, chatId });
              return;
            }
            
            // PATCH LOGIC CHECKLIST "alreadyAsked"
            const secondaryAlreadyAsked = !!(stPrev && stPrev.secondaryPrompted === true);
            const promptUser = montarPromptUser(cidadePreferida, historicoConversa, { secondaryAlreadyAsked });
            const txt = await chamarGroqAPI(PROMPT_SYSTEM, promptUser);
            const parsed = parsearRespostaGroq(txt);
            
            // Sanitização (IA) anti-clichê
            parsed.resposta = sanitizeIAResponse(parsed.resposta, historicoConversa);

            // fallback de telefone quando LLM não retornar
            if (!parsed.telefone_extraido) {
              const textoHistorico = (historicoConversa || []).map(m => m && m.texto || '').join(' ');
              const utils = require('./utils.js');
              const phones = utils.extractPhonesBRStrict(textoHistorico);
              const telefone = (phones && phones.length) ? phones[0] : null;
              if (telefone) {
                parsed.telefone_extraido = telefone;
              }
            }

            // Atualiza dados coletados locais (cidade, telefone, cereja)
            atualizarDadosColetados(chatId, {
              cidade: cidadePreferida || null,
              telefone: parsed.telefone_extraido || null,
              dados: parsed.dados || {}
            });

            // Inicia timer se capturou telefone pela primeira vez
            const jaTinhaTimer = timersFechamento && timersFechamento.has(chatId);
            if (!jaTinhaTimer && parsed.telefone_extraido) {
              iniciarTimerFechamento(chatId, parsed.telefone_extraido);
            }

            // Reaproveitar a página atual - NUNCA reload/goto
            const pAtual = await ensurePage().catch(() => null);
            if (!pAtual) {
              logger.warn('[GROQ] Page indisponível', { nome, chatId });
              await setChatState(nome, chatId, { state: 'erro_envio', erroTimestamp: Date.now() });
              try { await pendingDel(nome, chatId); } catch {}
              fila = fila.filter(id => id !== chatId);
              chatAtivo = null;
              return;
            }

            // Verifica se está no chat correto - se não, apenas marca cooldown (não navega)
            let urlNow = (typeof pAtual.url === 'function') ? (pAtual.url() || '') : '';
            if (!chatUrlMatches(urlNow, chatId) || !(await assertOnChat(pAtual, chatId, { timeoutMs: 0 }))) {
              logger.warn('[GROQ] URL/contexto não corresponde (sem navegação). Cooldown.', { nome, chatId, urlNow });
              const prev = await getChatState(nome, chatId).catch(()=>null);
              const attempts = (prev && prev.sendAttempts ? prev.sendAttempts : 0) + 1;
              await setChatState(nome, chatId, {
                state: CHAT_STATES.AGUARDANDO,
                sendAttempts: attempts,
                cooldownUntil: Date.now() + Math.min(60000, 20000 * attempts),
                lastProbeAt: Date.now()
              });
              try { await pendingDel(nome, chatId); } catch {}
              fila = fila.filter(id => id !== chatId);
              chatAtivo = null;
              return;
            }

            // Tenta obter composer - se falhar, usa refocusComposerNoReload
            let campoEnvio = await waitForComposer(pAtual, 10000);
            if (!campoEnvio) {
              logger.info('[GROQ] Composer não encontrado, tentando refocus', { nome, chatId });
              campoEnvio = await refocusComposerNoReload(pAtual, chatId, anchorSel);
            }

            if (!campoEnvio) {
              logger.warn('[GROQ] Composer indisponível após refocus - marcando cooldown', { nome, chatId });
              const prev = await getChatState(nome, chatId).catch(()=>null);
              const attempts = (prev && prev.sendAttempts ? prev.sendAttempts : 0) + 1;
              await setChatState(nome, chatId, {
                state: 'erro_envio',
                erroTimestamp: Date.now(),
                sendAttempts: attempts,
                cooldownUntil: Date.now() + Math.min(60000, 20000 * attempts),
                ultimoProbeCLIts: tsCLI || 0,
                lastProbeAt: Date.now()
              });
              try { await pendingDel(nome, chatId); } catch {}
              fila = fila.filter(id => id !== chatId);
              chatAtivo = null;
              return;
            }

            // Calcular pace do cliente e aplicar dedup
            const paceDelay = calcularPaceCliente(historicoConversa);
            logger.info('[PACE] Delay calculado: ' + paceDelay + 'ms', { nome, chatId });
            
            // Aplicar dedup rigoroso (últimas 3 respostas IA)
            let respostaFinal = parsed.resposta;
            respostaFinal = aplicarDedupResposta(respostaFinal, historicoConversa);
            if (respostaFinal !== parsed.resposta) {
              logger.info('[DEDUP] Resposta ajustada para evitar repetição', { nome, chatId });
            }
            
            // Aguardar delay humano baseado no pace do cliente
            await sleep(paceDelay);
            
            try {
              await setChatState(nome, chatId, { state: CHAT_STATES.ENVIANDO });
            } catch {}

            // AQUISIÇÃO DO LOCK — "just-in-time locking"
            await acquireSendGuard(pAtual, chatId);
            try {
              // PROTEÇÃO: Verifica se a última mensagem enviada é igual à atual (evita duplicação)
              const ultimaIATexto = ultimaIA && ultimaIA.texto ? String(ultimaIA.texto).trim() : '';
              const respostaAtual = String(respostaFinal || '').trim();
              if (ultimaIATexto && respostaAtual && ultimaIATexto === respostaAtual) {
                logger.warn('[GROQ] Mensagem duplicada detectada - pulando envio', { nome, chatId, resposta: respostaAtual.substring(0, 50) });
                await setChatState(nome, chatId, {
                  state: CHAT_STATES.AGUARDANDO,
                  lastProbeAt: Date.now(),
                  ultimoProbeCLIts: tsCLI || 0
                });
                try { await pendingDel(nome, chatId); } catch {}
                fila = fila.filter(id => id !== chatId);
                chatAtivo = null;
                return;
              }

              // ENFORCEMENT: Aplicar regras de governança antes de enviar (mas preservar a inteligência da IA)
              const stFlowPrev = await getChatState(nome, chatId).catch(()=>null);
              const flowPrev = (stFlowPrev && stFlowPrev.flow) ? stFlowPrev.flow : { greeted: false, asked: {}, answered: {} };
              let respostaGov = enforceGovRulesOnText(respostaFinal, { alreadyGreeted: !!flowPrev.greeted });
              
              // CRÍTICO: NÃO substituir a resposta da IA por uma fixa - confiar na inteligência da IA
              // Apenas garantir que menciona WhatsApp se necessário, mas SEMPRE preservando a resposta original
              const utils = require('./utils.js');
              const telOk = utils.isValidBRPhoneWithDDD(parsed.telefone_extraido || (flowPrev.answered && flowPrev.answered.telefone) || '');
              if (!telOk) {
                // Se a resposta não menciona WhatsApp, adiciona de forma natural (não substitui)
                if (!/whats(app)?|telefone|n[uú]mero/i.test(respostaGov)) {
                  // Adiciona a pergunta de WhatsApp de forma natural, preservando a resposta original
                  respostaGov = respostaGov.trim();
                  if (!respostaGov.endsWith('.')) respostaGov += '.';
                  respostaGov += ' Pode me passar seu WhatsApp? O motorista chama por lá.';
                }
              }
              
              await setChatState(nome, chatId, {
                flow: flowPrev,
                ultimaRespostaEnviada: respostaGov,
                lastProbeAt: Date.now()
              });
              
              await sendMessageSafe(pAtual, campoEnvio, respostaGov, nome, chatId);
              await appendIaLine(nome, chatId, respostaGov);
              
              // Garantir greeted=true após primeira resposta
              try {
                const st = await getChatState(nome, chatId).catch(()=>null);
                const flowSt = (st && st.flow) ? st.flow : { greeted: false, asked: {}, answered: {} };
                if (!flowSt.greeted) {
                  flowSt.greeted = true;
                  await setChatState(nome, chatId, { flow: flowSt, lastProbeAt: Date.now() });
                }
              } catch {}
              
              // Salvar secondaryPrompted após enviar resposta
              try { await setChatState(nome, chatId, { secondaryPrompted: true }); } catch {}

              await marcarRespondido(nome, chatId);
            } finally {
              // SEMPRE libera o lock, mesmo em caso de erro ou return antecipado
              releaseSendGuard(pAtual);
            }

            // Após envio bem-sucedido, persista (CRÍTICO: atualiza ultimoProbeCLIts para permitir detecção de novas mensagens)
            try {
              // Re-extrai histórico para pegar o timestamp mais recente do cliente
              let tsCLIAtualizado = tsCLI || 0;
              try {
                const historicoAtualizado = await extrairHistoricoConversa(pAtual);
                const ultimaClienteAtualizada = historicoAtualizado && historicoAtualizado.filter(m => m.autor === 'cliente').pop();
                if (ultimaClienteAtualizada && ultimaClienteAtualizada.timestamp) {
                  tsCLIAtualizado = tsNum(ultimaClienteAtualizada.timestamp);
                }
              } catch {}
              
              await setChatState(nome, chatId, {
                ultimaMensagemClienteProcessada: ultimaMsgClienteTexto,
                ultimoProbeCLIts: tsCLIAtualizado, // Atualiza para permitir detecção de novas mensagens
                lastIATs: Date.now(),
                lastProbeAt: Date.now(),
                lastClientHash,
                ultimaRespostaEnviada: respostaAtual, // Guarda a última resposta para evitar duplicação
                state: CHAT_STATES.AGUARDANDO // Garante que está aguardando resposta do cliente
              });
            } catch {}

            logger.info('[GROQ] Resposta enviada com sucesso', { chatId, finalizado: parsed.finalizado, tel: parsed.telefone_extraido });
          } catch (e) {
            logger.error('[GROQ] Falha no fluxo direto', { chatId, error: e && e.message || e });
            // Retry/backoff: registra tentativas e agenda reprocessamento
            try {
              const prev = await getChatState(nome, chatId);
              const attempts = (prev && prev.sendAttempts ? prev.sendAttempts : 0) + 1;
              const baseMin = 2; // 2min base
              const nextMs = Math.min(5 * 60 * 1000, Math.pow(2, attempts - 1) * baseMin * 60 * 1000); // max 5min

              if (attempts >= 3) {
                // Após 3 falhas, marca "erro_envio" e não tenta mais para esta mesma mensagem
                const msgHash = hashResposta(ultimaMsgClienteTexto || '');
                await setChatState(nome, chatId, {
                  state: 'erro_envio',
                  sendAttempts: attempts,
                  ultimaMsgErroHash: msgHash,
                  erroTimestamp: Date.now(), // NOVO: salva timestamp do erro para TTL
                  ultimoProbeCLIts: tsCLI || 0
                });
                await logIssue(nome, 'virtus_send_failed', `erro_envio após ${attempts} tentativas (chat ${chatId})`);
              } else {
                // Backoff exponencial até 5min no estado AGUARDANDO
                await setChatState(nome, chatId, {
                  state: CHAT_STATES.AGUARDANDO,
                  sendAttempts: attempts,
                  cooldownUntil: Date.now() + nextMs,
                  ultimoProbeCLIts: tsCLI || 0
                });
                await logIssue(nome, 'virtus_send_failed', `retry_schedule attempt=${attempts} in=${Math.round(nextMs/1000)}s chat=${chatId}`);
              }
            } catch {}
            // encerra ciclo
            try { await pendingDel(nome, chatId); } catch {}
            fila = fila.filter(id => id !== chatId);
            chatAtivo = null;
            return;
          }
        } else {
          // Fluxo antigo: Notificador
          // 5. Formata localização no padrão "Cidade (UF)" para a planilha Google
          const localizacaoFormatada = formatarLocalizacaoParaPlanilha(localizacao);

          // 6. Adiciona na fila de envio para o notificador com TODO o histórico
          adicionarChatParaEnvio(nome, {
            chatId,
            tipoServico,
            historico: historicoConversa, // TODO o histórico da conversa
            localizacao: localizacaoFormatada,
            urlClassificado
          });

          // INÍCIO PATCH: Gravar última mensagem do cliente processada (persistida em disco) - caminho Notificador
          try {
            await setChatState(nome, chatId, {
              ultimaMensagemClienteProcessada: ultimaMsgClienteTexto,
              ultimoProbeCLIts: tsCLI || 0
            });
          } catch {}
          // FIM PATCH
        }

        // Ledger: remove pending (chat foi processado)
        try { await pendingDel(nome, chatId); } catch {}
        fila = fila.filter(id => id !== chatId);
        chatAtivo = null;
        
        // NOVO: atualiza lastProbeAt no final do processamento (sucesso)
        try { 
          await setChatState(nome, chatId, { lastProbeAt: Date.now() }); 
        } catch {}

      } catch (err) {
        const msgErr = (err && err.message) ? err.message : String(err);
        // Se alvo fechou, classificar corretamente e sair silenciosamente
        if (/Target closed|Protocol error.*Target closed|Session closed/i.test(msgErr)) {
          try { await logIssue(nome, 'browser_disconnected', `chat ${chatId}: target/page closed during send`); } catch {}
        } else {
          try { await logIssue(nome, 'virtus_send_failed', `chat ${chatId}: ${msgErr}`); } catch {}
        }
        logger.error('Erro ao responder chat', { nome, chatId }, err);
        // Rollback pending em caso de erro
        try { await pendingDel(nome, chatId); } catch {}
        // NOVO: atualiza lastProbeAt mesmo em caso de erro
        try { 
          await setChatState(nome, chatId, { lastProbeAt: Date.now() }); 
        } catch {}
      }

      fila = fila.filter(id => id !== chatId);
      if (VIRTUS_DETAILED_DEBUG) { log(`[DETAILED] ChatId ${chatId} removido da fila e finalizado.`); }
    } finally {
      // CRÍTICO: Sempre liberar chatAtivo no finally para garantir que não fique travado
      if (chatAtivo === chatId) {
        chatAtivo = null;
        logger.info('[RESPONDER] chatAtivo liberado no finally', { nome, chatId });
      }
      
      // CRÍTICO: Sempre tentar liberar lock no finally, mesmo se não foi adquirido
      // Isso garante que locks órfãos sejam limpos
      try { 
        chatLock.release(nome, chatId);
        if (_chatLockAcquired) {
          logger.info('[RESPONDER] Lock liberado no finally', { nome, chatId });
        } else {
          logger.debug('[RESPONDER] Tentativa de liberar lock no finally (não estava adquirido)', { nome, chatId });
        }
      } catch (e) {
        logger.warn('[RESPONDER] Erro ao liberar lock no finally', { nome, chatId, error: e && e.message || e });
      }
      
      if (_chatLockAcquired) {
        stepLog.appendJSONL(nome, 'virtus', { attempt: attId, step: 'chat_unlock', chatId });
      }
      
      // Garantia: nunca deixar pending zumbi
      try { await pendingDel(nome, chatId); } catch {}
      resetFail(chatId); // limpa failCounts quando fim do ciclo
      try { 
        const p = await ensurePage().catch(()=>null);
        if (p) releaseSendGuard(p); 
      } catch {}
    }
  }

  // ========================
  // === BLOCO MODIFICADO ===
  // ========================
  async function filaManagerLoop() {
    if (!running || !epochOk()) return;
    logger.info(`[FILA] tick — running=${running} fila=${fila.length} chatAtivo=${chatAtivo || '-'}`, { nome });
    // ========== INÍCIO BLOCO FREEZER INSTRUÇÃO 2 ==========
    let manifestFrozenUntil = 0;
    try {
      const manifest = await manifestStore.read(nome);
      manifestFrozenUntil = typeof manifest?.frozenUntil === 'number' ? manifest.frozenUntil : 0;
    } catch {}
    if (manifestFrozenUntil && manifestFrozenUntil > Date.now()) {
      running = false;
      if (filaInterval) clearInterval(filaInterval), filaInterval = null;
      if (filaChatTimer) clearTimeout(filaChatTimer), filaChatTimer = null;
      if (scrollInterval) clearInterval(scrollInterval), scrollInterval = null;
      logger.warn(`[VIRTUS][${nome}] virtus_stop_frozen window — congelado até ${new Date(manifestFrozenUntil).toISOString()}`, { nome });
      return;
    }
    // ========== FIM BLOCO FREEZER INSTRUÇÃO 2 ==========

    // === INÍCIO GUARD DE VIDA NO FILAMANAGERLOOP ===
    if (!browser || browser.isConnected?.() === false) {
      logger.error(`[VIRTUS][${nome}] Browser morto/desconectado — encerrando Virtus`, { nome });
      if (issues) try { await logIssue(nome, 'virtus_page_dead', 'browser morto/disconnected'); } catch {}
      running = false;
      if (filaInterval) clearInterval(filaInterval), filaInterval = null;
      if (filaChatTimer) clearTimeout(filaChatTimer), filaChatTimer = null;
      if (scrollInterval) clearInterval(scrollInterval), scrollInterval = null;
      return;
    }
    // Fim guard de vida browser

    if (filaLoopBusy) return;
    filaLoopBusy = true;
    try {
      const p = await ensurePage();
      if (!p || (p.isClosed && p.isClosed())) {
        logger.error(`[VIRTUS][${nome}] Page fechada/desconectada — encerrando Virtus`, { nome });
        if (issues) try { await logIssue(nome, 'virtus_page_dead', 'page closed/disconnected'); } catch {}
        running = false;
        if (filaInterval) clearInterval(filaInterval), filaInterval = null;
        if (filaChatTimer) clearTimeout(filaChatTimer), filaChatTimer = null;
        if (scrollInterval) clearInterval(scrollInterval), scrollInterval = null;
        return;
      }


      // ======= INSTRUÇÃO: REMOVER BLOCO REVIVE AQUI =======
      /*
      // --- INÍCIO DETECTOR/REVIVE ---
      try {
        const reviveTimeoutMs = 1000;
        const jsTest = await Promise.race([
          p.evaluate(() => 1+41),
          new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), reviveTimeoutMs))
        ]);
      } catch (e) {
        try {
          log('[VIRTUS][REVIVE] Navegador detectado travado/sem resposta — abrindo aba fantasma para tentar reviver.');
          const tmp = await browser.newPage();
          setTimeout(() => { try { tmp.close(); } catch {} }, 1000);
        } catch (e2) {
        }
      }
      // --- FIM DETECTOR/REVIVE ---
      */
      // === BLOCO REMOVIDO CONFORME INSTRUÇÃO ===

      // Não dispare keepalive durante inserção de mensagem
      if (!isVirtusLocked(nome)) {
        try {
          await p.evaluate(() => {
            window.dispatchEvent(new Event('focus'));
            document.dispatchEvent(new MouseEvent('mousemove', {bubbles:true}));
            document.dispatchEvent(new Event('visibilitychange'));
            if (window && document && document.body) {
              const evt = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'Control', code: 'ControlLeft' });
              document.body.dispatchEvent(evt);
            }
          });
        } catch {}
      }

      if (limpaHistoricoVelho()) await salvaHistorico();

      // Em filaManagerLoop (logo após obter p via ensurePage()):
      const b = getBrowserFromPage(p);
      if (b && b._sendLock && b._sendLock.active) {
        const age = Date.now() - (b._sendLock.since || 0);
        if (age > 45000) {
          logger.warn('[FILA] sendLock ativo há >45s — liberando por watchdog', { nome });
          b._sendLock.active = false;
        } else {
          logger.info('[FILA] sendLock ativo — skip garantirMarketplace nesta iteração.', { nome });
          return;
        }
      }
      await maybeGuaranteeMarketplaceFast(p, nome);

      await atualizaFila();
      scheduleNextIfIdle();
      resetRecoverBackoff();

      if (scrollInterval == null) {
        scrollInterval = setInterval(async () => {
          if (!running || !epochOk()) return;
          try {
            const ok = await scrollChatsToTop(p, nome);
            if (VIRTUS_SCROLL_DEBUG) { log('[SCROLL TOP]', ok ? 'OK' : 'FAIL'); }
            if (ok) {
              lastScrollToTop = Date.now();
            }
          } catch {}
          // Reforço após 800ms para garantir Messenger reativo
          setTimeout(() => {
            if (!running || !epochOk()) return;
            try {
              const b = getBrowserFromPage(p);
              if (b && b._sendLock && b._sendLock.active) return;
            } catch {}
            scrollChatsToTop(p, nome);
          }, 800);
        }, 30000);
      }
      try {
        const scrolled = await scrollChatsToTop(p, nome);
        if (VIRTUS_SCROLL_DEBUG) { log('[SCROLL TOP]', scrolled ? 'OK' : 'FAIL'); }
        if (scrolled) {
          lastScrollToTop = Date.now();
        }
        // Reforço após 800ms para garantir Messenger reativo
        setTimeout(() => {
          if (!running || !epochOk()) return;
          try {
            const b = getBrowserFromPage(p);
            if (b && b._sendLock && b._sendLock.active) return;
          } catch {}
          scrollChatsToTop(p, nome);
        }, 800);
      } catch {}

      // ========== INÍCIO BLOCO ADICIONADO CONFORME INSTRUÇÃO ==========
      // Checagem de bloqueio temporário Messenger (DOM) — apenas LOG, congelamento é feito pelo nurseTick
      try {
        const det = await p.evaluate(() => {
          const norm = s => (s || '').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase();
          const texts = Array.from(document.querySelectorAll('h1,h2,span,div')).map(el => norm(el.innerText || el.textContent || ''));
          const hasBlocked =
            texts.some(t =>
              t.includes('voce esta bloqueado temporariamente') ||
              t.includes('você está bloqueado temporariamente') ||
              t.includes('youre temporarily blocked') ||
              t.includes('you’re temporarily blocked') ||
              t.includes('temporarily blocked')
            );
          return { blocked: hasBlocked };
        });
        if (det && det.blocked) {
          // Apenas LOG, não congele aqui! O nurseTick irá congelar.
          if (issues) try { await logIssue(nome, 'virtus_blocked', 'Messenger temporariamente bloqueado (Virtus/Marketplace)'); } catch {}
        }
      } catch {}
      // ========== FIM BLOCO ADICIONADO ==========

      // Garantir giro da fila
      if (!chatAtivo) scheduleNextIfIdle();

    } finally {
      filaLoopBusy = false;
      
    }
  }
  // ==== FIM BLOCO MODIFICADO ====

  // Controle de timer e dados por chat (escopo do perfil) - APENAS SE DIRECT_GROQ
  // Definido ANTES de responderChat() para estar acessível
  const timersFechamento = DIRECT_GROQ ? new Map() : null; // chatId -> { inicio, telefone, expirado }
  const dadosColetados = DIRECT_GROQ ? new Map() : null;   // chatId -> { cidade, telefone, ajudante, saida_tipo, saida_elevador, destino_tipo, destino_elevador, bairro_saida, bairro_destino, itens }
  const pedidosEnviados = DIRECT_GROQ ? new Set() : null;  // chatId já enviados

  async function atualizarDadosColetados(chatId, { cidade = null, telefone = null, dados = {} } = {}) {
    if (!dadosColetados) return;
    if (!dadosColetados.has(chatId)) dadosColetados.set(chatId, {});
    const cur = dadosColetados.get(chatId);
    if (cidade && !cur.cidade) cur.cidade = cidade;
    if (telefone) cur.telefone = telefone;
    // dados cereja
    const keys = ['ajudante','saida_tipo','saida_elevador','destino_tipo','destino_elevador','bairro_saida','bairro_destino','itens','data_hora'];
    for (const k of keys) {
      if (dados && dados[k] != null) cur[k] = dados[k];
    }
    dadosColetados.set(chatId, cur);
    // Persiste em disco
    try {
      await setChatState(nome, chatId, {
        dadosColetados: cur,
        updatedAt: Date.now()
      });
    } catch {}
    try { enviarPedidoParcialSeHabilitado(chatId); } catch {}
  }

  async function iniciarTimerFechamento(chatId, telefone) {
    const utils = require('./utils.js');
    if (!utils.isValidBRPhoneWithDDD(telefone || '')) {
      logger.warn('[TIMER] Tentativa de iniciar timer sem WhatsApp válido — bloqueado', { chatId });
      return;
    }
    if (!timersFechamento) return;
    if (timersFechamento.has(chatId)) return; // não reinicia
    const inicio = Date.now();
    const expiraEm = inicio + (10 * 60 * 1000); // 10 minutos
    timersFechamento.set(chatId, { inicio, telefone, expirado: false, expiraEm });
    // Persiste em disco
    try {
      await setChatState(nome, chatId, {
        timerStartedAt: inicio,
        timerExpiresAt: expiraEm,
        timerTelefone: telefone,
        updatedAt: Date.now()
      });
    } catch {}
    // 10 minutos depois, verifica
    setTimeout(() => verificarTimerExpirado(chatId), 10 * 60 * 1000);
    logger.info('[TIMER] Timer de 10min iniciado', { chatId, telefone });
  }

  async function verificarTimerExpirado(chatId) {
    if (!timersFechamento) return;
    const t = timersFechamento.get(chatId);
    if (!t || t.expirado) return;
    const decorrido = Date.now() - t.inicio;
    if (decorrido >= 10 * 60 * 1000) {
      t.expirado = true;
      timersFechamento.set(chatId, t);
      logger.info('[TIMER] Timer expirado — fechando pedido', { chatId });
      const dados = dadosColetados ? (dadosColetados.get(chatId) || {}) : {};
      try {
        await enviarPedidoParaNotificador(chatId, dados);
        if (pedidosEnviados) pedidosEnviados.add(chatId);
        await enviarMensagemFinal(chatId);
        await marcarRespondido(nome, chatId); // marca local
      } catch (e) {
        logger.error('[TIMER] Falha ao fechar pedido', { chatId, error: e && e.message || e });
      }
    }
  }

  // Resume timers após reboot/startVirtus
  async function resumeTimers() {
    if (!DIRECT_GROQ || !timersFechamento) return;
    try {
      const allStates = await loadChatState(nome);
      const agora = Date.now();
      for (const [chatId, state] of Object.entries(allStates)) {
        if (!state || !state.timerExpiresAt) continue;
        const expiraEm = state.timerExpiresAt;
        if (expiraEm <= agora) {
          // Timer já expirado, processa imediatamente
          await verificarTimerExpirado(chatId);
        } else {
          // Reprograma timer
          const restante = expiraEm - agora;
          timersFechamento.set(chatId, {
            inicio: state.timerStartedAt || (agora - (10 * 60 * 1000 - restante)),
            telefone: state.timerTelefone || null,
            expirado: false,
            expiraEm
          });
          setTimeout(() => verificarTimerExpirado(chatId), restante);
          logger.info('[TIMER] Timer restaurado', { chatId, restante: Math.round(restante / 1000) + 's' });
        }
        // Restaura dados coletados
        if (state.dadosColetados && dadosColetados) {
          dadosColetados.set(chatId, state.dadosColetados);
        }
      }
    } catch (e) {
      logger.warn('[TIMER] Erro ao restaurar timers', { error: e && e.message || e });
    }
  }

  function estruturarPedidoCompleto(nomePerfil, chatId, dados = {}) {
    const cidade = (dados && dados.cidade) || null;
    return {
      servidor: NOTIFICADOR_SERVIDOR || 'servidor1',
      perfil: nomePerfil,
      chat_id: chatId,
      cidade: cidade,
      telefone: dados && dados.telefone || null,
      itens: dados && dados.itens || null,
      bairro_saida: dados && dados.bairro_saida || null,
      bairro_destino: dados && dados.bairro_destino || null,
      saida_tipo: dados && dados.saida_tipo || null,
      saida_elevador: dados && dados.saida_elevador || null,
      destino_tipo: dados && dados.destino_tipo || null,
      destino_elevador: dados && dados.destino_elevador || null,
      ajudante: dados && dados.ajudante || null,
      timestamp: Date.now()
    };
  }

  // envio parcial opcional: NOTIFICADOR_ENVIAR_PARCIAL=1
  const _parcialCooldown = new Map(); // chatId -> lastSent
  async function enviarPedidoParcialSeHabilitado(chatId) {
    try {
      if (String(process.env.NOTIFICADOR_ENVIAR_PARCIAL || '0') !== '1') return;
      const now = Date.now();
      const last = _parcialCooldown.get(chatId) || 0;
      if ((now - last) < 5000) return; // 5s de cooldown
      const dados = dadosColetados && dadosColetados.get(chatId) || {};
      const payload = estruturarPedidoCompleto(nome, chatId, dados);
      payload.parcial = true;
      const urlFinal = `${NOTIFICADOR_URL}/api/pedidos`;
      await fetch(urlFinal, {
        method: 'POST',
        headers: { 'Content-Type':'application/json' },
        body: JSON.stringify(payload)
      }).catch(()=>{});
      _parcialCooldown.set(chatId, now);
      logger.info('[NOTIFICADOR] Pedido parcial enviado', { chatId, perfil: nome });
    } catch {}
  }

  async function enviarPedidoParaNotificador(chatId, dados) {
    if (!pedidosEnviados || pedidosEnviados.has(chatId)) return; // evita duplicar
    const payload = estruturarPedidoCompleto(nome, chatId, dados);
    const urlFinal = `${NOTIFICADOR_URL}/api/pedidos`;
    const resp = await fetch(urlFinal, {
      method: 'POST',
      headers: { 'Content-Type':'application/json' },
      body: JSON.stringify(payload)
    });
    if (!resp.ok) {
      const txt = await resp.text().catch(()=> '');
      throw new Error(`Notificador error ${resp.status}: ${txt}`);
    }
    logger.info('[NOTIFICADOR] Pedido final enviado', { chatId, perfil: nome });
  }

  async function enviarMensagemFinal(chatId) {
    const mensagem = 'Perfeito! Recebi todas as informações. Já vou processar seu pedido e te chamar no WhatsApp. Obrigado pela confiança! 🙌\n\nSiga nosso Instagram: @seu_instagram';
    let p = await ensurePage().catch(() => null);
    if (!p) {
      logger.warn('[MENSAGEM_FINAL] Page indisponível', { nome, chatId });
      return;
    }
    try {
      // NUNCA navegue/goto - apenas verifica se está no chat correto
      const expectedPath = `/marketplace/t/${chatId}/`;
      let urlNow = (typeof p.url === 'function') ? (p.url() || '') : '';
      if (!urlNow.includes(expectedPath)) {
        logger.warn('[MENSAGEM_FINAL] URL não corresponde ao chat - abortando', { nome, chatId, urlNow });
        return;
      }
      
      const okOn = await assertOnChat(p, chatId, { timeoutMs: 2000 });
      if (!okOn) {
        logger.warn('[MENSAGEM_FINAL] Chat não confirmado - abortando', { nome, chatId });
        return;
      }
      
      let campo = await waitForComposer(p, 8000);
      if (!campo) {
        logger.info('[MENSAGEM_FINAL] Composer não encontrado, tentando refocus', { nome, chatId });
        const anchorSel = `a[href^="/marketplace/t/${chatId}"]`;
        campo = await refocusComposerNoReload(p, chatId, anchorSel);
      }
      
      if (!campo) {
        logger.warn('[MENSAGEM_FINAL] Composer indisponível após refocus', { nome, chatId });
        return;
      }
      
      await sendMessageSafe(p, campo, mensagem, nome, chatId);
      logger.info('[MESSENGER] Mensagem final enviada', { chatId });
    } catch (e) {
      logger.warn('[MESSENGER] Falha ao enviar mensagem final', { chatId, error: e && e.message || e });
    }
  }

  async function runner() {
    const attId = stepLog.attemptId();

    // ========== INÍCIO BLOCO FREEZER INSTRUÇÃO 2 ==========
    let manifestFrozenUntil = 0;
    try {
      const manifest = await manifestStore.read(nome);
      manifestFrozenUntil = typeof manifest?.frozenUntil === 'number' ? manifest.frozenUntil : 0;
    } catch {}
    if (manifestFrozenUntil && manifestFrozenUntil > Date.now()) {
      running = false;
      if (filaInterval) clearInterval(filaInterval), filaInterval = null;
      if (filaChatTimer) clearTimeout(filaChatTimer), filaChatTimer = null;
      if (scrollInterval) clearInterval(scrollInterval), scrollInterval = null;
      logger.warn(`[VIRTUS][${nome}] virtus_stop_frozen window — congelado até ${new Date(manifestFrozenUntil).toISOString()}`, { nome });
      return;
    }
    // ========== FIM BLOCO FREEZER INSTRUÇÃO 2 ==========

    await sleep(2000);
    let ready = false;
    while (running && !ready) {
      if (!running || !epochOk()) return;
      try {
        if (!running || !epochOk()) return;
        const p = await ensurePage();
        if (!running || !epochOk()) return;
        if (!p) { await sleep(2500); continue; }
        if (p.url() === 'about:blank' || !/messenger\.com\/marketplace/i.test(p.url())) {
          try {
            if (!running || !epochOk()) return;
            await p.goto('https://www.messenger.com/marketplace', { waitUntil: 'domcontentloaded', timeout: 30000 });
          } catch {
            bumpRecoverBackoff(); if (recoverBackoffMs) await sleep(recoverBackoffMs); continue;
          }
        }
        if (!running || !epochOk()) return;
        await maybeGuaranteeMarketplaceFast(p, nome);
        try {
          const ok = await scrollChatsToTop(p, nome);
          setTimeout(() => {
            if (!running || !epochOk()) return;
            try {
              const b = getBrowserFromPage(p);
              if (b && b._sendLock && b._sendLock.active) return;
            } catch {}
            scrollChatsToTop(p, nome);
          }, 800);
        } catch {}
        ready = true;
        logger.info('Aba zero da Virtus iniciada e garantida: Marketplace pronta.', { nome });
        
        // Instalar MutationObserver para detectar novos chats em tempo real
        let NEWCHAT_DEDUP = new Set();
        function onNewChatDetected({ id, tempo }) {
          const chatId = id;
          const now = Date.now();
          if (respondedCache && respondedCache.has(chatId)) return;
          const last = lastProbeMap.get(chatId) || 0;
          if ((now - last) < Math.min(PROBE_RECHECK_MIN_MS, 1000)) return;
          lastProbeMap.set(chatId, now);
          if (!fila.includes(chatId) && !aguardandoRespostaMap.get(nome)?.has(chatId)) {
            fila.push(chatId);
            scheduleNextIfIdle();
          }
        }
        await installChatFeedObserver(p, nome, onNewChatDetected);
      } catch (err) {
        if (!running) return;
        logger.error('Falha ao garantir aba zero no startup Virtus', { nome }, err);
        await sleep(2500);
      }
    }
    if (!running || !epochOk()) return;
    await initHistoricoSePreciso();
    
    // Inicialização do Notificador (apenas se não estiver em modo DIRECT_GROQ)
    if (!DIRECT_GROQ) {
      try {
        await fazerHandshakeNotificador(nome);
        iniciarPollingRespostas(nome);
        
        // Implementa enviarRespostaMessengerSegura dentro do contexto do Virtus
        async function enviarRespostaMessengerSeguraLocal(chatId, resposta) {
        const MAX_TRIES = 2;
        let lastErr = null;
        
        for (let attempt = 1; attempt <= MAX_TRIES; attempt++) {
          let p = await ensurePage().catch(() => null);
          if (!p) {
            lastErr = new Error('page_unavailable');
            if (attempt === MAX_TRIES) break;
            await new Promise(r => setTimeout(r, 600 + Math.floor(Math.random() * 400)));
            continue;
          }
          
          try {
            // Em enviarRespostaMessengerSeguraLocal: Antes de qualquer navegação/goto, insira o check:
            try {
              const urlNow = (p && typeof p.url === 'function') ? (p.url() || '') : '';
              const okChat = chatUrlMatches(urlNow, chatId);
              let campo = null;
              let hasComposer = false;
              if (okChat) {
                campo = await waitForComposer(p, 1500).catch(()=>null);
                hasComposer = !!campo;
              }
              if (okChat && hasComposer) {
                await sendMessageSafe(p, campo, String(resposta || ''), nome, chatId);
                return true;
              }
            } catch {}
            
            logger.debug('[MESSENGER] Tentativa de envio', { nome, chatId, attempt, maxTries: MAX_TRIES });
            
            // NUNCA navegue/goto - apenas verifica se está no chat correto
            let urlNow = (typeof p.url === 'function') ? (p.url() || '') : '';
            if (!chatUrlMatches(urlNow, chatId)) {
              logger.warn('[MESSENGER] URL não corresponde ao chat - abortando', { nome, chatId, urlNow });
              throw new Error('chat_not_on_correct_url');
            }
            
            const okOn = await assertOnChat(p, chatId, { timeoutMs: 2000 });
            if (!okOn) {
              throw new Error('chat_not_opened');
            }
            
            let campo = await waitForComposer(p, 10000);
            if (!campo) {
              logger.info('[MESSENGER] Composer não encontrado, tentando refocus', { nome, chatId });
              const anchorSel = `a[href^="/marketplace/t/${chatId}"]`;
              campo = await refocusComposerNoReload(p, chatId, anchorSel);
            }
            
            if (!campo) {
              throw new Error('composer_not_available');
            }
            
            await campo.focus();
            await new Promise(r => setTimeout(r, 120));
            
            if (!(await assertOnChat(p, chatId, { timeoutMs: 2000 }))) {
              throw new Error('context_lost');
            }
            
            await sendMessageSafe(p, campo, String(resposta || ''), nome, chatId);
            
            logger.info('[MESSENGER] ✅✅✅ Enviada (robusta)', { nome, chatId, attempt });
            return true;
          } catch (err) {
            lastErr = err;
            const msgErr = (err && err.message) ? err.message : String(err);
            logger.warn('[MESSENGER] Tentativa falhou', { 
              nome, 
              chatId, 
              attempt, 
              maxTries: MAX_TRIES,
              error: msgErr 
            });
            
            if (attempt < MAX_TRIES) {
              // Aguardar antes de retry
              await new Promise(r => setTimeout(r, 600 + Math.floor(Math.random() * 400)));
            }
          }
        }
        
        if (lastErr) {
          const msgErr = (lastErr && lastErr.message) ? lastErr.message : String(lastErr);
          logger.error('[MESSENGER] ❌ Erro ao enviar mensagem após todas as tentativas', { 
            nome, 
            chatId, 
            error: msgErr 
          }, lastErr);
          throw lastErr;
        }
        
        return false;
      }
      
      // Implementa marcarRespondido dentro do contexto do Virtus
      async function marcarRespondidoLocal(chatId) {
        try {
          const agoraTs = agoraEpoch();
          let historicoLocal = {};
          try { historicoLocal = await readJson(HIST_FILE, {}); } catch {}
          historicoLocal[chatId] = agoraTs;
          await writeJsonAtomicFsync(HIST_FILE, historicoLocal);
          // atualiza cache local do Virtus
          setResponded(chatId, agoraTs);
          await salvaHistorico();
        } catch (e) {
          logger.error('[VIRTUS] marcarRespondido error', { nome, chatId, error: e && e.message || e });
        }
      }
      
        iniciarFilaEnvioMessenger(nome, enviarRespostaMessengerSeguraLocal, marcarRespondidoLocal);
      } catch (e) {
        logger.warn('[NOTIFICADOR] falha init filas/handshake (modo legado)', { nome, error: e && e.message || e });
      }
    } else {
      // Modo DIRECT_GROQ: nada a fazer aqui (responderChat envia diretamente no Messenger)
      logger.info('[GROQ] Modo DIRECT_GROQ ativo', { nome });
    // Restaura timers e dados coletados do disco
    await resumeTimers();
    }
    
    // Verificação contínua: loop recursivo sem intervalos longos
    // O filaInterval é apenas um fallback de segurança (não usado no loop principal)
    filaInterval = setInterval(filaManagerLoop, POLL_INTERVAL_MS);
    filaManagerLoop();
    
    // Kick inicial no runner: agende outra chamada em 3s, e outra em 10s
    // Isso garante polling rapidíssimo no boot para "ver" os chats sem precisar esperar o ciclo de 30s
    setTimeout(() => {
      if (running && epochOk()) {
        logger.info('[FILA] Kick inicial (3s) — forçando atualização de fila', { nome });
        atualizaFila().catch(() => {});
      }
    }, 3000);
    
    setTimeout(() => {
      if (running && epochOk()) {
        logger.info('[FILA] Kick inicial (10s) — forçando atualização de fila', { nome });
        atualizaFila().catch(() => {});
      }
    }, 10000);
  }

  runner();

  return {
    stop: async () => {
      stepLog.appendJSONL(nome, 'virtus', { attempt: attId, step: 'stop' });
      running = false;
      if (filaInterval) clearInterval(filaInterval), filaInterval = null;
      if (filaChatTimer) clearTimeout(filaChatTimer), filaChatTimer = null;
      if (scrollInterval) clearInterval(scrollInterval), scrollInterval = null;
      let pages = [];
      try { pages = await browser.pages(); } catch {}
      if (robeMeta && typeof nome !== "undefined") {
        if (!robeMeta[nome]) robeMeta[nome] = {};
        robeMeta[nome].numPages = pages.length;
      }
      // ========== Limpeza para evitar leaks ==========
      delete virtusDeadLogTimes[nome];
      try { respondedCache.clear(); } catch {}
      try { fila = []; } catch {}
      try { failCounts.clear(); } catch {}
      try { historico = {}; } catch {}
    }
  };
}

module.exports = {
  startVirtus
};