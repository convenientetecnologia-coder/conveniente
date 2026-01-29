### Changesets (auditoria) — `conveniente` — 2026-01-16 → 2026-01-29

Objetivo: deixar **auditável por commit** a lista exata de arquivos alterados (A/M/D/R).

Como usar (debug/forense):
- Ver diff de um commit: `git show <hash>`
- Ver apenas arquivos: `git show --name-status <hash>`
- Procurar “quando esse arquivo mudou”: `git log --name-status -- <path>`

Notas:
- Ordem: **cronológica** (`--reverse`).
- O conteúdo é construído em blocos para evitar truncamento de logs.

---

### 2026-01-16 11:46:30 -0300 | afc9b59 | telemetria: enviar host.totalMemGB no /report

A	.gitignore
M	scripts/dashboard.js

### 2026-01-16 13:50:37 -0300 | 7db161b | logs sob demanda + self_update + migrate_profiles + bootstrap service

M	index.js
A	scripts/bootstrapService.js
M	scripts/dashboard.js

### 2026-01-16 13:53:06 -0300 | 6801d52 | bootstrap: task mode without admin (onlogon fallback) + clearer hint

M	scripts/bootstrapService.js

### 2026-01-16 13:57:13 -0300 | e4ffe2e | bootstrap: auto-download NSSM when allowed

M	scripts/bootstrapService.js

### 2026-01-16 14:02:05 -0300 | 6f16bba | bootstrap: fix NSSM env args (no null bytes) + run bootstrap before server

M	index.js
M	scripts/bootstrapService.js

### 2026-01-16 14:03:47 -0300 | 4ed0b2f | bootstrap: NSSM install idempotent when service already exists

M	scripts/bootstrapService.js

### 2026-01-16 14:06:30 -0300 | 5fa6984 | bootstrap: treat service-exists even with PT-BR encoding

M	scripts/bootstrapService.js

### 2026-01-16 14:12:07 -0300 | 385c963 | bootstrap: reuse local nssm.exe (avoid download/http_503)

M	scripts/bootstrapService.js

### 2026-01-16 14:17:57 -0300 | 437a9a2 | bootstrap: add task_ui mode for visible browsers (interactive)

M	scripts/bootstrapService.js

### 2026-01-16 14:36:28 -0300 | 117ba6e | logs: add logs_manifest command + expand allowlist

M	scripts/dashboard.js

### 2026-01-16 14:39:05 -0300 | e32b86a | commands: fail unknown command types (no false ACK)

M	scripts/dashboard.js

### 2026-01-17 10:35:31 -0300 | 27b113b | logs: incluir login_required_events no fetch_logs

M	scripts/browser.js
M	scripts/dashboard.js
M	scripts/worker.js

### 2026-01-17 10:49:00 -0300 | 9693db5 | fix: worker os duplicate require

M	scripts/worker.js

### 2026-01-17 10:58:07 -0300 | 176f2df | lr: registrar evidÃªncia quando flag LR jÃ¡ estÃ  setada (snapshot)

M	scripts/worker.js

### 2026-01-17 11:10:12 -0300 | 9e414c2 | lr: registrar snapshot quando nÃ£o hÃ  pÃ¡ginas (cria login_required_events)

M	scripts/worker.js

### 2026-01-17 12:24:12 -0300 | 62e10c6 | fb: separar captcha_persona de checkpoint_captcha

M	scripts/browser.js

### 2026-01-17 13:28:08 -0300 | 3ce690f | gpt: ingest automÃ¡tico de evidÃªncia (LR) para cÃ©rebro central + endpoint centralizado

M	scripts/dashboard.js
A	scripts/gptFallback.js
A	scripts/notifierEndpoints.js
M	scripts/worker.js

### 2026-01-17 15:03:10 -0300 | e448690 | perf: governor SLOW por loop-lag (sem WMI) + virtus slowMode

M	scripts/virtus.js
M	scripts/worker.js

### 2026-01-17 15:04:34 -0300 | e8d0ed6 | perf: reiniciar runner do virtus quando governor muda de modo

M	scripts/worker.js

### 2026-01-17 15:23:48 -0300 | 3f9edf7 | ops: close_all canÃ´nico (close-all) + dashboard close_all robusto

M	scripts/api_perfis.js
M	scripts/dashboard.js

### 2026-01-17 15:34:10 -0300 | ce317e8 | ui: refletir close_all remoto no painel (ops em /api/status)

M	public/index.html
M	scripts/api_perfis.js
M	scripts/api_status.js
A	scripts/opsState.js

### 2026-01-17 15:50:17 -0300 | 522b431 | ops: nÃ£o engolir erro em close_all/open_all (ACK confiÃ¡vel)

M	scripts/dashboard.js

### 2026-01-17 17:33:04 -0300 | f7f77ee | ui: estado final Ãºnico por conta (sem duplicidade login/limite/captcha)

M	public/index.html

### 2026-01-19 19:45:11 -0300 | dd09e0b | Stock: nova conta via estoque + comandos stock_export_profiles/push

M	index.js
M	public/index.html
M	scripts/api_perfis.js
A	scripts/api_stock.js
M	scripts/dashboard.js

### 2026-01-19 19:47:11 -0300 | 0730428 | self_update: opcao restart para aplicar codigo novo

M	scripts/dashboard.js

### 2026-01-19 21:06:03 -0300 | efbfa6d | stock: robustecer nova conta (estoque CT) + debug

M	public/index.html
M	scripts/api_stock.js
M	scripts/notifierEndpoints.js

### 2026-01-19 21:09:23 -0300 | 49fe747 | ui: no-cache no painel para updates imediatos

M	index.js

