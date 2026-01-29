### Runbook técnico — operação diária (Conveniente / CT / Notificador)

Este arquivo é o **manual de operação**. Ele não “engessa”: se você precisar de um novo procedimento, adicione aqui como **EXPERIMENTAL** e, quando estabilizar, promova a **CANÔNICO**.

---

### Regras para evitar “caminhos paralelos”

- **CANÔNICO**: existe, é usado em produção e tem evidência.
- **EXPERIMENTAL**: novo caminho; deve ter:
  - motivo,
  - risco,
  - como validar,
  - como reverter,
  - e prazo/condição para virar canônico ou ser removido.

Regra adicional (obrigatória):
- Se um GPT fez **tentativa/erro** e descobriu o jeito certo, ele deve **promover o jeito certo para este runbook** (CANÔNICO) e registrar na `docs/TIMELINE.md` quando fizer sentido — para os próximos GPTs não repetirem erro.

---

### Checklist de release / atualização (produção real) — **CANÔNICO**

Objetivo: qualquer GPT/humano consegue atualizar e debugar com **prova**, sem “achismo” e sem travar produção.

#### Regra humana (importante)

Este runbook assume um fato: **o humano é falho** e não deve operar “na unha”.

- **O humano**: só aprova a mudança e cobra evidência (“o que mudou?”, “qual serviço reiniciar?”, “o que você vai fazer se der ruim?”).
- **O GPT**: prepara a execução (mudança + commit/push + comando CT quando existir, ex.: `self_update`) e deixa tudo registrado (evidência + timeline).
- **O humano**: quando for necessário aplicar no host, faz o restart manual com `node index.js` e avisa “reiniciado”.
- **Proibido**: pedir para o humano “trocar arquivo”, “copiar script”, “abrir pastas” ou “fazer rollback manual”.

#### 0) Registro mínimo (antes de mexer)

- [ ] Definir `THREAD` (se for cross-system): `TH-YYYY-MM-DD-slug-curto`
- [ ] Definir **escopo** (quais serviços): `conveniente` / `sitechatbot` / `notificador`
- [ ] Definir **alvo** (quais arquivos/funções):
  - Para `conveniente`: começar em `C:\conveniente\docs\checkups\file_timeline\INDEX_2026-01-09_a_2026-01-29.md` e nos hotspots.
- [ ] Definir **rollback** antes de aplicar (como desfazer rápido).
- [ ] Definir **validação** (endpoints/logs/ACK) antes de aplicar.

#### 1) Gate P0/P1 (não negociar)

Fonte canônica dos riscos conhecidos:
- `C:\conveniente\docs\checkup_geral_2026-01-29.md`

- **P0 (bloqueador de release)**:
  - [ ] Nenhum P0 aberto “sem mitigação”. Se existir P0 aberto, só pode seguir com:
    - mitigação clara + evidência + rollback pronto, **ou**
    - primeiro corrigir o P0.
  - P0 atual conhecido (referência):
    - lock não owner-safe em `conveniente/scripts/fileStore.js` (risco de corrida/corrupção) — **corrigido** em 2026-01-29 (ver `docs/TIMELINE.md` e `scripts/fileStore.js`).

- **P1 (permitido somente com guardrails)**:
  - [ ] Nenhuma espera infinita: qualquer wait precisa de deadline + logs + erro/ACK.
  - [ ] Evitar busy-wait / IO síncrono em caminho crítico (ou documentar impacto e agendar refactor).
  - [ ] Política de erro (unhandled) e logging devem ser consistentes no contexto da mudança.

#### 2) Execução (mudança)

- [ ] Implementar a mudança **mínima** (cirúrgica).
- [ ] Coletar evidência “depois”:
  - commits/diffs (no `conveniente`)
  - `ack_<cmdId>.json` (quando envolver CT)
  - logs relevantes (keys allowlisted)
