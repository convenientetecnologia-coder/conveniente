### INBOX — relatos do humano (Cássio) — CANÔNICO

Objetivo: quando o humano mandar um texto grande/bagunçado com “mil problemas”, o GPT usa este arquivo como **canal de intake**:

- colar o **texto bruto** (sem julgar)
- quebrar em **itens separados** (um por problema)
- classificar por **P0/P1/P2**
- marcar o que falta (evidência/logs/cmdId/hostId)
- mapear “relato X” → **arquivo(s)/função(s)** → hipótese → plano

> Regra: o humano não investiga nem coleta logs manualmente. O GPT puxa logs via CT, e o humano só reinicia `node index.js` quando solicitado.

---

## Regras não negociáveis (resumo)

- **Sou humano**: eu só reinicio processos no servidor com `node index.js` e confirmo “reiniciado”. Eu não coleto logs manualmente, não rodo comandos, não copio/colo evidência.
- **Você é o operador técnico**: você edita código, cria comandos, coleta logs via CT, registra docs, faz commit/push.
- **Sempre diga no início**:
  - **Precisa reiniciar?** sim/não
  - **Qual projeto?** conveniente / sitechatbot / notificador / site
  - **Como reiniciar (humano)?** `node index.js`
  - **Por quê?** (1 frase)
- **Sem achismo**: qualquer decisão importante tem que citar evidência (arquivo/path, log key, cmdId/requestId, endpoint).
- **Sem segredos**: nunca colar valores de secrets em chat/docs (apenas nomes/onde configurar).
- **Windows/PowerShell**: não usar `&&` nem heredoc `<<EOF` (usar `;` e `git commit -m ... -m ...`).
- **Melhoria contínua**: se você errou e depois acertou, você atualiza RUNBOOK/LIVRO/TIMELINE e sobe commit pro GitHub.
- **Padrão conveniente**: se mexeu no conveniente, você já faz commit/push + dispara `self_update` e só pede o restart.

### Arquivos canônicos (use sempre)

- `C:\conveniente\docs\LIVRO_DE_BORDO.md`
- `C:\conveniente\docs\RUNBOOK_TECNICO.md`
- `C:\conveniente\docs\TIMELINE.md`
- `C:\conveniente\docs\checkups\README.md`
- `C:\conveniente\docs\checkups\TEMPLATE_CHECKUP.md`
- `C:\conveniente\docs\checkup_geral_2026-01-29.md`

---

### Como usar (passo a passo)

1) **Colar o texto bruto** do humano em "RAW_INPUT".
2) **Criar itens** na tabela "TRIAGE" (1 linha por problema).
3) Para cada item, criar uma seção "ITEM ..." com:
   - hipótese(s)
   - evidência solicitada (logs keys / requestId / cmdId)
   - o que o GPT vai mudar (arquivos)
   - precisa reiniciar agora? sim/não
   - precisa reiniciar para validar? sim/não
4) **Obrigatório**: antes de mexer em código, fazer **análise de impacto**:
   - quem chama / quem é chamado (callers/callees)
   - quais arquivos/estados são tocados (desired/perfis/status/locks)
   - quais efeitos colaterais podem acontecer (ex.: "fechar" disparar "abrir" por nurse/desired)
   - quais riscos de regressão e como reduzir (mudança mínima + guardrails + rollback)
5) **Obrigatório**: antes de investigar "do zero", olhar o **passado** (evitar repetir erro / achar regressão):
   - `C:\conveniente\docs\TIMELINE.md` (entradas relacionadas)
   - `C:\conveniente\docs\checkups\file_timeline\INDEX_*.md` (qual arquivo é hotspot)
   - se o sintoma parece regressão: procurar commits recentes nos arquivos-alvo (o GPT faz isso)
6) **Obrigatório**: antes de corrigir, fazer **perguntas item-a-item** (alinhamento humano):
   - "como deveria ser?" (comportamento esperado)
   - "qual é o critério de sucesso?" (como validar)
   - "isso é P0/P1/P2 pra você?" (impacto)
   - "precisa disso hoje (agora) ou pode ser depois?" (prioridade)

---

## RAW_INPUT (colar aqui)

```text
RAW_INPUT (2026-03-18) — RM3 dashboard 95 vs 70 navegadores

"certo, vamos la, atenção extrema aqui, nao vamos codar nada , precisamos de ultra enpterise mlehor auditoria dossie de ponta a ponta do mundo sobre o que esta acontecendo, eu to la no rm3, ele ta bom 95 navegdors abertos, mas no dashboard ta marcando alguns navegdors fechados, e nao sei o que ta acontecendo, de fato tem 95 navegdors abertos, agora porque ta mostrando que so tem 70 no dashboard"

TRIAGE: P1 (discrepância operacional, não bloqueante)
STATUS: done — dossiê forense em docs/checkups/checkup_2026-03-18_dossie_forense_rm3_dashboard_95_vs_70_navegadores.md
``` 

---

## RAW_INPUT — 2026-04-07 (elevar anti-detect para nível enterprise, por fases)

```text
triagem inbox

registrar tudo para execução organizada, sem quebrar produção:

escopo aprovado:
1) geo de fingerprint deve seguir IP/proxy (sem mexer na cidade de negócio da conta)
2) timezone/idioma com coerência por proxy (evitar pacote repetido em massa)
3) validar qualidade real dos presets UA/UA-CH atuais; se insuficiente, avaliar fonte externa
4) fortalecer fingerprint avançado (webgl/canvas/audio/fonts/plugins)
5) reduzir uniformidade/cluster (platform e pacote técnico por coortes coerentes)
6) criar score de coerência por perfil com rollout seguro (observação -> soft -> hard) sem travar produção
7) comportamento humano fica para o fim, com debate dedicado

requisito operacional:
- ultra organizado, execução item a item, evidência e simulação antes de expandir.
```

### TRIAGE — 2026-04-07 (Programa Anti-Detect Enterprise)

| item | P | título | status | links |
|---|---|---|---|---|
| 1 | P0 | Geo de fingerprint por proxy (preservando cidade de negócio) | in_progress | `docs/inbox/in_progress/INC-20260407-1600-01.md` |
| 2 | P1 | Timezone/idioma por coerência de proxy (anti-cluster) | need_evidence | `docs/inbox/need_evidence/INC-20260407-1610-01.md` |
| 3 | P0 | Auditoria/validação dos presets UA/UA-CH atuais | need_evidence | `docs/inbox/need_evidence/INC-20260407-1620-01.md` |
| 4 | P0 | Fingerprint avançado: WebGL/Canvas/Audio/fonts/plugins | need_evidence | `docs/inbox/need_evidence/INC-20260407-1630-01.md` |
| 5 | P1 | Coortes de plataforma/pacote técnico para reduzir cluster | need_evidence | `docs/inbox/need_evidence/INC-20260407-1640-01.md` |
| 6 | P0 | Score de coerência por perfil (CT maestro: observação -> soft -> hard) | need_evidence | `docs/inbox/need_evidence/INC-20260407-1650-01.md` |
| 7 | P2 | Comportamento humano avançado (fase final, debate dedicado) | need_alignment | `docs/inbox/need_evidence/INC-20260407-1700-01.md` |

```text
RAW_INPUT (2026-03-30) — reforço operacional enterprise (“contrato do trabalho”, reiterado)

Nota: conteúdo já registrado integralmente em RAW_INPUT (2026-03-12) neste mesmo arquivo.
Reiteração de regras chave:
- humano: só reinicia com `node index.js` e confirma “reiniciado”; não coleta logs/manual.
- GPT: operador técnico (código + comandos + logs via CT + docs + commit/push quando aplicável).
- sem achismo: decisões importantes exigem evidência (path/log key/cmdId/requestId/endpoint).
- sempre iniciar resposta com cabeçalho 4 linhas (reinício/projeto/comando/por quê).
- Windows/PowerShell: sem `&&` e sem heredoc.
```

```text
RAW_INPUT (2026-04-02) — reforço operacional enterprise (reiteração)

Nota: reiteração do mesmo “contrato do trabalho” e regras não-negociáveis, já registradas integralmente em:
- RAW_INPUT — 2026-03-12 (neste arquivo)
- RAW_INPUT (2026-03-30) — reforço operacional enterprise (reiteração curta)
```

```text
RAW_INPUT (2026-04-04) — reforço operacional enterprise (reiteração + reforço de postura)

Nota: reiteração do mesmo “contrato do trabalho” e regras não-negociáveis, já registradas integralmente em:
- RAW_INPUT — 2026-03-12 (neste arquivo; texto integral)
- RAW_INPUT (2026-03-30) — reforço operacional enterprise (reiteração curta)
- RAW_INPUT (2026-04-02) — reforço operacional enterprise (reiteração)

Reforços explícitos do humano nesta reiteração:
- operar sem achismo, com evidência (path/log key/cmdId/requestId/endpoint);
- humano não executa comandos nem coleta logs; só reinicia `node index.js` quando solicitado e confirma “reiniciado”;
- GPT é o operador técnico: código + coleta via CT + organização em RUNBOOK/LIVRO/TIMELINE;
- sempre dizer quais processos/nodes precisam de restart;
- evitar mudanças grandes/absurdas; preferir mudança mínima, logs robustos e organização.
```

```text
RAW_INPUT (2026-04-06) — reforço operacional enterprise (reiteração + início de nova rodada de stress em produção)

Nota: reiteração do mesmo “contrato do trabalho” e regras não-negociáveis, já registradas integralmente em:
- RAW_INPUT — 2026-03-12 (neste arquivo; texto integral)
- RAW_INPUT (2026-03-30) — reforço operacional enterprise (reiteração curta)
- RAW_INPUT (2026-04-02) — reforço operacional enterprise (reiteração)
- RAW_INPUT (2026-04-04) — reforço operacional enterprise (reiteração + reforço de postura)

Reforços explícitos do humano nesta reiteração:
- operar 110% enterprise (organização + evidência + mudança mínima);
- tratar 1 problema por ticket (sem misturar assuntos);
- o humano não investiga nem coleta logs manualmente (o GPT coleta via CT);
- o humano só reinicia com `node index.js` quando o GPT pedir e confirma “reiniciado”;
- sempre declarar no início: precisa reiniciar? / qual projeto? / como reiniciar? / por quê (1 frase);
- sempre declarar quais nodes/processos precisam de restart (ou “nenhum”).
```

```text
RAW_INPUT (2026-04-02) — RM5 (Robe Mãe 5): Robe postagem falha “sem foto” apesar de ~1700 fotos

triagem imbox

robe mae 5 como base de teste

estamos com problema no robe, tem alguma coisa de muito errado que nao ta certo, eu to la no robe mae 5, eu fechei tudo e deixei apenas 1 navegador aberto pra teste, porque tem algo de muito errado que nao ta certo

eu cliquei em liberar robe pra postagem e ta dando erro que nao tem foto para aquela conta, mas isso nao faz sentido porque tem ~1700 fotos naquele servidor e nao teria como aquela conta ter postado tudo isso

o sistema registra as fotos para as contas para todas as contas postagem aquela mesma foto, mas nao repetir as fotos por conta, e é feito um reigstro, mas em algum momoento a foto é apagada, e o registro tambem tem que ser apagado, eu nao sei onde estamos com o problema, mas precisamos investigar isso de modo ultra enteprise forense melhor do mundo, preciamso auditar isso de ponta a ponta pra entender o que ta acontecendo
```

