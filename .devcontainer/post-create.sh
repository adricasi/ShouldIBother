#!/usr/bin/env bash
# Runs once when the dev container is created.
set -euo pipefail

echo "==> System packages (Claude Code sandbox deps, pre-commit)"
sudo apt-get update -y
sudo apt-get install -y --no-install-recommends bubblewrap socat pipx jq iptables ipset dnsutils iproute2

echo "==> Claude config volume ownership"
sudo chown -R "$(id -u):$(id -g)" "$HOME/.claude"

if [ -f "$HOME/ai-toolkit/install.sh" ]; then
  echo "==> Linking the shared ai-toolkit (read-only mount)"
  bash "$HOME/ai-toolkit/install.sh" --container
else
  echo "!! ~/ai-toolkit is not mounted; global agents/skills will be missing."
fi

pipx install pre-commit
export PATH="$HOME/.local/bin:$PATH"

# uv at the version CI uses (ci-node.yml), from PyPI through pipx: no download piped into a shell.
pipx install "uv==0.11.32"
if [ -f training/pyproject.toml ]; then
  (cd training && "$HOME/.local/bin/uv" sync --frozen)
fi
if [ -f package.json ]; then
  if [ -f package-lock.json ]; then npm ci; else npm install; fi
fi
if [ -f go.mod ]; then
  go mod download
fi

pre-commit install
echo "==> Done. Run 'claude' and log in once; the login persists in the claude-config volume."
