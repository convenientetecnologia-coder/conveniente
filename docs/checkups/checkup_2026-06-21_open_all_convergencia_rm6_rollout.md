# Checkup - Open all com convergencia (RM6)

## Objetivo

Validar por 2 ciclos noturnos que o `dailyWindowScheduler` nao registra mais sucesso falso no `open_all`, e preparar rollout gradual com rollback imediato.

## Mudanca aplicada

- Arquivo: `scripts/dailyWindowScheduler.js`
- O scheduler agora:
  - chama `POST /api/perfis/open-all-24h`;
  - aguarda convergencia real via `GET /api/status`;
  - considera sucesso apenas quando `active >= target` e (opcional) `trabalhando >= target`;
  - reexecuta `open-all-24h` com retry idempotente quando nao converge no timeout;
  - grava telemetria estruturada em `provision_audit`:
    - `daily_window_open_verify_attempt`
    - `daily_window_open` (com campos de convergencia).

## Feature flags (controle e rollback)

- `DAILY_WINDOW_OPEN_VERIFY_ENABLED=1` (default)
  - `1`: usa convergencia + retry (novo comportamento).
  - `0`: volta para comportamento antigo (rollback imediato).
- `DAILY_WINDOW_OPEN_REQUIRE_WORKING=1` (default)
  - `1`: exige `trabalhando` convergente.
  - `0`: exige apenas `active`.
- `DAILY_WINDOW_OPEN_VERIFY_TIMEOUT_MS=1800000` (default 30 min)
- `DAILY_WINDOW_OPEN_VERIFY_POLL_MS=5000` (default 5 s)
- `DAILY_WINDOW_OPEN_VERIFY_RETRY_MAX=2` (default 2 tentativas)

## Validacao RM6 (2 ciclos)

Executar por 2 madrugadas no RM6 e validar criterios abaixo:

1. Confirmar disparo:
   - existe `daily_window_open` no periodo da janela.
2. Confirmar convergencia:
   - para cada `daily_window_open` com `ok=true`, `active` e `working` iguais ao alvo.
3. Confirmar ausencia de gap sustentado:
   - zero casos de `activeCount > workingCount` por mais de 10 min apos `openAll.doneAt`.
4. Confirmar resiliencia:
   - sem necessidade de restart manual (`node index.js`) para completar a abertura.

## Rollout gradual

1. RM6 (canario): 2 ciclos completos.
2. Grupo 1: 2 hosts adicionais com perfil parecido de carga.
3. Grupo 2: metade restante dos hosts.
4. Grupo 3: todos os hosts.

Em cada grupo:
- monitorar `daily_window_open_verify_attempt` e `daily_window_open`;
- interromper avancos se houver falha repetida.

## Rollback

Rollback operacional imediato (sem migracao de dados):

1. Ajustar ambiente no host:
   - `DAILY_WINDOW_OPEN_VERIFY_ENABLED=0`
2. Reiniciar processo:
   - `node index.js`
3. Validar:
   - scheduler volta ao modo antigo (ack do `open-all-24h` sem espera de convergencia).
