#!/usr/bin/env bash
# Registers the Oracle with the AI agents installed on this machine.
#
# Claude Code and Copilot keep their MCP configuration in different places and
# in different shapes, so each is handled separately. Whichever is not
# installed is reported and skipped rather than treated as a failure: most
# people have one of the two, not both.
#
# Absolute paths throughout. An MCP client is launched by the editor, not by a
# shell, so it does not inherit the PATH a terminal has, and a version manager
# shim such as asdf's fails with a "command not found" that points nowhere
# useful.

set -uo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SERVER="$APP_DIR/agent/mcp_server.js"

NODE_BIN="$(command -v node || true)"
if [ -z "$NODE_BIN" ]; then
  echo "  node was not found on PATH. Install Node 18 or newer first." >&2
  exit 1
fi
# Resolves an asdf or nvm shim to the real binary the editor can run directly.
NODE_REAL="$("$NODE_BIN" -e 'console.log(process.execPath)' 2>/dev/null || echo "$NODE_BIN")"

echo ""

# --- Claude Code -------------------------------------------------------------

if command -v claude >/dev/null 2>&1; then
  claude mcp remove delphi >/dev/null 2>&1 || true
  claude mcp remove brain  >/dev/null 2>&1 || true
  if claude mcp add delphi --scope user -e DELPHI_ACTOR=claude -- "$NODE_REAL" "$SERVER" >/dev/null 2>&1; then
    echo "  Claude Code    registered"
  else
    echo "  Claude Code    failed, run: claude mcp add delphi --scope user -- $NODE_REAL $SERVER"
  fi
else
  echo "  Claude Code    not installed, skipped"
fi

# --- GitHub Copilot in VS Code ----------------------------------------------

# User level rather than workspace level, so Copilot can reach the tracker from
# any project rather than only from this folder. The repository also carries a
# .vscode/mcp.json for anyone who prefers it scoped to this checkout.
copilot_registered=0
for vscode_user in \
  "$HOME/Library/Application Support/Code/User" \
  "$HOME/Library/Application Support/Code - Insiders/User" \
  "$HOME/Library/Application Support/VSCodium/User"
do
  [ -d "$vscode_user" ] || continue
  target="$vscode_user/mcp.json"

  # Merged with python rather than overwritten, because this file may already
  # hold other servers and replacing it would silently remove them.
  NODE_REAL="$NODE_REAL" SERVER="$SERVER" TARGET="$target" python3 - <<'PY'
import json, os, pathlib
target = pathlib.Path(os.environ["TARGET"])
try:
    config = json.loads(target.read_text())
    if not isinstance(config, dict):
        config = {}
except Exception:
    config = {}
servers = config.get("servers")
if not isinstance(servers, dict):
    servers = {}
servers.pop("brain", None)
servers["delphi"] = {
    "type": "stdio",
    "command": os.environ["NODE_REAL"],
    "args": [os.environ["SERVER"]],
    "env": {"DELPHI_ACTOR": "copilot"},
}
config["servers"] = servers
target.parent.mkdir(parents=True, exist_ok=True)
target.write_text(json.dumps(config, indent=2) + "\n")
PY

  if [ $? -eq 0 ]; then
    echo "  Copilot        registered ($(basename "$(dirname "$vscode_user")"))"
    copilot_registered=1
  fi
done

if [ "$copilot_registered" -eq 0 ]; then
  echo "  Copilot        VS Code not found, skipped"
fi

echo ""
echo "  Restart your editor. MCP servers are loaded at startup."
echo ""
echo "  To make the agent use it without being asked each time, paste the"
echo "  contents of AGENTS.md into your standing instructions:"
echo "    Claude Code   CLAUDE.md"
echo "    Copilot       .github/copilot-instructions.md"
echo ""
