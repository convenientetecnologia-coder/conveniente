# AUDITORIA_INTEGRIDADE_HISTORICO (Fluxo 1 — Histórico / Persistência)
Data: 2026-07-03  
Modo: **Read-Only** (sem alterações de código nesta rodada)  
Tickets de teste fornecidos: **#19132, #19129, #19115** (canal `messenger_delta`)

## 0) Veredito (1 linha)
Os “Cards Azuis” estão nascendo com chat vazio porque o **CT (sitechatbot)**, na rota **`POST /api/messenger-delta/ingest`**, **não persiste o histórico** (mensagens do cliente e saudação automática): ele apenas “crava” metadados e cria/atualiza um ticket shadow; o payload rico enviado pela VM é **ignorado**.

---

## 1) Rastreamento real no SQLite do CT (prova por dump)

### 1.1) `ticket_atendimento` (os 3 tickets)
Resultado real do dump:

```json
[
  {
    "id": 19115,
    "channel_source": "messenger_delta",
    "source_ref": "md:aba80611-8b8a-46ed-a852-f5f0d573c03b:jundiai-1780678129637:1042262595050004",
    "customer_name": null,
    "city_uf_normalized": "Petrolina, PE Message Save Share Details Condition Used - like new Petrolina, PE",
    "customer_conversation_ref": "1042262595050004",
    "raw_context_json": "{\"server_id\":\"aba80611-8b8a-46ed-a852-f5f0d573c03b\",\"account_login\":\"jundiai-1780678129637\",\"thread_key\":\"1042262595050004\",\"cidade\":\"Petrolina, PE Message Save Share Details Condition Used - like new Petrolina, PE\"}"
  },
  {
    "id": 19129,
    "channel_source": "messenger_delta",
    "source_ref": "md:aba80611-8b8a-46ed-a852-f5f0d573c03b:jundiai-1780678129637:824766373906828",
    "customer_name": null,
    "city_uf_normalized": "Santa Maria, RS Message Save Share Details Condition Used - Fair Santa Maria, RS",
    "customer_conversation_ref": "824766373906828",
    "raw_context_json": "{\"server_id\":\"aba80611-8b8a-46ed-a852-f5f0d573c03b\",\"account_login\":\"jundiai-1780678129637\",\"thread_key\":\"824766373906828\",\"cidade\":\"Santa Maria, RS Message Save Share Details Condition Used - Fair Santa Maria, RS\"}"
  },
  {
    "id": 19132,
    "channel_source": "messenger_delta",
    "source_ref": "md:aba80611-8b8a-46ed-a852-f5f0d573c03b:jundiai-1780678129637:1032371252821330",
    "customer_name": null,
    "city_uf_normalized": "Petrolina, PE Message Save Share Details Condition New Petrolina, PE · Location",
    "customer_conversation_ref": "1032371252821330",
    "raw_context_json": "{\"server_id\":\"aba80611-8b8a-46ed-a852-f5f0d573c03b\",\"account_login\":\"jundiai-1780678129637\",\"thread_key\":\"1032371252821330\",\"cidade\":\"Petrolina, PE Message Save Share Details Condition New Petrolina, PE · Location\"}"
  }
]
```

**Constatação**:
- `raw_context_json` contém apenas: `server_id`, `account_login`, `thread_key`, `cidade`.
- **Não existe** `historico` nem mensagens iniciais persistidas em JSON.
- O campo `city_uf_normalized` está recebendo **lixo de DOM** (“Message Save Share Details…”), indicando problema de higienização do campo cidade no pipeline de captura.

### 1.2) `ticket_event_log` (o que foi gravado de fato)
Contagem de eventos:

```json
[
  { "ticket_id": 19115, "n": 12 },
  { "ticket_id": 19129, "n": 9 },
  { "ticket_id": 19132, "n": 9 }
]
```

Amostra dos eventos gravados (resumo):
- Todos os eventos são **`messenger_delta_lead_capturado`** repetidos.
- Não há eventos de **mensagem do cliente** nem de **saudação**.

Trecho (exemplo real):

```json
{
  "ticket_id": 19132,
  "event_type": "messenger_delta_lead_capturado",
  "payload": {
    "server_id": "...",
    "account_login": "...",
    "thread_key": "...",
    "cidade": "Petrolina, PE Message Save Share Details Condition New Petrolina, PE · Location"
  }
}
```

