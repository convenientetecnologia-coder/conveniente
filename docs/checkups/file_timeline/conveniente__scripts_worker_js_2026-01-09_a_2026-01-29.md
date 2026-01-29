### `conveniente/scripts/worker.js` — timeline por dia/commit — 2026-01-09 → 2026-01-29

Como usar:
- Para qualquer mudança citada aqui, abrir diff: `git show <hash>`
- Para achar funções (ex.: `invoke_human`): `Grep` no arquivo e depois correlacionar com o commit do dia.

Cobertura real:
- commits: 151
- min: 2026-01-17 10:35:31 -0300
- max: 2026-01-29 02:46:22 -0300

---

## 2026-01-17 (7)
- 2026-01-17 15:04:34 -0300 | e8d0ed6 | perf: reiniciar runner do virtus quando governor muda de modo
- 2026-01-17 15:03:10 -0300 | e448690 | perf: governor SLOW por loop-lag (sem WMI) + virtus slowMode
- 2026-01-17 13:28:08 -0300 | 3ce690f | gpt: ingest automÃ¡tico de evidÃªncia (LR) para cÃ©rebro central + endpoint centralizado
- 2026-01-17 11:10:12 -0300 | 9e414c2 | lr: registrar snapshot quando nÃ£o hÃ¡ pÃ¡ginas (cria login_required_events)
- 2026-01-17 10:58:07 -0300 | 176f2df | lr: registrar evidÃªncia quando flag LR jÃ¡ estÃ¡ setada (snapshot)
- 2026-01-17 10:49:00 -0300 | 9693db5 | fix: worker os duplicate require
- 2026-01-17 10:35:31 -0300 | 27b113b | logs: incluir login_required_events no fetch_logs

## 2026-01-20 (1)
- 2026-01-20 10:44:08 -0300 | 3b6813e | enterprise: provision resiliente + PIN modal guard + fb_gpt resolve

## 2026-01-21 (5)
- 2026-01-21 20:46:44 -0300 | b41fb62 | feat(stock): nova conta pausa Robe 24h (new_account) + check marketplace no start-work
- 2026-01-21 16:32:45 -0300 | f5c3b42 | feat(ui): scan all tabs for loginRequired + auto humanHold on identity
- 2026-01-21 15:57:31 -0300 | 0588e91 | feat(messenger): nurse GPT fallback + richer pin telemetry
- 2026-01-21 15:53:07 -0300 | 3af95ba | fix(messenger): scan all tabs for PIN modal + audit logs
- 2026-01-21 15:37:19 -0300 | bf4cafc | fix(messenger): auto-dismiss PIN modal in work-mode + telemetry

## 2026-01-22 (4)
- 2026-01-22 23:09:16 -0300 | c3ec39a | fix: pass operator to automationAllowed in start_work
- 2026-01-22 22:48:08 -0300 | 944548e | Allow stock_provision owner to run start_work under provision lock
- 2026-01-22 22:27:26 -0300 | 46186dd | Fix provision lock: allow owner operator + use stock_provision:<batchId>
- 2026-01-22 21:56:38 -0300 | 6ab1622 | Hardening stock_provision: backpressure, provision lock, retries

