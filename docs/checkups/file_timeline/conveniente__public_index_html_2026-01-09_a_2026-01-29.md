### `conveniente/public/index.html` — timeline por dia/commit — 2026-01-09 → 2026-01-29

Como usar:
- Abrir diff do commit: `git show <hash>`
- Este arquivo concentra mudanças do painel (UI/labels/fluxos de operação/humano).

Cobertura real:
- commits: 19
- min: 2026-01-17 15:34:10 -0300
- max: 2026-01-29 01:12:45 -0300

---

## 2026-01-17 (2)
- 2026-01-17 17:33:04 -0300 | f7f77ee | ui: estado final Ãºnico por conta (sem duplicidade login/limite/captcha)
- 2026-01-17 15:34:10 -0300 | ce317e8 | ui: refletir close_all remoto no painel (ops em /api/status)

## 2026-01-19 (6)
- 2026-01-19 22:24:58 -0300 | 452f0a3 | ui: remover toast de sucesso no Nova Conta
- 2026-01-19 22:10:35 -0300 | 638b763 | fix: escapeHtml no modal Nova Conta + logar excecao real
- 2026-01-19 22:07:12 -0300 | 51085d5 | ui: diagnostico enterprise no modal Nova Conta (estoque)
- 2026-01-19 21:59:18 -0300 | e394917 | fix: painel sem Electron (fallback listPerfis/getStatus)
- 2026-01-19 21:06:03 -0300 | efbfa6d | stock: robustecer nova conta (estoque CT) + debug
- 2026-01-19 19:45:11 -0300 | dd09e0b | Stock: nova conta via estoque + comandos stock_export_profiles/push

## 2026-01-21 (1)
- 2026-01-21 20:37:29 -0300 | 75c8aa0 | feat(ui): nova conta manual - seletor de categoria (fretes/veiculos)

## 2026-01-24 (2)
- 2026-01-24 02:12:29 -0300 | e81922c | fix(login_required): stop virtus; validate marketplace create/item; retry ui unblock; improve UI labels
- 2026-01-24 01:00:24 -0300 | 1ec81e7 | fix(login): robust submit + messenger login detection + human invoke + UI flag

## 2026-01-25 (2)
- 2026-01-25 17:56:07 -0300 | 0cf6dcf | feat(appeal): monitor hourly even under humanHold; expose countdown fields; UI shows Recurso em anÃ¡lise timer
- 2026-01-25 17:47:15 -0300 | d1a5c1d | fix(ui): show banned instead of login/cookies failed; clear loginRemediateFailed on ban

## 2026-01-26 (1)
- 2026-01-26 11:24:21 -0300 | efd7810 | fix: monitor recurso/identidade + overlay humano arrastavel + hard-close banned + slug no painel

## 2026-01-28 (3)
- 2026-01-28 17:35:41 -0300 | 5fd5bcf | Close-all hardening: dashboard uses backend close-all; cancel open-all session during close-all
- 2026-01-28 16:07:26 -0300 | cc1563b | Open-all backend orchestration: strict order mapping-only, global pause, UI progress
- 2026-01-28 15:01:07 -0300 | cfed608 | Dashboard hardening: no flicker on transient API failures; bounded resource wait

## 2026-01-29 (2)
- 2026-01-29 01:12:45 -0300 | 9859829 | rollback: snapshot 20260127_165414 (16:54) code-only
- 2026-01-29 00:30:17 -0300 | 225c756 | feat(close_all): cancel on dashboard refresh + preempt provision_lock

