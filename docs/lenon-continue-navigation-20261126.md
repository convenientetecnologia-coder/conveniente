# Lenon: transição após Continuar

Mãe 4, perfil `cascavel-1795257963540`.

Registros da tentativa:
- 1795697237847: superfície `aymh_continue` após as tentativas de cookies.
- 1795697237862: início da tentativa de credencial.
- 1795697240852: exceção `Execution context was destroyed, most likely because of a navigation.`
- 1795697241161: cadastro adiado por erro técnico.
- 1795697241280: navegador desconectado.
- 1795697241447: pedido de devolução da cadeira.

Isso prova que o fluxo abortou por exceção de navegação, antes da devolução da
cadeira; não prova rejeição de senha nem falha real de cookies. Não há evidência
de senha submetida nessa tentativa. A ordem dos registros também não sustenta
que a devolução da cadeira tenha causado a exceção.

O probe do formulário propagava erro de contexto destruído durante a navegação.
Agora repete apenas a leitura quando encontra esse erro transitório, aguardando
a mesma etapa por até 180 segundos (limitados pelo prazo da cadeira). O clique
em Continuar abre uma janela nova de espera para a senha. Não repete o clique,
não solicita outra cadeira e não toca no DOM enquanto a autoridade está incerta.
A etapa aparece como `Login: carregando após continuar`.

18 testes passaram: transição com três erros de contexto e montagem atrasada da
senha, ausência de senha sem submissão, formulário completo, senha isolada,
ausência de cadeira, reembolso de tentativa sem submissão e classificação de
erros técnicos. O teste da transição usa Chrome real com falhas de contexto
injetadas para reproduzir a exceção de forma determinística. A autenticação real
de Lenon ainda precisa ser confirmada no piloto.
