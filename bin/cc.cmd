@echo off
REM Claude Code via a custom inference gateway, with Remote Control still working.
REM Isolated config + local rerouting proxy + (optional) corporate CA trust.
REM All args are forwarded to claude, e.g.:  cc --resume   |   cc --dangerously-skip-permissions
setlocal
set "SCRIPT_DIR=%~dp0"
set "REPO_ROOT=%SCRIPT_DIR%.."

REM --- config dir: pointer written by setup-config (isolated default, or your real ~/.claude
REM     in --inherit mode). An explicit CLAUDE_CONFIG_DIR in the environment always wins. ---
if not defined CLAUDE_CONFIG_DIR if exist "%REPO_ROOT%\.cc-config-dir" set /p CLAUDE_CONFIG_DIR=<"%REPO_ROOT%\.cc-config-dir"
if not defined CLAUDE_CONFIG_DIR set "CLAUDE_CONFIG_DIR=%REPO_ROOT%\.claude-config"

REM --- ensure OAuth auth (an api key/token would disable Remote Control) ---
set "ANTHROPIC_API_KEY="
set "ANTHROPIC_AUTH_TOKEN="
set "ANTHROPIC_CUSTOM_HEADERS="
set "ANTHROPIC_MODEL="
set "ANTHROPIC_DEFAULT_OPUS_MODEL="
set "ANTHROPIC_DEFAULT_SONNET_MODEL="
set "ANTHROPIC_DEFAULT_HAIKU_MODEL="

REM --- MITM mode: point the client at the REAL host so Remote Control's
REM     host===api.anthropic.com check passes; hosts hijack + local HTTPS proxy
REM     (self-signed leaf) reroute /v1/messages to the gateway. ---
if not defined PROXY_PORT set "PROXY_PORT=443"
set "ANTHROPIC_BASE_URL=https://api.anthropic.com"

REM --- trust the local CA that signs our api.anthropic.com leaf (required). ---
if exist "%REPO_ROOT%\ca-bundle.pem" (
  set "NODE_EXTRA_CA_CERTS=%REPO_ROOT%\ca-bundle.pem"
) else (
  echo cc: missing ca-bundle.pem. Run:  bash scripts/gen-certs.sh
  exit /b 1
)

REM --- verify the hosts hijack is active, else RC traffic goes to the real host
REM     directly and inference won't be rerouted. ---
findstr /c:"cc-split-billing" "%WINDIR%\System32\drivers\etc\hosts" >nul 2>&1
if errorlevel 1 (
  echo cc: api.anthropic.com is NOT hijacked to 127.0.0.1.
  echo     Run once from an elevated PowerShell:
  echo       powershell -ExecutionPolicy Bypass -File "%REPO_ROOT%\scripts\hosts-hijack.ps1" enable
  exit /b 1
)

REM --- make sure the rerouting proxy is running; start it if not ---
REM     Set NODE_BIN to a Node >= 18 if the default `node` on PATH is too old.
if not defined NODE_BIN set "NODE_BIN=node"
"%NODE_BIN%" "%REPO_ROOT%\src\ensure-proxy.js"

REM --- launch claude with all passed-through args (RC on by default via settings.json) ---
claude %*
