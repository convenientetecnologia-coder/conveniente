PAGEFILE (MEMÓRIA VIRTUAL) - HABILITAÇÃO

========================================
POR QUE HABILITAR?
========================================

No Windows 10/11, sem pagefile (memória virtual), o sistema pode ter RAM física "livre" aparente, mas sem COMMIT suficiente para spawnar novos processos/renderers do Chrome.

Isso causa:
- Falhas esquisitas ao abrir abas
- Cascata de about:blank
- Travamentos mesmo com RAM livre

O COMMIT LIMIT = RAM física + pagefile. Sem pagefile, o COMMIT LIMIT = RAM física apenas, e o Windows pode recusar criar processos mesmo com RAM livre.

========================================
COMO HABILITAR
========================================

1. Execute o script como ADMINISTRADOR:
   - Clique com botão direito em "enable_pagefile_system_managed.ps1"
   - Selecione "Executar com PowerShell" (como Administrador)

2. REINICIE o Windows para aplicar completamente.

3. Verifique no painel: se ainda aparecer o aviso "PAGEFILE DESATIVADO", o pagefile pode não ter sido aplicado ainda (requer reboot).

========================================
VERIFICAÇÃO
========================================

Após reiniciar, o painel do sistema deve parar de mostrar o aviso "PAGEFILE DESATIVADO".

Você também pode verificar manualmente:
- Painel de Controle > Sistema > Configurações Avançadas do Sistema
- Aba "Avançado" > Desempenho > Configurações
- Aba "Avançado" > Memória Virtual > Alterar
- Deve estar marcado "Gerenciar automaticamente o tamanho do arquivo de paginação para todas as unidades"

========================================
NOTA TÉCNICA
========================================

O script usa "System Managed" (gerenciamento automático), que é a configuração recomendada. O Windows ajusta o tamanho do pagefile automaticamente conforme necessário.

