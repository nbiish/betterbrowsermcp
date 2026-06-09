# Reference Architecture: upstream @browsermcp/mcp vs betterbrowsermcp

This document is the **expert reference** for the betterbrowsermcp project.
It captures the architecture of the upstream `@browsermcp/mcp@0.1.3`
(the codebase betterbrowsermcp forks), explains what we kept, what
we changed, and what we added — and why.

The full vendored upstream source is at `upstream/` for line-by-line
study. This doc is the narrative.

---

## 1. The base system we're forking

`@browsermcp/mcp` is the upstream package. It implements an MCP
server that lets an LLM drive a browser tab through a Chrome
extension. The architecture is two halves:

```
┌─────────────────┐     stdio     ┌──────────────────────────┐
│ LLM (e.g.       │ ─────────────► │ @browsermcp/mcp          │
│ Claude, Codex)  │   MCP over     │ Node.js process          │
│                 │   JSON-RPC    │                          │
└─────────────────┘               │  - exposes browser_*     │
                                  │    tools (navigate,      │
                                  │    click, snapshot,      │
                                  │    ...)                  │
                                  │                          │
                                  │  - opens WebSocket on    │
                                  │    port 9009             │
                                  │    (/ws/<agentId>)      │
                                  └──────────┬───────────────┘
                                             │ WS
                                             ▼
                                  ┌──────────────────────────┐
                                  │ Chrome extension         │
                                  │ (Browser MCP v1.3.4)     │
                                  │                          │
                                  │  - runs content script   │
                                  │    in every page         │
                                  │  - does DOM ops on the   │
                                  │    bound tab             │
                                  │  - returns results via   │
                                  │    the WebSocket         │
                                  └──────────────────────────┘
```

The key design choices in upstream:

1. **One MCP process, one WebSocket, one browser tab.** The upstream
   server holds a single `Context` with one WebSocket. The extension
   binds one tab to that WebSocket.

2. **Hardcoded port 9009.** The WS path is `/`, the agent ID is
   `mcp` (literally). Only one server can run on a machine at a
   time.

3. **"Murder the other process" startup.** To free port 9009 if
   a stale instance is squatting, the server runs
   `lsof -ti:9009 | xargs kill -9` on startup. (This is the
   `killProcessOnPort` function in `upstream/src/utils/port.ts`.)

4. **Single-context routing.** All tool calls go to the one
   WebSocket. The extension routes them to the one bound tab.

5. **Recursion bug in `server.close()`.** The override calls itself
   instead of the parent — every reconnect blows the stack with
   `RangeError: Maximum call stack size exceeded`.

6. **Workspace monorepo deps.** The published package relies on
   `@repo/*` and `@r2r/messaging` workspaces that aren't in the
   public repo — the source can't be built standalone.

7. **No tab management.** No concept of multiple tabs, no labels,
   no active tab. Just one tab per process.

The upstream protocol over the WebSocket is:

```
Server → Extension:
  { id, type: "browser_navigate", payload: {url} }
  { id, type: "browser_click", payload: {element, ref} }
  { id, type: "browser_snapshot", payload: {} }
  ... (and ~12 more browser_* types)

Extension → Server:
  { type: "messageResponse", payload: {requestId, result|error} }
```

Each request has a unique `id` (server-generated); the response
echoes it back for correlation.

---

## 2. What betterbrowsermcp changed

**v0.1 → v0.2.0 (multi-agent):** forked the upstream, fixed
the recursion bug, removed `killProcessOnPort`, added multi-agent
routing via path-based agent IDs.

**v0.2.0 → v0.3.0 (multi-tab):** added per-tab labels, per-agent
active tab, optional `tabId` on every browser_* tool, plus five
new management tools (`browser_list_tabs`, `browser_open_tab`,
`browser_close_tab`, `browser_rename_tab`,
`browser_set_active_tab`).

### Side-by-side comparison

