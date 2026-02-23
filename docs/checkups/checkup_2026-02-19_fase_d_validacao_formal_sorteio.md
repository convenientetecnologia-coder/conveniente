### Checkup — Fase D (validação formal consolidada: stress + legado + isolamento)

> Regra: este arquivo é um **relatório**. O resumo (1–3 linhas) vai para `docs/TIMELINE.md`.

#### Contexto

- Data: 2026-02-19
- Ambiente: prod (validação com evidência em logs/banco; sem deploy novo)
- Hosts envolvidos (hostId/hostname): n/a (análise local de artefatos do runtime)
- Sintoma: necessidade de prova formal de que o novo fluxo tokenizado está estável e sem regressão no legado
- Impacto: gate de segurança para avançar no rollout real sem achismo

---

### Evidências coletadas (objetivas)

- Stress de atomicidade (isolado em banco temporário, sem tocar produção):
  - `C:\sitechatbot\dados\forensics\stress_lottery_report_1771551152895.json`
  - `C:\sitechatbot\dados\forensics\stress_lottery_report_1771551162624.json`
  - resultado pesado: `totalLeads=500`, `totalParticipantsPersisted=16622`, `totalWinnersPersisted=500`, `failures=0`
- Não regressão do legado (eventos reais de envio para grupos):
  - `C:\sitechatbot\dados\pedidos_audit.jsonl`
  - evidências de `delivery_mode_effective=legacy` em cidades fora piloto (ex.: Vitória da Conquista, Porto Alegre, Maceió, Londrina, Santo Antônio do Descoberto)
  - checagem consolidada: `tokenized fora de Ipatinga (MG) = 0`
- Isolamento dual-number no WhatsApp (mensagens de sorteio/resultado):
  - banco: `C:\sitechatbot\whatsapp\db\whatsapp.sqlite` (tabela `wa_outbox`)
  - script de prova: `C:\sitechatbot\tools\check_wa_routing_lottery.js`
  - resultado: `totalRowsWithTenantId=353`, `totalHits=6`, `countsByPhoneNumberId={"981509815045915":6}`
  - ausência de hits de sorteio no número de leads `929357310261751`

---

### Achados (P0/P1/P2)

- **P0**: Nenhuma falha crítica encontrada nesta rodada formal. Os três critérios centrais passaram:
  1) atomicidade sob carga,
  2) não regressão fora do piloto,
  3) isolamento por `wa_phone_number_id`.
- **P1**: Cobertura de frase para validação automática de roteamento depende do conjunto textual atual (se copy mudar, atualizar padrões do script).
- **P2**: Recomendável manter execução periódica do stress isolado antes de cada mudança estrutural no sorteio.

---

### Decisão / Ação recomendada (cirúrgica)

- O que mudar:
  - manter o fluxo atual;
  - usar este checkup como gate técnico de passagem para próximas fases.
- Por quê:
  - há evidência objetiva e reproduzível de robustez nas frentes críticas.
- Risco:
  - risco residual operacional de produção real (rede/API externa/volume orgânico) permanece e deve ser monitorado por E2E controlado.
- Rollback:
  - não aplicável nesta fase (somente validação e documentação).

---

### Plano de rollout

- Reinícios necessários (quais processos/nodes):
  - nenhum nesta fase (sem mudança de runtime).
- Ordem:
  1. manter piloto estrito conforme flags;
  2. executar novo E2E controlado antes de ampliar grupos;
  3. somente então ampliar rollout.
- Validação pós-rollout (checks):
  - repetir query/relatório de `delivery_mode_effective`;
  - repetir prova por `wa_phone_number_id` no `wa_outbox`;
  - repetir stress isolado após mudanças de lógica de sorteio.

---

### Status final da Fase D

- **FASE D: PASS**
- Critérios aprovados:
  - `PASS` atomicidade (stress pesado sem falhas);
  - `PASS` legado fora piloto;
  - `PASS` isolamento entre número cliente e número operacional no fluxo de sorteio.