### 2026-01-19 21:19:13 -0300 | cda3f1b | deploy: bloquear restart automatico no self_update (seguranca)

M	scripts/dashboard.js

### 2026-01-19 21:31:48 -0300 | 26526dc | stock: permitir configurar CT/secret via arquivo (set_ct_config)

M	scripts/api_stock.js
A	scripts/ctConfig.js
M	scripts/dashboard.js
M	scripts/notifierEndpoints.js

### 2026-01-19 21:50:41 -0300 | 26ca165 | fix: permitir Origin null (Electron) no CORS do painel

M	index.js

### 2026-01-19 21:56:07 -0300 | 36d9651 | fix: CORS local aceitar ::ffff:127.0.0.1 (Electron fetch)

M	index.js

### 2026-01-19 21:59:18 -0300 | e394917 | fix: painel sem Electron (fallback listPerfis/getStatus)

M	public/index.html

### 2026-01-19 22:07:12 -0300 | 51085d5 | ui: diagnostico enterprise no modal Nova Conta (estoque)

M	public/index.html

### 2026-01-19 22:10:35 -0300 | 638b763 | fix: escapeHtml no modal Nova Conta + logar excecao real

M	public/index.html

### 2026-01-19 22:24:58 -0300 | 452f0a3 | ui: remover toast de sucesso no Nova Conta

M	public/index.html

### 2026-01-20 10:44:08 -0300 | 3b6813e | enterprise: provision resiliente + PIN modal guard + fb_gpt resolve

M	scripts/api_perfis.js
M	scripts/browser.js
M	scripts/dashboard.js
M	scripts/gptFallback.js
M	scripts/worker.js

### 2026-01-21 10:22:48 -0300 | 14f9d1b | feat: auto-request ct_config when missing + use ct_config.json for LOG_INGEST_SECRET

M	scripts/dashboard.js
M	scripts/gptFallback.js

### 2026-01-21 10:36:10 -0300 | 643f30c | feat: add delete_perfis remote command

M	scripts/dashboard.js

### 2026-01-21 14:08:57 -0300 | 96edd4d | fix: delete_perfis closes active browser before delete

M	scripts/api_perfis.js
M	scripts/dashboard.js

### 2026-01-21 14:31:04 -0300 | b461df6 | fix: stock-update store-only (no auto cookie reinject)

M	scripts/api_perfis.js
M	scripts/dashboard.js

### 2026-01-21 15:17:30 -0300 | 781e2c8 | fix(messenger): dismiss PIN restore modal + continue-without-restore

M	scripts/browser.js

### 2026-01-21 15:37:19 -0300 | bf4cafc | fix(messenger): auto-dismiss PIN modal in work-mode + telemetry

M	scripts/api_status.js
M	scripts/browser.js
M	scripts/dashboard.js
M	scripts/worker.js

### 2026-01-21 15:53:07 -0300 | 3af95ba | fix(messenger): scan all tabs for PIN modal + audit logs

M	scripts/browser.js
M	scripts/worker.js

### 2026-01-21 15:57:31 -0300 | 0588e91 | feat(messenger): nurse GPT fallback + richer pin telemetry

M	scripts/browser.js
M	scripts/worker.js

### 2026-01-21 16:25:31 -0300 | d6e0d4d | feat(ui): detect identity confirmation (selfie video) as loginRequired

M	scripts/browser.js

### 2026-01-21 16:32:45 -0300 | f5c3b42 | feat(ui): scan all tabs for loginRequired + auto humanHold on identity

M	scripts/worker.js

### 2026-01-21 16:41:42 -0300 | b894426 | feat: automaÃ§Ã£o de PIN do Messenger - digita 882584 automaticamente quando modal aparece

M	scripts/browser.js

### 2026-01-21 16:43:11 -0300 | 40aa6b8 | Revert "feat: automaÃ§Ã£o de PIN do Messenger - digita 882584 automaticamente quando modal aparece"

M	scripts/browser.js

### 2026-01-21 16:50:17 -0300 | 08a286a | feat: automaÃ§Ã£o completa de PIN - digita 882584 automaticamente e usa GPT para confirmaÃ§Ã£o

M	scripts/browser.js

### 2026-01-21 20:37:29 -0300 | 75c8aa0 | feat(ui): nova conta manual - seletor de categoria (fretes/veiculos)

M	public/index.html

### 2026-01-21 20:46:44 -0300 | b41fb62 | feat(stock): nova conta pausa Robe 24h (new_account) + check marketplace no start-work

M	scripts/api_perfis.js
M	scripts/worker.js

### 2026-01-22 21:56:38 -0300 | 6ab1622 | Hardening stock_provision: backpressure, provision lock, retries

M	.gitignore
M	scripts/api_perfis.js
M	scripts/dashboard.js
A	scripts/provisionLock.js
M	scripts/supervisor.js
M	scripts/worker.js

### 2026-01-22 22:19:20 -0300 | cd474ba | Fix logs secret precedence: ct_config overrides env

M	scripts/dashboard.js

### 2026-01-22 22:27:26 -0300 | 46186dd | Fix provision lock: allow owner operator + use stock_provision:<batchId>

M	scripts/api_perfis.js
M	scripts/clusterMaster.js
M	scripts/dashboard.js
M	scripts/provisionLock.js
M	scripts/supervisor.js
M	scripts/supervisorClient.js
M	scripts/worker.js

### 2026-01-22 22:41:10 -0300 | b6bc7a7 | Add convenient auto-backup snapshots with retention

M	index.js

### 2026-01-22 22:48:08 -0300 | 944548e | Allow stock_provision owner to run start_work under provision lock

M	scripts/api_perfis.js
M	scripts/worker.js

