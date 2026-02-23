### Checkup — Novo fluxo de leads por sorteio e cobrança (pré-codificação)

> Regra: este arquivo é um relatório técnico para iniciar implementação com rastreabilidade total.

#### Contexto

- Data: 2026-02-19
- Ambiente: produção real (fase de desenho, sem deploy)
- Hosts envolvidos (hostId/hostname): n/a nesta fase (planejamento e auditoria de código)
- Sintoma: modelo atual expõe contato do cliente no grupo e não possui sorteio 2 min + cobrança por lead
- Impacto: necessidade de mudar o modelo de operação para pay-per-lead com controle financeiro e rollout seguro

---

### Evidências coletadas (objetivas)

- Arquivos/rotas existentes (CT core):
  - `C:\sitechatbot\index.js`
  - `GET/POST /webhook` (ingest Meta)
  - `POST /api/pedidos` (enqueue de pedidos)
  - `GET /api/notifier/next` e `POST /api/notifier/ack` (fila notificador)
- Fila de pedidos e mensagem para grupo:
  - `C:\sitechatbot\lib\pedidosStore.js`
  - estados `pending/sending/sent/error/dead`
  - builder atual inclui `Telefone` e `Link para contatar o cliente`
- Notificador (envio para grupos):
  - `C:\notificador\index.js`
  - mapa `cidade_uf -> groupId` em `groupsids.json`
  - envio do texto recebido no job + ACK resiliente
- Sistema interno de cadastro/participação (CT):
  - `C:\sitechatbot\convenientetecnologia\index.js`
  - `C:\sitechatbot\convenientetecnologia\lib\ctStore.js`
  - `C:\sitechatbot\convenientetecnologia\lib\ctMembershipStore.js`
  - já existem campos e rotas de cobrança por participação (`monthly_value_cents`, `billing_day`, `first_invoice_*`, `subscription_created_*`)
- Estrutura de banco (CT SQLite):
  - `C:\sitechatbot\convenientetecnologia\lib\ctDb.js`
  - esquema de `ct_driver_memberships` já contém base de cobrança, porém não existe ledger de leads sorteados nem integração Asaas E2E

---

### Achados (P0/P1/P2)

- **P0**
  - O fluxo atual publica contato direto do cliente no grupo via `buildMensagemMotorista` em `pedidosStore` (não atende novo requisito).
  - Não existe entidade de domínio para "lead token", "janela de sorteio", "participantes", "vencedor" e "perdedores".
  - Não existe ledger financeiro por lead sorteado (débito unitário + ajustes auditáveis).
  - Orquestração Asaas diária (seg-sex 08:00 / bloqueio 15:00) existe como **protótipo** no CT, mas ainda falta acoplar no runtime e validar E2E (mensageria + piloto).
  - Não existe gate por grupo para rollout parcial (3 grupos piloto mantendo legado nos demais).
- **P1**
  - Chat interno já existe, mas não há fluxo dedicado por setor (financeiro/administrativo) vinculado ao contexto de cobrança do motorista.
  - Falta trilha operacional única para renegociação (abatimento/desconto/adiamento) com reemissão controlada.
- **P2**
  - Falta painel consolidado de observabilidade para o novo fluxo (sorteio, conversão, cobrança, inadimplência, SLA de atendimento).

---

### Revalidação rodada 2 (sem piedade) — lacunas bloqueadoras pré-código

- **P0 — Roteamento dual-number incompleto no parser**
  - evidência: `C:\sitechatbot\whatsapp\lib\metaParser.js` extrai `from`/`type`, mas não persiste `phone_number_id` do payload Meta.
  - risco: mistura de contexto entre número de entrada (cliente) e número operacional (motorista).
  - ação obrigatória: incluir `phone_number_id`/`business_phone` no evento normalizado e usar isso no roteamento.

- **P0 — Sem modelo formal de lock do sorteio por lead**
  - evidência: não existe tabela/estado para `lead_window`, `lead_participant`, `lead_winner`.
  - risco: 2 vencedores em corrida de fechamento/retry.
  - ação obrigatória: lock transacional por `leadToken` + constraint única de vencedor.

- **P0 — Conflito potencial entre cobrança por participação atual e novo modelo por lead**
  - evidência: `ctMembershipStore` e `ctDb` já operam `monthly_value_cents`, `billing_day`, `first_invoice_*`, `subscription_created_*`.
  - risco: mistura de regras antigas (mensalidade/approved->active) com nova regra de débito por lead.
  - ação obrigatória: separar claramente domínio "assinatura/mensalidade legado" de "ledger pay-per-lead" (novo).

