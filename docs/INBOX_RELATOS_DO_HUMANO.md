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
6) **Obrigatório**: antes de corrigir, fazer **perguntas item-a-item** (alinhamento humano):
   - “como deveria ser?” (comportamento esperado)
   - “qual é o critério de sucesso?” (como validar)
   - “isso é P0/P1/P2 pra você?” (impacto)
   - “precisa disso hoje (agora) ou pode ser depois?” (prioridade)

---

## RAW_INPUT (colar aqui)

```text
triagem inbox

Antes das atualizações P0/P1/P2, eu estava com problemas no cadastro/provisionamento de conta (estoque).
No “Estoque disponíveis” a conta ficava reservada mas não ia (isso em todos os servidores, como mostra no histórico).

Histórico (recorte):

ID	Tipo	Status	Servidor	Conta	Erro	Quando
10630	provision_guard	concluído	—	—		29/01/2026, 20:03:02
10629	provision_guard	concluído	—	—		29/01/2026, 19:57:01
10628	provision_guard	concluído	—	—		29/01/2026, 19:51:01
10627	provision_guard	concluído	—	—		29/01/2026, 19:44:57
10626	provision_guard	concluído	—	—		29/01/2026, 19:38:57
10625	provision_guard	concluído	—	—		29/01/2026, 19:32:56
10624	provision_guard	concluído	—	—		29/01/2026, 19:26:56
10623	provision_guard	concluído	—	—		29/01/2026, 19:20:55
10622	provision_guard	concluído	—	—		29/01/2026, 19:14:55
10621	Cadastrador (provisionar conta)	concluído	ROBE MÃE 4	#505	fail ok=0 fail=1	29/01/2026, 19:13:10
10620	Cadastrador (provisionar conta)	falhou	ROBE MÃE 2	#504	fail ok=0 fail=1	29/01/2026, 19:12:11
10619	Cadastrador (provisionar conta)	falhou	ROBE MÃE 1	#503	fail ok=0 fail=1	29/01/2026, 19:11:26
10618	Cadastrador (provisionar conta)	falhou	ROBE MÃE 7	#502	fail ok=0 fail=1	29/01/2026, 19:11:11
10617	provision_guard	concluído	—	—		29/01/2026, 19:08:41
10616	Cadastrador (provisionar conta)	falhou	ROBE MÃE 6	#502	fail ok=0 fail=1	29/01/2026, 19:05:56
10615	Cadastrador (provisionar conta)	falhou	ROBE MÃE 5	#502	fail ok=0 fail=1	29/01/2026, 19:02:56
...
10596	Cadastrador (provisionar conta)	falhou	ROBE MÃE 4	#500	stale_account_moved	29/01/2026, 18:23:08
...

Depois de todas as atualizações, eu atualizei o ROBE MÃE 4, fiz o teste e ele cadastrou uma conta.
Não sei exatamente porque/onde destravou, mas aparentemente foi destravado.

Agora queremos investigar o fluxo do começo ao fim e garantir que todos os servidores cadastram contas de forma perfeita,
sem contas ficando presas em “reserved” e sem falhas silenciosas.
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
| INC-20260129-2100-01 | P1 | sitechatbot+conveniente | conta do estoque fica “reserved” mas não provisiona (falhas em massa) | hook do CT não atualiza job/solta reserva (ex.: busca por command_id limitada) e/ou falta de evidência no ACK | CT DB (jobs/accounts) + ack files + provision_audit.jsonl | in_progress | não | não |

---

### ITEM: INC-20260129-2100-01 — Estoque: “reserved mas não vai” (provision)

- **P**: P1 (pode virar P0 se voltar a travar em produção)
- **Sistema**: `sitechatbot` (estoque/CT) + `conveniente` (executor do provision)
- **Sintoma (humano)**: conta fica reservada no estoque, mas o provision falha e a conta não “anda”; ocorreu em múltiplos servidores; depois de updates, RM4 conseguiu provisionar 1 conta.
- **Como deveria ser (humano)**: (pendente — perguntar)
- **Critério de sucesso (humano)**: (pendente — perguntar)
- **Hipóteses (GPT)**:
  - H1: hook do CT em `/api/commands/ack` não encontra o job do `stock_provision` (busca limitada via `listJobs(limit=200)`), então não atualiza job e não libera `reserved`.
  - H2: `details.results` do ACK não carrega info suficiente (ex.: `profileName`/`stockAccountId`) para o CT decidir `assigned` vs `release` corretamente em falhas.
  - H3: guard `provision_guard` está rodando mas não consegue resolver rapidamente (TTL alto / janela grande), gerando “presas” temporárias.
- **Evidência a coletar (GPT)**:
  - CT DB: contas `reserved` + jobs `provision` `running` (sem imprimir login/senha/cookies).
  - ACK evidence: `sitechatbot/dados/logs/<hostId>/ack_<cmdId>.json` para `stock_provision` (verificar `details.results` e erros).
  - Servidor executor (RM4): `fetch_logs_query` em `provision_audit` por `stock_provision_action_fail` (sem secrets).
- **Arquivos prováveis**:
  - `C:\sitechatbot\index.js` (hook `/api/commands/ack` para `stock_provision`)
  - `C:\sitechatbot\convenientetecnologia\lib\ctFbStock.js` (jobs/accounts + reserve/release/guards)
  - `C:\conveniente\scripts\dashboard.js` (`execStockProvision` e formato de `results` no ACK)
- **Mapa de impacto (obrigatório)**:
  - **Fluxo ponta a ponta (alto nível)**: UI/Agendador CT → cria job (DB) + reserva conta → `enqueueCommand(stock_provision)` → host executa `execStockProvision` → ACK no CT → CT atualiza job + conta (assigned/release).
  - **Estados tocados**:
    - CT: `ct_fb_stock_jobs`, `ct_fb_stock_accounts` (+ audit)
    - Host: `provision_audit.jsonl`, `desired.json`, `perfis.json`, `status.json` (durante provisão)
  - **Risco de regressão**: mexer em hook de ACK pode alterar transições do estoque; mitigação: mudança mínima, idempotente, com fallback safe e audit log.
- **Histórico relacionado (obrigatório)**:
  - Timeline: (preencher após coletar evidência do dia 29/01 e commits relacionados)
- **Plano (mudança mínima)**:
  - trocar lookup do job por `command_id` para query direta (não limitada por `listJobs(limit=200)`).
  - adicionar fallback seguro: se job não for encontrado, ainda assim liberar reserva com base em `details.results[*].stockAccountId` quando falhou sem criação de perfil.
  - registrar audit local quando ocorrer “job não encontrado” (para nunca mais virar achismo).
- **Precisa reiniciar agora?** não
- **Precisa reiniciar para validar/testar?** depende (CT sim; hosts não necessariamente)

## ITEM TEMPLATE (copiar/colar por item)

### ITEM: INC-YYYYMMDD-HHMM-XX — Título curto

- **P**: P?
- **Sistema**: conveniente / sitechatbot / notificador
- **Sintoma (humano)**:
- **Como deveria ser (humano)**:
- **Critério de sucesso (humano)**: (ex.: “clicou → em X segundos tudo fechado e nada reabre por Y segundos”)
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

