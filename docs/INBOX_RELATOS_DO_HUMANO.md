### INBOX — relatos do humano (Cássio) — CANÔNICO

Objetivo: quando o humano mandar um texto grande/bagunçado com “mil problemas”, o GPT usa este arquivo como **canal de intake**:

- colar o **texto bruto** (sem julgar)
- quebrar em **itens separados** (um por problema)
- classificar por **P0/P1/P2**
- marcar o que falta (evidência/logs/cmdId/hostId)
- mapear “relato X” → **arquivo(s)/função(s)** → hipótese → plano

> Regra: o humano não investiga nem coleta logs manualmente. O GPT puxa logs via CT, e o humano só reinicia `node index.js` quando solicitado.

---

## Regras não negociáveis (resumo)

- **Sou humano**: eu só reinicio processos no servidor com `node index.js` e confirmo “reiniciado”. Eu não coleto logs manualmente, não rodo comandos, não copio/colo evidência.
- **Você é o operador técnico**: você edita código, cria comandos, coleta logs via CT, registra docs, faz commit/push.
- **Sempre diga no início**:
  - **Precisa reiniciar?** sim/não
  - **Qual projeto?** conveniente / sitechatbot / notificador
  - **Como reiniciar (humano)?** `node index.js`
  - **Por quê?** (1 frase)
- **Sem achismo**: qualquer decisão importante tem que citar evidência (arquivo/path, log key, cmdId/requestId, endpoint).
- **Sem segredos**: nunca colar valores de secrets em chat/docs (apenas nomes/onde configurar).
- **Windows/PowerShell**: não usar `&&` nem heredoc `<<EOF` (usar `;` e `git commit -m ... -m ...`).
- **Melhoria contínua**: se você errou e depois acertou, você atualiza RUNBOOK/LIVRO/TIMELINE e sobe commit pro GitHub.
- **Padrão conveniente**: se mexeu no conveniente, você já faz commit/push + dispara `self_update` e só pede o restart.

### Arquivos canônicos (use sempre)

- `C:\conveniente\docs\LIVRO_DE_BORDO.md`
- `C:\conveniente\docs\RUNBOOK_TECNICO.md`
- `C:\conveniente\docs\TIMELINE.md`
- `C:\conveniente\docs\checkups\README.md`
- `C:\conveniente\docs\checkups\TEMPLATE_CHECKUP.md`
- `C:\conveniente\docs\checkup_geral_2026-01-29.md`

---

### Como usar (passo a passo)

1) **Colar o texto bruto** do humano em “RAW_INPUT”.
2) **Criar itens** na tabela “TRIAGE” (1 linha por problema).
3) Para cada item, criar uma seção “ITEM …” com:
   - hipótese(s)
   - evidência solicitada (logs keys / requestId / cmdId)
   - o que o GPT vai mudar (arquivos)
   - precisa reiniciar agora? sim/não
   - precisa reiniciar para validar? sim/não
4) **Obrigatório**: antes de mexer em código, fazer **análise de impacto**:
   - quem chama / quem é chamado (callers/callees)
   - quais arquivos/estados são tocados (desired/perfis/status/locks)
   - quais efeitos colaterais podem acontecer (ex.: “fechar” disparar “abrir” por nurse/desired)
   - quais riscos de regressão e como reduzir (mudança mínima + guardrails + rollback)
5) **Obrigatório**: antes de investigar “do zero”, olhar o **passado** (evitar repetir erro / achar regressão):
   - `C:\conveniente\docs\TIMELINE.md` (entradas relacionadas)
   - `C:\conveniente\docs\checkups\file_timeline\INDEX_*.md` (qual arquivo é hotspot)
   - se o sintoma parece regressão: procurar commits recentes nos arquivos-alvo (o GPT faz isso)
6) **Obrigatório**: antes de corrigir, fazer **perguntas item-a-item** (alinhamento humano):
   - “como deveria ser?” (comportamento esperado)
   - “qual é o critério de sucesso?” (como validar)
   - “isso é P0/P1/P2 pra você?” (impacto)
   - “precisa disso hoje (agora) ou pode ser depois?” (prioridade)

