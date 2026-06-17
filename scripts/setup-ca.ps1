# setup-ca.ps1  (Windows / PowerShell)
# Export your corporate TLS-intercepting root CA to a PEM bundle so Node trusts it
# (via NODE_EXTRA_CA_CERTS). This fixes "unable to get local issuer certificate",
# which otherwise makes Remote Control eligibility checks fail and the flag be ignored.
#
# You only need this if your network performs TLS interception (common on corporate
# networks). On a normal network the control-plane test will already pass and you can
# skip CA setup entirely.
#
# Usage:
#   Diagnose first (prints the issuer of the live certs so you know your root CA name):
#     powershell -ExecutionPolicy Bypass -File scripts\setup-ca.ps1 -Diagnose
#   Then export, matching your root CA's subject by keyword(s):
#     powershell -ExecutionPolicy Bypass -File scripts\setup-ca.ps1 -RootMatch 'Your Corp Root CA'

param(
  [switch]$Diagnose,
  # Regex matched against certificate Subject. Set this to your corporate root CA name.
  [string]$RootMatch = ''
)

$ErrorActionPreference = 'Stop'
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoRoot  = Split-Path -Parent $scriptDir
$out       = Join-Path $repoRoot 'ca-bundle.pem'
$controlHosts = @('api.anthropic.com', 'mcp-proxy.anthropic.com', 'claude.ai')

function Probe-Issuer($h) {
  try {
    $c = New-Object System.Net.Sockets.TcpClient
    $c.Connect($h, 443)
    $ssl = New-Object System.Net.Security.SslStream($c.GetStream(), $false, ({ $true }))
    $ssl.AuthenticateAsClient($h)
    $cert = [System.Security.Cryptography.X509Certificates.X509Certificate2]$ssl.RemoteCertificate
    Write-Host "$h"
    Write-Host "   subject = $($cert.Subject)"
    Write-Host "   issuer  = $($cert.Issuer)"
    $ssl.Dispose(); $c.Close()
  } catch { Write-Host "$h : FAIL -> $($_.Exception.Message)" }
}

if ($Diagnose) {
  Write-Host "=== Diagnose: issuer of the live control-plane certs ==="
  Write-Host "If the issuer is NOT Anthropic/its public CA, that issuer name is your"
  Write-Host "corporate root CA. Pass a keyword from it to -RootMatch.`n"
  foreach ($h in $controlHosts) { Probe-Issuer $h }
  return
}

if (-not $RootMatch) {
  Write-Host "No -RootMatch given. Run with -Diagnose first to find your corporate root CA name," -ForegroundColor Yellow
  Write-Host "then re-run:  scripts\setup-ca.ps1 -RootMatch 'Your Corp Root CA'" -ForegroundColor Yellow
  exit 1
}

Write-Host "Searching certificate stores for root CA matching: $RootMatch ..."
$stores = @('Cert:\LocalMachine\Root', 'Cert:\CurrentUser\Root', 'Cert:\LocalMachine\CA', 'Cert:\CurrentUser\CA')
$found = @()
foreach ($s in $stores) {
  $found += Get-ChildItem $s -ErrorAction SilentlyContinue | Where-Object { $_.Subject -match $RootMatch }
}
$found = $found | Sort-Object Thumbprint -Unique
if ($found.Count -eq 0) {
  Write-Host "No matching CA found. Run -Diagnose and adjust -RootMatch." -ForegroundColor Red
  exit 1
}
Write-Host "Found $($found.Count) certificate(s):"
$found | ForEach-Object { Write-Host "  - $($_.Subject)" }

$sb = New-Object System.Text.StringBuilder
foreach ($c in $found) {
  $b64 = [System.Convert]::ToBase64String($c.RawData, 'InsertLineBreaks')
  [void]$sb.AppendLine("# $($c.Subject)")
  [void]$sb.AppendLine('-----BEGIN CERTIFICATE-----')
  [void]$sb.AppendLine($b64)
  [void]$sb.AppendLine('-----END CERTIFICATE-----')
}
[System.IO.File]::WriteAllText($out, $sb.ToString())
Write-Host "Wrote $out ($((Get-Item $out).Length) bytes)" -ForegroundColor Green

Write-Host "`n=== Node TLS connectivity test (using the exported bundle) ==="
$env:NODE_EXTRA_CA_CERTS = $out
node (Join-Path $scriptDir 'test-control-plane.js')
Write-Host "`nIf all hosts are OK you're done. If not, re-run -Diagnose and adjust -RootMatch."
