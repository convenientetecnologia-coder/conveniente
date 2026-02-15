### INBOX â€” relatos do humano (CÃ¡ssio) â€” CANÃ”NICO

Objetivo: quando o humano mandar um texto grande/bagunÃ§ado com â€œmil problemasâ€, o GPT usa este arquivo como **canal de intake**:

- colar o **texto bruto** (sem julgar)
- quebrar em **itens separados** (um por problema)
- classificar por **P0/P1/P2**
- marcar o que falta (evidÃªncia/logs/cmdId/hostId)
- mapear â€œrelato Xâ€ â†’ **arquivo(s)/funÃ§Ã£o(s)** â†’ hipÃ³tese â†’ plano

> Regra: o humano nÃ£o investiga nem coleta logs manualmente. O GPT puxa logs via CT, e o humano sÃ³ reinicia `node index.js` quando solicitado.

---

## Regras nÃ£o negociÃ¡veis (resumo)

- **Sou humano**: eu sÃ³ reinicio processos no servidor com `node index.js` e confirmo â€œreiniciadoâ€. Eu nÃ£o coleto logs manualmente, nÃ£o rodo comandos, nÃ£o copio/colo evidÃªncia.
- **VocÃª Ã© o operador tÃ©cnico**: vocÃª edita cÃ³digo, cria comandos, coleta logs via CT, registra docs, faz commit/push.
- **Sempre diga no inÃ­cio**:
  - **Precisa reiniciar?** sim/nÃ£o
  - **Qual projeto?** conveniente / sitechatbot / notificador
  - **Como reiniciar (humano)?** `node index.js`
  - **Por quÃª?** (1 frase)
- **Sem achismo**: qualquer decisÃ£o importante tem que citar evidÃªncia (arquivo/path, log key, cmdId/requestId, endpoint).
- **Sem segredos**: nunca colar valores de secrets em chat/docs (apenas nomes/onde configurar).
- **Windows/PowerShell**: nÃ£o usar `&&` nem heredoc `<<EOF` (usar `;` e `git commit -m ... -m ...`).
- **Melhoria contÃ­nua**: se vocÃª errou e depois acertou, vocÃª atualiza RUNBOOK/LIVRO/TIMELINE e sobe commit pro GitHub.
- **PadrÃ£o conveniente**: se mexeu no conveniente, vocÃª jÃ¡ faz commit/push + dispara `self_update` e sÃ³ pede o restart.

### Arquivos canÃ´nicos (use sempre)

- `C:\conveniente\docs\LIVRO_DE_BORDO.md`
- `C:\conveniente\docs\RUNBOOK_TECNICO.md`
- `C:\conveniente\docs\TIMELINE.md`
- `C:\conveniente\docs\checkups\README.md`
- `C:\conveniente\docs\checkups\TEMPLATE_CHECKUP.md`
- `C:\conveniente\docs\checkup_geral_2026-01-29.md`

---

### Como usar (passo a passo)

1) **Colar o texto bruto** do humano em â€œRAW_INPUTâ€.
2) **Criar itens** na tabela â€œTRIAGEâ€ (1 linha por problema).
3) Para cada item, criar uma seÃ§Ã£o â€œITEM â€¦â€ com:
   - hipÃ³tese(s)
   - evidÃªncia solicitada (logs keys / requestId / cmdId)
   - o que o GPT vai mudar (arquivos)
   - precisa reiniciar agora? sim/nÃ£o
   - precisa reiniciar para validar? sim/nÃ£o
4) **ObrigatÃ³rio**: antes de mexer em cÃ³digo, fazer **anÃ¡lise de impacto**:
   - quem chama / quem Ã© chamado (callers/callees)
   - quais arquivos/estados sÃ£o tocados (desired/perfis/status/locks)
   - quais efeitos colaterais podem acontecer (ex.: â€œfecharâ€ disparar â€œabrirâ€ por nurse/desired)
   - quais riscos de regressÃ£o e como reduzir (mudanÃ§a mÃ­nima + guardrails + rollback)
5) **ObrigatÃ³rio**: antes de investigar â€œdo zeroâ€, olhar o **passado** (evitar repetir erro / achar regressÃ£o):
   - `C:\conveniente\docs\TIMELINE.md` (entradas relacionadas)
   - `C:\conveniente\docs\checkups\file_timeline\INDEX_*.md` (qual arquivo Ã© hotspot)
   - se o sintoma parece regressÃ£o: procurar commits recentes nos arquivos-alvo (o GPT faz isso)
6) **ObrigatÃ³rio**: antes de corrigir, fazer **perguntas item-a-item** (alinhamento humano):
   - â€œcomo deveria ser?â€ (comportamento esperado)
   - â€œqual Ã© o critÃ©rio de sucesso?â€ (como validar)
   - â€œisso Ã© P0/P1/P2 pra vocÃª?â€ (impacto)
   - â€œprecisa disso hoje (agora) ou pode ser depois?â€ (prioridade)

---

## RAW_INPUT (colar aqui)