- **P0 — Scheduler de cobrança ainda não especificado para tolerância a downtime**
  - evidência: não há rotina de cobrança Asaas existente no CT para janela diária útil (08:00) com recuperação.
  - risco: perda de janela de cobrança quando processo estiver fora.
  - ação obrigatória: job idempotente por `billingCycleKey` + catch-up ao subir.

- **P0 — Gating de elegibilidade precisa existir em dois pontos**
  - evidência: fluxo atual só enfileira/envia pedido; não há validação de dívida no ato de "entrar no sorteio" e no ato de "entregar vencedor".
  - risco: motorista bloqueado ganhar lead por condição de corrida.
  - ação obrigatória: validar elegibilidade em `join` e revalidar antes de entregar dados completos.

- **P1 — Pilotagem por 3 grupos requer override por groupId (não só por cidade)**
  - evidência: `notificador/index.js` usa mapa `cidade_uf -> groupId`.
  - risco: ativar por cidade pode afetar grupos fora do piloto.
  - ação obrigatória: feature flag explícita por `groupId` com fallback imediato.

- **P1 — Política de liberação provisória 48h ainda sem mecanismo**
  - evidência: requisito humano cita liberação temporária manual por comprovante.
  - risco: bloqueio indevido de motorista pagante durante compensação de boleto.
  - ação obrigatória: override com expiração automática (`eligible_until`) + trilha de auditoria.

---

### Revalidação rodada 3 (ultra completa) — blindagem de não regressão e anti-mistura

- **P0 — Isolamento por número de WhatsApp ainda ausente no pipeline de conversa**
  - evidência:
    - `C:\sitechatbot\whatsapp\lib\metaParser.js` normaliza `from/type`, mas não carrega `phone_number_id`/`to`.
    - `C:\sitechatbot\whatsapp\index.js` processa `messages` e consulta conversa por `phone` apenas (`db.getOpenConversationByPhone(msg.phone)`).
    - `C:\sitechatbot\whatsapp\lib\db.js` e `C:\sitechatbot\whatsapp\db\schema.sql` usam `phone` como chave operacional de contato/conversa (sem coluna de número de destino).
  - risco: conversa de cliente (número de atendimento) e conversa de motorista (número operacional) colidirem no mesmo contexto quando o remetente for o mesmo telefone.
  - ação obrigatória: chave de tenant no WhatsApp (`phone_number_id` ou `wa_business_number`) em `wa_contacts`, `wa_conversations`, `wa_inbox`, `wa_outbox` e no roteamento.

- **P0 — Fila única de distribuição para grupos sem segregação de modo legado vs novo**
  - evidência:
    - `C:\sitechatbot\lib\pedidosStore.js` grava `source`, mas `claimNext` seleciona pendências sem filtro de `source`/`mode`.
    - `C:\sitechatbot\index.js` (`/api/notifier/next`) consome `pedidosStore.claimNext` diretamente.
    - `C:\notificador\index.js` envia qualquer job recebido apenas por `cidade_uf -> groupId`.
  - risco: mudança no builder/contrato da mensagem afetar todos os grupos legados ao mesmo tempo.
  - ação obrigatória: separar contrato de publicação por `delivery_mode` (`legacy`/`tokenized`) e controlar seleção por feature flag de grupo.

- **P0 — Pilotagem por 3 grupos não é verificável sem flag em ponto de publicação**
  - evidência:
    - roteamento atual no notificador é somente por `cidade_uf` (`groupsids.json`).
    - requisito operacional exige ativar novo fluxo em 3 grupos mantendo os demais intocados.
  - risco: ativação involuntária fora do piloto.
  - ação obrigatória: tabela/arquivo de `group_rollout_flags` com auditoria e fallback imediato por `groupId`.

- **P1 — Invariantes de contrato legado ainda não formalizados em teste automatizado**
  - evidência:
    - não há suíte específica garantindo que o pipeline atual continue publicando pedidos como hoje enquanto flags estiverem OFF.
  - risco: regressão silenciosa no fluxo que já está em produção real.
  - ação obrigatória: suíte de não-regressão com snapshots de payload/mensagem e cenários de fila/ack.

---

### Invariantes obrigatórios (não negociáveis) antes do 1º deploy do novo fluxo

