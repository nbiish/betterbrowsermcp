---
name: bbmcp
description: >-
  Connect any agent harness to the user's real, logged-in Chrome browser via
  Better Browser MCP (bbmcp). Start or attach to a local hub, claim your own
  agent identity, wire the MCP endpoint with zero user settings changes, work
  only in tabs you own (or that the user explicitly binds to you), and
  coordinate multi-tab work with other concurrent agents via advisory locks.
  Use whenever the task requires browsing, scraping, form-filling, testing a
  web app, capturing click-to-copy values, or parallel multi-tab work in the
  user's browser.
---

# bbmcp — drive the user's real browser as your own agent

One local **hub** process serves many agents. Each agent gets its own
isolated context, its own tabs, and its own MCP endpoint. You never touch
another agent's tabs, and the user never touches yours — unless they
explicitly bind a tab to you in the extension popup (explicit consent).

## Quickstart (zero config, zero user steps)

```bash
# 1. Attach — ALL arguments optional. Discovers/reuses the hub on ports
#    9223-9237 (or starts one on a free port), claims your agentId
#    (--agent, $BBMCP_AGENT_ID, or auto-generated), verifies your
#    endpoint, and prints ready-to-paste MCP config:
node <path-to-betterbrowsermcp>/scripts/bbmcp-connect.mjs --agent my-agent

# 2. NOTHING for the user to do. The extension auto-attaches to every
#    registered agent within ~30s. Only bind-their-tab remains a user
#    action — that consent gate is by design.

# 3. Wire your harness with the printed JSON (see "Harness wiring" below),
#    then call tools: browser_open_tab is your first tab.
```

## 1. The server

- **Hub (recommended, multi-agent):**
  `BROWSER_MCP_HUB=true BROWSER_MCP_PORT=9223 node <repo>/dist/index.js`
  One process, any number of agents. WS at `/ws/<agentId>`, MCP at
  `/mcp/<agentId>`, health at `GET /`.
- **Single-agent (one process per agent, legacy):**
  `BROWSER_MCP_AGENT_ID=<id> BROWSER_MCP_PORT=9109 npx @nbiish/betterbrowsermcp@latest`
  The extension auto-configures `hermes` and `default` endpoints on port
  9109 on first install — use 9109 to match.
- Build from source first if `dist/` is missing: `npm run build`.
- **Port collisions hard-fail** (never silently kills the other process).
  Never kill another agent's instance. The connect script avoids the
  problem entirely: it reuses an existing hub in 9223-9237 or starts on
  the first free port there — you never need to pick a port.
- Loopback binds need no auth. Non-loopback (`BROWSER_MCP_BIND=0.0.0.0`)
  REQUIRES `BROWSER_MCP_AUTH_TOKEN` — both transports fail closed without it.

## 2. Claim your identity

- Pick ONE stable agentId per agent: kebab-case, descriptive — e.g.
  `warp-oz`, `claude-research`, `codex-e2e`. It routes everything (WS, MCP,
  tab bindings, events), so do not change it mid-task.
- Your endpoints (port = whatever the connect script resolved — read its
  output instead of assuming 9223):
  - MCP: `http://localhost:<port>/mcp/<agentId>` (Streamable HTTP)
  - Extension WS (auto-attached by the extension): `ws://localhost:<port>/ws/<agentId>`

## 3. The tab contract (CRITICAL — read before any tool call)

- You can ONLY act on tabs **bound to you**. There is no global tab view.
- `browser_open_tab` creates and binds a new tab to you — your own workspace.
  Opening never steals focus unless `makeActive: true`.
- The user binds THEIR tab to you via the popup ("Bind to <agentId>") —
  that is explicit consent. Treat user-bound tabs as read-mostly unless the
  task says otherwise; `browser_unbind_tab`/popup unbind revokes access.
- One binding per tab. To share a tab between agents, the user rebinds it —
  access transfers, it is not simultaneous.
- **Advisory locks** arbitrate contention: `browser_acquire_tab` before long
  or conflicting work on a shared tab, `browser_release_tab` after. Locks
  auto-expire (TTL 5 min) but releasing early is polite. Expect
  `TAB_LOCKED`/`TAB_BUSY` errors and back off instead of retry-spamming.
- `browser_poll_events` delivers your buffered events
  (`binding_changed`, `navigation`, ...). Poll after pauses instead of
  re-listing tabs in a hot loop.

## 4. Tool playbook

