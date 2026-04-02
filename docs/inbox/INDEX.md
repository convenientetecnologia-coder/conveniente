### INBOX — arquivo de relatos (índice)

Regra: `C:\conveniente\docs\INBOX_RELATOS_DO_HUMANO.md` é a **entrada** (RAW_INPUT + triagem).
Depois de triado, cada incidente ganha um arquivo próprio em uma pasta por status:

- `C:\conveniente\docs\inbox\in_progress\` (em andamento / WIP)
- `C:\conveniente\docs\inbox\need_evidence\` (aguardando próxima rodada de evidência/decisão; não é WIP ativo)
- `C:\conveniente\docs\inbox\done\` (concluído)
- `C:\conveniente\docs\inbox\cancelled\` (cancelado / não será feito)

Objetivo: manter um **banco de relatos** pesquisável, sem virar um “textão infinito” no arquivo de entrada.

Nota importante (para não confundir GPTs):
- não existe pasta separada `need_alignment/`; INCs com `state=need_alignment` ficam em `need_evidence/` até virarem `in_progress` ou mudarem para `done/cancelled`.

---

## Incidentes (índice)

Regra: o status â€œde verdadeâ€ vive aqui **e** no topo do arquivo do INC.
Modelo â€œmÃ©dicoâ€: `state=done` nÃ£o exige restart/teste; isso vai em `rollout/validation`.

| id | P | state | rollout | validation | tÃ­tulo | arquivo |
|---|---|---|---|---|---|---|
| INC-20260402-0900-01 | P0 | done | deployed | passed | RM5: Robe postagem falha “sem foto” apesar de pool grande (~1700) | `done/INC-20260402-0900-01.md` |
| INC-20260318-1000-01 | P0 | need_evidence | not_deployed | not_run | Serviço de Lead: menu 10 serviços pós-frete + CT "Serviço de Lead" | `need_evidence/INC-20260318-1000-01.md` |
| INC-20260312-1000-01 | P0 | in_progress | not_deployed | not_run | Projeto `afiliadozap`: ingestão WhatsApp + geração de links afiliados + redistribuição controlada | `in_progress/INC-20260312-1000-01.md` |
| INC-20260306-1143-01 | P0 | done | needs_restart | not_run | Reemissão de boleto aumentou após remover leads (forense) | `need_evidence/INC-20260306-1143-01.md` |
| INC-20260306-1100-01 | P0 | done | needs_restart | not_run | Baixa Asaas não aplicada para motorista pago (forense) | `need_evidence/INC-20260306-1100-01.md` |
| INC-20260305-1815-02 | P0 | need_evidence | waiting_observation | partial | ngrok/CT intermitente + travamentos recentes (investigação forense) | `in_progress/INC-20260305-1815-02.md` |
| INC-20260305-1815-01 | P0 | need_evidence | not_deployed | not_run | Blindagem total do navegador (UAFP/fingerprint/geo/rede) | `need_evidence/INC-20260305-1815-01.md` |
| INC-20260305-1445-01 | P0 | in_progress | deployed_partial | passed | CT/ngrok intermitente (503/8012/3004) afetando dashboard e self_update | `in_progress/INC-20260305-1445-01.md` |
| INC-20260305-1445-02 | P1 | need_evidence | not_deployed | not_run | Suspeita de latência alta no Virtus/WhatsApp API | `need_evidence/INC-20260305-1445-02.md` |
| INC-20260305-0900-01 | P0 | in_progress | deployed_partial | passed_partial | Conveniente: migração Chrome.exe -> Chromium (sessão persistente + perfil visível) | `in_progress/INC-20260305-0900-01.md` |
| INC-20260305-0900-02 | P0 | done | deployed | passed | Conveniente: backup completo baseline (Chrome) antes de migração/PR | `done/INC-20260305-0900-02.md` |
| INC-20260302-1500-01 | P1 | done | deployed_monitoring | pass_for_core | Sorteio justo: contestação estorna dinheiro mas mantém “carga” no ranking até pagamento | `done/INC-20260302-1500-01.md` |
| INC-20260219-0900-01 | P0 | in_progress | pilot_next | pass_for_core | Programa novo modelo de leads (sorteio + cobrança por uso) | `in_progress/INC-20260219-0900-01.md` |
| INC-20260219-0910-01 | P0 | done | pilot_ready | pass | Webhook dual + distribuição anônima com link tokenizado | `done/INC-20260219-0910-01.md` |
| INC-20260219-0920-01 | P0 | done | pilot_ready | pass | Sorteio 3 minutos (menor consumo + desempate por chegada) | `done/INC-20260219-0920-01.md` |
| INC-20260219-0930-01 | P0 | done | pilot_ready | pass | Banco do motorista (ledger de leads, débitos e ajustes) | `done/INC-20260219-0930-01.md` |
| INC-20260219-0940-01 | P0 | done | pilot_ready | pass | Cobrança Asaas diária (seg-sex 08:00), baixa automática e bloqueio às 15:00 | `done/INC-20260219-0940-01.md` |
| INC-20260219-0950-01 | P1 | need_alignment | not_deployed | not_run | Atendimento no WhatsApp (financeiro/administrativo) integrado ao CT | `need_evidence/INC-20260219-0950-01.md` |
| INC-20260219-1000-01 | P0 | done | pilot_enabled_by_city | pass | Rollout controlado por grupos (piloto em 5 grupos, sem quebrar legado) | `done/INC-20260219-1000-01.md` |
| INC-20260219-1010-01 | P0 | done | pilot_ready | pass | Plano de testes E2E/simulações antes do Go-Live | `done/INC-20260219-1010-01.md` |
| INC-20260219-1020-01 | P0 | accepted_risk_by_owner | manual_step_required | waived | Segurança operacional: segredo exposto em conversa e rotação obrigatória | `done/INC-20260219-1020-01.md` |
| INC-20260220-2230-01 | P0 | done | deployed_monitoring | pass_for_core | Backup completo de `sitechatbot` e `notificador` no Drive privado (dossie + plano DR) | `done/INC-20260220-2230-01.md` |
| INC-20260222-2230-01 | P0 | need_alignment | not_deployed | not_run | Qualificacao de tamanho de frete antes do sorteio tokenized | `need_evidence/INC-20260222-2230-01.md` |
| INC-20260222-2310-01 | P0 | done | deployed_monitoring | pass_for_core | Contestacao de lead tokenized (devolucao ao grupo + estorno com anti-abuso) | `done/INC-20260222-2310-01.md` |
| INC-20260224-0005-01 | P0 | done | deployed_monitoring | pass_for_billing_hardening | Monitoracao runtime blindado (sitechatbot + notificador) em producao controlada | `done/INC-20260224-0005-01.md` |
| INC-20260224-1600-01 | P0 | done | not_deployed | audited_data_ready | Auditoria de 200 pedidos para nova politica de preco por porte/incompleto | `done/INC-20260224-1600-01.md` |
| INC-20260225-1400-01 | P0 | done | deployed_monitoring | pass_for_core | Programa de cobranca profissional (boleto/Asaas/reconciliacao/alertas/contingencia) | `done/INC-20260225-1400-01.md` |
| INC-20260226-1500-01 | P0 | need_alignment | not_deployed | not_run | CT: Menu "Contestacao" (olhos de Deus) — metricas avancadas (ciclo, valor, reabertura, abuso) | `need_evidence/INC-20260226-1500-01.md` |
| INC-20260227-0100-01 | P0 | done | deployed_monitoring | pass_for_core | Asaas sem notificações ao pagador (garantia inteligente por cliente, sem reconciliação burra) | `done/INC-20260227-0100-01.md` |
| INC-20260202-2000-01 | P0 | done | deployed | passed | CT: Fonte Ãšnica da Verdade (Virtusâ†’Grupos / Contas FB v2 / SimulaÃ§Ãµes) | `done/INC-20260202-2000-01.md` |
| INC-20260204-0110-01 | P2 | done | deployed | passed | CT Chat: "Mais usados" no picker do composer | `done/INC-20260204-0110-01.md` |
| INC-20260204-0100-01 | P0 | done | deployed | passed | CT Chat: mensagens misturadas entre salas | `done/INC-20260204-0100-01.md` |
| INC-20260204-0120-01 | P2 | done | deployed | passed | CT Chat: "Ver mais" indent na 1a linha | `done/INC-20260204-0120-01.md` |
| INC-20260204-0130-01 | P1 | cancelled | not_deployed | not_run | CT UI: layout quebra com zoom (encerrado por decisao do humano) | `cancelled/INC-20260204-0130-01.md` |
| INC-20260204-0140-01 | P1 | done | not_applicable | passed | CT Chat: mensagens demoram a chegar (latencia fim-a-fim) | `done/INC-20260204-0140-01.md` |
| INC-20260204-0141-01 | P2 | done | deployed | passed | CT Chat: ao abrir, ir para a mensagem mais antiga nao lida | `done/INC-20260204-0141-01.md` |
| INC-20260204-0142-01 | P1 | done | deployed | passed | CT Aprovados: notificação (novos) por usuário + som dedicado | `done/INC-20260204-0142-01.md` |
| INC-20260204-0143-01 | P1 | done | deployed | passed | CT Aprovados: latência realtime (badge/som) após "Enviar p/ financeiro" | `done/INC-20260204-0143-01.md` |
| INC-20260204-0144-01 | P1 | done | deployed | passed | CT Removidos: remover coluna “Motivo” e centralizar histórico no cadastro | `done/INC-20260204-0144-01.md` |
| INC-20260203-2580-01 | P2 | done | deployed | passed | CT Chat: composer nao sobrepor texto | `done/INC-20260203-2580-01.md` |
| INC-20260203-2570-01 | P2 | done | deployed | passed | CT Chat: pack de emojis padrao | `done/INC-20260203-2570-01.md` |
| INC-20260203-2560-01 | P2 | done | deployed | passed | CT Chat: layout do composer (input full + botoes dentro) | `done/INC-20260203-2560-01.md` |
| INC-20260203-2550-01 | P1 | done | deployed | passed | CT Chat: historico/paginacao (carregar antigas ao subir) | `done/INC-20260203-2550-01.md` |
| INC-20260202-1600-01 | P0 | done | deployed | passed | Cidades/Grupos: contrato canÃ´nico + prioridade provisÃ£o (estoqueâ†’servidor) + migraÃ§Ã£o manual | `done/INC-20260202-1600-01.md` |
| INC-20260207-1403-01 | P0 | done | deployed | passed | RM3: pós stock_provision, Virtus OFF em massa / volta parcial; fixes de resume e provisão | `done/INC-20260207-1403-01.md` |
| INC-20260212-0240-01 | P0 | done | deployed | passed | RM2: restore de perfis via backup (merge seguro + dry-run + apply atômico) | `done/INC-20260212-0240-01.md` |
| INC-20260212-0315-01 | P0 | cancelled | not_deployed | not_run | RM2: “wipe”/sobrescrita de perfis (perfis.json caiu de ~100 para 7) — investigação forense (superseded) | `cancelled/INC-20260212-0315-01.md` |
| INC-20260213-1200-01 | P0 | cancelled | not_deployed | not_run | RM6: “wipe”/apagamento de perfis (perfis.json) — investigação forense (superseded) | `cancelled/INC-20260213-1200-01.md` |
| INC-20260212-0605-01 | P0 | done | operational_fix | passed | RM1: auditoria CT vs servidor (alinhamento + teste de exclusão manual) | `done/INC-20260212-0605-01.md` |
| INC-20260212-0610-01 | P0 | done | deployed | passed | RM2: auditoria CT vs servidor (mesmo playbook do RM1) | `done/INC-20260212-0610-01.md` |
| INC-20260212-0615-01 | P0 | done | deployed | passed | RM3: auditoria CT vs servidor (mesmo playbook do RM1) | `done/INC-20260212-0615-01.md` |
| INC-20260212-0620-01 | P0 | done | operational_fix | passed | RM4: auditoria CT vs servidor (mesmo playbook do RM1) | `done/INC-20260212-0620-01.md` |
| INC-20260212-0625-01 | P0 | done | operational_fix | passed | RM5: auditoria CT vs servidor (mesmo playbook do RM1) | `done/INC-20260212-0625-01.md` |
| INC-20260212-0630-01 | P0 | done | operational_fix | passed | RM6: auditoria CT vs servidor (mesmo playbook do RM1) | `done/INC-20260212-0630-01.md` |
| INC-20260212-0635-01 | P0 | done | operational_fix | passed | RM7: auditoria CT vs servidor (mesmo playbook do RM1) | `done/INC-20260212-0635-01.md` |
| INC-20260214-0900-01 | P0 | done | deployed | passed | PROGRAMA UNICO P0: cadastro sem duplicação (CT estoque -> servidor -> CT em uso) | `done/INC-20260214-0900-01.md` |
| INC-20260214-1020-01 | P0 | done | deployed_rm1_controlled | passed_rm1_e2e | BLINDAGEM FINAL P0: hardening anti-regressão (perfis/ACK/estado) | `done/INC-20260214-1020-01.md` |
| INC-20260214-0910-01 | P0 | cancelled | not_deployed | not_run | Fundido no INC-20260214-0900-01 (canal/ACK virou bloco do programa único) | `cancelled/INC-20260214-0910-01.md` |
| INC-20260214-0920-01 | P0 | cancelled | not_deployed | not_run | Fundido no INC-20260214-0900-01 (invariantes anti-duplicação viraram bloco do programa único) | `cancelled/INC-20260214-0920-01.md` |
| INC-20260214-0930-01 | P0 | cancelled | not_deployed | not_run | Fase 2: anti-wipe amplo (fora do escopo do GO de cadastro sem duplicação) | `cancelled/INC-20260214-0930-01.md` |
| INC-20260214-0940-01 | P0 | cancelled | not_deployed | not_run | Fase 2: delete E2E retry-safe (fora do escopo do GO de cadastro sem duplicação) | `cancelled/INC-20260214-0940-01.md` |
| INC-20260214-0950-01 | P1 | cancelled | not_deployed | not_run | Fase 2: registry secundário detalhado (fora do escopo do GO de cadastro sem duplicação) | `cancelled/INC-20260214-0950-01.md` |
| INC-20260214-1000-01 | P1 | cancelled | not_deployed | not_run | Fase 2: observabilidade completa (fora do escopo do GO de cadastro sem duplicação) | `cancelled/INC-20260214-1000-01.md` |
| INC-20260214-1010-01 | P1 | cancelled | not_deployed | not_run | Fase 2: recovery/backup/restore amplo (fora do escopo do GO de cadastro sem duplicação) | `cancelled/INC-20260214-1010-01.md` |
| INC-20260215-1100-01 | P0 | need_evidence | deployed_partial | monitoring | RM1: Robe postar (Marketplace) — tela preta residual e confiabilidade de retentativa | `need_evidence/INC-20260215-1100-01.md` |
| INC-20260203-1800-01 | P0 | done | deployed_rm3_controlled | passed_operational | RM3: `loginRequired=probe_failed` com navegador aparentemente OK (Virtus derrubado por falso positivo) | `done/INC-20260203-1800-01.md` |
| INC-20260216-1600-01 | P0 | need_evidence | deployed_monitoring | monitoring | RM3: queda progressiva de RAM após boot (~11GB -> ~2GB) e entrada em modo defensivo | `need_evidence/INC-20260216-1600-01.md` |
| INC-20260216-1930-01 | P0 | need_evidence | not_deployed | not_run | RM4: loop Robe login_required x Messenger saudável (flag sobe/desce e Robe não converge) | `need_evidence/INC-20260216-1930-01.md` |
| INC-20260217-1450-01 | P0 | done | deployed_rm6_controlled | passed_operational | RM6: about:blank + loginRequired inconsistente com Messenger saudável (Virtus Offline indevido) | `done/INC-20260217-1450-01.md` |
| INC-20260203-2100-01 | P0 | done | deployed | passed | CT Sistema Interno: Resumo divergente (KPI usa ct_drivers, abas usam ct_driver_memberships) | `done/INC-20260203-2100-01.md` |
| INC-20260203-2230-01 | P1 | done | deployed | passed | CT Sistema Interno: WhatsApp verde + menu (abrir/copiar) + registro â€œChamou no zapâ€ (Testes Encerrados + Chamar depois + Cadastro + ParticipaÃ§Ã£o) | `done/INC-20260203-2230-01.md` |
| INC-20260203-2400-01 | P1 | done | deployed | passed | CT Chat: composer auto-grow (ate 8 linhas) + Ver mais em mensagens grandes | `done/INC-20260203-2400-01.md` |
| INC-20260203-2500-01 | P1 | done | deployed | passed | CT Chat: editar mensagem (menu ...) | `done/INC-20260203-2500-01.md` |
| INC-20260203-2510-01 | P2 | done | deployed | passed | CT Chat: links clicaveis | `done/INC-20260203-2510-01.md` |
| INC-20260203-2520-01 | P1 | done | deployed | passed | CT Chat: quebrar texto grande (sem scroll lateral) | `done/INC-20260203-2520-01.md` |
| INC-20260203-2530-01 | P1 | done | deployed | passed | CT Chat: reenviar mensagem falhada | `done/INC-20260203-2530-01.md` |
| INC-20260203-2540-01 | P2 | done | deployed | passed | CT Chat: cores por usuario | `done/INC-20260203-2540-01.md` |
| INC-20260201-0300-01 | P0 | done | deployed_partial | passed | P0: total>ativos (browsers fechados) apesar de RAM; sistema deve manter tudo aberto | `done/INC-20260201-0300-01.md` |
| INC-20260201-0200-01 | P0 | cancelled | not_deployed | not_run | Forense RAM: RM4/RM5/RM6 (capacidade mÃ¡xima), autoMode light/full e thresholds | `cancelled/INC-20260201-0200-01.md` |
| INC-20260201-0100-01 | P1 | done | needs_restart | not_run | CT/Servidores: contadores â€œLogin/Cookies falhouâ€ + â€œRecurso em anÃ¡liseâ€ + ordenaÃ§Ã£o OFFLINE primeiro | `done/INC-20260201-0100-01.md` |
| INC-20260201-0000-01 | P1 | done | deployed | passed | Groq config: garantir auto-download + auto-correÃ§Ã£o de modelo em TODOS os hosts apÃ³s update/restart | `done/INC-20260201-0000-01.md` |
| INC-20260131-0000-01 | P1 | done | deployed | passed | Captcha/Identidade: pre-screen â€œConfirme que vocÃª Ã© humanoâ€ + OCR Groq + identity/appeal handoff | `done/INC-20260131-0000-01.md` |
| INC-20260130-0905-01 | P0 | cancelled | not_deployed | not_run | CT marca RM3 OFFLINE mas host estÃ¡ acessÃ­vel (Servidores + Estoque) | `cancelled/INC-20260130-0905-01.md` |
| INC-20260130-1521-01 | P0 | done | manual_step_required | not_run | CT/Servidores mostra â€œDesconhecidoâ€ e precisa virar fonte de verdade operacional (flags + estados acionÃ¡veis) | `done/INC-20260130-1521-01.md` |
| INC-20260130-1544-01 | P0 | done | deployed | passed | RM3: â€œtrabalhando 0â€ no CT (urgente) | `done/INC-20260130-1544-01.md` |
| INC-20260130-2015-02 | P2 | done | deployed | passed | Abrir Todos deveria zerar flags para reavaliar estado real | `done/INC-20260130-2015-02.md` |
| INC-20260130-2015-03 | P2 | done | deployed | passed | HUD humano some ao navegar e demora a reaparecer | `done/INC-20260130-2015-03.md` |
| INC-20260130-2235-04 | P1 | done | deployed | passed | â€œConfirme que vocÃª Ã© humanoâ€ precisa auto-click | `done/INC-20260130-2235-04.md` |
| INC-20260130-0128-01 | P0 | done | deployed | passed | Abrir Todos nÃ£o iniciava com 0 browsers (nurseTick early-return) | `done/INC-20260130-0128-01.md` |
| INC-20260130-0001-01 | P0 | done | not_deployed | not_run | Abrir Todos: 2Âº clique dava open_all_lock_busy (lock idempotÃªncia) | `done/INC-20260130-0001-01.md` |
| INC-20260129-2100-01 | P1 | done | deployed_partial | not_run | Estoque: â€œreserved mas nÃ£o vaiâ€ (provision / stock_provision) | `done/INC-20260129-2100-01.md` |
| INC-20260129-2058-02 | P0 | done | needs_restart | not_run | Fechar Todos: reabre durante fechamento; lento; sobra navegador | `done/INC-20260129-2058-02.md` |
| INC-20260129-2058-03 | P1 | done | needs_restart | not_run | Abrir Todos 24h: concorrÃªncia/medo de clicar; auto-open no boot | `done/INC-20260129-2058-03.md` |
| INC-20260129-2058-04 | P1 | done | needs_restart | not_run | GovernanÃ§a: controle de concorrÃªncia (login_required/identity/open/ram) | `done/INC-20260129-2058-04.md` |
| INC-20260129-2340-01 | P1 | done | needs_restart | not_run | Abrir Todos: fica preso em 26/28; sem progresso; nÃ£o libera Robe/Virtus | `done/INC-20260129-2340-01.md` |
| INC-20260130-0005-01 | P1 | done | needs_restart | not_run | Invocar Humano: botÃµes no HUD (fechar/pause24h/excluir) + garantir isolamento do navegador humano | `done/INC-20260130-0005-01.md` |
| INC-20260130-0023-01 | P0 | done | needs_restart | not_run | RM3: estoque liberou conta, mas cadastro/provision falhou | `done/INC-20260130-0023-01.md` |
| INC-20260130-0047-01 | P1 | done | not_applicable | not_applicable | RM4: entender â€œmodo leve/fullâ€ (slowmode) â€” regras/motivos/mecanismos/impactos | `done/INC-20260130-0047-01.md` |
| INC-20260130-0103-01 | P0 | done | needs_restart | not_run | CT estoque/servidores â€œliberarâ€ solta cooldown do Robe em massa + RM3 nÃ£o cadastra | `done/INC-20260130-0103-01.md` |
| INC-20260130-0148-01 | P1 | done | needs_restart | not_run | Governor light/full: thresholds (RAM/lag), nÃ£o pausar Robe, recuperaÃ§Ã£o leve | `done/INC-20260130-0148-01.md` |
| INC-20260130-0205-01 | P0 | done | needs_restart | not_run | Governor light/full: janelas 5min/30min, sem fechar 1 navegador, hard reset total | `done/INC-20260130-0205-01.md` |
| INC-20260130-0227-01 | P0 | done | needs_restart | not_run | Crash no boot: `Illegal break statement` em `robeTickGlobal` | `done/INC-20260130-0227-01.md` |
| INC-20260130-0219-01 | P0 | done | deployed_partial | not_run | Governor light/full: somente RAM + snapshot 1/min por 48h | `done/INC-20260130-0219-01.md` |