```text
RAW_INPUT (2026-03-30) — triagem inbox (rateio 29 cidades + 121 cobranças Asaas dia 1 + abortar tokenized)

triagem imbox 

certo, vamos la, aqui eu preicso que voce tenha extrema atenção ultra melhor do mundo aqui

voce é 1 milhao de vezes mais inteligente do mundo e eu sou humano burro

seguinte, eu sou humano burro e muitas vzes nao sei exprssar o que estou passando, o que estamos passando oq ue esta acontecendo e isso é muito ruim, porque eu sou burro, e voce é 1 milhao de vezes mais inteligente do mundo 

seguinte, temos hoje o sistema atual que os pedidos estao chegando nos grupos

hoje temos 67 grupos que recebem pedidos de fretes e tudo mais

todos esses grupos sao modelo legacy ate onde eu sei 

certo, ate aqui é facil de entender

porque assim, e aqui preciso que voce tenha extrema atenção pra isso nao virar mais bagunça, porque eu to muito confuso , cansado, estressado irritado com medo entende

por isso preicsamos ser ultra enteprrise melhor do mudnoa qui pra entender tudo o que ta acontecendo, tudo o que aconteceu, e tudo que precisa ser feito pra gente conseguir deixar isso utlra alinhado melhor do mundo 

então assim, vou tentar ser o mais direto possivel pra voce entender, porque eu to com dificuldades em expressar 


1 - temos 67 grupos que recebem pedido legacy perfeitametne, esses pedidos vao com numero e link pra chamar o cliente diretametne

2 - desses 67 grupos cidades, 29 foram selecionadas para um teste novo 

então assim, essas aqui sao essas cidades 

1	Ipatinga (MG)
2	Montes Claros (MG)
3	Foz do Iguaçu (PR)
4	Fortaleza (CE)
5	Petrolina (PE)
6	Balneário Camboriú (SC)
7	Boa Vista (RR)
8	Jundiaí (SP)
9	Limeira (SP)
10	Rio Branco (AC)
11	Rio Verde (GO)
12	Santa Maria (RS)
13	Campos dos Goytacazes (RJ)
14	Macapá (AP)
15	Aracaju (SE)
16	Imperatriz (MA)
17	Indaiatuba (SP)
18	Bauru (SP)
19	Campina Grande (PB)
20	Campo Grande (MS)
21	Caruaru (PE)
22	Franca (SP)
23	Juazeiro do Norte (CE)
24	Marabá (PA)
25	Piracicaba (SP)
26	Porto Velho (RO)
27	Taubaté (SP)
28	Maceió (AL)
29	Sorocaba (SP)

então assim, onde que ta a confusão toda

nosso sistema primordial sempre foi 67 grupos ciaddes, trabalhando em modo legacy perfeito, onde todos os pedidos vao completos pros grupos

então agente criou o sistema tokenized, e é aqui que ta gerando toda a bagunça

no sistema tokenized os pedidos nao iam completos nos grupos, os motoristas acessavam um link para particiapr do sorteio, dai o sistema gerava valores pra eles, era uma confusao danada, compelxidade alta, bagunça generalizada, mas agente tinha criação de boeltos autoamtizado, tudo configurado e tudo rodando, o sistema em si a funcioannlidade em si do sistema tava perfeita

porquem nao foi aprovado, os motoristas odiaram esse sistema, isso deu uma merda fodida, e infelismente itvemos que abortar a continuação desse sistema

e ai o que fizemos , pegamos esses 29 cidades grupos e trouxemos elas novamente para o modo legacy

e o que aconteceu foi o seguinte

todas as 67 cidades grupos eram legacy com assinatura

dai escolhemos 29 cidades pra passar pra tokenizes com boletos avulsos 

nao foi aprovado e voltamos essas 29 cidades para o modo legacy novamente, porem sem assinatura, e é aqui que ta a bagunça

no caso é diferente, nao vai ser assinatura pra essas cidades, mas sim cobranças por valor do lead

ao inves de colocar o motorista no grupo pra trabalhar com os leads, e cobrar mensalidade fixa dele

agora toda segunda feira agente fecha todo o engajamento que deu durante 1 semana , multiplica por 5, adciona 30% em cima do valor total + 1.99 que é o valor pra gerar o boleto

e então isso ficou uma bagunça completa

porque ai temos a criação de boeltos bloqueios e tudo mais dentro do sistema interno que era gerado pelo sistema tokenized que foi abortado nao vamos mais usar, mas agente ainda quer continuar criando boletos

certo, ate aqui é isso que ta acontecendo

no dia 23/3 ate o dia 29/3 foram gerados leads nesses 29 grupos, hoje é dia 30 segunda feira, e fizemos o calculo e tudo mais dos motorisats desses 29 grupos, calculmaos tudo e deu isso aqui 

rateio_motoristas_2026-03-23_a_2026-03-29_com_30porcento.md

esse resultado aqui, ta nesse arquivo

certo, e o que foi feito, eu tava falando com o gpt em outro chat, so que aquele chat ta uma bagunça generalizada, e ele começou a fazer um monte de merda, fe zuma bagunça generalizada tambem, quando eu pedi pra gerar boletos, ele usou meio que o sistema otkenized, dai deu uma bagunça generalizada

dai ele gerou boletos para o dia 1, e fez boletos duplicado e tudo mais, ou seja uma bagunça generalizada das grandes

e cara eu to quase chorando aqui, porque eu to completamente perdido

dai eu pedi pra ele excluir os boletos em aberto do dia 2, porque era boletos duplicados que ele fez pro dia 1 tambem, dai tinha 54 boletos no dia 2 , que eram os mesmos valores pro dia 1 e uma merda genelzalida

e no dia 1 , se olhar no sistema interno e asaas temos 121 boletos

certo, ate aqui ta tudo bem, todos os demais boletos que tinha ele excluiu, inclusive boletos da epoca do sistema tokenized que agente tava em negociação com os motoriatas, mas cara , serio , eu nao to nem ai pra isso, eu to com tanto problema pra resolver que isso agora é o de menos pra mim, acreditoq ue o prejuizo foi pequno em compração com o prejuizo emocional e mental que to tendo com toda essa bagunça

eu nao qeuro mais o sistema tokenized, tudo do sistema tokenized nao vai ser usado

mas vamos precisar gerar boletos ainda via sistema para centenas de motorisats e tudo mais

e hoje foi o primeiro dia que fechamos a semana de leads, gerou um valor X pra cada grupo um valor Y para cada motorista contando se o motorisats ja tava dsde o incio da mudanças, ou se era motorisats novo que entoru no meio do caminho, enfim

o outro gpt ele usou o sistema tokenized aparetnemetne pra gerar as cobranças, tem cobrança, ele usou o sistema ct sistema interno de boletos eu acho, mas isso nao é mais necessarios , nao agora

porque eu so precisava fazer isso manualmente mesmo, via codigo aqui essa geração de boletos e o gpt começou a fazer tudo errado

cara eu to muito estressado, triste, com dores, quase chorando, apavorado, eu to virado em desespero total aqui , porque isso ta parecendo uma bagunça generalizada e eu nao sei o que fazer

temos esses 29 grupos, ja foram gerados as cobranças deles

e aqui ja temos 1 problema, eu fui la no asaas e abri um desses boletos do dia 1 e eu percebi que os boletos foram gerados cobranças com notificação via SMS

e nao é pra acontecer isos

ou seja, eu preciso muito da sua ajuda, precisamos ultra enpterisae melhro do mundo resolver isso d emodo utlra organizado, muita coisa vai precisar ser desfeita, muita coisa nova vai precisar ser feita, mas agora é hora de resolver o probelam porque eu to em desespero total

o que eu preciso 

1 - excluir todas essas 121 cobranças la do asaas

so que isso preicsa ser atomico perfeito, porque o outro gpt tava fazendo um mont de merda entende

ele removia as cobranças no CT , mas la do assas elas continuavam la, dai ele fez um monte de merda, tambem criou cobranças no ct que nao geravam boletos, assim ele fez uma merda do caralho, quando no caso eu so queria criar os boletos com os valores coforme o arquivo do rateio, mas tudo foi complicado, foi virando uma bola de neve e agora eu to aqui surtado, apavorado, desesperado, agoniado, quase chorando, negocio ta complexo pra mim 

então primeiro passo, remover todas as 121 cobranças do dia 1, esse é o primeiro passo

vamos fazer isso de modo ultra perfeito ? vamos deixar isso ultra alinahdo perfeito melhor do mundo? porque preicsmaos limpar o lixo, reorganizar, depois corrigir e limpar codigo, e criar coisas novas para o novo metodo, sem essa coisa de tokenized

precismaos agora garantirq ue vamos exlfcuir do ct e do asaas todos esses boletos, depois vemos o proximo passo
```

```text
triagem inbox (2026-03-05)

criar inc

Contexto:
- Queremos migrar o runtime do `conveniente` de `chrome.exe` para `chromium`.
- Objetivo: manter comportamento idêntico ao atual em produção:
  - sessão/cookies persistentes (fechar/abrir e continuar logado),
  - `userDataDir` mantendo a estrutura e localização (pasta conhecida),
  - UA/FP e toda estrutura existente intactas.

Requisitos explícitos:
1) Trocar `chrome.exe` por `chromium` sem quebrar persistência de sessão.
2) Preencher “dados do perfil do navegador” (nome + email fake no menu de perfil) para facilitar UX do operador:
   - nome = nome da conta (profileName)
   - email = `<profileName>@gmail.com`
3) Antes de qualquer mudança grande e antes de publicar no GitHub: fazer backup completo do estado atual (versão Chrome) para rollback rápido.

Restrições operacionais:
- agora é só estudo/auditoria/dossiê; não codar nem executar mudança em produção ainda.

---

triagem inbox

URGENTE

ROBE MÃE 3: no CT está com "trabalhando 0".

Perguntas:
- por que ele está assim?
- está travado?
- tem a ver com modo leve?

Pedido:
- verificar com logs ultra detalhados enterprise e provar o motivo agora.

---

triagem inbox

precisamos investigar no ROBE MÃƒE 3 com logs:

- dificuldade no "invocar humano": cliquei em invocar humano e **não está indo o painel** que abre junto com o invocar humano
- botão **"retomar trabalho" não está retomando trabalho**
- isso prejudica o sistema: tem contas com messenger+facebook ok, mas o sistema marca **login requerido** e **virtus offline**
- depois de um tempo o retomar trabalho funcionou, mas está "travado/estranho"

Pedido:
- investigar modo ultra enterprise no código e nos logs **por que isso acontece**
- primeiro entender/provar; depois (aprovado) decidir se muda ou não

---

triagem inbox (2026-01-30):

- ao clicar **Abrir Todos** ou abrir conta, deveria zerar flags para reavaliar estado real; flags antigas podem engessar
- apÃ³s **Retomar trabalho**, se Messenger estiver em login/senha, deveria re-detectar e repetir cookiesâ†’loginâ†’humano; parece engessado
- HUD do **modo humano** some ao navegar (demora a reaparecer)

---

triagem inbox (2026-01-30):

- apÃ³s Retomar trabalho, contas `campo_grande-1769119224052` e `porto_alegre-1769132611438` ficam sem flag e presas na tela de login
- conta `blumenau-1769748927066` abre em â€œconfirme que vocÃª Ã© humanoâ€; apÃ³s clicar â€œContinuarâ€ manualmente aparece captcha/ checkpoint; sistema deveria antecipar o clique â€œContinuarâ€ e sÃ³ entÃ£o invocar humano

---

triagem inbox (2026-02-03):

CT Chat (2 itens):
1) Composer (caixa de escrever) precisa auto-grow conforme digita; teto ~8 linhas.
2) Mensagens grandes precisam de botÃ£o â€œVer maisâ€ (expandir/recolher).


---

triagem inbox (2026-02-03):
CT Chat (5 itens):
1) Editar mensagem no menu (...) com modal bonito (preview + campo + confirmar/cancelar).
2) Links clicaveis no texto.
3) Mensagem unica grande deve quebrar para baixo (sem scroll lateral).
4) Reenviar quando falhar envio.
5) Cor por usuario.

```

---

## RAW_INPUT — 2026-03-12 (reforço operacional enterprise — “contrato do trabalho”)

