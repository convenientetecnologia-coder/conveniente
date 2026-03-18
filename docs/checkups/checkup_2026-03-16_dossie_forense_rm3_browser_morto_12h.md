# Checkup 2026-03-16 — Dossiê forense RM3: Browser morto / navegadores não reabrem (~12h)

## Cabeçalho operacional

- **Precisa reiniciar?** sim (para recuperar RM3)
- **Qual projeto?** conveniente
- **Como reiniciar (humano)?** `node index.js`
- **Por quê?** Worker em estado degradado após unhandledRejection; cluster não respawna porque processo não dá exit

---

## Objetivo

Auditar de forma forense perfeita o erro recidivante no **ROBE MÃE 3** (hostId: `5d7c3309-8581-4a50-a421-e6cbb52d8070`):

- **Sintoma:** navegadores fecham e não reabrem; sistema para de reabrir browsers
- **Recorrência:** ~12h após restart
- **Erros reportados pelo humano:** `Network.enable timed out`, `Protocol error (Network.setUserAgentOverride): Target closed`, `[FATAL][WORKER] unhandledRejection`, `[VIRTUS][...] Browser morto/desconectado — encerrando Virtus`

---

## Evidências coletadas

### E1) Logs do host RM3

| Fonte | Status | Path | Observação |
|-------|--------|------|------------|
| `logger` | `not_found` | `dados/logger.log` | `LOG_TO_FILE` não setado no RM3 |
| `provision_audit` | `ok` | `dados/provision_audit.jsonl` | ~220KB em `requestId=27e080f7-2b66-472a-940b-9bd4224646fa` |
| `status` | `ok` | `dados/status.json` | Snapshot de perfis |
| `service_stdout` | `not_found` | `dados/service_stdout.log` | RM3 não roda como NSSM |
| `service_stderr` | `not_found` | `dados/service_stderr.log` | idem |

**Conclusão:** O FATAL e os erros CDP vão para `console` (logger.error/logger.warn). Sem `LOG_TO_FILE=1` ou NSSM, esses logs não são persistidos em arquivo e não chegam ao CT via fetch_logs.

### E2) Cadeia de causa (evidência no código)

| Artefato | Path | Linhas | Evidência |
|----------|------|--------|-----------|
| `unhandledRejection` handler | `scripts/worker.js` | 13334–13343 | `logger.error('[FATAL][WORKER] unhandledRejection', ...)`; se `CONVENIENTE_FATAL_EXIT!=1` → `processo continua` (não chama `process.exit`) |
| `uncaughtException` handler | `scripts/worker.js` | 13322–13333 | idem |
| Cluster respawn | `scripts/clusterMaster.js` | 174–203 | Respawn só em `proc.on('exit', ...)` — worker precisa dar `exit` |
| Virtus "Browser morto" | `scripts/virtus.js` | 1193–1196, 1544–1548 | `logger.error('[VIRTUS][${nome}] Browser morto/desconectado — encerrando Virtus')` |
| CDP `setUserAgentOverride` | `scripts/browser.js` | 131–135 | `client.send('Network.setUserAgentOverride', ...)` — origem de erro "Target closed" |
| Protocol timeout | `scripts/browser.js` | 1104, 1144 | `protocolTimeout: 120000` no launch; `conn.setProtocolTimeout(60000)` no CDP |

### E3) Ordem dos eventos (cadeia inferida)

```
1. CDP/Puppeteer: operação (Network.enable ou setUserAgentOverride) demora ou target já fechou
2. Erro: "Network.enable timed out" ou "Protocol error (Network.setUserAgentOverride): Target closed"
3. Promise rejeitada → unhandledRejection no worker
4. worker.js: handler loga [FATAL][WORKER] unhandledRejection
5. CONVENIENTE_FATAL_EXIT!=1 (padrão) → processo NÃO chama process.exit(1)
6. Worker continua vivo, mas em estado degradado (handlers/event loop possivelmente corrompidos)
7. Cluster: não recebe 'exit' → não respawna
8. Virtus: detecta browser.isConnected()===false → loga "Browser morto/desconectado — encerrando Virtus"
9. Navegadores não reabrem porque o worker não respawna e o processo existente não recupera
```

---

## Causa raiz (hipótese confirmada por código)

1. **Causa imediata:** CDP timeout ou target fechado durante operação (Network.enable, setUserAgentOverride).
2. **Causa de persistência:** Worker trata `unhandledRejection` como fatal mas **não sai** quando `CONVENIENTE_FATAL_EXIT!=1`; o cluster só respawna em `exit`.
3. **Resultado:** Worker zombie — processo vivo, não respawna, browsers não reabrem.

---

## Recomendações para próxima ocorrência (coleta forense)

Para capturar evidência no momento do erro:

1. **Habilitar LOG_TO_FILE no RM3:** `set LOG_TO_FILE=1` antes de `node index.js` (ou via env no NSSM).
2. **Disparar fetch_logs imediatamente** quando o erro ocorrer:
   - `POST /api/logs/request_secret` com `keys: ["logger","provision_audit","status","issues_fallback"]` e `tailLines: 3000`.
3. **Se RM3 rodar como NSSM:** `service_stdout` e `service_stderr` passarão a existir e terão stdout/stderr do processo.

---

## Correções implementadas (2026-03-16)

### 1. Correção na raiz (browser.js)

- **patchPage:** Guard `page.isClosed()` antes de CDP; catch melhorado com log warn para erros CDP (Target closed, timeout)
- **bringWindowToFront:** Guard + catch com log para erros CDP
- Objetivo: evitar que erros CDP virem unhandledRejection

### 2. Recovery automática (worker.js)

- **unhandledRejection / uncaughtException:** Quando erro contém "Target closed", "Network.enable", "Protocol error", "setUserAgentOverride" → **exit(1)** para cluster respawnar
- Não depende mais de `CONVENIENTE_FATAL_EXIT=1` para erros CDP
- `CONVENIENTE_FATAL_EXIT=1` continua forçando exit para qualquer fatal

### 3. Cleanup UAFP (worker.js) — zero zumbi

- **fatalExitCleanupChrome():** Antes de exit, mata Chrome por userDataDir para todos os perfis do shard
- Garante ciclo completo: abertura → trabalho → fechamento → recuperação
- Evita navegadores zumbi consumindo RAM; UAFP íntegro

### 4. Investigação (doc separado)

- `checkup_2026-03-16_investigacao_rm3_vs_outros.md` — checklist para comparar RM3 vs RM2/RM4 (RAM, perfis, governor)

---

## Arquivos citados

- `C:\conveniente\scripts\worker.js` (linhas 13322–13343)
- `C:\conveniente\scripts\clusterMaster.js` (linhas 174–203)
- `C:\conveniente\scripts\virtus.js` (linhas 1193–1200, 1544–1550)
- `C:\conveniente\scripts\browser.js` (linhas 1097–1105, 1141–1146, 127–141)
- `C:\conveniente\scripts\logger.js` (linhas 22–24, 57–60)

---

## Timeline

| Quando | Evento |
|--------|--------|
| ~12h atrás | Restart do RM3 (última recuperação) |
| Agora | Erro recidivou: navegadores fecham, não reabrem |
| 2026-03-16 | Dossiê forense criado |

---

## RequestIds de evidência

- `27e080f7-2b66-472a-940b-9bd4224646fa` — fetch_logs (logger, provision_audit, status) — logger=not_found