## 2026-01-23 (21)
- 2026-01-23 23:59:44 -0300 | b296cc3 | feat(worker): auto login_remediate when loginRequired detected
- 2026-01-23 23:09:41 -0300 | 9c2afa3 | login_remediate: deterministic post-success (desired+nudge+activate retries, defer to nurse if needed)
- 2026-01-23 22:56:03 -0300 | a292da2 | status: include _debug controllersCount/pid per node to diagnose zero-active dashboard
- 2026-01-23 22:30:39 -0300 | 477031c | login_remediate: set desired active+virtus on after success to prevent immediate shutdown
- 2026-01-23 22:16:46 -0300 | 98a1d1c | login_remediate: fix post-success deadlock; activateOnce+startVirtus; close target without handlers
- 2026-01-23 21:59:51 -0300 | 563695d | login_remediate: post-success close browser, reopen closedForRam, start_work
- 2026-01-23 21:36:33 -0300 | c1bfed2 | login_remediate: validate real tabs (messenger + marketplace create) and open create/item
- 2026-01-23 20:18:54 -0300 | 9536768 | login_remediate: failfast deactivate timeout to avoid no-ack hangs
- 2026-01-23 19:58:22 -0300 | 6eaacf6 | login_remediate: GPT eyes for consent/popups; block false positives
- 2026-01-23 19:33:31 -0300 | 43c4d7f | fix(login_remediate): treat captcha as requires_human; avoid false success
- 2026-01-23 19:17:54 -0300 | 747695f | hardening(login_remediate): strict login detection + evidence screenshots + gpt submit fallback
- 2026-01-23 19:06:58 -0300 | 048ed09 | fix(login_remediate): optional override of humanHold for explicit runs
- 2026-01-23 18:56:50 -0300 | 2eb0b97 | feat(login_remediate): fetch credentials from CT when manifest missing
- 2026-01-23 18:37:19 -0300 | 61ebe1f | fix(login_remediate): hard timeouts + fail-fast + incremental audit
- 2026-01-23 17:57:33 -0300 | 2ea38c9 | chore(login_remediate): ack correctness, retry worker startup, restore state
- 2026-01-23 17:50:47 -0300 | fd66267 | fix(login_remediate): resume virtus after remediation
- 2026-01-23 17:42:15 -0300 | 3a26eab | feat(login_remediate): command + worker flow + login helpers + fresh cookies
- 2026-01-23 15:23:09 -0300 | ffc62a2 | fix: sticky shard rebalance (no mass shard_moved) + cap worker shard moves
- 2026-01-23 15:05:49 -0300 | 97236e3 | audit: log worker hardClose/deactivate to provision_audit
- 2026-01-23 14:11:34 -0300 | 3391475 | ultra: limit swap_for_open + pause virtus during provision
- 2026-01-23 13:48:16 -0300 | 8ce1d43 | ultra: ram policy + provision close_all guard

## 2026-01-24 (12)
- 2026-01-24 18:15:58 -0300 | 5e85a25 | configure: resume paused virtus; human-resume sets desired virtus on
- 2026-01-24 17:11:07 -0300 | cb9b8de | quiesce: require global pause before cookie inject (configure/login_remediate)
- 2026-01-24 16:46:18 -0300 | c578a81 | status: expose virtusOnline/sendLock/robeExec in get-status
- 2026-01-24 16:22:18 -0300 | e0d5f4f | stock_provision: wait quiesce + expose busy flags
- 2026-01-24 16:07:39 -0300 | a21fdfc | audit: log virtus pause during provision lock
- 2026-01-24 02:12:29 -0300 | e81922c | fix(login_required): stop virtus; validate marketplace create/item; retry ui unblock; improve UI labels
- 2026-01-24 01:44:09 -0300 | ae979e1 | fix(human-resume): clear loginRemediateFailed + remove blank tabs + suppress blank-killer during configure
- 2026-01-24 01:29:56 -0300 | 69fffd8 | fix(login): detect 2FA/checkpoint by URL path; prevent black screen in human mode on open
- 2026-01-24 01:16:51 -0300 | 495cff4 | fix(login): detect 2FA; fail-fast on any non-automatable; human mode ensure visible page
- 2026-01-24 01:00:24 -0300 | 1ec81e7 | fix(login): robust submit + messenger login detection + human invoke + UI flag
- 2026-01-24 00:33:55 -0300 | be77706 | fix(login_remediate): validate messenger+facebook by URL; keep real captcha reason
- 2026-01-24 00:12:29 -0300 | 6d06fca | fix(login): prevent auto loops + open-all human-only after login failure