1. **Sem mistura entre APIs/números**  
   Mensagens recebidas no número de atendimento e no número operacional não podem compartilhar conversa/estado por engano.
2. **Sem regressão no legado com flags OFF**  
   Todos os grupos continuam recebendo pedido no formato atual exatamente como hoje.
3. **Sem ativação fora do piloto**  
   Novo formato (tokenizado/anônimo) só sai para os 3 `groupId` autorizados.
4. **Sem dupla entrega de vencedor**  
   Exatamente 1 vencedor por `leadToken`, mesmo com retry/reprocessamento.
5. **Sem buraco financeiro**  
   Toda vitória gera lançamento e toda baixa paga desbloqueia elegibilidade com rastreio.

---

### Matriz de validação pré-código (rodada 3)

- **M1 — Chave de isolamento WhatsApp**
  - entrada: payload Meta com `phone_number_id` diferente e mesmo `from`.
  - esperado: contextos e conversas separados por número de destino.
- **M2 — Legado íntegro**
  - entrada: pedido legado com flags do novo fluxo OFF.
  - esperado: mensagem de grupo idêntica ao comportamento atual.
- **M3 — Piloto estrito**
  - entrada: pedidos de grupos piloto e não piloto no mesmo período.
  - esperado: somente piloto recebe contrato novo.
- **M4 — Fila/ack sob erro**
  - entrada: falha de envio + retry do notificador.
  - esperado: sem duplicar vencedor/cobrança e sem leak para grupos não piloto.
- **M5 — Contenção de regressão**
  - entrada: carga simultânea (webhook cliente + webhook motorista).
  - esperado: isolamento preservado e zero contaminação cruzada.

---

### Revalidação rodada 4 (ultra auditoria de destrinche completo)

### Estado atual confirmado no código (o que já existe)

- **Pipeline de entrada e distribuição já está robusto**
  - `C:\sitechatbot\index.js` mantém rotas de ingestão (`/webhook`, `/api/pedidos`, `/api/virtus/pedido`) e fila do notificador (`/api/notifier/next`, `/api/notifier/ack`).
  - `C:\sitechatbot\lib\pedidosStore.js` já possui estados `pending/sending/sent/error/dead`, lock de envio e retry/backoff.
  - `C:\notificador\index.js` já tem ACK resiliente (evita duplicação quando API oscila).

- **Fluxo atual do cliente WhatsApp está em produção e funcional**
  - `C:\sitechatbot\whatsapp\index.js` processa webhook, enfileira inbox e roda workers.
  - `C:\sitechatbot\whatsapp\lib\flow.js` já fecha conversa e enfileira pedido para grupos.

- **CT já possui base forte de cadastro, memberships e chat interno**
  - `C:\sitechatbot\convenientetecnologia\index.js` expõe rotas completas de memberships e chat.
  - `C:\sitechatbot\convenientetecnologia\lib\ctDb.js` e `ctMembershipStore.js` já suportam cobrança por participação (mensalidade), status, revisão e auditoria de ações.

### Lacunas confirmadas (o que ainda NÃO existe para o novo modelo)

- **P0 — Mensagem ainda expõe contato do cliente (legado ativo)**
  - evidência: `buildMensagemMotorista` em `C:\sitechatbot\lib\pedidosStore.js` ainda inclui `Telefone` e `Link para contatar o cliente`.
  - impacto: requisito de anonimização ainda não atendido.

- **P0 — Sorteio por token não existe no domínio**
  - evidência: ausência de entidades para `leadToken`, janela de 2 minutos, participantes e vencedor único no `sitechatbot`.
  - impacto: sem mecanismo de competição controlada entre motoristas.

- **P0 — Isolamento dual-number segue incompleto**
  - evidência: `C:\sitechatbot\whatsapp\lib\metaParser.js` não persiste `phone_number_id`; conversa é correlacionada por `phone`.
  - impacto: risco de mistura entre número de atendimento e número operacional.

- **P0 — Cobrança Asaas ainda não implementada em runtime (acoplamento)**
  - evidência: contrato documental existe (`C:\sitechatbot\docs\INTEGRACAO_ASAAS.md`) e o protótipo foi alinhado em `C:\sitechatbot\convenientetecnologia\lib\ctLeadLedgerStore.js` (validador: `C:\sitechatbot\tools\validate_billing_window_rule.js`).
  - impacto: ainda falta plugar o scheduler no processo real do CT + fluxo de aviso ao motorista + prova E2E (webhook/baixa/eligibilidade).

