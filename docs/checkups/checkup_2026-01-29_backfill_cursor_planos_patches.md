### Checkup — Backfill “nível 2” (Cursor timeline + planos/patches + backups) (2026-01-29)

Objetivo: transformar “coisas espalhadas” (Cursor, backups, recovery, patches, scripts de rollback) em **evidência pesquisável** para debugs.

Escopo: **somente reconstrução/organização** (não altera runtime).

---

## 0) O que é “timeline do Cursor” na prática (e o que foi usado aqui)

O Cursor guarda rastros úteis em disco (mesmo sem Git), principalmente:

- **Transcripts do agente (conversas + tool calls + paths)**:
  - `C:\Users\NOTIFICADOR\.cursor\projects\c-Users-NOTIFICADOR-AppData-Roaming-Cursor-Workspaces-1768493787840-workspace-json\agent-transcripts\08122b98-f4ea-460a-a92a-cfc841e61730.txt`
  - `C:\Users\NOTIFICADOR\.cursor\projects\c-Users-NOTIFICADOR-AppData-Roaming-Cursor-Workspaces-1768493787840-workspace-json\agent-transcripts\d81faf11-3398-48ff-821c-268d6cbf4982.txt`

- **Logs de terminal capturados pelo Cursor** (com comando e output):
  - `C:\Users\NOTIFICADOR\.cursor\projects\c-sitechatbot\terminals\*.txt`
  - `C:\Users\NOTIFICADOR\.cursor\projects\c-Users-NOTIFICADOR-AppData-Roaming-Cursor-Workspaces-1767798316519-workspace-json\terminals\*.txt`

Uso recomendado para debug:
- o transcript é o “**quem fez o quê**” (até com `ApplyPatch` e caminhos).
- os terminais são o “**o que rodou e o que respondeu**” (logs e erros reais).

---

## 1) Backups + “planos” que já existem no disco (ouro)

### 1.1) `sitechatbot` — snapshots automáticos (prova de continuidade)

Arquivo:
- `C:\sitechatbot\_backup_auto_root\_snapshots.log`

Evidência objetiva já extraída no checkup anterior:
- existe uma sequência de snapshots de `20260121_...` até `20260129_...` (alta cadência).

### 1.2) `notificador` — snapshots automáticos (prova de continuidade)

Arquivo:
- `C:\notificador\_backup_auto\_snapshots.log`

Evidência objetiva já extraída no checkup anterior:
- existe uma sequência de snapshots de `20260121_...` até `20260129_...`.

### 1.3) `sitechatbot/_recovery` — recovery com “histórico por arquivo” (prova)

Arquivos (exemplos):
- `C:\sitechatbot\_recovery\index.HISTORY_2026-01-19_211204.js`
- `C:\sitechatbot\_recovery\index.HISTORY_2026-01-20_103603.js`
- `C:\sitechatbot\_recovery\estoque.HISTORY_2026-01-19_211134.html`

Esses `*.HISTORY_*` provam que **houve versões guardadas** (por arquivo) em datas específicas.

### 1.4) `sitechatbot/_recovery` — restore_plan / restore_summary (prova)

Arquivos (existem):
- `C:\sitechatbot\_recovery\restore_plan_20260120_214606.json`
- `C:\sitechatbot\_recovery\restore_plan_20260120_214721.json`
- `C:\sitechatbot\_recovery\restore_plan_20260120_220220.json`
- `C:\sitechatbot\_recovery\restore_summary_*.txt`

O que isso dá:
- “plano” formal de substituição de arquivos e resumo do que foi/seria alterado (ótimo para timeline retroativa).

---

## 2) Patches/diffs e “planos operacionais” (ouro para debugs)

### 2.1) Patches de diff (conveniente atual vs snapshot 20260127_165414)

