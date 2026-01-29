### `conveniente/scripts/api_perfis.js` — timeline por dia/commit — 2026-01-09 → 2026-01-29

Como usar:
- Abrir diff do commit: `git show <hash>`
- Este arquivo costuma concentrar endpoints e governança operacional (close_all/open_all/delete/perfis).

Cobertura real:
- commits: 38
- min: 2026-01-17 15:23:48 -0300
- max: 2026-01-29 02:21:59 -0300

---

## 2026-01-17 (2)
- 2026-01-17 15:34:10 -0300 | ce317e8 | ui: refletir close_all remoto no painel (ops em /api/status)
- 2026-01-17 15:23:48 -0300 | 3f9edf7 | ops: close_all canÃ´nico (close-all) + dashboard close_all robusto

## 2026-01-19 (1)
- 2026-01-19 19:45:11 -0300 | dd09e0b | Stock: nova conta via estoque + comandos stock_export_profiles/push

## 2026-01-20 (1)
- 2026-01-20 10:44:08 -0300 | 3b6813e | enterprise: provision resiliente + PIN modal guard + fb_gpt resolve

## 2026-01-21 (3)
- 2026-01-21 20:46:44 -0300 | b41fb62 | feat(stock): nova conta pausa Robe 24h (new_account) + check marketplace no start-work
- 2026-01-21 14:31:04 -0300 | b461df6 | fix: stock-update store-only (no auto cookie reinject)
- 2026-01-21 14:08:57 -0300 | 96edd4d | fix: delete_perfis closes active browser before delete

## 2026-01-22 (4)
- 2026-01-22 23:45:36 -0300 | 30723c3 | fix: close_all acquires lock to prevent auto-reopen and returns ok=false on failures
- 2026-01-22 22:48:08 -0300 | 944548e | Allow stock_provision owner to run start_work under provision lock
- 2026-01-22 22:27:26 -0300 | 46186dd | Fix provision lock: allow owner operator + use stock_provision:<batchId>
- 2026-01-22 21:56:38 -0300 | 6ab1622 | Hardening stock_provision: backpressure, provision lock, retries

## 2026-01-23 (4)
- 2026-01-23 23:01:44 -0300 | 3f4df53 | dashboard: route login_remediate via cluster-safe API to keep status consistent
- 2026-01-23 14:46:51 -0300 | 243171a | audit: add provision_audit + close_all instrumentation
- 2026-01-23 13:48:16 -0300 | 8ce1d43 | ultra: ram policy + provision close_all guard
- 2026-01-23 00:49:40 -0300 | 594dd4f | fix: isolate manual configure with global lock to prevent reopen/swap during cookie injection

## 2026-01-24 (1)
- 2026-01-24 00:12:29 -0300 | 6d06fca | fix(login): prevent auto loops + open-all human-only after login failure

## 2026-01-25 (2)
- 2026-01-25 21:51:13 -0300 | 646f564 | identity_detect_humanhold_1h_monitor_selfie_video
- 2026-01-25 20:17:13 -0300 | 739d936 | fix: harden human overlay + ban sweep + appeal guard + buildTag

## 2026-01-26 (4)
- 2026-01-26 17:07:14 -0300 | d77b7ea | Unify stock_provision via login_remediate + reentrant provisionLock + graceful-first ban close
- 2026-01-26 16:49:08 -0300 | 938fdd3 | Fix CT archive/cred fetch fallback to env + include stockAccountId
- 2026-01-26 16:12:24 -0300 | daa8aa3 | Fix stock_provision credentials + hard kill on banned/2FA close
- 2026-01-26 12:56:54 -0300 | 8c595ab | fix: maintenance_provision auto-recover (provisionLock pid) + endpoint release

## 2026-01-27 (8)
- 2026-01-27 23:11:34 -0300 | fe8adb1 | Add worker hot-restart after self_update
- 2026-01-27 16:03:20 -0300 | 8c890a2 | fix(delete): archive to CT Excluidas before delete (queue on fail)
- 2026-01-27 15:53:06 -0300 | 9dd8a7a | fix(open-all): clear stale login flags + don't human-only on stuck flags
- 2026-01-27 15:40:20 -0300 | 4fd4680 | fix(provision): create-PIN robust + enforce robe pause 24h on new_account
- 2026-01-27 13:46:28 -0300 | 145bc15 | fix(banflow,nurse): deletar local sempre + priorizar recurso pronto + open-all sequencial
- 2026-01-27 13:10:12 -0300 | 9d3473d | fix(open-all): ack imediato + export garantirMarketplace
- 2026-01-27 11:00:46 -0300 | 439810d | fix(identity): trigger on manual open + start_work; cooldown 2m
- 2026-01-27 10:30:05 -0300 | 534263a | fix(identity): executor 24x7 + open-all operator

## 2026-01-28 (6)
- 2026-01-28 19:50:14 -0300 | 9bc34ba | Enterprise purge: tombstones + guaranteed server deletion (ban/2FA/manual/CT) + open-all skip
- 2026-01-28 17:35:41 -0300 | 5fd5bcf | Close-all hardening: dashboard uses backend close-all; cancel open-all session during close-all
- 2026-01-28 16:07:26 -0300 | cc1563b | Open-all backend orchestration: strict order mapping-only, global pause, UI progress
- 2026-01-28 14:49:59 -0300 | 0fb616d | Open-all sequencer (dashboard order), no non-structural freeze, messenger_page_not_available => human
- 2026-01-28 14:32:16 -0300 | 6c11c30 | Policy: open/resume clears non-terminal flags; frozen no longer blocks open; open-all no prescan
- 2026-01-28 12:18:19 -0300 | 2ad6f9e | perf: master-only writes for perfis.json (IPC + lock + audit)

## 2026-01-29 (2)
- 2026-01-29 02:21:59 -0300 | d33fc85 | fix(delete_perfis): idempotent delete + guardrail against empty perfis.json
- 2026-01-29 00:30:17 -0300 | 225c756 | feat(close_all): cancel on dashboard refresh + preempt provision_lock

