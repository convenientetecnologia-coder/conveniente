# CHECKUP - Simulacao pesada offline (P0/P1)

- Data: 2026-02-20
- Escopo: validar resiliencia e integridade apos ajustes de base (ack lock ownership, idempotencia, migracao de contestacao, reconciliacao de sorteio/ledger).
- Ambiente: offline/local, sem envio para grupos produtivos.

## Bloco A - Stress de sorteio atomico

- Comando: `node tools/stress_lottery_atomic.js`
- Evidencia: `C:\sitechatbot\dados\forensics\stress_lottery_report_1771804238948.json`
- Resultado:
  - `closedWindowsReported`: 120
  - `totalLeads`: 120
  - `totalParticipantsPersisted`: 1891
  - `totalWinnersPersisted`: 120
  - `failures`: 0
- Status: PASS

## Bloco B - Saude operacional billing + lottery

- Comando: `node tools/validate_ops_health_alerts.js`
- Evidencias:
  - `C:\sitechatbot\dados\forensics\ct_ops_health_1771804238975.sqlite`
  - `C:\sitechatbot\dados\forensics\pedidos_ops_health_1771804238975.sqlite`
- Resultado:
  - `billing.ok`: true
  - `lottery.ok`: true
  - Sinais detectados no cenario sintetico:
    - `asaas_paid_without_local_settlement`: 1
    - `debt_without_open_invoice`: 1
    - `overdue_open_windows`: 1
- Interpretacao: detecao de anomalia funcionando como esperado (sem falso negativo no cenario montado).
- Status: PASS

## Bloco C - ACK lock ownership + idempotencia

- Comando (offline): simulacao de claim/ack com worker valido e invalido
- Evidencia DB: `C:\sitechatbot\dados\forensics\ack_lock_sim_1771804251391.sqlite`
- Resultado:
  - `ack` com worker errado: `lock_owner_mismatch` (esperado)
  - `ack` com worker correto: `ok: true` (esperado)
  - `ack` repetido apos envio: `alreadySent: true` (idempotencia esperada)
- Status: PASS

## Bloco D - Migracao schema contestacao V2.1 (base)

- Comando (offline): init CT DB isolado + inspecao de tabelas
- Evidencia DB: `C:\sitechatbot\dados\forensics\ctdb_contest_schema_check_1771804300755.sqlite`
- Tabelas encontradas:
  - `ct_lead_contestation_cases`
  - `ct_lead_contestation_events`
- Status: PASS

## Conclusao executiva

- Resultado geral: PASS
- Risco bloqueante identificado nesta etapa: nenhum.
- Gate recomendado: `READY_FOR_NEXT_PHASE_SIMULATION`
- Proximo passo recomendado:
  1. Simulacao de cadencia M1 em volume (T+15, T+3h, T+23h) com 500-600 pedidos/dia em lote sintetico.
  2. Gerar KPI final de taxa de estorno por motivo e taxa de reabertura (limite maximo 1 auto-reenvio).

