### `conveniente/scripts/browser.js` — timeline por dia/commit — 2026-01-09 → 2026-01-29

Como usar:
- Abrir diff do commit: `git show <hash>`
- Para tópicos “invocar humano / captcha / identidade / appeal / consent”: este arquivo costuma conter detecção/cliques/UX.

Cobertura real:
- commits: 59
- min: 2026-01-17 10:35:31 -0300
- max: 2026-01-27 23:46:08 -0300

---

## 2026-01-17 (2)
- 2026-01-17 12:24:12 -0300 | 62e10c6 | fb: separar captcha_persona de checkpoint_captcha
- 2026-01-17 10:35:31 -0300 | 27b113b | logs: incluir login_required_events no fetch_logs

## 2026-01-20 (1)
- 2026-01-20 10:44:08 -0300 | 3b6813e | enterprise: provision resiliente + PIN modal guard + fb_gpt resolve

## 2026-01-21 (8)
- 2026-01-21 16:50:17 -0300 | 08a286a | feat: automaÃ§Ã£o completa de PIN - digita 882584 automaticamente e usa GPT para confirmaÃ§Ã£o
- 2026-01-21 16:43:11 -0300 | 40aa6b8 | Revert "feat: automaÃ§Ã£o de PIN do Messenger - digita 882584 automaticamente quando modal aparece"
- 2026-01-21 16:41:42 -0300 | b894426 | feat: automaÃ§Ã£o de PIN do Messenger - digita 882584 automaticamente quando modal aparece
- 2026-01-21 16:25:31 -0300 | d6e0d4d | feat(ui): detect identity confirmation (selfie video) as loginRequired
- 2026-01-21 15:57:31 -0300 | 0588e91 | feat(messenger): nurse GPT fallback + richer pin telemetry
- 2026-01-21 15:53:07 -0300 | 3af95ba | fix(messenger): scan all tabs for PIN modal + audit logs
- 2026-01-21 15:37:19 -0300 | bf4cafc | fix(messenger): auto-dismiss PIN modal in work-mode + telemetry
- 2026-01-21 15:17:30 -0300 | 781e2c8 | fix(messenger): dismiss PIN restore modal + continue-without-restore

## 2026-01-23 (11)
- 2026-01-23 21:36:33 -0300 | c1bfed2 | login_remediate: validate real tabs (messenger + marketplace create) and open create/item
- 2026-01-23 21:05:56 -0300 | 6f5a4ea | consent: include Fechar/X in unblock (deterministic + safe hints)
- 2026-01-23 20:59:43 -0300 | 4178f6d | consent flow: click ComeÃ§ar/Confirmar; safe GPT hints full-page; dialog okwords
- 2026-01-23 20:51:00 -0300 | 0b52023 | consent unblock: allow safe GPT clicks outside dialog + recheck consent exit
- 2026-01-23 20:42:39 -0300 | 8724df4 | pin modal: handle 'Mais opÃ§Ãµes' flow + skip; reduce ui_blocked false negatives
- 2026-01-23 20:35:13 -0300 | bf43d6c | ui_unblock: handle messenger PIN modal + harden captcha_persona detection
- 2026-01-23 20:32:08 -0300 | 80872d6 | messenger pin: default 882584 (env override MESSENGER_PIN)
- 2026-01-23 19:58:22 -0300 | 6eaacf6 | login_remediate: GPT eyes for consent/popups; block false positives
- 2026-01-23 19:33:31 -0300 | 43c4d7f | fix(login_remediate): treat captcha as requires_human; avoid false success
- 2026-01-23 19:17:54 -0300 | 747695f | hardening(login_remediate): strict login detection + evidence screenshots + gpt submit fallback
- 2026-01-23 17:42:15 -0300 | 3a26eab | feat(login_remediate): command + worker flow + login helpers + fresh cookies

## 2026-01-24 (3)
- 2026-01-24 01:29:56 -0300 | 69fffd8 | fix(login): detect 2FA/checkpoint by URL path; prevent black screen in human mode on open
- 2026-01-24 01:16:51 -0300 | 495cff4 | fix(login): detect 2FA; fail-fast on any non-automatable; human mode ensure visible page
- 2026-01-24 01:00:24 -0300 | 1ec81e7 | fix(login): robust submit + messenger login detection + human invoke + UI flag

## 2026-01-25 (5)
- 2026-01-25 22:33:09 -0300 | b8cfecd | fix: identityAssistStep - loop infinito respeitando budget + logs enterprise no nurseTick
- 2026-01-25 21:51:13 -0300 | 646f564 | identity_detect_humanhold_1h_monitor_selfie_video
- 2026-01-25 19:00:20 -0300 | 886ddfc | feat(ban+create): force create/item validation; auto-archive banned to CT with evidence; auto-delete profile
- 2026-01-25 17:32:43 -0300 | 1b64825 | fix: detect disabled_checkpoint (Desabilitamos sua conta) and abort login_remediate as banned with audit logs
- 2026-01-25 15:20:08 -0300 | 0b510c8 | fix: provision_lock + quiesce + appeal monitor + cooldown self-heal

## 2026-01-26 (13)
- 2026-01-26 23:25:44 -0300 | 4bc72a2 | Fix: marcar IDENTIDADE e CAPTCHA no painel; captcha invoca humano auto; identityAssist clica iniciar selfie
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

## 2026-01-27 (16)
- 2026-01-27 23:46:08 -0300 | 07aecea | Full quiesce for login_remediate + hacked flow scroll/blur
- 2026-01-27 23:10:31 -0300 | b1ff56b | Fix nurse humanHold opening + Messenger page not available handling
- 2026-01-27 22:11:30 -0300 | e251a30 | RM1: harden human/continue-as, appeal back-to-facebook, infra backoff
- 2026-01-27 21:46:03 -0300 | c537e70 | Fix Messenger PIN unblock + manifest autocure + avoid global stall from provision_lock
- 2026-01-27 15:58:37 -0300 | 4916fa5 | fix(pin,identity): handle create-PIN during inject + randomize identity cooldown 10-30m
- 2026-01-27 15:40:20 -0300 | 4fd4680 | fix(provision): create-PIN robust + enforce robe pause 24h on new_account
- 2026-01-27 15:17:28 -0300 | cf731ea | fix(provision): bypass kill_guard post-success + accept fb probe_failed + PIN confirm 2x
- 2026-01-27 14:50:46 -0300 | 8351fe5 | fix(provision): keep 3 tabs during login_remediate + whitelist create/vehicle
- 2026-01-27 14:39:56 -0300 | 7b79f49 | fix(messenger-pin): type PIN slowly + stop click loops
- 2026-01-27 14:30:46 -0300 | c8cede1 | fix(provision): inject cookies 3-tabs + retry ui_blocked on stock
- 2026-01-27 12:09:41 -0300 | 68b146f | fix(open-all): bootstrap 2 tabs + suppress blank killer; audit guard
- 2026-01-27 11:49:27 -0300 | 4646d2f | fix(identity): scrollIntoView for offscreen buttons + audit
- 2026-01-27 11:37:53 -0300 | 4ec9286 | fix(autopilot): stop identity clicks on captcha; 1-tab human; audit disconnect
- 2026-01-27 11:11:49 -0300 | b2d1c85 | fix(identity): stage-aware clicks + clear stale gate lease
- 2026-01-27 11:04:17 -0300 | a805fd7 | fix(identity): avoid waiting on disabled later-step; broaden keywords
- 2026-01-27 10:30:05 -0300 | 534263a | fix(identity): executor 24x7 + open-all operator