- [ ] Atualizar docs na mesma sessão (se mudou comportamento/procedimento):
  - `C:\conveniente\docs\TIMELINE.md` (entrada curta, com evidência + reinícios + rollback)
  - se for grande/complexo: criar um checkup em `C:\conveniente\docs\checkups\`

#### 3) Restart e validação (pós-mudança)

- [ ] Restart do(s) serviço(s) afetado(s) (ver seção “Restart / validação (padrão)” abaixo).
- [ ] O GPT deve dizer **em português direto** (sem ambiguidades):
  - **Precisa reiniciar agora?** sim/não (para continuar o trabalho atual)
  - **Precisa reiniciar?** sim/não
  - **Qual projeto?** `conveniente` / `sitechatbot` / `notificador`
  - **Como reinicia (humano)?** `node index.js`
  - **Por quê precisa reiniciar?** (1 frase)
  - **O que muda se NÃO reiniciar agora?** (1 frase)
- [ ] Validação mínima:
  - `conveniente`: `GET /health` + `GET /api/status`
  - CT: enfileirar comando simples + confirmar `ack_<cmdId>.json`
  - notificador: polling/ACK no CT
- [ ] Se falhar: aplicar rollback + registrar evidência do incidente.

---

### Restart / validação (padrão)

#### Regra humana (restart)

Neste ambiente, “restart” significa: **o humano vai no servidor e reinicia manualmente** (parar e rodar de novo):

- `node index.js`

O GPT **não** consegue reiniciar os seus processos remotos.

#### Mudou `conveniente/scripts/*.js` (runtime core)

- **Reiniciar (humano)**: no host do `conveniente`, parar o processo e subir de novo com `node index.js`.
- **Validar**:
  - `GET /health`
  - `GET /api/status`
  - logs (`dados/logger.log` se `LOG_TO_FILE=1`)

#### Mudou `sitechatbot/index.js` (CT)

- **Reiniciar (humano)**: no host do CT, parar o processo e subir de novo com `node index.js`.
- **Validar**:
  - enfileirar um comando simples + confirmar ACK
  - `sitechatbot/dados/commands.log` registrando `ack`

#### Mudou `notificador/index.js`

- **Reiniciar (humano)**: no host do notificador, parar o processo e subir de novo com `node index.js`.
- **Validar**:
  - autenticação Baileys (quando aplicável)
  - polling/integração com CT

---

### Diagnóstico rápido (incidente)

Copiar/colar e preencher:

```text
Timestamp:
Fuso:
HostId:
Projeto/serviço: (conveniente | sitechatbot | notificador)
Sintoma:
Impacto:
RequestId/cmdId/profileName:

Evidência coletada:
- logs keys:
- trecho:

Ação executada:
- mudança:
- restart:

Validação:
- endpoint/status:
- logs:
```

---

### Intake de “texto bomba” do humano (CANÔNICO)

Quando o humano mandar uma mensagem grande/bagunçada com vários sintomas misturados, o GPT deve:

- colar o texto bruto em `C:\conveniente\docs\INBOX_RELATOS_DO_HUMANO.md` (RAW_INPUT)
- quebrar em itens separados na tabela TRIAGE (P0/P1/P2)
- coletar evidência via CT (logs_manifest/fetch_logs/ACK), sem pedir para o humano “investigar”
- **fazer análise de impacto antes de mexer em código**:
  - mapear fluxo ponta a ponta (callers/callees)
  - listar estados tocados (desired/status/perfis/locks)
  - listar possíveis efeitos colaterais (“corrigir fechar todos” pode afetar “abrir todos”, nurse, desired, virtus/robe)
- dizer de forma direta:
  - precisa reiniciar agora? sim/não
  - precisa reiniciar para validar? sim/não
  - qual projeto e como (`node index.js`)

Motivo: isso impede o GPT de “misturar problemas” e evita que um texto confuso vire mudança errada.

---

### Windows/PowerShell — pegadinhas operacionais (para GPT não perder tempo)

Este workspace roda no Windows com PowerShell. Algumas coisas “padrão Linux” **falham** aqui:

- **Sem `&&`**: em PowerShell, usar `;` para encadear comandos.
- **Sem heredoc `<<EOF`**: não usar `cat <<EOF` / heredoc para mensagem de commit.
  - Jeito correto para commit com mensagem multi-linha:
    - usar múltiplos `-m` (ex.: `git commit -m "título" -m "corpo..."`)
- **`node -e`**: strings longas com aspas/regex podem quebrar o parse do PowerShell.
  - Preferir `node -e "..."` com JSON simples, ou criar um script `.js` e executar `node script.js`.

Regra: quando um GPT registrar um procedimento com comandos, escrever no formato PowerShell.

---

### Incidente ativo (template “em tempo real”)

Use este bloco quando você e o GPT estiverem investigando algo agora. Quando fechar:
- registrar o **resumo** na `docs/TIMELINE.md`
- se virar procedimento, promover para este runbook (CANÔNICO/EXPERIMENTAL)

```text
INCIDENTE_ATIVO:
Criado em:
Responsável humano:
Responsável GPT:

Hipóteses (curtas):
- H1:
- H2:

Coletas pendentes (objetivas):
- logs (keys/patterns):
- request_secret:
- cmdId:

Evidências coletadas (links/paths):
- 

Decisão atual:
- 

Próximo passo:
- 
```

---

### Operações de recuperação (canônicas)

#### 1) Comando “travado/zumbi” no CT

- **Verificar**:
  - `sitechatbot/dados/commands.log` (eventos `enqueued`, `delivered`, `ack`, `gc_*`)
  - evidência por comando: `sitechatbot/dados/logs/<hostId>/ack_<cmdId>.json`

#### 2) Inventário de logs do servidor (sem adivinhar paths)

- **Preferir**: comando `logs_manifest` (retorna tamanho/mtime das keys allowlisted no servidor).

#### 3) Coleta de logs (tail)

- **Preferir**: `fetch_logs` por keys (allowlist no servidor).
- **Quando precisar de filtro**: `fetch_logs_query` com `patterns` (substring).

#### 4) Lock de provisão preso (maintenance_provision)

- **Verificar**:
  - `fetch_logs` key `provision_lock`
- **Recuperação**:
  - comando `provision_unlock` (force) — usar apenas quando tiver certeza que não há provisão legítima em andamento.

---

### Coleta de logs via CT (sem UI) — canal `*_secret`

Use quando você precisa pedir logs rapidamente sem depender do painel.

- **Criar requisição**: `POST {CT_BASE}/api/logs/request_secret`
  - Headers:
    - `x-log-secret: <LOG_INGEST_SECRET>` (valor não deve ser colado em docs)
  - Body:
    - `hostId`: (obrigatório)
    - `keys`: array com até 8 keys do allowlist do servidor
    - `tailLines`: opcional (default 1200)

- **Consultar resultado**: `GET {CT_BASE}/api/logs/request_secret/<requestId>`
  - Retorna `hasResponse` e o payload quando disponível.

- **Manifest (inventário)**: `POST {CT_BASE}/api/logs/manifest_secret`

Observação: esses endpoints também aceitam request **localhost** no CT (para debug direto no host do CT).

---

### Notificador — diagnóstico rápido

- O `notificador` NÃO expõe HTTP (opera por polling no CT).
- CT endpoints usados:
  - `GET /api/notifier/next`
  - `POST /api/notifier/ack`
- Auth recomendada: `NOTIFIER_API_KEY` via header `x-api-key`.
- Identidade do worker: header `x-worker-id` (no notificador: `NOTIFIER_WORKER_ID`, default hostname).

---

### Regra anti-loop-infinito (comandos/esperas)

Problema histórico: “GPT enviou comando e ficou esperando resposta para sempre”.

Regras canônicas:

- **Nunca** implementar espera infinita (`while(true)` / polling) sem:
  - **deadline** (`timeoutMs`/`budgetMs`)
  - **telemetria** (log por etapa + motivo do wait)
  - **saída com erro** (para o CT registrar e o GC encerrar)
- Em fluxos que envolvem CT⇄Servidor:
  - o CT é **assíncrono** (fila/ACK); o cliente deve esperar no máximo um tempo e então coletar evidência (`ack_<cmdId>.json`, logs) em vez de ficar girando.

Checklist para qualquer “espera” nova:

- Qual é o **timeout máximo**?
- Qual é o **critério de sucesso**?
- O que acontece no **timeout** (ACK/erro/rollback)?
- Onde fica a **evidência** (log key, arquivo, requestId/cmdId)?

---

### Postura sobre “keys” (para não virar fonte de bug)

Objetivo do projeto neste estágio: **confiabilidade interna**. Segurança “externa” não é prioridade agora.

Regras canônicas (para evitar “perdi a chave e quebrei o sistema”):

- Se uma key/secret estiver ausente, o sistema **não deve travar** nem entrar em loop.
- O comportamento deve ser **determinístico e explícito**:
  - logar um warning “key ausente” (para visibilidade),
  - continuar operando do jeito mais simples possível,
  - e jamais depender de “prompt humano” para continuar.

Observação: isso NÃO significa “inventar chaves novas”. Significa “se existir, usa; se não existir, segue sem quebrar”.

### Baseline de env (produção) — sugerido

- `conveniente`:
  - `OPEN_CHROMIUM_ON_START=0`
  - `LOG_TO_FILE=1`
  - `LOG_DEBUG=0` (ou `DEBUG=0`)
  - `ALLOW_SELF_UPDATE_RESTART=0` (**importante**: evita `self_update` derrubar o processo sozinho)
  - `CONVENIENTE_FATAL_EXIT=0` (default). Se colocar `1`, o processo sai em `uncaughtException/unhandledRejection` para evitar “seguir vivo” corrompido (humano reinicia `node index.js`).

- `sitechatbot`:
  - `LOG_LEVEL=INFO`
  - `CT_COMMANDS_PRUNE_INTERVAL_MS=30000`

---

### `self_update` (comando) — como funciona (canônico)

Fonte: `C:\conveniente\scripts\dashboard.js`.

- **O que ele faz**: executa `git` no diretório do repo do `conveniente` (equivalente a “atualizar código pelo Git”).
- **O que ele NÃO faz**: não garante que o código novo “entrou em execução” sem restart.
- **Sobre `restart=1`**:
  - se `ALLOW_SELF_UPDATE_RESTART=1`, o `conveniente` pode **sair do processo** após o update (para um gerenciador reiniciar).
  - como aqui não existe reinício automático, isso pode derrubar o serviço até o humano rodar `node index.js` de novo.
  - por padrão, manter `ALLOW_SELF_UPDATE_RESTART=0`.

Regra operacional:
- O GPT pode enviar `self_update` sem “ficar esperando”.
- Se a investigação/mudança precisar do código novo rodando, o GPT deve avisar: **“preciso que você reinicie `node index.js` no host X para continuar”**.

---

### Update padrão (CANÔNICO) — `conveniente` (sem perda de tempo)

Objetivo: o humano (Cássio) **não precisa repetir instruções**. Sempre que houver mudança no `conveniente`, o padrão é:

- **GPT faz**:
  - `git commit` + `git push` (GitHub)
  - **dispara `self_update` via CT** (sem ficar esperando)
  - avisa o humano com uma frase curta: **“reinicia `node index.js` no host X”**
- **Humano faz**:
  - reinicia manualmente no host do `conveniente`: `node index.js`
  - responde “reiniciado” (para o GPT registrar na `docs/TIMELINE.md`)

Regra importante:
- **Nem toda mudança precisa de restart “agora”** para continuar desenvolvendo outras correções.
- Restart é obrigatório quando você precisa que a mudança **esteja valendo no runtime** (ex.: testar “open_all/close_all” corrigido).
- Se a próxima tarefa não depende do runtime novo, o GPT pode continuar trabalhando e o humano pode reiniciar depois (quando for validar/testar).

#### Como o GPT dispara `self_update` via CT (canônico)

Fonte (CT): `C:\sitechatbot\index.js` endpoint `POST /api/commands/enqueue_secret` (auth por `LOG_INGEST_SECRET` via header `x-log-secret`).

Payload do `self_update` (servidor `conveniente`): `branch` (default `main`), `restart` (default **0**), `requestId` (opcional).

Exemplo de requisição (o GPT executa; o humano não):

```text
POST {CT_BASE}/api/commands/enqueue_secret
Headers:
  x-log-secret: <LOG_INGEST_SECRET>
Body (JSON):
  {
    "target": "<hostId>" | "all",
    "type": "self_update",
    "payload": { "branch": "main", "restart": 0, "requestId": "deploy_conveniente_YYYYMMDD_HHMM" }
  }
```

Notas:
- `target="all"` vira broadcast (`*`) no CT.
- **Não usar** `restart=1` neste ambiente (sem reinício automático).
 - Vocabulário humano: “**pull**” = disparar `self_update` (update de Git no host).

---

### EXPERIMENTAL — “comandos novos sem restart” (hot-load / plugins)

Ideia: permitir que o GPT crie “novos comandos” em tempo real sem depender de deploy + restart.

Status: **não implementado** (somente proposta).

Observações importantes:
- Para isso ser possível com segurança e auditabilidade, precisa existir uma **infra** no servidor que já saiba:
  - receber um “plugin/ação” (arquivo ou pacote),
  - validar (mínimo: hash/assinatura/segredo),
  - registrar evidência (quem criou, quando, hash),
  - carregar e executar sem quebrar o processo.
- Mesmo com hot-load, normalmente ainda existe **um primeiro rollout** (deploy/restart) para instalar essa infra.

Quando formos implementar, vira um checkup próprio com:
- riscos,
- formato do plugin,
- logs/evidência,
- kill-switch,
- rollback.

