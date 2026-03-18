# Checkup — Dossiê pré-código: Serviço de Lead (menu de serviços pós-frete)

**Data**: 2026-03-18  
**Ambiente**: produção (sitechatbot)  
**INC**: `docs/inbox/need_evidence/INC-20260318-1000-01.md`  
**Regra**: NÃO codar ainda — auditoria e registro primeiro  

---

## 1. Contexto e objetivo

### Situação atual

O Virtus API (WhatsApp) atende clientes de frete/mudança. Em **3 cenários** o sistema envia uma mensagem final e encerra o chat:

1. **Completo**: cliente respondeu todas as perguntas (cidade, origem, destino, carga, etc.)
2. **Timeout parcial**: 10 min com UF+cidade mas sem completar
3. **Fast-track**: cliente pediu "chamar motorista" no meio do fluxo

O texto atual (comum ou similar) é:

```
✅ Sua solicitação foi recebida!

Em instantes um motorista vai chamar você aqui no WhatsApp com o orçamento.

Enquanto isso, você também pode participar do nosso grupo gratuito no WhatsApp SUPER DESCONTOS...
https://chat.whatsapp.com/Cxnyiu7SiZd1VTLBuOJU5y
```

### Objetivo da mudança

- **Aproveitar o lead do frete** oferecendo serviços complementares (internet, montador, limpeza, etc.)
- Enviar **menu interativo** (lista WhatsApp, até 10 itens) junto com o texto final
- Quando o cliente **seleciona um serviço**: registrar no CT, enviar mensagem amigável, reenviar menu
- Novo **menu no CT** "Serviço de Lead" para o operador ver e trabalhar os leads

---

## 2. Mapeamento técnico (evidência)

### 2.1 Onde o texto final é enviado

| # | Caso | Arquivo | Função/Bloco | Linha aprox. | Formato |
|---|------|---------|--------------|--------------|---------|
| 1 | Completo | `sitechatbot/whatsapp/lib/flow.js` | `handleConfirmCargo` (yesno.value=sim) | 3158-3161 | `buildTextPayload(phone, getFinalText())` |
| 2 | Timeout parcial | `sitechatbot/whatsapp/lib/timeouts.js` | loop `checkTimeouts` (partial_timeout) | 599-612 | `buildTextPayload(phone, getFinalText())` |
| 3 | Fast-track | `sitechatbot/whatsapp/lib/flow.js` | `interactiveId === 'fasttrack:send_now'` | 4434 | Texto **hardcoded** (não usa getFinalText) |

**Achado**: `getFinalText()` está **duplicado** em `flow.js` e `timeouts.js`. O fast-track usa texto inline.

### 2.2 Função getFinalText

- **flow.js** L748: `function getFinalText()` — lê `WA_FINAL_TEXT` (env) ou fallback padrão
- **timeouts.js** L15: mesma lógica (duplicada)
- **ENV.example** L59: `WA_FINAL_TEXT=...` (valor padrão documentado)

### 2.3 API WhatsApp — menu (lista)

- **whatsappApi.js** L72: `buildListPayload(to, bodyText, buttonText, sectionTitle, rows)`
- Suporta até **10 rows** por seção
- Formato: `interactive.type = 'list'` com `sections[].rows[]`
- Cada row: `{ id, title, description? }` — `id` é enviado de volta no `interactive_id` quando o usuário clica

### 2.4 Dados disponíveis no fechamento

| Dado | Fonte | Observação |
|------|-------|-------------|
| Telefone | `conversation.phone` | E.164 ou digits |
| Cidade | `conversation.city` + `conversation.uf` | Ex.: "Ipatinga (MG)" |
| Conversa ID | `conversation.id` | Para correlacionar |

### 2.5 Estrutura do CT (menu atual)

- **menu.html**: cards com links (Sistema Interno, Servidores, Virtus, Grupos, Contas, Diagnósticos, Estoque, Site, Contestação)
- Novo card: "Serviço de Lead" → rota a definir (ex.: `/convenientetecnologia/servico-lead`)

---

## 3. Fluxo proposto (detalhado)

### 3.1 Texto final + menu (3 pontos de envio)

Em **todos os 3 casos** (completo, timeout, fast-track):

1. **Texto** (novo):
   ```
   ✅ Sua solicitação foi recebida!

   Em instantes um motorista vai chamar você aqui no WhatsApp com o orçamento do frete.

   Enquanto isso, se precisar de outros serviços para sua mudança (como internet, montagem de móveis, entre outros), você pode acessar o menu abaixo e escolher o que precisar.

   Assim que selecionar, um profissional entra em contato com você.

   Você também pode participar do nosso grupo gratuito no WhatsApp SUPER DESCONTOS...
   🟢 Acesse o grupo gratuito de SUPER DESCONTOS:
   https://chat.whatsapp.com/Cxnyiu7SiZd1VTLBuOJU5y

   👇 Escolha uma opção no menu abaixo
   ```

2. **Payload**: `kind: 'list'` com `buildListPayload` — botão "Escolher" / "Menu", 10 opções

### 3.2 Quando cliente seleciona um serviço

- `interactive_id` recebido: `lead_service:1` a `lead_service:10` (ou `lead_service:internet`, etc.)
- **Ação**:
  1. Persistir em `ct_lead_service_requests` (phone, city_uf, service_id, created_at)
  2. Enviar mensagem amigável: "Obrigado! Um profissional já vai entrar em contato com você para ajudar com [serviço]. Deseja selecionar mais algum serviço?"
  3. Reenviar menu (lista) — texto só com o menu