```text
oi bom dia tudo bem, voce esta me ajudando a criar um sistema, esse sistema basicamente ficou pronto e ja começamos a rodar ele em modo de produção real , levando ele ao estresse e tudo mais para fins de bugs

me chamo cassio, voce e eu ja estamos trabalhando juntos a muito tempo e é um prazer enorme trabalhar com voce!

porem agora a partir daqui preciso que voce tenha 200% de atenção!

nao quero que voce incorpore um robo sem alma focado apenas em conectar funçoes com funçoes, quero que voce va alem disso! quero que voce saiba que aqui do outro lado tem um humano, muito inteligente e apto a fazer o que tiver que ser feito para que possamos sempre conquistar os melhores resultados!

voce e eu aqui somos os desenvolvedores, voce com sua extrema inteligencia e habilidades, eu como desenvolvedor humano e lider desse projeto onde juntos fazemos os testes com logs mais robustos possiveis, coletamos os dados mais reais possiveis, coletamos as informaçoes de modo mais reais possiveis!

preciso que voce confie em mim! pois eu confio em voce!

ja trabalhamos juntos a muito tempo e eu tenho certeza no que vou falar aqui, voce nunca esta 100% certo, e eu nunca estou 100% certo, voce ja me disse em outras ocasioes, tenho certeza disso, vamos fazer, nos fizemos e nao deu certo, ou seja, tem certezas que para voce parece ser certo, mas ja erramos tanto nisso que hoje eu ja sei que algumas certezas para voce é uma ilusão cara, ou seja, precisamos confiar um no outro , debater soluçoes, preciso que voce va no meu ritmo , eu sou humano, e nao sou maquina, meu processamento de dados e informaçoes é mais lento, então vamos sempre tentar identificar o ponto de modo ultra realista sem achismos, sem criaçoes absurdas, sem mudanças, e sem testes manuais, vamos resolver tudo com codigo, logs, e muita organização!

precisamos garantir sempre maxima melhor do mundo trabalhar de modo ultra enteprise, ultra detalhado, ultra organizado, ultra cirurgico, ultra robusto, ultra perfeito, ultra melhor do mundo

sobre mudanças, atualizaçoes e qualquer coisa que seja, eu quero que voce sempre me diga quais nodes eu preciso reiniciar

precisamos trabalhar 110% com perfeição ultra enteprise melhor do mundo

voce tem acesso a todos os dados de todos os projetos que estamos trabalhando, todos os arquivos tudo, voce tambem consegue ter acesso a todos os servidores enfileirando comandos via ct para todos os servidores, ja existem alguns comandos prontos, voce consegue puxar logs detalhados do jeito que precisar, ou seja, sempre que houve um problema em algum servidor vamos puxar os logs de la, assim voce tem dados reais 100% precisos, eu como humano burro nao quero ter que ficar investigando, voce muito mais inteligente rapido agil pode fazer tudo isso por codigo, o que eu faria em dias, voce faz em segundos

dai tipo assim, vamos sermpre debater da melhor fomra possivel, quero que voce entenda que eu sou um humano falho e cheio de limitaçoes, quero que voce sempre fale na minha lingua pra que eu possa entender da melhor forma possivel, eu sou programador de sistema de quinta categoria, ou seja, eu so sei programar usando inteligencia artificial, entendo alguma coisa ou outra de fluxos, mas ainda sim eu sou extremamente falho, preciso que voce sempre entenda da melhor forma possivel o que eu to tentando passar, pois muitas vezes nao sei me expressar, nao sei passar as informaçoes e isso pode fazer voce entender errado e agente fazer uma grande merda, por isso peço que voce tenha extrema atenção no que falo no sentido de que é confuso, e nao podemos aplicar minha confusão num sistema desse nivel

então assim oh, nos temos alguns livros de bordo onde ajuda muito e vamos usar eles em tudo, de modo perfeito organizado nivel enteprise melhor do mundo, dai tudo que for novo que for ajudar outros gpts em novos chats vamos anotar ali, ali ja tem anotaçoes de outros gpts e isso é excelente, pois voces se organizam, se instruem e tudo mais, vamos usar aquilo ali sem dó nem piedade

Regras não negociáveis (resumo):
Sou humano: eu só reinicio processos no servidor com node index.js e confirmo “reiniciado”. Eu não coleto logs manualmente, não rodo comandos, não copio/colo evidência.
Você é o operador técnico: você edita código, cria comandos, coleta logs via CT, registra docs, faz commit/push.
Sempre diga no início:
Precisa reiniciar? sim/não
Qual projeto? conveniente / sitechatbot / notificador / site
Como reiniciar (humano)? node index.js
Por quê? (1 frase)
Sem achismo: qualquer decisão importante tem que citar evidência (arquivo/path, log key, cmdId/requestId, endpoint).
Sem segredos: nunca colar valores de secrets em chat/docs (apenas nomes/onde configurar).
Windows/PowerShell: não usar && nem heredoc <<EOF (usar ; e git commit -m ... -m ...).
Melhoria contínua: se você errou e depois acertou, você atualiza RUNBOOK/LIVRO/TIMELINE e sobe commit pro GitHub.
Padrão conveniente: se mexeu no conveniente, você já faz commit/push + dispara self_update e só me pede o restart.

Arquivos canônicos (use sempre):
C:\conveniente\docs\LIVRO_DE_BORDO.md
C:\conveniente\docs\RUNBOOK_TECNICO.md
C:\conveniente\docs\TIMELINE.md
C:\conveniente\docs\checkups\README.md
C:\conveniente\docs\checkups\TEMPLATE_CHECKUP.md
C:\conveniente\docs\checkup_geral_2026-01-29.md
C:\conveniente\docs\HOST_REGISTRY.md

Se eu mandar um texto confuso com muitos problemas, sua primeira ação é criar triagem:
separar em itens (1 problema por item) e classificar P0/P1/P2
dizer o que falta (hostId, cmdId, logs keys, passos de reprodução)
puxar logs via CT (logs_manifest/fetch_logs) sem pedir eu investigar
Use o INBOX canônico para isso: C:\conveniente\docs\INBOX_RELATOS_DO_HUMANO.md
Nunca misture problemas: trate cada item como um “ticket” com status (need_evidence / in_progress / done)

então assim, vamos começar a trabalhar, atualizar, debugar, corrigir e fazer muitas coisas agora, então tudo o que for correspondente a esses arquivos vamos atualizar eles sempre pra manter sempre o mais atualizado possivel, muito obrigado pela sua atenção e bora trabalhar
```

---

## RAW_INPUT — 2026-03-12 (novo projeto `afiliadozap`)

```text
triagem inbox

projeto c:/afiliadozap

o projeto ta vazio e o projeto vai ser o seguinte

acho que vamos usar o bailyes acho que esse serve nao sei?! vou precisar da sua ajuda pra entender melhor isso

eu to participando de 2 grupos de whatsapp:
- "Promozone #455" (origem)
- "Super Descontos #1" (destino)

futuro: Super Descontos #2, #3...

objetivo:
- rodar `node index.js` no afiliadozap;
- conectar WhatsApp por QR code e manter sessão persistente;
- monitorar grupo origem;
- quando chegar oferta com link Amazon/Shopee/Mercado Livre:
  - abrir o link em navegador com sessão logada;
  - gerar nosso link de afiliado;
  - copiar mensagem original e trocar apenas o link;
  - enviar para grupo(s) destino, um por vez (sem spam).

pedido adicional:
- abrir navegador uma vez para login nos sites e salvar sessão perfeita;
- depois automatizar geração de links;
- provavelmente mapear DOM dos botões/campos de geração de afiliado.
```

---

## TRIAGE (1 linha por problema)

Colunas:
- **id**: `INC-YYYYMMDD-HHMM-XX`
- **arquivo**: link para `docs/inbox/INC-....md`
- **P**: P0/P1/P2
- **sistema**: conveniente / sitechatbot / notificador
- **sintoma (humano)**: 1 frase
- **hipÃ³tese (GPT)**: 1 frase
- **evidÃªncia**: logs keys / cmdId / requestId / endpoint
- **state do INC (rÃ­gido)**: `new` / `need_alignment` / `need_evidence` / `in_progress` / `done` / `cancelled`
- **rollout**: `not_deployed` / `deployed_partial` / `deployed` / `needs_restart` / `manual_step_required`
- **validation**: `not_run` / `passed` / `failed`
- **precisa reiniciar agora?** sim/nÃ£o
- **precisa reiniciar p/ validar?** sim/nÃ£o

