### Auditoria de evidências e cobertura — 2026-01-09 → 2026-01-29

Objetivo: tornar **mensurável** o quão “completo” o retroativo pode ser, e **onde** estão as lacunas inevitáveis.

Escopo: documentação/auditoria (não altera runtime).

---

## Cobertura por fonte (janela real encontrada)

- **Git (conveniente)**:
  - **Cobertura**: `2026-01-16` → `2026-01-29` (232 commits)
  - **Observação**: não há commits no repo `conveniente` entre `2026-01-09` e `2026-01-15` (ou a evolução aconteceu fora do Git / em outro repo / em outro caminho).

- **Auto-backup (CT / sitechatbot)**:
  - **Cobertura**: começa em `2026-01-21` (minTag `20260121_110746`)
  - **Arquivo**: `C:\sitechatbot\_backup_auto_root\_snapshots.log` (831 linhas)

- **Auto-backup (Notificador)**:
  - **Cobertura**: começa em `2026-01-21` (minTag `20260121_110755`)
  - **Arquivo**: `C:\notificador\_backup_auto\_snapshots.log` (392 linhas)

- **Cursor terminals (CT rodando “na prática”)**:
  - **Cobertura**: há registros explícitos de runtime em `2026-01-09`, `2026-01-10`, `2026-01-13`, `2026-01-14`, `2026-01-15`

- **Recovery/restore (CT)**:
  - **Evento principal**: `2026-01-20` (plans e summaries em `_recovery`)

---

## Auto-backup do CT (sitechatbot) — contagem por dia (tags 202601xx)

Fonte: `C:\sitechatbot\_backup_auto_root\_snapshots.log`

| Dia | Snapshots | minTag | maxTag |
|---|---:|
| 2026-01-21 | 44 | `20260121_110746` | `20260121_235153` |
| 2026-01-22 | 55 | `20260122_002153` | `20260122_233910` |
| 2026-01-23 | 103 | `20260123_000907` | `20260123_235837` |
| 2026-01-24 | 240 | `20260124_000003` | `20260124_235837` |
| 2026-01-25 | 165 | `20260125_000001` | `20260125_233417` |
| 2026-01-26 | 96 | `20260126_000157` | `20260126_234824` |
| 2026-01-27 | 49 | `20260127_001824` | `20260127_234036` |
| 2026-01-28 | 49 | `20260128_001036` | `20260128_234346` |
| 2026-01-29 | 30 | `20260129_001346` | `20260129_141415` |

Interpretação:
- A partir de 21/01 existe “prova contínua” de execução (snapshotting) e material para rollback/comparação.

---

## Auto-backup do Notificador — contagem por dia (tags 202601xx)

Fonte: `C:\notificador\_backup_auto\_snapshots.log`

| Dia | Snapshots | minTag | maxTag |
|---|---:|
| 2026-01-21 | 26 | `20260121_110755` | `20260121_233753` |
| 2026-01-22 | 48 | `20260122_000753` | `20260122_233351` |
| 2026-01-23 | 48 | `20260123_000351` | `20260123_233351` |
| 2026-01-24 | 48 | `20260124_000351` | `20260124_233350` |
| 2026-01-25 | 49 | `20260125_000350` | `20260125_234224` |
| 2026-01-26 | 48 | `20260126_001224` | `20260126_234225` |
| 2026-01-27 | 48 | `20260127_001225` | `20260127_234226` |
| 2026-01-28 | 48 | `20260128_001226` | `20260128_234406` |
| 2026-01-29 | 29 | `20260129_001406` | `20260129_141406` |

---

## Git do `conveniente` — commits por dia

Fonte: `git log --since=2026-01-09 --date=iso --pretty=format:"%ad|%h|%s"`

| Dia | Commits |
|---|---:|
| 2026-01-16 | 11 |
| 2026-01-17 | 12 |
| 2026-01-19 | 12 |
| 2026-01-20 | 1 |
| 2026-01-21 | 15 |
| 2026-01-22 | 8 |
| 2026-01-23 | 36 |
| 2026-01-24 | 12 |
| 2026-01-25 | 19 |
| 2026-01-26 | 45 |
| 2026-01-27 | 30 |
| 2026-01-28 | 22 |
| 2026-01-29 | 9 |

Interpretação:
- O “corpo” de mudanças versionadas no `conveniente` está concentrado em 16→29.

---

## `conveniente` auto-backup — inconsistência (drift) entre evidências

- **Evidência A (Cursor/agent-tools)**: `list_backups` reportou `baseDir=C:\conveniente\_backup_auto` e `logFile=C:\conveniente\_backup_auto\_snapshots.log` com `logOk=true` e `tagsCount=326`.
  - Fonte: `C:\Users\NOTIFICADOR\.cursor\projects\...\agent-tools\e5548d03-4350-439a-a0f5-1531adc4ddfe.txt`
- **Evidência B (estado atual do workspace)**: `C:\conveniente\_backup_auto\_snapshots.log` **não existe** (ENOENT ao tentar ler).

Interpretação:
- Isso é um “marco” auditável importante: ou o auto-backup do `conveniente` existiu e foi removido, ou a evidência A veio de outro estado/host/path.
- Como regra enterprise: quando há drift, registramos os dois lados e **não inventamos** o que aconteceu sem prova.

---

## Cursor terminals — evidências operacionais (09/01 → 15/01)

### Marcas relevantes (erro/instabilidade) encontradas

- **`SQLITE_BUSY` / “database is locked” (CT WhatsApp)**:
  - Evidência: `C:\Users\NOTIFICADOR\.cursor\projects\c-Users-NOTIFICADOR-AppData-Roaming-Cursor-Workspaces-1767798316519-workspace-json\terminals\31.txt`
  - Timestamps: `2026-01-09T20:16:23.263Z` (inbox) e `2026-01-09T21:36:19.722Z` (outbox/worker)

