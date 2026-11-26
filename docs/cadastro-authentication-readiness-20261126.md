# Cadastro: conexão, sessão e acesso manual

O cadastro não pode transformar falta de conexão, navegação interrompida ou página ainda carregando em recusa de cookies ou senha.

## Cookies

Uma marca histórica `sessionRejected` não pula mais a aplicação dos cookies salvos. A sessão só é declarada não restaurada após três aplicações e navegações com cadeira saudável e tela de login reconhecida. Cada navegação e espera de renderização admite até 180 segundos, respeitando a validade real da cadeira. Uma tela de login provisória tem carência de 30 segundos; um login autenticado reconhecido pode encerrar antes. Carregamento sem conclusão, HTTP de erro, perda da cadeira e navegação falha retornam resultado técnico, sem declarar cookies recusados.

Os eventos distinguem tentativa, aplicação dos cookies, sessão restaurada e três telas de login confirmadas. Cookies ausentes não equivalem a três recusas.

## Credenciais

O limite persistente passa a três envios reais por conta. Tentativas anteriores não são apagadas. O cadastro repete apenas rejeições explícitas de senha/dados; não repete automaticamente um envio de resultado incerto dentro da mesma execução. Falhas anteriores ao envio devolvem o débito da tentativa. O sucesso mantém a rotina existente de confirmação e gravação dos cookies atualizados, limpando a indicação de cookies recusados.

O resumo combinado de cookies e dados rejeitados exige três verificações de cookies e três rejeições explícitas de credenciais registradas. Um contador antigo de tentativas, isolado, não constitui prova de três rejeições. Restrições da conta permanecem distintas.

## Contas retidas e inspeção

Abertura manual de uma conta com cadastro bloqueado segue para inspeção humana. Abrir Todos e automações continuam bloqueados até cadastro confirmado. Invocar Humano pode abrir um navegador fechado; no proxy, a navegação inicial aguarda a cadeira humana, com painel local e guarda de transporte. Invocação sobre navegador já aberto não força nova navegação.

Configure e login_remediate passam a respeitar o worker proprietário do navegador no roteamento por células. As rotas manuais retomam células paradas. A espera HTTP de abertura por proxy é compatível com a fila, em vez de expirar em um minuto enquanto o comando continua rodando.

Configure manual pode reabrir um bloqueio comum de login para recuperação técnica, preservando o resultado anterior. Falhas técnicas novas após uma recuperação antiga podem ser recolocadas na fila uma vez por evidência, sem zerar o número de envios de senha. Restrições terminais e modo humano são preservados.

## Validação e implantação

72 testes de cadastro, cookies, recuperação, acesso manual, roteamento e transporte passaram. Outros 12 testes de seletores de credenciais, identidade e abertura manual passaram na mesma revisão. Esses testes incluem cenários sintéticos e navegador local de teste; não constituem login real confirmado nas duas contas de produção.

Há alterações no Index (`api_perfis` e `clusterMaster`) e nos workers. Uma atualização apenas dos workers não carrega a revisão completa. Validar primeiro na Mãe 4 com Index e workers recarregados; não declarar Lenon ou Leo autenticados antes da evidência real.
