### Host registry (CANÔNICO) — apelidos ↔ hostId

Objetivo: permitir que o GPT encontre rapidamente o `hostId` quando o humano falar “robe mae 2”, “server X”, etc.

Observações:
- `hostId` pode mudar se o servidor for reinstalado/limpo (porque nasce em `C:\conveniente\dados\.telemetry_hostid`).
- Este arquivo não tem segredos; é só mapeamento humano ↔ técnico.

---

## Tabela de mapeamento

| apelido (humano) | hostId (UUID) | hostname (se souber) | papel | notas |
|---|---|---|---|---|
| MARKSON S/ LOGIN-BAN | 7b84aa10-f8a8-47f9-b908-c8e16b74e989 | DESKTOP-R7OV935 | conveniente | categoria=VENDAS |
| ROBE MÃE 1 | 084c8fff-c508-47bd-a33e-3ab34aeb1e3d | DESKTOP-QK1AU5L | conveniente | categoria=FRETES |
| ROBE MÃE 2 | bcf01e8d-82da-4d5d-aed0-d60305d4696d | DESKTOP-P9CR5S0 | conveniente | categoria=FRETES |
| ROBE MÃE 3 | 5d7c3309-8581-4a50-a421-e6cbb52d8070 | DESKTOP-IR7JRIM | conveniente | categoria=FRETES |
| ROBE MÃE 4 | 825a4485-1465-4c11-aa18-52f0597b23a3 | DESKTOP-SKUV1H4 | conveniente | categoria=FRETES |
| ROBE MÃE 5 | 1b0f6f98-46bf-40c6-a0f9-dad6e1965c22 | DESKTOP-8EQRO4C | conveniente | categoria=FRETES |
| ROBE MÃE 6 | aba80611-8b8a-46ed-a852-f5f0d573c03b | DESKTOP-9OULHH9 | conveniente | categoria=FRETES |
| ROBE MÃE 7 | 29546e77-083e-4c81-b90f-4402499d0fef | DESKTOP-V44RTAO | conveniente | categoria=MOVEIS |

---

## Como obter o hostId (humano)

- No próprio host do `conveniente`: arquivo `C:\conveniente\dados\.telemetry_hostid`

