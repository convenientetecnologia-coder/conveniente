### Timeline — mudanças (mais novo em cima)

Regra: toda mudança relevante entra aqui com:
- tags (projeto/área),
- o que mudou,
- por que mudou,
- evidência (arquivo/endpoint/log),
- impacto operacional (reinícios),
- rollback.

Tags (modelo A = timeline única):
- `[CONV]`: conveniente
- `[CT]`: sitechatbot / CT
- `[NOTIF]`: notificador
- `[CROSS]`: envolve 2+ sistemas (sempre use junto com as tags de cada sistema)
- `[DOCS]`: documentação/organização (sem runtime)
- `[OPS]`: operação (procedimentos/rollback/restart)

Quando for “a mesma iniciativa” em mais de um sistema, usar um identificador:
- `THREAD=TH-YYYY-MM-DD-slug-curto`

Formato canônico (copiar/colar):

- `#### YYYY-MM-DD — [TAGS...] Título curto`
- **O que**: 1–5 bullets (sem detalhe excessivo)
- **Por quê**: 1 frase
- **Evidência**: caminho de arquivo / endpoint / log (ou “ver checkup X”)
- **Reinícios**: quais serviços/nodes precisam reiniciar (ou “nenhum”)
- **Rollback**: como desfazer (1–2 linhas)
- **THREAD**: `TH-...` (somente quando `[CROSS]`)

---

#### 2026-01-29 — [CROSS][DOCS] Organização inicial do conhecimento (bootstrap)

- **O que**:
  - Criado `docs/LIVRO_DE_BORDO.md` como índice/porta de entrada.
  - Criado `docs/RUNBOOK_TECNICO.md` (procedimentos operacionais).
  - Criado `docs/TIMELINE.md` (este arquivo).
  - Criado `docs/checkup_geral_2026-01-29.md` com achados técnicos.