| id | arquivo | P | sistema | sintoma (humano) | hipÃ³tese (GPT) | evidÃªncia | state | rollout | validation | reiniciar agora? | reiniciar p/ validar? |
|---|---|---|---|---|---|---|---|---|---|---|---|
| INC-20260405-0900-01 | `docs/inbox/need_evidence/INC-20260405-0900-01.md` | P0 | sitechatbot+conveniente | Implementar gateway de proxies ISP com sticky por conta, distribuição equilibrada e controle total no CT (liga/desliga global e por servidor) | precisa de novo contrato CT⇄hosts (config+estado+ACK) e algoritmo de atribuição estável com redistribuição mínima; rollout por feature-flag | evidência por código (CT menus+comandos; conveniente launch) + ACKs `ack_<cmdId>.json` + logs `provision_audit/logger/commands` | need_alignment | not_deployed | not_run | nao | sim |
| INC-20260402-0900-01 | `docs/inbox/done/INC-20260402-0900-01.md` | P0 | conveniente | RM5: “liberar Robe pra postagem” falha com erro “sem foto”, apesar de existir um pool grande (~1700 fotos) | consumo indevido por tentativa/registry inconsistente; corrigido: reserva não consome + auto-heal + liberação de reserva em falha | hostId `1b0f6f98-46bf-40c6-a0f9-dad6e1965c22`; cmdId self_update `e335b5bb-3f16-4f7d-89da-a26d899882fd` (ack ok) | done | deployed | passed | nao | nao |
| INC-20260305-1445-01 | `docs/inbox/in_progress/INC-20260305-1445-01.md` | P0 | sitechatbot+conveniente | ngrok/CT com 503 e `dial tcp localhost:3000`, `Falha ao enviar status`, self_update sem delivery | CT em indisponibilidade/intermitÃªncia na porta 3000 no momento da coleta; command ficou apenas enqueued atÃ© recuperar conectividade | `commands.log` (`enqueue` sem ack no cmd antigo; `ack ok` no retry), `ack_5bb322ed-1e2b-42c0-a1c0-0871bcddd226.json`, logs ngrok/erro 8012/3004 | in_progress | deployed_partial | passed | sim | sim |
| INC-20260305-1445-02 | `docs/inbox/need_evidence/INC-20260305-1445-02.md` | P1 | sitechatbot+notificador | Virtus/WhatsApp API aparentando latÃªncia alta | possÃ­vel efeito colateral da indisponibilidade CT/ngrok; precisa medir latÃªncia objetiva com `/health` e `/api/whatsapp/stats` em janela estÃ¡vel | endpoints CT + counters runtime + fila pedidos (sem stuck) | need_evidence | not_deployed | not_run | nao | sim |
| INC-20260305-0900-01 | `docs/inbox/in_progress/INC-20260305-0900-01.md` | P0 | conveniente | Migrar Chrome.exe -> Chromium mantendo sessÃµes persistentes e preenchendo perfil do navegador | risco de regressÃ£o: userDataDir/flags e diferenÃ§as de perfil; Fase 1 estabilizada, pendente fechar blindagem/Ux | evidÃªncia por cÃ³digo (paths de launch) + logs (keys: `logger`, `issues_fallback`, `status`, `desired`) | in_progress | deployed_partial | passed_partial | nao | sim |
| INC-20260305-0900-02 | `docs/inbox/done/INC-20260305-0900-02.md` | P0 | conveniente | Backup completo do conveniente (baseline Chrome) antes de mudar/runtime e publicar no GitHub | backup full executado com evidÃªncia (destino, log, hash) antes da migraÃ§Ã£o para Chromium | evidÃªncia: `C:\\sitechatbot\\backups\\conveniente_full_20260305_140355\\_backup_manifest.json` + `_backup_robocopy.log` | done | deployed | passed | nao | nao |
| INC-20260305-1815-01 | `docs/inbox/need_evidence/INC-20260305-1815-01.md` | P0 | conveniente | Blindagem total do navegador (UAFP/fingerprint/geo/rede) antes de novas mudanças | hardening atual existe, porém há gaps em network/privacy flags e coerência total por perfil; precisa dossiê com prova e plano | evidência por código (`browser.js`, `worker.js`, `fileStore.js`, `ua_presets.json`) + logs de runtime (`logger`, `provision_audit`) | need_evidence | not_deployed | not_run | nao | sim |
| INC-20260305-1815-02 | `docs/inbox/in_progress/INC-20260305-1815-02.md` | P0 | sitechatbot+conveniente | ngrok/CT intermitente e travamentos comprometendo operação | mitigação aplicada e estabilização parcial; em observação de 1h por decisão humana antes de fechamento | `logs_manifest`, `fetch_logs(keys=["logger","commands","status","ngrok"])`, endpoints `/health` + requestId/cmdId | need_evidence | waiting_observation | partial | nao | sim |
| INC-20260226-1500-01 | `docs/inbox/need_evidence/INC-20260226-1500-01.md` | P0 | sitechatbot | CT: criar menu "Contestacao" com olhos de Deus (taxas, motivos, motoristas, ciclos, valor zero) | falta congelar definicoes (denominador/numerador) + capturar dimensoes (cidade/grupo) no caso para analytics 110% auditavel | fontes: CT DB `ct_lead_contestation_*` + ledger `ct_driver_lead_ledger` + pedidos.sqlite `lead_lottery_*` | need_alignment | not_deployed | not_run | nao | sim |
| INC-20260203-2500-01 | `docs/inbox/in_progress/INC-20260203-2500-01.md` | P1 | sitechatbot | Chat: editar mensagem no menu (...) com modal | falta endpoint/edit + UI do menu/modal | debug ingest runId=chat_edit_v1 | in_progress | not_deployed | not_run | nao | sim |
| INC-20260203-2510-01 | `docs/inbox/need_evidence/INC-20260203-2510-01.md` | P2 | sitechatbot | Chat: links clicaveis | falta linkify no render | debug ingest runId=chat_links_v1 | need_alignment | not_deployed | not_run | nao | sim |
| INC-20260203-2520-01 | `docs/inbox/need_evidence/INC-20260203-2520-01.md` | P1 | sitechatbot | Chat: texto grande com scroll lateral | falta overflow-wrap/word-break | debug ingest runId=chat_wrap_v1 | need_alignment | not_deployed | not_run | nao | sim |
| INC-20260203-2530-01 | `docs/inbox/need_evidence/INC-20260203-2530-01.md` | P1 | sitechatbot | Chat: reenviar msg falhada | falta acao de resend em UI/outbox | debug ingest runId=chat_resend_v1 | need_alignment | not_deployed | not_run | nao | sim |
| INC-20260203-2540-01 | `docs/inbox/need_evidence/INC-20260203-2540-01.md` | P2 | sitechatbot | Chat: cor por usuario | falta paleta/estilo por actor | debug ingest runId=chat_colors_v1 | need_alignment | not_deployed | not_run | nao | sim |
| INC-20260203-2400-01 | `docs/inbox/in_progress/INC-20260203-2400-01.md` | P1 | sitechatbot | Chat: composer nÃ£o cresce e texto some; mensagens grandes precisam â€œVer maisâ€ | Composer com altura fixa sem handler; bolhas sem truncamento/toggle | debug ingest (runId=chat_autogrow_v1, chat_vermais_v1) | in_progress | not_deployed | not_run | nÃ£o | sim |
| INC-20260207-1403-01 | `docs/inbox/done/INC-20260207-1403-01.md` | P0 | conveniente+sitechatbot | RM3: 50/50/24 (Virtus OFF em massa) apÃ³s stock_provision | root-cause: quiesce + gaps de resume em ambiente sharded; follow-up: stock_provision nÃ£o depende de quiesce por padrÃ£o | CT snapshot `C:\\sitechatbot\\dados\\5d7c3309-...-30b3fe928b.json` + provision_audit(stock_provision_*resume*) | done | deployed | passed | nÃ£o | nÃ£o |
| INC-YYYYMMDD-HHMM-01 | `docs/inbox/in_progress/INC-YYYYMMDD-HHMM-01.md` | P1 | conveniente | â€¦ | â€¦ | logs_manifest + fetch_logs(keys=â€¦) | need_evidence | not_deployed | not_run | nÃ£o | sim |
| INC-20260201-0300-01 | `docs/inbox/done/INC-20260201-0300-01.md` | P0 | conveniente+sitechatbot | Total>ativos: browsers fechados apesar de RAM; prejuÃ­zo (contas paradas) | Root-cause: `open_all_finalize_partial` desativava `desired.active` + `nurseTick` bloqueava open quando `loginRequired=captcha_*` ou `identityRequired` e `ctrl` ausente | CT snapshots `C:\\sitechatbot\\dados\\<hostId>-*.json` + `provision_audit` (bootstrap_messenger_ready + loginRequired) + patch worker.js | done | deployed_partial | passed | nÃ£o | nÃ£o |
| INC-20260202-1600-01 | `docs/inbox/done/INC-20260202-1600-01.md` | P0 | sitechatbot+conveniente+notificador | Cidades/Grupos: contrato canÃ´nico + prioridade de provisÃ£o (estoqueâ†’servidor) + migraÃ§Ã£o manual | Fixar contrato: CT canÃ´nico=`cidade_uf`; `conveniente` recebe `cidade` sem UF; `notificador` depende de `cidade_uf`; depois construir score Ãºnico (24/48/72h + motoristas + A + LE por idade ~12d + warmup 24h) | evidÃªncia por cÃ³digo: `C:\\sitechatbot\\index.js`, `C:\\conveniente\\scripts\\dashboard.js`, `C:\\notificador\\index.js` | done | deployed | passed | nÃ£o | nÃ£o |
| INC-20260202-2000-01 | `docs/inbox/done/INC-20260202-2000-01.md` | P0 | sitechatbot+conveniente | Fonte Ãšnica da Verdade: Virtusâ†’Grupos vs Contas FB v2 divergindo (janelas + classificaÃ§Ã£o A/LR/LE/B) | Hoje existiam â€œ2 verdadesâ€: dashboard usava recent3d + classificador simples; v2 usava `fbAccountState`. Unificado para agregador canÃ´nico + janelas explÃ­citas + includeOffline explÃ­cito | evidÃªncia: CT `C:\\sitechatbot\\index.js` (`/api/dashboard/virtus`, `/api/contas-facebook`, `computeAccountsByGroupFromSnapshots`) + verificador offline `C:\\sitechatbot\\tools\\verify_virtus_groups_truth.js` | done | deployed | passed | nÃ£o | nÃ£o |
| INC-20260201-0200-01 | `docs/inbox/cancelled/INC-20260201-0200-01.md` | P0 | conveniente+sitechatbot | Forense RAM: avaliar RM4/RM5/RM6 lotados (min freeMB, autoMode light/full, risco e capacidade) | autoMode pode estar entrando em â€œlightâ€ por regras de tictac/lag mesmo com RAM sobrando; precisamos prova por telemetria por minuto | CT: logs_manifest + fetch_logs(keys=ram_telemetry*, status, governor/ops) dos hosts RM4/5/6 | cancelled | not_deployed | not_run | nÃ£o | nÃ£o |
| INC-20260201-0100-01 | `docs/inbox/done/INC-20260201-0100-01.md` | P1 | sitechatbot+conveniente | Menu Servidores: mostrar contagem de â€œLogin/Cookies falhouâ€ e â€œRecurso em anÃ¡liseâ€ no pill do servidor; ordenar OFFLINE primeiro | CT hoje nÃ£o consegue contar â€œlogin/cookies falhouâ€ porque `status.perfis` nÃ£o expÃµe `loginRemediateFailed`; appeal jÃ¡ existe; sort nÃ£o prioriza offline | evidÃªncia por cÃ³digo: `conveniente/scripts/worker.js` (`setLoginRemediateFailedFlag`, `setAppealSubmittedFlag`, `snapshotStatusAndWrite`) + `sitechatbot/index.js` (`GET /servers flagsAgg + sort`) + `sitechatbot/public/index.html` (render pills) | done | needs_restart | not_run | nÃ£o | sim |
| INC-20260201-0000-01 | `docs/inbox/done/INC-20260201-0000-01.md` | P1 | conveniente+sitechatbot | Groq config distribuÃ­do e alinhado (modelo maverick) em RM1â€“RM7 | ForÃ§ar set_groq_config e validar por evidÃªncia CT (cmd ok + modelo correto) | evidÃªncia: CT `dados/commands.json` (set_groq_config ok + groqModel maverick) | done | deployed | passed | nÃ£o | nÃ£o |
| INC-20260131-0000-01 | `docs/inbox/done/INC-20260131-0000-01.md` | P1 | conveniente | Captcha/Identidade: pre-screen â€œConfirme que vocÃª Ã© humanoâ€ + OCR Groq + handoff identity/appeal; evitar engessamento | Root-cause: botÃ£o â€œContinuarâ€ disabled + cooldown global de identity gate; corrigido com waits + gate sem cooldown | evidÃªncia RM7: `rm7_fetch_success_evidence_1769911213784.json` + `rm7_fetch_identity_stuck_1769899549740.json` | done | deployed | passed | nÃ£o | nÃ£o |
| INC-20260130-0905-01 | `docs/inbox/cancelled/INC-20260130-0905-01.md` | P0 | sitechatbot+conveniente | RM3 aparece OFFLINE no CT (servidores + estoque) mas o host estÃ¡ acessÃ­vel | CT nÃ£o recebeu `/report` recente (snapshot `receivedAt` velho) **ou** UI estÃ¡ mostrando â€œghostâ€ | CT snapshot: `C:\sitechatbot\dados\5d7c3309-...-30b3fe928b.json`; regra CT `/servers` (computedOnline por `receivedAt`) | cancelled | not_deployed | not_run | nÃ£o | nÃ£o |
| INC-20260130-1521-01 | `docs/inbox/done/INC-20260130-1521-01.md` | P0 | sitechatbot+conveniente | CT/Servidores mostra "Desconhecido" e contadores de flags (captcha/humano invocado/login/limite) nÃ£o sÃ£o 110% acionÃ¡veis | o CT estava colapsando razÃµes de `loginRequired` em `unknown` (ex.: `probe_failed`) e nÃ£o expunha flags operacionais no `/servers` | evidÃªncia: CT files `C:\sitechatbot\convenientetecnologia\lib\fbAccountState.js`, `C:\sitechatbot\index.js`, `C:\sitechatbot\public\index.html` | done | manual_step_required | not_run | nÃ£o | sim |
| INC-20260130-1544-01 | `docs/inbox/done/INC-20260130-1544-01.md` | P0 | conveniente+sitechatbot | RM3: â€œinvocar humanoâ€ nÃ£o abre painel/HUD e â€œretomar trabalhoâ€ parece nÃ£o retomar; alÃ©m de variaÃ§Ãµes 0â†’4â†’6 trabalhando no CT | fila de login_remediate travava quando governor_busy + `configurando=true` impedia autoLoginRemediateTick de avanÃ§ar | evidÃªncia: RM3 `provision_audit` em `rm3_pa_tail_verify_20260131_01.json` (CT) | done | deployed | passed | nÃ£o | nÃ£o |
| INC-20260130-2015-02 | `docs/inbox/done/INC-20260130-2015-02.md` | P2 | conveniente | Abrir Todos deveria zerar flags para reavaliar estado real | confirmado ok pelo humano para o uso atual | n/a (aceite do humano) | done | deployed | passed | nÃ£o | nÃ£o |
| INC-20260130-2015-03 | `docs/inbox/done/INC-20260130-2015-03.md` | P2 | conveniente | HUD humano some ao navegar e demora a reaparecer | confirmado ok pelo humano para o uso atual | n/a (aceite do humano) | done | deployed | passed | nÃ£o | nÃ£o |
| INC-20260130-2235-04 | `docs/inbox/done/INC-20260130-2235-04.md` | P1 | conveniente | â€œConfirme que vocÃª Ã© humanoâ€: precisava clicar â€œContinuarâ€ automaticamente antes de captcha | confirmado ok pelo humano para o uso atual | n/a (aceite do humano) | done | deployed | passed | nÃ£o | nÃ£o |
| INC-20260130-0128-01 | `docs/inbox/done/INC-20260130-0128-01.md` | P0 | conveniente | Abrir Todos nÃ£o iniciava com 0 browsers | nurseTick fazia early-return quando controllers=0 mesmo com desired.active/_openAll | CT: desired active=28/28 + controllersCount=0; fix commit 035fa92 | done | deployed | passed | nÃ£o | sim |
| INC-20260130-0001-01 | `docs/inbox/done/INC-20260130-0001-01.md` | P0 | conveniente | Abrir Todos: 2Âº clique dava open_all_lock_busy | endpoint nÃ£o era idempotente; faltava feedback; stale lock precisava auto-recover | painel alert + payload alreadyRunning + lockOwner | done | not_deployed | not_run | nÃ£o | sim |
| INC-20260129-2100-01 | `docs/inbox/done/INC-20260129-2100-01.md` | P1 | sitechatbot+conveniente | conta do estoque fica â€œreservedâ€ mas nÃ£o provisiona (falhas em massa) | timeouts+busy+ACK lookup limitado; hardening+fallback | CT DB + ack files + provision_audit.jsonl | done | deployed_partial | not_run | nÃ£o | sim |
| INC-20260129-2058-02 | `docs/inbox/done/INC-20260129-2058-02.md` | P0 | conveniente | Fechar Todos reabre/lento; sobra navegador | painel fechava sem zerar desired.active; nurse reabria | provision_audit(close_all_*) + status snapshot | done | needs_restart | not_run | sim | sim |
| INC-20260129-2058-03 | `docs/inbox/done/INC-20260129-2058-03.md` | P1 | conveniente | Abrir Todos concorre/trava; auto-open no boot | open_all sequencial (nurse) + start-closed no boot (sem auto-open) | provision_audit(open_all*) + desired/status | done | needs_restart | not_run | sim | sim |
| INC-20260129-2058-04 | `docs/inbox/done/INC-20260129-2058-04.md` | P1 | conveniente | GovernanÃ§a de concorrÃªncia (login/identity/open/ram) | permits por tipo (login_remediate/identity_flow) integrados ao supervisor + TTL anti-leak + busy sem travar | CT status snapshot (RM4) + novos eventos do supervisor (permit_*) + provision_audit(governor_denied) | done | needs_restart | not_run | nÃ£o | nÃ£o |
| INC-20260129-2340-01 | `docs/inbox/done/INC-20260129-2340-01.md` | P1 | conveniente | Abrir Todos abre sÃ³ 26/28; fica parado; sem progresso; nÃ£o libera Robe/Virtus | pending â€œimpossÃ­veisâ€ por RAM mantinham keepalive do open_all_map; Virtus ficava pausado indefinidamente | CT: fetch_logs(status+desired+provision_audit) (RM4) requestId=0ea405...; perfis faltantes + pause_tick | done | needs_restart | not_run | nÃ£o | sim |
| INC-20260130-0005-01 | `docs/inbox/done/INC-20260130-0005-01.md` | P1 | conveniente | Invocar Humano: melhorar mini painel (HUD) com aÃ§Ãµes Ãºteis (fechar/pause24h/excluir) | HUD via exposeFunction; botÃµes chamam fluxos canÃ´nicos; humanControl isola o navegador | provision_audit(human_overlay_action_*) + teste em RM4 | done | needs_restart | not_run | nÃ£o | sim |
| INC-20260130-0023-01 | `docs/inbox/done/INC-20260130-0023-01.md` | P0 | conveniente+sitechatbot | RM3 recebeu conta do estoque mas nÃ£o cadastrou | falha no stock_provision por provision_lock_busy (lock de human_reconcile_login_form) | CT: cmdId+ack (ae137...) + self_update ack (07ea...) | done | needs_restart | not_run | sim | sim |
| INC-20260130-0047-01 | `docs/inbox/done/INC-20260130-0047-01.md` | P1 | conveniente | RM4: sistema fica em â€œmodo leveâ€ (slowmode) | governor autoMode: sai de full sÃ³ se freeMB>=3072 e lag<=exit; light pausa robeTickGlobal e deixa Virtus mais lento | CT status snapshot (RM4) + cÃ³digo worker/virtus | done | not_applicable | not_applicable | nÃ£o | nÃ£o |
| INC-20260130-0103-01 | `docs/inbox/done/INC-20260130-0103-01.md` | P0 | sitechatbot+conveniente | CT estoque/servidores â€œliberar todosâ€ causou liberaÃ§Ã£o indevida de cooldowns do Robe | endpoint CT acoplado a `robes_release_all` + stock_provision falhando por pause_timeout | CT commands.log/ack + ack details RM3 | done | needs_restart | not_run | nÃ£o | sim |
| INC-20260130-0148-01 | `docs/inbox/done/INC-20260130-0148-01.md` | P1 | conveniente | Governor light/full: thresholds e comportamento | entrar/sair por 2GB; ajustar lag; light nÃ£o â€œmataâ€ Robe; recovery leve com rate limit | worker.js autoMode (env CT_GOV_*) + commits+acks | done | needs_restart | not_run | nÃ£o | sim |
| INC-20260130-0205-01 | `docs/inbox/done/INC-20260130-0205-01.md` | P0 | conveniente | Governor light/full: evitar escadinha e resetar de forma correta | janelas 5min/30min + hard reset total; sem fechar 1 navegador | commit d8a3abc + self_update acks | done | needs_restart | not_run | nÃ£o | sim |
| INC-20260130-0227-01 | `docs/inbox/done/INC-20260130-0227-01.md` | P0 | conveniente | Crash no boot apÃ³s restart | `Illegal break statement` em `scripts/worker.js` | log do boot + commit f243902 | done | needs_restart | not_run | nÃ£o | sim |
| INC-20260130-0219-01 | `docs/inbox/done/INC-20260130-0219-01.md` | P0 | conveniente | Governor: somente RAM + telemetria 48h | RAM-only + snapshots 1/min; sem reset/fechar/abrir | commits 3e32a40/afc019a + coleta RM5 via fetch_logs | done | deployed_partial | not_run | nÃ£o | sim |

