#!/bin/sh
set -eu

plugin_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
local_bin="$HOME/.local/bin"
export PATH="$local_bin:/opt/homebrew/bin:/usr/local/bin:$PATH"

node_bin=${CODEX_SWARM_NODE:-$(command -v node || true)}
if [ -z "$node_bin" ] || ! "$node_bin" -e 'process.exit(Number(process.versions.node.split(".")[0]) < 24 ? 1 : 0)' 2>/dev/null; then
  echo "Codex Swarm needs Node.js 24 or newer. Set CODEX_SWARM_NODE to its executable if Node is outside PATH." >&2
  exit 1
fi
exec "$node_bin" "$plugin_root/src/mcp.mjs"
