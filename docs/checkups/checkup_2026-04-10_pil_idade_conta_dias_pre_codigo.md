# Checkup — PIL "idade da conta" (dias) no dashboard (pré-código)

Data: `2026-04-10`  
INC: `docs/inbox/need_evidence/INC-20260410-2110-01.md`  
Escopo: auditoria ponta a ponta, sem codar runtime.

## 1) Onde o PIL é montado hoje

O render dos pills da conta ocorre no frontend:

- `public/index.html`
  - helpers de pills (`buildPill`, `buildCooldownPill`, `buildRobeDailyPlanPills`, etc);
  - montagem por conta em `buildList(...)`, dentro do `filtered.forEach(...)`.

Conclusão: o novo pill "Idade: N dias" é naturalmente uma adição nesta camada.

## 2) Como os dados chegam ao frontend

O frontend combina duas fontes:

1. `safeListPerfis()` (`/api/perfis`) — baseline de perfil;
2. `safeGetStatus()` (`/api/status`) — overlay de estado dinâmico.

No merge atual (`public/index.html`):

- baseline via `Object.assign(defaults, p)` (preserva campos vindos de `p`);
- overlay de status sobrescreve campos equivalentes por `nome`.

Conclusão: para idade no PIL, podemos usar campo vindo de `/api/perfis` ou `/api/status` (ou ambos), desde que seja estável.

## 3) Fonte de "data de cadastro" existente hoje (real)

### 3.1 Modelo de perfil criado no runtime

Em `scripts/worker.js`, no `criar-perfil`:

- `perfilObj` inclui `nome`, `cidade`, `ua*`, `cookies`, `robeCooldownUntil`, `configuredAt`, `userDataDir`;
- **não há campo explícito canônico de `createdAt` de perfil** nesse objeto.

### 3.2 Evidência de idade já usada operacionalmente

Existe dossiê já gerado com idade de contas:

- `docs/contas_ativas_por_idade_2026-04-10.md`

A lista indica cálculo baseado no sufixo timestamp do `nome` (padrão `cidade-<epoch_ms>`), exemplo:

- `sorocaba-1758251084942`
- `cuiaba-1773398704237`

Conclusão: hoje a idade prática já é inferida do slug/timestamp no nome, não de campo persistido dedicado.

## 4) Risco/limitação da fonte atual

- **Pró:** disponível já, sem migração de massa.
- **Contra:** depende do padrão de nome conter epoch no final; se houver perfil legado/futuro fora desse padrão, idade fica ausente/incerta.

## 5) Estratégia pré-código recomendada (enterprise)

Fase A (baixo risco, imediata):

1. Computar idade em dias no frontend a partir de `p.nome` (quando casar `-(\\d{13})$`).
2. Exibir pill: `Idade: <N> dia(s)` (preferência visual: plural simplificado opcional).
3. Se não houver timestamp válido:
   - mostrar `Idade: —` (ou ocultar pill), sem quebrar layout.

Fase B (canônica, robusta):

1. Persistir `profileCreatedAt` no `perfilObj` no momento da criação.
2. Expor esse campo em `/api/status` para UI/relatórios.
3. Manter fallback de parsing do nome somente para legado.

## 6) Pontos de patch previstos (quando liberar código)

1. `scripts/worker.js`
   - incluir `profileCreatedAt` em `perfilObj` no `criar-perfil`.
2. `public/index.html`
   - helper `buildAccountAgePill(p)` + inserção na `titleRow`.
3. `scripts/api_status.js` / `scripts/clusterMaster.js` (se necessário)
   - garantir passagem do novo campo em agregação de status.
4. documentação
   - `TIMELINE.md`, runbook e INC.

## 7) Critério de aceite (canário)

- Em uma conta recém-criada: `Idade: 0 dias`.
- Em conta de ontem: `Idade: 1 dia`.
- Em conta antiga: valor coerente com dossiê histórico.
- Nenhuma regressão em render de PIL ou filtros do dashboard.

## 8) Conclusão

A demanda é viável com baixo risco.  
Para entrega rápida, o parsing do timestamp do nome resolve o objetivo imediato; para padrão ultra enterprise, o ideal é consolidar `profileCreatedAt` persistido e manter fallback legado.
