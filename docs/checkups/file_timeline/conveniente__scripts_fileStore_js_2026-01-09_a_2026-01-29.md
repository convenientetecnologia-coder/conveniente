### `conveniente/scripts/fileStore.js` — timeline por dia/commit — 2026-01-09 → 2026-01-29

Como usar:
- Abrir diff do commit: `git show <hash>`
- Atenção: aqui ficam locks/atomic writes/tombstones/perfis.json — muda bastante o risco de corrupção.

Cobertura real:
- commits: 10
- min: 2026-01-28 10:07:25 -0300
- max: 2026-01-29 02:21:59 -0300

---

## 2026-01-28 (7)
- 2026-01-28 23:35:25 -0300 | 14f9391 | feat: convenient local backup ops (list_backups/restore_backup) + perfis autorepair
- 2026-01-28 19:50:14 -0300 | 9bc34ba | Enterprise purge: tombstones + guaranteed server deletion (ban/2FA/manual/CT) + open-all skip
- 2026-01-28 17:28:56 -0300 | b6aabff | Boot safety: clear pending desired._openAll session on startup (no auto-resume)
- 2026-01-28 12:18:19 -0300 | 2ad6f9e | perf: master-only writes for perfis.json (IPC + lock + audit)
- 2026-01-28 11:47:27 -0300 | 554748f | fix: recover perfis.json from Chrome user data on boot
- 2026-01-28 11:11:17 -0300 | 5c62c07 | fix: lock perfis.json + repair_perfis_json remote command
- 2026-01-28 10:07:25 -0300 | 229f109 | Boot recovery for perfis.json + safer atomic writes

## 2026-01-29 (3)
- 2026-01-29 02:21:59 -0300 | d33fc85 | fix(delete_perfis): idempotent delete + guardrail against empty perfis.json
- 2026-01-29 01:43:11 -0300 | 0477b47 | fix(perfis): add withPerfisFileLockUpdate for cluster-safe perfis.json writes
- 2026-01-29 01:12:45 -0300 | 9859829 | rollback: snapshot 20260127_165414 (16:54) code-only

