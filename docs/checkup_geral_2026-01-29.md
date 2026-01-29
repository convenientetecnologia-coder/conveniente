### Checkup geral — `conveniente` + `sitechatbot` (2026-01-29)

Contexto: nas últimas semanas houve mudanças rápidas/desorganizadas e o sistema em produção está instável. Este documento registra **achados verificáveis por código** (sem achismo) e prioriza riscos por impacto.

---

### Escopo auditado

- **conveniente**: `index.js`, `scripts/clusterMaster.js`, `scripts/supervisor.js`, `scripts/dashboard.js`, `scripts/fileStore.js`, `scripts/workerClient.js`, `scripts/worker.js`, `scripts/logger.js`, `scripts/provisionLock.js`, `scripts/ramPolicy.js`
- **sitechatbot**: `index.js` (fila de comandos, GC, endpoints “secret”)
- Documento existente: `docs/ultra_enterprise_system_audit_2026-01-24.md` (referência histórica/decisões anteriores)

---

### Achados (prioridade)

#### P0 — lock de arquivo pode ser quebrado no `conveniente` (risco de corrida/corrupção)

**Onde**: `conveniente/scripts/fileStore.js`

**Fato**: as rotinas de lock `desired.json.lock` e `perfis.json.lock` podem executar `unlinkSync(lockPath)` **mesmo quando o processo atual NÃO adquiriu o lock** (por exemplo, timeout ao tentar criar o arquivo lock). Isso pode apagar o lock de outro processo que está usando o recurso.

**Status**: ✅ **CORRIGIDO** (mudança aplicada em `C:\conveniente\scripts\fileStore.js` — release owner-safe; não remove `.lock` sem aquisição; inclui meta + stale recovery best-effort).

**Trechos relevantes**:

- **desired**:
  - `releaseDesiredLockFile(fd)` sempre tenta `unlinkSync(desiredLockPath)` mesmo se `fd` for `null`/não adquirido.
  - `withDesiredFileLockUpdate()` chama `releaseDesiredLockFile(fd)` no `finally`, então no erro/timeout também.

- **perfis**:
  - `withPerfisFileLockUpdate()` no `finally` sempre tenta `unlinkSync(perfisLockPath)` mesmo se `fd` nunca foi aberto.

**Impacto esperado em produção**:

- corridas de escrita em `desired.json` / `perfis.json`
- estado “flutuando” (perfis duplicando/sumindo, inconsistências de painel/status)
- bugs intermitentes difíceis de reproduzir

**Ação recomendada (cirúrgica)**:

- transformar lock em “owner-safe”:
  - ao criar o lock, escrever um conteúdo mínimo no lock (ex.: `{ pid, ts }`)
  - ao liberar: **somente** remover o lock se (a) `fd` foi adquirido **e** (b) o lock ainda pertence ao mesmo `pid` (ou ao mesmo “token” se adotarmos token)
- evitar apagar lock em caso de `*_lock_timeout`

---

#### P1 — busy-wait/IO síncrono pode congelar o processo (latência/congelos sob stress)

**Onde**:

- `conveniente/scripts/fileStore.js`:
  - `withPerfisFileLockUpdate()` usa `while ((Date.now()-start) < delayMs) {}` (busy-wait).
- `conveniente/index.js`:
  - backup “auto” faz muitas operações síncronas (`copyFileSync`, `readdirSync`) e ainda usa `Atomics.wait` (sleep bloqueante).

**Impacto esperado**:

- picos de latência no painel/API durante contenção de lock ou durante snapshot
- sensação de “travou” mesmo sem crash

**Ação recomendada**:

- remover busy-wait e usar espera assíncrona (ou reestruturar lock para async de verdade)
- se manter backup, reduzir impacto:
  - opcional: rodar snapshot em processo separado
  - opcional: permitir desativar/afrouxar em produção via env (já existe `CONVENIENTE_AUTO_BACKUP_DISABLE=1`)

**Status**: ✅ **mitigado** — snapshot do auto-backup agora roda em **processo separado** (subprocess), reduzindo freeze do main.

---

#### P1 — risco de “espera infinita” (deadlines)

**Onde**:

- `conveniente/scripts/dashboard.js`
  - `ensureFreeMB(minMB)` fazia `while(true)` esperando RAM/CPU atingirem o alvo (sem deadline) — **corrigido**: agora tem `timeoutMs` + logs de progresso + erro explícito no timeout.
  - Observação: no código atual, **não foi encontrado call-site** para `ensureFreeMB` (parece helper legado), mas o padrão é perigoso e pode voltar a ser usado por engano.
- `conveniente/scripts/browser.js`
  - existem `while(true)` em rotinas de UI que dependem de “achar e clicar”; devem sempre ter timeout/guardrail interno.
- `sitechatbot/lib/lock.js` e `notificador/lib/lock.js`
  - `while(true)` é usado para adquirir lock, mas com **timeout** (`timeoutMs`) e **stale recovery** (`staleMs`). Este padrão é OK.

**Impacto esperado**:

- qualquer `while(true)` usado em caminho crítico sem deadline pode travar execução/ACK e virar “comando zumbi” no CT.

**Ação recomendada**:

- padronizar regra: *nenhum wait pode ser infinito*.
- qualquer loop de espera precisa de:
  - deadline (`budgetMs`/`timeoutMs`)
  - logging/telemetria por etapa
  - saída em erro com ACK claro (no servidor) para o CT GC encerrar corretamente.

---

#### P1 — tratamento global de erro é inconsistente (risco de “seguir vivo” corrompido)

**Onde**:

- `conveniente/scripts/worker.js` tem handlers `uncaughtException` / `unhandledRejection` que **logam** (não reiniciam).
- `conveniente/index.js` não tem handlers globais equivalentes.
- `sitechatbot/index.js` tem handlers globais, mas atualmente loga em `console.error` e ignora alguns casos.

**Risco**:

- erro grave pode deixar o processo em estado ruim e continuar rodando “torto”.

**Ação recomendada**:

- padronizar política:
  - no mínimo: log consistente + marcação de “degraded” e reinício controlado quando apropriado.

---

#### P2 — logging em produção (ruído / falta de persistência)

**Onde**: `conveniente/scripts/logger.js`

**Fato**:

- `DEBUG_MODE` default está efetivamente ligado (`'1'`), o que tende a gerar ruído.
- `LOG_TO_FILE` só grava se env estiver setada; em produção é útil persistir logs.

**Ação recomendada**:

- definir padrão de produção:
  - `LOG_DEBUG=0` (ou `DEBUG=0`)
  - `LOG_TO_FILE=1` (especialmente em hosts críticos)

---

### Pontos bons (não mexer agora)

#### `sitechatbot`: lock+GC de comandos (bom)

**Onde**: `sitechatbot/index.js`

- lock da fila de comandos (`commands.lock`) só é removido no `finally` **se** o `fd` foi de fato adquirido (evita “unlock errado”).
- existe GC para `close_all` e `login_remediate` sem ACK (evita “carregando infinito”).

---

### Próximas ações sugeridas (ordem)

1) **P0**: corrigir lock owner-safe em `conveniente/scripts/fileStore.js`
2) **P1**: remover busy-wait no lock de `perfis.json` (ou reduzir impacto)
3) **P1/P2**: padronizar policy de unhandled errors + logging de produção

---

### Reinícios necessários (se aplicarmos correções)

- **Se mexer em `conveniente/scripts/fileStore.js`**:
  - reiniciar o processo do **conveniente** (master) ⇒ isso recria os workers do cluster automaticamente.
- **Não precisa reiniciar**:
  - `sitechatbot` (a menos que a alteração seja nele)