### PolÃ­tica ultra-rÃ­gida (enterprise) â€” como o INBOX funciona

Regra do jogo: **INBOX Ã© um sistema de tickets** (nÃ£o um chat). Cada relato vira ticket(s) e cada ticket vira um arquivo `INC-...md`.

1) **1 texto â†’ N itens â†’ N arquivos**
   - Sempre que o humano mandar â€œtriagem inboxâ€ (textÃ£o ou nÃ£o), o GPT:
     - cola no `RAW_INPUT`
     - quebra em itens
     - para cada item cria um `docs/inbox/INC-...md` separado
     - registra cada item na tabela `TRIAGE` com link para o arquivo.

2) **WIP limit = 1 (um por vez)**
   - SÃ³ pode existir **1** item com state `in_progress` por vez.
   - Se houver vÃ¡rios itens, o GPT escolhe 1 (por P0/P1 e impacto) e **sÃ³ muda de item quando o anterior estiver `done`**.

3) **Status Ãºnico e rastreÃ¡vel (sem achismo)**
   - **state do INC**:
     - `new`: criado, ainda nÃ£o alinhado.
     - `need_alignment`: faltam perguntas (â€œcomo deveria serâ€ / â€œcritÃ©rio de sucessoâ€).
     - `need_evidence`: precisa coletar logs/CT antes de mexer.
     - `in_progress`: investigando/alterando (WIP=1).
     - `done`: o GPT jÃ¡ fez o melhor trabalho possÃ­vel (cÃ³digo/docs/deploy se aplicÃ¡vel). Pode faltar restart/teste â€” isso vai em `rollout/validation`, nÃ£o aqui.
     - `cancelled`: descartado conscientemente (com justificativa).
   - **rollout/validation**:
     - rollout `needs_restart` NÃƒO impede `done`; apenas indica que â€œa prescriÃ§Ã£o ainda nÃ£o foi aplicada em runtimeâ€.
     - validation `not_run` Ã© normal; se der ruim depois, isso vira **novo INC** (novo relato), referenciando este.

4) **EvoluÃ§Ã£o contÃ­nua dentro do arquivo do INC**
   - O arquivo `INC-...md` deve ser â€œvivoâ€: toda evidÃªncia nova, descoberta, decisÃ£o, e patch aplicado entra ali.
   - Quando fecha (`done`), o arquivo fica como â€œpostmortemâ€/histÃ³rico.

5) **Fechamento (modelo â€œmÃ©dicoâ€)**
   - Para marcar `done`, basta: o GPT entregou a melhor soluÃ§Ã£o possÃ­vel (cÃ³digo/docs e, quando possÃ­vel, deploy).
   - Restart/teste nÃ£o bloqueiam `done`: viram `rollout=needs_restart` e `validation=not_run`.
   - Se o problema persistir/voltar: cria-se um **novo** INC (novo relato), citando o INC anterior como histÃ³rico.

6) **OrganizaÃ§Ã£o por pastas (status fÃ­sico)**
   - Ao criar um INC: salvar em `docs/inbox/in_progress/INC-...md`
   - Ao marcar `need_evidence`: mover para `docs/inbox/need_evidence/INC-...md` (aguardando evidÃªncia/decisÃ£o; nÃ£o Ã© WIP ativo)
   - Ao marcar `done`: mover para `docs/inbox/done/INC-...md` (mesmo que rollout/validation estejam pendentes)
   - Ao marcar `cancelled`: mover para `docs/inbox/cancelled/INC-...md`
   - O `docs/inbox/INDEX.md` e a tabela `TRIAGE` devem apontar para o caminho correto (sem link quebrado).

---

### ITEM: INC-20260129-2100-01 â€” Estoque: â€œreserved mas nÃ£o vaiâ€ (provision)

- **P**: P1 (pode virar P0 se voltar a travar em produÃ§Ã£o)
- **Sistema**: `sitechatbot` (estoque/CT) + `conveniente` (executor do provision)
- **Sintoma (humano)**: conta fica reservada no estoque, mas o provision falha e a conta nÃ£o â€œandaâ€; ocorreu em mÃºltiplos servidores; depois de updates, RM4 conseguiu provisionar 1 conta.
- **Como deveria ser (humano)**: (pendente â€” perguntar)
- **CritÃ©rio de sucesso (humano)**: (pendente â€” perguntar)
- **HipÃ³teses (GPT)**:
  - H1: hook do CT em `/api/commands/ack` nÃ£o encontra o job do `stock_provision` (busca limitada via `listJobs(limit=200)`), entÃ£o nÃ£o atualiza job e nÃ£o libera `reserved`.
  - H2: `details.results` do ACK nÃ£o carrega info suficiente (ex.: `profileName`/`stockAccountId`) para o CT decidir `assigned` vs `release` corretamente em falhas.
  - H3: guard `provision_guard` estÃ¡ rodando mas nÃ£o consegue resolver rapidamente (TTL alto / janela grande), gerando â€œpresasâ€ temporÃ¡rias.
- **EvidÃªncia a coletar (GPT)**:
  - CT DB: contas `reserved` + jobs `provision` `running` (sem imprimir login/senha/cookies).
  - ACK evidence: `sitechatbot/dados/logs/<hostId>/ack_<cmdId>.json` para `stock_provision` (verificar `details.results` e erros).
  - Servidor executor (RM4): `fetch_logs_query` em `provision_audit` por `stock_provision_action_fail` (sem secrets).
- **Arquivos provÃ¡veis**:
  - `C:\sitechatbot\index.js` (hook `/api/commands/ack` para `stock_provision`)
  - `C:\sitechatbot\convenientetecnologia\lib\ctFbStock.js` (jobs/accounts + reserve/release/guards)
  - `C:\conveniente\scripts\dashboard.js` (`execStockProvision` e formato de `results` no ACK)
- **Mapa de impacto (obrigatÃ³rio)**:
  - **Fluxo ponta a ponta (alto nÃ­vel)**: UI/Agendador CT â†’ cria job (DB) + reserva conta â†’ `enqueueCommand(stock_provision)` â†’ host executa `execStockProvision` â†’ ACK no CT â†’ CT atualiza job + conta (assigned/release).
  - **Estados tocados**:
    - CT: `ct_fb_stock_jobs`, `ct_fb_stock_accounts` (+ audit)
    - Host: `provision_audit.jsonl`, `desired.json`, `perfis.json`, `status.json` (durante provisÃ£o)
  - **Risco de regressÃ£o**: mexer em hook de ACK pode alterar transiÃ§Ãµes do estoque; mitigaÃ§Ã£o: mudanÃ§a mÃ­nima, idempotente, com fallback safe e audit log.
- **HistÃ³rico relacionado (obrigatÃ³rio)**:
  - Timeline: (preencher apÃ³s coletar evidÃªncia do dia 29/01 e commits relacionados)
- **Plano (mudanÃ§a mÃ­nima)**:
  - trocar lookup do job por `command_id` para query direta (nÃ£o limitada por `listJobs(limit=200)`).
  - adicionar fallback seguro: se job nÃ£o for encontrado, ainda assim liberar reserva com base em `details.results[*].stockAccountId` quando falhou sem criaÃ§Ã£o de perfil.
  - registrar audit local quando ocorrer â€œjob nÃ£o encontradoâ€ (para nunca mais virar achismo).
- **Precisa reiniciar agora?** nÃ£o
- **Precisa reiniciar para validar/testar?** depende (CT sim; hosts nÃ£o necessariamente)

ObservaÃ§Ã£o (organizaÃ§Ã£o):
- O â€œRAW_INPUTâ€ acima Ã© **temporÃ¡rio** (entrada).
- ApÃ³s triagem, o incidente vira um arquivo prÃ³prio em `C:\conveniente\docs\inbox\INC-....md` e o RAW_INPUT volta a ficar vazio.
- Ãndice: `C:\conveniente\docs\inbox\INDEX.md`.

## ITEM TEMPLATE (copiar/colar por item)

### ITEM: INC-YYYYMMDD-HHMM-XX â€” TÃ­tulo curto

- **P**: P?
- **Sistema**: conveniente / sitechatbot / notificador
- **Sintoma (humano)**:
- **Como deveria ser (humano)**:
- **CritÃ©rio de sucesso (humano)**: (ex.: â€œclicou â†’ em X segundos tudo fechado e nada reabre por Y segundosâ€)
- **ReproduÃ§Ã£o (se existir)**: (passos simples)
- **HipÃ³teses (GPT)**:
  - H1:
  - H2:
- **EvidÃªncia a coletar (GPT)**:
  - logs_manifest (hostId=â€¦)
  - fetch_logs(keys=â€¦)
  - cmdId/requestId (se aplicÃ¡vel)
- **Arquivos provÃ¡veis**:
  - `...`
- **Mapa de impacto (obrigatÃ³rio)**:
  - **Fluxo ponta a ponta (alto nÃ­vel)**: (ex.: CT â†’ dashboard.applyCommands â†’ endpoint â†’ worker â†’ arquivo/estado)
  - **Callers** (quem chama esse fluxo):
    - â€¦
  - **Callees** (o que esse fluxo aciona):
    - â€¦
  - **Estados tocados**: `desired.json` / `status.json` / `perfis.json` / manifests / locks / timers
  - **Efeitos colaterais possÃ­veis**:
    - â€œX pode religar Yâ€ (ex.: nurse/desired/virtus)
  - **Risco de regressÃ£o** (1 frase) + **mitigaÃ§Ã£o** (1 frase)
- **HistÃ³rico relacionado (obrigatÃ³rio)**:
  - **Timeline**: cite as entradas relevantes de `docs/TIMELINE.md` (data + tÃ­tulo).
  - **Hotspots/arquivos**: cite quais arquivos aparecem no `docs/checkups/file_timeline/` e por quÃª.
  - **HipÃ³tese de regressÃ£o**: â€œisso pode ter comeÃ§ado apÃ³s mudanÃ§a Xâ€ (com evidÃªncia).
- **Plano (mudanÃ§a mÃ­nima)**:
  - â€¦
- **Precisa reiniciar agora?** sim/nÃ£o â€” por quÃª
- **Precisa reiniciar para validar/testar?** sim/nÃ£o â€” por quÃª
- **ValidaÃ§Ã£o**:
  - endpoint/log esperado
- **Rollback**:
  - `git revert` + (se for validar rollback) reiniciar `node index.js`

---## RAW_INPUT — 2026-02-14 (pedido de “fase 2”: atomicidade + duplicação zero)

