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