```text
triagem inbox

URGENTE

ROBE MÃƒE 3: no CT estÃ¡ com "trabalhando 0".

Perguntas:
- por que ele estÃ¡ assim?
- estÃ¡ travado?
- tem a ver com modo leve?

Pedido:
- verificar com logs ultra detalhados enterprise e provar o motivo agora.

---

triagem inbox

precisamos investigar no ROBE MÃƒE 3 com logs:

- dificuldade no "invocar humano": cliquei em invocar humano e **nÃ£o estÃ¡ indo o painel** que abre junto com o invocar humano
- botÃ£o **"retomar trabalho" nÃ£o estÃ¡ retomando trabalho**
- isso prejudica o sistema: tem contas com messenger+facebook ok, mas o sistema marca **login requerido** e **virtus offline**
- depois de um tempo o retomar trabalho funcionou, mas estÃ¡ "travado/estranho"

Pedido:
- investigar modo ultra enterprise no cÃ³digo e nos logs **por que isso acontece**
- primeiro entender/provar; depois (aprovado) decidir se muda ou nÃ£o

---

triagem inbox (2026-01-30):

- ao clicar **Abrir Todos** ou abrir conta, deveria zerar flags para reavaliar estado real; flags antigas podem engessar
- apÃ³s **Retomar trabalho**, se Messenger estiver em login/senha, deveria re-detectar e repetir cookiesâ†’loginâ†’humano; parece engessado
- HUD do **modo humano** some ao navegar (demora a reaparecer)

---

triagem inbox (2026-01-30):

- apÃ³s Retomar trabalho, contas `campo_grande-1769119224052` e `porto_alegre-1769132611438` ficam sem flag e presas na tela de login
- conta `blumenau-1769748927066` abre em â€œconfirme que vocÃª Ã© humanoâ€; apÃ³s clicar â€œContinuarâ€ manualmente aparece captcha/ checkpoint; sistema deveria antecipar o clique â€œContinuarâ€ e sÃ³ entÃ£o invocar humano

---

triagem inbox (2026-02-03):

CT Chat (2 itens):
1) Composer (caixa de escrever) precisa auto-grow conforme digita; teto ~8 linhas.
2) Mensagens grandes precisam de botÃ£o â€œVer maisâ€ (expandir/recolher).


---

triagem inbox (2026-02-03):
CT Chat (5 itens):
1) Editar mensagem no menu (...) com modal bonito (preview + campo + confirmar/cancelar).
2) Links clicaveis no texto.
3) Mensagem unica grande deve quebrar para baixo (sem scroll lateral).
4) Reenviar quando falhar envio.
5) Cor por usuario.

```

---

## TRIAGE (1 linha por problema)

Colunas:
- **id**: `INC-YYYYMMDD-HHMM-XX`
- **arquivo**: link para `docs/inbox/INC-....md`
- **P**: P0/P1/P2
- **sistema**: conveniente / sitechatbot / notificador
- **sintoma (humano)**: 1 frase
- **hipÃ³tese (GPT)**: 1 frase
- **evidÃªncia**: logs keys / cmdId / requestId / endpoint
- **state do INC (rÃ­gido)**: `new` / `need_alignment` / `need_evidence` / `in_progress` / `done` / `cancelled`
- **rollout**: `not_deployed` / `deployed_partial` / `deployed` / `needs_restart` / `manual_step_required`
- **validation**: `not_run` / `passed` / `failed`
- **precisa reiniciar agora?** sim/nÃ£o
- **precisa reiniciar p/ validar?** sim/nÃ£o

