#!/usr/bin/env bash
set -euo pipefail

INSTALL_DIR="${BCURL_INSTALL_DIR:-/usr/local}"
BIN_DIR="$INSTALL_DIR/bin"
LIB_DIR="$INSTALL_DIR/lib/bcurl"

RED='\033[0;31m'
GREEN='\033[0;32m'
NC='\033[0m'

info()  { echo -e "${GREEN}[bcurl]${NC} $*"; }
error() { echo -e "${RED}[bcurl]${NC} $*" >&2; }

if [ ! -w "$INSTALL_DIR" ] 2>/dev/null; then
  SUDO="sudo"
else
  SUDO=""
fi

if [ -f "$BIN_DIR/bcurl" ]; then
  $SUDO rm -f "$BIN_DIR/bcurl"
  info "Removed $BIN_DIR/bcurl"
fi

if [ -d "$LIB_DIR" ]; then
  $SUDO rm -rf "$LIB_DIR"
  info "Removed $LIB_DIR"
fi

info "bcurl uninstalled."
