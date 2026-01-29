### Ledger de commits (auditoria) — `conveniente` — 2026-01-16 → 2026-01-29

Objetivo: deixar **100% auditável por commit** (com horário) o que entrou no repo `C:\conveniente`.

Notas:
- O repo `conveniente` **não tem commits** entre 2026-01-09 e 2026-01-15 (segundo `git log --since=2026-01-09`).
- Para reduzir tamanho, o título do commit está **truncado em 45 chars**.
- Para ver o título completo: `git show -s --format=%B <hash>`.
- Para ver arquivos alterados: `git show --name-status <hash>`.

Comando base usado:

```bash
git log --since="2026-01-09" --date=iso --pretty=format:"%ad|%h|%<(45,trunc)%s"
```

Ledger:

```text
2026-01-29 02:46:22 -0300|8780b49|fix(cluster): prevent worker shard from wip..
2026-01-29 02:37:55 -0300|ae47f9e|diag(ack): add DASHBOARD_ACK_DEBUG logging ..
2026-01-29 02:34:15 -0300|805443f|fix(delete_perfis): skip HTTP when profile ..
2026-01-29 02:21:59 -0300|d33fc85|fix(delete_perfis): idempotent delete + gua..
2026-01-29 01:46:32 -0300|d99e2b0|fix(login_required): force desired virtus=o..
2026-01-29 01:43:11 -0300|0477b47|fix(perfis): add withPerfisFileLockUpdate f..
2026-01-29 01:38:11 -0300|151ebe3|fix(open_all): messenger-only boot (skip cr..
2026-01-29 01:12:45 -0300|9859829|rollback: snapshot 20260127_165414 (16:54) ..
2026-01-29 00:30:17 -0300|225c756|feat(close_all): cancel on dashboard refres..
2026-01-28 23:39:47 -0300|1814d9b|feat: export convenient backup snapshot fil..
2026-01-28 23:35:25 -0300|14f9391|feat: convenient local backup ops (list_bac..
2026-01-28 19:50:14 -0300|9bc34ba|Enterprise purge: tombstones + guaranteed s..
2026-01-28 17:50:21 -0300|7b3d980|Purge guarantee: ct_archive_queue not_found..
2026-01-28 17:35:41 -0300|5fd5bcf|Close-all hardening: dashboard uses backend..
2026-01-28 17:28:56 -0300|b6aabff|Boot safety: clear pending desired._openAll..
2026-01-28 17:11:16 -0300|d7daf78|Human invoke hardening: strong captcha conf..
2026-01-28 16:50:45 -0300|3721fe2|Do not force human mode for captcha when Ro..
2026-01-28 16:33:57 -0300|86d50f8|Open-all governance: mandatory probe, step ..
2026-01-28 16:17:59 -0300|1339b31|Fix open-all start from zero browsers (do n..
2026-01-28 16:07:26 -0300|cc1563b|Open-all backend orchestration: strict orde..
2026-01-28 15:01:07 -0300|cfed608|Dashboard hardening: no flicker on transien..
2026-01-28 14:49:59 -0300|0fb616d|Open-all sequencer (dashboard order), no no..
2026-01-28 14:32:16 -0300|6c11c30|Policy: open/resume clears non-terminal fla..
2026-01-28 14:09:26 -0300|d7f7df3|Boot: messenger-only validation; human hard..
2026-01-28 13:21:47 -0300|a96646e|Fix: prevent login_remediate provision_lock..
2026-01-28 12:39:33 -0300|f05e9d4|fix: worker get-status respects shard to av..
2026-01-28 12:18:19 -0300|2ad6f9e|perf: master-only writes for perfis.json (I..
2026-01-28 11:47:27 -0300|554748f|fix: recover perfis.json from Chrome user d..
2026-01-28 11:31:35 -0300|7301889|fix: auto-recover perfis.json on worker boot 
2026-01-28 11:11:17 -0300|5c62c07|fix: lock perfis.json + repair_perfis_json ..
2026-01-28 10:07:25 -0300|229f109|Boot recovery for perfis.json + safer atomi..
2026-01-27 23:46:08 -0300|07aecea|Full quiesce for login_remediate + hacked f..
2026-01-27 23:11:34 -0300|fe8adb1|Add worker hot-restart after self_update     
2026-01-27 23:10:31 -0300|b1ff56b|Fix nurse humanHold opening + Messenger pag..
2026-01-27 22:11:30 -0300|e251a30|RM1: harden human/continue-as, appeal back-..
2026-01-27 21:46:03 -0300|c537e70|Fix Messenger PIN unblock + manifest autocu..
2026-01-27 17:03:02 -0300|8e3d75c|uafp: sync ua_presets to CT (show all prese..
2026-01-27 16:37:17 -0300|58c6afa|feat(uafp): export uaPresetId + emit CT uaf..
2026-01-27 16:03:20 -0300|8c890a2|fix(delete): archive to CT Excluidas before..
2026-01-27 15:58:37 -0300|4916fa5|fix(pin,identity): handle create-PIN during..
2026-01-27 15:53:06 -0300|9dd8a7a|fix(open-all): clear stale login flags + do..
2026-01-27 15:40:20 -0300|4fd4680|fix(provision): create-PIN robust + enforce..
2026-01-27 15:17:28 -0300|cf731ea|fix(provision): bypass kill_guard post-succ..
2026-01-27 15:00:17 -0300|aacd4b0|fix(oneTabGuard): allow 3 tabs during confi..
2026-01-27 14:50:46 -0300|8351fe5|fix(provision): keep 3 tabs during login_re..
2026-01-27 14:39:56 -0300|7b79f49|fix(messenger-pin): type PIN slowly + stop ..
2026-01-27 14:32:55 -0300|c4d82c2|chore(build): bump worker buildTag (provisi..
2026-01-27 14:30:46 -0300|c8cede1|fix(provision): inject cookies 3-tabs + ret..
2026-01-27 13:48:13 -0300|1d25b07|fix(ct-archive): not_found_assigned -> dele..
2026-01-27 13:46:28 -0300|145bc15|fix(banflow,nurse): deletar local sempre + ..
2026-01-27 13:10:12 -0300|9d3473d|fix(open-all): ack imediato + export garant..
2026-01-27 12:50:29 -0300|144a3b1|fix(bootstrap): wait messenger ready + robu..
2026-01-27 12:39:28 -0300|fe6a299|fix(bootstrap): reuse page0 even if about:b..
2026-01-27 12:28:27 -0300|c1b1fca|fix(bootstrap): messenger-first then robe p..
2026-01-27 12:09:41 -0300|68b146f|fix(open-all): bootstrap 2 tabs + suppress ..
2026-01-27 11:49:27 -0300|4646d2f|fix(identity): scrollIntoView for offscreen..
2026-01-27 11:37:53 -0300|4ec9286|fix(autopilot): stop identity clicks on cap..
2026-01-27 11:11:49 -0300|b2d1c85|fix(identity): stage-aware clicks + clear s..
2026-01-27 11:04:17 -0300|a805fd7|fix(identity): avoid waiting on disabled la..
2026-01-27 11:00:46 -0300|439810d|fix(identity): trigger on manual open + sta..
2026-01-27 10:30:05 -0300|534263a|fix(identity): executor 24x7 + open-all ope..
2026-01-26 23:34:40 -0300|2801f66|Identity autopilot: executar steps ao detec..
2026-01-26 23:25:44 -0300|4bc72a2|Fix: marcar IDENTIDADE e CAPTCHA no painel;..
2026-01-26 23:09:43 -0300|05f7ea8|PolÃ­tica: nunca invocar humano automaticam..
2026-01-26 22:56:49 -0300|2c05934|RM5: evitar tela preta about:blank no open-..
2026-01-26 22:42:24 -0300|4ebb6b5|Open/Retomar: humanHold nunca forÃ§a humano..
2026-01-26 22:38:47 -0300|c8477bd|ActivateOnce: ao abrir em modo humano por i..
2026-01-26 22:23:46 -0300|a35e80d|Human-resume: captcha/checkpoint Ã© estado ..
2026-01-26 22:18:24 -0300|839cdb4|DetectLoginRequired: reconhecer identidade ..
2026-01-26 22:10:49 -0300|6278e46|Open-all: nÃ£o invocar humano em identidade..
2026-01-26 22:00:01 -0300|9b59d05|Open-all human mode: nunca ficar em about:b..
2026-01-26 21:51:39 -0300|0653b35|Human-resume: preflight no Facebook (nÃ£o n..
2026-01-26 21:42:39 -0300|1b167db|Human-resume: limpar flags appeal/identity ..
2026-01-26 21:23:57 -0300|791d26b|Appeal monitor: arm idempotente (nÃ£o reini..
2026-01-26 21:21:28 -0300|8ab226e|Identity assist: clicar Carregar sÃ³ quando..
2026-01-26 21:15:24 -0300|a7006f5|Monitor 1h: reload enterprise com fallback ..
2026-01-26 21:02:48 -0300|78c2bd3|Ban/2FA: arquivar no CT mesmo se close falh..
2026-01-26 20:59:54 -0300|b8aebd4|Ultra enterprise: bloqueia delete se Chrome..
2026-01-26 20:46:38 -0300|497a2d6|Enterprise: block delete when controller mi..
2026-01-26 20:34:48 -0300|38a99c3|Enterprise: auto ban/2FA via deactivate + C..
2026-01-26 19:34:40 -0300|b162ed4|Force close Chrome after ban/2FA (no skip)   
2026-01-26 17:24:55 -0300|fcf0de0|Add ban/2FA deep trace + CT archive retry q..
2026-01-26 17:07:14 -0300|d77b7ea|Unify stock_provision via login_remediate +..
2026-01-26 16:49:08 -0300|938fdd3|Fix CT archive/cred fetch fallback to env +..
2026-01-26 16:33:05 -0300|8746279|Prevent ban/2FA reopen + add fetch_logs_que..
2026-01-26 16:16:20 -0300|eb44bba|Harden self_update git to be non-interactiv..
2026-01-26 16:12:24 -0300|daa8aa3|Fix stock_provision credentials + hard kill..
2026-01-26 15:53:10 -0300|00ceb17|Ban/2FA staged guarantee: mark browserClose..
2026-01-26 15:44:18 -0300|83e1f94|Hardcore login UX + conservative PID gate: ..
2026-01-26 15:12:34 -0300|d75f985|Prevent orphan Chrome on banned/2FA: robust..
2026-01-26 14:50:50 -0300|bd2f575|Fix appeal vs identity detection; harden ba..
2026-01-26 13:54:52 -0300|4f2fcde|fix: identidade clicar Carregar sÃ³ quando ..
2026-01-26 13:51:00 -0300|68a7fb1|fix: identidade (Carregar) espera ate 150s;..
2026-01-26 13:37:55 -0300|b7e88b0|fix: ban/2FA sempre taskkill rootPid (nao d..
2026-01-26 13:26:56 -0300|12e94ae|fix: nunca deletar perfil com Chrome vivo (..
2026-01-26 13:18:22 -0300|f1adccf|fix: provisionLock compat (nao invalidar lo..
2026-01-26 13:04:40 -0300|cf01990|fix: lockProfileAction reentrante (evita de..
2026-01-26 12:56:54 -0300|8c595ab|fix: maintenance_provision auto-recover (pr..
2026-01-26 12:51:07 -0300|7554981|fix: ban/2FA serializado por perfil + limpa..
2026-01-26 12:49:30 -0300|b33db69|fix: ban/2FA ordem correta (fechar navegado..
2026-01-26 12:40:20 -0300|0cec3b4|fix: ban/2FA fecha browser por rootPid (per..
2026-01-26 12:35:19 -0300|4435e56|fix: matar processos do perfil com kill rob..
2026-01-26 12:31:25 -0300|7b33342|ux: overlay humano indica que pode arrastar..
2026-01-26 12:25:38 -0300|fb44786|fix: banned/2FA sem navegador orfao (kill p..
2026-01-26 12:14:14 -0300|c451ab2|fix: reconciliar estado real em modo humano..
2026-01-26 11:24:21 -0300|efd7810|fix: monitor recurso/identidade + overlay h..
2026-01-25 22:33:09 -0300|b8cfecd|fix: identityAssistStep - loop infinito res..
2026-01-25 22:10:41 -0300|3c90b2e|identity_wait_carregar_20_120s               
2026-01-25 22:00:02 -0300|5205bf6|identity_gate_singleton_cooldown_5_10m       
2026-01-25 21:51:13 -0300|646f564|identity_detect_humanhold_1h_monitor_selfie..
2026-01-25 21:13:04 -0300|00fc5f6|fix: safe retro 2FA sweep + avoid heavy nur..
2026-01-25 21:09:58 -0300|1b319fe|fix: 2FA sweep retroactive + allow nurseTic..
2026-01-25 21:02:16 -0300|3271a49|feat: auto-exclude accounts on two_factor (..
2026-01-25 20:17:13 -0300|739d936|fix: harden human overlay + ban sweep + app..
2026-01-25 19:00:20 -0300|886ddfc|feat(ban+create): force create/item validat..
2026-01-25 18:29:50 -0300|3b5da22|feat(human): overlay persistente no navegad..
2026-01-25 18:06:27 -0300|6e51721|chore(audit): log appeal monitor events to ..
2026-01-25 17:56:07 -0300|0cf6dcf|feat(appeal): monitor hourly even under hum..
2026-01-25 17:47:15 -0300|d1a5c1d|fix(ui): show banned instead of login/cooki..
2026-01-25 17:32:43 -0300|1b64825|fix: detect disabled_checkpoint (Desabilita..
2026-01-25 17:17:56 -0300|c9c806f|fix: human-resume runs preflight; if login_..
2026-01-25 16:47:46 -0300|75746f2|audit: add detailed configure_* events to p..
2026-01-25 15:37:52 -0300|6036eeb|fix: manual configure resumes work; require..
2026-01-25 15:34:13 -0300|7cbd0ca|fix: configure uses cookies->login->human w..
2026-01-25 15:20:08 -0300|0b510c8|fix: provision_lock + quiesce + appeal moni..
2026-01-24 18:15:58 -0300|5e85a25|configure: resume paused virtus; human-resu..
2026-01-24 17:11:07 -0300|cb9b8de|quiesce: require global pause before cookie..
2026-01-24 16:46:18 -0300|c578a81|status: expose virtusOnline/sendLock/robeEx..
2026-01-24 16:22:18 -0300|e0d5f4f|stock_provision: wait quiesce + expose busy..
2026-01-24 16:07:39 -0300|a21fdfc|audit: log virtus pause during provision lock
2026-01-24 02:12:29 -0300|e81922c|fix(login_required): stop virtus; validate ..
2026-01-24 01:44:09 -0300|ae979e1|fix(human-resume): clear loginRemediateFail..
2026-01-24 01:29:56 -0300|69fffd8|fix(login): detect 2FA/checkpoint by URL pa..
2026-01-24 01:16:51 -0300|495cff4|fix(login): detect 2FA; fail-fast on any no..
2026-01-24 01:00:24 -0300|1ec81e7|fix(login): robust submit + messenger login..
2026-01-24 00:33:55 -0300|be77706|fix(login_remediate): validate messenger+fa..
2026-01-24 00:12:29 -0300|6d06fca|fix(login): prevent auto loops + open-all h..
2026-01-23 23:59:44 -0300|b296cc3|feat(worker): auto login_remediate when log..
2026-01-23 23:35:51 -0300|2f82c24|ops: add profiles_cleanup command and allow..
2026-01-23 23:25:38 -0300|6d771c7|docs: ultra enterprise system audit (provis..
2026-01-23 23:09:41 -0300|9c2afa3|login_remediate: deterministic post-success..
2026-01-23 23:01:44 -0300|3f4df53|dashboard: route login_remediate via cluste..
2026-01-23 22:56:03 -0300|a292da2|status: include _debug controllersCount/pid..
2026-01-23 22:30:39 -0300|477031c|login_remediate: set desired active+virtus ..
2026-01-23 22:16:46 -0300|98a1d1c|login_remediate: fix post-success deadlock;..
2026-01-23 21:59:51 -0300|563695d|login_remediate: post-success close browser..
2026-01-23 21:36:33 -0300|c1bfed2|login_remediate: validate real tabs (messen..
2026-01-23 21:05:56 -0300|6f5a4ea|consent: include Fechar/X in unblock (deter..
2026-01-23 20:59:43 -0300|4178f6d|consent flow: click ComeÃ§ar/Confirmar; saf..
2026-01-23 20:51:00 -0300|0b52023|consent unblock: allow safe GPT clicks outs..
2026-01-23 20:42:39 -0300|8724df4|pin modal: handle 'Mais opÃ§Ãµes' flow + sk..
2026-01-23 20:35:13 -0300|bf43d6c|ui_unblock: handle messenger PIN modal + ha..
2026-01-23 20:32:08 -0300|80872d6|messenger pin: default 882584 (env override..
2026-01-23 20:18:54 -0300|9536768|login_remediate: failfast deactivate timeou..
2026-01-23 19:58:22 -0300|6eaacf6|login_remediate: GPT eyes for consent/popup..
2026-01-23 19:33:31 -0300|43c4d7f|fix(login_remediate): treat captcha as requ..
2026-01-23 19:17:54 -0300|747695f|hardening(login_remediate): strict login de..
2026-01-23 19:06:58 -0300|048ed09|fix(login_remediate): optional override of ..
2026-01-23 18:56:50 -0300|2eb0b97|feat(login_remediate): fetch credentials fr..
2026-01-23 18:37:19 -0300|61ebe1f|fix(login_remediate): hard timeouts + fail-..
2026-01-23 17:57:33 -0300|2ea38c9|chore(login_remediate): ack correctness, re..
2026-01-23 17:50:47 -0300|fd66267|fix(login_remediate): resume virtus after r..
2026-01-23 17:42:15 -0300|3a26eab|feat(login_remediate): command + worker flo..
2026-01-23 15:23:09 -0300|ffc62a2|fix: sticky shard rebalance (no mass shard_..
2026-01-23 15:05:49 -0300|97236e3|audit: log worker hardClose/deactivate to p..
2026-01-23 14:48:55 -0300|7243707|audit: log created profileName during stock..
2026-01-23 14:46:51 -0300|243171a|audit: add provision_audit + close_all inst..
2026-01-23 14:22:34 -0300|8ed158d|obs: expose git HEAD via fetch_logs allowlist
2026-01-23 14:13:57 -0300|3bb17b8|docs: ultra enterprise provision policy      
2026-01-23 14:12:37 -0300|2703849|ultra: allow close_all only when explicit h..
2026-01-23 14:11:34 -0300|3391475|ultra: limit swap_for_open + pause virtus d..
2026-01-23 13:48:16 -0300|8ce1d43|ultra: ram policy + provision close_all guard
2026-01-23 00:49:40 -0300|594dd4f|fix: isolate manual configure with global l..
2026-01-22 23:45:36 -0300|30723c3|fix: close_all acquires lock to prevent aut..
2026-01-22 23:15:11 -0300|4ab834c|feat: add provision_unlock command and expo..
2026-01-22 23:09:16 -0300|c3ec39a|fix: pass operator to automationAllowed in ..
2026-01-22 22:48:08 -0300|944548e|Allow stock_provision owner to run start_wo..
2026-01-22 22:41:10 -0300|b6bc7a7|Add convenient auto-backup snapshots with r..
2026-01-22 22:27:26 -0300|46186dd|Fix provision lock: allow owner operator + ..
2026-01-22 22:19:20 -0300|cd474ba|Fix logs secret precedence: ct_config overr..
2026-01-22 21:56:38 -0300|6ab1622|Hardening stock_provision: backpressure, pr..
2026-01-21 20:46:44 -0300|b41fb62|feat(stock): nova conta pausa Robe 24h (new..
2026-01-21 20:37:29 -0300|75c8aa0|feat(ui): nova conta manual - seletor de ca..
2026-01-21 16:50:17 -0300|08a286a|feat: automaÃ§Ã£o completa de PIN - digita ..
2026-01-21 16:43:11 -0300|40aa6b8|Revert "feat: automaÃ§Ã£o de PIN do Messeng..
2026-01-21 16:41:42 -0300|b894426|feat: automaÃ§Ã£o de PIN do Messenger - dig..
2026-01-21 16:32:45 -0300|f5c3b42|feat(ui): scan all tabs for loginRequired +..
2026-01-21 16:25:31 -0300|d6e0d4d|feat(ui): detect identity confirmation (sel..
2026-01-21 15:57:31 -0300|0588e91|feat(messenger): nurse GPT fallback + riche..
2026-01-21 15:53:07 -0300|3af95ba|fix(messenger): scan all tabs for PIN modal..
2026-01-21 15:37:19 -0300|bf4cafc|fix(messenger): auto-dismiss PIN modal in w..
2026-01-21 15:17:30 -0300|781e2c8|fix(messenger): dismiss PIN restore modal +..
2026-01-21 14:31:04 -0300|b461df6|fix: stock-update store-only (no auto cooki..
2026-01-21 14:08:57 -0300|96edd4d|fix: delete_perfis closes active browser be..
2026-01-21 10:36:10 -0300|643f30c|feat: add delete_perfis remote command       
2026-01-21 10:22:48 -0300|14f9d1b|feat: auto-request ct_config when missing +..
2026-01-20 10:44:08 -0300|3b6813e|enterprise: provision resiliente + PIN moda..
2026-01-19 22:24:58 -0300|452f0a3|ui: remover toast de sucesso no Nova Conta   
2026-01-19 22:10:35 -0300|638b763|fix: escapeHtml no modal Nova Conta + logar..
2026-01-19 22:07:12 -0300|51085d5|ui: diagnostico enterprise no modal Nova Co..
2026-01-19 21:59:18 -0300|e394917|fix: painel sem Electron (fallback listPerf..
2026-01-19 21:56:07 -0300|36d9651|fix: CORS local aceitar ::ffff:127.0.0.1 (E..
2026-01-19 21:50:41 -0300|26ca165|fix: permitir Origin null (Electron) no COR..
2026-01-19 21:31:48 -0300|26526dc|stock: permitir configurar CT/secret via ar..
2026-01-19 21:19:13 -0300|cda3f1b|deploy: bloquear restart automatico no self..
2026-01-19 21:09:23 -0300|49fe747|ui: no-cache no painel para updates imediatos
2026-01-19 21:06:03 -0300|efbfa6d|stock: robustecer nova conta (estoque CT) +..
2026-01-19 19:47:11 -0300|0730428|self_update: opcao restart para aplicar cod..
2026-01-19 19:45:11 -0300|dd09e0b|Stock: nova conta via estoque + comandos st..
2026-01-17 17:33:04 -0300|f7f77ee|ui: estado final Ãºnico por conta (sem dupl..
2026-01-17 15:50:17 -0300|522b431|ops: nÃ£o engolir erro em close_all/open_al..
2026-01-17 15:34:10 -0300|ce317e8|ui: refletir close_all remoto no painel (op..
2026-01-17 15:23:48 -0300|3f9edf7|ops: close_all canÃ´nico (close-all) + dash..
2026-01-17 15:04:34 -0300|e8d0ed6|perf: reiniciar runner do virtus quando gov..
2026-01-17 15:03:10 -0300|e448690|perf: governor SLOW por loop-lag (sem WMI) ..
2026-01-17 13:28:08 -0300|3ce690f|gpt: ingest automÃ¡tico de evidÃªncia (LR) ..
2026-01-17 12:24:12 -0300|62e10c6|fb: separar captcha_persona de checkpoint_c..
2026-01-17 11:10:12 -0300|9e414c2|lr: registrar snapshot quando nÃ£o hÃ¡ pÃ¡g..
2026-01-17 10:58:07 -0300|176f2df|lr: registrar evidÃªncia quando flag LR jÃ¡..
2026-01-17 10:49:00 -0300|9693db5|fix: worker os duplicate require             
2026-01-17 10:35:31 -0300|27b113b|logs: incluir login_required_events no fetc..
2026-01-16 14:39:05 -0300|e32b86a|commands: fail unknown command types (no fa..
2026-01-16 14:36:28 -0300|117ba6e|logs: add logs_manifest command + expand al..
2026-01-16 14:17:57 -0300|437a9a2|bootstrap: add task_ui mode for visible bro..
2026-01-16 14:12:07 -0300|385c963|bootstrap: reuse local nssm.exe (avoid down..
2026-01-16 14:06:30 -0300|5fa6984|bootstrap: treat service-exists even with P..
2026-01-16 14:03:47 -0300|4ed0b2f|bootstrap: NSSM install idempotent when ser..
2026-01-16 14:02:05 -0300|6f16bba|bootstrap: fix NSSM env args (no null bytes..
2026-01-16 13:57:13 -0300|e4ffe2e|bootstrap: auto-download NSSM when allowed   
2026-01-16 13:53:06 -0300|6801d52|bootstrap: task mode without admin (onlogon..
2026-01-16 13:50:37 -0300|7db161b|logs sob demanda + self_update + migrate_pr..
2026-01-16 11:46:30 -0300|afc9b59|telemetria: enviar host.totalMemGB no /report
```

