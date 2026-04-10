# Checkup 2026-04-10 — Auditoria P1 ponta a ponta (Virtus, CDP, ACK/sync)

## Escopo

Auditoria pré-código para três frentes prioritárias:

- P1-A: `Virtus` RAM cleaner real por swap controlado de aba.
- P1-B: orçamento global para operações CDP pesadas.
- P1-C: robustez de ACK/sincronização entre `sitechatbot` e `conveniente`.

## Mapa de código auditado

### P1-A — Virtus RAM cleaner
- `C:\conveniente\scripts\virtus.js`
  - `startVirtus()`
  - `ensurePage()`
  - `filaManagerLoop()`
  - `tryAcquireGlobalRecycle()`
  - `canRunHeavyAction()`
  - `getIdleMode()`
- `C:\conveniente\scripts\worker.js`
  - `closeExtraPages()`
  - `maybeStartPruneLoop()`
  - `stopPruneLoop()`
  - integração de `installOneTabGuard`

### P1-B — CDP pesado
- `C:\conveniente\scripts\worker.js`
  - `readIOStreamChunks()`
  - `collectChromePidsViaTracing()`
  - `getControllerPidsCached()`
  - `ramCpuMonitorTick()`

### P1-C — ACK e sincronização
- `C:\sitechatbot\index.js`
  - `enqueueCommand()`
  - `pullCommandsForHost()`
  - `app.post('/api/commands/ack')`
  - `expireStaleStockProvisionInflightNoAck()`
  - `stockSchedulerTick()`
- `C:\conveniente\scripts\dashboard.js`
  - `execStockProvision()`
  - `sendAckOnce()`
  - `flushPendingAcks()`
  - `ackCommand()`
  - `applyCommands()`

## Conclusão forense por frente

## P1-A (Virtus)

Estado atual:
- recycle já existe, mas majoritariamente por navegação na mesma aba (`p.goto(...)`), não por troca de aba.
- `ensurePage()` ainda tende a usar `pages[0]` e a fechar extras fora de exceções.
- pruner do worker roda em paralelo (`maybeStartPruneLoop`) e pode conflitar com uma futura janela temporária de 2 abas.

Risco principal:
- implementar swap sem coordenação explícita com pruner/one-tab guard pode gerar fecha-errado ou troca instável.

Diretriz técnica:
- swap apenas em `idleSafe`.
- preservar locks (`sendLock`, `chatLock`, `isVirtusLocked`) e contextos protegidos (`humanControl`, `robe`, `configurando`).
- fallback automático para recycle atual se swap falhar.

## P1-B (CDP)

Estado atual:
- núcleo pesado está concentrado em `collectChromePidsViaTracing()` + `readIOStreamChunks()`.
- há controle por tick/cache, mas não um orçamento global único por janela/host.

Risco principal:
- em carga, operações de tracing podem competir com outras ações CDP e aumentar latência/instabilidade.

Diretriz técnica:
- budget global por janela com limite, gap mínimo e backoff.
- quando orçamento negar tracing, degradar para caminho leve (cache/root pid) sem travar monitor.

## P1-C (ACK/sync)

Estado atual:
- fluxo já possui inflight, idempotência por `ack_<cmdId>.json` e sweep de timeout.
- `sendAckOnce` direto usa timeout curto (3s) e fallback para `acks_pending`.

Risco principal:
- descompasso entre orçamento de provision (`STOCK_PROVISION_BUDGET_MS`) e timeout inflight no CT (`CT_STOCK_PROVISION_ACK_TIMEOUT_MS`) pode liberar reserva antes da conclusão real.

Diretriz técnica:
- alinhar contrato temporal CT↔host.
- fortalecer drenagem de `acks_pending` e observabilidade de ACK.

## Sequência recomendada para implementação (quando aprovada)

1. P1-A (Virtus swap) — menor blast radius, impacto direto em RAM por sessão.
2. P1-B (CDP budget) — reduz pressão estrutural de monitoramento/protocolo.
3. P1-C (ACK/sync) — endurece consistência operacional e reduz ruído de fila.

## Critérios de aceite (canário unificado)

Go:
- queda do slope de RAM por perfil/host em janela comparável.
- manutenção ou melhora de taxa de envio do Virtus.
- redução de eventos de timeout/abort falsos de `stock_provision`.

Caution:
- melhora parcial sem regressão grave; manter canário e ajustar thresholds.

Stop:
- aumento relevante de falha de envio, duplicidade de execução, ou crescimento de timeout de ACK.

## Rollback canônico por frente

- P1-A: kill-switch por env da estratégia de swap; volta ao recycle atual.
- P1-B: kill-switch do budget CDP pesado; volta ao comportamento atual de tracing/tick.
- P1-C: rollback de política de timeout/ACK para valores anteriores e reprocesso normal da fila.

## Processos para restart (na fase de implementação)

- `conveniente`: para P1-A e P1-B.
- `sitechatbot` e `conveniente`: para P1-C.

Nesta fase (auditoria): nenhum restart necessário.
