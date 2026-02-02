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
| INC-20260202-2000-01 | P0 | done | deployed | passed | CT: Fonte Única da Verdade (Virtus→Grupos / Contas FB v2 / Simulações) | `done/INC-20260202-2000-01.md` |
| INC-20260202-1600-01 | P0 | in_progress | not_deployed | not_run | Cidades/Grupos: contrato canônico + prioridade provisão (estoque→servidor) + migração manual | `in_progress/INC-20260202-1600-01.md` |
| INC-20260201-0300-01 | P0 | done | deployed_partial | passed | P0: total>ativos (browsers fechados) apesar de RAM; sistema deve manter tudo aberto | `done/INC-20260201-0300-01.md` |
| INC-20260201-0200-01 | P0 | in_progress | not_deployed | not_run | Forense RAM: RM4/RM5/RM6 (capacidade máxima), autoMode light/full e thresholds | `in_progress/INC-20260201-0200-01.md` |
| INC-20260201-0100-01 | P1 | done | needs_restart | not_run | CT/Servidores: contadores “Login/Cookies falhou” + “Recurso em análise” + ordenação OFFLINE primeiro | `done/INC-20260201-0100-01.md` |
| INC-20260201-0000-01 | P1 | done | deployed | passed | Groq config: garantir auto-download + auto-correção de modelo em TODOS os hosts após update/restart | `done/INC-20260201-0000-01.md` |
| INC-20260131-0000-01 | P1 | done | deployed | passed | Captcha/Identidade: pre-screen “Confirme que você é humano” + OCR Groq + identity/appeal handoff | `done/INC-20260131-0000-01.md` |
| INC-20260130-0905-01 | P0 | cancelled | not_deployed | not_run | CT marca RM3 OFFLINE mas host está acessível (Servidores + Estoque) | `cancelled/INC-20260130-0905-01.md` |
| INC-20260130-1521-01 | P0 | done | manual_step_required | not_run | CT/Servidores mostra “Desconhecido” e precisa virar fonte de verdade operacional (flags + estados acionáveis) | `done/INC-20260130-1521-01.md` |
| INC-20260130-1544-01 | P0 | done | deployed | passed | RM3: “trabalhando 0” no CT (urgente) | `done/INC-20260130-1544-01.md` |
| INC-20260130-2015-02 | P2 | done | deployed | passed | Abrir Todos deveria zerar flags para reavaliar estado real | `done/INC-20260130-2015-02.md` |
| INC-20260130-2015-03 | P2 | done | deployed | passed | HUD humano some ao navegar e demora a reaparecer | `done/INC-20260130-2015-03.md` |
| INC-20260130-2235-04 | P1 | done | deployed | passed | “Confirme que você é humano” precisa auto-click | `done/INC-20260130-2235-04.md` |
| INC-20260130-0128-01 | P0 | done | deployed | passed | Abrir Todos não iniciava com 0 browsers (nurseTick early-return) | `done/INC-20260130-0128-01.md` |
| INC-20260130-0001-01 | P0 | done | not_deployed | not_run | Abrir Todos: 2º clique dava open_all_lock_busy (lock idempotência) | `done/INC-20260130-0001-01.md` |
| INC-20260129-2100-01 | P1 | done | deployed_partial | not_run | Estoque: “reserved mas não vai” (provision / stock_provision) | `done/INC-20260129-2100-01.md` |
| INC-20260129-2058-02 | P0 | done | needs_restart | not_run | Fechar Todos: reabre durante fechamento; lento; sobra navegador | `done/INC-20260129-2058-02.md` |
| INC-20260129-2058-03 | P1 | done | needs_restart | not_run | Abrir Todos 24h: concorrência/medo de clicar; auto-open no boot | `done/INC-20260129-2058-03.md` |
| INC-20260129-2058-04 | P1 | done | needs_restart | not_run | Governança: controle de concorrência (login_required/identity/open/ram) | `done/INC-20260129-2058-04.md` |
| INC-20260129-2340-01 | P1 | done | needs_restart | not_run | Abrir Todos: fica preso em 26/28; sem progresso; não libera Robe/Virtus | `done/INC-20260129-2340-01.md` |
| INC-20260130-0005-01 | P1 | done | needs_restart | not_run | Invocar Humano: botões no HUD (fechar/pause24h/excluir) + garantir isolamento do navegador humano | `done/INC-20260130-0005-01.md` |
| INC-20260130-0023-01 | P0 | done | needs_restart | not_run | RM3: estoque liberou conta, mas cadastro/provision falhou | `done/INC-20260130-0023-01.md` |
| INC-20260130-0047-01 | P1 | done | not_applicable | not_applicable | RM4: entender “modo leve/full” (slowmode) — regras/motivos/mecanismos/impactos | `done/INC-20260130-0047-01.md` |
| INC-20260130-0103-01 | P0 | done | needs_restart | not_run | CT estoque/servidores “liberar” solta cooldown do Robe em massa + RM3 não cadastra | `done/INC-20260130-0103-01.md` |
| INC-20260130-0148-01 | P1 | done | needs_restart | not_run | Governor light/full: thresholds (RAM/lag), não pausar Robe, recuperação leve | `done/INC-20260130-0148-01.md` |
| INC-20260130-0205-01 | P0 | done | needs_restart | not_run | Governor light/full: janelas 5min/30min, sem fechar 1 navegador, hard reset total | `done/INC-20260130-0205-01.md` |
| INC-20260130-0227-01 | P0 | done | needs_restart | not_run | Crash no boot: `Illegal break statement` em `robeTickGlobal` | `done/INC-20260130-0227-01.md` |
| INC-20260130-0219-01 | P0 | done | deployed_partial | not_run | Governor light/full: somente RAM + snapshot 1/min por 48h | `done/INC-20260130-0219-01.md` |

