### Host registry (CANÔNICO) — apelidos ↔ hostId

Objetivo: permitir que o GPT encontre rapidamente o `hostId` quando o humano falar “robe mae 2”, “server X”, etc.

Observações:
- `hostId` pode mudar se o servidor for reinstalado/limpo (porque nasce em `C:\conveniente\dados\.telemetry_hostid`).
- Este arquivo não tem segredos; é só mapeamento humano ↔ técnico.

---

## Tabela de mapeamento

| apelido (humano) | hostId (UUID) | hostname (se souber) | papel | notas |
|---|---|---|---|---|
| robe mae 2 | | | conveniente | |

---

## Como obter o hostId (humano)

- No próprio host do `conveniente`: arquivo `C:\conveniente\dados\.telemetry_hostid`