| | Upstream v0.1.3 | betterbrowsermcp v0.3.0 |
|---|---|---|
| **Process model** | One process, one WebSocket, one tab | One process per agent (different ports) |
| **Agent ID** | Hardcoded "mcp" | `BROWSER_MCP_AGENT_ID` env var |
| **WS path** | `/` | `/ws/<agent-id>` |
| **Port** | 9009 (hardcoded) | `BROWSER_MCP_PORT` env var (default 9009) |
| **Port collision** | `killProcessOnPort` (silently murders the other process) | **Hard error** — refuses to start, prints diagnostics |
| **Tabs per process** | One (single Context) | Many — registered by tabId in the extension |
| **tabId on tool calls** | N/A | Optional on every browser_* tool |
| **Multi-tab management** | None | 5 new tools: list/open/close/rename/setActive |
| **Tab labels** | None | Free-form strings, surfaced in snapshots and the popup |
| **Active tab per agent** | Implicit (the one bound tab) | Explicit — tool calls with no tabId route to the active tab |
| **`server.close()` recursion** | Bug — blows stack on every reconnect | **Fixed** with explicit `__origClose` binding |
| **Workspace monorepo deps** | Required (can't build standalone) | **Inlined** — `config.ts`, `messaging.ts`, `types.ts`, `utils.ts` |
| **Bind address** | 0.0.0.0-equivalent | Defaults to 127.0.0.1 (localhost-only) |
| **Bind to any process** | Clobbers any process on port 9009 | Refuses to clobber; agents must use different ports |
| **Build** | `pnpm` workspace + monorepo | `npm install && npm run build` — self-contained |

### Files: what we kept, what we changed, what we added

**Kept (logic is essentially identical, may have minor edits):**
- `src/tools/common.ts` — navigate, goBack, goForward, pressKey, wait
- `src/tools/snapshot.ts` — snapshot, click, hover, type, selectOption
- `src/tools/custom.ts` — screenshot, getConsoleLogs
- `src/tools/tool.ts` — Tool/ToolSchema/ToolResult types
- `src/resources/resource.ts` — Resource types
- `src/utils/aria-snapshot.ts` — ARIA YAML snapshot (extended to embed tab list)
- `src/utils/log.ts` — debug log helper
- `src/index.ts` — entry point (rewrote for multi-process banner)
- `src/server.ts` — MCP server, tool dispatch (rewrote to remove ContextRegistry)

**Replaced entirely (inlined from upstream monorepo):**
- `upstream/src/config.ts` → `src/config.ts` — env var resolution, WS path helpers
- `upstream/src/types.ts` → `src/types.ts` — Zod tool schemas (extended with 5 new tools)
- `upstream/src/messaging.ts` → `src/messaging.ts` — WS message protocol + sender
- `upstream/src/utils.ts` → `src/utils.ts` — wait() + non-murderous port helpers
- `upstream/src/context.ts` → `src/context.ts` — per-process Context (rewrote for single-agent)
- `upstream/src/utils/port.ts` → REMOVED (murder behavior gone)

**Added:**
- `src/tools/manage.ts` — 5 new management tool handlers
- `BROWSER_MCP_AGENT_ID` env var — multi-agent identification
- `BROWSER_MCP_PORT` env var — per-agent port
- `BROWSER_MCP_BIND` env var — bind address (defaults to 127.0.0.1)
- `BROWSER_MCP_AUTH_TOKEN` env var — optional WS auth handshake
- `BROWSER_MCP_NO_KILL_PORT` env var — escape hatch (default: refuse)
- `BROWSER_MCP_AGENT_SEPARATOR` env var — tool prefix separator
- `BROWSER_MCP_WS_PATH_PREFIX` env var — WS path prefix

**Removed:**
- `killProcessOnPort` startup behavior
- Workspace monorepo dependencies
- Single hardcoded agent ID ("mcp")
- Hardcoded port 9009

---

## 3. Protocol additions in v0.3.0

Every `browser_*` tool now accepts an optional `tabId` argument:

```ts
browser_navigate: { url: string, tabId?: number }
browser_click:    { element: string, ref: string, tabId?: number }
browser_type:     { element, ref, text, submit, tabId? }
browser_snapshot: { tabId? }
// ... and 10 more
```

The semantics:
- `tabId` provided → route to that specific bound tab
- `tabId` absent → route to the agent's **active tab** (or first
  bound tab if no active is set)

Five new management messages on the WebSocket:

```
Server → Extension:
  { id, type: "browser_list_tabs",       payload: {} }
  { id, type: "browser_open_tab",        payload: {url?, label?} }
  { id, type: "browser_close_tab",       payload: {tabId} }
  { id, type: "browser_rename_tab",      payload: {tabId, label} }
  { id, type: "browser_set_active_tab",  payload: {tabId} }

Extension → Server:
  { type: "messageResponse", payload: {requestId, result|error} }
```

Result types for the management calls:
- `browser_list_tabs` → `{tabs: [{tabId, label, url, title, isActive}], activeTabId}`
- `browser_open_tab` → `{tabId, label, url}`
- `browser_close_tab` / `browser_rename_tab` / `browser_set_active_tab` → `{ok: true}`

The ARIA snapshot output now also embeds a "Bound tabs for this
agent" block so the LLM always knows what's available:

```yaml
- Page URL: https://dashboard.stripe.com
- Page Title: Stripe Dashboard
- Bound tabs for this agent:
  - tabId=12345  label="Stripe dashboard"  url=https://dashboard.stripe.com
  - tabId=67890  label="OpenAI console"    url=https://platform.openai.com
- Page Snapshot
\`\`\`yaml
- button "Connect" [ref=e1]
- ...
\`\`\`
```

This means the LLM never needs a separate `browser_list_tabs`
call to discover what's bound — the snapshot tells it.

---

## 4. Real-world use case: Stripe + OpenAI multi-tab

The driver for v0.3.0 is website portfolio monetization. The flow:

1. User binds two tabs to the `hermes` agent:
   - `https://dashboard.stripe.com` (label: "Stripe dashboard")
   - `https://platform.openai.com` (label: "OpenAI console")

