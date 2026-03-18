# Checkup — Fase 1: CT Menu "Serviço de Lead" (dossiê ponta a ponta)

**Data**: 2026-03-18  
**INC**: `docs/inbox/need_evidence/INC-20260318-1000-01.md`  
**Ordem**: Fase 1 — CT menu primeiro. Depois Virtus (texto + menu).  
**Regra**: Não mexer em flow.js/timeouts.js nesta fase. Zero risco de quebrar Virtus.  

---

## 1. Objetivo da Fase 1

Criar o menu "Serviço de Lead" no CT **antes** de alterar o Virtus. Assim:

1. O operador já tem onde ver os leads quando chegarem
2. Teste: humano pode inserir manualmente (ou via script) um registro e validar que aparece
3. Depois, no Virtus: quando cliente selecionar serviço, o fluxo grava na mesma tabela

---

## 2. Auditoria ponta a ponta (o que criar)

### 2.1 Card no menu (menu.html)

**Padrão existente** (ex.: Site, Contestação):

```html
<a class="ctMenuCard" href="/convenientetecnologia/servico-lead">
  <div class="ctMenuCardIcon">📋</div>
  <div class="ctMenuCardTitle">Serviço de Lead</div>
  <div class="muted">Leads de serviços pós-frete: telefone, cidade e serviço escolhido</div>
</a>
```

**Arquivo**: `C:\sitechatbot\convenientetecnologia\public\menu.html`  
**Posição**: após Contestação (ou entre Site e Contestação, conforme preferência)  
**Risco**: zero — só adiciona um card, não altera nenhum existente  

---

### 2.2 Rota no CT (convenientetecnologia/index.js)

**Padrão existente** (ex.: L125-126):

```javascript
router.get("/site", ctAuth.requireAuthPage, (req, res) => sendFile(res, "site.html"));
```

**Adicionar**:

```javascript
router.get("/servico-lead", ctAuth.requireAuthPage, (req, res) => sendFile(res, "servico-lead.html"));
```

**Arquivo**: `C:\sitechatbot\convenientetecnologia\index.js`  
**Risco**: zero — nova rota, não altera nenhuma existente  

---

### 2.3 Tabela no banco (ctDb.js)

**Schema**:

```sql
CREATE TABLE IF NOT EXISTS ct_lead_service_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  phone_digits TEXT NOT NULL,
  city_uf TEXT,
  service_id INTEGER NOT NULL,
  service_label TEXT,
  conversation_id INTEGER,
  created_at INTEGER NOT NULL,
  status TEXT DEFAULT 'novo',
  updated_at INTEGER,
  notes TEXT
);
CREATE INDEX IF NOT EXISTS idx_lead_service_phone ON ct_lead_service_requests(phone_digits);
CREATE INDEX IF NOT EXISTS idx_lead_service_status ON ct_lead_service_requests(status);
CREATE INDEX IF NOT EXISTS idx_lead_service_created ON ct_lead_service_requests(created_at DESC);
```

**Onde**: `ctDb.js` — dentro do bloco de migrações (após `ct_lead_contestation_events` ou em nova função `migrateLeadServiceRequests`)  
**Risco**: baixo — CREATE TABLE IF NOT EXISTS é idempotente; não altera tabelas existentes  

---

### 2.4 Página HTML (servico-lead.html)

**Padrão**: seguir `site.html` — estrutura mínima com ctMenuWrap, título, área de lista.

```html
<!DOCTYPE html>
<html lang="pt-br">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>Conveniente Tecnologia — Serviço de Lead</title>
  <link rel="stylesheet" href="/convenientetecnologia/ct.css" />
  <link rel="stylesheet" href="/ct_chat_panel.css" />
  <link rel="stylesheet" href="/ct_unified.css" />
</head>
<body>
  <main class="ctMenuWrap" id="ctServicoLeadRoot">
    <div class="ctAuthCard" style="max-width:1100px; margin: 0 auto;">
      <div class="ctTitle">📋 Serviço de Lead</div>
      <div class="muted" style="margin-top:6px">Leads de serviços pós-frete: telefone, cidade e serviço escolhido pelo cliente.</div>
      <div id="ctServicoLeadMsg" class="ctMsg" style="margin-top:10px"></div>
      <div id="ctServicoLeadList" style="margin-top:12px"></div>
    </div>
  </main>
  <script src="/ct_unified.js" defer></script>
  <script src="/convenientetecnologia/servico-lead.js" defer></script>
  <script src="/ct_chat_panel.js" defer></script>
</body>
</html>
```

