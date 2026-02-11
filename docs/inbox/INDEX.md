### INBOX â€” arquivo de relatos (Ã­ndice)

Regra: `C:\conveniente\docs\INBOX_RELATOS_DO_HUMANO.md` Ã© a **entrada** (RAW_INPUT + triagem).
Depois de triado, cada incidente ganha um arquivo prÃ³prio em uma pasta por status:

- `C:\conveniente\docs\inbox\in_progress\` (em andamento / WIP)
- `C:\conveniente\docs\inbox\need_evidence\` (aguardando prÃ³xima rodada de evidÃªncia/decisÃ£o; nÃ£o Ã© WIP ativo)
- `C:\conveniente\docs\inbox\done\` (concluÃ­do)
- `C:\conveniente\docs\inbox\cancelled\` (cancelado / nÃ£o serÃ¡ feito)

Objetivo: manter um **banco de relatos** pesquisÃ¡vel, sem virar um â€œtextÃ£o infinitoâ€ no arquivo de entrada.

---

## Incidentes (Ã­ndice)

Regra: o status â€œde verdadeâ€ vive aqui **e** no topo do arquivo do INC.
Modelo â€œmÃ©dicoâ€: `state=done` nÃ£o exige restart/teste; isso vai em `rollout/validation`.

| id | P | state | rollout | validation | tÃ­tulo | arquivo |
|---|---|---|---|---|---|---|
| INC-20260202-2000-01 | P0 | done | deployed | passed | CT: Fonte Ãšnica da Verdade (Virtusâ†’Grupos / Contas FB v2 / SimulaÃ§Ãµes) | `done/INC-20260202-2000-01.md` |
| INC-20260204-0110-01 | P2 | done | deployed | passed | CT Chat: "Mais usados" no picker do composer | `done/INC-20260204-0110-01.md` |
| INC-20260204-0100-01 | P0 | done | deployed | passed | CT Chat: mensagens misturadas entre salas | `done/INC-20260204-0100-01.md` |
| INC-20260204-0120-01 | P2 | done | deployed | passed | CT Chat: "Ver mais" indent na 1a linha | `done/INC-20260204-0120-01.md` |
| INC-20260204-0130-01 | P1 | cancelled | not_deployed | not_run | CT UI: layout quebra com zoom (encerrado por decisao do humano) | `cancelled/INC-20260204-0130-01.md` |
| INC-20260204-0140-01 | P1 | need_evidence | not_deployed | not_run | CT Chat: mensagens demoram a chegar (latencia fim-a-fim) | `need_evidence/INC-20260204-0140-01.md` |
| INC-20260204-0141-01 | P2 | done | deployed | passed | CT Chat: ao abrir, ir para a mensagem mais antiga nao lida | `done/INC-20260204-0141-01.md` |
| INC-20260204-0142-01 | P1 | done | deployed | passed | CT Aprovados: notificação (novos) por usuário + som dedicado | `done/INC-20260204-0142-01.md` |
| INC-20260204-0143-01 | P1 | done | deployed | passed | CT Aprovados: latência realtime (badge/som) após "Enviar p/ financeiro" | `done/INC-20260204-0143-01.md` |
| INC-20260204-0144-01 | P1 | done | deployed | passed | CT Removidos: remover coluna “Motivo” e centralizar histórico no cadastro | `done/INC-20260204-0144-01.md` |
| INC-20260203-2580-01 | P2 | done | deployed | passed | CT Chat: composer nao sobrepor texto | `done/INC-20260203-2580-01.md` |
| INC-20260203-2570-01 | P2 | done | deployed | passed | CT Chat: pack de emojis padrao | `done/INC-20260203-2570-01.md` |
| INC-20260203-2560-01 | P2 | done | deployed | passed | CT Chat: layout do composer (input full + botoes dentro) | `done/INC-20260203-2560-01.md` |
| INC-20260203-2550-01 | P1 | done | deployed | passed | CT Chat: historico/paginacao (carregar antigas ao subir) | `done/INC-20260203-2550-01.md` |
| INC-20260202-1600-01 | P0 | done | deployed | passed | Cidades/Grupos: contrato canÃ´nico + prioridade provisÃ£o (estoqueâ†’servidor) + migraÃ§Ã£o manual | `done/INC-20260202-1600-01.md` |
| INC-20260207-1403-01 | P0 | done | deployed | passed | RM3: pós stock_provision, Virtus OFF em massa / volta parcial; fixes de resume e provisão | `done/INC-20260207-1403-01.md` |
| INC-20260203-1800-01 | P0 | need_evidence | deployed_partial | not_run | RM3: `loginRequired=probe_failed` com navegador aparentemente OK (Virtus derrubado por blindagem) | `need_evidence/INC-20260203-1800-01.md` |
| INC-20260203-2100-01 | P0 | done | deployed | passed | CT Sistema Interno: Resumo divergente (KPI usa ct_drivers, abas usam ct_driver_memberships) | `done/INC-20260203-2100-01.md` |
| INC-20260203-2230-01 | P1 | done | deployed | passed | CT Sistema Interno: WhatsApp verde + menu (abrir/copiar) + registro â€œChamou no zapâ€ (Testes Encerrados + Chamar depois + Cadastro + ParticipaÃ§Ã£o) | `done/INC-20260203-2230-01.md` |
| INC-20260203-2400-01 | P1 | done | deployed | passed | CT Chat: composer auto-grow (ate 8 linhas) + Ver mais em mensagens grandes | `done/INC-20260203-2400-01.md` |
| INC-20260203-2500-01 | P1 | done | deployed | passed | CT Chat: editar mensagem (menu ...) | `done/INC-20260203-2500-01.md` |
| INC-20260203-2510-01 | P2 | done | deployed | passed | CT Chat: links clicaveis | `done/INC-20260203-2510-01.md` |
| INC-20260203-2520-01 | P1 | done | deployed | passed | CT Chat: quebrar texto grande (sem scroll lateral) | `done/INC-20260203-2520-01.md` |
| INC-20260203-2530-01 | P1 | done | deployed | passed | CT Chat: reenviar mensagem falhada | `done/INC-20260203-2530-01.md` |
| INC-20260203-2540-01 | P2 | done | deployed | passed | CT Chat: cores por usuario | `done/INC-20260203-2540-01.md` |
| INC-20260201-0300-01 | P0 | done | deployed_partial | passed | P0: total>ativos (browsers fechados) apesar de RAM; sistema deve manter tudo aberto | `done/INC-20260201-0300-01.md` |
| INC-20260201-0200-01 | P0 | need_evidence | not_deployed | not_run | Forense RAM: RM4/RM5/RM6 (capacidade mÃ¡xima), autoMode light/full e thresholds | `need_evidence/INC-20260201-0200-01.md` |
| INC-20260201-0100-01 | P1 | done | needs_restart | not_run | CT/Servidores: contadores â€œLogin/Cookies falhouâ€ + â€œRecurso em anÃ¡liseâ€ + ordenaÃ§Ã£o OFFLINE primeiro | `done/INC-20260201-0100-01.md` |
| INC-20260201-0000-01 | P1 | done | deployed | passed | Groq config: garantir auto-download + auto-correÃ§Ã£o de modelo em TODOS os hosts apÃ³s update/restart | `done/INC-20260201-0000-01.md` |
| INC-20260131-0000-01 | P1 | done | deployed | passed | Captcha/Identidade: pre-screen â€œConfirme que vocÃª Ã© humanoâ€ + OCR Groq + identity/appeal handoff | `done/INC-20260131-0000-01.md` |
| INC-20260130-0905-01 | P0 | cancelled | not_deployed | not_run | CT marca RM3 OFFLINE mas host estÃ¡ acessÃ­vel (Servidores + Estoque) | `cancelled/INC-20260130-0905-01.md` |
| INC-20260130-1521-01 | P0 | done | manual_step_required | not_run | CT/Servidores mostra â€œDesconhecidoâ€ e precisa virar fonte de verdade operacional (flags + estados acionÃ¡veis) | `done/INC-20260130-1521-01.md` |
| INC-20260130-1544-01 | P0 | done | deployed | passed | RM3: â€œtrabalhando 0â€ no CT (urgente) | `done/INC-20260130-1544-01.md` |
| INC-20260130-2015-02 | P2 | done | deployed | passed | Abrir Todos deveria zerar flags para reavaliar estado real | `done/INC-20260130-2015-02.md` |
| INC-20260130-2015-03 | P2 | done | deployed | passed | HUD humano some ao navegar e demora a reaparecer | `done/INC-20260130-2015-03.md` |
| INC-20260130-2235-04 | P1 | done | deployed | passed | â€œConfirme que vocÃª Ã© humanoâ€ precisa auto-click | `done/INC-20260130-2235-04.md` |
| INC-20260130-0128-01 | P0 | done | deployed | passed | Abrir Todos nÃ£o iniciava com 0 browsers (nurseTick early-return) | `done/INC-20260130-0128-01.md` |
| INC-20260130-0001-01 | P0 | done | not_deployed | not_run | Abrir Todos: 2Âº clique dava open_all_lock_busy (lock idempotÃªncia) | `done/INC-20260130-0001-01.md` |
| INC-20260129-2100-01 | P1 | done | deployed_partial | not_run | Estoque: â€œreserved mas nÃ£o vaiâ€ (provision / stock_provision) | `done/INC-20260129-2100-01.md` |
| INC-20260129-2058-02 | P0 | done | needs_restart | not_run | Fechar Todos: reabre durante fechamento; lento; sobra navegador | `done/INC-20260129-2058-02.md` |
| INC-20260129-2058-03 | P1 | done | needs_restart | not_run | Abrir Todos 24h: concorrÃªncia/medo de clicar; auto-open no boot | `done/INC-20260129-2058-03.md` |
| INC-20260129-2058-04 | P1 | done | needs_restart | not_run | GovernanÃ§a: controle de concorrÃªncia (login_required/identity/open/ram) | `done/INC-20260129-2058-04.md` |
| INC-20260129-2340-01 | P1 | done | needs_restart | not_run | Abrir Todos: fica preso em 26/28; sem progresso; nÃ£o libera Robe/Virtus | `done/INC-20260129-2340-01.md` |
| INC-20260130-0005-01 | P1 | done | needs_restart | not_run | Invocar Humano: botÃµes no HUD (fechar/pause24h/excluir) + garantir isolamento do navegador humano | `done/INC-20260130-0005-01.md` |
| INC-20260130-0023-01 | P0 | done | needs_restart | not_run | RM3: estoque liberou conta, mas cadastro/provision falhou | `done/INC-20260130-0023-01.md` |
| INC-20260130-0047-01 | P1 | done | not_applicable | not_applicable | RM4: entender â€œmodo leve/fullâ€ (slowmode) â€” regras/motivos/mecanismos/impactos | `done/INC-20260130-0047-01.md` |
| INC-20260130-0103-01 | P0 | done | needs_restart | not_run | CT estoque/servidores â€œliberarâ€ solta cooldown do Robe em massa + RM3 nÃ£o cadastra | `done/INC-20260130-0103-01.md` |
| INC-20260130-0148-01 | P1 | done | needs_restart | not_run | Governor light/full: thresholds (RAM/lag), nÃ£o pausar Robe, recuperaÃ§Ã£o leve | `done/INC-20260130-0148-01.md` |
| INC-20260130-0205-01 | P0 | done | needs_restart | not_run | Governor light/full: janelas 5min/30min, sem fechar 1 navegador, hard reset total | `done/INC-20260130-0205-01.md` |
| INC-20260130-0227-01 | P0 | done | needs_restart | not_run | Crash no boot: `Illegal break statement` em `robeTickGlobal` | `done/INC-20260130-0227-01.md` |
| INC-20260130-0219-01 | P0 | done | deployed_partial | not_run | Governor light/full: somente RAM + snapshot 1/min por 48h | `done/INC-20260130-0219-01.md` |

