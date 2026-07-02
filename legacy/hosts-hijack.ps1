<#
  hosts-hijack.ps1  (Windows, requires Administrator)

  Redirect api.anthropic.com to 127.0.0.1 (or remove that redirect) in the
  system hosts file, so Claude Code's traffic to the (RC-required) official
  host lands on the local HTTPS proxy instead.

  Usage (from an elevated PowerShell):
    powershell -ExecutionPolicy Bypass -File scripts\hosts-hijack.ps1 enable
    powershell -ExecutionPolicy Bypass -File scripts\hosts-hijack.ps1 disable
    powershell -ExecutionPolicy Bypass -File scripts\hosts-hijack.ps1 status

  The managed line is tagged with a marker comment so it can be removed cleanly
  and never touches your other hosts entries.

  SIDE EFFECT: while enabled, EVERY program on this machine resolves
  api.anthropic.com to 127.0.0.1 (browsers, plain `claude`, other SDKs). Only the
  local proxy (with the matching self-signed cert) will serve it correctly.
#>
[CmdletBinding()]
param(
  [Parameter(Position = 0)]
  [ValidateSet('enable', 'disable', 'status')]
  [string]$Action = 'status'
)

$ErrorActionPreference = 'Stop'
$hostsPath = Join-Path $env:WinDir 'System32\drivers\etc\hosts'
$marker    = '# cc-split-billing'
$hostName  = 'api.anthropic.com'
$line      = "127.0.0.1`t$hostName`t$marker"

function Test-Admin {
  $id = [Security.Principal.WindowsIdentity]::GetCurrent()
  (New-Object Security.Principal.WindowsPrincipal($id)).IsInRole(
    [Security.Principal.WindowsBuiltinRole]::Administrator)
}

# Read hosts with a shared handle + retry (antivirus / DNS clients often hold a
# transient lock on the hosts file, which makes plain Get-Content/Set-Content fail
# with "being used by another process").
function Get-HostsLines {
  for ($i = 0; $i -lt 15; $i++) {
    try {
      $fs = [IO.File]::Open($hostsPath, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::ReadWrite)
      $sr = New-Object IO.StreamReader($fs)
      $t = $sr.ReadToEnd(); $sr.Close(); $fs.Close()
      return ($t -split "`r?`n")
    } catch { Start-Sleep -Milliseconds 300 }
  }
  throw "cannot read hosts (locked by another process after retries)"
}

# Write hosts with a shared handle + retry, same reasoning as above.
function Write-HostsFile([string[]]$lines) {
  $content = ($lines -join "`r`n").TrimEnd("`r", "`n") + "`r`n"
  $bytes = [Text.Encoding]::ASCII.GetBytes($content)
  for ($i = 0; $i -lt 15; $i++) {
    try {
      $fs = [IO.File]::Open($hostsPath, [IO.FileMode]::Create, [IO.FileAccess]::Write, [IO.FileShare]::ReadWrite)
      $fs.Write($bytes, 0, $bytes.Length); $fs.Flush(); $fs.Close()
      return
    } catch { Start-Sleep -Milliseconds 300 }
  }
  throw "cannot write hosts (locked by another process after retries). Close AV/VPN/DNS tools holding it, or edit the file manually."
}

function Show-Status {
  $has = (Get-HostsLines | Where-Object { $_ -match [regex]::Escape($marker) })
  if ($has) { Write-Host "status: ENABLED  ->  $has" -ForegroundColor Yellow }
  else      { Write-Host "status: disabled (no cc-split-billing hosts entry)" -ForegroundColor Green }
}

if ($Action -eq 'status') { Show-Status; return }

if (-not (Test-Admin)) {
  Write-Error "hosts-hijack $Action requires Administrator. Re-run from an elevated PowerShell:`n  Start-Process powershell -Verb RunAs"
  exit 1
}

# Always strip any existing managed line first (clean, idempotent).
$kept = Get-HostsLines | Where-Object { $_ -notmatch [regex]::Escape($marker) }

if ($Action -eq 'enable') {
  $out = @($kept) + $line
  Write-HostsFile $out
  # Flush the OS resolver cache so the change takes effect immediately.
  try { ipconfig /flushdns | Out-Null } catch {}
  Write-Host "hosts: ENABLED  ($hostName -> 127.0.0.1)" -ForegroundColor Yellow
}
elseif ($Action -eq 'disable') {
  Write-HostsFile $kept
  try { ipconfig /flushdns | Out-Null } catch {}
  Write-Host "hosts: disabled ($hostName redirect removed)" -ForegroundColor Green
}
