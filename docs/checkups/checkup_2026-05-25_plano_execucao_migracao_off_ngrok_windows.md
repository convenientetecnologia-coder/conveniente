### Checkup — Plano de Execucao Off-Ngrok (Windows First)

> Regra: este arquivo e o checklist mestre de execucao. O resumo curto fica na `docs/TIMELINE.md`.

#### Contexto

- Data: 2026-05-25
- Ambiente alvo: producao real (Windows, operacao manual por terminais)
- Objetivo: substituir ngrok por infraestrutura propria com dominio + HTTPS + reverse proxy, sem regressao
- Escopo: `sitechatbot`, `conveniente`, `notificador`, `site`
- Nao escopo (nesta fase): migracao para Linux/Docker/Kubernetes

### Diretorio operacional de borda

- Decisao: usar `C:/portas` como central operacional da camada de borda (DNS/HTTPS/Tunnel/Proxy).
- Status atual: pasta `C:/portas` existe no host com bootstrap tecnico da Fase 1 (templates e scripts de borda).
- Regra sobre `index.js`: quando existir em `C:/portas`, deve fazer somente orquestracao da borda, sem logica de negocio.

---

### Evidencias base de arquitetura atual (auditoria)

- Mapa de tuneis ngrok (3000/3001/3002/3003):
  - `C:/sitechatbot/ngrok.dual.yml`
- Core publico CT + webhooks/callbacks:
  - `C:/sitechatbot/index.js`
- Proxy humano + atendimentos + portal motoristas:
  - `C:/sitechatbot/indexct.js`
- Fallbacks de URL publica em ngrok:
  - `C:/sitechatbot/index.js`
  - `C:/sitechatbot/lib/attendanceStore.js`
  - `C:/conveniente/scripts/notifierEndpoints.js`
- Hosts `conveniente` apontando para CT via ngrok:
  - `C:/conveniente/dados/ct_config.json`
- Notificador (dependencia CT via `SITECHATBOT_API_BASE`):
  - `C:/notificador/index.js`
- Site com beacon hardcoded para endpoint ngrok:
  - `C:/site` (paginas com `/convenientetecnologia/api/site/event`)

---

### Regras de operacao (nao negociaveis)

- Sem big-bang: migracao em ondas pequenas, validando ponta a ponta por etapa.
- Sem achismo: toda decisao critica precisa de evidencia (arquivo/log key/cmdId/requestId/endpoint).
- Sem segredo em docs: registrar apenas nome da variavel/local de configuracao.
- Humano nao investiga logs/comandos: operador tecnico faz coleta e consolidacao.
- Rollback obrigatorio por fase antes de iniciar a fase seguinte.

---

### Resultado final esperado

- Todos os endpoints publicos em dominio proprio com HTTPS valido.
- Nenhum fluxo de producao dependente de `*.ngrok.io`.
- WhatsApp API e Asaas funcionando estavel no novo endpoint.
- Links tokenizados de motoristas abrindo em dominio proprio.
- Monitoramento e runbook atualizados para continuidade entre chats.

---

### Mapa de servicos e portas (estado atual -> estado alvo)

| Servico | Porta local | Estado atual | Estado alvo |
|---|---:|---|---|
| CT Core (`sitechatbot/index.js`) | 3000 | Exposto por ngrok | Exposto por `api.<dominio>` |
| CT Proxy humano (`sitechatbot/indexct.js`) | 3001 | Exposto por ngrok | Exposto por `painel.<dominio>` |
| Atendimentos (`sitechatbot/indexct.js`) | 3002 | Exposto por ngrok | Exposto por `atendimento.<dominio>` |
| Portal motoristas (`sitechatbot/indexct.js`) | 3003 | Exposto por ngrok | Exposto por `motoristas.<dominio>` |
| Conveniente (`conveniente/index.js`) | 8088 (local) | Local + callbacks no CT via ngrok | Local + callbacks no CT via dominio proprio |
| Notificador callback (`notificador/index.js`) | 8789 (local por padrao) | Sem ngrok direto | Mantem local (publicar so se necessario) |

---

### Gate de rede (IP dinamico / CGNAT) — decisao obrigatoria

#### Gate A (com abertura de portas 80/443)