---

## RAW_INPUT (colar aqui)

```text
[cole aqui o texto bruto do humano]
```

---

## TRIAGE (1 linha por problema)

Colunas:
- **id**: `INC-YYYYMMDD-HHMM-XX`
- **arquivo**: link para `docs/inbox/INC-....md`
- **P**: P0/P1/P2
- **sistema**: conveniente / sitechatbot / notificador
- **sintoma (humano)**: 1 frase
- **hipótese (GPT)**: 1 frase
- **evidência**: logs keys / cmdId / requestId / endpoint
- **state do INC (rígido)**: `new` / `need_alignment` / `need_evidence` / `in_progress` / `done` / `cancelled`
- **rollout**: `not_deployed` / `deployed_partial` / `deployed` / `needs_restart` / `manual_step_required`
- **validation**: `not_run` / `passed` / `failed`
- **precisa reiniciar agora?** sim/não
- **precisa reiniciar p/ validar?** sim/não

| id | arquivo | P | sistema | sintoma (humano) | hipótese (GPT) | evidência | state | rollout | validation | reiniciar agora? | reiniciar p/ validar? |
|---|---|---|---|---|---|---|---|---|---|---|---|
| INC-YYYYMMDD-HHMM-01 | `docs/inbox/in_progress/INC-YYYYMMDD-HHMM-01.md` | P1 | conveniente | … | … | logs_manifest + fetch_logs(keys=…) | need_evidence | not_deployed | not_run | não | sim |
| INC-20260130-0128-01 | `docs/inbox/done/INC-20260130-0128-01.md` | P0 | conveniente | Abrir Todos não iniciava com 0 browsers | nurseTick fazia early-return quando controllers=0 mesmo com desired.active/_openAll | CT: desired active=28/28 + controllersCount=0; fix commit 035fa92 | done | deployed | passed | não | sim |
| INC-20260130-0001-01 | `docs/inbox/done/INC-20260130-0001-01.md` | P0 | conveniente | Abrir Todos: 2º clique dava open_all_lock_busy | endpoint não era idempotente; faltava feedback; stale lock precisava auto-recover | painel alert + payload alreadyRunning + lockOwner | done | not_deployed | not_run | não | sim |
| INC-20260129-2100-01 | `docs/inbox/done/INC-20260129-2100-01.md` | P1 | sitechatbot+conveniente | conta do estoque fica “reserved” mas não provisiona (falhas em massa) | timeouts+busy+ACK lookup limitado; hardening+fallback | CT DB + ack files + provision_audit.jsonl | done | deployed_partial | not_run | não | sim |
| INC-20260129-2058-02 | `docs/inbox/done/INC-20260129-2058-02.md` | P0 | conveniente | Fechar Todos reabre/lento; sobra navegador | painel fechava sem zerar desired.active; nurse reabria | provision_audit(close_all_*) + status snapshot | done | needs_restart | not_run | sim | sim |
| INC-20260129-2058-03 | `docs/inbox/done/INC-20260129-2058-03.md` | P1 | conveniente | Abrir Todos concorre/trava; auto-open no boot | open_all sequencial (nurse) + start-closed no boot (sem auto-open) | provision_audit(open_all*) + desired/status | done | needs_restart | not_run | sim | sim |
| INC-20260129-2058-04 | `docs/inbox/done/INC-20260129-2058-04.md` | P1 | conveniente | Governança de concorrência (login/identity/open/ram) | permits por tipo (login_remediate/identity_flow) integrados ao supervisor + TTL anti-leak + busy sem travar | CT status snapshot (RM4) + novos eventos do supervisor (permit_*) + provision_audit(governor_denied) | done | not_deployed | not_run | não | não |

### Política ultra-rígida (enterprise) — como o INBOX funciona

Regra do jogo: **INBOX é um sistema de tickets** (não um chat). Cada relato vira ticket(s) e cada ticket vira um arquivo `INC-...md`.

1) **1 texto → N itens → N arquivos**
   - Sempre que o humano mandar “triagem inbox” (textão ou não), o GPT:
     - cola no `RAW_INPUT`
     - quebra em itens
     - para cada item cria um `docs/inbox/INC-...md` separado
     - registra cada item na tabela `TRIAGE` com link para o arquivo.

