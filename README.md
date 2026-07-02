# claude-code-split-billing

Keep Claude Code's **Remote Control** (which needs a `claude.ai` subscription login)
working, while routing all **LLM inference** to a custom, Anthropic-compatible
**gateway** — so token usage is billed to that gateway instead of consuming your
subscription quota. **And it's isolated: plain `claude` is completely unaffected.**

- Log in with your **subscription (OAuth)** → Remote Control works: you can view and
  drive this machine's sessions from `claude.ai/code` and the mobile app.
- A small local proxy reroutes inference (`POST /v1/messages*`) to **your gateway**, so
  per-token inference is billed there, **not** against your subscription.
- `cc` talks to the proxy over a **private per-user unix socket**. No system hosts-file
  change, no port 443, no certificates. Run `cc` and a normal `claude` side by side.

<p align="center">
  <img src="docs/architecture.svg" alt="Architecture: subscription Remote Control stays on while inference is billed to a custom gateway, isolated from plain claude" width="100%">
</p>

---

## ⚠️ Disclaimer

- Your subscription fee is still due. Its role is reduced to "paying for Remote
  Control". You only save the **per-token inference cost** — worth it only if your
  gateway's tokens are meaningfully cheaper than your subscription's included usage.
- This relies on **undocumented client behavior** (`ANTHROPIC_UNIX_SOCKET`, an internal
  "claude ssh remote" transport) and routes inference to a third-party gateway, which
  **sits past the edge of the Terms of Service**. A future release may change or remove
  this at any time. **Use at your own risk.**
- Unlike the older approach (see [`legacy/`](./legacy)), this does **not** MITM an
  official host, edit your system hosts file, or install any certificate into a trust
  store. Everything is scoped to the `cc` process via environment variables.
- Provided under the MIT license with no warranty. You are responsible for complying
  with the terms of every service you connect to.

---

## How it works

Claude Code makes two kinds of network requests. In socket mode it sends **all** of them
over the unix socket to the local proxy, which splits them by path:

| Traffic | Path | Where the proxy sends it |
|---|---|---|
| **Inference** | `POST /v1/messages*` | your gateway (billed there); gateway auth headers injected, model id optionally remapped |
| **Control plane** (OAuth, Remote Control sessions/bridge/heartbeat, feature flags, MCP registry) | everything else | the **real** `api.anthropic.com`, with your OAuth bearer injected |

Key mechanics:

1. **Remote Control is enabled when** the session is first-party (OAuth) **and**
   *either* `ANTHROPIC_UNIX_SOCKET` is set *or* the base-URL host is `api.anthropic.com`.
   Setting the socket **satisfies the gate without any host trickery**.
2. **With `ANTHROPIC_UNIX_SOCKET` set, Claude Code sends all API traffic over that socket**
   using Bun's `fetch(url, { unix })`. `cc` also sets
   `ANTHROPIC_BASE_URL=http://api.anthropic.com` so the socket carries **plain HTTP** —
   no TLS handshake, so **no certificate is needed**.
