### `sitechatbot` (CT) — evidência por arquivo/dia (sem Git) — 2026-01-09 → 2026-01-29

Objetivo: registrar **o que dá pra provar** “por arquivo” no CT, mesmo sem Git.

Regra:
- Aqui não existe “diff por commit”; existe evidência por:
  - `restore_plan_*` / `restore_summary_*`
  - `*.HISTORY_*` (alguns arquivos)
  - snapshots (somente tags/horários; não traz conteúdo/diff)
  - terminals (runtime)

---

## 2026-01-09 → 2026-01-15 (operação / runtime)

Evidência de runtime (logs), não de mudança de código:
- `C:\Users\NOTIFICADOR\.cursor\projects\...\terminals\31.txt` (09→13)
- `C:\Users\NOTIFICADOR\.cursor\projects\c-sitechatbot\terminals\6.txt` (14→15)
- `C:\Users\NOTIFICADOR\.cursor\projects\c-sitechatbot\terminals\13.txt` (start via `start_ct_puppeteer.ps1`)

---

## 2026-01-19 (histórico por arquivo existente)

Arquivos com histórico explícito preservado:
- `C:\sitechatbot\_recovery\estoque.HISTORY_2026-01-19_211134.html`
- `C:\sitechatbot\_recovery\index.HISTORY_2026-01-19_211204.js`

Interpretação:
- prova de que o CT já guardava versões de `estoque.html` e `index.js` nesse dia.

---

## 2026-01-20 (restore/recovery — prova “por arquivo” via planos)

Artefatos:
- `C:\sitechatbot\_recovery\restore_plan_20260120_214606.json`
- `C:\sitechatbot\_recovery\restore_summary_20260120_214606.txt`
- `C:\sitechatbot\_recovery\restore_plan_20260120_214721.json`
- `C:\sitechatbot\_recovery\restore_summary_20260120_214721.txt`
- `C:\sitechatbot\_recovery\restore_plan_20260120_220220.json`
- `C:\sitechatbot\_recovery\restore_summary_20260120_220220.txt`
- `C:\sitechatbot\_recovery\index.HISTORY_2026-01-20_103603.js`

Resumo do que foi “tocado” (TOP_CHANGES, por summary):
- `restore_summary_20260120_214606.txt` (replace=3):
  - `index.js` (candWhen=2026-01-20 10:36:03)
  - `convenientetecnologia\lib\ctDb.js` (candWhen=2026-01-19 20:39:03)
  - `convenientetecnologia\lib\ctFbStock.js` (candWhen=2026-01-19 20:44:27)
- `restore_summary_20260120_220220.txt` (replace=2):
  - `convenientetecnologia\public\estoque.html` (candWhen=2026-01-19 22:45:37)
  - `convenientetecnologia\tools\ct_fix_duplicate_phones.js` (candWhen=2026-01-13 17:51:03)

Interpretação:
- 20/01 é o dia mais “auditável por arquivo” no CT, porque há plano e prova de substituição.

---

## 2026-01-21 → 2026-01-29 (auto-backup por tag/horário)

Fonte: `C:\sitechatbot\_backup_auto_root\_snapshots.log` (inicia em 21/01).

Obs:
- snapshots ajudam para rollback por tag/horário, mas **não** dizem “o que mudou em cada arquivo”.