2. LLM session:
   ```
   LLM: "I need to set up the Stripe webhook. Let me first see what
         tabs are bound."
   → browser_list_tabs
   ← tabId=12345  label="Stripe dashboard"  url=...
     tabId=67890  label="OpenAI console"    url=... ← ACTIVE

   LLM: "Switch focus to Stripe."
   → browser_set_active_tab(tabId=12345)
   ← ok

   LLM: "Snapshot the dashboard."
   → browser_snapshot
   ← (full ARIA tree for the Stripe dashboard)

   LLM: "Click 'Webhooks' in the left sidebar."
   → browser_click(element="Webhooks link in sidebar", ref="e14")
   ← ok + new snapshot

   LLM: "Now switch to OpenAI and grab the API key."
   → browser_set_active_tab(tabId=67890)
   → browser_snapshot
   → browser_click(element="API keys", ref="e7")
   ```

The key insight: `browser_set_active_tab` is the LLM's way of
saying "now I'm working on this tab." All subsequent unspecific
tool calls (without `tabId`) go to the active tab. This makes
multi-site workflows natural.

Passkey auth on Stripe works because the extension is driving
the user's actual browser — no headless bypass, no virtual
WebAuthn, just real Chrome with the user's profile. This was the
explicit reason for forking away from the headless-style tools
that don't satisfy Stripe's passkey requirement.

---

## 5. How the WebSocket handshake works

```
Extension WS to server, on first message:
  1. WS upgrade: GET /ws/<agentId>
  2. (If BROWSER_MCP_AUTH_TOKEN is set) Extension sends:
     { type: "auth", token: "..." }
  3. Server validates, sends 4401 close if wrong
  4. Server marks the Context as authenticated

Subsequent messages:
  Extension → Server: {type: "messageResponse", payload: {requestId, result|error}}
  Server → Extension: {id, type: "browser_*", payload: {...}}

Reconnection:
  Extension drops WS on close. Background retries with backoff:
  1s, 2s, 5s, 10s, 30s (capped). Auth handshake re-runs.
```

The extension's `background.js` (in
`nbiish/betterbrowsermcp-extension`) owns the reconnect logic
and the per-agent WS pool. It tracks:

- `chrome.storage.sync["endpoints"]` — list of WS URLs to monitor
- `chrome.storage.local["bindings"]` — `{tabId: agentId}` map
- `chrome.storage.local["tabMeta"]` — `{tabId: {label, url, title}}`
- `chrome.storage.local["activeTabs"]` — `{agentId: tabId}`

The content script (`content.js`) handles DOM operations and
ARIA snapshot generation per-page. Refs (`e1`, `e2`, ...) are
stable for the lifetime of a page; a re-snapshot reassigns them.

---

## 6. Debugging: comparing upstream vs betterbrowsermcp behavior

| Symptom | Upstream cause | betterbrowsermcp fix |
|---|---|---|
| `RangeError: Maximum call stack size exceeded` in `mcp-stderr.log` | Recursion bug in `server.close()` | Patched in `src/server.ts` with `__origClose` binding |
| Two MCP clients (e.g. Hermes + OMP) keep killing each other's server | `killProcessOnPort` murders the other on startup | Hard-fail; multiple agents use different ports |
| Tool calls fail randomly with `ClosedResourceError` every ~90s | One server kills the other, the loser's keepalive fails | No more port fights; stable connections |
| Two tabs bound to one agent — `browser_navigate` only affects one | No concept of multiple tabs; single Context | `tabId` parameter + per-agent active tab |
| Source won't build (`Cannot find module '@repo/types'`) | Workspace monorepo deps not in the public repo | Inlined into single-package repo |
| Server binds to 0.0.0.0 by default | `WebSocketServer({ port: ... })` without `host` | Defaults to 127.0.0.1 via `WebSocketServer({ noServer: true })` + explicit `httpServer.listen(port, host)` |

---

## 7. Where to look

- `upstream/` — full vendored upstream source, frozen at v0.1.3
- `upstream/VENDORED.md` — provenance and why this is frozen
- `../../src/` — betterbrowsermcp source (this is the runtime code)
- `../../src/types.ts` — Zod tool schemas (read this first for the
  surface area)
- `../../src/server.ts` — tool dispatch + `__origClose` patch
- `../../src/config.ts` — env var resolution
- `../../../` — the repo root, with `README.md`, `package.json`, etc.

For the extension side (which the MCP server talks to), see
`nbiish/betterbrowsermcp-extension/README.md` and
`content.js` (DOM ops) + `background.js` (WS pool + multi-tab
routing).

---

## 8. What we'd love from upstream

If upstream ever does any of these, betterbrowsermcp's reason
to exist shrinks (good — we want the upstream to win eventually):

- Multi-tab support in the extension
- Multi-agent routing with port collision detection
- Fix the `server.close()` recursion
- Stop the `killProcessOnPort` murder

Until then, this fork is the v0.3.0+ reality.
