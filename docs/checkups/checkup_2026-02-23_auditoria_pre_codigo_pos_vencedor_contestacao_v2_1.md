# CHECKUP — Auditoria pré‑código (pós‑vencedor) — Contestação V2.1

- Data: 2026-02-23
- Escopo: `INC-20260222-2310-01` (Contestação V2.1) + integração com core tokenized já em produção (sorteio/ledger/cobrança)
- Objetivo: congelar **baseline real do runtime atual** + mapear **pontos exatos de código** + listar **gaps P0/P1/P2** + definir **simulação pesada P2** (500–600/dia) com evidência por arquivo e com deadline (anti-trava).
- Regra: **não codifica** neste checkup; é relatório pré‑implementação.

---

### Contexto

Hoje o core tokenized está validado (pedido anônimo → grupo → sorteio → vencedor → ledger → cobrança/bloqueio).  
O problema atual é o “pós‑vencedor”: depois que o motorista ganha e chama o cliente, precisamos de um motor de fluxo **auditável e controlado** para:

- guiar motorista/cliente sem “perder lead quente” e sem “cobrar lead frio”;
- permitir contestação com regras V2.1 congeladas (janela até 23h, M1..M4, validação Virtus, reabertura máx 1, estorno total idempotente/atômico);
- garantir trilha de auditoria ponta a ponta (driver_id, phone_digits, lead_token, motivo, decisão, actor_user_id, requestId, timestamp).

---

### Evidências coletadas (objetivas)

#### Baseline runtime atual (pós‑vencedor hoje)

- **Encerramento de janela + notificação do vencedor + débito do lead** (idempotente por `lead_token`):
  - `C:\sitechatbot\whatsapp\lib\timeouts.js`
    - `processClosedLeadLotteries(...)`
    - `registerWinnerLedger(outcome, now)` → `ctLeadLedgerStore.awardLead(...)`
    - `buildWinnerText(outcome)` (mensagem ao motorista)
- **Entrada do motorista no sorteio pelo número operacional**:
  - `C:\sitechatbot\whatsapp\lib\flow.js`
    - `extractLeadTokenFromMessage(...)`
    - `handleInbound(...)` branch quando `wa_phone_number_id == WA_DRIVER_OPERATION_PHONE_NUMBER_ID`
    - valida elegibilidade via `ctLeadLedgerStore.checkDriverEligibilityByPhone(...)`
    - entra na janela via `pedidosStore.joinLeadLottery(...)`

Conclusão objetiva do baseline: **pós‑vencedor hoje = 1 mensagem de “Parabéns + telefone/link” + débito do lead**.  
Não existe ainda o motor guiado **T+15 / T+3h / T+23h** rodando em runtime.

#### Base técnica já existente para contestação (schema + contrato)

- Contrato (motivos/status/janela):
  - `C:\sitechatbot\convenientetecnologia\lib\ctContestationContract.js`
- Schema canônico (lead contestation):
  - `C:\sitechatbot\convenientetecnologia\lib\ctDb.js`
    - `migrateLeadContestationV21(dbi)` cria:
      - `ct_lead_contestation_cases`
      - `ct_lead_contestation_events`
      - índices por `lead_token`/`cycle_no` e followups (`followup_t15_at`, `followup_t3h_at`, `close_t23h_at`)
    - também cria base antiga paralela:
      - `ct_contestation_cases`
      - `ct_contestation_events`
- Prova automática de schema V2.1 (offline/forense):
  - `C:\sitechatbot\tools\validate_contestation_schema_v21.js`

#### Base técnica já existente para estorno/compensação no ledger (primitivas)

- `C:\sitechatbot\convenientetecnologia\lib\ctLeadLedgerStore.js`
  - existe `entry_type='lead_contested_exclusion'` (lançamento negativo) em fluxos de edição/cancelamento;
  - existe índice idempotente para fonte do estorno:
    - `ux_ct_driver_lead_ledger_contest_source` (único por `contest_source_entry_id`).

---

### Auditoria ponta a ponta (função‑a‑função) — baseline e “onde vai encaixar”

#### A) Pedido → grupo (já OK)

- Builder do texto do pedido (inclui Porte e janela tokenized):
  - `C:\sitechatbot\lib\pedidosStore.js`
    - `buildMensagemMotorista(...)`
    - `buildMensagemMotoristaTokenized(...)`
    - `buildMensagemByMode(...)`

#### B) Sorteio → winner (já OK)

- Janela / determinismo / persistência:
  - `C:\sitechatbot\lib\pedidosStore.js`
    - `joinLeadLottery(...)`
    - `finalizeExpiredLeadLotteries(...)`
    - `pickWinnerForTokenTx(...)`
    - `getLeadLotteryOutcome(...)`

#### C) Pós‑vencedor (hoje) — onde está e o que falta

**Hoje:**
- `C:\sitechatbot\whatsapp\lib\timeouts.js`
  - fecha janela
  - avisa vencedor (texto)
  - registra débito no ledger (`awardLead`) idempotente por `lead_token`

**Faltante (V2.1):**
- motor de followup e contestação:
  - T+15 (motorista)
  - T+3h (cliente via Virtus) [M1/M2/M3]
  - T+23h (fechamento M1)
- reabertura controlada no grupo (máx 1) e bloqueio de reentrada do contestante
- decisão/estorno atômico e idempotente por `lead_token` (não por “telefone solto”)
- fila manual CT para M4 (UI + endpoints + auditoria com `actor_user_id`)

#### D) Entrada operacional do motorista (número operacional) — ponto de encaixe do novo fluxo