- **P0 — Ledger por lead (R$10 por vitória + ajustes) ainda inexistente**
  - evidência: CT atual possui cobrança por participação (`monthly_value_cents`, `billing_day`) e não por evento de vitória de lead.
  - impacto: sem trilha financeira por lead ganho.

- **P1 — Chat existe, mas não com triagem nativa de motorista por setor**
  - evidência: APIs de chat genéricas em `C:\sitechatbot\convenientetecnologia\index.js`; não há fluxo nativo "falar com financeiro/administrativo" ligado ao número operacional do novo fluxo.
  - impacto: atendimento funciona, mas sem roteamento automático por contexto de dívida/cadastro.

- **P1 — Rollout por 3 grupos ainda depende de mecanismo novo**
  - evidência: notificador atual usa mapeamento `cidade_uf -> groupId` sem regra explícita de `delivery_mode` por grupo.
  - impacto: sem trava canônica para ativar contrato novo só nos 3 grupos piloto.

### Plano técnico de execução sem quebrar o legado (ordem cirúrgica)

1. **Isolamento de tenant WhatsApp (dual-number)**: incluir `phone_number_id` no parser, persistência e lookup de conversa.
2. **Novo domínio de lead/token/sorteio**: tabelas com lock transacional e vencedor único por `leadToken`.
3. **Mensagem dupla com flag**: manter builder legado; criar builder tokenizado; selecionar por `groupId` piloto.
4. **Ledger pay-per-lead separado de membership legado**: não reutilizar mensalidade como fonte de verdade de débito de lead.
5. **Asaas E2E**: emissão diária útil 08:00 idempotente + bloqueio 15:00 + webhook de baixa + elegibilidade.
6. **Atendimento motorista**: entrada do número operacional com roteamento para financeiro/administrativo no chat CT.
7. **E2E completo e só então piloto**: 3 grupos definidos, rollback por grupo imediato.

---

### Verificação de completude total (rodada 5) — checklist 110%

Legenda:
- **OK** = investigado e documentado com evidência.
- **PENDENTE** = ainda depende de decisão/evidência final.

| ID | Requisito humano | Status | Evidência principal | Bloqueia plano de execução? |
|---|---|---|---|---|
| R01 | Não quebrar fluxo atual de pedidos nos grupos | OK | `C:\sitechatbot\lib\pedidosStore.js`, `C:\notificador\index.js` | sim (se não houver garantia por flag) |
| R02 | Não misturar APIs/números WhatsApp | PENDENTE | `C:\sitechatbot\whatsapp\lib\metaParser.js`, `C:\sitechatbot\whatsapp\lib\db.js` | sim |
| R03 | Mensagem anônima no grupo (sem telefone/link cliente) | PENDENTE | builder atual ainda expõe contato em `pedidosStore` | sim |
| R04 | Link com código/token para número operacional | PENDENTE | domínio `leadToken` ainda inexistente | sim |
| R05 | Janela de 2 minutos para participação | PENDENTE | sem entidade de janela/participante/vencedor | sim |
| R06 | Regra de vencedor (menor consumo + desempate chegada) | PENDENTE | sem algoritmo persistido/auditável | sim |
| R07 | 1 único vencedor por lead | PENDENTE | sem lock transacional por token | sim |
| R08 | Registro financeiro por lead ganho (R$10) | PENDENTE | CT atual é mensalidade por participação | sim |
| R09 | Ajustes manuais no “banco” (abatimento/desconto/zerar/renegociar) | PENDENTE | menu/ledger específico não implementado | sim |
| R10 | Cobrança automática diária útil 08:00 com bloqueio 15:00 | PENDENTE | protótipo alinhado (`ctLeadLedgerStore.js`) + contrato (`INTEGRACAO_ASAAS.md`) | sim |
| R11 | Boleto/Pix somente (sem cartão) | PENDENTE | regra de emissão ainda não codificada | sim |
| R12 | Baixa automática e desbloqueio de elegibilidade | PENDENTE | sem webhook financeiro integrado no runtime | sim |
| R13 | Bloqueio de devedor ao tentar entrar no sorteio | PENDENTE | sem gate duplo `join` + `entrega` | sim |
| R14 | Liberação provisória 48h com comprovante | PENDENTE | mecanismo `eligible_until` não implementado | não (pode ir em fase controlada, mas recomendado P1 alto) |
| R15 | Atendimento financeiro/administrativo no chat CT | PENDENTE | chat existe, roteamento por setor ainda não | não (mas essencial para operação) |
| R16 | Piloto estrito em 3 grupos e expansão gradual | PENDENTE | falta lista final `groupId` + flag canônica | sim |
| R17 | E2E/simulação antes de Go-Live | OK | matriz E2E e critérios Go/No-Go já definidos neste dossiê | sim (execução ainda pendente) |
| R18 | Segurança de segredo (sem expor token) | PENDENTE | `INC-20260219-1020-01` aguarda evidência de rotação | sim |

