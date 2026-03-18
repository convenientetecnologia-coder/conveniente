# Checkup 2026-03-16 — Investigação RM3 vs outros hosts (causa raiz)

## Objetivo

Identificar **por que** o erro CDP (Target closed, Network.enable timed out) ocorre **só no RM3** e não nos demais ROBE MÃE.

## Hosts a comparar

| Host | hostId | hostname | categoria |
|------|--------|----------|-----------|
| RM2 | bcf01e8d-82da-4d5d-aed0-d60305d4696d | DESKTOP-P9CR5S0 | FRETES |
| **RM3** | **5d7c3309-8581-4a50-a421-e6cbb52d8070** | **DESKTOP-IR7JRIM** | **FRETES** |
| RM4 | 825a4485-1465-4c11-aa18-52f0597b23a3 | DESKTOP-SKUV1H4 | FRETES |

## Checklist de investigação (via CT)

### 1. Perfis por host

- `fetch_logs` com key `status` → contar `perfis.length`
- Comparar: RM3 tem mais perfis que RM2/RM4?

### 2. Perfis por worker (shard size)

- `status` tem `_debug` ou info de workers?
- Ou: `desired.json` + lógica de sharding → quantos perfis por worker em cada host

### 3. Governor / RAM

- `fetch_logs` com key `governor_snapshots` (últimas linhas)
- Buscar: `freeMB`, `ram_low`, `supervisor_denied:ram_low`
- Comparar: RM3 tem menos RAM livre ou mais eventos ram_low?

### 4. Fall forensics

- `fetch_logs` com key `fall_forensics` (se existir)
- Ou `provision_audit` filtrando eventos: `nurse_open_ram_denied`, `supervisor_denied:ram_low`
- Comparar frequência entre hosts

### 5. Hardware (manual)

- RAM total: RM3 vs RM2/RM4
- CPU: mesma geração?
- Disco: SSD vs HDD?

## Queries sugeridas (CT)

```json
POST /api/logs/request_secret
{
  "hostId": "5d7c3309-8581-4a50-a421-e6cbb52d8070",
  "keys": ["status", "governor_snapshots", "provision_audit"],
  "tailLines": 500
}
```

Repetir para RM2 e RM4 com mesmo hostId.

## Métricas a extrair

| Métrica | RM2 | RM3 | RM4 |
|---------|-----|-----|-----|
| perfis.length | ? | ? | ? |
| perfis por worker | ? | ? | ? |
| governor: freeMB (média) | ? | ? | ? |
| nurse_open_ram_denied (contagem) | ? | ? | ? |
| supervisor_denied:ram_low (contagem) | ? | ? | ? |

## Hipóteses a validar

1. **RM3 tem mais perfis** → mais pressão de RAM
2. **RM3 tem menos RAM** → governor fecha navegadores com mais frequência
3. **RM3 tem shard maior** → mais Chrome por worker → mais chance de race CDP
4. **RM3 tem hardware mais lento** → CDP demora mais → timeout

## Ações pós-investigação

- Se RAM: reduzir perfis no RM3 ou aumentar RAM
- Se shard: ajustar distribuição de perfis entre workers
- Se hardware: considerar upgrade ou reduzir carga