- **Falhas WhatsApp API `(#131000)` + retries**:
  - Evidência: `...\terminals\26.txt`, `...\terminals\31.txt`, `C:\Users\NOTIFICADOR\.cursor\projects\c-sitechatbot\terminals\6.txt`
  - Timestamps: 09/01 e 14/01–15/01 (múltiplas tentativas e backoff)

- **Migração falhou: `no such column: driver_id`**:
  - Evidência: `...\terminals\30.txt`
  - Timestamp: `2026-01-09T20:03:02.461Z` (mensagem do CT)

- **Outbox “preso em sending” e reenfileirado**:
  - Evidência: `...\terminals\29.txt`
  - Timestamp: `2026-01-09T20:01:26.026Z` (`Reenfileirados 2 outbox presos em sending`)

### Arquivos/intervalos (para referência rápida)

| Terminal | Primeira evidência | Última evidência | Observação |
|---|---|---|---|
| `...\terminals\31.txt` | 2026-01-09T20:05:36Z | 2026-01-13T12:22:40Z | maior “janela contínua” 09→13 (inclui erros/timeout) |
| `...\terminals\26.txt` | 2026-01-09T18:24:23Z | 2026-01-09T18:27:26Z | sequência de retries do outbox (#131000) |
| `...\terminals\29.txt` | 2026-01-09T19:59:26Z | 2026-01-09T20:01:26Z | reenfileiramento de outbox preso |
| `c-sitechatbot\\terminals\\6.txt` | 2026-01-14T21:07:21Z | 2026-01-15T13:47:28Z | erros WhatsApp API e retries 14→15 |
| `c-sitechatbot\\terminals\\13.txt` | 2026-01-15T16:03:07Z | 2026-01-15T16:03:07Z | start do CT via script `start_ct_puppeteer.ps1` |

---

## CT recovery/restore (20/01) — planos e resumos

### Restore plan principal (22:02)

- **Arquivo**: `C:\sitechatbot\_recovery\restore_plan_20260120_220220.json`
- **Resumo**: `C:\sitechatbot\_recovery\restore_summary_20260120_220220.txt`
- **TOP_CHANGES** (replace=2):
  - `convenientetecnologia\public\estoque.html` (candWhen=2026-01-19 22:45:37)
  - `convenientetecnologia\tools\ct_fix_duplicate_phones.js` (candWhen=2026-01-13 17:51:03)

### Plans anteriores (21:46 / 21:47)

- **Resumo**: `restore_summary_20260120_214606.txt` e `restore_summary_20260120_214721.txt`
- **TOP_CHANGES** (replace=3):
  - `index.js` (candWhen=2026-01-20 10:36:03)
  - `convenientetecnologia\lib\ctDb.js` (candWhen=2026-01-19 20:39:03)
  - `convenientetecnologia\lib\ctFbStock.js` (candWhen=2026-01-19 20:44:27)

Interpretação:
- 20/01 é um “marco” real de **restauração/ajuste do CT** (mudança por plano, não por Git).

---

## Backups recebidos do `conveniente` via CT (27/01)

Fonte: `C:\sitechatbot\_incoming_backups\825a4485-1465-4c11-aa18-52f0597b23a3\backup_20260127_*\_manifest.json`

| Tag | cmdId | filesCount | Destaques |
|---|---|---:|---|
| `20260127_162416` | `a3ffdf09-d348-4b6e-88da-adf32c4c9706` | 9 | `scripts\\worker.js`, `scripts\\dashboard.js`, `scripts\\fileStore.js` |
| `20260127_165414` | `f6a2d5cb-e008-4365-abef-e6d2f353ce18` | 9 | `scripts\\worker.js`, `scripts\\dashboard.js`, `public\\index.html` |
| `20260127_172414` | `5f38f5fb-b242-446a-99c9-24ff916078d7` | 9 | `scripts\\worker.js`, `scripts\\dashboard.js`, `scripts\\provisionLock.js` |

Interpretação:
- esses manifests são “prova de transporte” (CT recebeu cópias do `conveniente`), úteis para auditoria/rollback.

---

## Cursor agent-tools — marcos operacionais (sem depender de Git)

- **`list_backups` (conveniente)**:
  - Arquivo: `C:\Users\NOTIFICADOR\.cursor\projects\...\agent-tools\e5548d03-4350-439a-a0f5-1531adc4ddfe.txt`
  - `cmdType=list_backups`
  - `receivedAt=1769654283847` → `2026-01-29T02:38:03.847Z`

Observação:
- outros arquivos de agent-tools relevantes (`bulk_gitpull_*`, `push_update`) existem, mas alguns contêm “terminal output” acoplado (não JSON puro). A timeline retroativa referencia esses arquivos pelo nome (e o conteúdo pode ser aberto quando necessário).

---

## Ledger canônico de commits do `conveniente` (por horário)

Arquivo:
- `C:\conveniente\docs\checkups\audit_2026-01-29_conveniente_git_ledger_2026-01-16_a_2026-01-29.md`

---

## Changesets do Git (por commit: A/M/D/R)

Arquivo:
- `C:\conveniente\docs\checkups\audit_2026-01-29_conveniente_git_changesets_2026-01-16_a_2026-01-29.md`

---

## Hotspots (onde mais mudou)

Arquivo:
- `C:\conveniente\docs\checkups\audit_2026-01-29_conveniente_git_hotspots_2026-01-16_a_2026-01-29.md`


