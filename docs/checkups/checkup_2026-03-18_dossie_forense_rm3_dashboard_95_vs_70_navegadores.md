# Checkup 2026-03-18 — Dossiê forense RM3: Dashboard 95 navegadores reais vs 70 exibidos

## Cabeçalho operacional

- **Precisa reiniciar?** não
- **Qual projeto?** conveniente (auditoria/documentação)
- **Como reiniciar (humano)?** N/A
- **Por quê?** Dossiê forense ponta a ponta — sem alteração de código

---

## Objetivo

Auditar de forma **enterprise** a discrepância reportada no **ROBE MÃE 3** (hostId: `5d7c3309-8581-4a50-a421-e6cbb52d8070`):

- **Sintoma:** 95 navegadores abertos na realidade (humano confirma visualmente); dashboard mostra ~70 (alguns como "fechados")
- **Gap:** ~25 perfis com browser aberto aparecem como fechados no dashboard

---

## Fluxo de dados (ponta a ponta)

### 1. Definição de "aberto" vs "fechado"

| Camada | Arquivo | Linha | Lógica |
|--------|---------|-------|--------|
| **Fonte da verdade** | `scripts/worker.js` | 10169 | `active: controllers.has(nome)` |
| **Significado** | — | — | `active === true` ⇔ perfil tem controller ativo (browser controlado pelo Node) |

**Conclusão:** O dashboard **não** conta janelas Chrome visíveis. Conta perfis em `controllers` (Map de controllers com browser ativo no processo Node).

### 2. Cadeia de propagação

```
[Worker N] controllers.has(nome) → active
     ↓
snapshotStatusAndWrite() [event-driven, sem setInterval]
     ↓
dados/status_node_N.json (multi-node) ou dados/status.json (single)
     ↓
clusterMaster.get-status (agrega todos os nodes) OU workerClient.get-status (single)
     ↓
api_status.js: overlay + baseline perfis.json
     ↓
GET /api/status
     ↓
dashboard readAggregatedStatus() → fetch(api/status) ou fallback (status.json / status_node_*.json)
     ↓
buildQuickSnapshot() → activeCount = perfis.filter(p => p.active).length
     ↓
Payload → CT (notificador)
```

### 3. Ordem de prioridade das fontes (dashboard)

| Prioridade | Fonte | Condição |
|-----------|-------|----------|
| 1 | `http://127.0.0.1:${PORT}/api/status` | Timeout 15s |
| 2 | `dados/status.json` | Se API falhar |
| 3 | Agregação de `dados/status_node_1.json` … `status_node_N.json` | Se status.json falhar |

**Arquivo:** `scripts/dashboard.js` linhas 103–185 (`readAggregatedStatus`).

### 4. Baseline vs overlay (api_status.js)

- **Baseline:** `perfis.json` → todos os perfis com `active: false` (linhas 40–94).
- **Overlay:** resposta do worker/cluster com `active: true` para perfis com controller.
- **Merge:** `merged.active = !!(overlay && overlay.active) || !!b.active` (linha 282) — **nunca** permite `active: true` virar `false` por overlay.
- **Perfis sem overlay:** permanecem com baseline (`active: false`).

### 5. Cluster multi-node (clusterMaster.js)

- Cada worker grava em `status_node_${idx+1}.json`.
- `get-status` faz `Promise.allSettled` em todos os workers.
- Se RPC falhar: usa `status_node_N.json` com idade ≤ 60s (`MAX_FILE_AGE_MS`).
- Se arquivo > 60s: **node é ignorado** — perfis desse node ficam **sem overlay**.
- Resultado: merge em `baseMap` por `nome`; `out.warning = "partial nodes: ..."` quando há falhas.

---

## Hipóteses para discrepância (95 real vs ~70 dashboard)

### H1. Timeout de get-status em multi-node (ALTA)

- **Cenário:** RM3 com 4 nodes; algum node demora > timeout.
- **Efeito:** Overlay incompleto; perfis do node que não respondeu ficam com baseline (`active: false`).
- **Evidência:** `status.warning` contém `partial nodes: nodeX: no_reply` ou `nodeX: using_stale_file(Ns)`.

### H2. status_node_*.json desatualizado (> 60s)

- **Cenário:** `snapshotStatusAndWrite` é event-driven; poucos eventos → arquivos não atualizados.
- **Efeito:** Fallback do cluster ignora node; perfis ficam com baseline.
- **Evidência:** `mtime` de `status_node_*.json` > 60s.

