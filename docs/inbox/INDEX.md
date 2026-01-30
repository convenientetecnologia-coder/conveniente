### INBOX — arquivo de relatos (índice)

Regra: `C:\conveniente\docs\INBOX_RELATOS_DO_HUMANO.md` é a **entrada** (RAW_INPUT + triagem).
Depois de triado, cada incidente ganha um arquivo próprio em uma pasta por status:

- `C:\conveniente\docs\inbox\in_progress\` (em andamento)
- `C:\conveniente\docs\inbox\done\` (concluído)
- `C:\conveniente\docs\inbox\cancelled\` (cancelado / não será feito)

Objetivo: manter um **banco de relatos** pesquisável, sem virar um “textão infinito” no arquivo de entrada.

---

## Incidentes (índice)

Regra: o status “de verdade” vive aqui **e** no topo do arquivo do INC.
Modelo “médico”: `state=done` não exige restart/teste; isso vai em `rollout/validation`.

| id | P | state | rollout | validation | título | arquivo |
|---|---|---|---|---|---|---|
| INC-20260130-0128-01 | P0 | done | deployed | passed | Abrir Todos não iniciava com 0 browsers (nurseTick early-return) | `done/INC-20260130-0128-01.md` |
| INC-20260130-0001-01 | P0 | done | not_deployed | not_run | Abrir Todos: 2º clique dava open_all_lock_busy (lock idempotência) | `done/INC-20260130-0001-01.md` |
| INC-20260129-2100-01 | P1 | done | deployed_partial | not_run | Estoque: “reserved mas não vai” (provision / stock_provision) | `done/INC-20260129-2100-01.md` |
| INC-20260129-2058-02 | P0 | done | needs_restart | not_run | Fechar Todos: reabre durante fechamento; lento; sobra navegador | `done/INC-20260129-2058-02.md` |
| INC-20260129-2058-03 | P1 | done | needs_restart | not_run | Abrir Todos 24h: concorrência/medo de clicar; auto-open no boot | `done/INC-20260129-2058-03.md` |
| INC-20260129-2058-04 | P1 | done | needs_restart | not_run | Governança: controle de concorrência (login_required/identity/open/ram) | `done/INC-20260129-2058-04.md` |
| INC-20260129-2340-01 | P1 | done | needs_restart | not_run | Abrir Todos: fica preso em 26/28; sem progresso; não libera Robe/Virtus | `done/INC-20260129-2340-01.md` |
| INC-20260130-0005-01 | P1 | done | needs_restart | not_run | Invocar Humano: botões no HUD (fechar/pause24h/excluir) + garantir isolamento do navegador humano | `done/INC-20260130-0005-01.md` |

