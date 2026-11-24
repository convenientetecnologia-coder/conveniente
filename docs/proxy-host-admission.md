# Um pedido pendente por servidor

O Index mantém o coordenador do servidor em `scripts/carrierV2/indexCoordinator.js`, ligado ao canal existente das células em `clusterMaster.js`. Os workers registram tarefas; o Index escolhe a próxima, solicita a cadeira, mantém o cliente CT e entrega ao worker apenas o acesso local daquela operação. Navegadores não negociam cadeiras. O limite por arquivo preparado anteriormente foi substituído por essa fila no Index.

Há uma aquisição pendente no CT por servidor. Quando uma cadeira chega, o Index pode solicitar outra, sem limitar o total de cadeiras ativas do servidor a uma ou duas. Respostas prontas e interação humana precedem cadastro/abertura, atendimento quente e observação fria. A espera acumulada também aumenta prioridade para evitar esquecimento das demais contas.

O CT aplica a mesma regra centralmente com `maxQueuedPerServer: 1` e distribui concessões entre servidores elegíveis com menos cadeiras ocupadas (`fairServers: true`). Não é necessário reiniciar filas ou apagar pedidos anteriores; o escalonador atende o backlog existente de forma justa enquanto ele esvazia.

Na devolução, o worker desconecta o navegador e avisa o Index. O Index fecha seu acesso local e solicita um recibo de responsabilidade ao CT, salvando `phase: release_requested` quando recebe o recibo correto. O CT continua contando a cadeira enquanto finaliza o fechamento remoto. A mesma conta só pode iniciar outra operação após confirmar o encerramento anterior. O recibo não confirma mensagem enviada ou publicação realizada.

CT antigo continua funcionando: ignora o cabeçalho opcional e entrega o ACK final como antes. Instalar o CT atualizado primeiro é a ordem preferida. Os arquivos dos servidores podem ser baixados com `restart: false` e carregados no próximo início completo do Index e dos workers. Reiniciar somente workers não carrega o coordenador no Index antigo.

O canal worker–Index valida o proprietário e a célula da conta. O Index verifica a disponibilidade do worker antes de ativar a cadeira. Queda de worker devolve seus recursos; reinício do Index exige reconciliação da operação persistida antes de retomar. Falta de Index não autoriza navegação direta. Flags de conta e confirmação de mensagens não são apagadas por essa mudança.

Testes cobrem 105 tarefas, prioridade e envelhecimento, pedido idempotente, cancelamento concorrente com concessão, worker morto, devolução perdida, mesmo navegador aguardando encerramento anterior e comunicação worker–Index com execução central de efeitos/confirmações.