### 2026-01-22 23:09:16 -0300 | c3ec39a | fix: pass operator to automationAllowed in start_work

M	scripts/worker.js

### 2026-01-22 23:15:11 -0300 | 4ab834c | feat: add provision_unlock command and expose provision_lock in fetch_logs

M	scripts/dashboard.js

### 2026-01-22 23:45:36 -0300 | 30723c3 | fix: close_all acquires lock to prevent auto-reopen and returns ok=false on failures

M	scripts/api_perfis.js

### 2026-01-23 00:49:40 -0300 | 594dd4f | fix: isolate manual configure with global lock to prevent reopen/swap during cookie injection

M	scripts/api_perfis.js

### 2026-01-23 13:48:16 -0300 | 8ce1d43 | ultra: ram policy + provision close_all guard

M	scripts/api_perfis.js
M	scripts/dashboard.js
A	scripts/ramPolicy.js
M	scripts/supervisor.js
M	scripts/worker.js

### 2026-01-23 14:11:34 -0300 | 3391475 | ultra: limit swap_for_open + pause virtus during provision

M	scripts/worker.js

### 2026-01-23 14:12:37 -0300 | 2703849 | ultra: allow close_all only when explicit human

M	scripts/dashboard.js

### 2026-01-23 14:13:57 -0300 | 3bb17b8 | docs: ultra enterprise provision policy

A	docs/provision_ultra_enterprise.md

### 2026-01-23 14:22:34 -0300 | 8ed158d | obs: expose git HEAD via fetch_logs allowlist

M	scripts/dashboard.js

### 2026-01-23 14:46:51 -0300 | 243171a | audit: add provision_audit + close_all instrumentation

M	scripts/api_perfis.js
M	scripts/dashboard.js
A	scripts/provisionAudit.js

### 2026-01-23 14:48:55 -0300 | 7243707 | audit: log created profileName during stock_provision

M	scripts/dashboard.js

### 2026-01-23 15:05:49 -0300 | 97236e3 | audit: log worker hardClose/deactivate to provision_audit

M	scripts/worker.js

### 2026-01-23 15:23:09 -0300 | ffc62a2 | fix: sticky shard rebalance (no mass shard_moved) + cap worker shard moves

M	scripts/clusterMaster.js
M	scripts/worker.js

### 2026-01-23 17:42:15 -0300 | 3a26eab | feat(login_remediate): command + worker flow + login helpers + fresh cookies

M	scripts/browser.js
M	scripts/dashboard.js
M	scripts/worker.js
M	scripts/workerClient.js

### 2026-01-23 17:50:47 -0300 | fd66267 | fix(login_remediate): resume virtus after remediation

M	scripts/worker.js

### 2026-01-23 17:57:33 -0300 | 2ea38c9 | chore(login_remediate): ack correctness, retry worker startup, restore state

M	scripts/dashboard.js
M	scripts/worker.js

### 2026-01-23 18:37:19 -0300 | 61ebe1f | fix(login_remediate): hard timeouts + fail-fast + incremental audit

M	scripts/worker.js

### 2026-01-23 18:56:50 -0300 | 2eb0b97 | feat(login_remediate): fetch credentials from CT when manifest missing

M	scripts/worker.js

### 2026-01-23 19:06:58 -0300 | 048ed09 | fix(login_remediate): optional override of humanHold for explicit runs

M	scripts/worker.js

### 2026-01-23 19:17:54 -0300 | 747695f | hardening(login_remediate): strict login detection + evidence screenshots + gpt submit fallback

M	scripts/browser.js
M	scripts/dashboard.js
M	scripts/worker.js

### 2026-01-23 19:33:31 -0300 | 43c4d7f | fix(login_remediate): treat captcha as requires_human; avoid false success

M	scripts/browser.js
M	scripts/worker.js

### 2026-01-23 19:58:22 -0300 | 6eaacf6 | login_remediate: GPT eyes for consent/popups; block false positives

M	scripts/browser.js
M	scripts/worker.js

### 2026-01-23 20:18:54 -0300 | 9536768 | login_remediate: failfast deactivate timeout to avoid no-ack hangs

M	scripts/worker.js

### 2026-01-23 20:32:08 -0300 | 80872d6 | messenger pin: default 882584 (env override MESSENGER_PIN)

M	scripts/browser.js

### 2026-01-23 20:35:13 -0300 | bf43d6c | ui_unblock: handle messenger PIN modal + harden captcha_persona detection

M	scripts/browser.js

### 2026-01-23 20:42:39 -0300 | 8724df4 | pin modal: handle 'Mais opÃ§Ãµes' flow + skip; reduce ui_blocked false negatives

M	scripts/browser.js

### 2026-01-23 20:51:00 -0300 | 0b52023 | consent unblock: allow safe GPT clicks outside dialog + recheck consent exit

M	scripts/browser.js

### 2026-01-23 20:59:43 -0300 | 4178f6d | consent flow: click ComeÃ§ar/Confirmar; safe GPT hints full-page; dialog okwords

M	scripts/browser.js

### 2026-01-23 21:05:56 -0300 | 6f5a4ea | consent: include Fechar/X in unblock (deterministic + safe hints)

M	scripts/browser.js

### 2026-01-23 21:36:33 -0300 | c1bfed2 | login_remediate: validate real tabs (messenger + marketplace create) and open create/item

M	scripts/browser.js
M	scripts/worker.js

### 2026-01-23 21:59:51 -0300 | 563695d | login_remediate: post-success close browser, reopen closedForRam, start_work

M	scripts/worker.js

### 2026-01-23 22:16:46 -0300 | 98a1d1c | login_remediate: fix post-success deadlock; activateOnce+startVirtus; close target without handlers