| id | arquivo | P | sistema | sintoma (humano) | hipÃ³tese (GPT) | evidÃªncia | state | rollout | validation | reiniciar agora? | reiniciar p/ validar? |
|---|---|---|---|---|---|---|---|---|---|---|---|
| INC-20260203-2500-01 | `docs/inbox/in_progress/INC-20260203-2500-01.md` | P1 | sitechatbot | Chat: editar mensagem no menu (...) com modal | falta endpoint/edit + UI do menu/modal | debug ingest runId=chat_edit_v1 | in_progress | not_deployed | not_run | nao | sim |
| INC-20260203-2510-01 | `docs/inbox/need_evidence/INC-20260203-2510-01.md` | P2 | sitechatbot | Chat: links clicaveis | falta linkify no render | debug ingest runId=chat_links_v1 | need_alignment | not_deployed | not_run | nao | sim |
| INC-20260203-2520-01 | `docs/inbox/need_evidence/INC-20260203-2520-01.md` | P1 | sitechatbot | Chat: texto grande com scroll lateral | falta overflow-wrap/word-break | debug ingest runId=chat_wrap_v1 | need_alignment | not_deployed | not_run | nao | sim |
| INC-20260203-2530-01 | `docs/inbox/need_evidence/INC-20260203-2530-01.md` | P1 | sitechatbot | Chat: reenviar msg falhada | falta acao de resend em UI/outbox | debug ingest runId=chat_resend_v1 | need_alignment | not_deployed | not_run | nao | sim |
| INC-20260203-2540-01 | `docs/inbox/need_evidence/INC-20260203-2540-01.md` | P2 | sitechatbot | Chat: cor por usuario | falta paleta/estilo por actor | debug ingest runId=chat_colors_v1 | need_alignment | not_deployed | not_run | nao | sim |
| INC-20260203-2400-01 | `docs/inbox/in_progress/INC-20260203-2400-01.md` | P1 | sitechatbot | Chat: composer nÃ£o cresce e texto some; mensagens grandes precisam â€œVer maisâ€ | Composer com altura fixa sem handler; bolhas sem truncamento/toggle | debug ingest (runId=chat_autogrow_v1, chat_vermais_v1) | in_progress | not_deployed | not_run | nÃ£o | sim |
| INC-20260207-1403-01 | `docs/inbox/done/INC-20260207-1403-01.md` | P0 | conveniente+sitechatbot | RM3: 50/50/24 (Virtus OFF em massa) apÃ³s stock_provision | root-cause: quiesce + gaps de resume em ambiente sharded; follow-up: stock_provision nÃ£o depende de quiesce por padrÃ£o | CT snapshot `C:\\sitechatbot\\dados\\5d7c3309-...-30b3fe928b.json` + provision_audit(stock_provision_*resume*) | done | deployed | passed | nÃ£o | nÃ£o |
| INC-YYYYMMDD-HHMM-01 | `docs/inbox/in_progress/INC-YYYYMMDD-HHMM-01.md` | P1 | conveniente | â€¦ | â€¦ | logs_manifest + fetch_logs(keys=â€¦) | need_evidence | not_deployed | not_run | nÃ£o | sim |
| INC-20260201-0300-01 | `docs/inbox/done/INC-20260201-0300-01.md` | P0 | conveniente+sitechatbot | Total>ativos: browsers fechados apesar de RAM; prejuÃ­zo (contas paradas) | Root-cause: `open_all_finalize_partial` desativava `desired.active` + `nurseTick` bloqueava open quando `loginRequired=captcha_*` ou `identityRequired` e `ctrl` ausente | CT snapshots `C:\\sitechatbot\\dados\\<hostId>-*.json` + `provision_audit` (bootstrap_messenger_ready + loginRequired) + patch worker.js | done | deployed_partial | passed | nÃ£o | nÃ£o |
| INC-20260202-1600-01 | `docs/inbox/done/INC-20260202-1600-01.md` | P0 | sitechatbot+conveniente+notificador | Cidades/Grupos: contrato canÃ´nico + prioridade de provisÃ£o (estoqueâ†’servidor) + migraÃ§Ã£o manual | Fixar contrato: CT canÃ´nico=`cidade_uf`; `conveniente` recebe `cidade` sem UF; `notificador` depende de `cidade_uf`; depois construir score Ãºnico (24/48/72h + motoristas + A + LE por idade ~12d + warmup 24h) | evidÃªncia por cÃ³digo: `C:\\sitechatbot\\index.js`, `C:\\conveniente\\scripts\\dashboard.js`, `C:\\notificador\\index.js` | done | deployed | passed | nÃ£o | nÃ£o |
| INC-20260202-2000-01 | `docs/inbox/done/INC-20260202-2000-01.md` | P0 | sitechatbot+conveniente | Fonte Ãšnica da Verdade: Virtusâ†’Grupos vs Contas FB v2 divergindo (janelas + classificaÃ§Ã£o A/LR/LE/B) | Hoje existiam â€œ2 verdadesâ€: dashboard usava recent3d + classificador simples; v2 usava `fbAccountState`. Unificado para agregador canÃ´nico + janelas explÃ­citas + includeOffline explÃ­cito | evidÃªncia: CT `C:\\sitechatbot\\index.js` (`/api/dashboard/virtus`, `/api/contas-facebook`, `computeAccountsByGroupFromSnapshots`) + verificador offline `C:\\sitechatbot\\tools\\verify_virtus_groups_truth.js` | done | deployed | passed | nÃ£o | nÃ£o |
| INC-20260201-0200-01 | `docs/inbox/in_progress/INC-20260201-0200-01.md` | P0 | conveniente+sitechatbot | Forense RAM: avaliar RM4/RM5/RM6 lotados (min freeMB, autoMode light/full, risco e capacidade) | autoMode pode estar entrando em â€œlightâ€ por regras de tictac/lag mesmo com RAM sobrando; precisamos prova por telemetria por minuto | CT: logs_manifest + fetch_logs(keys=ram_telemetry*, status, governor/ops) dos hosts RM4/5/6 | in_progress | not_deployed | not_run | nÃ£o | nÃ£o |
| INC-20260201-0100-01 | `docs/inbox/done/INC-20260201-0100-01.md` | P1 | sitechatbot+conveniente | Menu Servidores: mostrar contagem de â€œLogin/Cookies falhouâ€ e â€œRecurso em anÃ¡liseâ€ no pill do servidor; ordenar OFFLINE primeiro | CT hoje nÃ£o consegue contar â€œlogin/cookies falhouâ€ porque `status.perfis` nÃ£o expÃµe `loginRemediateFailed`; appeal jÃ¡ existe; sort nÃ£o prioriza offline | evidÃªncia por cÃ³digo: `conveniente/scripts/worker.js` (`setLoginRemediateFailedFlag`, `setAppealSubmittedFlag`, `snapshotStatusAndWrite`) + `sitechatbot/index.js` (`GET /servers flagsAgg + sort`) + `sitechatbot/public/index.html` (render pills) | done | needs_restart | not_run | nÃ£o | sim |
| INC-20260201-0000-01 | `docs/inbox/done/INC-20260201-0000-01.md` | P1 | conveniente+sitechatbot | Groq config distribuÃ­do e alinhado (modelo maverick) em RM1â€“RM7 | ForÃ§ar set_groq_config e validar por evidÃªncia CT (cmd ok + modelo correto) | evidÃªncia: CT `dados/commands.json` (set_groq_config ok + groqModel maverick) | done | deployed | passed | nÃ£o | nÃ£o |
| INC-20260131-0000-01 | `docs/inbox/done/INC-20260131-0000-01.md` | P1 | conveniente | Captcha/Identidade: pre-screen â€œConfirme que vocÃª Ã© humanoâ€ + OCR Groq + handoff identity/appeal; evitar engessamento | Root-cause: botÃ£o â€œContinuarâ€ disabled + cooldown global de identity gate; corrigido com waits + gate sem cooldown | evidÃªncia RM7: `rm7_fetch_success_evidence_1769911213784.json` + `rm7_fetch_identity_stuck_1769899549740.json` | done | deployed | passed | nÃ£o | nÃ£o |
| INC-20260130-0905-01 | `docs/inbox/cancelled/INC-20260130-0905-01.md` | P0 | sitechatbot+conveniente | RM3 aparece OFFLINE no CT (servidores + estoque) mas o host estÃ¡ acessÃ­vel | CT nÃ£o recebeu `/report` recente (snapshot `receivedAt` velho) **ou** UI estÃ¡ mostrando â€œghostâ€ | CT snapshot: `C:\sitechatbot\dados\5d7c3309-...-30b3fe928b.json`; regra CT `/servers` (computedOnline por `receivedAt`) | cancelled | not_deployed | not_run | nÃ£o | nÃ£o |
| INC-20260130-1521-01 | `docs/inbox/done/INC-20260130-1521-01.md` | P0 | sitechatbot+conveniente | CT/Servidores mostra "Desconhecido" e contadores de flags (captcha/humano invocado/login/limite) nÃ£o sÃ£o 110% acionÃ¡veis | o CT estava colapsando razÃµes de `loginRequired` em `unknown` (ex.: `probe_failed`) e nÃ£o expunha flags operacionais no `/servers` | evidÃªncia: CT files `C:\sitechatbot\convenientetecnologia\lib\fbAccountState.js`, `C:\sitechatbot\index.js`, `C:\sitechatbot\public\index.html` | done | manual_step_required | not_run | nÃ£o | sim |
| INC-20260130-1544-01 | `docs/inbox/done/INC-20260130-1544-01.md` | P0 | conveniente+sitechatbot | RM3: â€œinvocar humanoâ€ nÃ£o abre painel/HUD e â€œretomar trabalhoâ€ parece nÃ£o retomar; alÃ©m de variaÃ§Ãµes 0â†’4â†’6 trabalhando no CT | fila de login_remediate travava quando governor_busy + `configurando=true` impedia autoLoginRemediateTick de avanÃ§ar | evidÃªncia: RM3 `provision_audit` em `rm3_pa_tail_verify_20260131_01.json` (CT) | done | deployed | passed | nÃ£o | nÃ£o |
| INC-20260130-2015-02 | `docs/inbox/done/INC-20260130-2015-02.md` | P2 | conveniente | Abrir Todos deveria zerar flags para reavaliar estado real | confirmado ok pelo humano para o uso atual | n/a (aceite do humano) | done | deployed | passed | nÃ£o | nÃ£o |
| INC-20260130-2015-03 | `docs/inbox/done/INC-20260130-2015-03.md` | P2 | conveniente | HUD humano some ao navegar e demora a reaparecer | confirmado ok pelo humano para o uso atual | n/a (aceite do humano) | done | deployed | passed | nÃ£o | nÃ£o |
| INC-20260130-2235-04 | `docs/inbox/done/INC-20260130-2235-04.md` | P1 | conveniente | â€œConfirme que vocÃª Ã© humanoâ€: precisava clicar â€œContinuarâ€ automaticamente antes de captcha | confirmado ok pelo humano para o uso atual | n/a (aceite do humano) | done | deployed | passed | nÃ£o | nÃ£o |
| INC-20260130-0128-01 | `docs/inbox/done/INC-20260130-0128-01.md` | P0 | conveniente | Abrir Todos nÃ£o iniciava com 0 browsers | nurseTick fazia early-return quando controllers=0 mesmo com desired.active/_openAll | CT: desired active=28/28 + controllersCount=0; fix commit 035fa92 | done | deployed | passed | nÃ£o | sim |
| INC-20260130-0001-01 | `docs/inbox/done/INC-20260130-0001-01.md` | P0 | conveniente | Abrir Todos: 2Âº clique dava open_all_lock_busy | endpoint nÃ£o era idempotente; faltava feedback; stale lock precisava auto-recover | painel alert + payload alreadyRunning + lockOwner | done | not_deployed | not_run | nÃ£o | sim |
| INC-20260129-2100-01 | `docs/inbox/done/INC-20260129-2100-01.md` | P1 | sitechatbot+conveniente | conta do estoque fica â€œreservedâ€ mas nÃ£o provisiona (falhas em massa) | timeouts+busy+ACK lookup limitado; hardening+fallback | CT DB + ack files + provision_audit.jsonl | done | deployed_partial | not_run | nÃ£o | sim |
| INC-20260129-2058-02 | `docs/inbox/done/INC-20260129-2058-02.md` | P0 | conveniente | Fechar Todos reabre/lento; sobra navegador | painel fechava sem zerar desired.active; nurse reabria | provision_audit(close_all_*) + status snapshot | done | needs_restart | not_run | sim | sim |
| INC-20260129-2058-03 | `docs/inbox/done/INC-20260129-2058-03.md` | P1 | conveniente | Abrir Todos concorre/trava; auto-open no boot | open_all sequencial (nurse) + start-closed no boot (sem auto-open) | provision_audit(open_all*) + desired/status | done | needs_restart | not_run | sim | sim |
| INC-20260129-2058-04 | `docs/inbox/done/INC-20260129-2058-04.md` | P1 | conveniente | GovernanÃ§a de concorrÃªncia (login/identity/open/ram) | permits por tipo (login_remediate/identity_flow) integrados ao supervisor + TTL anti-leak + busy sem travar | CT status snapshot (RM4) + novos eventos do supervisor (permit_*) + provision_audit(governor_denied) | done | needs_restart | not_run | nÃ£o | nÃ£o |
| INC-20260129-2340-01 | `docs/inbox/done/INC-20260129-2340-01.md` | P1 | conveniente | Abrir Todos abre sÃ³ 26/28; fica parado; sem progresso; nÃ£o libera Robe/Virtus | pending â€œimpossÃ­veisâ€ por RAM mantinham keepalive do open_all_map; Virtus ficava pausado indefinidamente | CT: fetch_logs(status+desired+provision_audit) (RM4) requestId=0ea405...; perfis faltantes + pause_tick | done | needs_restart | not_run | nÃ£o | sim |
| INC-20260130-0005-01 | `docs/inbox/done/INC-20260130-0005-01.md` | P1 | conveniente | Invocar Humano: melhorar mini painel (HUD) com aÃ§Ãµes Ãºteis (fechar/pause24h/excluir) | HUD via exposeFunction; botÃµes chamam fluxos canÃ´nicos; humanControl isola o navegador | provision_audit(human_overlay_action_*) + teste em RM4 | done | needs_restart | not_run | nÃ£o | sim |
| INC-20260130-0023-01 | `docs/inbox/done/INC-20260130-0023-01.md` | P0 | conveniente+sitechatbot | RM3 recebeu conta do estoque mas nÃ£o cadastrou | falha no stock_provision por provision_lock_busy (lock de human_reconcile_login_form) | CT: cmdId+ack (ae137...) + self_update ack (07ea...) | done | needs_restart | not_run | sim | sim |
| INC-20260130-0047-01 | `docs/inbox/done/INC-20260130-0047-01.md` | P1 | conveniente | RM4: sistema fica em â€œmodo leveâ€ (slowmode) | governor autoMode: sai de full sÃ³ se freeMB>=3072 e lag<=exit; light pausa robeTickGlobal e deixa Virtus mais lento | CT status snapshot (RM4) + cÃ³digo worker/virtus | done | not_applicable | not_applicable | nÃ£o | nÃ£o |
| INC-20260130-0103-01 | `docs/inbox/done/INC-20260130-0103-01.md` | P0 | sitechatbot+conveniente | CT estoque/servidores â€œliberar todosâ€ causou liberaÃ§Ã£o indevida de cooldowns do Robe | endpoint CT acoplado a `robes_release_all` + stock_provision falhando por pause_timeout | CT commands.log/ack + ack details RM3 | done | needs_restart | not_run | nÃ£o | sim |
| INC-20260130-0148-01 | `docs/inbox/done/INC-20260130-0148-01.md` | P1 | conveniente | Governor light/full: thresholds e comportamento | entrar/sair por 2GB; ajustar lag; light nÃ£o â€œmataâ€ Robe; recovery leve com rate limit | worker.js autoMode (env CT_GOV_*) + commits+acks | done | needs_restart | not_run | nÃ£o | sim |
| INC-20260130-0205-01 | `docs/inbox/done/INC-20260130-0205-01.md` | P0 | conveniente | Governor light/full: evitar escadinha e resetar de forma correta | janelas 5min/30min + hard reset total; sem fechar 1 navegador | commit d8a3abc + self_update acks | done | needs_restart | not_run | nÃ£o | sim |
| INC-20260130-0227-01 | `docs/inbox/done/INC-20260130-0227-01.md` | P0 | conveniente | Crash no boot apÃ³s restart | `Illegal break statement` em `scripts/worker.js` | log do boot + commit f243902 | done | needs_restart | not_run | nÃ£o | sim |
| INC-20260130-0219-01 | `docs/inbox/done/INC-20260130-0219-01.md` | P0 | conveniente | Governor: somente RAM + telemetria 48h | RAM-only + snapshots 1/min; sem reset/fechar/abrir | commits 3e32a40/afc019a + coleta RM5 via fetch_logs | done | deployed_partial | not_run | nÃ£o | sim |