## 2026-01-25 (19)
- 2026-01-25 22:33:09 -0300 | b8cfecd | fix: identityAssistStep - loop infinito respeitando budget + logs enterprise no nurseTick
- 2026-01-25 22:10:41 -0300 | 3c90b2e | identity_wait_carregar_20_120s
- 2026-01-25 22:00:02 -0300 | 5205bf6 | identity_gate_singleton_cooldown_5_10m
- 2026-01-25 21:51:13 -0300 | 646f564 | identity_detect_humanhold_1h_monitor_selfie_video
- 2026-01-25 21:13:04 -0300 | 00fc5f6 | fix: safe retro 2FA sweep + avoid heavy nurse when no browsers
- 2026-01-25 21:09:58 -0300 | 1b319fe | fix: 2FA sweep retroactive + allow nurseTick without controllers
- 2026-01-25 21:02:16 -0300 | 3271a49 | feat: auto-exclude accounts on two_factor (2FA) with evidence
- 2026-01-25 20:17:13 -0300 | 739d936 | fix: harden human overlay + ban sweep + appeal guard + buildTag
- 2026-01-25 19:00:20 -0300 | 886ddfc | feat(ban+create): force create/item validation; auto-archive banned to CT with evidence; auto-delete profile
- 2026-01-25 18:29:50 -0300 | 3b5da22 | feat(human): overlay persistente no navegador com dados+copiar+retomar
- 2026-01-25 18:06:27 -0300 | 6e51721 | chore(audit): log appeal monitor events to provision_audit; include appeal fields in status snapshots
- 2026-01-25 17:56:07 -0300 | 0cf6dcf | feat(appeal): monitor hourly even under humanHold; expose countdown fields; UI shows Recurso em anÃ¡lise timer
- 2026-01-25 17:47:15 -0300 | d1a5c1d | fix(ui): show banned instead of login/cookies failed; clear loginRemediateFailed on ban
- 2026-01-25 17:32:43 -0300 | 1b64825 | fix: detect disabled_checkpoint (Desabilitamos sua conta) and abort login_remediate as banned with audit logs
- 2026-01-25 17:17:56 -0300 | c9c806f | fix: human-resume runs preflight; if login_required schedule login_remediate + robe24h; if banned/captcha/identity invoke human
- 2026-01-25 16:47:46 -0300 | 75746f2 | audit: add detailed configure_* events to provision_audit for E2E evidence
- 2026-01-25 15:37:52 -0300 | 6036eeb | fix: manual configure resumes work; require provisionLock; unfreeze cooldown on resume
- 2026-01-25 15:34:13 -0300 | 7cbd0ca | fix: configure uses cookies->login->human with quiesce/headroom
- 2026-01-25 15:20:08 -0300 | 0b510c8 | fix: provision_lock + quiesce + appeal monitor + cooldown self-heal