M	scripts/worker.js

### 2026-01-23 22:30:39 -0300 | 477031c | login_remediate: set desired active+virtus on after success to prevent immediate shutdown

M	scripts/worker.js

### 2026-01-23 22:56:03 -0300 | a292da2 | status: include _debug controllersCount/pid per node to diagnose zero-active dashboard

M	scripts/clusterMaster.js
M	scripts/worker.js

### 2026-01-23 23:01:44 -0300 | 3f4df53 | dashboard: route login_remediate via cluster-safe API to keep status consistent

M	scripts/api_perfis.js
M	scripts/dashboard.js

### 2026-01-23 23:09:41 -0300 | 9c2afa3 | login_remediate: deterministic post-success (desired+nudge+activate retries, defer to nurse if needed)

M	scripts/worker.js

### 2026-01-23 23:25:38 -0300 | 6d771c7 | docs: ultra enterprise system audit (provision, login_remediate, telemetry, stock UI)

A	docs/ultra_enterprise_system_audit_2026-01-24.md

### 2026-01-23 23:35:51 -0300 | 2f82c24 | ops: add profiles_cleanup command and allow fetch_logs of desired/status for audit

M	scripts/dashboard.js

### 2026-01-23 23:59:44 -0300 | b296cc3 | feat(worker): auto login_remediate when loginRequired detected

M	scripts/worker.js

### 2026-01-24 00:12:29 -0300 | 6d06fca | fix(login): prevent auto loops + open-all human-only after login failure

M	scripts/api_perfis.js
M	scripts/api_status.js
M	scripts/worker.js

### 2026-01-24 00:33:55 -0300 | be77706 | fix(login_remediate): validate messenger+facebook by URL; keep real captcha reason

M	scripts/worker.js

### 2026-01-24 01:00:24 -0300 | 1ec81e7 | fix(login): robust submit + messenger login detection + human invoke + UI flag

M	public/index.html
M	scripts/browser.js
M	scripts/worker.js

### 2026-01-24 01:16:51 -0300 | 495cff4 | fix(login): detect 2FA; fail-fast on any non-automatable; human mode ensure visible page

M	scripts/browser.js
M	scripts/worker.js

### 2026-01-24 01:29:56 -0300 | 69fffd8 | fix(login): detect 2FA/checkpoint by URL path; prevent black screen in human mode on open

M	scripts/browser.js
M	scripts/worker.js

### 2026-01-24 01:44:09 -0300 | ae979e1 | fix(human-resume): clear loginRemediateFailed + remove blank tabs + suppress blank-killer during configure

M	scripts/worker.js

### 2026-01-24 02:12:29 -0300 | e81922c | fix(login_required): stop virtus; validate marketplace create/item; retry ui unblock; improve UI labels

M	public/index.html
M	scripts/worker.js

### 2026-01-24 16:07:39 -0300 | a21fdfc | audit: log virtus pause during provision lock

M	scripts/worker.js

### 2026-01-24 16:22:18 -0300 | e0d5f4f | stock_provision: wait quiesce + expose busy flags

M	scripts/dashboard.js
M	scripts/worker.js

### 2026-01-24 16:46:18 -0300 | c578a81 | status: expose virtusOnline/sendLock/robeExec in get-status

M	scripts/worker.js

### 2026-01-24 17:11:07 -0300 | cb9b8de | quiesce: require global pause before cookie inject (configure/login_remediate)

M	scripts/worker.js

### 2026-01-24 18:15:58 -0300 | 5e85a25 | configure: resume paused virtus; human-resume sets desired virtus on

M	scripts/worker.js

### 2026-01-25 15:20:08 -0300 | 0b510c8 | fix: provision_lock + quiesce + appeal monitor + cooldown self-heal

M	scripts/browser.js
M	scripts/dashboard.js
M	scripts/provisionLock.js
M	scripts/worker.js

### 2026-01-25 15:34:13 -0300 | 7cbd0ca | fix: configure uses cookies->login->human with quiesce/headroom

M	scripts/worker.js

### 2026-01-25 15:37:52 -0300 | 6036eeb | fix: manual configure resumes work; require provisionLock; unfreeze cooldown on resume

M	scripts/worker.js

### 2026-01-25 16:47:46 -0300 | 75746f2 | audit: add detailed configure_* events to provision_audit for E2E evidence

M	scripts/worker.js

### 2026-01-25 17:17:56 -0300 | c9c806f | fix: human-resume runs preflight; if login_required schedule login_remediate + robe24h; if banned/captcha/identity invoke human

M	scripts/worker.js

### 2026-01-25 17:32:43 -0300 | 1b64825 | fix: detect disabled_checkpoint (Desabilitamos sua conta) and abort login_remediate as banned with audit logs

M	scripts/browser.js
M	scripts/worker.js

### 2026-01-25 17:47:15 -0300 | d1a5c1d | fix(ui): show banned instead of login/cookies failed; clear loginRemediateFailed on ban

M	public/index.html
M	scripts/worker.js

### 2026-01-25 17:56:07 -0300 | 0cf6dcf | feat(appeal): monitor hourly even under humanHold; expose countdown fields; UI shows Recurso em anÃ¡lise timer

M	public/index.html
M	scripts/worker.js

### 2026-01-25 18:06:27 -0300 | 6e51721 | chore(audit): log appeal monitor events to provision_audit; include appeal fields in status snapshots

M	scripts/worker.js

### 2026-01-25 18:29:50 -0300 | 3b5da22 | feat(human): overlay persistente no navegador com dados+copiar+retomar

M	scripts/worker.js

### 2026-01-25 19:00:20 -0300 | 886ddfc | feat(ban+create): force create/item validation; auto-archive banned to CT with evidence; auto-delete profile

