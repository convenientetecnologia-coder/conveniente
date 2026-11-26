# Recuperação manual de autenticação

O botão Cookies e Login mantém a rota configure existente. O operador
`admin_configure:` identifica a solicitação manual no worker; stock_provision e
as tentativas automáticas mantêm seus limites atuais.

A solicitação explícita abre uma nova rodada limitada a três submissões de senha.
Preserva o contador anterior, os metadados do fluxo anterior e o resultado anterior
do cadastro; emite `manual_auth_recovery_begin`. Não redefine ban, captcha,
identidade, código, suspensão de Marketplace ou outras restrições persistentes.

Usa prepareCadastroBrowser e o mesmo configure do cadastro: aguarda cadeira,
abre o navegador se necessário, tenta cookies e depois credenciais quando cabível,
incluindo Continuar e a etapa opcional Ignorar. Falhas técnicas continuam sendo
adiadas; rejeições explícitas e restrições mantêm sua classificação.

Somente após a verificação existente de identidade/autenticação/Messages, salvar
cookies e fechar a sessão de cadastro, o desired fica ativo com Virtus ligado.
Isso libera a conta para abertura pela fila normal; não declara que um navegador
fechado já está online. Resposta inclui authenticationVerified e workQueued.

Não altera cooldown de postagem nem aplica pausa de conta nova a conta recuperada.
O navegador de trabalho usa a configuração própria de Virtus. A alteração requer
recarregar os workers e a página do painel, sem reiniciar o Index.

31 testes cobrem a rodada manual, preservação dos dados, restrições, resultado
pendente, fechamento sem confirmação, ordenação de liberação, fluxo do configure,
acesso a navegador fechado e aquisição/devolução da cadeira de cadastro.
O teste real deve começar na Mãe 4.
