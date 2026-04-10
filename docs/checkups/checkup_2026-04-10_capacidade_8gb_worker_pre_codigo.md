# Checkup — Capacidade 8GB/worker (pré-código)

Data: `2026-04-10`  
INC: `docs/inbox/in_progress/INC-20260410-1930-01.md`  
Escopo: auditoria ponta a ponta para migrar de `1 worker/16GB` para `1 worker/8GB`, mantendo `15 contas/8GB`.

## 1) Estado atual encontrado no código

## 1.1 Política de capacidade

- `scripts/ramPolicy.js`
  - `calcNodesByTotalMemMB(totalMB)` usa `Math.ceil(gb / 16)`.
- `scripts/memoryPlan.js`
  - `NODE_SEG_MB = 16384`.
  - `MAX_PER_NODE = 30`.

Conclusão: o cálculo base de shard/capacidade está acoplado à segmentação de 16GB.

## 1.2 Runtime de shards

- `scripts/worker.js`
  - shard operacional por `SHARD_PROFILES`/`SHARD_SET`.
  - handler `set-shard` com airbag (`MAX_SHARD_MOVE_DEACTIVATIONS`) já reduz risco de storm em redistribuição.

Conclusão: o runtime já suporta redistribuição de perfis por shard, o que favorece a mudança de topologia.

## 1.3 Agregação e visibilidade por node

- `scripts/dashboard.js`
  - `readAggregatedStatus()` lê `status_node_*.json` por regex.
  - `logsAllowlist()` mantém entradas estáticas até `status_node_6`.

Conclusão: para hosts maiores, a allowlist estática pode limitar observabilidade se o número de nodes crescer além de 6.

## 2) Mudanças mínimas necessárias (proposta de implementação)

1. `scripts/ramPolicy.js`
   - alterar heurística para `Math.ceil(gb / 8)`.
2. `scripts/memoryPlan.js`
   - `NODE_SEG_MB: 8192`.
   - `MAX_PER_NODE: 15`.
   - manter travas de segurança atuais de memória livre e overhead.
3. `scripts/dashboard.js`
   - remover limitação rígida de `status_node_1..6` na allowlist, tornando compatível com N nodes.
4. documentação
   - atualizar `RUNBOOK_TECNICO.md`, `TIMELINE.md`, e este dossiê com rollback explícito.

## 3) Riscos e mitigação

- Risco A: mais processos/workers elevarem overhead fixo.
  - Mitigação: canário em 1 host e medição comparativa 24-48h.
- Risco B: redistribuição de shard gerar churn de ativação.
  - Mitigação: aplicar ajuste com janela de baixa pressão e airbag de deativação já existente.
- Risco C: observabilidade parcial por limite de logs/status por node.
  - Mitigação: corrigir allowlist antes do rollout amplo.

## 4) Plano de validação (canário)

- Alvo inicial: 1 host de 16GB.
- Antes: baseline de 24h (com configuração atual).
- Depois: 24h-48h com `2 workers x 15 contas`.
- Evidências mínimas:
  - estabilidade de `active/trabalhando/virtusOnline`;
  - redução de churn de recovery (deactivate/activate/reopen inesperado);
  - sem aumento de incidentes de provisão/ACK.

## 5) Critério Go/Caution/Stop

- Go:
  - estabilidade igual ou melhor vs baseline;
  - sem regressão de provisão/consistência.
- Caution:
  - melhora parcial com custo de overhead visível, sem incidentes críticos.
- Stop:
  - aumento de churn, erros de shard, ou regressão operacional.

## 6) Rollback canônico

- voltar segmentação para `16GB/worker` e `30 contas/worker`;
- aplicar `self_update`;
- reiniciar `conveniente` no host alvo (`node index.js`);
- validar retorno aos indicadores de baseline.

## 7) Conclusão da auditoria pré-código

A mudança é tecnicamente viável e coerente com o runtime atual.  
Para ficar enterprise e seguro, precisa entrar com pacote mínimo completo (`ramPolicy` + `memoryPlan` + observabilidade de node no `dashboard`) e canário controlado antes de expansão.

## 8) Atualização de execução (2026-04-10)

Pacote mínimo foi aplicado:

- `scripts/ramPolicy.js`: `16GB -> 8GB` por node na heurística.
- `scripts/memoryPlan.js`: `NODE_SEG_MB=8192`, `MAX_PER_NODE=15`.
- `scripts/dashboard.js`: allowlist dinâmica de `status_node_N` (default `1..16`).

Validação sintática executada com sucesso:

- `node --check scripts/ramPolicy.js`
- `node --check scripts/memoryPlan.js`
- `node --check scripts/dashboard.js`