M	scripts/browser.js
M	scripts/worker.js

### 2026-01-25 20:17:13 -0300 | 739d936 | fix: harden human overlay + ban sweep + appeal guard + buildTag

M	scripts/api_perfis.js
M	scripts/clusterMaster.js
M	scripts/provisionAudit.js
M	scripts/worker.js

### 2026-01-25 21:02:16 -0300 | 3271a49 | feat: auto-exclude accounts on two_factor (2FA) with evidence

M	scripts/worker.js

### 2026-01-25 21:09:58 -0300 | 1b319fe | fix: 2FA sweep retroactive + allow nurseTick without controllers

M	scripts/worker.js

### 2026-01-25 21:13:04 -0300 | 00fc5f6 | fix: safe retro 2FA sweep + avoid heavy nurse when no browsers

M	scripts/worker.js

### 2026-01-25 21:51:13 -0300 | 646f564 | identity_detect_humanhold_1h_monitor_selfie_video

M	scripts/api_perfis.js
M	scripts/browser.js
M	scripts/worker.js

### 2026-01-25 22:00:02 -0300 | 5205bf6 | identity_gate_singleton_cooldown_5_10m

M	scripts/worker.js

### 2026-01-25 22:10:41 -0300 | 3c90b2e | identity_wait_carregar_20_120s

M	scripts/worker.js

### 2026-01-25 22:33:09 -0300 | b8cfecd | fix: identityAssistStep - loop infinito respeitando budget + logs enterprise no nurseTick

M	scripts/browser.js
M	scripts/worker.js

### 2026-01-26 11:24:21 -0300 | efd7810 | fix: monitor recurso/identidade + overlay humano arrastavel + hard-close banned + slug no painel

M	public/index.html
M	scripts/worker.js

### 2026-01-26 12:14:14 -0300 | c451ab2 | fix: reconciliar estado real em modo humano (anti-engessamento) + limpar flags mascaradas

M	scripts/worker.js

### 2026-01-26 12:25:38 -0300 | fb44786 | fix: banned/2FA sem navegador orfao (kill por userDataDir mesmo sem controller)

M	scripts/worker.js

### 2026-01-26 12:31:25 -0300 | 7b33342 | ux: overlay humano indica que pode arrastar/mover

M	scripts/worker.js

### 2026-01-26 12:35:19 -0300 | 4435e56 | fix: matar processos do perfil com kill robusto (WMI filter+timeout+retry)

M	scripts/browser.js

### 2026-01-26 12:40:20 -0300 | 0cec3b4 | fix: ban/2FA fecha browser por rootPid (persistido) antes de excluir

M	scripts/worker.js

### 2026-01-26 12:49:30 -0300 | b33db69 | fix: ban/2FA ordem correta (fechar navegador -> excluir -> CT); close gracioso antes de force-kill

M	scripts/browser.js
M	scripts/worker.js

### 2026-01-26 12:51:07 -0300 | 7554981 | fix: ban/2FA serializado por perfil + limpar PIDs apos fechar

M	scripts/worker.js

### 2026-01-26 12:56:54 -0300 | 8c595ab | fix: maintenance_provision auto-recover (provisionLock pid) + endpoint release

M	scripts/api_perfis.js
M	scripts/provisionLock.js

### 2026-01-26 13:04:40 -0300 | cf01990 | fix: lockProfileAction reentrante (evita deadlock em ban/2FA dentro de login_remediate)

M	scripts/worker.js

### 2026-01-26 13:18:22 -0300 | f1adccf | fix: provisionLock compat (nao invalidar lock sem pid); auto-recover so quando pid existir

M	scripts/provisionLock.js

### 2026-01-26 13:26:56 -0300 | 12e94ae | fix: nunca deletar perfil com Chrome vivo (verifica pids por userDataDir antes de excluir)

M	scripts/browser.js
M	scripts/worker.js

### 2026-01-26 13:37:55 -0300 | b7e88b0 | fix: ban/2FA sempre taskkill rootPid (nao depender de isPidAlive); isPidAlive trata EPERM como vivo

M	scripts/worker.js

### 2026-01-26 13:51:00 -0300 | 68a7fb1 | fix: identidade (Carregar) espera ate 150s; appeal_submitted nao vira identity_submitted por hint generico

M	scripts/browser.js
M	scripts/worker.js

### 2026-01-26 13:54:52 -0300 | 4f2fcde | fix: identidade clicar Carregar sÃ³ quando realmente clicavel (poll 250ms, evita falso positivo)

M	scripts/browser.js

### 2026-01-26 14:50:50 -0300 | bd2f575 | Fix appeal vs identity detection; harden banned/2FA close gating

M	scripts/browser.js
M	scripts/worker.js

### 2026-01-26 15:12:34 -0300 | d75f985 | Prevent orphan Chrome on banned/2FA: robust udir fallback + slug PID match

M	scripts/browser.js
M	scripts/worker.js

### 2026-01-26 15:44:18 -0300 | 83e1f94 | Hardcore login UX + conservative PID gate: single-tab before human/login; block delete if PID check fails

M	scripts/browser.js
M	scripts/worker.js

### 2026-01-26 15:53:10 -0300 | 00ceb17 | Ban/2FA staged guarantee: mark browserClosedAt in manifest; block delete unless closed

M	scripts/worker.js

### 2026-01-26 16:12:24 -0300 | daa8aa3 | Fix stock_provision credentials + hard kill on banned/2FA close

M	scripts/api_perfis.js
M	scripts/dashboard.js
M	scripts/worker.js

### 2026-01-26 16:16:20 -0300 | eb44bba | Harden self_update git to be non-interactive + timeout