---

### Gate hard-stop antes da auditoria de plano de execução

Para avançar para a auditoria do plano de execução, estes itens precisam estar fechados:

1. confirmar os 3 `groupId` do piloto;
2. confirmar ciclo de pontuação do sorteio (reset);
3. confirmar regra de elegibilidade (global vs por cidade/grupo);
4. confirmar política Asaas (editar cobrança vs cancelar+criar);
5. confirmar modelagem de isolamento dual-number (`phone_number_id`);
6. confirmar modelagem de ledger separado do domínio mensalidade;
7. registrar evidência de rotação de segredo (`INC-20260219-1020-01`).

Sem esses 7 pontos, qualquer plano de execução fica com risco de achismo/regressão.

---

### Perguntas obrigatórias de alinhamento final (antes do primeiro commit de código)

1. Ciclo de pontuação do sorteio:
   - zera toda segunda?
   - zera após pagamento diário útil?
   - ou usa janela móvel por período?
2. Política de cobrança:
   - reemite alterando cobrança existente ou cancela e cria nova sempre?
3. Elegibilidade:
   - dívida bloqueia globalmente o motorista ou por cidade/grupo?
4. Atendimento:
   - financeiro/administrativo será dentro do chat atual ou módulo novo?
5. Piloto:
   - lista exata dos 3 `groupId` + critérios para ampliar rollout.

---

### Decisão / Ação recomendada (cirúrgica)

- O que mudar:
  - Implementar o novo fluxo em camadas, preservando o pipeline atual como fallback.
  - Reaproveitar infraestrutura já pronta (fila de pedidos, notificador, cadastros/memberships) e adicionar domínios faltantes.
- Por quê:
  - Minimiza risco de regressão e acelera entrega com base em código já estabilizado.
- Risco:
  - Misturar mudança de mensagem, sorteio e cobrança no mesmo deploy gera efeito cascata difícil de depurar.
- Rollback:
  - Feature flags por grupo + fallback para builder legado de mensagem e sem participação no sorteio.

---

### Arquitetura-alvo (macro)

1) **Entrada do pedido (cliente)**  
- Continua no CT (`/webhook` e/ou `/api/pedidos`) com deduplicação.
- Gera `leadToken` único e persistido.

2) **Publicação para grupos (motoristas)**  
- Mensagem no grupo sem contato do cliente.
- Inclui link com `leadToken` para o número operacional.

3) **Participação no sorteio**  
- Mensagem do motorista no número operacional entra em fila por `leadToken`.
- Primeira entrada abre janela de 2 minutos.

4) **Fechamento da janela**  
- Seleção determinística:
  - menor contagem de leads no ciclo;
  - empate por `joined_at` (ordem de chegada).
- Vencedor recebe dados completos do lead.
- Não vencedores recebem resposta de encerramento.

5) **Financeiro (ledger + cobrança)**  
- Cada vitória gera lançamento de débito unitário.
- Scheduler diário útil 08:00 emite cobrança para quem tiver saldo.
- Às 15:00, motorista com pendência segue bloqueado até baixa confirmada.
- Pagamento confirmado libera elegibilidade automaticamente.

6) **Operação interna (CT)**  
- Menu "Banco" no cadastro:
  - ledger de leads;
  - ajustes manuais auditáveis;
  - ações de cobrança/reemissão;
  - status de bloqueio/liberação.

---

### Mapeamento INC -> entrega técnica

- `INC-20260219-0910-01`  
  - anonimização da mensagem de grupo;
  - geração/persistência de `leadToken`;
  - link operacional por token.

- `INC-20260219-0920-01`  
  - fila de participantes;
  - janela 2 min;
  - algoritmo de seleção determinística;
  - mensagens vencedor/perdedor.

