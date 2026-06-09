<h1 align="center">Better Browser MCP</h1>

<p align="center">
  Multi-agent local browser automation. Drop-in upgrade of <a href="https://github.com/browsermcp/mcp">@browsermcp/mcp</a> with configurable ports, per-agent WebSocket paths, and no more port-9009 fighting between agents.
  <br />
  <a href="https://github.com/nbiish/betterbrowsermcp/issues">Issues</a>
  •
  <a href="#multi-agent-setup">Multi-agent setup</a>
  •
  <a href="#why">Why this exists</a>
</p>

---

## What's different from `@browsermcp/mcp`?

| | `@browsermcp/mcp@0.1.3` | `@betterbrowsermcp/mcp@0.2.0` |
|---|---|---|
| Port collision behavior | Silently kills the other process (`lsof -ti:9009 \| xargs kill -9`) | Hard error, process exits with clear message |
| Multiple agents on one machine | Each MCP process fights for the same port | Each agent runs on its own port — no fighting |
| Agent identification | None | `BROWSER_MCP_AGENT_ID` env var, exposed in WS path |
| WebSocket path | `/` (any) | `/ws/<agent-id>` |
| Auth | None | Optional `BROWSER_MCP_AUTH_TOKEN` for shared-secret handshake |
| Recursion bug in `server.close()` | Yes (crashes on every reconnect) | **Fixed** — explicit `__origClose` binding |
| Workspace monorepo deps | Required `@repo/*` for build | Self-contained, builds from a single `npm install` |
| Bind address | Any | Defaults to `127.0.0.1` (localhost-only by default) |

All `browser_navigate`, `browser_click`, `browser_snapshot`, etc. tool names are identical to upstream — no client changes needed on the LLM side.

---

## Quick start

### Single agent (one process, one browser)

```bash
npx @betterbrowsermcp/mcp@latest
# or, from this checkout:
npm install
npm run build
node dist/index.js
```

The server binds port 9009, WebSocket at `ws://127.0.0.1:9009/ws/default`. The browser extension connects there.

### Multi-agent (one process per agent, all sharing one browser)

```bash
# Agent "hermes" on port 9009
BROWSER_MCP_AGENT_ID=hermes BROWSER_MCP_PORT=9009 \
  npx @betterbrowsermcp/mcp@latest &

# Agent "omp" on port 9010
BROWSER_MCP_AGENT_ID=omp BROWSER_MCP_PORT=9010 \
  npx @betterbrowsermcp/mcp@latest &

# Agent "codex" on port 9011
BROWSER_MCP_AGENT_ID=codex BROWSER_MCP_PORT=9011 \
  npx @betterbrowsermcp/mcp@latest &
```

Each process binds its own port. They never fight. The browser extension connects to all three WebSocket endpoints and lets the user bind each tab to a specific agent.

---

## Multi-agent setup

The user-facing flow:

1. **Start one MCP process per agent** (different ports, different `BROWSER_MCP_AGENT_ID`)
2. **Configure the browser extension** with the list of WS endpoints to monitor (e.g. `ws://127.0.0.1:9009/ws/hermes`, `ws://127.0.0.1:9010/ws/omp`)
3. **For each browser tab**, the user clicks the extension icon and picks which agent controls it. The binding persists for that tab until changed or disconnected.
4. **Different tabs can be bound to different agents** — the same browser serves many agents concurrently.

The MCP processes don't know about each other. The browser extension is the multiplexer that knows which agent controls which tab.

## Multi-tab per agent (v0.3.0+)

A single agent can have **multiple browser tabs** bound to it, so a Hermes-style agent can drive Stripe in one tab and the inference provider dashboard in another, all from one MCP process. The LLM picks which tab to act on.

### Tools for multi-tab work

| Tool | Purpose |
|---|---|
| `browser_list_tabs` | List all bound tabs with their tabId, label, URL, active marker |
| `browser_open_tab` | Open a new tab and bind it (optional `url`, `label`) |
| `browser_close_tab` | Close a bound tab |
| `browser_rename_tab` | Set a human-readable label on a tab |
| `browser_set_active_tab` | Switch which tab unspecific tool calls route to |

Every existing `browser_*` tool also accepts an optional `tabId` parameter. If omitted, the call routes to the agent's **active tab**.

### Example: driving Stripe + OpenAI console from one agent

```
LLM: "I need to set up a Stripe webhook. Let me check what tabs are bound."
  -> browser_list_tabs
  -> response:
      tabId=12345  label="Stripe dashboard"  url=https://dashboard.stripe.com
      tabId=67890  label="OpenAI console"    url=https://platform.openai.com  ← ACTIVE

LLM: "I should focus on Stripe first."
  -> browser_set_active_tab(tabId=12345)

LLM: "Let me take a snapshot of the Stripe dashboard."
  -> browser_snapshot
  -> response: full ARIA tree, refs like e1, e2, ... for the Stripe dashboard

LLM: "Click 'Webhooks'."
  -> browser_click(element="Webhooks link in sidebar", ref="e14")

LLM: "Now switch to the OpenAI console and grab the API key."
  -> browser_set_active_tab(tabId=67890)
  -> browser_snapshot
  -> browser_click(element="API keys", ref="e7")
```

### Multi-tab vs. multi-agent