## 2026-01-26 (38)
- 2026-01-26 23:34:40 -0300 | 2801f66 | Identity autopilot: executar steps ao detectar tela; overlay force em captcha; evitar reset de humanHold
- 2026-01-26 23:25:44 -0300 | 4bc72a2 | Fix: marcar IDENTIDADE e CAPTCHA no painel; captcha invoca humano auto; identityAssist clica iniciar selfie
- 2026-01-26 23:09:43 -0300 | 05f7ea8 | PolÃ­tica: nunca invocar humano automaticamente (open/open-all/retomar/nurse/login_remediate); humano sÃ³ via invoke_human
- 2026-01-26 22:56:49 -0300 | 2c05934 | RM5: evitar tela preta about:blank no open-all/retomar; identidade nÃ£o virar captcha_persona; invocar humano sÃ³ quando fato
- 2026-01-26 22:18:24 -0300 | 839cdb4 | DetectLoginRequired: reconhecer identidade (selfie/vÃ­deo) mesmo fora de /checkpoint
- 2026-01-26 21:21:28 -0300 | 8ab226e | Identity assist: clicar Carregar sÃ³ quando realmente clicÃ¡vel (hit-test + retry)
- 2026-01-26 20:34:48 -0300 | 38a99c3 | Enterprise: auto ban/2FA via deactivate + CT archive before delete
- 2026-01-26 15:44:18 -0300 | 83e1f94 | Hardcore login UX + conservative PID gate: single-tab before human/login; block delete if PID check fails
- 2026-01-26 15:12:34 -0300 | d75f985 | Prevent orphan Chrome on banned/2FA: robust udir fallback + slug PID match
- 2026-01-26 14:50:50 -0300 | bd2f575 | Fix appeal vs identity detection; harden banned/2FA close gating
- 2026-01-26 13:54:52 -0300 | 4f2fcde | fix: identidade clicar Carregar sÃ³ quando realmente clicavel (poll 250ms, evita falso positivo)
- 2026-01-26 13:51:00 -0300 | 68a7fb1 | fix: identidade (Carregar) espera ate 150s; appeal_submitted nao vira identity_submitted por hint generico
- 2026-01-26 13:26:56 -0300 | 12e94ae | fix: nunca deletar perfil com Chrome vivo (verifica pids por userDataDir antes de excluir)
- 2026-01-26 12:49:30 -0300 | b33db69 | fix: ban/2FA ordem correta (fechar navegador -> excluir -> CT); close gracioso antes de force-kill
- 2026-01-26 12:35:19 -0300 | 4435e56 | fix: matar processos do perfil com kill robusto (WMI filter+timeout+retry)
- 2026-01-26 12:31:25 -0300 | 7b33342 | ux: overlay humano indica que pode arrastar/mover
- 2026-01-26 12:25:38 -0300 | fb44786 | fix: banned/2FA sem navegador orfao (kill por userDataDir mesmo sem controller)
- 2026-01-26 12:14:14 -0300 | c451ab2 | fix: reconciliar estado real em modo humano (anti-engessamento) + limpar flags mascaradas
- 2026-01-26 11:24:21 -0300 | efd7810 | fix: monitor recurso/identidade + overlay humano arrastavel + hard-close banned + slug no painel

## 2026-01-27 (26)
- 2026-01-27 23:46:08 -0300 | 07aecea | Full quiesce for login_remediate + hacked flow scroll/blur
- 2026-01-27 23:10:31 -0300 | b1ff56b | Fix nurse humanHold opening + Messenger page not available handling
- 2026-01-27 22:11:30 -0300 | e251a30 | RM1: harden human/continue-as, appeal back-to-facebook, infra backoff
- 2026-01-27 21:46:03 -0300 | c537e70 | Fix Messenger PIN unblock + manifest autocure + avoid global stall from provision_lock
- 2026-01-27 17:03:02 -0300 | 8e3d75c | uafp: sync ua_presets to CT (show all presets)
- 2026-01-27 16:37:17 -0300 | 58c6afa | feat(uafp): export uaPresetId + emit CT uafp events
- 2026-01-27 15:58:37 -0300 | 4916fa5 | fix(pin,identity): handle create-PIN during inject + randomize identity cooldown 10-30m
- 2026-01-27 15:53:06 -0300 | 9dd8a7a | fix(open-all): clear stale login flags + don't human-only on stuck flags
- 2026-01-27 15:40:20 -0300 | 4fd4680 | fix(provision): create-PIN robust + enforce robe pause 24h on new_account
- 2026-01-27 15:17:28 -0300 | cf731ea | fix(provision): bypass kill_guard post-success + accept fb probe_failed + PIN confirm 2x
- 2026-01-27 15:00:17 -0300 | aacd4b0 | fix(oneTabGuard): allow 3 tabs during configure even in bootstrap
- 2026-01-27 14:50:46 -0300 | 8351fe5 | fix(provision): keep 3 tabs during login_remediate + whitelist create/vehicle
- 2026-01-27 14:39:56 -0300 | 7b79f49 | fix(messenger-pin): type PIN slowly + stop click loops
- 2026-01-27 14:32:55 -0300 | c4d82c2 | chore(build): bump worker buildTag (provision_3tabs_v1)
- 2026-01-27 14:30:46 -0300 | c8cede1 | fix(provision): inject cookies 3-tabs + retry ui_blocked on stock
- 2026-01-27 13:48:13 -0300 | 1d25b07 | fix(ct-archive): not_found_assigned -> delete local (no duplication)
- 2026-01-27 13:46:28 -0300 | 145bc15 | fix(banflow,nurse): deletar local sempre + priorizar recurso pronto + open-all sequencial
- 2026-01-27 12:50:29 -0300 | 144a3b1 | fix(bootstrap): wait messenger ready + robust robe probe + reclassify login
- 2026-01-27 12:39:28 -0300 | fe6a299 | fix(bootstrap): reuse page0 even if about:blank (avoid extra tabs)
- 2026-01-27 12:28:27 -0300 | c1b1fca | fix(bootstrap): messenger-first then robe probe(tab1) before start_work
- 2026-01-27 12:09:41 -0300 | 68b146f | fix(open-all): bootstrap 2 tabs + suppress blank killer; audit guard
- 2026-01-27 11:49:27 -0300 | 4646d2f | fix(identity): scrollIntoView for offscreen buttons + audit
- 2026-01-27 11:37:53 -0300 | 4ec9286 | fix(autopilot): stop identity clicks on captcha; 1-tab human; audit disconnect
- 2026-01-27 11:11:49 -0300 | b2d1c85 | fix(identity): stage-aware clicks + clear stale gate lease
- 2026-01-27 11:00:46 -0300 | 439810d | fix(identity): trigger on manual open + start_work; cooldown 2m
- 2026-01-27 10:30:05 -0300 | 534263a | fix(identity): executor 24x7 + open-all operator