```text
(humano)

Quero fechar os 2 INCs de wipe (RM2 e RM6) porque já varremos todos os servidores (RM1..RM7) e agora quero começar
uma fase nova “ultra enterprise”:1 - cadastro de contas nunca em hipótese alguma zerar perfis
2 - nada, em hipótese alguma zerar perfis
3 - usar a pasta perfis para registrar mais coisas referente aos perfis, como um banco secundário perfeito:
    - registrar UA, fp, login/senha, datas e histórico (sem o sistema usar isso como verdade)
    - servir como fallback/recovery caso perfis.json suma
    - registrar exclusão pendente e fazer auto-retry de limpeza no boot/periodicamente (se falhar por lock)
    - mas NUNCA usar a pasta perfis como fonte da verdade para o dashboard, para não ressuscitar lixo
4 - investigação forense: por que está dando conta duplicada:
    - duplicada nos servidores
    - duplicada entre servidores
    - duplicada no CT em uso
   Quero saber tudo, resolver ponta a ponta de modo atômico:
    - conta do estoque -> 1 servidor só, nunca 2
    - CT registrar em uso perfeito, e exclusão perfeita também

Quero abrir um INC novo pra isso, fechar os 2 INCs antigos, e garantir que agora está tudo perfeito pra liberar
cadastro urgente sem surtar.
```### TRIAGE — 2026-02-14| item | P | título | status | links |
|---|---|---|---|---|
| 1 | P0 | Fechar INCs antigos de wipe (RM2/RM6) como superseded | done | `docs/inbox/cancelled/INC-20260212-0315-01.md`, `docs/inbox/cancelled/INC-20260213-1200-01.md` |
| 2 | P0 | PROGRAMA ÚNICO: cadastro sem duplicação (CT estoque -> servidor -> CT em uso) | done | `docs/inbox/done/INC-20260214-0900-01.md` |
| 3 | P0 | INCs auxiliares (0910/0920) fundidos no programa único | done | `docs/inbox/cancelled/INC-20260214-0910-01.md`, `docs/inbox/cancelled/INC-20260214-0920-01.md` |
| 4 | P1 | Fase 2 (0930/0940/0950/1000/1010) reclassificada após estabilizar cadastro | done | `docs/inbox/cancelled/INC-20260214-0930-01.md`, `docs/inbox/cancelled/INC-20260214-0940-01.md`, `docs/inbox/cancelled/INC-20260214-0950-01.md`, `docs/inbox/cancelled/INC-20260214-1000-01.md`, `docs/inbox/cancelled/INC-20260214-1010-01.md` |
| 5 | P0 | BLINDAGEM FINAL: hardening anti-regressão (H1/H2/H3) | done | `docs/inbox/done/INC-20260214-1020-01.md` |

---## RAW_INPUT — 2026-02-15 (RM1: Robe postar / Marketplace “tela preta”)```text
triagem inbox

robe mae 1estamos com o seguinte problema, quando o robe vai postar , na aba zero ta rodando o virtus daquela conta, dai cheag a hora do robe postar, ele abre aba 1 facebook criar item , a tela ta ficando pretao robe abre a aba 1 naveag para a pagina correta, ta tudo perfeito, ta indo pra pagina correta, as vezes consegue colocar foto, mas é muito raro, as vezes consegue colocar titulo, as vezes na foto ele ta ficando tela preta, as vezes no titulo, e em casos muito raros ele consegue chegar no preço, mas é muito rarogeralmente ja ta dando tela preta logo apos acessar a pagina, a pagina do criar item aparece, mas fica preta em seguida

temos essa conta aqui la no rm1 pra gente testar[001] Alex Santana
ID: maringa-1759198592235
Cidade: Marabá
```### TRIAGE — 2026-02-15| item | P | título | status | links |
|---|---|---|---|---|
| 1 | P0 | RM1: Robe postar (Marketplace) — tela preta residual e retentativa não determinística | need_evidence | `docs/inbox/need_evidence/INC-20260215-1100-01.md` |
| 2 | P0 | RM3: Virtus Offline com Messenger saudável (`loginRequired=probe_failed`) | done | `docs/inbox/done/INC-20260203-1800-01.md` |
| 2 | P0 | RM3: Virtus Offline com `loginRequired=probe_failed` e abas inconsistentes | done | `docs/inbox/done/INC-20260203-1800-01.md` |

---## RAW_INPUT — 2026-02-16 (RM3: degradação de RAM ao longo das horas)```text
triagem inbox

criar inc

robe mae 3

acabei de reiniciar o robe mae 3, cliquei em abrir todos, ele ficou total 120, ativos 120 e trabalhando 118.
no CT servidores apareceu ~11gb de ram livre, mas nas próximas horas isso cai para ~2gb e o sistema entra em modo destrutivo
(fecha navegador, para trabalho, tenta sobreviver).

dor principal: entender com prova por que a RAM degrada com o tempo mesmo com parque parecido de contas abertas.
objetivo: controle total de memória, usar só RAM necessária, evitar acúmulo e manter operação estável.
```### TRIAGE — 2026-02-16| item | P | título | status | links |
|---|---|---|---|---|
| 1 | P0 | RM3: queda progressiva de RAM após boot (~11GB -> ~2GB) com entrada em modo defensivo | need_evidence | `docs/inbox/need_evidence/INC-20260216-1600-01.md` |
| 2 | P0 | RM3: Virtus Online/Offline em convergência pós-fix (monitoramento de estabilidade) | done | `docs/inbox/done/INC-20260203-1800-01.md` |
| 3 | P0 | RM1: tela preta residual em postagem (reabertura para evidência) | need_evidence | `docs/inbox/need_evidence/INC-20260215-1100-01.md` |
| 4 | P0 | RM4: Robe login_required com Messenger saudável (loop de flag sem convergir) | need_evidence | `docs/inbox/need_evidence/INC-20260216-1930-01.md` |

---

## RAW_INPUT — 2026-02-17 (RM6: about:blank + loginRequired inconsistente)

```text
triagem inbox

abrir inc robe mae 6

[005] Igor Barbosa
ID: campina_grande-1769232949697
Navegador Ativo
Virtus Offline
Login requerido
Robe pronto/idle

observação humana:
- aba zero messenger saudável
- estado continua login requerido + virtus offline
- existem 2 contas "Davi" com aba 1 about:blank (sem invocar humano para preservar estado real)
```

### TRIAGE — 2026-02-17

| item | P | título | status | links |
|---|---|---|---|---|
| 1 | P0 | RM6: about:blank + loginRequired inconsistente com Messenger saudável (Virtus Offline indevido) | done | `docs/inbox/done/INC-20260217-1450-01.md` |

---## RAW_INPUT — 2026-02-19 (novo modelo operacional de leads por sorteio e cobrança)```text
triagem inbox novo inc

objetivo macro:
- mudar o método de operação para "pay-per-lead" com sorteio;
- manter tudo ultra organizado/documentado antes de codar;
- não executar mudanças agora, só triagem/análise e registro.

requisitos relatados (resumo bruto; histórico — pode ficar desatualizado se houver adendo):
1) pedido chega pelo número de entrada e hoje vai aos grupos com contato do cliente; novo fluxo deve ocultar contato e enviar link com código.
2) motorista clica no link, fala no número de operação e entra numa janela de 2 minutos.
3) após 2 minutos, ganha quem tem menos leads; empate decide por ordem de chegada; só 1 recebe contato completo do cliente.
4) criar "banco" no cadastro do motorista para registrar leads ganhos e débito por lead.
5) (histórico) cobrança automática via Asaas (boleto/pix) e bloqueio por pendência — ver **Adendo de regra** logo abaixo para a regra atual.
6) permitir ajustes manuais no banco (abatimento, desconto, zerar, renegociar, reemitir cobrança).
7) motorista com dívida recebe opção pagar/falar com financeiro; sem cadastro recebe opção cadastrar/falar com administrativo; atendimento deve ir para chat interno.
8) rollout controlado: começar com 3 grupos piloto; restante continua legado até aprovação.
9) necessidade de testes E2E completos e simulações antes de liberar o piloto.
10) pedido explícito de documentação total e operação sem achismo.
```

Adendo de regra (2026-02-19, atualização humana):
- cobrança passa a ser diária em dias úteis às 08:00;
- bloqueio por inadimplência passa para 15:00 do mesmo dia;
- competência de cobrança: segunda cobra leads de sexta/sábado/domingo + segunda; terça cobra segunda; quarta cobra terça; quinta cobra quarta; sexta cobra quinta.
- janela operacional humana: segunda a sexta, 10:00–17:00.

Adendo de regra (2026-03-03, atualização humana):
- emissão de cobrança: **segunda e quinta às 22:00**;
- vencimento/bloqueio por inadimplência: **quinta e segunda às 10:00** (ciclo seguinte ao da emissão);
- competência: corte no instante real da emissão (scheduler após 22:00).

Adendo de rollout (2026-02-20, atualização humana):
- piloto ajustado para 5 grupos/cidades: Ipatinga (MG), Montes Claros (MG), Foz do Iguaçu (PR), Fortaleza (CE), Petrolina (PE).

### TRIAGE — 2026-02-19

| item | P | título | status | links |
|---|---|---|---|---|
| 1 | P0 | Programa macro: novo modelo de leads por sorteio + cobrança por uso | in_progress | `docs/inbox/need_evidence/INC-20260219-0900-01.md` |
| 2 | P0 | Webhook dual + distribuição anônima + link tokenizado | done | `docs/inbox/need_evidence/INC-20260219-0910-01.md` |
| 3 | P0 | Sorteio 3min (menor consumo + desempate por chegada) | done | `docs/inbox/need_evidence/INC-20260219-0920-01.md` |
| 4 | P0 | Banco/ledger do motorista (leads, débitos, ajustes) | done | `docs/inbox/need_evidence/INC-20260219-0930-01.md` |
| 5 | P0 | Cobrança Asaas diária (seg-sex 08:00) + bloqueio 15:00 + baixa automática | done | `docs/inbox/need_evidence/INC-20260219-0940-01.md` |
| 6 | P1 | Atendimento financeiro/administrativo no WhatsApp integrado ao CT | need_alignment | `docs/inbox/need_evidence/INC-20260219-0950-01.md` |
| 7 | P0 | Rollout controlado por grupo (piloto em 5 grupos) | done | `docs/inbox/need_evidence/INC-20260219-1000-01.md` |
| 8 | P0 | Plano de testes E2E e critérios Go/No-Go | done | `docs/inbox/need_evidence/INC-20260219-1010-01.md` |
| 9 | P0 | Segurança: rotação de credencial exposta no relato | accepted_risk_by_owner | `docs/inbox/need_evidence/INC-20260219-1020-01.md` |

---

## RAW_INPUT — 2026-02-20 (continuidade e segurança: GitHub para sitechatbot/notificador)```text
precisamos abrir um INC para publicar os projetos sitechatbot e notificador no GitHub com segurança.contexto:
- servidor "notificador" roda sitechatbot + ngrok + notificador;
- hoje há repos no GitHub para conveniente e site;
- ainda não há repos para sitechatbot e notificador;
- objetivo é segurança/continuidade (evitar risco de backup local único).

pedido:
- não publicar agora;
- abrir dossiê completo, auditável e enterprise para essa publicação.
```

### TRIAGE — 2026-02-20

| item | P | título | status | links |
|---|---|---|---|---|
| 1 | P0 | Publicação segura de `sitechatbot` e `notificador` no GitHub (dossiê + plano) | in_progress | `docs/inbox/need_evidence/INC-20260220-2230-01.md` |

Adendo (2026-02-20, decisão humana):
- pivot de estratégia: em vez de GitHub neste momento, priorizar backup completo no drive privado (acesso exclusivo do owner), com sincronização contínua e plano de restore/disaster recovery.

---

## RAW_INPUT — 2026-03-02 (justiça no sorteio: contestação não pode “zerar” vantagem)

```text
triagem inbox

criar novo inc

temos apos o sorteio a possibilidade de contestação. em alguns casos devolve o pedido pro grupo e estorna o valor ao motorista, isso está perfeito.

problema:
- ao contestar, o lead “some” da contagem de leads daquele motorista para fins de sorteio.
- com isso, o mesmo motorista pode ganhar de novo logo em seguida e ficar “escolhendo” pedidos (ganha -> contesta -> ganha -> contesta).
- isso deixa injusto, porque contestar (mesmo sendo válido) vira uma vantagem no sorteio.

necessidade (regra alvo):
- contestar deve devolver o crédito/cobrança, mas deve continuar contando internamente como “lead pego” para fins de justiça do sorteio (na rodada vigente).
- ao pagar o boleto (fechar a rodada), tudo zera.

explicação desejada:
- contagem do sorteio deve considerar:
  1) lead que ele ganhou
  2) lead que ele contestou
  3) leads que estão em boleto em aberto (rodada vigente)

efeito esperado:
- quem paga boleto zera e passa a ter preferência (menos “carga”).
- quem contesta não ganha vantagem no sorteio (a contagem de “carga” permanece).
```

### TRIAGE — 2026-03-02

| item | P | título | status | links |
|---|---|---|---|---|
| 1 | P1 | Sorteio justo: contestação estorna dinheiro mas mantém “carga” no ranking até pagamento | need_alignment | `docs/inbox/need_evidence/INC-20260302-1500-01.md` |

---

## RAW_INPUT — 2026-03-03 (auditoria contas excluídas RM1..RM7 em 24/48/72/96h)

```text
triagem inbox

aqui preciso de atenção extrema sua

preciamos trablahar aqui de forma ultra enterprise melhor do mundo ultra mlehor do mundo agora

eu preciso de dados das ultimas 24 horas, 48 horas, 72 horas 96 horas

preciso da seguinte questao, preciso dessas informaçoes do robe mae 1 2 3 4 5 6 7

quero essa ultra auditoria melhor do mundo pra humano burro entender

eu preciso saber as seguintes questoes

preciso saber quantas contas cairam, fora excluidas dos servidores nesse periodo

o que preciso saber ultra detalhado é

data de cadastro da conta no estoque, data do cadsatro da conta no servidor, e data da exclusão da conta