**Arquivo**: `C:\sitechatbot\convenientetecnologia\public\servico-lead.html` (novo)  

---

### 2.5 API e JS (servico-lead.js)

**API** (em convenientetecnologia/index.js):

```javascript
router.get("/api/lead_service/list", ctAuth.requireAuthApi, (req, res) => {
  try {
    const db = ctDb.getDB();
    const status = String(req.query.status || "").trim() || null;
    const limit = Math.min(500, Math.max(1, parseInt(req.query.limit || "100", 10) || 100));
    let sql = `SELECT id, phone_digits, city_uf, service_id, service_label, created_at, status, notes
               FROM ct_lead_service_requests ORDER BY created_at DESC LIMIT ?`;
    const params = [limit];
    if (status) {
      sql = `SELECT id, phone_digits, city_uf, service_id, service_label, created_at, status, notes
             FROM ct_lead_service_requests WHERE status=? ORDER BY created_at DESC LIMIT ?`;
      params.unshift(status);
    }
    const rows = db.prepare(sql).all(...params);
    return res.json({ ok: true, items: rows });
  } catch (e) {
    return res.status(500).json({ ok: false, error: (e && e.message) || String(e) });
  }
});
```

**JS** (servico-lead.js): fetch da API, renderizar tabela (telefone, cidade, serviço, data, status).  
**Arquivo**: `C:\sitechatbot\convenientetecnologia\public\servico-lead.js` (novo)  

---

## 3. Mapa de arquivos (Fase 1)

| Arquivo | Ação | Risco |
|---------|------|-------|
| `convenientetecnologia/public/menu.html` | Adicionar 1 card | Zero |
| `convenientetecnologia/index.js` | Adicionar 1 rota GET + 1 API GET | Zero |
| `convenientetecnologia/lib/ctDb.js` | Adicionar migração (CREATE TABLE) | Baixo |
| `convenientetecnologia/public/servico-lead.html` | Criar (novo) | Zero |
| `convenientetecnologia/public/servico-lead.js` | Criar (novo) | Zero |

**Nenhum arquivo do Virtus** (flow.js, timeouts.js) é tocado nesta fase.

---

## 4. Mapa dos 10 serviços (canônico, para título/descrição)

| service_id | title | description |
|------------|-------|-------------|
| 1 | 📶 Internet residencial | Ativar internet rápida na sua nova casa |
| 2 | 🛠️ Montador de móveis | Montagem rápida e profissional |
| 3 | 🧹 Limpeza pós-mudança | Deixe tudo limpo e organizado |
| 4 | ❄️ Instalação de ar-condicionado | Instalação com técnico especializado |
| 5 | 🐜 Dedetização | Elimine pragas da sua nova casa |
| 6 | 📺 TV por assinatura | Planos com canais e streaming |
| 7 | 🔒 Segurança residencial | Câmeras e alarmes para sua casa |
| 8 | 🏠 Seguro residencial | Proteja seu imóvel e seus bens |
| 9 | 🚗 Seguro de veículo | Proteja seu carro com ótimos planos |
| 10 | ☀️ Energia solar | Economize na conta de luz |

---

## 5. Validação pós-Fase 1

1. Reiniciar `sitechatbot` (`node index.js`)
2. Acessar CT → menu → clicar em "Serviço de Lead"
3. Página carrega (lista vazia ou com dados de teste)
4. Inserir 1 registro manualmente (via script ou SQL) e confirmar que aparece

---

## 6. Rollback (se necessário)

- Reverter commits dos 5 arquivos
- Tabela `ct_lead_service_requests` pode ficar (não quebra nada) ou dropar manualmente

---

## 7. O que NÃO fazer nesta fase

- **Não** mexer em `flow.js`
- **Não** mexer em `timeouts.js`
- **Não** centralizar `getFinalText` (desnecessário e risco de regressão)
- **Não** criar handler `lead_service:N` no Virtus (isso é Fase 2)