### PolÃ­tica ultra-rÃ­gida (enterprise) â€” como o INBOX funciona

Regra do jogo: **INBOX Ã© um sistema de tickets** (nÃ£o um chat). Cada relato vira ticket(s) e cada ticket vira um arquivo `INC-...md`.

1) **1 texto â†’ N itens â†’ N arquivos**
   - Sempre que o humano mandar â€œtriagem inboxâ€ (textÃ£o ou nÃ£o), o GPT:
     - cola no `RAW_INPUT`
     - quebra em itens
     - para cada item cria um `docs/inbox/INC-...md` separado
     - registra cada item na tabela `TRIAGE` com link para o arquivo.

2) **WIP limit = 1 (um por vez)**
   - SÃ³ pode existir **1** item com state `in_progress` por vez.
   - Se houver vÃ¡rios itens, o GPT escolhe 1 (por P0/P1 e impacto) e **sÃ³ muda de item quando o anterior estiver `done`**.

3) **Status Ãºnico e rastreÃ¡vel (sem achismo)**
   - **state do INC**:
     - `new`: criado, ainda nÃ£o alinhado.
     - `need_alignment`: faltam perguntas (â€œcomo deveria serâ€ / â€œcritÃ©rio de sucessoâ€).
     - `need_evidence`: precisa coletar logs/CT antes de mexer.
     - `in_progress`: investigando/alterando (WIP=1).
     - `done`: o GPT jÃ¡ fez o melhor trabalho possÃ­vel (cÃ³digo/docs/deploy se aplicÃ¡vel). Pode faltar restart/teste â€” isso vai em `rollout/validation`, nÃ£o aqui.
     - `cancelled`: descartado conscientemente (com justificativa).
   - **rollout/validation**:
     - rollout `needs_restart` NÃƒO impede `done`; apenas indica que â€œa prescriÃ§Ã£o ainda nÃ£o foi aplicada em runtimeâ€.
     - validation `not_run` Ã© normal; se der ruim depois, isso vira **novo INC** (novo relato), referenciando este.

