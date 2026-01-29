### Checkup — Backfill “nível 3” (Cursor `agent-tools` = marcos reais) (2026-01-29)

Objetivo: extrair do Cursor o que costuma ser “ouro” para debug — **marcos reais** (cmdIds, requestIds, git pull/push, taskkill, backups), sem depender de memória humana.

Escopo: **somente reconstrução/organização** (não altera runtime).

---

## 1) Onde fica (e o que é) `agent-tools`

O Cursor salva resultados de execuções/ações do agente em arquivos `.txt` (muitas vezes JSON) chamados “agent-tools”.

Pastas usadas nesta varredura:

- `C:\Users\NOTIFICADOR\.cursor\projects\c-sitechatbot\agent-tools\`
- `C:\Users\NOTIFICADOR\.cursor\projects\c-Users-NOTIFICADOR-AppData-Roaming-Cursor-Workspaces-1768493787840-workspace-json\agent-tools\`

Esses arquivos são úteis porque frequentemente registram:
- `cmdId`, `hostId`, `requestId`, `branch`, `restart`
- outputs grandes (ex.: dumps/diagnósticos, diffs, status de jobs)

---

## 2) Como a varredura foi feita (critério)

- Janela: **últimos ~15 dias** (por `mtime` do arquivo).
- Filtro: o arquivo precisava conter pelo menos 1 keyword entre:
  - `ApplyPatch`, `restore_plan`, `_incoming_backups`, `_backup_auto`, `_snapshots.log`
  - `rollback`, `taskkill`, `node index.js`, `start_ct_puppeteer.ps1`
  - `git `, `commit`, `push`, `pull`
  - `TIMELINE.md`, `LIVRO_DE_BORDO.md`, `RUNBOOK_TECNICO.md`, `checkup_`

Resultado: **30 arquivos** com sinais relevantes.

---

## 3) Marcos “de ouro” extraídos (com evidência)

### 3.1) Conveniente: comando `list_backups` confirmou `_backup_auto/_snapshots.log` e volume de tags

Evidência (arquivo agent-tools):
- `C:\Users\NOTIFICADOR\.cursor\projects\c-Users-NOTIFICADOR-AppData-Roaming-Cursor-Workspaces-1768493787840-workspace-json\agent-tools\e5548d03-4350-439a-a0f5-1531adc4ddfe.txt`

Dados-chave:
- `cmdType`: `list_backups`
- `hostId`: `825a4485-1465-4c11-aa18-52f0597b23a3`
- `cmdId`: `326a188c-f925-44d3-a130-6e7e99a554b0`
- `baseDir`: `C:\conveniente\_backup_auto`
- `logFile`: `C:\conveniente\_backup_auto\_snapshots.log`
- `tagsCount`: **326**

Impacto para debug:
- prova objetiva de que o conveniente tem um log de snapshots local e que ele já estava “crescido” (centenas de tags).

### 3.2) “Bulk git pull” via `self_update` (CROSS: CT → servidores)

Evidência (arquivo agent-tools com payloads `self_update`):
- `C:\Users\NOTIFICADOR\.cursor\projects\c-Users-NOTIFICADOR-AppData-Roaming-Cursor-Workspaces-1768493787840-workspace-json\agent-tools\6824a330-2923-4c90-bc02-c2f92d32cd68.txt`

Sinais encontrados (exemplos):
- `requestId`: `bulk_gitpull_00ceb17_825a4485-1465-4c11-aa18-52f0597b23a3_1769453708285`
- `requestId`: `bulk_gitpull_83e1f94_825a4485-1465-4c11-aa18-52f0597b23a3_1769453072170`
- `requestId`: `bulk_gitpull_d75f985_825a4485-1465-4c11-aa18-52f0597b23a3_1769451621921`
- `branch`: `main`
- `restart`: `false`

Evidência adicional no mesmo arquivo:
- `hc_self_update_daa8aa3_rm4_1769454765616` com `reason` citando `taskkill rootPid on banned/2FA`

Impacto para debug:
- prova de que houve “rodadas” de update distribuído (git pull) identificáveis por `requestId` e commit hash no próprio id.

### 3.3) “Push update” (CT registrando jobs de push)

Evidência:
- `C:\Users\NOTIFICADOR\.cursor\projects\c-Users-NOTIFICADOR-AppData-Roaming-Cursor-Workspaces-1768493787840-workspace-json\agent-tools\4b4c1f38-3852-4f10-b3c4-45866e51d792.txt`

Sinais encontrados:
- `kind`: `push_update`
- `status`: `done`
- `host_id` (exemplos): `084c8fff-c508-47bd-a33e-3ab34aeb1e3d`, `1b0f6f98-46bf-40c6-a0f9-dad6e1965c22`

Impacto para debug:
- prova de que o CT registrava eventos de “push_update” por host (útil para correlação).

### 3.4) Inventário/uso de scripts de start do CT (puppeteer)

Evidência:
- `C:\Users\NOTIFICADOR\.cursor\projects\c-Users-NOTIFICADOR-AppData-Roaming-Cursor-Workspaces-1768493787840-workspace-json\agent-tools\772c8f0e-89e9-445b-9386-66d8230749c9.txt`

Sinais encontrados (paths):
- `C:\sitechatbot\convenientetecnologia\tools\start_ct_puppeteer.ps1`
- `...\start_ct_puppeteer_headless.ps1`
- `...\start_ct_puppeteer_ui.ps1`

Nota: logs de execução do start também aparecem nos “terminals do Cursor” (ver checkup nível 2).

---

## 4) Lista de “marcos por arquivo” (curto)

Esta lista é gerada da varredura e serve para localizar rapidamente o arquivo certo:

- `e5548d03-4350-439a-a0f5-1531adc4ddfe.txt`: `list_backups` (perfis snapshot tagsCount=326; logFile aponta `_backup_auto/_snapshots.log`)
- `6824a330-2923-4c90-bc02-c2f92d32cd68.txt`: múltiplos `self_update` com `requestId=bulk_gitpull_*` (branch main; restart=false)
- `4b4c1f38-3852-4f10-b3c4-45866e51d792.txt`: eventos `push_update` (status done) por host_id
- `772c8f0e-89e9-445b-9386-66d8230749c9.txt`: paths de scripts `start_ct_puppeteer*.ps1`

---

## 5) Próximo uso prático (como isso vira debug)

Quando aparecer um bug “começou dia X”, você consegue:
- achar o `requestId` do `bulk_gitpull_*` e correlacionar com o commit (`00ceb17`, `83e1f94`, `d75f985`, etc.)
- confirmar se o servidor estava com backups (`list_backups`/`_snapshots.log`)
- achar rastros de jobs `push_update`/`self_update` por host_id

