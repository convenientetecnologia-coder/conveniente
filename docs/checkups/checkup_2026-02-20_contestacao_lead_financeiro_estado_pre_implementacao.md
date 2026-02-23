# CHECKUP — Contestacao de lead (financeiro/estado) pre-implementacao

- data: 2026-02-20
- escopo: `INC-20260222-2310-01`
- status: pre_implementation_design_locked

---

## Objetivo

Congelar regras sem ambiguidade antes de codar:
- estorno total somente do lead contestado;
- devolucao ao grupo quando valido;
- bloqueio de reentrada no mesmo lead;
- idempotencia e atomicidade por `lead_token`.

---

## Regras fechadas (owner)

1) Estorno financeiro:
- total, integral, e apenas do `lead_token` contestado e aprovado.

2) Devolucao ao grupo:
- apenas se o lead ainda for tecnicamente valido.

3) Reentrada:
- motorista contestante nao pode participar novamente do mesmo `lead_token`.

4) Janela:
- contestacao em ate 6 horas apos entrega do contato.

5) Permissao CT:
- qualquer usuario autenticado pode decidir analise manual.

6) SLA manual:
- sem expurgo por tempo; item fica na fila ate resolucao.

---

## Invariantes tecnicos obrigatorios

1) Chave de consistencia: `lead_token`.

2) Unicidade financeira por lead:
- maximo 1 debito (`lead_award`) por lead valido;
- maximo 1 estorno de contestacao aprovada por lead.

3) Vinculacao financeira:
- estorno deve referenciar o debito original do mesmo `lead_token`.

4) Idempotencia:
- retries nao podem gerar novo estorno.

5) Atomicidade:
- decisao + estorno + mudanca de estado do lead em semantica all-or-nothing por lead.

---

## Plano de auditoria ponta-a-ponta

### A) Pre-codificacao (design audit)
- [x] regras funcionais documentadas no INC;
- [x] limites e anti-abuso definidos;
- [x] permissoes/SLA manual definidos;
- [x] invariantes financeiros definidos.

### B) Pos-codificacao (runtime audit)
- [ ] teste de aprovacao automatica gera 1 estorno total do mesmo lead;
- [ ] teste de retry nao duplica estorno;
- [ ] teste de falha intermediaria nao deixa estado parcial;
- [ ] teste de devolucao ao grupo respeita validade;
- [ ] teste de reentrada bloqueia contestante no mesmo lead;
- [ ] trilha de auditoria completa visivel no CT.

---

## Evidencia exigida na validacao

- query de reconciliacao por `lead_token` (debito x estorno x estado final);
- logs com `requestId` e ator da decisao;
- amostra real de 3 cenarios:
  - aprovado automatico,
  - manual aprovado,
  - rejeitado/bloqueado.

---

## Resultado esperado

Implementacao sem achismo, com consistencia financeira por lead, sem perdas, sem duplicidade e sem regressao operacional.

