### Checkup — Go/No-Go final para piloto de 5 grupos

#### Contexto

- Data: 2026-02-20
- Ambiente: produção real (validação em base forense isolada)
- Hosts envolvidos (hostId/hostname): n/a (rodadas locais de validação)
- Sintoma: necessidade de fechar decisão formal para migração controlada de grupos ao novo fluxo
- Impacto: sem decisão formal, há risco de ativar piloto sem rastreabilidade objetiva

---

### Evidências coletadas (objetivas)

- Stress e drills aprovados:
  - `C:\sitechatbot\dados\forensics\stress_phase4_enterprise_1771624051549.json`
  - `C:\sitechatbot\dados\forensics\stress_lottery_report_1771624251610.json`
  - `C:\sitechatbot\dados\forensics\ct_stress_billing_atomic_1771624251435.sqlite`
  - `C:\sitechatbot\dados\forensics\ct_poll_reconcile_1771623887927.sqlite`
  - `C:\sitechatbot\dados\forensics\ct_ops_health_1771623930026.sqlite`
  - `C:\sitechatbot\dados\forensics\pedidos_ops_health_1771623930026.sqlite`
- Scripts utilizados:
  - `C:\sitechatbot\tools\stress_phase4_enterprise.js`
  - `C:\sitechatbot\tools\stress_lottery_atomic.js`
  - `C:\sitechatbot\tools\stress_billing_enterprise_atomic.js`
  - `C:\sitechatbot\tools\validate_asaas_webhook_auto_settlement.js`
  - `C:\sitechatbot\tools\simulate_asaas_invoice_lifecycle.js`
  - `C:\sitechatbot\tools\validate_ops_health_alerts.js`

---

### Achados (P0/P1/P2)

- **P0**:
  - Sorteio sob alta carga sem falhas na rodada final (`failures=0` na carga de 1200 leads).
  - Baixa automática por webhook idempotente aprovada.
  - Reconciliação por poll em cenário de webhook atrasado aprovada.
  - Reemissão com ajuste aprovada sem inconsistência de saldo/fatura.
  - Bloqueio por dívida e desbloqueio por pagamento validados em simulação controlada.
  - Motorista sem cadastro não participa e recebe orientação de administrativo (validado em teste real controlado).
- **P1**:
  - `validate_ops_health_alerts.js` precisou ajuste para regra diária idempotente (feito).
  - Falta somente confirmar os 5 grupos/cidades de migração para habilitação controlada.
- **P2**:
  - Opcional pós-ativação: repetir amostragem semanal de stress forense para monitoramento contínuo.

---

### Decisão / Ação recomendada (cirúrgica)

- O que mudar:
  - Avançar para piloto controlado com exatamente 5 grupos (por cidade/grupoId).
- Por quê:
  - Todos os critérios técnicos P0 desta fase fecharam em `PASS` com evidência objetiva.
- Risco:
  - Risco residual operacional de rollout humano (grupo errado/flag errada) se não houver conferência dupla antes de ativar.
- Rollback:
  - Reverter imediatamente os 5 grupos para fluxo legado (flags de grupo OFF) e manter restante da operação inalterado.

---

### Plano de rollout

- Reinícios necessários (quais processos/nodes):
  - Em princípio, nenhum reinício apenas para cadastro de grupos/flags.
  - Se houver alteração de código adicional, reiniciar `sitechatbot` com `node index.js`.
- Ordem:
- 1) Confirmar os 5 grupos/cidades e seus `groupId` no `notificador`.
  - 2) Validar mapeamento e preparar ativação controlada.
  - 3) Ativar novo fluxo apenas nesses 5 grupos.
  - 4) Monitorar primeira janela completa (sorteio + cobrança + baixa).
- Validação pós-rollout (checks):
  - nenhum grupo fora da lista recebe fluxo novo;
  - participação/sorteio normal nos 5 grupos;
  - bloqueio/desbloqueio financeiro consistente;
  - sem duplicidade financeira na baixa.

---

### Status final

- **GO CONDICIONAL APROVADO**.
- Pendência única para executar o piloto: **confirmar os `groupId` dos 5 grupos** (Ipatinga, Montes Claros, Foz do Iguaçu, Fortaleza, Petrolina).
