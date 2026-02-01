# Checkup — 2026-02-01 — Forense de RAM (governor_snapshots 1/min) — RM4/RM5/RM6

## Objetivo

Avaliar, com evidência real (telemetria 1/min), como os servidores **ROBE MÃE 4/5/6** se comportaram em **RAM** e **autoMode (full/light)** quando operando com alta carga, para decidir:

- se o **limite máximo de contas** por servidor está seguro;
- se o **modo leve** está sendo acionado com coerência;
- se existem **riscos reais** (min freeMB muito baixo / instabilidade / lag extremo).

---

## Evidência (CT)

Os dados foram coletados via CT (`fetch_logs` key `governor_snapshots`) e estão salvos em:

- RM4: `C:\sitechatbot\dados\logs\825a4485-1465-4c11-aa18-52f0597b23a3\ram_forense_govsnap_825a4485-1465-4c11-aa18-52f0597b23a3_1769906994.json`
- RM5: `C:\sitechatbot\dados\logs\1b0f6f98-46bf-40c6-a0f9-dad6e1965c22\ram_forense_govsnap_1b0f6f98-46bf-40c6-a0f9-dad6e1965c22_1769906994.json`
- RM6: `C:\sitechatbot\dados\logs\aba80611-8b8a-46ed-a852-f5f0d573c03b\ram_forense_govsnap_aba80611-8b8a-46ed-a852-f5f0d573c03b_1769906995.json`

Snapshot atual (para totalMB/freeMB e estado atual do modo):

- RM4: `C:\sitechatbot\dados\logs\825a4485-1465-4c11-aa18-52f0597b23a3\ram_forense_status_825a4485-1465-4c11-aa18-52f0597b23a3_1769907105.json`
- RM5: `C:\sitechatbot\dados\logs\1b0f6f98-46bf-40c6-a0f9-dad6e1965c22\ram_forense_status_1b0f6f98-46bf-40c6-a0f9-dad6e1965c22_1769907106.json`
- RM6: `C:\sitechatbot\dados\logs\aba80611-8b8a-46ed-a852-f5f0d573c03b\ram_forense_status_aba80611-8b8a-46ed-a852-f5f0d573c03b_1769907106.json`

---

## Como o governor decide full/light (código)

Fonte: `C:\conveniente\scripts\worker.js`

- Entra em `light` quando `freeMB < CT_GOV_MEM_ENTER_MB` por `CT_GOV_ENTER_CONFIRM_MS` (default 5min).
- Sai para `full` quando `freeMB >= CT_GOV_MEM_EXIT_MB` por `CT_GOV_EXIT_CONFIRM_MS` (default 5min).
- Defaults relevantes:
  - `CT_GOV_MEM_ENTER_MB=2048`
  - `CT_GOV_MEM_EXIT_MB=2048`
  - `CT_GOV_ENTER_CONFIRM_MS=5min`
  - `CT_GOV_EXIT_CONFIRM_MS=5min`
- O arquivo `governor_snapshots.jsonl` é gerado 1/min e inclui: `mode`, `freeMB`, `lagMeanMs`, `lagMaxMs`, `controllers`, `desiredActive`, `desiredTotal`, `shardSize`.

---

## Resultados (resumo por servidor)

Janela real analisada (pelo primeiro/último registro):

- RM4: 2026-01-30 14:55 → 2026-02-01 03:50 (2189 amostras/min)
- RM5: 2026-01-30 05:35 → 2026-02-01 03:49 (2749 amostras/min)
- RM6: 2026-01-30 05:37 → 2026-02-01 03:49 (2763 amostras/min)

Tabela (RAM livre e modo):

| Host | totalMB | min freeMB (% do total) | p5 freeMB (% do total) | p50 freeMB (% do total) | full(min) | light(min) |
|---|---:|---:|---:|---:|---:|---:|
| RM4 | 15870 | 289 (1.8%) | 1003 (6.3%) | 1934 (12.2%) | 988 | 1201 |
| RM5 | 16351 | 1772 (10.8%) | 2290 (14.0%) | 3528 (21.6%) | 2749 | 0 |
| RM6 | 20356 | 2505 (12.3%) | 3082 (15.1%) | 4174 (20.5%) | 2763 | 0 |

Carga (medianas, para contexto):

| Host | controllers P50 | desiredActive P50 | desiredTotal P50 | shardSize P50 |
|---|---:|---:|---:|---:|
| RM4 | 25 | 28 | 28 | 28 |
| RM5 | 30 | 31 | 31 | 30 |
| RM6 | 26 | 41 | 57 | 26 |

---

## Interpretação (verdade nua e crua)

### RM4 (risco real)

- **RAM em risco**: min `freeMB=289` (≈ **1.8%** do total), e `p50 freeMB=1934` (≈ **12.2%**).
- **Entrou em light 1201 minutos** de 2189 (≈55% do tempo), consistente com o limiar de 2GB e o fato de a mediana estar **abaixo** de 2GB.
- **Conclusão**: RM4 está operando **no limite** para a configuração atual (totalMB ~15.5GB). O modo leve está fazendo o papel de “seguro”, mas isso não elimina o risco de instabilidade quando a RAM fica muito baixa.

### RM5 (ok / margem confortável)

- Min `freeMB=1772` (≈10.8%), mas `p5=2290` e `p50=3528`.
- **Não entrou em light** (0 minutos), o que sugere que as quedas abaixo de 2GB não se sustentaram pelo tempo de confirmação (5 min).
- **Conclusão**: RAM está sob controle na janela analisada.

### RM6 (RAM ok, mas atenção para lag extremo)

- RAM livre: min 2505 (12.3%), p50 4174 (20.5%) — bom.
- Embora não tenha entrado em light, foi observado `lagMaxMs` extremo (picos) no snapshot (já capturado nos arquivos). Isso pode indicar travamentos do event-loop (I/O, GC, picos de trabalho) mesmo com RAM ok.
- **Conclusão**: RAM não é o gargalo principal; investigar “por que o loop travou” é a próxima etapa (se estiver afetando produção).

---

## Recomendações (objetivas, sem achismo)

### Recomendações imediatas (sem mexer em código)

1) **RM4**: reduzir a carga (cap de contas ativas / navegadores simultâneos) **ou** aumentar RAM do host.
   - Evidência: min freeMB 289 e p50 abaixo do limiar de 2GB.

2) Manter `CT_GOV_MEM_ENTER_MB=2048` por enquanto (ele está funcionando como “alerta/seguro”), mas tratar isso como **sintoma de capacidade**, não “bug”.

### Recomendações de engenharia (próximo ciclo)

1) Definir uma regra de capacidade por RAM total (ex.: 16GB vs 20GB) em vez de “um número fixo por RM”.
2) Criar um segundo relatório: “lag forense” (picos de `lagMaxMs`) para RM6 e cruzar com:
   - picos de `rssMB/heapUsedMB` (já existe no governor_snapshots),
   - eventos de `provision_audit` próximos ao horário (se necessário).

---

## Próximas perguntas (para guiar decisão do líder)

- Qual é a **margem mínima aceitável** de RAM livre em produção? (ex.: nunca < 2GB? nunca < 10%?)
- “Capacidade máxima” significa **quantos perfis em desired** ou quantos **browsers simultâneos** (controllers)?
- Aceitamos modo leve como “normal” em servidor lotado, ou preferimos reduzir contas para manter full quase sempre?