- `INC-20260219-0930-01`  
  - modelo ledger (`lead_award`, `manual_adjustment`, `payment_settlement`);
  - saldo devedor por motorista;
  - trilha de auditoria (`actor`, `reason`, `timestamp`).

- `INC-20260219-0940-01`  
  - integração Asaas (sem expor secret em código/docs);
  - criação/reemissão/cancelamento de cobrança;
  - webhook de baixa;
  - gate de elegibilidade por dívida.

- `INC-20260219-0950-01`  
  - roteamento para atendimento financeiro/administrativo;
  - cards/salas no CT com contexto do motorista e dívida.

- `INC-20260219-1000-01`  
  - feature flag por grupo;
  - lista de 3 grupos piloto;
  - fallback imediato por grupo.

- `INC-20260219-1010-01`  
  - suíte E2E;
  - simulações de carga;
  - critérios de Go/No-Go.

- `INC-20260219-1020-01`  
  - rotação de credencial e validação de revogação da antiga.

---

### Dependências e ordem de implementação (obrigatória)

1. `1020` segurança (rotação credencial).  
2. `0910` token + mensagem anônima (sem ativar em produção geral).  
3. `0920` sorteio com janela e seleção.  
4. `0930` ledger/banco do motorista.  
5. `0940` cobrança e bloqueio por débito.  
6. `0950` atendimento financeiro/administrativo.  
7. `1010` testes E2E completos.  
8. `1000` piloto 3 grupos -> aprovação -> expansão.

---

### Critérios de aceite (Go/No-Go)

- **Tokenização**
  - nenhum pedido no grupo piloto exibe telefone/link do cliente.
  - todo pedido gera `leadToken` único e rastreável.

- **Sorteio**
  - 1 vencedor por `leadToken`.
  - desempate reproduzível por ordem de chegada.
  - losers notificados sem ambiguidade.

- **Ledger**
  - toda vitória gera débito.
  - toda alteração manual gera trilha (`quem`, `quando`, `motivo`).
  - saldo final reproduzível a partir dos lançamentos.

- **Cobrança**
  - job diário útil 08:00 idempotente com corte de bloqueio às 15:00.
  - baixa automática libera elegibilidade.
  - dívida aberta bloqueia participação.

- **Piloto**
  - somente 3 grupos no novo fluxo.
  - rollback por grupo em 1 ação.
  - sem impacto nos grupos legados.

---

### Plano de testes E2E (mínimo obrigatório)

1. Pedido entra -> token gerado -> grupo recebe mensagem sem contato.  
2. 1 motorista participa -> ganha automaticamente no fechamento da janela.  
3. 10 motoristas participam -> vence menor consumo; empate por chegada.  
4. Motorista com dívida tenta participar -> bloqueio + opção de pagar/financeiro.  
5. Motorista sem cadastro -> opção cadastro/administrativo.  
6. Ajuste manual no banco -> saldo atualizado corretamente.  
7. Cobrança emitida -> pagamento confirmado -> desbloqueio automático.  
8. Falhas de webhook/retry -> sem duplicar vencedor nem cobrança.

---

### Observabilidade e evidência operacional

- Logs por `leadToken`, `driverId`, `groupId`, `requestId`.
- Eventos obrigatórios:
  - `lead_created`
  - `lead_window_opened`
  - `lead_participant_joined`
  - `lead_winner_selected`
  - `lead_loser_notified`
  - `ledger_entry_created`
  - `billing_issued`
  - `billing_paid`
  - `eligibility_blocked` / `eligibility_released`
- Métricas mínimas:
  - taxa de participação por lead;
  - tempo médio até vencedor;
  - inadimplência ativa;
  - sucesso de envio notificador;
  - erros por etapa.

---

### Segurança (não negociável)

- Nunca armazenar token de API em docs/chat.
- Registrar somente:
  - nome da variável (`ASAAS_ACCESS_TOKEN`);
  - local de configuração (env/arquivo seguro);
  - evidência de rotação e revogação.

---

### Reinícios / rollout desta fase de auditoria

- Reinícios necessários agora: nenhum (somente dossiê e planejamento).
- Reinícios quando começar implementação:
  - `sitechatbot`: `node index.js` (novas rotas/scheduler/integrações)
  - `notificador`: `node index.js` (mudança de contrato de mensagem/fluxo)
- Ordem recomendada (quando houver código):
  - subir CT primeiro (com feature flags OFF),
  - depois notificador,
  - então habilitar 3 grupos piloto.