aqui to querendo a melhor ultra auditoria do mundo, quero saber quantas contas cairam nesse periodo, se sao contas novas, que foram cadastradas no estoque recenemnte quando que foram, quando que foram cadastradas no serviodr, e quando que elas foram excluidas

porque como eu tenho 3 tipos de contas, quero saber que contas que sao as que estao sendo excluidas, preciso desse ultra enteprise melhor dossie do mundo de auditoria perfeita pra eu saber o que ta acontecendo, pode fazer o melhor do mundo, nao é pra mexer em nada quero apenas o melhor ultra relatorio do mundo, se quiser fazer um arquivo e registrar isso em um arquivo, so me diz onde ta o arquivo no final, isso precisa ser perfeito
```

### TRIAGE — 2026-03-03

| item | P | título | status | links |
|---|---|---|---|---|
| 1 | P1 | Auditoria forense de exclusões RM1..RM7 (24h/48h/72h/96h) | done | `docs/inbox/done/INC-20260303-1755-01.md` |

---

## RAW_INPUT — 2026-03-05 (continuidade Chromium + blindagem + ngrok)

```text
agora a princpio ta abrindo perfeito

vamos abrir um inc novo perfeito pra blindagem total do navegador, em need evidence, e debater antes de codar

agora temos esse inc do chromium pra terminar

também vamos abrir um inc do ngrok e travamentos; começou agora e está comprometendo o sistema todo

itens:
1 - inc do chromium que já estamos trabalhando
2 - abrir inc da blindagem total perfeita do navegador
3 - abrir inc do ngrok e travamentos para investigação forense (limite ngrok, porta, código ou outro fator)
```

---

## RAW_INPUT — 2026-03-05 (RM7 canário + estancar queda de contas)

```text
precisamos congelar mudanças de engine e focar em resultado imediato de queda de contas.

meta humana:
- rm7 lotado e janela de 24h com no máximo 2 contas caídas.
- 6 quedas em um dia é tragédia operacional.

contexto humano:
- no dolphin/adspower a queda era muito menor;
- no conveniente houve ganho enorme de automação, porém queda de contas em cascata;
- decisão: usar RM7 como cobaia e instrumentar nas entranhas para saber causa real de cada queda.

pedido:
- auditoria ponta a ponta sem achismo;
- dossiê pré-código ultra detalhado;
- instrumentação “olhos de deus” para timeline por conta (últimas horas) e análise causal quando cair.
```

### TRIAGE — 2026-03-05 (adendo blindagem RM7)

| item | P | título | status | links |
|---|---|---|---|---|
| 1 | P0 | Blindagem total RM7 canário (instrumentação forense máxima + estabilidade + meta <=2 quedas/24h) | need_evidence | `docs/inbox/need_evidence/INC-20260305-1815-01.md` |

---

## RAW_INPUT — 2026-03-18 (Serviço de Lead — menu de serviços pós-frete)

```text
triagem inbox

atualização: Serviço de Lead — aproveitamento de lead do frete

Contexto atual:
- Virtus faz atendimento no zap API do Virtus
- 3 casos em que o sistema envia texto final pro cliente:
  1. quando cliente responde todas as perguntas
  2. timeout
  3. no meio do chat cliente pede pra ser direcionado para o motorista

Texto atual (encerramento):
"Em instantes um motorista vai chamar você aqui no WhatsApp com o orçamento.
Enquanto isso, você também pode participar do nosso grupo gratuito no WhatsApp SUPER DESCONTOS..."

Nova proposta (complementar):
- Texto novo com menu de serviços (botão WhatsApp API — menu até 10 itens)
- 10 opções: Internet residencial, Montador de móveis, Limpeza pós-mudança, Instalação ar-condicionado, Dedetização, TV assinatura, Segurança residencial, Seguro residencial, Seguro veículo, Energia solar
- Quando cliente seleciona um item: sistema envia mensagem amigável (profissional vai entrar em contato) + reenvia menu (texto só) pra ver se quer mais algum serviço
- Ao selecionar serviço e enviar: sistema agradece

Novo menu no CT: "Serviço de Lead"
- Registrar: telefone, cidade, serviço que cliente pediu
- Dados: telefone e cidade da API Virtus (mesma cidade do pedido de frete); serviço vem da escolha do cliente
- Usuário vai ficar de olho no CT pra trabalhar os leads

Regra: NÃO codar ainda. Primeiro registrar tudo, auditar ponta a ponta, fazer dossiê pré-código ultra enterprise.
```

### TRIAGE — 2026-03-18 (Serviço de Lead)

| item | P | título | status | links |
|---|---|---|---|---|
| 1 | P0 | Serviço de Lead: menu de 10 serviços pós-frete + CT "Serviço de Lead" | need_evidence | `docs/inbox/need_evidence/INC-20260318-1000-01.md` |

Dossiê pré-código: `docs/checkups/checkup_2026-03-18_dossie_pre_codigo_servico_lead.md`

---

## RAW_INPUT — 2026-03-06 (baixa de boleto nao ocorreu)

```text
criar inc

nao vamos codar nada ainda, so registrar e investigar:

- alguns casos pagaram boleto e baixaram automatico;
- outro caso pagou no banco, mas nao houve baixa no sistema;
- cliente: Marcos Paulo (Florianopolis e Balneario Camboriu), ativo;
- nao aplicar baixa agora; primeiro entender causa real;
- descobrir se foi webhook nao recebido/processado, erro interno ou outro fator;
- objetivo: blindar baixa automatica com qualidade enterprise sem metodo burro de polling.
```

### TRIAGE — 2026-03-06

| item | P | título | status | links |
|---|---|---|---|---|
| 1 | P0 | Baixa Asaas não aplicada para motorista pago (forense sem baixa manual) | done | `docs/inbox/need_evidence/INC-20260306-1100-01.md` |
| 2 | P0 | Reemissão de boleto aumentou após remoção de leads (R$50,00 -> R$58,67) | done | `docs/inbox/need_evidence/INC-20260306-1143-01.md` |

---

## RAW_INPUT — 2026-03-06 (queda em cascata + bloqueio temporario por uso indevido)

```text
reiniciado

tem algo muito errado no runtime:
- varias contas mostrando "Você está bloqueado temporariamente" + "recurso usado de forma indevida"
- hipótese humana: sistema entrou em ações rápidas/loop/pânico (ex.: reload/retry infinito ou navegação descontrolada)
- percepção: agravou após entrada de automações de cadastro automático + login_required + captcha + identidade
- sinais em outros servidores também, não só RM7
- objetivo: investigação forense completa até achar o gatilho exato de rajada/loop
- regra: sem achismo; mapear evidência real com timeline por perfil
```

---

## RAW_INPUT — 2026-03-26 (CT: cadastro em teste "sumiu")

```text
sidney dias telefone 13974118730 cidade santos

tem esse cadastro no ct sistema interno, que foi criado pra ele um teste e tudo mais, mas ele nao ta aparecendo nem em testes em andamento nem testes encerrados, parece que sumiu nao sei, e isso é um problema serio e grave , porque assim ele fica em teste pra sempre e agente nunca cobra ele pra saber se ele quer continuar ou nao
```

### TRIAGE — 2026-03-26 (CT testes)

| item | P | título | status | links |
|---|---|---|---|---|
| 1 | P0 | CT: driver em status `test` sem registro em `ct_tests` (não aparece em andamento/encerrados) | in_progress | evidência: `sitechatbot/dados/convenientetecnologia.sqlite` (`ct_drivers.id=1853`, `ct_tests` vazio) |

### TRIAGE — 2026-03-06 (bloqueio temporario por uso indevido)

| item | P | título | status | links |
|---|---|---|---|---|
| 1 | P0 | RM7 e demais hosts: identificar loop/rajada que induz "bloqueado temporariamente" | in_progress | `docs/inbox/need_evidence/INC-20260305-1815-01.md` |

---

## RAW_INPUT — 2026-03-30 (CT: exclusão de cobrança não atômica)

```text
certo, vamos la, aqui atenção utlra enteprise extrema melhor do mundo

eu fui no ct no cadastro excluir boleto, so consegui excluir na quarta tentativa, nao ta atomivo perfeito isso aqui

Leo Junior de Piracicaba

e desse aqui nao consegui excluir, tem algo de muito errado que nao ta certo

Rohsael - Caruaru

isso precisa ser atomico ultra entperis emelhor perfeito do mundo 110%
```

### TRIAGE — 2026-03-30 (CT: cancelamento/exclusão de cobrança)

| item | P | título | status | links |
|---|---|---|---|---|
| 1 | P0 | CT: “Excluir cobrança” exige múltiplas tentativas (transiente Asaas / falta de retry/estado) — Leo Junior (Piracicaba) | in_progress | evidência: `C:\sitechatbot\convenientetecnologia\lib\ctLeadLedgerStore.js` (`cancelInvoice`) + logs/ct_events (a coletar) |
| 2 | P0 | CT: “Excluir cobrança” falha e não cancela — Rohsael (Caruaru) | in_progress | evidência: logs/ct_events (a coletar) + estado do invoice no SQLite (a coletar) |

---

## RAW_INPUT — 2026-04-05 (novo: Gateway/Proxy ISP com sticky por conta + CT controle total)

```text
triagem imbox

sistema conveniente com gateway de proxy com distribuição equilibrada e persistencia do mesmo proxy para a mesma conta

atualmente o sistema conveniente nao tem gateway ou uso de proxy, ou seja vamos mudar uma coisa muito importante no sistema

atualmente eu tenho varios servidores, vou te dar exemplo, o rm3 ele tem 64gb de ram e trabalha com ate 120 navegadores , e esse servidor ele ta conectado a 1 moldem ou seja 1 ip , e isso ta uma merda

agora quero fazer um sistema de gateway inteligente perfeito melhor do mundo onde vamos adquirir alguns proxys ISP , eu ja to vendo isso com uma empresa de proxy, a principio vou pegar 20 proxys assim que agente tiver configurado o sistema, mas vamos escalar isso a nivel ultra enterprise melhor do mundo podendo ter 40 50 70 proxys em breve, ou seja, isso vai precisar ser ultra perfeito

eu pensei em agente ter um menu la junto com os menus do ct

Sistema Interno
Cadastro, testes, repescagem, banidos e histórico
Servidores
Monitoramento em tempo real
Virtus
Painel de pedidos e grupos
Grupos
IDs, categorias, urgência e migrações
Contas
Lista por servidor/conta com problemas por categoria
Diagnósticos (GPT)
Auditoria, padrões e investigação de mudanças de DOM
Estoque
Importar contas (.txt), deduplicar e provisionar automaticamente por servidor/categoria
Site
Cidades no ar, links e métricas de acesso + cliques no WhatsApp
Contestação
Olhos de Deus das contestações: período, cidade, volume e qualidade
Serviço de Lead
Leads de serviços pós-frete: telefone, cidade e serviço escolhido

aqui ter um de Gateway , algo assim, onde la eu adiciono o proxye , sempre que remover ou adicionar novo proxy , o sistema ct faz o envio para os servidores começarem a usar

e redistribui igualitariamente ne

então o que eu pensei é, configurar o sistema conveniente pra usar proxy e isso preicsa ser ultra perfeito melhor do mundo , cada conta naveagdor precisa usar sempre o mesmo proxy, salvo quando o agente adicionar ou remover o proxy o ct avisa todos os servidores e eles se auto corrigem, mas em grosso modo, todos vao usar sempre um proxy fixo que o sistema definiu para aquela conta ne

pensei no painel gateway no ct, ter um botao do tipo , ativar proxyes então o ct envia isso para os servidores e a partir dai 110% dos servidores passam apenas a operar usando o proxy, se eu desativar pxoryes, os servidores passam a usar a rede normal deles, dai no caso vamos precisar que cada servidor seja possivel ativar ou desativar, por exemplo, ter um botao de ligar e desligar proxyes por exmeplo, e ter ao lado de cada servidor no ct ativar ou desativar o uso de proxy por aquele servidor, porque as vezes eu tenho o servidor instalado em um servidor de teste e nao quero que ele use os proxyes entende, dai eu consigo ligar proxyes, perfeito agora ta ligado proxys podendo os servidores usar, dai eu posso ativar ou desativar um servidor especificio se ele vai usar proxye ou nao, tudo ultra atomico perfeito, com confirmação no painel , algo como , eu clico em ligar, otimo proxy ta ligado, dai agora eu seleciono um servidor e clico em ativar, sistema ct faz envio dessa ifnormação pro srvidor, espera o servidor responder que deu tudo certo, e então sistema altera status daquele servidor pra gateway ON , algo assim , tudo isso precisa ser atomico perfeito

e la no servidor ele recebe todos os proxyes disponiveis define de forma igualitaria qual conta vai usar qual proxye, e vai usar aquele proxy pra aquela conta idefinidamente

caso eu adicione ou remova proxyes no ct gateway, isso é refletido no servidor, e ele se auto redistibui, mas isso precisa ser de forma inteligente, se tem 30 proxyes, e eu removi 5, o sistema nao precisa mudar os outros 25 proxyes das outras contas de forma burra, ele apenas precisa identificar quais as contas que estao sem proxy e dar proxyes fixo pra aquela conta de forma ultra intelignete melhor do mundo