```text
discover    browser_list_tabs            (labels + active tabId)
workspace   browser_open_tab {url?}      browser_close_tab
            browser_rename_tab {label}   browser_set_active_tab {tabId}
targeting   browser_navigate {url}       browser_go_back / browser_go_forward
            browser_wait_for_content     (content-script readiness)
            browser_wait_for_text {text} browser_wait {ms}
perceive    browser_snapshot             → element refs; REQUIRED before click/type
            browser_screenshot           browser_get_console_logs
act         browser_click {element, ref} browser_hover {element, ref}
            browser_type {element, ref, text, submit}
            browser_select_option {element, ref, values}
            browser_press_key {key}      browser_scroll? → browser_cursor_scroll
react-form  browser_set_input_value / browser_clear_input   (React-controlled inputs)
            browser_paste_text                              (SPA paste events)
extract     browser_extract_text {selector?}  browser_get_attribute {selector, attribute}
            browser_evaluate {js}             (last resort; page JS context)
capture     browser_copy_to_clipboard    ("click to copy" values: API keys, PATs)
parallel    browser_acquire_tab / browser_release_tab / browser_poll_events
```

- Workflow: `list_tabs → open_tab → navigate → wait_for_content → snapshot →
  act(ref) → wait_for_text/verify → poll_events`. Always snapshot before
  clicking: `ref` comes from the snapshot.
- Multi-tab parallelism is safe: per-tab op queues prevent interleaving
  inside one tab; different tabs of yours can work concurrently.

## 5. Cursor verbs (human-like interaction, CDP-backed)

`browser_cursor_move · browser_cursor_hover · browser_cursor_click ·
browser_cursor_click_hold · browser_cursor_drag · browser_cursor_scroll ·
browser_cursor_submit · browser_cursor_context_menu`

Real mouse/keyboard via `chrome.debugger` (attach/detach per verb). Chrome
shows a "debugging" banner while attached — the user sees this; it is
expected. Prefer normal tools (`browser_click`/`browser_type`) for speed;
use cursor verbs for canvas apps, drag-and-drop, hover menus, and
anti-bot-sensitive flows.

## 6. Secrets (never in plain inputs or logs)

10 `browser_secrets_*` tools backed by the user's PQC bundle
(ML-KEM-768 + AES-256-GCM): `status · list · get · load · add ·
add_from_clipboard · unlock_agent · lock_agent · copy_to_page · rotate`.

- Capture values with `browser_copy_to_clipboard` → `browser_secrets_add_from_clipboard`.
- Fill forms with `browser_secrets_copy_to_page` (injected into the page's
  MAIN world — values never transit the model context or tool results).
- `unlock_agent`/`lock_agent` scope agent access; relock when done.
- Never echo secret values into snapshots, logs, or tool arguments.

## 7. Harness wiring

**Warp** — Settings → Agents → MCP servers, in an agent config file, or per-run:

```json
{ "bbmcp": { "url": "http://localhost:9223/mcp/my-agent" } }
```

```bash
oz agent run --mcp '{"bbmcp":{"url":"http://localhost:9223/mcp/my-agent"}}' --prompt "..."
```

**Claude Code:** `claude mcp add --transport http bbmcp http://localhost:9223/mcp/my-agent`

**Generic Streamable HTTP (curl smoke test):**

```bash
curl -s http://localhost:9223/mcp/my-agent \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"smoke","version":"0.0.1"}}}'
```

MCP behavior notes: send header `Accept: application/json, text/event-stream`
(or you get 406). Responses may arrive as JSON or an SSE frame — handle both.
Echo the `Mcp-Session-Id` response header on subsequent requests. Call
`notifications/initialized` after `initialize`.

**stdio (single-agent, harnesses that only support stdio):**
`command: npx`, `args: ["@nbiish/betterbrowsermcp@latest"]`, env
`BROWSER_MCP_AGENT_ID=<id>`, `BROWSER_MCP_PORT=9109`.

## 8. Troubleshooting

- `noConnectedExtension` — the extension auto-attaches within ~30s of your
  `initialize`. Still red after a minute? Have the user reload the
  extension (chrome://extensions → reload icon). Manual fallback:
  extension icon → Add agent → your id + the port from connect output.
- Port already in use → the hub hard-fails with a clear message. Choose
  another port; do NOT kill the existing process.
- WS closes with `4401` → auth token mismatch (server has
  `BROWSER_MCP_AUTH_TOKEN` set; extension entry needs the same token).
- HTTP `406` → missing/wrong `Accept` header.
- `TAB_LOCKED` / `TAB_BUSY` → another agent holds the advisory lock. Wait
  and retry once; escalate to the user instead of fighting.
- Tool call does nothing on a stale tab → re-`wait_for_content` after SPA
  navigation; check `browser_poll_events` for `navigation` events.