**Conclusão do dump**:
O payload chegou ao CT (há `lead_capturado`), porém o CT **não está persistindo texto/histórico** — ele apenas registra “capturado”.

### 1.3) Observação crítica do Frontend (por que “parece 100% vazio”)
No dashboard, a renderização do chat para `messenger_delta` está configurada para buscar no `ticket_event_log` **somente** estes tipos de evento:
- `messenger_delta_agent_message_sent`
- `messenger_delta_delivery_update`

Ou seja:
- Mesmo os eventos existentes `messenger_delta_lead_capturado` **não aparecem** no chat.
- E como o CT não está gravando mensagens do cliente/saudação como eventos, o painel fica sem contexto visual.

---

## 2) Composição cronológica do payload na VM (o que a VM prepara)

No lado VM, o pipeline de ingestão foi migrado para `worker.js` (fila JSONL + POST stateless). O builder do payload confirma que o worker tenta enviar **mensagens do cliente concatenadas** + **saudação**:

Arquivo: `C:\conveniente\scripts\worker.js`

Ponto crítico: `__deltaBuildCtIngestPayload(payload)` monta:
- `mensagens_cliente_concatenadas`
- `saudacao_texto`
- `cidade`

E o loop `__deltaIngestTick()` só avança o cursor quando recebe **ACK 200** do CT.

**Isso indica que, do ponto de vista da VM, existe intenção explícita de enviar texto/histórico.**

---

## 3) Rota de ingestão no CT (onde o texto “morre”)

### 3.1) A rota `/api/messenger-delta/ingest` no CT é minimalista
Arquivo: `C:\sitechatbot\index.js`

A rota:
- lê `server_id`, `account_login`, `thread_key`
- lê `texto_limpo` apenas de `body.texto_limpo || body.last_message || body.texto`
- chama:
  - `__deltaUpsertCtChatRow(...)`
  - `__deltaUpsertAttendanceShadowTicket(...)`
- **não processa** `mensagens_cliente_concatenadas`
- **não processa** `saudacao_texto`
- **não executa loop de INSERT** de mensagens no `ticket_event_log`

### 3.2) O shadow ticket gravado não contém histórico
Arquivo: `C:\sitechatbot\index.js`

`__deltaUpsertAttendanceShadowTicket()` monta `rawContext` com:
- `server_id`, `account_login`, `thread_key`, `cidade`

E apenda um evento:
- `messenger_delta_lead_capturado`

**Não existe persistência do chat/histórico aqui.**

---

## 4) Hipóteses testadas (e resultado)

### H1) “A VM não está enviando texto”
**Refutada parcialmente**: o worker tem builder explícito (`mensagens_cliente_concatenadas` + `saudacao_texto`) e mantém cursor até ACK 200.

### H2) “O CT recebeu mas ignorou”
**Confirmada**: a rota do CT não tem nenhum bloco de persistência de histórico; o dump mostra apenas `lead_capturado`.

### H3) “Falha de integridade/chave impede INSERT”
**Irrelevante no estado atual**: não há sequer tentativa de INSERT de mensagens no CT para falhar — o código simplesmente não faz.

---

## 5) Observações adicionais (SRE)

1) **Evento repetido em loop**: `messenger_delta_lead_capturado` aparece muitas vezes por ticket (9–12).  
   Isso pode “poluir” o `ticket_event_log` e indica que o ingest está sendo chamado repetidamente sem dedupe/limite de evento “capturado”.

2) **Cidade com lixo de DOM** (`"Message Save Share Details Condition..."`) está sendo persistida em `city_uf_normalized`.  
   Mesmo que não quebre a triagem de tickets, isso degrada UX e pode afetar regras de roteamento por cidade.

---

## 6) Próximo passo recomendado (NÃO executado nesta rodada)
Para “histórico 110% perfeito” (cliente + saudação automática + cronologia), o CT precisa:
- Aceitar e persistir `mensagens_cliente_concatenadas` (ou array de mensagens) no **ticket_event_log** como eventos de chat.
- Persistir `saudacao_texto` como evento “outbound/bot” ou “greeting_sent”.
- Opcional: manter também um espelho em `raw_context_json.historico` (se o frontend depende disso).
- Deduplicar/limitar o evento `messenger_delta_lead_capturado` (ex.: 1 por ticket por janela de tempo).

