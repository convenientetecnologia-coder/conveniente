# Fechamentos recorrentes com Virtus proxy — 23/11/2026

Evidência coletada nas sete Mães: `provision_audit` e histórico limitado de turnos por conta, correlacionados com eventos de operação do CT. Há fechamentos legítimos por conta terminal e crashes reais do Chrome; esses caminhos permanecem separados da recuperação de conexão.

Nas contas amostradas, `release_unconfirmed / control_requires_reconciliation` precedeu o evento `browser_disconnected`. O histórico mostra inclusive visitas com `checkConfirmed: true` antes de falhar a devolução da cadeira. No CT, desconexões `carrier_liveness_timeout` ocorreram nos instantes 1795483991 e 1795485197; esses registros provam a falha do canal, mas não identificam sozinhos a origem física ou de processo da indisponibilidade.

Antes, o turno bloqueado encerrava o Chrome em dois caminhos automáticos da sessão. A nova recuperação mantém o navegador offline e sem novas ações enquanto aguarda o estado terminal da operação exata no CT. Nunca libera capacidade por suposição, nunca confirma mensagem pelo simples fechamento do transporte e não reinicia ação anterior.

Uma ação local ainda pendente também impede retomada. Somente após seu término e prova de encerramento do transporte a sessão volta à fila. A próxima visita precisa verificar novamente a caixa de entrada: a recuperação não marca a página como pronta. Consultas usam espera progressiva até 30 segundos. Falhas de conta e processos mortos continuam com os tratamentos próprios.

Validação: testes de ACK perdido, prova terminal ausente/presente, ação local atrasada, preservação do navegador e fechamento explícito. Implantação solicitada: atualizar arquivos das sete Mães, sem reiniciar processos; nova versão entra no próximo início. Investigar separadamente a origem dos timeouts de liveness do executor/CT sem confundi-la com o descarte desnecessário do navegador.