4) **EvoluÃ§Ã£o contÃ­nua dentro do arquivo do INC**
   - O arquivo `INC-...md` deve ser â€œvivoâ€: toda evidÃªncia nova, descoberta, decisÃ£o, e patch aplicado entra ali.
   - Quando fecha (`done`), o arquivo fica como â€œpostmortemâ€/histÃ³rico.

5) **Fechamento (modelo â€œmÃ©dicoâ€)**
   - Para marcar `done`, basta: o GPT entregou a melhor soluÃ§Ã£o possÃ­vel (cÃ³digo/docs e, quando possÃ­vel, deploy).
   - Restart/teste nÃ£o bloqueiam `done`: viram `rollout=needs_restart` e `validation=not_run`.
   - Se o problema persistir/voltar: cria-se um **novo** INC (novo relato), citando o INC anterior como histÃ³rico.

6) **OrganizaÃ§Ã£o por pastas (status fÃ­sico)**
   - Ao criar um INC: salvar em `docs/inbox/in_progress/INC-...md`
   - Ao marcar `need_evidence`: mover para `docs/inbox/need_evidence/INC-...md` (aguardando evidÃªncia/decisÃ£o; nÃ£o Ã© WIP ativo)
   - Ao marcar `done`: mover para `docs/inbox/done/INC-...md` (mesmo que rollout/validation estejam pendentes)
   - Ao marcar `cancelled`: mover para `docs/inbox/cancelled/INC-...md`
   - O `docs/inbox/INDEX.md` e a tabela `TRIAGE` devem apontar para o caminho correto (sem link quebrado).

