#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

echo "==================================="
echo " Claude Code Discord Bot Setup"
echo "==================================="
echo

echo "[1/5] Checking Node.js..."
if ! command -v node >/dev/null 2>&1; then
  echo "  Node.js 20+ is required. Install it from https://nodejs.org and run this script again."
  exit 1
fi

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$NODE_MAJOR" -lt 20 ]; then
  echo "  Node.js 20+ is required (found $(node --version))."
  exit 1
fi
echo "  Found Node.js $(node --version)"
echo

echo "[2/5] Checking Claude Code..."
if ! command -v claude >/dev/null 2>&1; then
  echo "  Claude Code not found. Installing it with npm..."
  npm install -g @anthropic-ai/claude-code
fi
if ! command -v claude >/dev/null 2>&1; then
  echo "  Claude Code installation did not add 'claude' to PATH."
  exit 1
fi
echo "  Found Claude Code"
echo "  Run 'claude' once before starting the bot if you have not authenticated yet."
echo

echo "[3/5] Installing project dependencies..."
npm install
echo

echo "[4/5] Checking environment file..."
if [ ! -f .env ]; then
  cp .env.example .env
  echo "  Created .env from .env.example. Edit it with your Discord and workspace settings."
else
  echo "  .env already exists"
fi
echo

echo "[5/5] Building the bot..."
npm run build
echo

echo "Setup complete."
echo "  1. Confirm .env is configured."
echo "  2. Authenticate Claude Code with: claude"
echo "  3. Start the bot in the foreground with: npm start"
