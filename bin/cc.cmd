@echo off
REM Claude Code via a custom inference gateway, with Remote Control still working.
REM Isolated config + local rerouting proxy + (optional) corporate CA trust.
REM All args are forwarded to claude, e.g.:  cc --resume   |   cc --dangerously-skip-permissions
setlocal
set "SCRIPT_DIR=%~dp0"
set "REPO_ROOT=%SCRIPT_DIR%.."

REM --- isolated config (does not touch your default ~/.claude.json) ---
if not defined CLAUDE_CONFIG_DIR set "CLAUDE_CONFIG_DIR=%REPO_ROOT%\.claude-config"

REM --- ensure OAuth auth (an api key/token would disable Remote Control) ---
set "ANTHROPIC_API_KEY="
set "ANTHROPIC_AUTH_TOKEN="
set "ANTHROPIC_CUSTOM_HEADERS="
set "ANTHROPIC_MODEL="
set "ANTHROPIC_DEFAULT_OPUS_MODEL="
set "ANTHROPIC_DEFAULT_SONNET_MODEL="
set "ANTHROPIC_DEFAULT_HAIKU_MODEL="

REM --- inference -> local proxy -> gateway ---
if not defined PROXY_PORT set "PROXY_PORT=8787"
set "ANTHROPIC_BASE_URL=http://127.0.0.1:%PROXY_PORT%"

REM --- trust corporate TLS root so Node reaches the control plane (only if bundle exists) ---
if exist "%REPO_ROOT%\ca-bundle.pem" set "NODE_EXTRA_CA_CERTS=%REPO_ROOT%\ca-bundle.pem"

REM --- make sure the rerouting proxy is running; start it if not ---
node "%REPO_ROOT%\src\ensure-proxy.js"

REM --- launch claude with all passed-through args (RC on by default via settings.json) ---
claude %*
