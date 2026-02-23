# CHECKUP - Contestacao V2 (dossie ponta a ponta pre-codigo)

- data: 2026-02-20
- escopo: `INC-20260222-2310-01`
- status: pre_implementation_design_locked_v2
- thread: `TH-2026-02-20-leads-porte-contestacao-ct`

---

## Objetivo desta rodada

Congelar o modelo V2 antes de codar, com foco em:
- proteger o motorista honesto sem abrir abuso em escala;
- proteger o cliente (nao perder atendimento valido);
- evitar guerra de reenvio infinito no grupo;
- manter rastreabilidade financeira e operacional por atendimento.

---

## Decisoes V2 fechadas (owner + auditoria)

1) Janela de contestacao do motorista:
- ate 23h do atendimento.

2) Motivos de contestacao (menu fechado V2):
- M1: cliente nao respondeu
- M2: cliente informou que ja contratou outro
- M3: cliente desistiu apos contato
- M4: informacoes do pedido divergentes do informado

3) Motivos removidos do menu:
- "numero invalido ou inexistente" (nao faz sentido no modelo atual, origem WhatsApp API).
- "servico fora do meu perfil cadastrado" (fica para fase futura quando houver cadastro formal de perfil de veiculo).

4) Reenvio automatico ao grupo:
- maximo 1 reenvio automatico por atendimento original.
- acima disso, fila manual no CT.

5) Regra de validacao com cliente:
- para M1/M2/M3: validar com cliente via Virtus antes da decisao final.
- para M4: fila manual direta (com possibilidade de contato com cliente no CT).

6) Politica de cota do motorista:
- quando validacao do cliente confirma a versao do motorista, nao consome cota punitiva.
- quando nao confirma, segue regra de cota e anti-abuso.

7) Fonte da verdade humana:
- operacao e CT devem priorizar telefone do cliente como identificador de leitura humana.
- `lead_token` segue como chave tecnica interna.

8) Janela de mensagens ao cliente:
- sistema inicia outbound ate 23h (janela gratuita operacional definida).
- se cliente responder depois, atendimento continua normalmente no fluxo.

---

## Fluxo operacional V2 (alto nivel)

1. Cliente abre atendimento no Virtus e pedido entra no grupo.
2. Motorista vence sorteio e recebe contato.
3. T+15 min: sistema pergunta status para o motorista (fluxo guiado):
   - "conseguiu falar com o cliente?"
4. Se motorista escolher contestar ou sem resposta:
   - abre menu de motivos M1..M4.
5. M1/M2/M3:
   - sistema consulta cliente com menu curto (sim/nao com subitem claro).
   - decide reabrir/encerrar/estornar conforme resposta.
6. M4:
   - envia para fila manual CT com trilha de auditoria.
7. Quando reabrir:
   - cria nova rodada controlada (novo ciclo de mobilizacao),
   - bloqueia reentrada automatica do motorista contestante nesse ciclo.

---

## Matriz de decisao (motivo x acao)

### M1 - cliente nao respondeu
- regra principal:
  - nunca encerrar M1 antes de 23h.
  - estorno M1 so fecha em:
    - cliente confirmou que nao quer mais, ou
    - 23h sem resposta do cliente e sem avancos validos.
- cadencia operacional:
  - T+15 min (motorista): "conseguiu falar com o contato?" -> sim / ainda nao respondeu / tive outro problema.
  - T+3h (cliente Virtus): "voce ainda quer o frete?" -> sim / nao.
  - entre T+3h e T+23h:
    - no maximo 1 lembrete adicional para cliente (sem spam),
    - motorista pode atualizar status (respondeu / nao respondeu).
  - T+23h:
    - confirmacao final com motorista,
    - confirmacao final opcional recomendada com cliente: "conseguiu falar com o motorista?".
- financeiro:
  - cliente respondeu "nao quero" -> aprova estorno.
  - cliente respondeu "sim quero" -> mantem atendimento ativo (sem estorno automatico final).
  - sem resposta ate 23h + sem avancos -> aprova estorno.

### M2 - cliente ja contratou outro
- acao inicial: contestacao provisoria.
- validacao cliente: "ja conseguiu frete?"
  - SIM: encerra e aprova estorno.
  - NAO: reabre 1 rodada no grupo.

### M3 - cliente desistiu apos contato
- acao inicial: contestacao provisoria.
- validacao cliente: "ainda deseja atendimento?"
  - NAO: encerra e aprova estorno.
  - SIM: reabre 1 rodada no grupo.

### M4 - informacoes divergentes
- acao inicial: fila manual.
- operador CT decide:
  - aprovado: estorno + possivel reabertura controlada.
  - rejeitado: sem estorno.

---

## Guardrails anti-guerra (reenvio)

