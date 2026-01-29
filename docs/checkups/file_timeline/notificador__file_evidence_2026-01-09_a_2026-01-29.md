### `notificador` — evidência por arquivo/dia (sem Git) — 2026-01-09 → 2026-01-29

Objetivo: registrar **o que dá pra provar** “por arquivo” no Notificador, mesmo sem Git.

Limitação:
- No workspace atual, não há histórico versionado por arquivo do `notificador` (Git/patches/history).
- O que existe é evidência de **operação** e **snapshots por tag/horário** (sem diffs).

---

## 2026-01-09 → 2026-01-15 (operação / runtime)

Evidência de runtime (logs):
- `C:\Users\NOTIFICADOR\.cursor\projects\...\terminals\30.txt` e `...\terminals\31.txt` mostram o serviço rodando e erros `SQLITE_BUSY`/WhatsApp API no período.

Obs:
- Isso prova comportamento/instabilidade, não “mudança de código por arquivo”.

---

## 2026-01-21 → 2026-01-29 (auto-backup por tag/horário)

Fonte: `C:\notificador\_backup_auto\_snapshots.log` (inicia em 21/01).

Obs:
- snapshots ajudam para rollback por tag/horário, mas **não** dizem “o que mudou em cada arquivo”.

