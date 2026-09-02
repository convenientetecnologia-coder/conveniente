# Instalação ultra robusta do Sistema Conveniente (Windows) — by OpenAI & dev Amigo
# Rode este script no PowerShell com permissões normais (ele vai pedir permissão de admin pra instalar apps!)

function Log($msg) {
    Write-Host ("[CONVENIENTE-INSTALADOR] " + $msg) -ForegroundColor Cyan
}

# 1. Instalar dependências via Winget (Node, Chrome, Chromium, Git)
Log "Instalando Node.js LTS (Se necessário)..."
winget install -e --id OpenJS.NodeJS.LTS -h

Log "Instalando Google Chrome (Se necessário)..."
winget install -e --id Google.Chrome -h

Log "Instalando Chromium (opcional)..."
winget install -e --id Chromium.Chromium -h

Log "Instalando Git (Se necessário para baixar o repositório)..."
winget install -e --id Git.Git -h

# Aguarda alguns segundos para evitar falhas de ambiente
Start-Sleep -Seconds 10

# 2. Clonar o projeto do GitHub em C:\conveniente
if (Test-Path "C:\conveniente") {
    Log "Removendo pasta antiga do C:\conveniente"
    Remove-Item -Path "C:\conveniente" -Recurse -Force
}
Log "Clonando o sistema do GitHub em C:\conveniente..."
git clone https://github.com/convenientetecnologia-coder/conveniente.git "C:\conveniente"

# 3. Instalar bibliotecas node (NPM)
Set-Location "C:\conveniente"
Log "Instalando bibliotecas npm..."
npm install

# 4. Criar estrutura de dados mínima (caso não exista)
if (!(Test-Path ".\dados")) {
    Log "Criando estrutura de dados mínima..."
    mkdir dados -Force | Out-Null
    Set-Content -Encoding UTF8 -Path .\dados\localizacoes.json -Value '{ "São Paulo": ["Centro","Sé","Pinheiros"] }'
    Set-Content -Encoding UTF8 -Path .\dados\titulos.json -Value '["Oferta imperdível","Promoção do dia","Produto novo!"]'
    Set-Content -Encoding UTF8 -Path .\dados\atendimento.json -Value '["Olá! Obrigado pelo contato. Posso te ajudar com mais informações?"]'
    Set-Content -Encoding UTF8 -Path .\dados\cidades.json -Value '["São Paulo","Rio de Janeiro"]'
    Set-Content -Encoding UTF8 -Path .\dados\cidades_coords.json -Value '[{"nome":"São Paulo","lat":-23.5505,"lon":-46.6333,"accuracy":30}]'
}
$FotosDir = "$env:USERPROFILE\Desktop\fotos"
if (!(Test-Path $FotosDir)) {
    Log "Criando pasta de fotos em $FotosDir"
    mkdir $FotosDir -Force | Out-Null
}

# 5. Atalho Iniciar: sobe o Conveniente. Loop do Porteiro em silencio se faltar. Sem admin.
$wsh = New-Object -ComObject WScript.Shell
$Shortcut = $wsh.CreateShortcut("$env:USERPROFILE\Desktop\Iniciar Conveniente.lnk")
$Shortcut.TargetPath = Join-Path $env:SystemRoot 'System32\wscript.exe'
$Shortcut.Arguments = '//nologo "C:\conveniente\porteiro\INICIAR_SISTEMA.vbs"'
$Shortcut.WorkingDirectory = "C:\conveniente"
$Shortcut.WindowStyle = 7
$Shortcut.IconLocation = "$PWD\icon.png"
$Shortcut.Save()
Log "Atalho criado na Área de Trabalho: Iniciar Conveniente"

# 6. Porteiro (reboot 04:00, lixeira, AUTO_BOOT). StandbyList NAO entra no Porteiro.
$porteiro = Join-Path $PWD "instalar_porteiro.ps1"
if (Test-Path -LiteralPath $porteiro) {
    Log "Instalando Porteiro v5.2.0-nomem (MemClean=OFF; pede admin uma vez)..."
    & powershell -NoProfile -ExecutionPolicy Bypass -File $porteiro
    if ($LASTEXITCODE -and $LASTEXITCODE -ne 0) {
        Log "AVISO: Porteiro nao instalou (codigo $LASTEXITCODE). Rode depois: $porteiro"
    } else {
        Log "Porteiro instalado (C:\auto_vigia). RAM/StandbyList fica no Conveniente."
    }
} else {
    Log "AVISO: instalar_porteiro.ps1 ausente neste clone."
}

# 7. Pronto!
Log "INSTALAÇÃO FINALIZADA!"
Log "Para rodar, basta clicar 2x no ícone 'Iniciar Conveniente' na sua Área de Trabalho!"
Start-Sleep -Seconds 2
[System.Windows.MessageBox]::Show("Conveniente + Porteiro instalados.`nClique no icone 'Iniciar Conveniente'.`nRAM: Conveniente. Reboot 04:00: Porteiro.", "Conveniente — Instalado", 0, 64)