## 2026-01-28 (14)
- 2026-01-28 19:50:14 -0300 | 9bc34ba | Enterprise purge: tombstones + guaranteed server deletion (ban/2FA/manual/CT) + open-all skip
- 2026-01-28 17:50:21 -0300 | 7b3d980 | Purge guarantee: ct_archive_queue not_found_assigned now force-removes from perfis.json (IPC + fallback)
- 2026-01-28 17:11:16 -0300 | d7daf78 | Human invoke hardening: strong captcha confirmation + require confirmed flag; remove immediate human on setCaptchaCheckpoint
- 2026-01-28 16:50:45 -0300 | 3721fe2 | Do not force human mode for captcha when Robe is paused by limit_posting (keep Virtus running)
- 2026-01-28 16:33:57 -0300 | 86d50f8 | Open-all governance: mandatory probe, step throttling/backoff, reduce focus flicker
- 2026-01-28 16:17:59 -0300 | 1339b31 | Fix open-all start from zero browsers (do not early-return nurseTick when _openAll active)
- 2026-01-28 16:07:26 -0300 | cc1563b | Open-all backend orchestration: strict order mapping-only, global pause, UI progress
- 2026-01-28 14:49:59 -0300 | 0fb616d | Open-all sequencer (dashboard order), no non-structural freeze, messenger_page_not_available => human
- 2026-01-28 14:32:16 -0300 | 6c11c30 | Policy: open/resume clears non-terminal flags; frozen no longer blocks open; open-all no prescan
- 2026-01-28 14:09:26 -0300 | d7f7df3 | Boot: messenger-only validation; human hard-pause; captcha-only invoke_human
- 2026-01-28 13:21:47 -0300 | a96646e | Fix: prevent login_remediate provision_lock freezing server; add watchdog + ban timeout
- 2026-01-28 12:39:33 -0300 | f05e9d4 | fix: worker get-status respects shard to avoid overwriting aggregate
- 2026-01-28 12:18:19 -0300 | 2ad6f9e | perf: master-only writes for perfis.json (IPC + lock + audit)
- 2026-01-28 11:31:35 -0300 | 7301889 | fix: auto-recover perfis.json on worker boot

## 2026-01-29 (4)
- 2026-01-29 02:46:22 -0300 | 8780b49 | fix(cluster): prevent worker shard from wiping global perfis.json
- 2026-01-29 01:46:32 -0300 | d99e2b0 | fix(login_required): force desired virtus=off + stop virtus/robe on flag
- 2026-01-29 01:38:11 -0300 | 151ebe3 | fix(open_all): messenger-only boot (skip create tab probe + no auto start_work)
- 2026-01-29 01:12:45 -0300 | 9859829 | rollback: snapshot 20260127_165414 (16:54) code-only