---

### ITEM: INC-20260129-2100-01 â€” Estoque: â€œreserved mas nÃ£o vaiâ€ (provision)

- **P**: P1 (pode virar P0 se voltar a travar em produÃ§Ã£o)
- **Sistema**: `sitechatbot` (estoque/CT) + `conveniente` (executor do provision)
- **Sintoma (humano)**: conta fica reservada no estoque, mas o provision falha e a conta nÃ£o â€œandaâ€; ocorreu em mÃºltiplos servidores; depois de updates, RM4 conseguiu provisionar 1 conta.
- **Como deveria ser (humano)**: (pendente â€” perguntar)
- **CritÃ©rio de sucesso (humano)**: (pendente â€” perguntar)
- **HipÃ³teses (GPT)**:
  - H1: hook do CT em `/api/commands/ack` nÃ£o encontra o job do `stock_provision` (busca limitada via `listJobs(limit=200)`), entÃ£o nÃ£o atualiza job e nÃ£o libera `reserved`.
  - H2: `details.results` do ACK nÃ£o carrega info suficiente (ex.: `profileName`/`stockAccountId`) para o CT decidir `assigned` vs `release` corretamente em falhas.
  - H3: guard `provision_guard` estÃ¡ rodando mas nÃ£o consegue resolver rapidamente (TTL alto / janela grande), gerando â€œpresasâ€ temporÃ¡rias.