2) **WIP limit = 1 (um por vez)**
   - Só pode existir **1** item com state `in_progress` por vez.
   - Se houver vários itens, o GPT escolhe 1 (por P0/P1 e impacto) e **só muda de item quando o anterior estiver `done`**.

3) **Status único e rastreável (sem achismo)**
   - **state do INC**:
     - `new`: criado, ainda não alinhado.
     - `need_alignment`: faltam perguntas (“como deveria ser” / “critério de sucesso”).
     - `need_evidence`: precisa coletar logs/CT antes de mexer.
     - `in_progress`: investigando/alterando (WIP=1).
     - `done`: o GPT já fez o melhor trabalho possível (código/docs/deploy se aplicável). Pode faltar restart/teste — isso vai em `rollout/validation`, não aqui.
     - `cancelled`: descartado conscientemente (com justificativa).
   - **rollout/validation**:
     - rollout `needs_restart` NÃO impede `done`; apenas indica que “a prescrição ainda não foi aplicada em runtime”.
     - validation `not_run` é normal; se der ruim depois, isso vira **novo INC** (novo relato), referenciando este.

4) **Evolução contínua dentro do arquivo do INC**
   - O arquivo `INC-...md` deve ser “vivo”: toda evidência nova, descoberta, decisão, e patch aplicado entra ali.
   - Quando fecha (`done`), o arquivo fica como “postmortem”/histórico.

5) **Fechamento (modelo “médico”)**
   - Para marcar `done`, basta: o GPT entregou a melhor solução possível (código/docs e, quando possível, deploy).
   - Restart/teste não bloqueiam `done`: viram `rollout=needs_restart` e `validation=not_run`.
   - Se o problema persistir/voltar: cria-se um **novo** INC (novo relato), citando o INC anterior como histórico.

6) **Organização por pastas (status físico)**
   - Ao criar um INC: salvar em `docs/inbox/in_progress/INC-...md`
   - Ao marcar `done`: mover para `docs/inbox/done/INC-...md` (mesmo que rollout/validation estejam pendentes)
   - Ao marcar `cancelled`: mover para `docs/inbox/cancelled/INC-...md`
   - O `docs/inbox/INDEX.md` e a tabela `TRIAGE` devem apontar para o caminho correto (sem link quebrado).

---

### ITEM: INC-20260129-2100-01 — Estoque: “reserved mas não vai” (provision)

- **P**: P1 (pode virar P0 se voltar a travar em produção)
- **Sistema**: `sitechatbot` (estoque/CT) + `conveniente` (executor do provision)
- **Sintoma (humano)**: conta fica reservada no estoque, mas o provision falha e a conta não “anda”; ocorreu em múltiplos servidores; depois de updates, RM4 conseguiu provisionar 1 conta.
- **Como deveria ser (humano)**: (pendente — perguntar)
- **Critério de sucesso (humano)**: (pendente — perguntar)
- **Hipóteses (GPT)**:
  - H1: hook do CT em `/api/commands/ack` não encontra o job do `stock_provision` (busca limitada via `listJobs(limit=200)`), então não atualiza job e não libera `reserved`.
  - H2: `details.results` do ACK não carrega info suficiente (ex.: `profileName`/`stockAccountId`) para o CT decidir `assigned` vs `release` corretamente em falhas.
  - H3: guard `provision_guard` está rodando mas não consegue resolver rapidamente (TTL alto / janela grande), gerando “presas” temporárias.
- **Evidência a coletar (GPT)**:
  - CT DB: contas `reserved` + jobs `provision` `running` (sem imprimir login/senha/cookies).
  - ACK evidence: `sitechatbot/dados/logs/<hostId>/ack_<cmdId>.json` para `stock_provision` (verificar `details.results` e erros).
  - Servidor executor (RM4): `fetch_logs_query` em `provision_audit` por `stock_provision_action_fail` (sem secrets).
