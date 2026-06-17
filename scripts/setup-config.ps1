# setup-config.ps1  (Windows / PowerShell)
# Create an isolated Claude Code config directory and turn on Remote Control by default.
# This directory is independent of your default ~/.claude.json — they do not affect each other.

param(
  [string]$ConfigDir = (Join-Path (Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)) '.claude-config')
)
$ErrorActionPreference = 'Stop'

New-Item -ItemType Directory -Force -Path $ConfigDir | Out-Null
$sf = Join-Path $ConfigDir 'settings.json'

if (Test-Path $sf) { $j = Get-Content $sf -Raw | ConvertFrom-Json } else { $j = [pscustomobject]@{} }
if ($j.PSObject.Properties.Name -contains 'enableRemoteControlByDefault') {
  $j.enableRemoteControlByDefault = $true
} else {
  $j | Add-Member -NotePropertyName enableRemoteControlByDefault -NotePropertyValue $true
}
($j | ConvertTo-Json -Depth 20) | Out-File -Encoding utf8 $sf

Write-Host "Isolated config dir: $ConfigDir" -ForegroundColor Green
Write-Host "settings.json:"
Get-Content $sf -Raw
Write-Host "`nNext: run 'cc' then /login and choose the subscription (OAuth) option."
