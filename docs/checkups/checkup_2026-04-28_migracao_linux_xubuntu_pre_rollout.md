### Checkup — Migração Linux Xubuntu (pré-rollout com sessão gráfica)

> Regra: este arquivo é um **relatório**. O resumo (1–3 linhas) vai para `docs/TIMELINE.md`.

#### Contexto

- Data: 2026-04-28
- Ambiente: pre-rollout (auditoria + preparação canônica)
- Hosts envolvidos (hostId/hostname): n/a (etapa de preparação)
- Sintoma: necessidade de operar `conveniente` em Xubuntu 24.04 com menor custo operacional, mantendo compatibilidade com Windows.
- Impacto: sem trilha Linux canônica, há risco de setup inconsistente, drift de runtime e quebra de operação visual.

---

### Evidências coletadas (objetivas)

- Arquivos de instalação/execução:
  - `C:\conveniente\instalar_conveniente.ps1` (instalador Windows canônico)
  - `C:\conveniente\scripts\bootstrapService.js` (bootstrap atual Windows-only)
  - `C:\conveniente\scripts\browser.js` (launch Puppeteer + paths Linux/Windows)
  - `C:\conveniente\scripts\api_perfis.js` (`userDataDir` cross-platform)
- Trechos relevantes:
  - fallback Linux para binário de navegador: `/usr/bin/google-chrome-stable`, `/usr/bin/google-chrome`, `/snap/bin/chromium`;
  - operação visual com launch headful por padrão, porém com override via env (`HEADLESS`, `OVERRIDE_HEADLESS`);
  - kill/cleanup Linux já existente com `pkill` e parse de `ps` (best-effort).
- Novos artefatos desta frente:
  - `C:\conveniente\scripts\install_conveniente_linux.sh`
  - `C:\conveniente\scripts\browser.js` (guardrail headless)
  - seção canônica Linux no `C:\conveniente\docs\RUNBOOK_TECNICO.md`

---

### Achados (P0/P1/P2)

- **P0**: não havia instalador Linux canônico com 1 comando; apenas fluxo Windows.
- **P0**: bootstrap operacional formal estava acoplado a Windows (`Task Scheduler`/`NSSM`), sem caminho Linux documentado.
- **P1**: política "sempre visível" poderia ser quebrada por envs de headless se não houvesse guardrail documental.
- **P1**: gestão de processos no Linux já existe, mas depende de matching por cmdline/path (funciona, porém requer validação em VM/host real).
- **P2**: coexistência de nomenclatura Chrome/Chromium em pontos diferentes demanda disciplina de configuração para evitar drift.

---

### Decisão / Ação recomendada (cirúrgica)

- O que mudar:
  - manter instalador Windows atual para hosts Windows;
  - introduzir instalador Linux dedicado e idempotente (`scripts/install_conveniente_linux.sh`);
  - bloquear headless acidental por padrão no launcher (headless somente com exceção explícita);
  - formalizar operação Linux em sessão gráfica ativa e navegador visível no runbook.
- Por quê:
  - garantir previsibilidade de setup Linux sem alterar o fluxo consolidado de Windows.
- Risco:
  - diferença entre ambiente VM e host produtivo (driver gráfico, sessão ativa, permissões de terminal).
- Rollback:
  - não promover Linux para produção e manter operação em Windows;
  - reverter commits da trilha Linux no repositório se necessário.

---

### Plano de rollout

- Reinícios necessários (quais processos/nodes):
  - nesta etapa de preparação: nenhum;
  - quando aplicar em host Linux: reiniciar apenas `conveniente` no host alvo (`node index.js`).
- Ordem:
  1) validar instalador em Xubuntu limpo;
  2) validar painel + navegador visível + health;
  3) validar estabilidade curta (abertura/fechamento/retomada);
  4) promover por canário antes de expansão.
- Validação pós-rollout (checks):
  - `node -v`, `npm -v`, `google-chrome --version`;
  - `GET /health` e `GET /api/status`;
  - evidência de operação visual (sem headless operacional);
  - manutenção de compatibilidade com hosts Windows sem alteração de procedimento.