- **Arquivos prováveis**:
  - `C:\sitechatbot\index.js` (hook `/api/commands/ack` para `stock_provision`)
  - `C:\sitechatbot\convenientetecnologia\lib\ctFbStock.js` (jobs/accounts + reserve/release/guards)
  - `C:\conveniente\scripts\dashboard.js` (`execStockProvision` e formato de `results` no ACK)
- **Mapa de impacto (obrigatório)**:
  - **Fluxo ponta a ponta (alto nível)**: UI/Agendador CT → cria job (DB) + reserva conta → `enqueueCommand(stock_provision)` → host executa `execStockProvision` → ACK no CT → CT atualiza job + conta (assigned/release).
  - **Estados tocados**:
    - CT: `ct_fb_stock_jobs`, `ct_fb_stock_accounts` (+ audit)
    - Host: `provision_audit.jsonl`, `desired.json`, `perfis.json`, `status.json` (durante provisão)
  - **Risco de regressão**: mexer em hook de ACK pode alterar transições do estoque; mitigação: mudança mínima, idempotente, com fallback safe e audit log.
- **Histórico relacionado (obrigatório)**:
  - Timeline: (preencher após coletar evidência do dia 29/01 e commits relacionados)
- **Plano (mudança mínima)**:
  - trocar lookup do job por `command_id` para query direta (não limitada por `listJobs(limit=200)`).
  - adicionar fallback seguro: se job não for encontrado, ainda assim liberar reserva com base em `details.results[*].stockAccountId` quando falhou sem criação de perfil.
  - registrar audit local quando ocorrer “job não encontrado” (para nunca mais virar achismo).
- **Precisa reiniciar agora?** não
- **Precisa reiniciar para validar/testar?** depende (CT sim; hosts não necessariamente)

Observação (organização):
- O “RAW_INPUT” acima é **temporário** (entrada).
- Após triagem, o incidente vira um arquivo próprio em `C:\conveniente\docs\inbox\INC-....md` e o RAW_INPUT volta a ficar vazio.
- Índice: `C:\conveniente\docs\inbox\INDEX.md`.

## ITEM TEMPLATE (copiar/colar por item)

### ITEM: INC-YYYYMMDD-HHMM-XX — Título curto

- **P**: P?
- **Sistema**: conveniente / sitechatbot / notificador
- **Sintoma (humano)**:
- **Como deveria ser (humano)**:
- **Critério de sucesso (humano)**: (ex.: “clicou → em X segundos tudo fechado e nada reabre por Y segundos”)
- **Reprodução (se existir)**: (passos simples)
- **Hipóteses (GPT)**:
  - H1:
  - H2:
- **Evidência a coletar (GPT)**:
  - logs_manifest (hostId=…)
  - fetch_logs(keys=…)
  - cmdId/requestId (se aplicável)
- **Arquivos prováveis**:
  - `...`
- **Mapa de impacto (obrigatório)**:
  - **Fluxo ponta a ponta (alto nível)**: (ex.: CT → dashboard.applyCommands → endpoint → worker → arquivo/estado)
  - **Callers** (quem chama esse fluxo):
    - …
  - **Callees** (o que esse fluxo aciona):
    - …
  - **Estados tocados**: `desired.json` / `status.json` / `perfis.json` / manifests / locks / timers
  - **Efeitos colaterais possíveis**:
    - “X pode religar Y” (ex.: nurse/desired/virtus)
  - **Risco de regressão** (1 frase) + **mitigação** (1 frase)
- **Histórico relacionado (obrigatório)**:
  - **Timeline**: cite as entradas relevantes de `docs/TIMELINE.md` (data + título).
  - **Hotspots/arquivos**: cite quais arquivos aparecem no `docs/checkups/file_timeline/` e por quê.
  - **Hipótese de regressão**: “isso pode ter começado após mudança X” (com evidência).
- **Plano (mudança mínima)**:
  - …
- **Precisa reiniciar agora?** sim/não — por quê
- **Precisa reiniciar para validar/testar?** sim/não — por quê
- **Validação**:
  - endpoint/log esperado
- **Rollback**:
  - `git revert` + (se for validar rollback) reiniciar `node index.js`