3. **In socket mode Claude Code attaches no auth of its own** ("the local proxy is
   API-key-authed"). The proxy injects what each side needs: your **gateway credentials**
   on inference, and your **OAuth bearer** (read fresh from
   `$CLAUDE_CONFIG_DIR/.credentials.json`, so refreshes are picked up) on the control plane.
4. `cc` exports `CLAUDE_CODE_OAUTH_TOKEN` (read from your stored login) because the
   inference SDK needs an auth method *resolved* in socket mode. It is **not sent
   upstream** — it's a local marker; the proxy does the real authentication.
5. **Isolation:** plain `claude` never sets any of these variables, so it uses its normal
   direct connection to `api.anthropic.com`. cc's setup lives entirely in cc's environment.

### Why Bun (and a little Node)

On **Windows**, Bun's `unix` option is an **AF_UNIX filesystem socket**, which **Node
cannot serve** — so the proxy runs under **Bun** (`Bun.serve({ unix })`). Bun's
`spawn` does not keep a child alive after the parent exits on Windows, so a tiny **Node**
shim (`src/spawn-proxy.js`) launches the Bun proxy detached (Node's detached spawn does
survive). Node is used only as that launcher; all serving/forwarding is Bun.

---

## Requirements

- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) CLI installed and on your `PATH`.
- **[Bun](https://bun.sh) ≥ 1.1** — the proxy runtime. Install once: `npm i -g bun`.
- **Node.js ≥ 18** — used only to launch the proxy in the background (almost always already present).
- A Claude **Pro/Max subscription** (OAuth login + Remote Control).
- A reachable **Anthropic-compatible inference gateway** and its credentials.

No Administrator/root, no hosts-file edit, no port 443, no certificate.

---

## Repository layout

```
claude-code-split-billing/
├── src/
│   ├── proxy.js              # Bun proxy on the unix socket:
│   │                         #   POST /v1/messages -> gateway, rest -> real anthropic
│   ├── ensure-proxy.js       # Bun: ping the socket; start the proxy if it isn't up
│   ├── spawn-proxy.js        # Node shim: launch the Bun proxy fully detached
│   └── read-oauth.js         # Bun: print an OAuth field from stored creds (for cc)
├── bin/
│   └── cc.cmd / cc           # launchers wrapping `claude` (Windows / *nix)
├── config/
│   └── settings.example.json # enableRemoteControlByDefault: true
├── scripts/
│   └── setup-config.ps1 / .sh   # choose the config dir + enable Remote Control
├── legacy/                   # the deprecated hosts-hijack + TLS-MITM approach (reference)
└── .env.example              # gateway config template — copy to .env
```

Secret files are git-ignored: `.env`, `.claude-config/`, `*.sock`, `*.log`.

---

## Setup

### 1. Get the code and configure the gateway

```bash
git clone <your-fork-url> claude-code-split-billing
cd claude-code-split-billing
cp .env.example .env          # Windows: copy .env.example .env
```

Edit `.env`: `GATEWAY_HOST` (required), `GATEWAY_BASE_PATH`, `GATEWAY_HEADERS`
(**your secret key goes here**), and `GATEWAY_MODEL_MAP` (map the model ids Claude Code
sends — including the default **`fable`** — to ids your gateway knows, or it returns
`400 Deployment not found`).

### 2. Install Bun (once)

```bash
npm i -g bun        # or: curl -fsSL https://bun.sh/install | bash   (macOS/Linux)
bun --version
```

### 3. Choose a config directory + enable Remote Control

`setup-config` records which Claude Code config dir `cc` uses (`.cc-config-dir`) and turns
on Remote Control. Run with no flag to be asked; or pass `--inherit` (share your real
`~/.claude` — recommended, so Remote Control uses your existing login) / `--isolated`
(separate login under `cc`).

- **Windows:** `powershell -ExecutionPolicy Bypass -File scripts\setup-config.ps1`
- **macOS/Linux:** `scripts/setup-config.sh`

### 4. Put the launcher on your PATH, then log in

Add `bin/` to `PATH` (or symlink `bin/cc` / copy `bin\cc.cmd` onto it). Make sure you are
logged in with your subscription — either run plain `claude` once and `/login`
(subscription / claude.ai), or in `--isolated` mode run `cc` then `/login`.

```bash
cc
```

### 5. Verify

- Ask anything (e.g. `hi`).
- `proxy.log` should show **both**:
  `REQ POST /v1/messages -> INFER ...` → `RES 200 INFER` (inference billed to gateway),
  **and** `REQ ... -> CTRL ...` → `RES 200 CTRL` for the control plane / Remote Control.
- Startup does **not** show "only available when using Claude via api.anthropic.com".
- Open `claude.ai/code` (or the mobile app) on the same account and confirm the session
  appears and is controllable.
- In another terminal, plain `claude` still works normally and independently.

---

## Daily usage

Use `cc` as a drop-in for `claude` — all arguments pass through:

```bash
cc                                   # normal interactive session
cc --resume
cc --dangerously-skip-permissions
```

On each launch `cc`: inherits your config dir → clears `ANTHROPIC_API_KEY`-type vars
(keeps OAuth) → picks a short socket path (`~/.cc/cc.sock`, override with `CC_SOCK`) →
exports `ANTHROPIC_UNIX_SOCKET` + `ANTHROPIC_BASE_URL=http://api.anthropic.com` +
`CLAUDE_CODE_OAUTH_TOKEN` (read from your stored login) → ensures the Bun proxy is running
(`ensure-proxy.js`) → launches `claude`. Remote Control is on by default via `settings.json`.

To go back to plain, un-split Claude Code, just run `claude` — nothing about it was
changed. To stop the background proxy, kill the `bun … src/proxy.js` process (the next
`cc` restarts it).

---

## Configuration

Gateway settings live in `.env` (loaded by `src/proxy.js`). See `.env.example`.

| Variable | Default | Purpose |
|---|---|---|
| `GATEWAY_HOST` | — (**required**) | Gateway hostname inference is billed to. |
| `GATEWAY_PORT` | `443` | Gateway TLS port. |
| `GATEWAY_BASE_PATH` | empty | Path prefix prepended before `/v1/messages`. |
| `GATEWAY_HEADERS` | `{}` | JSON of headers to inject on inference (auth/identity). |
| `GATEWAY_STRIP_HEADERS` | `authorization,x-api-key` | Client headers removed before forwarding upstream. |
| `GATEWAY_MODEL_MAP` | empty | JSON `{substring: replacement}`; remaps model ids (include `fable`). |
| `GATEWAY_DEFAULT_MODEL` | empty | Model id used only when a request has no/invalid model. |
| `CONTROL_HOST` | `api.anthropic.com` | Real control-plane host the proxy forwards non-inference traffic to. |

The socket path is not in `.env` — `cc` sets it (default `~/.cc/cc.sock`). Override by
exporting `CC_SOCK=/short/path.sock` before `cc` (keep it short: the AF_UNIX path limit is
~108 characters).

---

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `cc: Bun is required` | Install Bun: `npm i -g bun`. |
| `cc: no Claude OAuth login found` | You're not logged in for the config dir `cc` uses. Run plain `claude` + `/login` (subscription), or `cc` + `/login` in `--isolated` mode. |
| `Could not resolve authentication method` in the log | `CLAUDE_CODE_OAUTH_TOKEN` wasn't set — usually the same "not logged in" cause above. |
| `400 Deployment of "claude-fable-…" not found` (or wrong model) | Add a `fable` entry (and any others) to `GATEWAY_MODEL_MAP` pointing at ids your gateway actually has. |
| RC works but inference still hits your subscription | `proxy.log` has no `INFER -> <gateway>` line. Confirm `.env` `GATEWAY_HOST` is set and the proxy is running. |
| `ENAMETOOLONG` starting the proxy | The socket path is too long. Set `CC_SOCK` to something short (e.g. `~/.cc/cc.sock`). |
| `ensure-proxy: proxy did not come up` | See `proxy-stdout.log` / `proxy.log`. Usually a bad `.env` (missing `GATEWAY_HOST`) or Bun not found. |
| Remote Control doesn't appear | Make sure you logged in with the **subscription (claude.ai)** option (not an API key), and `enableRemoteControlByDefault` is set (via `setup-config`). |

---

## Security notes

- Your gateway secret lives in `.env` (git-ignored). Never commit it; rotate if it leaks.
- The proxy reads your OAuth bearer from `$CLAUDE_CONFIG_DIR/.credentials.json` and injects
  it only on control-plane requests to `CONTROL_HOST`. It is never sent to the gateway.
- The isolated config dir `.claude-config/` (in `--isolated` mode) holds **OAuth
  credentials**. Protect it.
- The proxy listens only on the local unix socket (`~/.cc/cc.sock`), not on any TCP port.

---

## License

[MIT](./LICENSE)
