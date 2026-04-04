#!/usr/bin/env bash
set -euo pipefail

# bcurl installer
# Installs bcurl system-wide so it's available in bash and zsh.

INSTALL_DIR="${BCURL_INSTALL_DIR:-/usr/local}"
BIN_DIR="$INSTALL_DIR/bin"
LIB_DIR="$INSTALL_DIR/lib/bcurl"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

info()  { echo -e "${GREEN}[bcurl]${NC} $*"; }
warn()  { echo -e "${YELLOW}[bcurl]${NC} $*"; }
error() { echo -e "${RED}[bcurl]${NC} $*" >&2; }

# --- Pre-flight checks ---

if ! command -v node &>/dev/null; then
  error "Node.js is required but not installed."
  error "Install it from https://nodejs.org/ or via your package manager."
  exit 1
fi

NODE_VERSION=$(node -v | sed 's/v//' | cut -d. -f1)
if [ "$NODE_VERSION" -lt 18 ]; then
  error "Node.js >= 18 is required (found $(node -v))."
  exit 1
fi

if ! command -v npm &>/dev/null; then
  error "npm is required but not installed."
  exit 1
fi

# --- Build ---

info "Installing dependencies..."
cd "$SCRIPT_DIR"
npm install --production=false 2>&1 | tail -1

info "Building TypeScript..."
npx tsc 2>&1

info "Installing Playwright Chromium browser..."
npx playwright install chromium 2>&1 | tail -1

# --- Install ---

info "Installing to $LIB_DIR ..."

# Need write access
if [ ! -w "$INSTALL_DIR" ] 2>/dev/null; then
  warn "Need sudo to write to $INSTALL_DIR"
  SUDO="sudo"
else
  SUDO=""
fi

$SUDO mkdir -p "$LIB_DIR"
$SUDO mkdir -p "$BIN_DIR"

# Copy runtime files
$SUDO rm -rf "$LIB_DIR"
$SUDO mkdir -p "$LIB_DIR"
$SUDO cp -r dist/ "$LIB_DIR/dist/"
$SUDO cp -r node_modules/ "$LIB_DIR/node_modules/"
$SUDO cp package.json "$LIB_DIR/"

# Create launcher script
$SUDO tee "$BIN_DIR/bcurl" > /dev/null << 'LAUNCHER'
#!/usr/bin/env bash
# bcurl - Like curl, but returns browser-rendered screenshots
exec node "$BCURL_LIB_DIR/dist/cli.js" "$@"
LAUNCHER

# Inject actual lib dir into launcher
$SUDO sed -i.bak "s|\$BCURL_LIB_DIR|$LIB_DIR|g" "$BIN_DIR/bcurl"
$SUDO rm -f "$BIN_DIR/bcurl.bak"
$SUDO chmod +x "$BIN_DIR/bcurl"

# --- Verify ---

if command -v bcurl &>/dev/null; then
  info "Installation successful!"
  info ""
  info "  bcurl $(bcurl --version 2>/dev/null || echo '1.0.0')"
  info "  Installed to: $BIN_DIR/bcurl"
  info "  Library at:   $LIB_DIR"
  info ""
  info "Usage:"
  info "  bcurl https://example.com -o screenshot.png"
  info "  bcurl --help"
else
  warn "bcurl was installed to $BIN_DIR/bcurl"
  warn "but $BIN_DIR is not in your PATH."
  warn ""
  warn "Add it to your shell profile:"
  warn ""
  warn "  # For bash (~/.bashrc or ~/.bash_profile):"
  warn "  export PATH=\"$BIN_DIR:\$PATH\""
  warn ""
  warn "  # For zsh (~/.zshrc):"
  warn "  export PATH=\"$BIN_DIR:\$PATH\""
  warn ""
  warn "Then restart your shell or run: source ~/.zshrc"
fi