### H3. api/status timeout (15s) no dashboard

- **Cenário:** Dashboard chama `fetch(api/status)` com timeout 15s; cluster demora.
- **Efeito:** Dashboard usa fallback (status.json ou agregação de arquivos) possivelmente antigo.
- **Evidência:** Log `[DASH][TICK] api/status timeout (15s), using fallback`.

### H4. Perfis sem overlay ("sem resposta dos perfis")

- **Cenário:** Overlay não contém todos os perfis (ex.: node não respondeu).
- **Efeito:** `status.warning = "sem resposta dos perfis: X, Y, Z"`; esses perfis ficam com baseline.
- **Evidência:** Campo `warning` no payload do status.

### H5. Contagem "real" inclui janelas órfãs (ALTA)

- **Cenário:** Os 95 incluem janelas Chrome **sem** processo Node associado (zumbis de sessões anteriores, crash sem cleanup).
- **Efeito:** `controllers.has(nome)` é a fonte da verdade; janelas órfãs não estão em `controllers`.
- **Evidência:** Comparar `controllers.size` (por node) vs número de janelas Chrome visíveis. Se `controllers.size` ≈ 70 e janelas ≈ 95, há ~25 órfãs.

### H6. Ordem de merge no cluster (baixa)

- **Cenário:** Dois nodes têm o mesmo perfil (bug de shard); último sobrescreve.
- **Efeito:** Improvável se sharding está correto; verificar se algum perfil está em mais de um shard.

### H7. Falta de snapshotStatusAndWrite periódico

- **Cenário:** Status é event-driven; sem eventos, não há escrita.
- **Efeito:** Arquivos `status_node_*.json` ficam stale.
- **Evidência:** Não há `setInterval` para status no worker.

---

## Checklist de diagnóstico (RM3)

Executar no host RM3 para coletar evidência:

| # | Ação | Comando / path | O que verificar |
|---|------|----------------|-----------------|
| 1 | Contar `active: true` em status | `dados/status.json` | `perfis.filter(p=>p.active).length` |
| 2 | Verificar warning | `dados/status.json` | Campo `warning` |
| 3 | Idade dos status_node | `dados/status_node_*.json` | `mtime` de cada arquivo (idade em segundos) |
| 4 | Contar active por node | `dados/status_node_*.json` | `perfis.filter(p=>p.active).length` em cada |
| 5 | controllers.size (se exposto) | `get-status` `_debug.controllersCount` | Por worker |
| 6 | Janelas Chrome vs processos | Task Manager / `Get-Process chrome` | Número de processos chrome.exe |

### Comandos PowerShell (RM3)

```powershell
# 1. Contagem em status.json
$s = Get-Content C:\conveniente\dados\status.json | ConvertFrom-Json
($s.perfis | Where-Object { $_.active -eq $true }).Count

# 2. Warning
$s.warning

# 3. Idade dos status_node_*.json
Get-ChildItem C:\conveniente\dados\status_node_*.json | ForEach-Object {
  $age = (Get-Date) - $_.LastWriteTime
  [PSCustomObject]@{ File = $_.Name; AgeSec = [math]::Round($age.TotalSeconds) }
}

# 4. Contagem por node
Get-ChildItem C:\conveniente\dados\status_node_*.json | ForEach-Object {
  $j = Get-Content $_.FullName | ConvertFrom-Json
  $n = ($j.perfis | Where-Object { $_.active -eq $true }).Count
  [PSCustomObject]@{ Node = $_.Name; ActiveCount = $n }
}
```

---

## Resumo executivo

| Pergunta | Resposta |
|----------|----------|
| **O que o dashboard conta?** | Perfis com `controllers.has(nome) === true` (browser controlado pelo Node) |
| **O que o humano vê como "95 abertos"?** | Janelas Chrome visíveis (podem incluir órfãs) |
| **Causa mais provável do gap?** | H5 (órfãs) ou H1/H2 (timeout/stale em multi-node) |
| **Próximo passo?** | Coletar evidência com checklist acima |

---

## Referências

- Dossiê RM3 browser morto: `docs/checkups/checkup_2026-03-16_dossie_forense_rm3_browser_morto_12h.md`
- `scripts/worker.js` linha 10169: `active: controllers.has(nome)`
- `scripts/api_status.js` linhas 281–282: merge `active`
- `scripts/clusterMaster.js` linhas 470–505: agregação e `partial nodes`
- `scripts/dashboard.js` linhas 103–185, 626–679: `readAggregatedStatus`, `buildQuickSnapshot`