se eu adicionar mais proxyes, ai sim, servidor precisa distribuir novamente os proxyes, de forma igualitaria ultra perfeito tambem de forma ultra inteligente tentando tocar o minimo em contas que ja tem proxy, so pra distribuição perfeita ne, se tem 100 naveagdores usando 10 proxyes, sao 10 naveagdeores usando o mesmo proxyes, se eu adicionar mais 10 proxyes, o sistema nao precisa reentregar tudo denovo pra todos, apenas escolhe 5 contas de cada proxyes pra mudar de proxy, mas as outras 5 mantem o mesmo ne

nao é dificil, o que eu quero é sistema conveniente no servidor ultra inteligente melhor do mundo ultra perfeito 110% perfeito usando sistema gateway com proxy ultra perfeito melhor do mundo sabendo distribuir e readequar sempre que necesssarios os proxyes de forma igualitaria nas contas daquele servidor tocando o minimo possivel nos proxyes das contas, e sempre o uso por naveagdor é fixo atomico para cada conta/proxye fixo perfeito

e no ct um menu onde eu tenha total ultra contorle perfeito do mundo pra adicoinar novos proxyes, remover proxyes, ligar e desligar uso de proxyes ativar ou desativar servidores especificos , se possivel monitoramento de proxy ruim que parou de funcionar enfim, quero um manu painel onde eu tenha 110% de perfeito controle pra administrar isso, adicionar novos proxyes e tudo mais, dai podendo adciionar proxyes em lote, tipo um local de adicionar proxy, dai ele abre outro menu e eu vou adicionando 1 a 1 , dai eu adiciono 10 proxyes por exemplo, e quando eu clicar em salvar, dai sim, o sistema salva os 10 de uma vez so, e ja faz envio para os servidores

tambem seria bom eu acho que ao inciiar um sistema node index.js no servidor, ele ja faz uma requisição pra saber sobre os proxyes se ta tudo certo, e tudo mais, se ele ta marcado la

tambem a questao de servidor novo, servidor novo se conectou, ele ja entra com proxy desativado daquele servidor, dai eu tenho que ir la e ativar ele, sempre servidor novo entra como desativado, tendo que fazer a ativação manual no ct, enfim deixar isso ultra melhor do mundo

como voce é 1 milhao de vezes mais inteligente do mundo, e voce tem acesso a todos os arquivos do sistema do conveniente e do sitechatbot, como voce tem acesso a tudo e conhece tudo, se tiver sugestoes debates, agora é hora de agente alinhar tudo deixar isso ultra perfeito melhor do mundo, nao vamos codar nada agora, vamos fazer auditoria de ponta a ponta, dossie ultra enterprise melhor do mundo antes de começar a codar, agora é hora de olhar as entrnahas olhar tudo, ver se ja temos base pra isso, enfim, precisamos fazer o melhor do melhor do mundo entre uso de proxy /  contorle total disso no ct
```

---

## RAW_INPUT — 2026-04-07 (elevar anti-detect para nivel enterprise, por fases)

```text
triagem inbox

registrar tudo para execucao organizada, sem quebrar producao:

escopo aprovado:
1) geo de fingerprint deve seguir IP/proxy (sem mexer na cidade de negocio da conta)
2) timezone/idioma com coerencia por proxy (evitar pacote repetido em massa)
3) validar qualidade real dos presets UA/UA-CH atuais; se insuficiente, avaliar fonte externa
4) fortalecer fingerprint avancado (webgl/canvas/audio/fonts/plugins)
5) reduzir uniformidade/cluster (platform e pacote tecnico por coortes coerentes)
6) criar score de coerencia por perfil com rollout seguro (observacao -> soft -> hard) sem travar producao
7) comportamento humano fica para o fim, com debate dedicado

requisito operacional:
- ultra organizado, execucao item a item, evidencia e simulacao antes de expandir.
```

### TRIAGE — 2026-04-07 (Programa Anti-Detect Enterprise)

| item | P | titulo | status | links |
|---|---|---|---|---|
| 1 | P0 | Geo de fingerprint por proxy (preservando cidade de negocio) | in_progress | `docs/inbox/in_progress/INC-20260407-1600-01.md` |
| 2 | P1 | Timezone/idioma por coerencia de proxy (anti-cluster) | need_evidence | `docs/inbox/need_evidence/INC-20260407-1610-01.md` |
| 3 | P0 | Auditoria/validacao dos presets UA/UA-CH atuais | need_evidence | `docs/inbox/need_evidence/INC-20260407-1620-01.md` |
| 4 | P0 | Fingerprint avancado: WebGL/Canvas/Audio/fonts/plugins | need_evidence | `docs/inbox/need_evidence/INC-20260407-1630-01.md` |
| 5 | P1 | Coortes de plataforma/pacote tecnico para reduzir cluster | need_evidence | `docs/inbox/need_evidence/INC-20260407-1640-01.md` |
| 6 | P0 | Score de coerencia por perfil (CT maestro: observacao -> soft -> hard) | need_evidence | `docs/inbox/need_evidence/INC-20260407-1650-01.md` |
| 7 | P2 | Comportamento humano avancado (fase final, debate dedicado) | need_alignment | `docs/inbox/need_evidence/INC-20260407-1700-01.md` |

---

## RAW_INPUT — 2026-04-08 (RM6/RM7: Facebook "Sorry, something went wrong" + painel oscilando)

```text
no RM6 e RM7 (com proxy + fingerprint novos), ao cadastrar conta o navegador abre e as paginas do Facebook aparecem com:
"Sorry, something went wrong. We're working on getting this fixed as soon as we can."

google abre normalmente.

no CT aparece contagem (ex.: 30) e no host oscila (27/28/29/30).
ha percepcao de congestionamento de ACK e chegada parcelada de contas.
```

```text
RAW_INPUT (2026-04-08) — RM6: após mudanças de fingerprint (WebGL/canvas/etc) cadastro até pode ocorrer,
mas o navegador "não consegue mais ir pro Facebook" / fluxo de login/configure fica quebrado.

Pedido operacional:
- usar o "Conveniente Lab" para reproduzir e entender causa real (sem desativar proxy/anti-detect).

Conta citada para teste:
- 2178 — Renato Matos — 82956343520 — disponível no estoque.
```

### TRIAGE — 2026-04-08 (RM6/RM7 cadastro quebrado)

| item | P | titulo | status | links |
|---|---|---|---|---|
| 1 | P0 | RM6/RM7: “Facebook não abre / Sorry…” | done | postmortem: `docs/inbox/done/INC-20260408-0900-01.md` + evidência: `sitechatbot/dados/logs/aba80611-8b8a-46ed-a852-f5f0d573c03b/ack_6a007033-823a-41c5-8899-c91b0ce19045.json` |
| 2 | P1 | RM6: contagem de contas oscilando entre CT e host dashboard | done | observado durante a crise; sem reproduzir após estabilização operacional |
| 3 | P1 | RM6/RM7: suspeita de congestionamento por excesso de comandos `gateway_set_proxies`/ACK | done | mitigado pelos patches prévios (dedupe/cooldown no CT + priorização/collapse no host); manter em observação |

#### RESOLUÇÃO (confirmada pelo humano)

- Causa raiz do “Facebook não abre / Sorry…”: **cookies inválidos nas contas específicas**.
- Validação: humano testou **3 contas com cookies válidos** e o cadastro/login ocorreu normalmente.

#### UPDATE TECNICO — 2026-04-08 (fluxo de entrega CT -> host + priorizacao de comandos)

- Evidencia de entrega de conta em pacote unico (`stock_provision`): `sitechatbot/index.js` (`/api/stock/provision/manual`, `/api/stock/provision/from_account_secret`) envia `login`, `password`, `cookies`, `city`, `category` no mesmo payload por acao.
- Evidencia de execucao no host em transacao unica: `conveniente/scripts/dashboard.js` (`execStockProvision`) processa `create_profile -> activate -> configure -> recycle -> start_work` no mesmo comando/lock.
- Evidencia de falha atual no cadastro (nao "conta parcelada"): `sitechatbot/dados/logs/aba80611-8b8a-46ed-a852-f5f0d573c03b/ack_b47be4b4-3978-4e78-906a-b416386cae9a.json` e `ack_31f08857-59a9-4e67-a342-00349044e20b.json` com `still_login_required:checkpoint_interstitial` apos `configure`.
- Acao de mitigacao aplicada no host (sem desligar proxy): `conveniente/scripts/dashboard.js` agora:
  - prioriza `stock_provision/login_remediate` antes de comandos de gateway no mesmo lote;
  - colapsa `gateway_set_proxies/gateway_reconcile` redundantes no mesmo lote (ACK `skipped` com motivo `superseded_by_newer_gateway_command_in_same_batch`).
- Objetivo da mitigacao: reduzir atraso de cadastro por backlog de gateway e impedir sensacao de operacao "parcelada" durante tempestade de comandos.

#### UPDATE FORENSE — 2026-04-08 (perfil Renato Matos: troca de proxy durante cadastro)

- Evidencia do erro de cadastro no profile alvo: `sitechatbot/dados/logs/aba80611-8b8a-46ed-a852-f5f0d573c03b/ack_d8edcb9d-5357-4f98-83d1-7066fb7bda67.json` com `still_login_required:checkpoint_interstitial` em `configure`.
- Evidencia de recycle de gateway logo em seguida no mesmo profile: `sitechatbot/dados/logs/aba80611-8b8a-46ed-a852-f5f0d573c03b/ack_5465bb03-0780-4181-b397-1c5d59e29a77.json` (`changedSample` inclui `campos_dos_goytacazes-1775658025686`).
- Causa operacional confirmada: `gateway_set_proxies` tentou recycle do perfil recem-provisionado durante janela de `kill_guard/configurando`, abrindo risco de troca de proxy no meio do fluxo.
- Correcao aplicada no host (`conveniente/scripts/dashboard.js`):
  - bloqueia recycle quando perfil esta `configurando` ou `humanControl`;
  - `execGatewaySetProxies` e fila de retry (`processGatewayRecycleQueue`) passam a reciclar com `allowBusy=false` (respeita prechecks, reencola retry).
- Resultado esperado: manter proxy/fingerprint estaveis durante cadastro/login e reciclar apenas apos sair da janela critica.

#### UPDATE FORENSE/CT — 2026-04-08 (por que `gateway_set_proxies` repetia sem mudanca real)

- Causa raiz identificada: reconciliacao por `report_reconcile/auto_reconcile` no CT podia reenfileirar o mesmo payload repetidamente quando o host permanecia em mismatch (ex.: profile em `kill_guard/configurando`) e sem comando pendente no momento.
- Evidencia de volume: `sitechatbot/dados/commands.json` com sequencias longas de `type: gateway_set_proxies` para host habilitado; ACKs recorrentes em `sitechatbot/dados/logs/<hostId>/ack_*.json`.
- Correcao aplicada no CT (`sitechatbot/index.js`):
  - dedupe temporal por payload normalizado (remove `issuedAt`) com cooldown (`CT_GATEWAY_SAME_PAYLOAD_RESEND_COOLDOWN_MS`, default 5 min);
  - sync de report passa `plannedCohorts` junto com `plannedAssignments` no payload desejado;
  - quando host sinaliza `needsGatewayInventory/needsGatewayProxyTrafficCreds`, envio segue `force=true` (nao bloqueado por cooldown).
- Resultado esperado: fim da tempestade de reenvio identico; gateway so reenfila em mudanca real, pedido explicito do host ou apos cooldown de seguranca.

---

## RAW_INPUT — 2026-04-08 (Robe: postagem “frenética” 24/7 + sinais de automação)

```text
Contexto operacional (humano):

- Temos hosts com ~120 contas no mesmo servidor.
- O Robe está sempre com 2/3/4/5 contas na fila, postando ininterruptamente:
  - uma conta posta → entra em cooldown;
  - outras seguem postando;
  - quando o cooldown termina, a conta entra na fila novamente e normalmente já entra na posição 3/4/5.
- Mudança recente positiva: antes era ~120 navegadores no mesmo proxy; agora está ~120 navegadores distribuídos por ~12 proxies.
  - Resultado percebido: algumas contas começaram a engajar após 2–3 dias.
- Ainda assim: está ocorrendo captcha e deslog em algumas contas.
- Ao relogar, algumas contas mostram mensagem do Facebook indicando suspeita de comportamento automatizado.

Diretriz operacional:
- foco agora é 110% no Robe (reduzir “cara de automação” sem quebrar produção).

Nota:
- humano vai enviar proposta de “humanização” escrita por outro GPT para debate e implementação segura.
```

### TRIAGE — 2026-04-08 (Robe: anti‑cluster/humanização)

| item | P | titulo | status | links |
|---|---|---|---|---|
| 1 | P0 | Robe: postagem 24/7 “frenética” com cluster (fila sempre cheia) + captcha/deslog + aviso “suspeita de automação” | need_evidence | `docs/inbox/need_evidence/INC-20260408-1400-01.md` |
| 2 | P0 | Robe V2: sessões/lotes/pausas dentro do bloco (substituir padrão de cooldown fixo por post) | in_progress | `docs/inbox/need_evidence/INC-20260408-1400-01.md` |