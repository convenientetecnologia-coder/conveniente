### Checkup — migração Chrome -> Chromium (pré-código)

> Regra: este arquivo é um **relatório**. O resumo (1–3 linhas) vai para `docs/TIMELINE.md`.

#### Contexto

- Data: 2026-03-05
- Ambiente: prod (auditoria de código; sem rollout)
- Hosts envolvidos (hostId/hostname): n/a (fase pré-código)
- Sintoma: necessidade de trocar runtime de `chrome.exe` para `chromium`, preservando sessões já logadas e melhorando UX de identificação por conta.
- Impacto: regressão aqui pode derrubar login persistente e quebrar operação de perfis em produção.

---

### Evidências coletadas (objetivas)

- Arquivos-chave:
  - `C:\conveniente\scripts\browser.js`
  - `C:\conveniente\scripts\api_perfis.js`
  - `C:\conveniente\scripts\worker.js`
  - `C:\conveniente\scripts\bootstrapService.js`
  - `C:\conveniente\scripts\dashboard.js`
  - `C:\conveniente\index.js`
- Trechos relevantes:
  - `browser.js`: `findChromeStable()`, `ensureUserDataDirUnderChrome()`, `openBrowser(...)`.
  - `api_perfis.js` e `worker.js`: `resolveChromeUserDataRoot()` (hardcoded em `Google\\Chrome\\User Data`).
  - `bootstrapService.js`: `buildEnvPairs()` não propaga `CHROME_PATH/CHROMIUM_PATH`.
  - `dashboard.js`: auditorias/purge assumem `chromeRoot/Conveniente/<nome>`.
- Cmd de evidência:
  - mapeamento por `Select-String` em código (`CHROME_PATH`, `CHROMIUM_PATH`, `userDataDir`, `Google\\Chrome\\User Data`, `OPEN_CHROMIUM_ON_START`).

---

### Achados (P0/P1/P2)

- **P0-1 — Executável Chromium no Windows não é descoberto por padrão**
  - Em `browser.js`, `findChromeStable()` no Windows lista apenas paths default do Google Chrome.
  - `CHROMIUM_PATH` funciona, mas depende de env; sem isso pode continuar no Chrome ou falhar se Chrome não existir.
  - Risco: migração "aparente" sem efetivamente trocar engine em todos os hosts.

- **P0-2 — Serviço agendado/NSSM pode perder env crítico da migração**
  - `bootstrapService.js` propaga poucas envs (`LOG_INGEST_SECRET`, `PORT`, `DASHBOARD_INTERVAL_MS`, `OPEN_CHROMIUM_ON_START`).
  - Não propaga `CHROMIUM_PATH`/`CHROME_PATH` nem uma flag explícita de engine.
  - Risco: host que roda via task/service iniciar com configuração diferente da sessão interativa.

- **P0-3 — Persistência de sessão está acoplada ao root "Google Chrome User Data"**
  - `api_perfis.js`, `worker.js`, `browser.js`, `dashboard.js` usam/assumem `...Google\\Chrome\\User Data\\Conveniente\\<nome>`.
  - Isso é bom para preservar sessão existente (requisito atual), mas exige decisão explícita:
    - manter root atual (recomendado na Fase 1), ou
    - migrar root (não recomendado agora).

- **P1-1 — Requisito UX “nome + email no menu do navegador” não está implementado hoje**
  - Não há código setando identidade visual do perfil (somente normalização de `Preferences` para `exited_cleanly/session`).
  - Risco: tentar “forçar email no menu” sem login Google pode não refletir nativamente no UI.

- **P1-2 — Arg launch desativa `ProfilePicker`**
  - `--disable-features=...ProfilePicker...` está nas flags de launch.
  - Pode impactar justamente a área de UX onde o operador quer ver dados do perfil.

- **P2-1 — nomenclatura está confusa (Chrome/Chromium misturados)**
  - Ex.: `OPEN_CHROMIUM_ON_START` no `index.js` abre painel; launch principal usa função `findChromeStable`.
  - Sem padronização de naming, risco de operação equivocada aumenta.

---

### Decisão / Ação recomendada (cirúrgica)

- O que mudar (fase de código, ainda não executada):
  1) Introduzir seleção explícita de engine (`BROWSER_ENGINE=chrome|chromium`) com default seguro.
  2) Tornar resolução do executável determinística:
     - Chromium no Windows via `CHROMIUM_PATH` obrigatório quando engine=chromium.
     - opcionalmente incluir paths default de Chromium Windows como fallback.
  3) Preservar `userDataDir` atual (`Google\\Chrome\\User Data\\Conveniente\\<nome>`) na Fase 1.
  4) Propagar envs de engine/executable no bootstrap (task/NSSM) para eliminar drift.
  5) UX nome/email: prova técnica isolada antes de rollout (POC em 1 perfil de teste).

- Por quê:
  - garante troca real de engine sem quebrar sessão atual nem criar divergência entre hosts.

- Risco:
  - maior risco é “achar que está em Chromium”, mas parte dos hosts continuar em Chrome por falta de env no service mode.

- Rollback:
  - manter baseline (backup já concluído) + revert de commit + restart manual (`node index.js`) no host alvo.

---

### Plano de rollout

- Reinícios necessários (quais processos/nodes):
  - quando entrar na fase de código: `conveniente` no host de teste.
- Ordem:
  1) Implementar mudanças de seleção de engine.
  2) Testar em 1 host (sessão persistente 3 ciclos).
  3) Validar logs e evidência.
  4) Expandir gradualmente.
- Validação pós-rollout (checks):
  - perfil abre logado após restart de navegador (3x).
  - confirmar executável real usado no launch (log do path).
  - confirmar `userDataDir` esperado e sem criação de perfil “novo”.
  - checar fluxos: abrir/fechar, invocar humano, retomar trabalho.