M	scripts/dashboard.js

### 2026-01-26 16:33:05 -0300 | 8746279 | Prevent ban/2FA reopen + add fetch_logs_query for incident forensics

M	scripts/dashboard.js
M	scripts/worker.js

### 2026-01-26 16:49:08 -0300 | 938fdd3 | Fix CT archive/cred fetch fallback to env + include stockAccountId

M	scripts/api_perfis.js
M	scripts/dashboard.js
M	scripts/worker.js

### 2026-01-26 17:07:14 -0300 | d77b7ea | Unify stock_provision via login_remediate + reentrant provisionLock + graceful-first ban close

M	scripts/api_perfis.js
M	scripts/dashboard.js
M	scripts/provisionLock.js
M	scripts/worker.js

### 2026-01-26 17:24:55 -0300 | fcf0de0 | Add ban/2FA deep trace + CT archive retry queue (no more lost accounts)

M	scripts/worker.js

### 2026-01-26 19:34:40 -0300 | b162ed4 | Force close Chrome after ban/2FA (no skip)

M	scripts/worker.js

### 2026-01-26 20:34:48 -0300 | 38a99c3 | Enterprise: auto ban/2FA via deactivate + CT archive before delete

M	scripts/browser.js
M	scripts/worker.js

### 2026-01-26 20:46:38 -0300 | 497a2d6 | Enterprise: block delete when controller missing but Chrome still alive

M	scripts/worker.js

### 2026-01-26 20:59:54 -0300 | b8aebd4 | Ultra enterprise: bloqueia delete se Chrome ainda vivo + build trace

M	.gitignore
M	scripts/worker.js

### 2026-01-26 21:02:48 -0300 | 78c2bd3 | Ban/2FA: arquivar no CT mesmo se close falhar; nunca deletar com Chrome vivo

M	scripts/worker.js

### 2026-01-26 21:15:24 -0300 | a7006f5 | Monitor 1h: reload enterprise com fallback + logs (anti-loop Recurso/Identidade em anÃ¡lise)

M	scripts/worker.js

### 2026-01-26 21:21:28 -0300 | 8ab226e | Identity assist: clicar Carregar sÃ³ quando realmente clicÃ¡vel (hit-test + retry)

M	scripts/browser.js

### 2026-01-26 21:23:57 -0300 | 791d26b | Appeal monitor: arm idempotente (nÃ£o reiniciar timer a cada minuto)

M	scripts/worker.js

### 2026-01-26 21:42:39 -0300 | 1b167db | Human-resume: limpar flags appeal/identity + destravar modal 'de volta ao Facebook'

M	scripts/worker.js

### 2026-01-26 21:51:39 -0300 | 0653b35 | Human-resume: preflight no Facebook (nÃ£o no Messenger) + ignorar hasAppeal antigo

M	scripts/worker.js

### 2026-01-26 22:00:01 -0300 | 9b59d05 | Open-all human mode: nunca ficar em about:blank; identity/appeal navegam antes de overlay

M	scripts/worker.js

### 2026-01-26 22:10:49 -0300 | 6278e46 | Open-all: nÃ£o invocar humano em identidade/appeal; probe pÃ³s-abertura corrige flags e auto-start se liberado

M	scripts/worker.js

### 2026-01-26 22:18:24 -0300 | 839cdb4 | DetectLoginRequired: reconhecer identidade (selfie/vÃ­deo) mesmo fora de /checkpoint

M	scripts/browser.js

### 2026-01-26 22:23:46 -0300 | a35e80d | Human-resume: captcha/checkpoint Ã© estado prÃ³prio (nÃ£o virar login/cookies falhou)

M	scripts/worker.js

### 2026-01-26 22:38:47 -0300 | c8477bd | ActivateOnce: ao abrir em modo humano por identidade/appeal, rodar probe para setar flags reais

M	scripts/worker.js

### 2026-01-26 22:42:24 -0300 | 4ebb6b5 | Open/Retomar: humanHold nunca forÃ§a humano invocado; identity/appeal nÃ£o setam humanHold; sÃ³ captcha/login falha invocam humano

M	scripts/worker.js

### 2026-01-26 22:56:49 -0300 | 2c05934 | RM5: evitar tela preta about:blank no open-all/retomar; identidade nÃ£o virar captcha_persona; invocar humano sÃ³ quando fato

M	scripts/browser.js
M	scripts/worker.js

### 2026-01-26 23:09:43 -0300 | 05f7ea8 | PolÃ­tica: nunca invocar humano automaticamente (open/open-all/retomar/nurse/login_remediate); humano sÃ³ via invoke_human

M	scripts/worker.js

### 2026-01-26 23:25:44 -0300 | 4bc72a2 | Fix: marcar IDENTIDADE e CAPTCHA no painel; captcha invoca humano auto; identityAssist clica iniciar selfie

M	scripts/browser.js
M	scripts/worker.js

### 2026-01-26 23:34:40 -0300 | 2801f66 | Identity autopilot: executar steps ao detectar tela; overlay force em captcha; evitar reset de humanHold

M	scripts/worker.js

### 2026-01-27 10:30:05 -0300 | 534263a | fix(identity): executor 24x7 + open-all operator

M	scripts/api_perfis.js
M	scripts/browser.js
M	scripts/worker.js

### 2026-01-27 11:00:46 -0300 | 439810d | fix(identity): trigger on manual open + start_work; cooldown 2m

M	scripts/api_perfis.js
M	scripts/worker.js

### 2026-01-27 11:04:17 -0300 | a805fd7 | fix(identity): avoid waiting on disabled later-step; broaden keywords

M	scripts/browser.js