- **EvidÃªncia a coletar (GPT)**:
  - CT DB: contas `reserved` + jobs `provision` `running` (sem imprimir login/senha/cookies).
  - ACK evidence: `sitechatbot/dados/logs/<hostId>/ack_<cmdId>.json` para `stock_provision` (verificar `details.results` e erros).
  - Servidor executor (RM4): `fetch_logs_query` em `provision_audit` por `stock_provision_action_fail` (sem secrets).
- **Arquivos provÃ¡veis**:
  - `C:\sitechatbot\index.js` (hook `/api/commands/ack` para `stock_provision`)
  - `C:\sitechatbot\convenientetecnologia\lib\ctFbStock.js` (jobs/accounts + reserve/release/guards)
  - `C:\conveniente\scripts\dashboard.js` (`execStockProvision` e formato de `results` no ACK)
- **Mapa de impacto (obrigatÃ³rio)**:
  - **Fluxo ponta a ponta (alto nÃ­vel)**: UI/Agendador CT â†’ cria job (DB) + reserva conta â†’ `enqueueCommand(stock_provision)` â†’ host executa `execStockProvision` â†’ ACK no CT â†’ CT atualiza job + conta (assigned/release).
  - **Estados tocados**:
    - CT: `ct_fb_stock_jobs`, `ct_fb_stock_accounts` (+ audit)
    - Host: `provision_audit.jsonl`, `desired.json`, `perfis.json`, `status.json` (durante provisÃ£o)
  - **Risco de regressÃ£o**: mexer em hook de ACK pode alterar transiÃ§Ãµes do estoque; mitigaÃ§Ã£o: mudanÃ§a mÃ­nima, idempotente, com fallback safe e audit log.
- **HistÃ³rico relacionado (obrigatÃ³rio)**:
  - Timeline: (preencher apÃ³s coletar evidÃªncia do dia 29/01 e commits relacionados)
- **Plano (mudanÃ§a mÃ­nima)**:
  - trocar lookup do job por `command_id` para query direta (nÃ£o limitada por `listJobs(limit=200)`).
  - adicionar fallback seguro: se job nÃ£o for encontrado, ainda assim liberar reserva com base em `details.results[*].stockAccountId` quando falhou sem criaÃ§Ã£o de perfil.
  - registrar audit local quando ocorrer â€œjob nÃ£o encontradoâ€ (para nunca mais virar achismo).
- **Precisa reiniciar agora?** nÃ£o
- **Precisa reiniciar para validar/testar?** depende (CT sim; hosts nÃ£o necessariamente)

ObservaÃ§Ã£o (organizaÃ§Ã£o):
- O â€œRAW_INPUTâ€ acima Ã© **temporÃ¡rio** (entrada).
- ApÃ³s triagem, o incidente vira um arquivo prÃ³prio em `C:\conveniente\docs\inbox\INC-....md` e o RAW_INPUT volta a ficar vazio.
- Ãndice: `C:\conveniente\docs\inbox\INDEX.md`.

## ITEM TEMPLATE (copiar/colar por item)

### ITEM: INC-YYYYMMDD-HHMM-XX â€” TÃ­tulo curto

- **P**: P?
- **Sistema**: conveniente / sitechatbot / notificador
- **Sintoma (humano)**:
- **Como deveria ser (humano)**:
- **CritÃ©rio de sucesso (humano)**: (ex.: â€œclicou â†’ em X segundos tudo fechado e nada reabre por Y segundosâ€)
- **ReproduÃ§Ã£o (se existir)**: (passos simples)
- **HipÃ³teses (GPT)**:
  - H1:
  - H2:
- **EvidÃªncia a coletar (GPT)**:
  - logs_manifest (hostId=â€¦)
  - fetch_logs(keys=â€¦)
  - cmdId/requestId (se aplicÃ¡vel)
- **Arquivos provÃ¡veis**:
  - `...`
- **Mapa de impacto (obrigatÃ³rio)**:
  - **Fluxo ponta a ponta (alto nÃ­vel)**: (ex.: CT â†’ dashboard.applyCommands â†’ endpoint â†’ worker â†’ arquivo/estado)
  - **Callers** (quem chama esse fluxo):
    - â€¦
  - **Callees** (o que esse fluxo aciona):
    - â€¦
  - **Estados tocados**: `desired.json` / `status.json` / `perfis.json` / manifests / locks / timers
  - **Efeitos colaterais possÃ­veis**:
    - â€œX pode religar Yâ€ (ex.: nurse/desired/virtus)
  - **Risco de regressÃ£o** (1 frase) + **mitigaÃ§Ã£o** (1 frase)
