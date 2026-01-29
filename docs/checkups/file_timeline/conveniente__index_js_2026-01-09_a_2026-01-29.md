### `conveniente/index.js` — timeline por dia/commit — 2026-01-09 → 2026-01-29

Como usar:
- Abrir diff do commit: `git show <hash>`
- Este arquivo é o bootstrap/entrada; mudanças aqui tendem a afetar boot, policies e wiring.

Cobertura real:
- commits: 11
- min: 2026-01-16 13:50:37 -0300
- max: 2026-01-29 01:12:45 -0300

---

## 2026-01-16 (2)
- 2026-01-16 14:02:05 -0300 | 6f16bba | bootstrap: fix NSSM env args (no null bytes) + run bootstrap before server
- 2026-01-16 13:50:37 -0300 | 7db161b | logs sob demanda + self_update + migrate_profiles + bootstrap service

## 2026-01-19 (4)
- 2026-01-19 21:56:07 -0300 | 36d9651 | fix: CORS local aceitar ::ffff:127.0.0.1 (Electron fetch)
- 2026-01-19 21:50:41 -0300 | 26ca165 | fix: permitir Origin null (Electron) no CORS do painel
- 2026-01-19 21:09:23 -0300 | 49fe747 | ui: no-cache no painel para updates imediatos
- 2026-01-19 19:45:11 -0300 | dd09e0b | Stock: nova conta via estoque + comandos stock_export_profiles/push

## 2026-01-22 (1)
- 2026-01-22 22:41:10 -0300 | b6bc7a7 | Add convenient auto-backup snapshots with retention

## 2026-01-28 (3)
- 2026-01-28 19:50:14 -0300 | 9bc34ba | Enterprise purge: tombstones + guaranteed server deletion (ban/2FA/manual/CT) + open-all skip
- 2026-01-28 17:28:56 -0300 | b6aabff | Boot safety: clear pending desired._openAll session on startup (no auto-resume)
- 2026-01-28 10:07:25 -0300 | 229f109 | Boot recovery for perfis.json + safer atomic writes

## 2026-01-29 (1)
- 2026-01-29 01:12:45 -0300 | 9859829 | rollback: snapshot 20260127_165414 (16:54) code-only