- **Multi-agent** = multiple MCP processes, one per agent (e.g. Hermes + OMP + Codex), each with its own port and WS endpoint
- **Multi-tab** = within ONE agent's MCP process, multiple browser tabs are bound, with per-tab labels and an "active" tab for unspecific calls

The two compose: spawn N MCP processes (multi-agent), each connects to the same browser with M tabs (multi-tab), and the LLM picks which `(agent, tab)` pair to drive for each tool call.

## Environment variables

| Var | Default | Description |
|---|---|---|
| `BROWSER_MCP_AGENT_ID` | `default` | Agent identifier. Used in the WS path (`/ws/<id>`) so the extension can route tab bindings. |
| `BROWSER_MCP_PORT` | `9009` | WebSocket port to bind. Use different ports for different agents. |
| `BROWSER_MCP_BIND` | `127.0.0.1` | Bind address. **Never** set to `0.0.0.0` — exposes browser automation to the network. |
| `BROWSER_MCP_AUTH_TOKEN` | _(unset)_ | Optional shared secret. If set, the extension must send `{type:"auth", token:"..."}` as its first WS message, else the connection is closed with 4401. |
| `BROWSER_MCP_WS_PATH_PREFIX` | `/ws` | Path prefix for the WS endpoint. Default `/ws` means the agent's endpoint is at `/ws/<agentId>`. |

---

## Browser extension

Better Browser MCP is server-side only. The browser extension that talks to it is a fork of the upstream `@browsermcp` extension with two changes:

1. **Configurable WS endpoints** — instead of a hard-coded `ws://localhost:9009`, the extension popup lets the user add/remove WS endpoints to monitor. Each is identified by agent ID.
2. **Per-tab agent binding** — when the user clicks the extension icon on a tab, they see a list of currently-connected agents (i.e. which WS endpoints are open and which tabs they're bound to). Picking one binds the current tab to that agent until changed or disconnected.

The forked extension is built separately and lives in `nbiish/betterbrowsermcp-extension` (forthcoming).

Until that's ready, you can patch the upstream extension to:
- Read WS endpoints from a config (instead of hardcoded `localhost:9009`)
- Show a tab-binding UI in the popup

---

## Why this exists

The original `@browsermcp/mcp@0.1.3` has two design flaws that cause constant pain in multi-agent setups:

### 1. `killProcessOnPort` on startup

Every time the server starts, it runs `lsof -ti:9009 | xargs kill -9` before binding. This was meant to free the port from a stale previous instance, but in a multi-agent world it means **every agent's MCP process murders every other agent's MCP process on startup**. The result: keepalive failures every ~90s, `ClosedResourceError` on every tool call, weeks of debugging.

Better Browser MCP removed this. Port collision is now a hard error with a clear message: which port, which env var to change, and how to investigate (`lsof -ti:<port> | xargs ps -p`).

### 2. Single WebSocket per process, no agent awareness

The upstream server has a single `Context` object holding the one WebSocket. There's no concept of "I'm agent X, please route my tool calls to my tab". The result: in a multi-agent setup, only one agent can have a tab connected at a time, and the others fail with "No connection to browser extension".

Better Browser MCP gives each MCP process an explicit `BROWSER_MCP_AGENT_ID`. The WebSocket is served at `/ws/<agentId>`. The browser extension binds tabs to specific agent IDs. Each agent gets its own dedicated tab.

### 3. Recursion bug in `server.close()`

The upstream `dist/index.js` has `server.close = async () => { await server.close(); ... }` — it calls itself recursively, blowing the stack on every reconnect with `RangeError: Maximum call stack size exceeded`.

Better Browser MCP fixes this with explicit `__origClose` binding.

---

## Development

```bash
# Install deps
npm install

# Typecheck
npm run typecheck

# Build (ESM via tsup)
npm run build

# Test (manual)
BROWSER_MCP_AGENT_ID=hermes BROWSER_MCP_PORT=9099 \
  npm start
# in another shell:
curl http://127.0.0.1:9099/
# {"name":"Better Browser MCP (agent: hermes)","bind":"127.0.0.1","port":9099, ...}
```

### Project structure

```
src/
  config.ts           env var resolution, WS URL helpers
  context.ts          per-process Context (one WebSocket = one tab)
  messaging.ts        WS message protocol (inlined from upstream)
  server.ts           MCP server, tool routing
  tools/              tool implementations (navigate, click, etc.)
  utils.ts            helpers (wait, port check)
  ws.ts               WebSocket server with auth handshake
  index.ts            entry point
  types.ts            Zod schemas (inlined from upstream's monorepo)
```

### Patched bugs from upstream

- **`server.close()` recursion** (src/server.ts: in `createServerWithTools`): capture `originalClose` before override
- **`killProcessOnPort` murder** (removed entirely — src/utils.ts: only `isPortInUse` remains)
- **Workspace monorepo deps** (inlined into single-package repo)

---

## Credits

Better Browser MCP is a fork of [browsermcp/mcp](https://github.com/browsermcp/mcp) with the multi-agent fixes needed for the [Hermes](https://hermes-agent.nousresearch.com/) + [OMP](https://github.com/can1357/oh-my-pi) + Codex multi-agent workflow. Originally adapted from Microsoft's Playwright MCP server.

By [Nbiish](https://github.com/nbiish) — first repo, but probably not the last.