- **HistÃ³rico relacionado (obrigatÃ³rio)**:
  - **Timeline**: cite as entradas relevantes de `docs/TIMELINE.md` (data + tÃ­tulo).
  - **Hotspots/arquivos**: cite quais arquivos aparecem no `docs/checkups/file_timeline/` e por quÃª.
  - **HipÃ³tese de regressÃ£o**: â€œisso pode ter comeÃ§ado apÃ³s mudanÃ§a Xâ€ (com evidÃªncia).
- **Plano (mudanÃ§a mÃ­nima)**:
  - â€¦
- **Precisa reiniciar agora?** sim/nÃ£o â€” por quÃª
- **Precisa reiniciar para validar/testar?** sim/nÃ£o â€” por quÃª
- **ValidaÃ§Ã£o**:
  - endpoint/log esperado
- **Rollback**:
  - `git revert` + (se for validar rollback) reiniciar `node index.js`

---

## RAW_INPUT — 2026-02-14 (pedido de “fase 2”: atomicidade + duplicação zero)

```text
(humano)

Quero fechar os 2 INCs de wipe (RM2 e RM6) porque já varremos todos os servidores (RM1..RM7) e agora quero começar
uma fase nova “ultra enterprise”:

1 - cadastro de contas nunca em hipótese alguma zerar perfis
2 - nada, em hipótese alguma zerar perfis
3 - usar a pasta perfis para registrar mais coisas referente aos perfis, como um banco secundário perfeito:
    - registrar UA, fp, login/senha, datas e histórico (sem o sistema usar isso como verdade)
    - servir como fallback/recovery caso perfis.json suma
    - registrar exclusão pendente e fazer auto-retry de limpeza no boot/periodicamente (se falhar por lock)
    - mas NUNCA usar a pasta perfis como fonte da verdade para o dashboard, para não ressuscitar lixo
4 - investigação forense: por que está dando conta duplicada:
    - duplicada nos servidores
    - duplicada entre servidores
    - duplicada no CT em uso
   Quero saber tudo, resolver ponta a ponta de modo atômico:
    - conta do estoque -> 1 servidor só, nunca 2
    - CT registrar em uso perfeito, e exclusão perfeita também

Quero abrir um INC novo pra isso, fechar os 2 INCs antigos, e garantir que agora está tudo perfeito pra liberar
cadastro urgente sem surtar.
```

### TRIAGE — 2026-02-14

| item | P | título | status | links |
|---|---|---|---|---|
| 1 | P0 | Fechar INCs antigos de wipe (RM2/RM6) como superseded | done | `docs/inbox/cancelled/INC-20260212-0315-01.md`, `docs/inbox/cancelled/INC-20260213-1200-01.md` |
| 2 | P0 | PROGRAMA ÚNICO: cadastro sem duplicação (CT estoque -> servidor -> CT em uso) | done | `docs/inbox/done/INC-20260214-0900-01.md` |
| 3 | P0 | INCs auxiliares (0910/0920) fundidos no programa único | done | `docs/inbox/cancelled/INC-20260214-0910-01.md`, `docs/inbox/cancelled/INC-20260214-0920-01.md` |
| 4 | P1 | Fase 2 (0930/0940/0950/1000/1010) reclassificada após estabilizar cadastro | done | `docs/inbox/cancelled/INC-20260214-0930-01.md`, `docs/inbox/cancelled/INC-20260214-0940-01.md`, `docs/inbox/cancelled/INC-20260214-0950-01.md`, `docs/inbox/cancelled/INC-20260214-1000-01.md`, `docs/inbox/cancelled/INC-20260214-1010-01.md` |
| 5 | P0 | BLINDAGEM FINAL: hardening anti-regressão (H1/H2/H3) | done | `docs/inbox/done/INC-20260214-1020-01.md` |

---

## RAW_INPUT — 2026-02-15 (RM1: Robe postar / Marketplace “tela preta”)

```text
triagem inbox

robe mae 1

estamos com o seguinte problema, quando o robe vai postar , na aba zero ta rodando o virtus daquela conta, dai cheag a hora do robe postar, ele abre aba 1 facebook criar item , a tela ta ficando preta

o robe abre a aba 1 naveag para a pagina correta, ta tudo perfeito, ta indo pra pagina correta, as vezes consegue colocar foto, mas é muito raro, as vezes consegue colocar titulo, as vezes na foto ele ta ficando tela preta, as vezes no titulo, e em casos muito raros ele consegue chegar no preço, mas é muito raro

geralmente ja ta dando tela preta logo apos acessar a pagina, a pagina do criar item aparece, mas fica preta em seguida

temos essa conta aqui la no rm1 pra gente testar

[001] Alex Santana
ID: maringa-1759198592235
Cidade: Marabá
```

### TRIAGE — 2026-02-15

| item | P | título | status | links |
|---|---|---|---|---|
| 1 | P0 | RM1: Robe postar (Marketplace) — aba 1 tela preta ao criar item | done | `docs/inbox/done/INC-20260215-1100-01.md` |