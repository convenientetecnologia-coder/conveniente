# Checkup — 2026-04-29 — Virtus Offline preso + Abas 2/3 inconsistentes

## Escopo

Auditoria forense read-only (sem codar) para o sintoma:

- card de perfil no dashboard mostra `Virtus Offline` e `Abas: 2/3`;
- a conta fica dificil de destravar com `invocar humano`/`retomar`;
- em alguns casos so reinicio do servidor resolve.

---

## Evidencias de implementacao (codigo)

## 1) Como o dashboard decide `Virtus Offline`

No frontend, o pill usa `p.trabalhando`:

- arquivo: `C:/conveniente/public/index.html`
- regra: `Virtus ${p.trabalhando ? 'Online' : 'Offline'}`

Conclusao: offline no card nao vem diretamente de `virtusOnline`; vem de `trabalhando`.

## 2) Como o dashboard decide `Abas: N`

No frontend, mostra pill apenas quando `numPages > 1`:

- arquivo: `C:/conveniente/public/index.html`
- origem de dado: overlay de `/api/status` sobre baseline de `/api/perfis`.

## 3) Origem dos dados (`/api/status` + fallback)

- `/api/perfis` traz baseline de `perfis.json` (`scripts/api_perfis.js`).
- `/api/status` tenta `worker get-status`; em falha usa fallback/baseline cache e warning (`scripts/api_status.js`).

Risco identificado:

- quando overlay do worker falha/atrasa, UI pode exibir estado parcial/stale.

## 4) Quem calcula `trabalhando` e `numPages`

- `trabalhando` e `numPages` saem do `get-status` do worker (`scripts/worker.js`).
- `numPages` e alimentado por hooks de browser/pruner (`scripts/browser.js` + callback `onNumPages` no worker).

## 5) Guardas/locks que podem travar fluxo de recuperacao

Mapeados no runtime:

- `maintenance_provision` / `provision_lock` podem bloquear `activate`.
- `killGuardUntil` pode impedir reabertura temporaria.
- captcha flow pode retornar `inproc_busy` / `governor_busy`.
- `human-resume` falha quando browser nao esta conectado (`human_resume_no_browser`).

Arquivos:

- `C:/conveniente/scripts/worker.js`
- `C:/conveniente/scripts/provisionLock.js`
- `C:/conveniente/scripts/api_perfis.js`

---

## Hipoteses fortes (sem aplicar patch ainda)

1. Estado stale no card por fallback de `/api/status` quando `get-status` falha.
2. `numPages` reportado por ciclo de prune/guard pode atrasar frente ao estado visual real.
3. Guardas de lock (`provision_lock`, `kill_guard`, captcha mutex/governor) bloqueiam retomada e parecem "conta presa".
4. `human-resume` sem browser conectado gera erro e nao reconcilia tudo sozinho.

---

## Proxima etapa (quando autorizado)

1. Montar matriz operacional: sintoma -> flag/lock -> endpoint de confirmacao -> acao segura.
2. Coletar evidencias por perfil afetado (host/perfil/cmdId e janelas de tempo) via CT.
3. Definir patch minimo com rollback para:
   - reduzir falso offline/stale no card;
   - melhorar reconciliacao de estado apos `human-resume`/reopen;
   - endurecer consistencia de `numPages`.

---

## Execucao — fase 1 (2026-04-30)

Implementado patch minimo em `C:/conveniente/scripts/worker.js`:

1. `numPages` no `get-status` agora zera para perfis sem controller ativo (`active=false`), evitando pill stale `Abas: N`.
2. `human-resume` ganhou reconciliacao segura para caso `browser_not_connected`:
   - limpa meta runtime relevante (`numPages=0`, `whyNotOpen`);
   - remove `humanHold` no desired;
   - agenda `activate` assíncrono quando `desired.active=true`;
   - registra issue/audit de reconciliacao.

Objetivo: reduzir casos de conta "presa" que antes exigiam restart completo.

