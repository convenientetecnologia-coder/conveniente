# Checkup 2026-03-19 — Auditoria Tokenized WhatsApp: mensagens Financeiro e Administrativo

## Cabeçalho operacional

- **Precisa reiniciar?** não
- **Qual projeto?** sitechatbot (auditoria/documentação)
- **Como reiniciar (humano)?** N/A
- **Por quê?** Auditoria ponta a ponta — sem alteração de código

---

## Objetivo

Auditar de forma **enterprise** as mensagens que o sistema tokenized (WhatsApp API) envia ao motorista quando ele clica em **Falar financeiro** ou **Falar administrativo**, em todos os contextos (bloqueado, oi, boleto em aberto, sorteio).

---

## Resumo executivo

| Ação do motorista | Mensagem de resposta do sistema |
|-------------------|----------------------------------|
| **Clicar em "Falar financeiro"** | `🕒 Atendimento de segunda a sexta, das 10h às 17h.\n\nPara falar com o financeiro, entre em contato diretamente pelo WhatsApp abaixo:\n\n📞 (48) 99124-6818\n\nLink direto 📲 https://wa.link/mgwet0` |
| **Clicar em "Falar administrativo"** | `🕒 Atendimento de segunda a sexta, das 10h às 17h.\n\nPara falar com o administrativo (novo cadastro), entre em contato diretamente pelo WhatsApp abaixo:\n\n📞 (48) 99219-6621\n\nLink direto 📲 https://wa.link/lbp8lc` |

**Conclusão:** As mensagens são **únicas e canônicas** — o mesmo texto é enviado em todos os contextos (bloqueado, oi, menu boleto, sorteio).

---

## Contextos onde as opções aparecem

### 1. Motorista bloqueado — envia "oi"

- **Texto exibido:** "Perfeito, vamos te atender por aqui. Escolha o setor:" (se tem cadastro) ou "Perfeito, vamos te atender por aqui. Para começar, fale com o administrativo (novo cadastro)." (se não tem cadastro)
- **Botões:** "Falar financeiro" (id: `op:financeiro`), "Falar administrativo" (id: `op:administrativo`)
- **Evidência:** `flow.js` linhas 3935–3946, `buildSupportRoutingButtonsOutbox`

### 2. Motorista bloqueado por boleto — tenta entrar no sorteio

- **Texto exibido:** Mensagem de bloqueio + "Seu saldo da carteira está em ..." + resumo de boletos
- **Botões:** "Pagar no PIX", "Selecionar boleto", "Falar financeiro" (quando 1 boleto; `includeFinance: true`)
- **Menu lista (2+ boletos):** lista de boletos + opção "Falar com financeiro" (id: `boleto_select:financeiro`)
- **Evidência:** `flow.js` linhas 4057–4101, `buildPaymentActionButtonsOutbox`, `buildInvoiceSelectionListOutbox`

### 3. Motorista sem cadastro — tenta sorteio

- **Texto exibido:** "Você ainda não possui cadastro para participar do sorteio. Para começar, fale com o administrativo (novo cadastro)."
- **Botões:** apenas "Falar administrativo" (`includeFinance: false`)
- **Evidência:** `flow.js` linhas 3968–3978

### 4. Motorista com boleto — aviso de cobrança (issue notice)

- **Botões:** "Pagar no PIX", "Falar financeiro"
- **Evidência:** `convenientetecnologia/index.js` linhas 91–94

---

## Mapeamento de IDs → resposta

| ID do botão/listagem | Keyword extraído | Mensagem de resposta |
|----------------------|------------------|----------------------|
| `op:financeiro` | `financeiro` | 🕒 Atendimento de segunda a sexta... + WhatsApp (48) 99124-6818 + link wa.link/mgwet0 |
| `op:administrativo` | `administrativo` | 🕒 Atendimento... + WhatsApp (48) 99219-6621 + link wa.link/lbp8lc |
| `boleto_select:financeiro` | `financeiro` | (mesma mensagem acima) |

---

## Fluxo de dados

```
WhatsApp Cloud API (webhook)
  → metaParser / inbox
  → db.claimNextInbound (interactive_id = op:financeiro | op:administrativo | boleto_select:financeiro)
  → flow.handleInbound
  → extractOperationKeyword(text, interactive_id) → 'financeiro' | 'administrativo'
  → branch opKeyword === 'financeiro' | 'administrativo'
  → enqueueOutbox: buildTextPayload(phone, MENSAGEM_CANÔNICA)
  → outboxSender → WhatsApp API
```

---

## Evidência (arquivos e linhas)

| Arquivo | Linhas | Conteúdo |
|---------|--------|----------|
| `sitechatbot/whatsapp/lib/flow.js` | 133, 144–146 | `extractOperationKeyword`: mapeia `op:financeiro`, `boleto_select:financeiro`, `op:administrativo` |
| `sitechatbot/whatsapp/lib/flow.js` | 3903–3916 | Resposta **Financeiro** |
| `sitechatbot/whatsapp/lib/flow.js` | 3919–3932 | Resposta **Administrativo** |
| `sitechatbot/whatsapp/lib/flow.js` | 262–276 | `buildSupportRoutingButtonsOutbox`: botões Financeiro + Administrativo |
| `sitechatbot/whatsapp/lib/flow.js` | 226–229 | `buildInvoiceSelectionListOutbox`: opção "Falar com financeiro" na lista de boletos |
| `sitechatbot/convenientetecnologia/index.js` | 91–94 | Botões no aviso de cobrança (PIX + Financeiro) |

---

## Conclusão

**Sim, é só isso.** As mensagens enviadas ao clicar em Financeiro e Administrativo são **únicas e fixas** no código, sem variação por contexto. O sistema responde sempre com o mesmo texto em todos os cenários.

---

## Atualização 2026-03-19 — Nova mensagem Financeiro

Mensagem alterada para contato direto via WhatsApp:

```
🕒 Atendimento de segunda a sexta, das 10h às 17h.

Para falar com o financeiro, entre em contato diretamente pelo WhatsApp abaixo:

📞 (48) 99124-6818

Link direto 📲 https://wa.link/mgwet0
```

**Arquivos:** `sitechatbot/whatsapp/lib/flow.js` — Financeiro linhas 3909–3911; Administrativo linhas 3925–3927.

**Administrativo (atualização):**
```
🕒 Atendimento de segunda a sexta, das 10h às 17h.

Para falar com o administrativo (novo cadastro), entre em contato diretamente pelo WhatsApp abaixo:

📞 (48) 99219-6621

Link direto 📲 https://wa.link/lbp8lc
```