### 2026-01-27 11:11:49 -0300 | b2d1c85 | fix(identity): stage-aware clicks + clear stale gate lease

M	scripts/browser.js
M	scripts/worker.js

### 2026-01-27 11:37:53 -0300 | 4ec9286 | fix(autopilot): stop identity clicks on captcha; 1-tab human; audit disconnect

M	scripts/browser.js
M	scripts/worker.js

### 2026-01-27 11:49:27 -0300 | 4646d2f | fix(identity): scrollIntoView for offscreen buttons + audit

M	scripts/browser.js
M	scripts/worker.js

### 2026-01-27 12:09:41 -0300 | 68b146f | fix(open-all): bootstrap 2 tabs + suppress blank killer; audit guard

M	scripts/browser.js
M	scripts/worker.js

### 2026-01-27 12:28:27 -0300 | c1b1fca | fix(bootstrap): messenger-first then robe probe(tab1) before start_work

M	scripts/worker.js

### 2026-01-27 12:39:28 -0300 | fe6a299 | fix(bootstrap): reuse page0 even if about:blank (avoid extra tabs)

M	scripts/worker.js

### 2026-01-27 12:50:29 -0300 | 144a3b1 | fix(bootstrap): wait messenger ready + robust robe probe + reclassify login

M	scripts/worker.js

### 2026-01-27 13:10:12 -0300 | 9d3473d | fix(open-all): ack imediato + export garantirMarketplace

M	scripts/api_perfis.js
M	scripts/virtus.js

### 2026-01-27 13:46:28 -0300 | 145bc15 | fix(banflow,nurse): deletar local sempre + priorizar recurso pronto + open-all sequencial

M	scripts/api_perfis.js
M	scripts/worker.js

### 2026-01-27 13:48:13 -0300 | 1d25b07 | fix(ct-archive): not_found_assigned -> delete local (no duplication)

M	scripts/worker.js

### 2026-01-27 14:30:46 -0300 | c8cede1 | fix(provision): inject cookies 3-tabs + retry ui_blocked on stock

M	scripts/browser.js
M	scripts/worker.js

### 2026-01-27 14:32:55 -0300 | c4d82c2 | chore(build): bump worker buildTag (provision_3tabs_v1)

M	scripts/worker.js

### 2026-01-27 14:39:56 -0300 | 7b79f49 | fix(messenger-pin): type PIN slowly + stop click loops

M	scripts/browser.js
M	scripts/worker.js

### 2026-01-27 14:50:46 -0300 | 8351fe5 | fix(provision): keep 3 tabs during login_remediate + whitelist create/vehicle

M	scripts/browser.js
M	scripts/worker.js

### 2026-01-27 15:00:17 -0300 | aacd4b0 | fix(oneTabGuard): allow 3 tabs during configure even in bootstrap

M	scripts/worker.js

### 2026-01-27 15:17:28 -0300 | cf731ea | fix(provision): bypass kill_guard post-success + accept fb probe_failed + PIN confirm 2x

M	scripts/browser.js
M	scripts/worker.js

### 2026-01-27 15:40:20 -0300 | 4fd4680 | fix(provision): create-PIN robust + enforce robe pause 24h on new_account

M	scripts/api_perfis.js
M	scripts/browser.js
M	scripts/worker.js

### 2026-01-27 15:53:06 -0300 | 9dd8a7a | fix(open-all): clear stale login flags + don't human-only on stuck flags

M	scripts/api_perfis.js
M	scripts/worker.js

### 2026-01-27 15:58:37 -0300 | 4916fa5 | fix(pin,identity): handle create-PIN during inject + randomize identity cooldown 10-30m

M	scripts/browser.js
M	scripts/worker.js

### 2026-01-27 16:03:20 -0300 | 8c890a2 | fix(delete): archive to CT Excluidas before delete (queue on fail)

M	scripts/api_perfis.js

### 2026-01-27 16:37:17 -0300 | 58c6afa | feat(uafp): export uaPresetId + emit CT uafp events

M	scripts/dashboard.js
M	scripts/worker.js

### 2026-01-27 17:03:02 -0300 | 8e3d75c | uafp: sync ua_presets to CT (show all presets)

M	scripts/worker.js

### 2026-01-27 21:46:03 -0300 | c537e70 | Fix Messenger PIN unblock + manifest autocure + avoid global stall from provision_lock

M	scripts/browser.js
M	scripts/worker.js

### 2026-01-27 22:11:30 -0300 | e251a30 | RM1: harden human/continue-as, appeal back-to-facebook, infra backoff

M	scripts/browser.js
M	scripts/worker.js

### 2026-01-27 23:10:31 -0300 | b1ff56b | Fix nurse humanHold opening + Messenger page not available handling

M	scripts/browser.js
M	scripts/worker.js

### 2026-01-27 23:11:34 -0300 | fe8adb1 | Add worker hot-restart after self_update

M	scripts/api_perfis.js
M	scripts/dashboard.js
M	scripts/workerClient.js

### 2026-01-27 23:46:08 -0300 | 07aecea | Full quiesce for login_remediate + hacked flow scroll/blur

M	scripts/browser.js
M	scripts/robeQueue.js
M	scripts/worker.js

### 2026-01-28 10:07:25 -0300 | 229f109 | Boot recovery for perfis.json + safer atomic writes

M	index.js
M	scripts/fileStore.js

### 2026-01-28 11:11:17 -0300 | 5c62c07 | fix: lock perfis.json + repair_perfis_json remote command

M	scripts/dashboard.js
M	scripts/fileStore.js

### 2026-01-28 11:31:35 -0300 | 7301889 | fix: auto-recover perfis.json on worker boot

M	scripts/worker.js

