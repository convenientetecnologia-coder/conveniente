### INBOX — relatos do humano (Cássio) — CANÔNICO

Objetivo: quando o humano mandar um texto grande/bagunçado com “mil problemas”, o GPT usa este arquivo como **canal de intake**:

- colar o **texto bruto** (sem julgar)
- quebrar em **itens separados** (um por problema)
- classificar por **P0/P1/P2**
- marcar o que falta (evidência/logs/cmdId/hostId)
- mapear “relato X” → **arquivo(s)/função(s)** → hipótese → plano

> Regra: o humano não investiga nem coleta logs manualmente. O GPT puxa logs via CT, e o humano só reinicia `node index.js` quando solicitado.

---

## Regras não negociáveis (resumo)

- **Sou humano**: eu só reinicio processos no servidor com `node index.js` e confirmo “reiniciado”. Eu não coleto logs manualmente, não rodo comandos, não copio/colo evidência.
- **Você é o operador técnico**: você edita código, cria comandos, coleta logs via CT, registra docs, faz commit/push.
- **Sempre diga no início**:
  - **Precisa reiniciar?** sim/não
  - **Qual projeto?** conveniente / sitechatbot / notificador
  - **Como reiniciar (humano)?** `node index.js`
  - **Por quê?** (1 frase)
- **Sem achismo**: qualquer decisão importante tem que citar evidência (arquivo/path, log key, cmdId/requestId, endpoint).
- **Sem segredos**: nunca colar valores de secrets em chat/docs (apenas nomes/onde configurar).
- **Windows/PowerShell**: não usar `&&` nem heredoc `<<EOF` (usar `;` e `git commit -m ... -m ...`).
- **Melhoria contínua**: se você errou e depois acertou, você atualiza RUNBOOK/LIVRO/TIMELINE e sobe commit pro GitHub.
- **Padrão conveniente**: se mexeu no conveniente, você já faz commit/push + dispara `self_update` e só pede o restart.

### Arquivos canônicos (use sempre)

- `C:\conveniente\docs\LIVRO_DE_BORDO.md`
- `C:\conveniente\docs\RUNBOOK_TECNICO.md`
- `C:\conveniente\docs\TIMELINE.md`
- `C:\conveniente\docs\checkups\README.md`
- `C:\conveniente\docs\checkups\TEMPLATE_CHECKUP.md`
- `C:\conveniente\docs\checkup_geral_2026-01-29.md`

---

### Como usar (passo a passo)

1) **Colar o texto bruto** do humano em “RAW_INPUT”.
2) **Criar itens** na tabela “TRIAGE” (1 linha por problema).
3) Para cada item, criar uma seção “ITEM …” com:
   - hipótese(s)
   - evidência solicitada (logs keys / requestId / cmdId)
   - o que o GPT vai mudar (arquivos)
   - precisa reiniciar agora? sim/não
   - precisa reiniciar para validar? sim/não
4) **Obrigatório**: antes de mexer em código, fazer **análise de impacto**:
   - quem chama / quem é chamado (callers/callees)
   - quais arquivos/estados são tocados (desired/perfis/status/locks)
   - quais efeitos colaterais podem acontecer (ex.: “fechar” disparar “abrir” por nurse/desired)
   - quais riscos de regressão e como reduzir (mudança mínima + guardrails + rollback)
5) **Obrigatório**: antes de investigar “do zero”, olhar o **passado** (evitar repetir erro / achar regressão):
   - `C:\conveniente\docs\TIMELINE.md` (entradas relacionadas)
   - `C:\conveniente\docs\checkups\file_timeline\INDEX_*.md` (qual arquivo é hotspot)
   - se o sintoma parece regressão: procurar commits recentes nos arquivos-alvo (o GPT faz isso)

---

## RAW_INPUT (colar aqui)

```text
[cole aqui o texto bruto do humano]
```

---

## TRIAGE (1 linha por problema)

Colunas:
- **id**: `INC-YYYYMMDD-HHMM-XX`
- **P**: P0/P1/P2
- **sistema**: conveniente / sitechatbot / notificador
- **sintoma (humano)**: 1 frase
- **hipótese (GPT)**: 1 frase
- **evidência**: logs keys / cmdId / requestId / endpoint
- **status**: new / need_evidence / in_progress / blocked / done
- **precisa reiniciar agora?** sim/não
- **precisa reiniciar p/ validar?** sim/não

| id | P | sistema | sintoma (humano) | hipótese (GPT) | evidência | status | reiniciar agora? | reiniciar p/ validar? |
|---|---|---|---|---|---|---|---|---|
| INC-YYYYMMDD-HHMM-01 | P1 | conveniente | … | … | logs_manifest + fetch_logs(keys=…) | need_evidence | não | sim |

---

## ITEM TEMPLATE (copiar/colar por item)

### ITEM: INC-YYYYMMDD-HHMM-XX — Título curto

- **P**: P?
- **Sistema**: conveniente / sitechatbot / notificador
- **Sintoma (humano)**:
- **Reprodução (se existir)**: (passos simples)
- **Hipóteses (GPT)**:
  - H1:
  - H2:
- **Evidência a coletar (GPT)**:
  - logs_manifest (hostId=…)
  - fetch_logs(keys=…)
  - cmdId/requestId (se aplicável)
- **Arquivos prováveis**:
  - `...`
- **Mapa de impacto (obrigatório)**:
  - **Fluxo ponta a ponta (alto nível)**: (ex.: CT → dashboard.applyCommands → endpoint → worker → arquivo/estado)
  - **Callers** (quem chama esse fluxo):
    - …
  - **Callees** (o que esse fluxo aciona):
    - …
  - **Estados tocados**: `desired.json` / `status.json` / `perfis.json` / manifests / locks / timers
  - **Efeitos colaterais possíveis**:
    - “X pode religar Y” (ex.: nurse/desired/virtus)
  - **Risco de regressão** (1 frase) + **mitigação** (1 frase)
- **Histórico relacionado (obrigatório)**:
  - **Timeline**: cite as entradas relevantes de `docs/TIMELINE.md` (data + título).
  - **Hotspots/arquivos**: cite quais arquivos aparecem no `docs/checkups/file_timeline/` e por quê.
  - **Hipótese de regressão**: “isso pode ter começado após mudança X” (com evidência).
- **Plano (mudança mínima)**:
  - …
- **Precisa reiniciar agora?** sim/não — por quê
- **Precisa reiniciar para validar/testar?** sim/não — por quê
- **Validação**:
  - endpoint/log esperado
- **Rollback**:
  - `git revert` + (se for validar rollback) reiniciar `node index.js`

