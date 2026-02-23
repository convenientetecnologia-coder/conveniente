# PLANO TECNICO FORMAL V1 - Contestacao (P0 -> P1 -> P2)

- data: 2026-02-20
- status: pre_codigo_formal_locked
- escopo: cliente -> grupo -> sorteio -> vencedor -> cobranca -> contestacao
- base funcional: `playbook_operacional_contestacao_v2_1.md`

---

## Objetivo de negocio (o que realmente importa)

1) Cobrar corretamente leads validos (sem perda de receita por falha de fluxo).  
2) Estornar corretamente leads lixo comprovados (sem injustica com motorista honesto).  
3) Evitar guerra operacional (loop de reenvio/contestacao).  
4) Garantir trilha auditavel ponta a ponta para decisao financeira.

---

## Regra de ouro operacional

- M1 (cliente nao respondeu) nunca encerra antes de 23h.
- Toda acao deve estar vinculada a um atendimento unico (ID tecnico).
- Sem ID unico por atendimento, nao executa automacao.

---

## FASE P0 - Contencao e Fundacao (bloqueia inicio da implementacao)

### P0.1 Neutralizacao de risco de rascunho
- [x] Remover artefato de contestacao nao integrado que pode induzir erro.
- Evidencia:
  - removido: `C:\sitechatbot\convenientetecnologia\lib\ctLeadContestationStore.js`

### P0.2 Contrato canonico de dados e estados
- [ ] Definir contrato tecnico unico para atendimento:
  - `case_id` (ou `lead_token` + versao de ciclo),
  - `driver_phone_digits`,
  - `customer_phone_digits`,
  - `contest_reason`,
  - `contest_status`,
  - `client_validation_status`,
  - `reopen_count`.
- [ ] Definir maquina de estados canonical:
  - `open` -> `driver_followup` -> `contest_provisional` -> `manual_queue|approved|rejected` -> `closed`.

### P0.3 Schema minimo obrigatorio
- [ ] `contestation_cases`
- [ ] `contestation_events` (audit trail)
- [ ] `reopen_count` com trava de maximo 1 automatico
- [ ] indices de idempotencia (`requestId`, `case_id`, chave financeira)

### Gate de aceite P0
- [ ] Documento de contrato assinado (sem ambiguidade)
- [ ] Estados fechados
- [ ] Schema aprovado
- [ ] Sem artefatos rascunho ativos

---

## FASE P1 - Integridade financeira e operacional (alto impacto)

### P1.1 Idempotencia envio + ACK
- [ ] Endurecer envio/ack por `jobId` para impedir duplicidade em falha de rede.
- Alvos:
  - `C:\sitechatbot\notificador\index.js`
  - `C:\sitechatbot\lib\pedidosStore.js`

### P1.2 Ownership de lock no ACK
- [ ] `ack()` deve validar ownership (`locked_by == workerId`) antes de fechar status.
- Alvo:
  - `C:\sitechatbot\lib\pedidosStore.js`

### P1.3 Normalizacao unica de telefone
- [ ] Consolidar helper unico compartilhado (flow, sorteio, ledger, CT).
- Alvos:
  - `C:\sitechatbot\whatsapp\lib\flow.js`
  - `C:\sitechatbot\lib\pedidosStore.js`
  - `C:\sitechatbot\convenientetecnologia\lib\ctLeadLedgerStore.js`

### P1.4 Reconciliacao winner vs ledger
- [ ] Job de reconciliacao para detectar:
  - winner sem debito,
  - debito sem winner,
  - divergencia de telefone/case.
- Alvos:
  - `C:\sitechatbot\whatsapp\lib\timeouts.js`
  - `C:\sitechatbot\convenientetecnologia\lib\ctLeadLedgerStore.js`

### Gate de aceite P1
- [ ] Nenhuma duplicidade em teste de falha de ACK
- [ ] Nenhum fechamento de ACK sem ownership correto
- [ ] Telefone normalizado consistente ponta a ponta
- [ ] Relatorio de reconciliacao limpo nos cenarios de teste

---

## FASE P2 - Escala 500-600 pedidos/dia

### P2.1 Cadencia operacional codificada
- [ ] T+15 (motorista), T+3h (cliente), T+23h (fechamento M1)
- [ ] no maximo 1 lembrete adicional cliente entre T+3h e T+23h
- Alvos:
  - `C:\sitechatbot\whatsapp\lib\timeouts.js`
  - `C:\sitechatbot\whatsapp\lib\flow.js`

### P2.2 Reabertura controlada (max 1)
- [ ] Trava de `reopen_count <= 1` em automacao
- [ ] Segunda tentativa sempre manual
- Alvo:
  - `C:\sitechatbot\lib\pedidosStore.js`

### P2.3 Observabilidade e runbook
- [ ] Metricas:
  - taxa contestacao por motivo
  - estorno aprovado/rejeitado
  - tempo de resolucao
  - taxa de reabertura
  - inconsistencias winner/ledger
- [ ] Runbook de incidente operacional

### Gate de aceite P2
- [ ] Stress 500-600/dia sem perda de consistencia
- [ ] Sem loop de reenvio
- [ ] Sem estorno duplicado
- [ ] Sem cobranca indevida no dataset de simulacao

---

## Ordem executavel (sem desvio)

1. Fechar P0 completamente.  
2. Implementar P1 com testes de falha/retry.  
3. Implementar P2 com simulacao pesada.  
4. So depois rollout controlado.

---

## Criterio de "pode deployar"

- P0/P1/P2 aprovados com evidencia.  
- Checkups e INC sincronizados.  
- Sem item critico aberto.

---

## Frase de controle

"Sem idempotencia, sem ownership de lock, sem reconciliacao e sem cadencia validada, nao sobe para producao."