### 2026-01-28 11:47:27 -0300 | 554748f | fix: recover perfis.json from Chrome user data on boot

M	scripts/fileStore.js

### 2026-01-28 12:18:19 -0300 | 2ad6f9e | perf: master-only writes for perfis.json (IPC + lock + audit)

M	scripts/api_perfis.js
M	scripts/clusterMaster.js
M	scripts/fileStore.js
A	scripts/perfisMasterClient.js
M	scripts/worker.js

### 2026-01-28 12:39:33 -0300 | f05e9d4 | fix: worker get-status respects shard to avoid overwriting aggregate

M	scripts/worker.js

### 2026-01-28 13:21:47 -0300 | a96646e | Fix: prevent login_remediate provision_lock freezing server; add watchdog + ban timeout

M	scripts/clusterMaster.js
M	scripts/worker.js

### 2026-01-28 14:09:26 -0300 | d7f7df3 | Boot: messenger-only validation; human hard-pause; captcha-only invoke_human

M	scripts/worker.js

### 2026-01-28 14:32:16 -0300 | 6c11c30 | Policy: open/resume clears non-terminal flags; frozen no longer blocks open; open-all no prescan

M	scripts/api_perfis.js
M	scripts/worker.js

### 2026-01-28 14:49:59 -0300 | 0fb616d | Open-all sequencer (dashboard order), no non-structural freeze, messenger_page_not_available => human

M	scripts/api_perfis.js
M	scripts/worker.js

### 2026-01-28 15:01:07 -0300 | cfed608 | Dashboard hardening: no flicker on transient API failures; bounded resource wait

M	public/index.html
M	scripts/api_status.js

### 2026-01-28 16:07:26 -0300 | cc1563b | Open-all backend orchestration: strict order mapping-only, global pause, UI progress

M	public/index.html
M	scripts/api_perfis.js
M	scripts/api_status.js
M	scripts/worker.js

### 2026-01-28 16:17:59 -0300 | 1339b31 | Fix open-all start from zero browsers (do not early-return nurseTick when _openAll active)

M	scripts/worker.js

### 2026-01-28 16:33:57 -0300 | 86d50f8 | Open-all governance: mandatory probe, step throttling/backoff, reduce focus flicker

M	scripts/worker.js

### 2026-01-28 16:50:45 -0300 | 3721fe2 | Do not force human mode for captcha when Robe is paused by limit_posting (keep Virtus running)

M	scripts/worker.js

### 2026-01-28 17:11:16 -0300 | d7daf78 | Human invoke hardening: strong captcha confirmation + require confirmed flag; remove immediate human on setCaptchaCheckpoint

M	scripts/worker.js

### 2026-01-28 17:28:56 -0300 | b6aabff | Boot safety: clear pending desired._openAll session on startup (no auto-resume)

M	index.js
M	scripts/fileStore.js

### 2026-01-28 17:35:41 -0300 | 5fd5bcf | Close-all hardening: dashboard uses backend close-all; cancel open-all session during close-all

M	public/index.html
M	scripts/api_perfis.js

### 2026-01-28 17:50:21 -0300 | 7b3d980 | Purge guarantee: ct_archive_queue not_found_assigned now force-removes from perfis.json (IPC + fallback)

M	scripts/worker.js

### 2026-01-28 19:50:14 -0300 | 9bc34ba | Enterprise purge: tombstones + guaranteed server deletion (ban/2FA/manual/CT) + open-all skip

M	index.js
M	scripts/api_perfis.js
M	scripts/fileStore.js
M	scripts/worker.js

### 2026-01-28 23:35:25 -0300 | 14f9391 | feat: convenient local backup ops (list_backups/restore_backup) + perfis autorepair

M	scripts/dashboard.js
M	scripts/fileStore.js

### 2026-01-28 23:39:47 -0300 | 1814d9b | feat: export convenient backup snapshot files via command

M	scripts/dashboard.js

### 2026-01-29 00:30:17 -0300 | 225c756 | feat(close_all): cancel on dashboard refresh + preempt provision_lock

M	public/index.html
M	scripts/api_perfis.js
M	scripts/opsState.js

### 2026-01-29 01:12:45 -0300 | 9859829 | rollback: snapshot 20260127_165414 (16:54) code-only

M	index.js
M	package-lock.json
M	public/index.html
M	scripts/dashboard.js
M	scripts/fileStore.js
M	scripts/worker.js

### 2026-01-29 01:38:11 -0300 | 151ebe3 | fix(open_all): messenger-only boot (skip create tab probe + no auto start_work)

M	scripts/worker.js

### 2026-01-29 01:43:11 -0300 | 0477b47 | fix(perfis): add withPerfisFileLockUpdate for cluster-safe perfis.json writes

M	scripts/fileStore.js

### 2026-01-29 01:46:32 -0300 | d99e2b0 | fix(login_required): force desired virtus=off + stop virtus/robe on flag

M	scripts/worker.js

### 2026-01-29 02:21:59 -0300 | d33fc85 | fix(delete_perfis): idempotent delete + guardrail against empty perfis.json

M	.gitignore
M	scripts/api_perfis.js
M	scripts/fileStore.js

### 2026-01-29 02:34:15 -0300 | 805443f | fix(delete_perfis): skip HTTP when profile missing (reduce noise + fast ack)

M	scripts/dashboard.js

### 2026-01-29 02:37:55 -0300 | ae47f9e | diag(ack): add DASHBOARD_ACK_DEBUG logging for /api/commands/ack

M	scripts/dashboard.js

### 2026-01-29 02:46:22 -0300 | 8780b49 | fix(cluster): prevent worker shard from wiping global perfis.json

M	scripts/worker.js