- `C:\sitechatbot\whatsapp\lib\flow.js`
  - branch do número operacional já existe para:
    - pagamento (pix/boleto/financeiro/administrativo)
    - entrada no sorteio via `leadToken`

**Ponto de encaixe recomendado:** o mesmo branch (número operacional) deve também:
- reconhecer “ações de followup/contestar” do motorista (por `interactive_id`/IDs técnicos, nunca por texto);
- correlacionar a ação ao atendimento (`case_key`/`lead_token` + `cycle_no`) e escrever em `ct_lead_contestation_events`.

---

### Achados (P0/P1/P2) — sem achismo

#### **P0 (bloqueia início de código)**

1) **Duplicidade de schema de contestação no CT (`ct_contestation_*` vs `ct_lead_contestation_*`)**
- Evidência: `C:\sitechatbot\convenientetecnologia\lib\ctDb.js` cria ambos.
- Risco: GPT futuro implementar em tabela errada; auditoria ficar fragmentada.
- Ação pré‑código: escolher **uma** base canônica para runtime (recomendação: `ct_lead_contestation_*`, pois já está alinhada a `lead_token + cycle_no` e já tem `followup_t15_at/t3h/t23h`).

2) **Inconsistência potencial de strings de status entre contrato e schema**
- Evidência:
  - contrato: `ctContestationContract.js` (`CASE_STATUS`, `CLIENT_VALIDATION_STATUS`)
  - schema: comentários/valores em `ctDb.js` (`ct_lead_contestation_cases` e `ct_contestation_cases`)
- Risco: estados “parecem iguais”, mas viram bugs silenciosos.
- Ação pré‑código: congelar o dicionário final (status/reason_code/client_validation_status) no dossiê e só então codar.

3) **Baseline pós‑vencedor não tem motor guiado**
- Evidência: ausência de copy T+15/T+3h/T+23h em runtime; baseline está em `timeouts.js` com 1 mensagem + débito.
- Impacto: motorista “fica sem o que fazer” e o sistema não conduz exceções.

#### **P1 (integridade e idempotência de decisões financeiras/estado)**

- Precisamos de uma operação dedicada de “estorno/compensação” por atendimento, que:
  - referencie o débito original do mesmo `lead_token`;
  - use chave de idempotência (`request_id` + `contest_source_entry_id`) para impedir duplicação;
  - grave evento auditável e feche estado em all‑or‑nothing.

Observação: já existem primitivas (`lead_contested_exclusion` + índice único por `contest_source_entry_id`), mas falta o motor de decisão e a vinculação ao `case`.

#### **P2 (escala 500–600/dia + simulação pesada)**

Objetivo: provar com evidência objetiva, antes de tocar em grupos produtivos:
- cadência M1 (T+15/T+3h/T+23h) sem spam;
- validação Virtus (cliente) em M1/M2/M3;
- reabertura max 1 sem loop;
- idempotência sob retry/concorrência (cliques duplicados, rede, restart);
- estorno total somente do `lead_token` contestado.

---

### Plano de simulação pesada (P2) — desenho do artefato (pré‑código)

Regras (anti‑trava):
- **nunca** uma suíte única sem deadline; cada bloco gera **1 arquivo de evidência**.
- cada comando deve ter `timeoutMs/budgetMs` e produzir `ok=false` com diagnóstico em timeout.

#### Blocos recomendados (offline)

1) **Gerador de casos (500–600/dia)**
- Gera dataset determinístico (seed) de:
  - `lead_token`, `cycle_no`, `driver_id`, `customer_phone_digits` (sanitizado), timestamps
  - distribuição de motivos (M1..M4) e respostas do cliente

2) **Simulador de cadência**
- Simula relógio (T+15, T+3h, T+23h) e aplica regras V2.1:
  - M1 nunca fecha antes de 23h
  - entre T+3h e T+23h: no máx 1 lembrete ao cliente
  - reabertura max 1 por atendimento

3) **Simulador de retry/concorrência**
- Reaplica o mesmo evento (mesmo `request_id`) N vezes
- dispara eventos fora de ordem
- valida invariantes:
  - no máx 1 estorno por `lead_token`
  - contestante não reentra no mesmo `lead_token`/ciclo

#### Saída (evidência)

Para cada execução, gerar um relatório JSON em `C:\sitechatbot\dados\forensics\`:
- contagens por motivo/decisão
- contagens de reabertura
- contagens de estorno duplicado (esperado 0)
- exemplos de violações (primeiros 10)

---

### Decisão / Ação recomendada (cirúrgica)

- **O que mudar (quando iniciar implementação)**:
  - criar motor pós‑vencedor (scheduler + handlers) usando **IDs técnicos** e as tabelas canônicas;
  - adicionar endpoints CT para fila manual M4 + auditoria com `actor_user_id`;
  - implementar simulação P2 com evidência por arquivo antes de qualquer rollout.
- **Por quê**: hoje o sistema não guia exceções pós‑vencedor; isso aumenta perda de lead e injustiça financeira.
- **Risco**: regressão no core tokenized (hoje validado). Mitigar com flags e simulação offline primeiro.
- **Rollback**: flags OFF + rollback de runtime (git) + restart dos nodes afetados.

---

### Plano de rollout (quando houver código)

- **Reinícios necessários (provável)**:
  - `sitechatbot` (WhatsApp flow/timeouts + CT endpoints): `node index.js`
  - `notificador` (se reabertura automática envolver envio ao grupo pelo pipeline do notificador): `node index.js`
- **Validação pós‑rollout (checks)**:
  - nenhuma mensagem para grupos produtivos durante simulação
  - smoke test em ambiente controlado
  - evidência por `requestId`/`lead_token` em logs e no CT DB