1) Maximo 1 reenvio automatico por atendimento.
2) Se reenvio automatico falhar de novo, vai para manual.
3) Reenvio nunca deve gerar loop infinito.
4) Contestante nao participa do reenvio automatico do mesmo ciclo reaberto.
5) Excecao humana (fora do sorteio): se cliente quiser falar com motorista especifico, CT pode conduzir manualmente.

---

## Financeiro e consistencia (invariantes)

1) Estorno sempre atomico e idempotente por atendimento contestado.
2) Nunca estornar em lote "outros leads" por efeito colateral.
3) Retry nunca duplica estorno.
4) Estados de contestacao e financeiro devem fechar em all-or-nothing.
5) Trilha obrigatoria com:
- `driver_id`
- `phone_digits` (operacional)
- `lead_token` (tecnico)
- `motivo`
- `decisao`
- `actor_user_id`
- `requestId`
- `timestamp`

---

## Fluxo guiado para motorista (copy operacional)

Pergunta de acompanhamento (T+15 min):
- "Conseguiu falar com o cliente ({PHONE})?"

Menu sugerido:
- "Sim, falei com o contato"
  - "Consegui falar e vou seguir atendimento."
- "Ainda nao respondeu"
  - "Tente mais uma mensagem curta e, se possivel, 1 ligacao."
- "Tive outro problema com este atendimento"
  - "Abrir menu de motivos de contestacao."

Observacao:
- manter texto curto, objetivo e humano.
- evitar texto livre na fase inicial.
- cada clique deve vir com identificador tecnico unico do atendimento (nunca interpretar por texto generico).

---

## Fluxo cliente (Virtus) - menus curtos

Pergunta tipo A:
- "Voce ainda quer o frete?"
  - "Sim, ainda quero"
    - "Pode pedir para motorista me chamar."
  - "Nao, nao preciso mais"
    - "Ja resolvi / mudei de ideia."

Pergunta tipo B:
- "Voce ja conseguiu frete?"
  - "Sim, ja consegui"
    - "Nao preciso mais."
  - "Nao consegui"
    - "Quero continuar procurando."

---

## Mapeamento tecnico funcao-a-funcao (pre-codigo)

### Entrada WhatsApp motorista
- `C:\sitechatbot\whatsapp\lib\flow.js`
  - `handleInbound(...)`
  - `extractOperationKeyword(...)`
  - `extractLeadTokenFromMessage(...)`
  - `buildPaymentActionButtonsOutbox(...)`

### Sorteio / reabertura controlada
- `C:\sitechatbot\lib\pedidosStore.js`
  - `joinLeadLottery(...)`
  - `finalizeExpiredLeadLotteries(...)`
  - `getLeadLotteryOutcome(...)`
  - (novo) funcoes de bloqueio de reentrada e reabertura controlada.

### Financeiro / estorno
- `C:\sitechatbot\convenientetecnologia\lib\ctLeadLedgerStore.js`
  - `awardLead(...)`
  - `listInvoiceLeadEntries(...)`
  - `getOpenInvoiceByPhone(...)`
  - `editInvoiceLeadsAndReissue(...)`
  - (novo) funcao atomica dedicada para estorno de contestacao por atendimento.

### Fila manual e auditoria CT
- `C:\sitechatbot\convenientetecnologia\index.js`
  - endpoints `lead_ledger/*` existentes como base
  - (novo) endpoints de contestacao manual (fila, decidir, bloquear/desbloquear, historico)
- `C:\sitechatbot\convenientetecnologia\lib\ctDb.js`
  - migracoes de schema para contestacao/auditoria/flags de bloqueio.

---

## Riscos e mitigacoes

R1) Loop de reenvio:
- mitigacao: maximo 1 automatico + manual obrigatorio depois.

R2) Contestacao oportunista:
- mitigacao: validacao cliente, cota, anti-abuso, auditoria.

R3) Cliente pouco responsivo:
- mitigacao: nao encerrar antes de 23h, lembrete limitado sem spam, fechamento com confirmacao final.

R4) Complexidade operacional:
- mitigacao: menus curtos, telefone como referencia humana, estados claros.

---

## Plano de simulacao pesada (apos congelar implementacao)

1) 500-600 pedidos/dia simulados com amostragem de contestacao.
2) Testes de concorrencia de retries para garantir idempotencia.
3) Testes de reenvio com limite maximo 1.
4) Testes de confirmacao cliente tardia.
5) Reconciliaçao financeiro/estado por atendimento.
6) Teste de ambiguidade com 3+ atendimentos simultaneos por motorista (garantir roteamento por ID unico).

---

## Gate de inicio de codigo

Este dossie V2 fecha as regras de produto e operacao para iniciar codificacao.
Qualquer mudanca de regra depois deste ponto deve voltar para INC + checkup antes de runtime.