### 3.3 Quando cliente seleciona e já tinha selecionado antes

- Se já registrou: enviar agradecimento simples + menu de novo (para multi-seleção)

### 3.4 Menu no CT

- Nova rota/página: lista de `ct_lead_service_requests` com: telefone, cidade, serviço, data
- Filtros: status (novo/em_atendimento/convertido), período
- Usuário humano trabalha os leads (liga, envia WhatsApp, etc.)

---

## 4. Especificação dos 10 serviços

| # | id | title (até 24 chars) | description (até 72 chars) |
|---|-----|----------------------|----------------------------|
| 1 | lead_service:1 | 📶 Internet residencial | Ativar internet rápida na sua nova casa |
| 2 | lead_service:2 | 🛠️ Montador de móveis | Montagem rápida e profissional |
| 3 | lead_service:3 | 🧹 Limpeza pós-mudança | Deixe tudo limpo e organizado |
| 4 | lead_service:4 | ❄️ Ar-condicionado | Instalação com técnico especializado |
| 5 | lead_service:5 | 🐜 Dedetização | Elimine pragas da sua nova casa |
| 6 | lead_service:6 | 📺 TV por assinatura | Planos com canais e streaming |
| 7 | lead_service:7 | 🔒 Segurança residencial | Câmeras e alarmes para sua casa |
| 8 | lead_service:8 | 🏠 Seguro residencial | Proteja seu imóvel e seus bens |
| 9 | lead_service:9 | 🚗 Seguro de veículo | Proteja seu carro com ótimos planos |
| 10 | lead_service:10 | ☀️ Energia solar | Economize na conta de luz |

**Nota**: WhatsApp limita `title` a 24 caracteres e `description` a 72. Ajustar se necessário.

---

## 5. Schema proposto (ct_lead_service_requests)

```sql
CREATE TABLE IF NOT EXISTS ct_lead_service_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  phone_digits TEXT NOT NULL,
  city_uf TEXT,
  service_id INTEGER NOT NULL,  -- 1..10
  service_label TEXT,
  conversation_id INTEGER,
  created_at INTEGER NOT NULL,
  status TEXT DEFAULT 'novo',  -- novo | em_atendimento | convertido | cancelado
  updated_at INTEGER,
  notes TEXT
);

CREATE INDEX idx_lead_service_phone ON ct_lead_service_requests(phone_digits);
CREATE INDEX idx_lead_service_status ON ct_lead_service_requests(status);
CREATE INDEX idx_lead_service_created ON ct_lead_service_requests(created_at);
```

---

## 6. Arquivos a tocar (resumo)

**Ordem de implementação (decisão humana):**
1. **Fase 1**: CT menu "Serviço de Lead" — ver `checkup_2026-03-18_fase1_ct_menu_servico_lead.md`
2. **Fase 2**: Virtus — texto + menu nos 3 pontos; handler `lead_service:N`

| Arquivo | Fase | Alteração |
|---------|------|-----------|
| `convenientetecnologia/public/menu.html` | 1 | novo card "Serviço de Lead" |
| `convenientetecnologia/index.js` | 1 | rota + API |
| `convenientetecnologia/lib/ctDb.js` | 1 | nova tabela ct_lead_service_requests |
| `convenientetecnologia/public/servico-lead.html` | 1 | nova página |
| `convenientetecnologia/public/servico-lead.js` | 1 | nova UI |
| `whatsapp/lib/flow.js` | 2 | 3 pontos de envio (texto+menu); handler `lead_service:N` |
| `whatsapp/lib/timeouts.js` | 2 | trocar text por list (nos 3 pontos) |
| `whatsapp/lib/whatsappApi.js` | — | já tem buildListPayload — sem mudança |

**Regra**: NÃO centralizar getFinalText. Cada arquivo mantém sua lógica; mudança mínima.

---

## 7. Riscos e mitigações

| Risco | Mitigação |
|-------|------------|
| Regressão no texto atual | Fase 1 não toca Virtus; Fase 2 altera só onde envia (trocar payload) |
| Cliente recebe 2 msgs (texto + menu) | WhatsApp permite; ou enviar tudo em 1 msg list (body com texto longo) |
| Limite de caracteres no body da list | WhatsApp: body até 1024 chars; ajustar texto se necessário |

---

## 8. Decisão / próximo passo

- **Fase 1 primeiro**: CT menu "Serviço de Lead" — dossiê em `checkup_2026-03-18_fase1_ct_menu_servico_lead.md`
- **Depois**: Virtus (texto + menu nos 3 pontos; handler)
- Texto final e 10 opções: conforme especificação do humano (confirmado)

---

## 9. Evidência de código (paths)

- `C:\sitechatbot\whatsapp\lib\flow.js` — getFinalText L748, handleConfirmCargo L3160, fasttrack L4434
- `C:\sitechatbot\whatsapp\lib\timeouts.js` — getFinalText L15, partial_timeout L599-612
- `C:\sitechatbot\whatsapp\lib\whatsappApi.js` — buildListPayload L72
- `C:\sitechatbot\convenientetecnologia\public\menu.html` — cards do menu
- `C:\sitechatbot\whatsapp\db\schema.sql` — wa_conversations
