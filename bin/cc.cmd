@echo off
REM Claude Code via a custom inference gateway, with Remote Control still working -
REM isolated so plain `claude` is unaffected. Inference is billed to your gateway; the
REM account/OAuth control plane (incl. Remote Control) still talks to real Anthropic.
REM All args are forwarded to claude, e.g.:  cc --resume   |   cc --dangerously-skip-permissions
setlocal EnableDelayedExpansion
set "SCRIPT_DIR=%~dp0"
set "REPO_ROOT=%SCRIPT_DIR%.."

REM --- Bun is required: Claude Code's ANTHROPIC_UNIX_SOCKET transport is an AF_UNIX
REM     socket that Node cannot serve on Windows; the proxy runs under Bun. ---
where bun >nul 2>&1
if errorlevel 1 (
  echo cc: Bun is required for the local proxy. Install it once, then retry:
  echo        npm i -g bun      ^(or see https://bun.sh^)
  exit /b 1
)

REM --- config dir: inherit your real ~/.claude by default so Remote Control can read
REM     your stored OAuth login. Pointer written by setup-config; env var always wins. ---
if not defined CLAUDE_CONFIG_DIR if exist "%REPO_ROOT%\.cc-config-dir" set /p CLAUDE_CONFIG_DIR=<"%REPO_ROOT%\.cc-config-dir"
if not defined CLAUDE_CONFIG_DIR set "CLAUDE_CONFIG_DIR=%USERPROFILE%\.claude"

REM --- clear API-key style auth (would change auth mode / disable Remote Control) ---
set "ANTHROPIC_API_KEY="
set "ANTHROPIC_AUTH_TOKEN="
set "ANTHROPIC_CUSTOM_HEADERS="
set "ANTHROPIC_MODEL="
set "ANTHROPIC_DEFAULT_OPUS_MODEL="
set "ANTHROPIC_DEFAULT_SONNET_MODEL="
set "ANTHROPIC_DEFAULT_HAIKU_MODEL="

REM --- short socket path (AF_UNIX sun_path is ~108 chars). Override with CC_SOCK. ---
if not defined CC_SOCK set "CC_SOCK=%USERPROFILE%\.cc\cc.sock"
for %%I in ("%CC_SOCK%") do set "CC_SOCK_DIR=%%~dpI"
if not exist "%CC_SOCK_DIR%" mkdir "%CC_SOCK_DIR%"

REM --- socket mode: turns Remote Control on (bypasses the host check) AND sends all API
REM     traffic over the socket to our proxy. http:// => plain HTTP on the socket, so no
REM     TLS and no certificate are needed. ---
set "ANTHROPIC_UNIX_SOCKET=%CC_SOCK%"
set "ANTHROPIC_BASE_URL=http://api.anthropic.com"

REM --- the inference SDK in socket mode needs an OAuth token present to resolve an auth
REM     method. It is NOT sent upstream (the proxy authenticates); it's a local marker. ---
for /f "usebackq delims=" %%T in (`bun "%REPO_ROOT%\src\read-oauth.js"`) do set "CLAUDE_CODE_OAUTH_TOKEN=%%T"
if not defined CLAUDE_CODE_OAUTH_TOKEN (
  echo cc: no Claude OAuth login found in "%CLAUDE_CONFIG_DIR%".
  echo     Sign in once with plain  claude  ^(run /login^), then retry cc.
  exit /b 1
)
for /f "usebackq delims=" %%S in (`bun "%REPO_ROOT%\src\read-oauth.js" scopes`) do set "CLAUDE_CODE_OAUTH_SCOPES=%%S"

REM --- make sure the rerouting proxy is running; start it if not ---
REM     `call` is required: `bun` resolves to bun.cmd, and invoking a .cmd from a .cmd
REM     without `call` transfers control and never returns (claude below would not run).
call bun "%REPO_ROOT%\src\ensure-proxy.js"
if errorlevel 1 exit /b 1

REM --- launch claude with all passed-through args (RC on by default via settings.json) ---
claude %*