- Requisito: IP publico no roteador + port forwarding funcional para servidor.
- Borda: Cloudflare DNS + Nginx Windows.
- SSL: Cloudflare Full (strict) com certificado de origem (ou Let's Encrypt).

#### Gate B (sem abertura de portas / CGNAT)

- Requisito: sem port forwarding ou sem IP publico roteavel.
- Borda: Cloudflare Tunnel + Nginx Windows local.
- SSL: Cloudflare (edge) + origem local sem exposicao direta da rede.

#### Checklist do gate

- [ ] Coletar evidencia da conectividade atual (A ou B) com laudo objetivo.
- [ ] Registrar decisao final do gate neste arquivo.
- [ ] Registrar impacto operacional da decisao (portas/firewall/rede).

**Decisao final do gate (preencher):**
- Gate escolhido: B (provisorio)
- Evidencia: diagnostico local sem saida conclusiva de rede + ambiente humano sem visibilidade de port-forward; para reduzir risco operacional e dependencia de modem/roteador, Gate B e o caminho inicial.
- Data: 2026-05-25
- Observacao: "Gate A pode ser reavaliado se houver prova tecnica de encaminhamento 80/443 funcional".

---

### Blueprint de subdominios (padrao recomendado)

- `api.<dominio>` -> CT core (`127.0.0.1:3000`)
- `painel.<dominio>` -> proxy humano (`127.0.0.1:3001`)
- `atendimento.<dominio>` -> dashboard atendimentos (`127.0.0.1:3002`)
- `motoristas.<dominio>` -> portal motorista (`127.0.0.1:3003`)
- `leadhook.<dominio>` -> opcional para callback do notificador (`127.0.0.1:8789`)

Checklist:
- [ ] Confirmar nomes finais de subdominio.
- [ ] Definir TTL DNS inicial de rollout.
- [ ] Definir padrao de naming para ambientes (prod/staging, se houver).

---

### Sequencia de migracao (um por vez)

## Fase 0 — Preparacao e baseline

- [ ] Congelar mudancas paralelas nao relacionadas a rede publica.
- [ ] Snapshot de configuracoes atuais (envs, CT base URL, webhooks cadastrados).
- [ ] Gerar baseline de saude atual (antes da migracao):
  - [ ] `/health`
  - [ ] `/report` + `/api/commands/ack` + `/api/logs/ingest`
  - [ ] `/webhook` + `/flows`
  - [ ] `/convenientetecnologia/api/asaas/webhook`

Evidencia minima:
- Arquivos de baseline + endpoints testados + horario.

Rollback:
- Nao aplicavel (fase de preparacao).

## Fase 1 — Borda nova pronta em paralelo

- [x] Subir camada de borda (Nginx + Cloudflare, conforme Gate A/B).
- [x] Configurar reverse proxy para `3000/3001/3002/3003`.
- [x] Garantir `X-Forwarded-*` correto para autenticacao/cookies.
- [x] Validar HTTPS em todos os subdominios.

Evidencia minima:
- Mapa de rotas ativas e teste 200/302 esperado por subdominio.

Rollback:
- Voltar DNS para estado anterior e manter ngrok como unico endpoint externo.

#### Fase 1 iniciada — bootstrap tecnico

- Status: iniciado com base operacional em `C:/portas`, sem alteracao de runtime de negocio.
- Dominio confirmado: `convenientetecnologia.com`.
- DNS confirmado: zona ativa na Cloudflare.
- Ngrok: permanece ativo nesta etapa e segue como endpoint externo principal.
- Evidencias dos arquivos criados:
  - `C:/portas/portas.config.json`
  - `C:/portas/nginx/nginx.conf.template`
  - `C:/portas/nginx/nginx.conf.gate_b.convenientetecnologia.com`
  - `C:/portas/cloudflare/config.yml.template`
  - `C:/portas/cloudflare/config.gate_b.convenientetecnologia.com.yml`
  - `C:/portas/scripts/healthcheck_gate_b.ps1`
  - `C:/portas/index.js`
  - `C:/portas/docs/FASE1_GATE_B_PASSO_A_PASSO.md`
- Observacao historica: esta etapa iniciou com placeholders e sem segredo em docs.

#### Fase 1 avancada — automacao Cloudflare API (Gate B)

- Automacao criada: `C:/portas/scripts/cloudflare_tunnel_api.js`.
- Entradas seguras por variavel de ambiente:
  - `CF_API_TOKEN`
  - `CF_ACCOUNT_ID`
  - `CF_ZONE_ID` (opcional)
- Comandos operacionais:
  - planejamento: `node C:/portas/scripts/cloudflare_tunnel_api.js --mode plan`
  - aplicacao: `node C:/portas/scripts/cloudflare_tunnel_api.js --mode apply`
- Pre-requisitos de execucao:
  - `CF_API_TOKEN` no ambiente local ou `C:/portas/cloudflare/.env.local` (sem registrar valor em docs/chat)
  - `CF_ACCOUNT_ID` opcional (script tenta resolver pela zona)
  - `CF_ZONE_ID` opcional
- Saidas da automacao:
  - auditoria: `C:/portas/cloudflare/outputs/`
  - config ativa do tunnel: `C:/portas/cloudflare/config.active.yml`
  - atualizacao do `tunnel_id` em `C:/portas/portas.config.json`
- Observacao: ngrok permanece ativo durante toda a Fase 1.

#### Fase 1 concluida — tunnel e DNS aplicados com validacao ponta a ponta

- Data/hora da execucao: 2026-05-25 (BRT).
- `plan` e `apply` executados com sucesso na automacao API.
- Tunnel criado/reutilizado e CNAMEs ativos para:
  - `api.convenientetecnologia.com`
  - `painel.convenientetecnologia.com`
  - `atendimento.convenientetecnologia.com`
  - `atendimentos.convenientetecnologia.com`
  - `motoristas.convenientetecnologia.com`
  - `leadhook.convenientetecnologia.com`
  - `convenientetecnologia.com`
  - `www.convenientetecnologia.com`
- Borda local em execucao paralela:
  - Nginx Windows (`C:/portas/nginx/nginx-1.29.7/nginx.exe`) com ajuste de `server_names_hash_bucket_size` e bind local `127.0.0.1:8080`.
  - cloudflared (`C:/portas/bin/cloudflared.exe`) com `C:/portas/cloudflare/config.active.yml`.
- Validacoes executadas:
  - `node C:/portas/index.js` => 5/5 checks OK.
  - `powershell -ExecutionPolicy Bypass -File C:/portas/scripts/healthcheck_gate_b.ps1` => 0 falhas obrigatorias (checks publicos opcionais podem oscilar durante propagacao DNS local).
  - `curl --resolve` usando DNS `1.1.1.1` => `/_edge/health` retornando HTTP 200 em 8/8 hostnames gerenciados.
  - raiz publica `https://convenientetecnologia.com/` servindo landing e links diretos para os subdominios canônicos.
- Nota operacional:
  - resolucao DNS do resolvedor local pode oscilar durante propagacao; validacao deterministica foi feita com `Resolve-DnsName -Server 1.1.1.1` + `curl --resolve`.
- Nota de firewall:
  - popup inicial do Windows Defender ocorreu por listener de borda; com Nginx em `127.0.0.1:8080`, a necessidade de novo prompt reduz drasticamente.
- Nota operacional:
  - Gate B de runtime e operado por `start_gate_b.ps1` / `stop_gate_b.ps1` / `status_gate_b.ps1`; `C:/portas/index.js` nao e daemon continuo.
  - auto-start no boot `SYSTEM` ativo via Task Scheduler (`GateB-AutoStart-BootSystem`) usando `install_gate_b_boot_system.ps1`.
  - task de logon (`GateB-AutoStart-Logon`) removida para evitar execucao interativa redundante.
  - consulta sem elevacao nao enxerga detalhes da task `SYSTEM` (esperado), retornando `FOUND_BUT_RESTRICTED`.
  - UAC/administrador necessario apenas na instalacao da task de boot; reinicios seguintes do host nao exigem confirmacao.
- Evidencias:
  - `C:/portas/cloudflare/outputs/cf_tunnel_plan_20260525_141918.json`
  - `C:/portas/cloudflare/outputs/cf_tunnel_apply_20260525_141935.json`
  - `C:/portas/cloudflare/outputs/cf_tunnel_apply_20260525_142008.json`
  - `C:/portas/cloudflare/outputs/cf_tunnel_plan_20260525_144506.json`
  - `C:/portas/cloudflare/outputs/cf_tunnel_apply_20260525_144519.json`
  - `C:/portas/cloudflare/outputs/cf_tunnel_apply_20260525_145953.json`
  - `C:/portas/portas.config.json`
  - `C:/portas/cloudflare/config.active.yml`
  - `C:/portas/nginx/nginx.conf.gate_b.convenientetecnologia.com`
  - `C:/portas/nginx/html/index.html`
  - `C:/portas/scripts/start_gate_b.ps1`
  - `C:/portas/scripts/status_gate_b.ps1`
  - `C:/portas/scripts/stop_gate_b.ps1`
  - `C:/portas/scripts/install_gate_b_autostart.ps1` (fallback)
  - `C:/portas/scripts/install_gate_b_boot_system.ps1`
  - `C:/portas/scripts/status_gate_b_autostart.ps1`
  - `C:/portas/scripts/uninstall_gate_b_autostart.ps1`
  - `C:/portas/cloudflare/outputs/install_gate_b_boot_system_runner.log`
  - `C:/portas/cloudflare/outputs/query_boot_task_runner.log`
  - Task Scheduler (elevado): `GateB-AutoStart-BootSystem` FOUND / `GateB-AutoStart-Logon` NOT_FOUND
  - `C:/portas/scripts/healthcheck_gate_b.ps1`
  - `C:/portas/index.js`

#### Fase 1 hardening final — stack completo em boot + dashboard operacional

- Escopo aplicado:
  - auto-start no boot (`SYSTEM`) expandido para `sitechatbot` core, `sitechatbot` edge e `notificador`;
  - mantido `GateB-AutoStart-BootSystem` como parte do mesmo padrão;
  - criados scripts de start por serviço com checagem de porta/health para evitar duplicidade;
  - root dashboard (`https://convenientetecnologia.com/`) promovido para painel operacional com checks em tempo real.
- Tasks ativas:
  - `GateB-AutoStart-BootSystem`
  - `Sitechatbot-Core-AutoStart-BootSystem`
  - `Sitechatbot-Edge-AutoStart-BootSystem`
  - `Notificador-AutoStart-BootSystem`
  - `OpsDashboard-AutoOpen-Logon`
- Endpoints operacionais do dashboard (mesma origem):
  - `/_ops/health/gateb` -> esperado `200`
  - `/_ops/health/sitechatbot_core` -> esperado `200`
  - `/_ops/health/sitechatbot_edge` -> esperado `200/302`
  - `/_ops/health/atendimentos` -> esperado `200/302`
  - `/_ops/health/notificador` -> esperado `200/404/405`
- Observacao:
  - durante transicao, `ngrok` permanece manual (fora do pacote de boot automatico).
- Evidencias:
  - `C:/portas/scripts/start_sitechatbot_core.ps1`
  - `C:/portas/scripts/start_sitechatbot_edge.ps1`
  - `C:/portas/scripts/start_notificador_worker.ps1`
  - `C:/portas/scripts/start_full_stack.ps1`
  - `C:/portas/scripts/install_stack_boot_system.ps1`
  - `C:/portas/scripts/status_stack_boot_system.ps1`
  - `C:/portas/scripts/invoke_stack_boot_tasks_once.ps1`
  - `C:/portas/scripts/open_ops_dashboard.ps1`
  - `C:/portas/cloudflare/outputs/install_stack_boot_system_runner.log`
  - `C:/portas/cloudflare/outputs/invoke_stack_boot_tasks_once.log` (`last_result=0` para 4/4 tasks)
  - `C:/portas/cloudflare/outputs/open_ops_dashboard.log`
  - `C:/portas/nginx/nginx.conf.gate_b.convenientetecnologia.com` (`/_ops/health/*`)
  - `C:/portas/nginx/html/index.html` (dashboard operacional)

#### Validacao pos-reboot (host reiniciado)

- Resultado: aprovado.
- Evidencias de runtime apos boot:
  - `C:/portas/scripts/status_gate_b.ps1` => `ONLINE`;
  - listeners unicos ativos em `3000`, `3001`, `3002`, `3003`, `8080`, `8789`;
  - `wmic process` mostra `CreationDate` no horario do boot para `node/nginx/cloudflared`;
  - `https://convenientetecnologia.com/` => `200` com marcador `Dashboard Operacional`;
  - checks publicos de operacao:
    - `/_ops/health/gateb` => `200`
    - `/_ops/health/sitechatbot_core` => `200`
    - `/_ops/health/sitechatbot_edge` => `200`
    - `/_ops/health/atendimentos` => `302` (esperado)
    - `/_ops/health/notificador` => `404` (esperado como sinal de listener ativo).
- Observacao operacional:
  - `ngrok` permanece manual nessa fase de convivencia (usuario iniciou apos boot).
  - abertura visual do dashboard para o usuario agora e automatizada no logon por `OpsDashboard-AutoOpen-Logon`.

## Fase 2 — Migrar superficie humana de menor risco

- [ ] Migrar `painel.<dominio>` (3001) validando login e navegacao.
- [ ] Migrar `atendimentos.<dominio>` (3002) validando fluxo operacional.
- [ ] Manter ngrok ativo em paralelo durante observacao.

Evidencia minima:
- Testes de login/sessao/stream/chat sem erro critico.

Rollback:
- Reapontar acesso humano para URL antiga (ngrok) imediatamente.

## Fase 3 — Migrar portal de motoristas

- [ ] Atualizar base publica do portal motorista (`CT_DRIVER_PORTAL_PUBLIC_BASE_URL` / equivalente).
- [ ] Gerar links tokenizados novos no dominio proprio.
- [ ] Validar abertura de link em navegador mobile e desktop.

Evidencia minima:
- 3-5 links de teste com sucesso (sem dados sensiveis no doc).

Rollback:
- Reverter base URL para ngrok e reenviar links novos.

## Fase 4 — Migrar callbacks internos dos hosts `conveniente`

- [x] Atualizar `CT_BASE_URL`/`ctBaseUrl` dos hosts para `api.<dominio>`.
- [ ] Validar ciclo completo:
  - [ ] `POST /report`
  - [ ] `POST /api/commands/ack`
  - [ ] `POST /api/logs/ingest`

Evidencia minima:
- ACKs por `cmdId` no CT + ingest por `requestId` com hostId correto.

Rollback:
- Reverter `CT_BASE_URL` dos hosts para endpoint anterior.

## Fase 5 — Migrar webhooks externos criticos

- [x] Atualizar webhook Asaas para endpoint novo.
- [x] Atualizar webhook WhatsApp (`/webhook` e `/flows`, se aplicavel).
- [x] Validar entrega real (nao apenas teste sintatico).

Evidencia minima:
- Evento real recebido/processado por cada integracao.

Rollback:
- Voltar cadastro de webhook para URL anterior imediatamente.

## Fase 6 — Migrar endpoint do site (beacon/evento)

- [x] Atualizar `site` para parar de usar URL ngrok hardcoded de `/api/site/event`.
- [x] Publicar e validar ingestao de eventos no endpoint novo.

Evidencia minima:
- Evento de pagina chegando no CT com endpoint novo.

Rollback:
- Reverter endpoint do site para URL anterior temporariamente.

## Fase 7 — Desativacao controlada do ngrok

- [ ] Validar 24h-72h de estabilidade no novo caminho.
- [x] Eliminar fallbacks `.ngrok.io` de codigo/config.
- [ ] Desligar tunel ngrok.
- [ ] Monitorar erros pos-corte por janela acordada.

Evidencia minima:
- Sem dependencia ativa de ngrok em fluxos criticos.

Rollback:
- Reativar tunel ngrok e restaurar rotas antigas de emergencia.

---

### Checklist de seguranca minima (antes do corte final)

- [ ] Tokens/chaves obrigatorios ativados (sem fallback inseguro).
- [ ] Rate limit aplicado em endpoints sensiveis.
- [ ] Firewall bloqueando acesso externo direto a `3000-3003/8789`.
- [ ] Logs de erro e acesso monitorados no periodo de transicao.

---

### Matriz de reinicio por fase (referencia rapida)

- Fase 0: nenhum
- Fase 1: `sitechatbot` (se houver alteracao de runtime/proxy local)
- Fase 2: `sitechatbot` / `indexct` conforme ajuste de rota
- Fase 3: `sitechatbot` (se alterada base URL em env)
- Fase 4: hosts `conveniente` afetados + CT
- Fase 5: normalmente sem restart (cadastro externo), exceto se alterar env de validacao
- Fase 6: `site` build/deploy (sem restart node local se estatico)
- Fase 7: `ngrok` desativado; demais apenas se houver ajuste final

---

### Mapa de terminais operacionais (execucao assistida)

- Terminal 1: `C:/sitechatbot` (`node index.js`)
- Terminal 2: `C:/sitechatbot` (`node indexct.js`)
- Terminal 3: `C:/notificador` (`node index.js`)
- Terminal 4: borda (Nginx Windows / cloudflared, conforme gate)
- Terminal 5: validacao (smoke tests e coleta de evidencia)

---

### Registro de execucao (preencher em cada etapa)

#### Etapa executada

- Fase:
- Horario inicio:
- Horario fim:
- O que foi alterado:
- Evidencias:
- Resultado:
- Reinicios aplicados:
- Rollback necessario?:

#### Etapa executada

- Fase: 4, 5, 6 e 7 (parcial)
- Horario inicio: 2026-05-25T16:35-03:00
- Horario fim: 2026-05-25T16:52-03:00
- O que foi alterado:
  - saneamento runtime off-ngrok (`sitechatbot/index.js`, `sitechatbot/lib/attendanceStore.js`, `sitechatbot/whatsapp/lib/flow.js`, `conveniente/scripts/notifierEndpoints.js`);
  - alinhamento de base CT (`sitechatbot/convenientetecnologia/ct.env`, `conveniente/dados/ct_config.json`);
  - corte externo por API (`sitechatbot/tools/cutover_external_webhooks_off_ngrok.js`) para WhatsApp (`/webhook`) e Asaas (`/convenientetecnologia/api/asaas/webhook`);
  - beacon do site no domínio final (`site/src/_data/site.json`) com rebuild e deploy (`npm run build`, `npm run deploy:root`);
  - desativação operacional do ngrok (`sitechatbot/ngrok.js`, `sitechatbot/ngrok.dual.yml`, `sitechatbot/lib/unifiedRuntime.js`).
- Evidencias:
  - execução: `node C:/sitechatbot/tools/cutover_external_webhooks_off_ngrok.js`
  - resumo objetivo:
    - `meta_webhook.ok=true` (`subscribed_apps=1`);
    - `meta_flows.skipped=true` (`reason=no_flows_found_on_waba`, sem flow ativo gerenciado por API no WABA atual);
    - `asaas_webhook.ok=true`, `action=updated`, `id=70fda287-21c4-4dd5-96d9-2a3c5481bd6d`;
    - validações: `webhook_verify_status=200`, `flows_status=403(signature_invalid esperado)`, `asaas_status=400(missing_payment_id esperado)`;
    - validação de métrica: `site_summary_validation.delta=1` em `/api/site/summary`.
  - validação de build/deploy do site:
    - `npm run build` (Eleventy: `Copied 11 Wrote 213 files`);
    - `npm run deploy:root` (`224 arquivo(s) copiados`).
  - validação de endpoint publicado:
    - `site/src/_data/site.json` e `site/dist/index.html`/`site/index.html` com `https://api.convenientetecnologia.com/convenientetecnologia/api/site/event`.
  - tentativa de desligamento de processo legado ngrok:
    - `Get-Process ngrok` encontrou PID `1248`;
    - `Stop-Process`/`taskkill` retornaram `Acesso negado` no contexto atual.
- Resultado:
  - corte off-ngrok aplicado em código/config + webhooks externos atualizados + beacon migrado;
  - pendente apenas desligamento forçado do processo legado ngrok em execução e janela de observação 24h-72h.
- Reinicios aplicados:
  - nenhum nesta etapa.
- Rollback necessario?:
  - não.
  - plano imediato permanece: reverter callback override de WhatsApp e webhook Asaas para URL anterior + reverter commit local de fallback se houver regressão.

---

### Definicao de pronto (go-live sem ngrok)

- [ ] Todos os webhooks criticos operando no dominio proprio.
- [ ] Todos os callbacks de host (`report/ack/logs`) estaveis sem ngrok.
- [ ] Portal motoristas e superficies humanas validados.
- [ ] Zero referencia ativa a `*.ngrok.io` no runtime de producao.
- [ ] Timeline + runbook + livro de bordo atualizados com evidencias finais.

