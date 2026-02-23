# CHECKUP — Auditoria ponta a ponta pre-codigo (porte + sorteio + contestacao + CT)

- data: 2026-02-20
- status: pre_implementation_audit_complete
- escopo:
  - `INC-20260222-2230-01`
  - `INC-20260222-2310-01`
  - `INC-20260219-0950-01`

---

## Objetivo

Congelar, auditar e provar o desenho ponta a ponta antes da implementacao:
- nova qualificacao de porte no fluxo WhatsApp;
- ajuste de mensagem do sorteio tokenized (3 minutos apos primeiro participante);
- contestacao de lead com estorno total por `lead_token`, devolucao ao grupo quando valido e bloqueio de reentrada;
- operacao CT "Motoristas WhatsApp" com trilha de auditoria.

---

## Escopo funcional auditado (funcao por funcao)

### 1) Fluxo WhatsApp de pedido

- arquivo: `C:\sitechatbot\whatsapp\lib\flow.js`
- funcoes auditadas:
  - `handleAskHelper`
  - `handleAskOrigin`
  - `handleAskDestination`
  - `handleAskOriginAddress`
  - `handleAskDestinationAddress`
  - `handleAskCargo`
  - `handleConfirmCargo`
  - roteador principal `switch (step)`

Sequencia atual validada:
- cidade -> ajudante -> origem endereco -> confirmar origem -> tipo origem -> destino endereco -> confirmar destino -> tipo destino -> descricao -> confirmar/finalizar.

Ponto de insercao fechado para nova pergunta de porte:
- entre `handleAskDestination` e `handleAskCargo`.

### 2) Mensagem de grupo e sorteio tokenized

- arquivo: `C:\sitechatbot\lib\pedidosStore.js`
- funcoes/constantes auditadas:
  - `buildMensagemMotoristaTokenized`
  - `TOKENIZED_WINDOW_LABEL`
  - `joinLeadLottery`
  - `pickWinnerForTokenTx`
  - `closeLotteryTokenTx`
  - `finalizeExpiredLeadLotteries`
  - `getLeadLotteryOutcome`

Decisao funcional consolidada:
- mensagem tokenized deve explicitar:
  - "o sorteio encerra 3 minutos apos o primeiro motorista entrar".

### 3) Financeiro/ledger/contestado

- arquivo: `C:\sitechatbot\convenientetecnologia\lib\ctLeadLedgerStore.js`
- funcoes/itens auditados:
  - `awardLead`
  - `excludeInvoiceWithLeads`
  - `editInvoiceLeadsAndReissue`
  - indice de unicidade `ux_ct_driver_lead_ledger_award_token`
  - tipo `lead_contested_exclusion`

Regra atomica consolidada:
- estorno sempre total e somente do `lead_token` contestado aprovado.

### 4) Operacao CT/autenticacao/auditoria

- arquivos:
  - `C:\sitechatbot\convenientetecnologia\index.js`
  - `C:\sitechatbot\convenientetecnologia\lib\ctAuth.js`
  - `C:\sitechatbot\convenientetecnologia\public\ct.js`
  - `C:\sitechatbot\convenientetecnologia\public\app.html`

Constatacoes:
- modelo de acesso atual e' autenticacao por sessao (`requireAuthApi`/`requireAuthPage`);
- padrao de ator ja existe em varios endpoints via `req.ctUser.username`;
- suporte a permissao ampla (qualquer usuario autenticado) e compativel com decisao do owner.

---

## Evidencias objetivas coletadas nesta auditoria

### A) Stress de sorteio isolado (sem tocar producao real)

- comando executado: `node tools/stress_lottery_atomic.js` (db temporario isolado)
- resultado:
  - `ok: true`
  - `totalLeads: 40`
  - `totalWinnersPersisted: 40`
  - `failures: 0`
- evidencia:
  - `C:\sitechatbot\dados\forensics\stress_lottery_report_1771790753573.json`

### B) Sanidade de consistencia em base atual

Metrica coletada (7 dias e integridade):
- `windows7d: 50`
- `winners7d: 50`
- `awards7d: 30`
- `contested7d: 0`
- `awardDup: 0`
- `winnerNotParticipant: 5`

Analise da anomalia `winnerNotParticipant`:
- os 5 casos sao tokens de baseline/forense (`EQL_*`) com `close_reason`:
  - `baseline_equalize`
  - `baseline_equalize_final`
- checagem adicional:
  - `winnerNotParticipantNonEql: 0`

Conclusao:
- nao ha mismatch nos leads operacionais nao-baseline.

---

## Invariantes pre-codigo aprovados

1) Chave canonica de contestacao/estorno: `lead_token`.

2) Financeiro por lead:
- maximo 1 `lead_award` valido por par logico (`driver_id`, `lead_token`);
- maximo 1 estorno de contestacao aprovada por `lead_token`.

3) Estorno:
- integral e somente do lead contestado;
- proibido efeito colateral em outros leads do mesmo motorista.

4) Idempotencia:
- retry da mesma operacao nao cria estorno duplicado.

5) Atomicidade:
- decisao + estorno + estado do lead em all-or-nothing por lead.

6) Reentrada:
- motorista contestante nao pode reentrar no mesmo `lead_token`.

7) Operacao CT:
- item de contestacao nao pode sumir por timeout;
- estados rastreaveis (`open`, `in_contact`, `approved`, `rejected`, `blocked`);
- auditoria com `actor_user_id` e `requestId`.

---

## Lacunas tecnicas mapeadas antes de codar

1) Nao existe funcao dedicada para estorno por `lead_token` atomico com bloqueio de reentrada no mesmo fluxo.

2) Nao existe tabela/estrutura canonica de contestacao com estado operacional e timeline de decisoes.

3) Nao existe area CT dedicada "Motoristas WhatsApp" com fila unificada de atendimento/contestacao.

4) Nao existe ainda regra implementada de republicacao/devolucao ao grupo apos contestacao aprovada (com elegibilidade tecnica).

---

## Gate de pronto para implementacao

- [x] Escopo funcional fechado em INCs.
- [x] Regras financeiras atomicas por lead fechadas.
- [x] Permissao e SLA operacional CT fechados.
- [x] Evidencia tecnica de sorteio atomico (stress isolado) coletada.
- [x] Mismatch operacional relevante descartado (apenas tokens baseline/forense).
- [x] Backlog acoplado mapeado (bloquear/desbloquear manual no cadastro).

Status final do gate:
- `READY_TO_IMPLEMENT_PHASED`

---

## Ordem de implementacao recomendada (sem executar nesta auditoria)

1. fluxo WhatsApp: inserir pergunta de porte e persistir no payload;
2. mensagem de grupo: exibir porte + copy correta da janela tokenized;
3. motor de contestacao por `lead_token` (6h, motivos, limites, anti-abuso);
4. estorno total atomico por lead + bloqueio de reentrada;
5. devolucao ao grupo quando elegivel;
6. CT Motoristas WhatsApp + fila de contestacoes com auditoria forte.

