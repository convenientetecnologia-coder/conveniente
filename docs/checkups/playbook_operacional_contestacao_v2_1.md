# PLAYBOOK OPERACIONAL - Contestacao V2.1 (1 pagina)

- status: canônico para operação diária
- base: `INC-20260222-2310-01` + `checkup_2026-02-20_contestacao_v2_dossie_ponta_a_ponta_pre_codigo.md`
- objetivo: reduzir erro humano, evitar abuso, proteger cliente e motorista

---

## Regra mestra

Para motivo **M1 (cliente nao respondeu)**:
- nunca encerrar antes de 23h;
- estorno so fecha se:
  - cliente confirmar que nao quer mais, ou
  - 23h sem resposta e sem avancos validos.

---

## Motivos oficiais (menu fechado)

1. M1 - Cliente nao respondeu  
2. M2 - Cliente informou que ja contratou outro  
3. M3 - Cliente desistiu apos contato  
4. M4 - Informacoes do pedido divergentes do informado

---

## Cadencia operacional (resumo)

### T+15 min (motorista)
Pergunta:
- "Conseguiu falar com o contato ({PHONE})?"

Opcoes:
- "Sim, falei com o contato"
- "Ainda nao respondeu"
- "Tive outro problema com este atendimento"

### T+3h (cliente - Virtus) [M1/M2/M3]
Pergunta:
- "Voce ainda quer o frete?"

Opcoes:
- "Sim, ainda quero"
- "Nao, nao preciso mais"

### T+3h ate T+23h
- no maximo 1 lembrete adicional ao cliente (sem spam);
- motorista pode atualizar status (respondeu / nao respondeu).

### T+23h (fechamento M1)
- confirmacao final com motorista (obrigatoria);
- confirmacao final com cliente (opcional recomendada);
- aplica regra financeira final.

---

## Decisao rapida por motivo

### M1 - Cliente nao respondeu
- antes de 23h: manter em acompanhamento (sem estorno final).
- cliente respondeu "nao quero": aprovar estorno.
- cliente respondeu "sim quero": manter atendimento ativo.
- sem resposta ate 23h + sem avancos: aprovar estorno.

### M2 - Ja contratou outro
- validar com cliente;
- confirmado: encerra + estorno;
- nao confirmado: segue atendimento/reabertura controlada.

### M3 - Desistiu apos contato
- validar com cliente;
- confirmado: encerra + estorno;
- nao confirmado: segue atendimento/reabertura controlada.

### M4 - Divergente
- fila manual CT;
- decisao humana com auditoria obrigatoria.

---

## Reabertura no grupo (anti-guerra)

- maximo 1 reenvio automatico por atendimento;
- acima disso: fila manual;
- motorista contestante nao participa do ciclo reaberto automatico.

---

## Checklist de operação (rápido)

Antes de aprovar estorno:
- [ ] motivo correto selecionado;
- [ ] atendimento vinculado ao ID tecnico correto;
- [ ] tentativa/retorno conforme janela da regra;
- [ ] validacao cliente (quando aplicavel) registrada;
- [ ] decisao com `requestId` e `actor_user_id`.

Antes de reabrir grupo:
- [ ] ainda dentro de janela operacional;
- [ ] nao excedeu limite de 1 reenvio automatico;
- [ ] bloqueio de reentrada do contestante aplicado.

---

## Auditoria minima obrigatoria

Registrar sempre:
- `driver_id`
- `phone_digits` (referencia humana)
- `lead_token` (referencia tecnica)
- `motivo`
- `decisao`
- `actor_user_id`
- `requestId`
- `timestamp`

---

## Regras anti-erro tecnico

1) Cada clique deve carregar ID unico do atendimento (nao interpretar texto generico).  
2) Click repetido deve ser idempotente (nao duplicar acao financeira).  
3) Retry/falha parcial deve respeitar all-or-nothing nas transicoes criticas.

---

## Frase de governanca

"Sem regra congelada e sem trilha de auditoria, nao executa."

