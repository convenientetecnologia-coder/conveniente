# Provisão (Estoque) — Ultra Enterprise (Impacto Mínimo)

## Objetivo
Garantir que `stock_provision` rode **24/7/365** com **impacto mínimo**:
- **Nunca** fechar dezenas de navegadores por “efeito colateral”.
- Pausar automações (Virtus/Robe) de forma controlada durante o pico de cookies.
- Se faltar RAM, fechar **somente o mínimo necessário** (preferindo ociosos / alto consumo).

## Política de RAM (canônica)
Implementada em `scripts/ramPolicy.js`.

- **Operação normal (sistema trabalhando):**
  - Reserva mínima livre: \(2GB\) + \(1GB\) por node
  - Nodes = `ceil(totalGB / 16GB)`
- **Durante provisão (pico de cookies):**
  - Reserva mínima livre: \(2GB\) + \(~1.5GB\) (pico cookies)
  - O \(1GB/node\) é **emprestável** durante provisão (Virtus/Robe ficam controlados).

Variáveis (opcionais):
- `HOST_BASE_MB` (default 2048)
- `PROVISION_SPIKE_MB` (default 1536)
- `SUP_MIN_FREE_RAM_MB` (override emergencial; default 0 = usa política)
- `OPEN_MIN_FREE_MB` (override emergencial; default 0 = usa política)

## Regras de `close_all`
`close_all` só pode existir quando **explicitamente humano** (UI / operador).  
Qualquer `close_all` “automático” (deploy/script) é **bloqueado** no `dashboard`.

Durante provisão (`provision_lock` ativo):
- `close_all` humano é **deferido** (executa depois que a provisão terminar).

## Onde fica cada coisa
- Headroom/política: `scripts/ramPolicy.js`
- Limites de abertura: `scripts/supervisor.js` + `scripts/worker.js`
- Execução do estoque: `scripts/dashboard.js` (`execStockProvision`)
- Nurse e swap mínimo: `scripts/worker.js` (`trySwapOpen` limitado)
- Pausa Virtus durante provisão: `scripts/worker.js` (`nurseTick` para Virtus)

## Logs/Diagnóstico (troubleshooting)
- `dados/updates.jsonl`: execuções `self_update`
- `dados/provision_lock.json`: lock global e owner/TTL
- `dados/commands.log` (sitechatbot): enqueues/acks remotos
- `dados/issues_fallback.log` (conveniente): trilha de ações e debounces

## Sinais de que a política está sendo respeitada
- Não ocorre “tempestade” de `swap_for_open`.
- Durante `stock_provision`:
  - Virtus é pausado em perfis ociosos (sem `_sendLock`).
  - Robe não inicia (já era bloqueado por `provisionLock`).
  - `hardRecoverRam` fecha no máximo `STOCK_PROVISION_MAX_HARD_DEACTIVATIONS` (default 4).

