# Pacote de revisão Virtus em produção — 21/11/2026

## Mãe 5

Evidências: capturas enviadas pelo operador mostram aviso de armazenamento seguro, skeleton, documento sem estilos com erro explícito de carregamento, lista geral do Messenger e splash. Snapshot do servidor contém visitas incompletas por timeout de 120 segundos, visitas Marketplace prontas e um resultado Marketplace ausente. Essas evidências não comprovam que mensagens ficaram sem resposta nem que a cadeira foi liberada cedo demais.

Correções preparadas:

- Fechar apenas o aviso informativo reconhecido de alterações do armazenamento seguro pelo botão OK e confirmar seu desaparecimento; não aceitar automaticamente PIN, identidade ou outros diálogos.
- Exigir documento de conversas completo e estável antes de procurar Marketplace; skeleton, splash, erro explícito e fonte padrão sem estilos não contam como pronto.
- Exigir grid Marketplace, em vez de aceitar um título isolado como feed ativo.
- Revalidar documento e alvo antes de concluir Marketplace ausente; readiness negativa nunca vira visita aprovada.
- Após espera falhar com evidência explícita de estilos ausentes ou erro de carregar conversas, permitir um reload e exigir nova validação. Limite de um reload por página a cada dez minutos; página saudável sem mensagens novas não provoca reload.

Validação: 47 testes passaram, incluindo visita, PIN/avisos, estabilidade, sessão proxy, devolução de cadeira e confirmação de envio. Testes com DOM simulado não substituem validação real em produção.

Não aplicado aos servidores. Revisão dos demais servidores continua. Ainda pendente validar em ambiente real o comportamento de reconexão da lista e recebimento/envio das mensagens observadas pelo operador.

## Mãe 7

Página sem estilos e splash repetem os sintomas da Mãe 5. Snapshot confirma visitas incompletas e também um caso distinto: perfil ativo em `about:blank`, sessão proxy fechada e `startup_timeout` persistido. O callback de timeout fechava a sessão sem garantir fechamento do navegador; sua própria rotina de encerramento desativava a limpeza periódica. Corrigido para fechar o navegador ao vencer a abertura, inclusive quando a limpeza da sessão falha. Não reinicia cadastro nem ignora checkpoints. Duas verificações direcionadas cobrem timeout com erro e preservação de navegador cujo startup concluiu.

## Mãe 6 — atendimento, postagem e identificação

Pamela associada por registro à conta `anapolis-1795215264742`, com coleta/cidade resolvida; ainda não equivale a confirmação de entrega. Brenda associada pelo operador a `florianopolis-1795274260369`; a conta da Ester ainda não foi identificada. Postagem com prévia quebrada associada a `aracaju-1795068496714`; upload e prévia ainda devem ser distinguidos pelos registros.

Identificação local acrescentada às páginas: etiqueta discreta com nome/cidade e ID no atributo de descrição, sem rede, navegação, login Chrome ou cadeira. Não depende do modo humano e não intercepta cliques. O pedido humano hoje espera cadeira antes de concluir preparação visual; não foi alterada sua governança nesta etapa.

Osvaldo: registros mostram a thread recente `1932008228209409`, mensagem “Oi, esse item está disponível?”, descartada repetidamente como `first_boot_seed_without_delta_history` apesar de estar dentro de 12 horas. Alterado para solicitar verificação da última mensagem pelo mecanismo já existente de leitura antes de descartá-la como histórico. Esse mecanismo exige mensagem não vazia, do cliente e dentro de 12 horas; mensagem nossa ou conversa antiga não dispara resposta. O estágio novo registra a decisão. Confirmação visual de que essa thread é Brenda ainda deve ser correlacionada com a conta; o nome não está no evento capturado.

## Mãe 3 — lista deslocada

Capturas mostram lista posicionada em conversas de seis/sete semanas; ao voltar ao topo aparece conversa aguardando resposta há 19 horas. O fluxo proxy não fazia reset explícito da lista em cada visita, embora outros caminhos de envio tenham reset próprio. Acrescentado retorno ao topo somente nos ancestrais roláveis do grid Marketplace antes de validar sua estabilidade. A posição precisa continuar confirmada durante a validação; não rola o documento inteiro nem a conversa aberta. Os 19h também excedem o filtro de 12h existente; não se conclui que a rolagem sozinha causou falta de resposta. Conta e logs específicos ainda necessários para esse caso.

### Preservação de tempo e estado

Limite de 12 horas preservado. A revisão inicial não se aplica a conversas já presentes no estado persistido de atendimento. A releitura anteriormente injetava `Date.now()+1500`; isso foi substituído pelo timestamp original da rede quando o texto conferido é o mesmo, ou pelo horário verificável da mensagem lida. Mensagem sem horário comprovado, futura ou fora da janela não é encaminhada. Uma nova leitura/reconexão não renova a idade de uma mensagem antiga. Testes cobrem reinício com estado persistido, envelhecimento além de 12h, resposta nossa, divergência de texto e horário ausente.
