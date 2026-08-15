# Registers the Oracle with the AI agents installed on this machine, on Windows.
#
# The PowerShell counterpart of mcp.sh. Same shape, same two agents, and the same
# rule: whichever is not installed is reported and skipped rather than treated as
# a failure, because most people have one of the two rather than both.
#
#   powershell -ExecutionPolicy Bypass -File install\mcp.ps1
#
# The ExecutionPolicy argument is not optional advice. Windows refuses to run
# unsigned scripts by default, and the error it gives says nothing about what to
# do next.

$ErrorActionPreference = "Continue"

$AppDir = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$Server = Join-Path $AppDir "agent\mcp_server.js"

# An installed copy keeps the server in resources rather than beside the source.
if (-not (Test-Path $Server)) {
  $installed = Join-Path $env:LOCALAPPDATA "Programs\Delphi\resources\agent\mcp_server.js"
  if (Test-Path $installed) { $Server = $installed }
}
if (-not (Test-Path $Server)) {
  Write-Host "  Could not find mcp_server.js. Run this from the Delphi folder." -ForegroundColor Red
  exit 1
}

$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
  Write-Host "  node was not found on PATH. Install Node 18 or newer first." -ForegroundColor Red
  exit 1
}
# The real binary rather than a shim. An editor launches its MCP servers without
# your shell's PATH, so a version manager shim fails with a "command not found"
# that points nowhere useful.
$NodeReal = & $node.Source -e "console.log(process.execPath)"

Write-Host ""

# --- Claude Code -------------------------------------------------------------

if (Get-Command claude -ErrorAction SilentlyContinue) {
  claude mcp remove delphi 2>$null | Out-Null
  claude mcp add delphi --scope user -e DELPHI_ACTOR=claude -- $NodeReal $Server 2>$null | Out-Null
  if ($LASTEXITCODE -eq 0) {
    Write-Host "  Claude Code    registered"
  } else {
    Write-Host "  Claude Code    failed, run: claude mcp add delphi --scope user -- $NodeReal $Server"
  }
} else {
  Write-Host "  Claude Code    not installed, skipped"
}

# --- GitHub Copilot in VS Code ----------------------------------------------

# User level rather than workspace level, so Copilot can reach the tracker from
# any project rather than only from this folder.
$registered = $false
foreach ($dir in @("$env:APPDATA\Code\User", "$env:APPDATA\Code - Insiders\User", "$env:APPDATA\VSCodium\User")) {
  if (-not (Test-Path $dir)) { continue }
  $target = Join-Path $dir "mcp.json"

  # Merged rather than overwritten, because this file may already hold other
  # servers and replacing it would silently remove them.
  $config = @{}
  if (Test-Path $target) {
    try { $config = Get-Content $target -Raw | ConvertFrom-Json -AsHashtable } catch { $config = @{} }
  }
  if ($null -eq $config) { $config = @{} }
  if (-not $config.ContainsKey("servers") -or $null -eq $config["servers"]) { $config["servers"] = @{} }

  $config["servers"]["delphi"] = @{
    type    = "stdio"
    command = $NodeReal
    args    = @($Server)
    env     = @{ DELPHI_ACTOR = "copilot" }
  }

  $config | ConvertTo-Json -Depth 10 | Set-Content -Path $target -Encoding UTF8
  Write-Host "  Copilot        registered ($(Split-Path -Leaf (Split-Path -Parent $dir)))"
  $registered = $true
}

if (-not $registered) {
  Write-Host "  Copilot        VS Code not found, skipped"
}

Write-Host ""
Write-Host "  Restart your editor. MCP servers are loaded at startup."
Write-Host ""
Write-Host "  To make the agent use it without being asked each time, paste the"
Write-Host "  contents of AGENTS.md into your standing instructions:"
Write-Host "    Claude Code   CLAUDE.md"
Write-Host "    Copilot       .github\copilot-instructions.md"
Write-Host ""