- **Por quê**: evitar perda de contexto entre chats/GPTs e reduzir criação de “caminhos paralelos”.
- **Evidência**: arquivos em `C:\conveniente\docs\`.
- **Reinícios**: nenhum (somente documentação).
- **Rollback**: remover os arquivos `.md` (não afeta runtime).
- **THREAD**: `TH-2026-01-29-docs-bootstrap`

---

#### 2026-01-29 — [CONV][DOCS] Achado P0 (ainda não corrigido): lock não owner-safe

- **O que**: identificado P0 de concorrência em lock de arquivo no `conveniente`.
- **Por quê**: `unlink` do lock pode acontecer mesmo sem adquirir o lock ⇒ risco de corrida/corrupção.
- **Evidência**: `docs/checkup_geral_2026-01-29.md` e `conveniente/scripts/fileStore.js`.
- **Reinícios**: nenhum (ainda não alterado).
- **Rollback**: n/a (não houve mudança).

---

#### 2026-01-29 — [CONV][FIX] Correção P0: lock owner-safe em `fileStore.js` + remove busy-wait (CPU)

- **O que**:
  - corrigido release de lock para **não** remover `.lock` quando o lock não foi adquirido.
  - adicionados metadados no lock (pid/ts/token) e recuperação best-effort de lock “stale” por idade.
  - trocado busy-wait do lock de `perfis.json` por `Atomics.wait` (não gasta CPU).
- **Por quê**: eliminar risco de corrida/corrupção em `desired.json`/`perfis.json` e reduzir congelos por contenção.
- **Evidência**: `C:\conveniente\scripts\fileStore.js` (seção de locks `desired.json`/`perfis.json`).
- **Reinícios**: **conveniente** (somente) — **humano** reinicia no host do `conveniente` (parar e rodar `node index.js`).
- **Rollback**: o GPT prepara rollback via Git (ex.: `git revert` / voltar tag). O humano aplica reiniciando `node index.js` no host do `conveniente`.

---

#### 2026-01-29 — [CONV][FIX] P1: deadline/logs no `ensureFreeMB` (sem espera infinita)

- **O que**: `ensureFreeMB()` no `conveniente/scripts/dashboard.js` deixou de esperar infinito; agora tem `timeoutMs`, logs de progresso e erro explícito no timeout.
- **Por quê**: regra canônica P1: nenhuma espera pode ser infinita.
- **Evidência**: `C:\conveniente\scripts\dashboard.js` (função `ensureFreeMB`).
- **Precisa reiniciar agora?** não (mudança preventiva; só “vale” no runtime após restart).
- **Precisa reiniciar para validar/testar?** sim, se você quiser testar `ensureFreeMB` em runtime.
- **Qual projeto?** conveniente
- **Como reiniciar (humano)?** `node index.js`
- **Rollback**: `git revert` do commit e (se precisar validar rollback) reiniciar `node index.js`.

---

#### 2026-01-29 — [CONV][FIX] P1: auto-backup do `index.js` em subprocess (reduz freeze)

- **O que**: o snapshot automático (`CONVENIENTE_AUTO_BACKUP_*`) deixou de rodar com IO síncrono pesado no processo principal; agora dispara um subprocesso (`scripts/autoBackupWorker.js`) para fazer o trabalho.
- **Por quê**: P1 — reduzir latência/congelos do `conveniente` sob stress.
- **Evidência**:
  - `C:\conveniente\index.js` (função `startAutoBackupConveniente`)
  - `C:\conveniente\scripts\autoBackupWorker.js`
- **Precisa reiniciar agora?** não (só é necessário quando você quiser o benefício em runtime).
- **Precisa reiniciar para validar/testar?** sim, se você quiser observar “menos freeze” e confirmar que `_backup_auto/_snapshots.log` continua sendo gerado.
- **Qual projeto?** conveniente
- **Como reiniciar (humano)?** `node index.js`
- **Rollback**: `git revert` do commit e (se precisar validar rollback) reiniciar `node index.js`.

---

#### 2026-01-29 — [CONV][FIX] P1: auto-backup evita snapshots concorrentes (lock)

- **O que**: adicionado lock no worker de backup para impedir snapshots concorrentes quando um snapshot demora mais que o intervalo (e stale recovery).
- **Por quê**: reduzir IO/carga e evitar “pile-up” de backups.
- **Evidência**: `C:\conveniente\scripts\autoBackupWorker.js` (lock `_snapshot_running.lock`).
- **Precisa reiniciar agora?** não
- **Precisa reiniciar para validar/testar?** sim, se quiser observar o comportamento em runtime.
- **Qual projeto?** conveniente
- **Como reiniciar (humano)?** `node index.js`
- **Rollback**: `git revert` do commit e (se precisar validar rollback) reiniciar `node index.js`.

---

#### 2026-01-29 — [CONV][FIX] P1: logs/guardrails em waits de UI (browser/virtus)

- **O que**:
  - `browser.js`: `waitAny()` agora loga timeout quando `BROWSER_DEBUG=1`.
  - `browser.js`: loop de `identityAssistStep` ficou explicitamente bounded por budget/minTries (sem `while(true)`).
  - `virtus.js`: `assertOnChat` loga timeout quando `VIRTUS_DEBUG=1` (só em timeout).
- **Por quê**: P1 — reduzir “travou e não sei onde” e garantir que waits sejam sempre bounded.
- **Evidência**:
  - `C:\conveniente\scripts\browser.js`
  - `C:\conveniente\scripts\virtus.js`
- **Precisa reiniciar agora?** não
- **Precisa reiniciar para validar/testar?** sim, se quiser observar logs em runtime.
- **Qual projeto?** conveniente
- **Como reiniciar (humano)?** `node index.js`
- **Rollback**: `git revert` do commit e (se precisar validar rollback) reiniciar `node index.js`.

---

#### 2026-01-29 — [CONV][FIX] P1: handlers globais de erro (master/worker) + opção de exit

- **O que**: padronizado `uncaughtException`/`unhandledRejection` no master (`index.js`) e no worker (`scripts/worker.js`), com logs consistentes e opção `CONVENIENTE_FATAL_EXIT=1` para sair (evitar “seguir vivo” corrompido).
- **Por quê**: P1 — política de erro consistente e auditável.
- **Evidência**:
  - `C:\conveniente\index.js`
  - `C:\conveniente\scripts\worker.js`
  - `C:\conveniente\docs\RUNBOOK_TECNICO.md` (baseline env)
- **Precisa reiniciar agora?** não (só é necessário quando você quiser que isso passe a valer no runtime).
- **Precisa reiniciar para validar/testar?** sim, se quiser simular erro e ver o comportamento/log.
- **Qual projeto?** conveniente
- **Como reiniciar (humano)?** `node index.js`
- **Rollback**: `git revert` do commit e (se precisar validar rollback) reiniciar `node index.js`.

---

#### 2026-01-29 — [CROSS][DOCS][OPS] Inbox canônica para “texto bomba” do humano (triage P0/P1/P2)

- **O que**: criado canal canônico para intake/triage de relatos desorganizados do humano (colagem do texto bruto + decomposição em itens + P0/P1/P2 + evidência).
- **Evidência**:
  - `C:\conveniente\docs\INBOX_RELATOS_DO_HUMANO.md`
  - `C:\conveniente\docs\RUNBOOK_TECNICO.md` (seção “Intake de texto bomba do humano”)
  - `C:\conveniente\docs\LIVRO_DE_BORDO.md` (link no índice)
- **Reinícios**: nenhum (somente documentação).
- **Rollback**: reverter alterações nos `.md` (não afeta runtime).

---

#### 2026-01-29 — [CROSS][DOCS][OPS] INBOX: análise de impacto obrigatória (callers/callees/efeitos colaterais)

- **O que**: reforçado que “triagem inbox” inclui **investigação real** antes de mexer: mapear fluxo ponta a ponta e impactos (callers/callees/estados/efeitos colaterais).
- **Evidência**:
  - `C:\conveniente\docs\INBOX_RELATOS_DO_HUMANO.md` (Mapa de impacto obrigatório)
  - `C:\conveniente\docs\RUNBOOK_TECNICO.md` (intake: análise de impacto)
- **Reinícios**: nenhum (somente documentação).
- **Rollback**: reverter alterações nos `.md` (não afeta runtime).

---

#### 2026-01-29 — [CROSS][DOCS][OPS] INBOX: “olhar o histórico primeiro” (timeline + file_timeline)

- **O que**: padronizado que triagem inbox inclui checar histórico (TIMELINE + file_timeline/hotspots) para detectar regressão e evitar repetir erro.
- **Evidência**:
  - `C:\conveniente\docs\INBOX_RELATOS_DO_HUMANO.md` (Histórico relacionado obrigatório)
  - `C:\conveniente\docs\RUNBOOK_TECNICO.md` (intake: olhar histórico)
- **Reinícios**: nenhum (somente documentação).
- **Rollback**: reverter alterações nos `.md` (não afeta runtime).

---

#### 2026-01-29 — [CROSS][DOCS][OPS] INBOX: bloco de “regras não negociáveis” (humano/GPT)

- **O que**: adicionado bloco de regras não negociáveis e lista de arquivos canônicos dentro do `INBOX_RELATOS_DO_HUMANO.md` para guiar triage em chats com relato confuso.
- **Evidência**: `C:\conveniente\docs\INBOX_RELATOS_DO_HUMANO.md`
- **Reinícios**: nenhum (somente documentação).
- **Rollback**: reverter alterações nos `.md` (não afeta runtime).

---

#### 2026-01-29 — [CROSS][DOCS] Checkup 3 (loops/timeouts/polling)

- **O que**:
  - Documentado contrato CT⇄Notificador (poll/ack).
  - Documentado canal de logs `*_secret` (requestId/response) no CT.
  - Registrada regra canônica anti “espera infinita” (deadlines/ACK/GC).
  - Registrado achado P1: risco de `while(true)` sem deadline (ex.: `ensureFreeMB` legado no `conveniente`).
- **Evidência**:
  - `docs/LIVRO_DE_BORDO.md`
  - `docs/RUNBOOK_TECNICO.md`
  - `docs/checkup_geral_2026-01-29.md`
- **Reinícios**: nenhum (somente documentação/auditoria).
- **Rollback**: reverter alterações nos `.md` (não afeta runtime).
- **THREAD**: `TH-2026-01-29-ops-contracts`

---

#### 2026-01-29 — [CROSS][DOCS][OPS] Checklist canônico de release (P0/P1) no RUNBOOK

- **O que**: promovido checklist de “produção real de atualizações” para o `RUNBOOK_TECNICO.md`, com gate explícito P0/P1 e links para evidências/auditorias.
- **Por quê**: garantir que qualquer GPT consiga atualizar sem achismo e sem “caminhos paralelos”.
- **Evidência**:
  - `C:\conveniente\docs\RUNBOOK_TECNICO.md` (seção “Checklist de release / atualização (produção real) — CANÔNICO”)
  - `C:\conveniente\docs\checkup_geral_2026-01-29.md` (P0/P1)
- **Reinícios**: nenhum (somente documentação).
- **Rollback**: reverter alterações nos `.md` (não afeta runtime).
- **THREAD**: `TH-2026-01-29-release-checklist-p0p1`

---

#### 2026-01-29 — [CROSS][DOCS][OPS] Contrato humano/GPT (node manual) + `self_update` sem espera

- **O que**: reforçado contrato operacional: humano só reinicia manualmente com `node index.js`; GPT não “reinicia servidor”. Documentado comportamento real de `self_update` e regra de não ficar esperando resposta.
- **Evidência**:
  - `C:\conveniente\docs\RUNBOOK_TECNICO.md` (seções “Regra humana (restart)” e “self_update (comando) — como funciona”)
  - `C:\conveniente\docs\LIVRO_DE_BORDO.md` (regra humana)
- **Reinícios**: nenhum (somente documentação).
- **Rollback**: reverter alterações nos `.md` (não afeta runtime).

---

#### 2026-01-29 — [CROSS][DOCS][OPS] PowerShell gotchas (sem `&&`/heredoc) para commits/comandos

- **O que**: registrado “jeito certo” de rodar comandos no Windows/PowerShell (ex.: não usar `&&` e não usar heredoc `<<EOF`) para evitar GPTs repetirem tentativa/erro.
- **Evidência**: `C:\conveniente\docs\RUNBOOK_TECNICO.md` (seção “Windows/PowerShell — pegadinhas operacionais”)
- **Reinícios**: nenhum (somente documentação).
- **Rollback**: reverter alterações nos `.md` (não afeta runtime).

---

#### 2026-01-29 — [CROSS][DOCS][OPS] Vocabulário: “pull” = `self_update` (CT)

- **O que**: padronizado vocabulário humano: quando o humano disser “pull”, significa disparar `self_update` via CT (equivalente a `git pull` no host).
- **Evidência**:
  - `C:\conveniente\docs\LIVRO_DE_BORDO.md`
  - `C:\conveniente\docs\RUNBOOK_TECNICO.md`
- **Reinícios**: nenhum (somente documentação).
- **Rollback**: reverter alterações nos `.md` (não afeta runtime).

---

#### 2026-01-29 — [CROSS][DOCS][OPS] Regra: “precisa reiniciar agora?” vs “precisa reiniciar para validar”

- **O que**: registrado que nem toda atualização exige restart imediato para continuar trabalhando; restart é obrigatório quando a mudança precisa estar valendo no runtime (teste/validação).
- **Evidência**:
  - `C:\conveniente\docs\RUNBOOK_TECNICO.md` (checklist: “Precisa reiniciar agora?” + regra de restart)
  - `C:\conveniente\docs\LIVRO_DE_BORDO.md` (regra de restart)
- **Reinícios**: nenhum (somente documentação).
- **Rollback**: reverter alterações nos `.md` (não afeta runtime).

---

#### 2026-01-29 — [CROSS][DOCS] Reconstrução retroativa (~10 dias) a partir de evidências (Git/backups/recovery)

- **O que**: reconstruído histórico dos últimos ~10 dias (conveniente/sitechatbot/notificador) usando Git, logs de backups e arquivos de recovery.
- **Evidência**: `C:\conveniente\docs\checkups\checkup_2026-01-29_reconstrucao_ultimos_10_dias.md`
- **Reinícios**: nenhum (somente documentação).
- **Rollback**: reverter alterações nos `.md` (não afeta runtime).
- **THREAD**: `TH-2026-01-29-backfill-timeline`

---

#### 2026-01-29 — [CROSS][DOCS] Backfill nível 2: Cursor timeline + planos/patches + backups recebidos

- **O que**: consolidado “rastro do Cursor” (transcripts/terminals) + patches/diffs + manifests de backups recebidos pelo CT + scripts de rollback/prune.
- **Por quê**: transformar evidência espalhada (plans/backups/patches) em material pesquisável para debug e RCA.
- **Evidência**: `C:\conveniente\docs\checkups\checkup_2026-01-29_backfill_cursor_planos_patches.md`
- **Reinícios**: nenhum (somente documentação).
- **Rollback**: reverter alterações nos `.md` (não afeta runtime).
- **THREAD**: `TH-2026-01-29-backfill-cursor-plans`

---

#### 2026-01-29 — [CROSS][DOCS] Backfill nível 3: Cursor `agent-tools` (marcos reais: cmdId/requestId/git pull/push)

- **O que**: minerado `agent-tools/*.txt` do Cursor para recuperar marcos reais (ex.: `list_backups`, `bulk_gitpull_*`, `push_update`, scripts de start).
- **Por quê**: aumentar precisão de RCA/debug quando não há Git em todos os projetos e o passado está “espalhado”.
- **Evidência**: `C:\conveniente\docs\checkups\checkup_2026-01-29_backfill_cursor_agenttools.md`
- **Reinícios**: nenhum (somente documentação).
- **Rollback**: reverter alterações nos `.md` (não afeta runtime).
- **THREAD**: `TH-2026-01-29-backfill-cursor-agenttools`

---

#### 2026-01-29 — [CROSS][DOCS] Timeline retroativa (09/01 → hoje) (formato “em tempo real”)

- **O que**: criada timeline retroativa 2026-01-09 → 2026-01-29 no formato “como se fosse em tempo real”, com THREADs e evidências (Git/backups/recovery/Cursor).
- **Por quê**: deixar o “passado” rastreável para RCA/debug, sem confundir retroativo com o padrão de qualidade do “ao vivo”.
- **Evidência**: `C:\conveniente\docs\checkups\checkup_2026-01-29_timeline_retroativa_2026-01-09_a_2026-01-29.md`
- **Reinícios**: nenhum (somente documentação).
- **Rollback**: reverter alterações nos `.md` (não afeta runtime).
- **THREAD**: `TH-2026-01-29-retro-timeline-2026-01-09`

