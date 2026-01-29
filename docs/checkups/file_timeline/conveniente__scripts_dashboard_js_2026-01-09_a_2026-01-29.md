### `conveniente/scripts/dashboard.js` — timeline por dia/commit — 2026-01-09 → 2026-01-29

Como usar:
- Abrir diff do commit: `git show <hash>`
- Para perguntas de “ACK / comandos / close_all / open_all / status / fetch_logs”: este arquivo é central.

Cobertura real:
- commits: 47
- min: 2026-01-16 11:46:30 -0300
- max: 2026-01-29 02:37:55 -0300

---

## 2026-01-16 (4)
- 2026-01-16 14:39:05 -0300 | e32b86a | commands: fail unknown command types (no false ACK)
- 2026-01-16 14:36:28 -0300 | 117ba6e | logs: add logs_manifest command + expand allowlist
- 2026-01-16 13:50:37 -0300 | 7db161b | logs sob demanda + self_update + migrate_profiles + bootstrap service
- 2026-01-16 11:46:30 -0300 | afc9b59 | telemetria: enviar host.totalMemGB no /report

## 2026-01-17 (4)
- 2026-01-17 15:50:17 -0300 | 522b431 | ops: nÃ£o engolir erro em close_all/open_all (ACK confiÃ¡vel)
- 2026-01-17 15:23:48 -0300 | 3f9edf7 | ops: close_all canÃ´nico (close-all) + dashboard close_all robusto
- 2026-01-17 13:28:08 -0300 | 3ce690f | gpt: ingest automÃ¡tico de evidÃªncia (LR) para cÃ©rebro central + endpoint centralizado
- 2026-01-17 10:35:31 -0300 | 27b113b | logs: incluir login_required_events no fetch_logs

## 2026-01-19 (4)
- 2026-01-19 21:31:48 -0300 | 26526dc | stock: permitir configurar CT/secret via arquivo (set_ct_config)
- 2026-01-19 21:19:13 -0300 | cda3f1b | deploy: bloquear restart automatico no self_update (seguranca)
- 2026-01-19 19:47:11 -0300 | 0730428 | self_update: opcao restart para aplicar codigo novo
- 2026-01-19 19:45:11 -0300 | dd09e0b | Stock: nova conta via estoque + comandos stock_export_profiles/push

## 2026-01-20 (1)
- 2026-01-20 10:44:08 -0300 | 3b6813e | enterprise: provision resiliente + PIN modal guard + fb_gpt resolve

## 2026-01-21 (5)
- 2026-01-21 15:37:19 -0300 | bf4cafc | fix(messenger): auto-dismiss PIN modal in work-mode + telemetry
- 2026-01-21 14:31:04 -0300 | b461df6 | fix: stock-update store-only (no auto cookie reinject)
- 2026-01-21 14:08:57 -0300 | 96edd4d | fix: delete_perfis closes active browser before delete
- 2026-01-21 10:36:10 -0300 | 643f30c | feat: add delete_perfis remote command
- 2026-01-21 10:22:48 -0300 | 14f9d1b | feat: auto-request ct_config when missing + use ct_config.json for LOG_INGEST_SECRET

## 2026-01-22 (4)
- 2026-01-22 23:15:11 -0300 | 4ab834c | feat: add provision_unlock command and expose provision_lock in fetch_logs
- 2026-01-22 22:27:26 -0300 | 46186dd | Fix provision lock: allow owner operator + use stock_provision:<batchId>
- 2026-01-22 22:19:20 -0300 | cd474ba | Fix logs secret precedence: ct_config overrides env
- 2026-01-22 21:56:38 -0300 | 6ab1622 | Hardening stock_provision: backpressure, provision lock, retries

## 2026-01-23 (10)
- 2026-01-23 23:35:51 -0300 | 2f82c24 | ops: add profiles_cleanup command and allow fetch_logs of desired/status for audit
- 2026-01-23 23:01:44 -0300 | 3f4df53 | dashboard: route login_remediate via cluster-safe API to keep status consistent
- 2026-01-23 19:17:54 -0300 | 747695f | hardening(login_remediate): strict login detection + evidence screenshots + gpt submit fallback
- 2026-01-23 17:57:33 -0300 | 2ea38c9 | chore(login_remediate): ack correctness, retry worker startup, restore state
- 2026-01-23 17:42:15 -0300 | 3a26eab | feat(login_remediate): command + worker flow + login helpers + fresh cookies
- 2026-01-23 14:48:55 -0300 | 7243707 | audit: log created profileName during stock_provision
- 2026-01-23 14:46:51 -0300 | 243171a | audit: add provision_audit + close_all instrumentation
- 2026-01-23 14:22:34 -0300 | 8ed158d | obs: expose git HEAD via fetch_logs allowlist
- 2026-01-23 14:12:37 -0300 | 2703849 | ultra: allow close_all only when explicit human
- 2026-01-23 13:48:16 -0300 | 8ce1d43 | ultra: ram policy + provision close_all guard

## 2026-01-24 (1)
- 2026-01-24 16:22:18 -0300 | e0d5f4f | stock_provision: wait quiesce + expose busy flags

## 2026-01-25 (1)
- 2026-01-25 15:20:08 -0300 | 0b510c8 | fix: provision_lock + quiesce + appeal monitor + cooldown self-heal

## 2026-01-26 (5)
- 2026-01-26 17:07:14 -0300 | d77b7ea | Unify stock_provision via login_remediate + reentrant provisionLock + graceful-first ban close
- 2026-01-26 16:49:08 -0300 | 938fdd3 | Fix CT archive/cred fetch fallback to env + include stockAccountId
- 2026-01-26 16:33:05 -0300 | 8746279 | Prevent ban/2FA reopen + add fetch_logs_query for incident forensics
- 2026-01-26 16:16:20 -0300 | eb44bba | Harden self_update git to be non-interactive + timeout
- 2026-01-26 16:12:24 -0300 | daa8aa3 | Fix stock_provision credentials + hard kill on banned/2FA close

## 2026-01-27 (2)
- 2026-01-27 23:11:34 -0300 | fe8adb1 | Add worker hot-restart after self_update
- 2026-01-27 16:37:17 -0300 | 58c6afa | feat(uafp): export uaPresetId + emit CT uafp events

## 2026-01-28 (3)
- 2026-01-28 23:39:47 -0300 | 1814d9b | feat: export convenient backup snapshot files via command
- 2026-01-28 23:35:25 -0300 | 14f9391 | feat: convenient local backup ops (list_backups/restore_backup) + perfis autorepair
- 2026-01-28 11:11:17 -0300 | 5c62c07 | fix: lock perfis.json + repair_perfis_json remote command

## 2026-01-29 (3)
- 2026-01-29 02:37:55 -0300 | ae47f9e | diag(ack): add DASHBOARD_ACK_DEBUG logging for /api/commands/ack
- 2026-01-29 02:34:15 -0300 | 805443f | fix(delete_perfis): skip HTTP when profile missing (reduce noise + fast ack)
- 2026-01-29 01:12:45 -0300 | 9859829 | rollback: snapshot 20260127_165414 (16:54) code-only

