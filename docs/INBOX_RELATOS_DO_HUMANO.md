### INBOX — relatos do humano (Cássio) — CANÔNICO

Objetivo: quando o humano mandar um texto grande/bagunçado com “mil problemas”, o GPT usa este arquivo como **canal de intake**:

- colar o **texto bruto** (sem julgar)
- quebrar em **itens separados** (um por problema)
- classificar por **P0/P1/P2**
- marcar o que falta (evidência/logs/cmdId/hostId)
- mapear “relato X” → **arquivo(s)/função(s)** → hipótese → plano

> Regra: o humano não investiga nem coleta logs manualmente. O GPT puxa logs via CT, e o humano só reinicia `node index.js` quando solicitado.

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
- **Plano (mudança mínima)**:
  - …
- **Precisa reiniciar agora?** sim/não — por quê
- **Precisa reiniciar para validar/testar?** sim/não — por quê
- **Validação**:
  - endpoint/log esperado
- **Rollback**:
  - `git revert` + (se for validar rollback) reiniciar `node index.js`

