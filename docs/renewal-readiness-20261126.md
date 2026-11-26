# Renovação: Mãe 4 / Fidel, 26/11/2026

## Evidência e limite da conclusão

O registro do ciclo de Fidel mostra publicação confirmada, passagem pelo ID e
interrupção da renovação com `interaction_without_healthy_proxy_turn:isolated`.
O início da renovação ocorreu em 1795656671369; a exceção em 1795656764895.
A operação tinha prazo absoluto 1795657762 (segundos). Portanto, não se tratava
de esgotamento desse prazo. O pedido de devolução veio depois da exceção.
Os registros disponíveis não provam qual evento tornou o snapshot local
temporariamente não saudável, nem que esse ciclo é exatamente o incidente visual
observado pelo operador. Não declarar erro de senha, inelegibilidade ou renovação
concluída a partir dessa falha técnica.

## Correção

- A estabilidade considera o conteúdo do modal de renovação, sem ser reiniciada
  por contadores do painel humano ou mudanças na página atrás dele.
- O clique usa o controle real visível, habilitado, estável e atingível pelo mouse.
  Remove a busca duplicada por coordenadas e os fallbacks de clique em DOM.
- Se a tentativa final ficar incerta, não repetir automaticamente a ação.
- Antes das leituras de renovação, uma perda temporária de autoridade pode aguardar
  até 30 segundos pela recuperação da mesma operação, sem tocar no DOM nem obter
  outra cadeira. Encerramento e prazo absoluto continuam bloqueando a interação.
- O cliente informa erro/idade do último status e encerramento; exceções de
  renovação registram esses campos, sem credenciais.
- Permanecem a espera de até 180 segundos pelo cálculo de elegibilidade e a
  confirmação de transporte após o clique. Botão disponível não significa sucesso.

## Validação

51 testes passaram entre renovação, menu de ações, controles em Chrome real,
isolamento e autoridade de cadeira. Incluem contagem bloqueada por dois minutos
antes de liberar, duplicata oculta, painel mudando atrás do modal, recuperação
de status, prazo vencido e ausência de replay de clique incerto.

O HTML fornecido foi carregado em Chrome isolado, com CSS mínimo para layout
(o anexo não inclui as folhas de estilo do Facebook). O clique atingiu uma vez
o controle `Renovar` não oculto. Isso valida a seleção no DOM fornecido;
não substitui o piloto conectado no Facebook.

## Implantação

Baixar arquivos nas sete Mães sem reiniciar. Primeiro recarregar pelo Porteiro
somente a Mãe 4, conforme solicitado. O pacote inclui alterações anteriores de
cadastro no Index; reiniciar apenas workers não recarrega essa parte. A conclusão
real da renovação de Fidel depende do piloto e da evidência de transporte.
