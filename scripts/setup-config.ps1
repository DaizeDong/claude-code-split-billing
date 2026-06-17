# setup-config.ps1  (Windows / PowerShell)
# Choose which Claude Code config directory `cc` uses, and turn on Remote Control.
#
# Modes:
#   (no switch)          You are prompted whether to enable inherit (shared) mode.
#   -Isolated            Isolated config dir at <repo>\.claude-config — independent of ~/.claude.
#                        You log in separately under `cc`; nothing is shared.
#   -Inherit [Dir]       Reuse your real Claude Code config (Dir, default $env:USERPROFILE\.claude)
#                        so `cc` and `claude` SHARE login, plugins, skills, sessions, MCP and
#                        settings live. Only inference billing differs. Writes one key
#                        (enableRemoteControlByDefault) into Dir\settings.json; others preserved.
#
# The chosen directory is recorded in <repo>\.cc-config-dir (git-ignored), which bin\cc.cmd reads.

param(
  [switch]$Inherit,
  [switch]$Isolated,
  [string]$ConfigDir
)
$ErrorActionPreference = 'Stop'

$repo = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)

# No explicit mode given: ask interactively, else default to isolated.
if (-not $Inherit -and -not $Isolated -and -not $ConfigDir) {
  if ([Environment]::UserInteractive) {
    Write-Host "Choose how 'cc' stores its Claude Code config:"
    Write-Host "  isolated (default) - separate .claude-config; you log in under 'cc', nothing shared"
    Write-Host "  shared  (inherit)  - reuse your real ~/.claude; share login/plugins/skills/sessions"
    $ans = Read-Host "Enable inherit (shared) mode? [y/N]"
    if ($ans -match '^(y|yes)$') { $Inherit = $true }
  } else {
    Write-Host "No mode switch and not interactive - defaulting to isolated (use -Inherit to share ~/.claude)." -ForegroundColor Yellow
  }
}

if (-not $ConfigDir) {
  if ($Inherit) { $ConfigDir = Join-Path $env:USERPROFILE '.claude' }
  else          { $ConfigDir = Join-Path $repo '.claude-config' }
}

New-Item -ItemType Directory -Force -Path $ConfigDir | Out-Null
$sf = Join-Path $ConfigDir 'settings.json'

if (Test-Path $sf) { $j = Get-Content $sf -Raw | ConvertFrom-Json } else { $j = [pscustomobject]@{} }
if ($j.PSObject.Properties.Name -contains 'enableRemoteControlByDefault') {
  $j.enableRemoteControlByDefault = $true
} else {
  $j | Add-Member -NotePropertyName enableRemoteControlByDefault -NotePropertyValue $true
}
($j | ConvertTo-Json -Depth 20) | Out-File -Encoding utf8 $sf

# Record the chosen dir so bin\cc.cmd uses it (git-ignored; may contain a personal path).
$ConfigDir | Out-File -Encoding ascii -NoNewline (Join-Path $repo '.cc-config-dir')

if ($Inherit) {
  Write-Host "Mode: inherit (shared)" -ForegroundColor Green
  Write-Host "Config dir cc uses: $ConfigDir"
  Write-Host "cc now SHARES this config with your normal 'claude' (login, plugins, skills,"
  Write-Host "sessions, MCP, settings). Only inference billing differs."
  Write-Host "Added enableRemoteControlByDefault to $sf (existing keys preserved)."
} else {
  Write-Host "Mode: isolated" -ForegroundColor Green
  Write-Host "Config dir cc uses: $ConfigDir"
  Write-Host "`nNext: run 'cc' then /login and choose the subscription (OAuth) option."
}
