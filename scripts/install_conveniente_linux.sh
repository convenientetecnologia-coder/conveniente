#!/usr/bin/env bash
set -euo pipefail

LOG_PREFIX="[CONVENIENTE-LINUX-INSTALL]"

log() {
  printf "%s %s\n" "$LOG_PREFIX" "$*"
}

fail() {
  printf "%s ERRO: %s\n" "$LOG_PREFIX" "$*" >&2
  exit 1
}

if [[ "$(uname -s)" != "Linux" ]]; then
  fail "Este instalador e exclusivo para Linux."
fi

if [[ -f /etc/os-release ]]; then
  # shellcheck disable=SC1091
  source /etc/os-release
else
  fail "Nao foi possivel detectar a distribuicao Linux (/etc/os-release ausente)."
fi

if [[ "${ID:-}" != "ubuntu" && "${ID_LIKE:-}" != *"ubuntu"* ]]; then
  fail "Distribuicao nao suportada por este instalador (esperado Ubuntu/Xubuntu 24.04)."
fi

if [[ "$(id -u)" -eq 0 ]]; then
  SUDO=""
  RUN_USER="${SUDO_USER:-root}"
else
  SUDO="sudo"
  RUN_USER="$(id -un)"
fi

if ! command -v sudo >/dev/null 2>&1 && [[ -n "$SUDO" ]]; then
  fail "sudo nao encontrado. Instale sudo ou execute como root."
fi

run_as_user() {
  if [[ "$(id -un)" == "$RUN_USER" ]]; then
    bash -lc "$*"
  else
    sudo -u "$RUN_USER" bash -lc "$*"
  fi
}

RUN_HOME="$(getent passwd "$RUN_USER" | cut -d: -f6)"
if [[ -z "$RUN_HOME" ]]; then
  fail "Nao foi possivel resolver HOME do usuario alvo ($RUN_USER)."
fi

INSTALL_DIR="/opt/conveniente"
REPO_URL="${CONVENIENTE_REPO_URL:-https://github.com/convenientetecnologia-coder/conveniente.git}"

log "Usuario alvo: $RUN_USER"
log "Pasta de instalacao: $INSTALL_DIR"
log "Repo: $REPO_URL"

log "Atualizando indice de pacotes..."
$SUDO apt-get update -y

log "Instalando dependencias base..."
$SUDO apt-get install -y \
  ca-certificates \
  curl \
  git \
  gnupg \
  unzip \
  wget \
  htop \
  net-tools \
  jq \
  xdg-utils \
  build-essential \
  fonts-liberation \
  fonts-noto-color-emoji \
  fonts-dejavu \
  fonts-freefont-ttf \
  libasound2t64 \
  libatk-bridge2.0-0 \
  libatk1.0-0 \
  libc6 \
  libcairo2 \
  libcups2 \
  libdbus-1-3 \
  libdrm2 \
  libgbm1 \
  libglib2.0-0 \
  libgtk-3-0 \
  libnspr4 \
  libnss3 \
  libpango-1.0-0 \
  libu2f-udev \
  libvulkan1 \
  libx11-6 \
  libx11-xcb1 \
  libxcb1 \
  libxcomposite1 \
  libxdamage1 \
  libxext6 \
  libxfixes3 \
  libxkbcommon0 \
  libxrandr2 \
  libxrender1 \
  libxshmfence1

log "Configurando timezone e locale..."
$SUDO timedatectl set-timezone America/Sao_Paulo || true
$SUDO locale-gen pt_BR.UTF-8
$SUDO update-locale LANG=pt_BR.UTF-8 LC_ALL=pt_BR.UTF-8

if command -v localectl >/dev/null 2>&1; then
  log "Configurando teclado ABNT2 (best-effort)..."
  $SUDO localectl set-keymap br-abnt2 || true
  $SUDO localectl set-x11-keymap br abnt2 || true
fi

if ! command -v node >/dev/null 2>&1; then
  log "Instalando Node.js LTS (NodeSource 20.x)..."
  curl -fsSL https://deb.nodesource.com/setup_20.x | $SUDO -E bash -
  $SUDO apt-get install -y nodejs
else
  log "Node ja instalado: $(node -v)"
fi

if ! command -v google-chrome >/dev/null 2>&1; then
  log "Instalando Google Chrome Stable..."
  CHROME_KEYRING="/usr/share/keyrings/google-linux-signing-keyring.gpg"
  CHROME_LIST="/etc/apt/sources.list.d/google-chrome.list"
  curl -fsSL https://dl.google.com/linux/linux_signing_key.pub | $SUDO gpg --dearmor -o "$CHROME_KEYRING"
  printf "deb [arch=amd64 signed-by=%s] http://dl.google.com/linux/chrome/deb/ stable main\n" "$CHROME_KEYRING" | $SUDO tee "$CHROME_LIST" >/dev/null
  $SUDO apt-get update -y
  $SUDO apt-get install -y google-chrome-stable
else
  log "Google Chrome ja instalado: $(google-chrome --version || true)"
fi

if [[ -d "$INSTALL_DIR/.git" ]]; then
  log "Repositorio ja existe. Fazendo update..."
  $SUDO git -C "$INSTALL_DIR" fetch --all --prune
  $SUDO git -C "$INSTALL_DIR" reset --hard origin/main
else
  log "Clonando repositorio..."
  $SUDO rm -rf "$INSTALL_DIR"
  $SUDO git clone "$REPO_URL" "$INSTALL_DIR"
fi

$SUDO chown -R "$RUN_USER:$RUN_USER" "$INSTALL_DIR"

log "Instalando dependencias npm..."
run_as_user "npm --prefix \"$INSTALL_DIR\" install"

log "Preparando launcher de desktop..."
DESKTOP_DIR="$RUN_HOME/Desktop"
mkdir -p "$DESKTOP_DIR"
LAUNCHER_PATH="$DESKTOP_DIR/Iniciar Conveniente.desktop"
cat > "$LAUNCHER_PATH" <<'EOF'
[Desktop Entry]
Version=1.0
Type=Application
Name=Iniciar Conveniente
Comment=Executar runtime do Conveniente (modo visual)
Exec=bash -lc 'cd /opt/conveniente; node index.js'
Icon=google-chrome
Terminal=true
Categories=Utility;
EOF
chmod +x "$LAUNCHER_PATH"
$SUDO chown "$RUN_USER:$RUN_USER" "$LAUNCHER_PATH"

log "Instalacao Linux concluida com sucesso."
log "Proximo passo (humano): abrir terminal grafico e rodar:"
log "  cd /opt/conveniente"
log "  node index.js"
log "Observacao: modo operacional canônico e com sessao grafica ativa (navegador visivel)."
