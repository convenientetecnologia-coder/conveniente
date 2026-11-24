# Um pedido pendente por servidor

Os workers compartilham a aquisição de cadeira pelo marcador único `dados/carrier_v2_operations/host-admission.lock`. A espera das outras contas é local. Quando a aquisição termina, o próximo pedido pode entrar: isso não limita as cadeiras ativas do servidor a uma ou duas.

O CT aplica a mesma regra centralmente com `maxQueuedPerServer: 1` e distribui concessões entre servidores elegíveis com menos cadeiras ocupadas (`fairServers: true`). Não é necessário reiniciar filas ou apagar pedidos anteriores; o escalonador atende o backlog existente de forma justa enquanto ele esvazia.

Na devolução, o cliente atualizado solicita um recibo de responsabilidade ao CT. Ele fecha seu acesso local antes do pedido e salva `phase: release_requested` quando recebe o recibo correto. O CT continua contando a cadeira enquanto finaliza o fechamento remoto. A mesma conta só pode iniciar outra operação após consultar o encerramento anterior. O recibo não confirma mensagem enviada ou publicação realizada.

CT antigo continua funcionando: ignora o cabeçalho opcional e entrega o ACK final como antes. Instalar o CT atualizado primeiro é a ordem preferida. Os arquivos dos servidores podem ser baixados com `restart: false` e carregados no próximo início.

Testes cobrem processos separados disputando uma aquisição, quinze contas concorrentes, cancelamento, falha do proprietário e recibo sem liberação remota prematura. Flags de conta e confirmação de mensagens não são apagadas por essa mudança.