Diretório:
- `C:\sitechatbot\_incoming_backups\_diff_current_vs_20260127_165414\`

Arquivos encontrados:
- `diff_index.js.patch`
- `diff_scripts__fileStore.js.patch`
- `diff_scripts__worker.js.patch`
- `diff_scripts__dashboard.js.patch`
- `diff_public__index.html.patch`
- `diff_package-lock.json.patch`

Exemplos de “marcos” que esses patches provam:
- `index.js`: adicionou rotinas de boot “militar” (limpar open-all pendurado, recover perfis.json, sweeps) (`diff_index.js.patch`).
- `fileStore.js`: crescimento grande (tombstones, provision_audit, writeJsonAtomic com .bak, sweeps) (`diff_scripts__fileStore.js.patch`).
- `dashboard.js`: `close_all` deferido com deadline + `repair_perfis_json` (recuperação) (`diff_scripts__dashboard.js.patch`).
- `worker.js`: auto-recovery de `perfis.json` no boot (a partir do Chrome User Data) e integração com master (`diff_scripts__worker.js.patch`).
- `public/index.html`: anti-flicker + progresso do “Abrir Todos” refletido no dashboard (`diff_public__index.html.patch`).
- `package-lock.json`: entrou `pidusage` e `ps-list` (instrumentação de processos/RAM) (`diff_package-lock.json.patch`).

### 2.2) Patches de diff (worker/dashboard entre snapshots 16:24 vs 16:54)

Arquivos:
- `C:\sitechatbot\_incoming_backups\_diff_worker_1624_vs_1654.patch`
- `C:\sitechatbot\_incoming_backups\_diff_dashboard_1624_vs_1654.patch`

Marco “CROSS” muito importante (prova de contrato):
- em `worker.js` apareceu **UA+FP telemetry -> CT**, chamando:
  - `POST ${CT_BASE_URL}/api/stock/uafp_event_secret` (com `X-Log-Secret`)
  - isso cria dependência direta CT ⇄ conveniente para observabilidade de captcha/identity/banned/2FA.

---

## 3) Backups “recebidos” pelo CT (export de snapshot do conveniente)

Diretório (prova de recebimento):
- `C:\sitechatbot\_incoming_backups\825a4485-1465-4c11-aa18-52f0597b23a3\backup_20260127_*\`

Arquivos `_manifest.json` (prova de cada export):
- `...\backup_20260127_162416\_manifest.json`
- `...\backup_20260127_165414\_manifest.json`
- `...\backup_20260127_172414\_manifest.json`

O que o manifest prova:
- `host` (origem) + `cmd` (id do comando) + `ackPath` (ack no CT) + `tag`.
- exportou um conjunto consistente de 9 arquivos (ex.: `index.js`, `public/index.html`, `scripts/dashboard.js`, `scripts/worker.js`, etc.).

---

## 4) “Planos” operacionais (PowerShell) já prontos

Scripts:
- `C:\sitechatbot\ops\rollback_conveniente_code_from_local_backup.ps1`
  - rollback **somente código** do `conveniente` a partir de `C:\conveniente\_backup_auto\<TAG>\`
  - faz backup do estado atual em `C:\conveniente\_manual_backup_before_rollback\...`
  - verifica integridade com SHA256
- `C:\sitechatbot\ops\perfis_audit_prune.ps1`
  - auditoria + prune “SAFE” de `perfis.json` e `desired.json`
  - suporta baseline do backup (tag) e usa `provision_audit.jsonl` recente como sinal

Isso é material “ouro” para incidentes porque define:
- escopo (não mexe em `dados/` no rollback de código),
- guardrails,
- e validação pós-ação (hash).

---

## 5) Conclusão: o que foi “adicionado ao banco de dados do passado”

Sem depender de memória humana, agora dá para reconstruir com prova:
- **Export de snapshots do conveniente** para o CT (via `_incoming_backups` + `_manifest.json`).
- **Diferenças exatas** (patches) entre snapshot e estado atual (e entre snapshots).
- **Planos de restore/recovery** no CT (`restore_plan`/`restore_summary` + `*.HISTORY_*`).
- **Comandos realmente executados** e logs reais (terminals do Cursor).

Próximo passo recomendado (documentação):
- criar uma entrada `[CROSS][DOCS]` no `docs/TIMELINE.md` apontando para este checkup e usar `THREAD=...`.

