### `conveniente/scripts/bootstrapService.js` — timeline por dia/commit — 2026-01-09 → 2026-01-29

Como usar:
- Abrir diff do commit: `git show <hash>`
- Este arquivo concentra automação de bootstrap/service (NSSM/task mode).

Cobertura real:
- commits: 8
- min: 2026-01-16 13:50:37 -0300
- max: 2026-01-16 14:17:57 -0300

---

## 2026-01-16 (8)
- 2026-01-16 14:17:57 -0300 | 437a9a2 | bootstrap: add task_ui mode for visible browsers (interactive)
- 2026-01-16 14:12:07 -0300 | 385c963 | bootstrap: reuse local nssm.exe (avoid download/http_503)
- 2026-01-16 14:06:30 -0300 | 5fa6984 | bootstrap: treat service-exists even with PT-BR encoding
- 2026-01-16 14:03:47 -0300 | 4ed0b2f | bootstrap: NSSM install idempotent when service already exists
- 2026-01-16 14:02:05 -0300 | 6f16bba | bootstrap: fix NSSM env args (no null bytes) + run bootstrap before server
- 2026-01-16 13:57:13 -0300 | e4ffe2e | bootstrap: auto-download NSSM when allowed
- 2026-01-16 13:53:06 -0300 | 6801d52 | bootstrap: task mode without admin (onlogon fallback) + clearer hint
- 2026-01-16 13:50:37 -0300 | 7db161b | logs sob demanda + self_update + migrate_profiles + bootstrap service

