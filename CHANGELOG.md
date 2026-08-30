# Changelog

## 0.9.0 — 2026-08-30 — hub mode + parallel tabs

### Added
- **Hub mode** (`BROWSER_MCP_HUB=true`): one process serves many agents. Any `/ws/<agentId>` is routed to a per-agent Context lazily created on first connect (`src/registry.ts` AgentRegistry). Auth handshake enforced per Context. Single-agent stdio mode is unchanged and byte-compatible
- **MCP over Streamable HTTP** (`src/http.ts`): `POST /mcp` and `POST /mcp/<agentId>` on the same HTTP server (stateless JSON-RPC via `StreamableHTTPServerTransport`). On a non-loopback `BROWSER_MCP_BIND`, requests **require** `Authorization: Bearer $BROWSER_MCP_AUTH_TOKEN` (401 otherwise, fail closed even with no token configured)
- `GET /` health JSON gains `mode: "hub"|"single"` and `agents[]` with `{agentId, connected, boundTabs}`
- `browser_bind_tab` / `browser_unbind_tab`: agent-side adoption/release of existing tabs (no open, no focus)
- `browser_acquire_tab` / `browser_release_tab`: advisory per-tab locks (TTL default 300000ms, `lockId`, `BUSY` + holder on conflict, holder bypasses)
- `browser_wait_for_content`: resolves when the content script answers a readiness ping (`timeoutS`, default 10)
- `browser_poll_events`: drains the per-agent buffered extension events (`tab_removed`, `tab_updated`, `binding_changed`); bounded ring buffer cap 200, server-side (`src/events.ts`). Buffered events are also appended (and cleared) on `browser_list_tabs` and `browser_snapshot` output
- `browser_open_tab` gains `makeActive` (default **false** — background tabs; never force-set the active tab)
- `browser_list_tabs` passes through new per-tab fields `windowId` and `activeInWindow`
- `browser_navigate` (non-snapshot) surfaces the loaded page's `title` from the extension's readiness-aware reply
- `browser_secrets_add_from_clipboard` fully implemented: extension returns the system clipboard text (`{name, tabId}` → `{ok, value}`), server merges + re-packs the bundle, audit-logs by fingerprint (was a v0.7.0 stub)
- `pqc-secrets` binary resolution order: `BROWSER_MCP_PQC_SECRETS_BIN` → `which pqc-secrets` → `~/.local/bin` → `/usr/local/bin` → legacy `~/code/ainish-coder/bin`; winner logged to stderr once (was hardcoded to the legacy path)

### Changed
- `BROWSER_MCP_BIND` default is now `localhost` (the previous committed default was a placeholder string that failed to bind at runtime)
- Tool descriptions push explicit `tabId` usage when driving multiple tabs in parallel
- Hub mode runs as a daemon (no stdio); single-agent mode unchanged

## 0.8.0 — 2026-06-10 — availability-first PQC safety rails

### Added
- `browser_secrets_get`: `mode: 'plain' | 'redact'` (plain default; redact is a length-only summary helper, not a security gate)
- `browser_secrets_add`: `dry_run: true` previews the add (added/modified/unchanged counts) without writing
- `browser_secrets_rotate`: re-encrypts the entire bundle with a fresh data key + KEM shared secret. Identity ML-KEM-768 key in the keychain stays. Auto-backs up the previous bundle to `secrets.bundle.json.bak.<UTC>` (retain 7 days)
- `src/audit.ts`: append-only audit log at `~/.config/pqc-secrets/audit.log` mode 0o600. Format: `<utc-ts>\t<actor>\t<action>\tname=...\tmode=...\ttab=...\t<detail>`. Logs the SHA3-256 fingerprint of values (first 16 hex chars), never the values themselves
- `.agents/skills/pqc-secrets` and `.agents/skills/pqc-signatures-security`: symlinks to the canonical ainish-coder skills, so the canonical source remains single

### Fixed
- `browser_secrets_add` was broken since v0.7.0 — the original handler had a dead `await pqc(["pack"])` call (execFile with no stdin → exits with "No secrets found" → throws) that prevented the spawn block from running. Removed the dead call; spawn now does the real work
- Rust `pqc-secrets` binary was rebuilt and reinstalled at `/Users/nbiish/code/ainish-coder/bin/pqc-secrets` to pick up the `PQC_KEYCHAIN_ACCOUNT` env override merged in ainish-coder. Old binary defaulted to `account=default` which no longer exists in the keychain

### Changed
- `secrets_rotate` no longer claims "audit logging is added in v0.8.0 step 2.4" — the audit log is now in place
- Documented **availability-first** design directive: no auth tokens, no redaction-by-default, no required `tabId` for non-browser-context operations. Per-tab operations (unlock/lock/copy_to_page) require tabId because it's the cache key / paste target, not a gate
- Updated `llms.txt` TL;DR + Current state + added a new "PQC secrets management" tool-reference section

### Verified
- Build: 81.30 KB ESM, tsc clean
- Registry: 33 tools register via `tools/list`
- Bundle verifier: live bundle validates, ~15 keys, 0 plaintext leaks
- Audit log: 6 events recorded end-to-end (get plain, get redact, add, unlock, lock, rotate)
- Rotate: bundle fingerprint + KEM ciphertext + data nonce all changed; all 15 keys still decrypt after rotate
- Add: bundle went from 13 to 15 keys; audit shows `value-fp=sha3:549ab3b879785c99`

## 0.7.0 — 2026-06-08 — PQC secrets MCP surface

### Added
- 9 `browser_secrets_*` tools wrapping the `pqc-secrets` Rust CLI (FIPS 203 ML-KEM-768 + AES-256-GCM):
  - status, list, get, load, add, add_from_clipboard, unlock_agent, lock_agent, copy_to_page
- `BROWSER_MCP_PQC_SECRETS_BIN` env var override (full path to the `pqc-secrets` binary, defaults to `~/code/ainish-coder/bin/pqc-secrets`)
- Multi-tab content-script handlers for `browser_secrets_load` (page-side: pushes frozen read-only `window.__bbmcpSecrets__` object + fires `bbmcp:secrets-loaded` CustomEvent)

## 0.6.0 — 2026-06-09 — React-friendly form input

### Added
- `browser_set_input_value`: set value of an input/textarea/contenteditable with full React-friendly semantics (resets React's internal valueTracker so controlled inputs accept the value)
- `browser_clear_input`: counterpart to clear stale content before setInputValue
- Both the MCP server and the extension content script updated

## 0.5.0 — 2026-06-08 — SPA-state extraction tools

### Added
- `browser_paste_text`, `browser_wait_for_text`, `browser_get_attribute`, `browser_extract_text`, `browser_evaluate`

## 0.4.0 — 2026-06-07 — clipboard support

### Added
- `browser_copy_to_clipboard` (server + extension)

## 0.3.0 — 2026-06-06 — multi-tab surface

### Added
- `browser_list_tabs`, `browser_open_tab`, `browser_close_tab`, `browser_rename_tab`, `browser_set_active_tab`
- Per-tab labels, per-agent WebSocket path binding

## 0.2.0 — 2026-06-05 — multi-agent routing

### Added
- `BROWSER_MCP_AGENT_ID` and `BROWSER_MCP_PORT` env vars; one process per agent on its own port
- Hard-fail on port collision (no `killProcessOnPort`)

## 0.1.0 — 2026-06-04 — initial drop-in upgrade of `@browsermcp/mcp@0.1.3`

### Added
- `browser_navigate`, `browser_click`, `browser_type`, `browser_hover`, `browser_select_option`, `browser_press_key`, `browser_snapshot`, `browser_screenshot`, `browser_get_console_logs`, `browser_go_back`, `browser_go_forward`, `browser_wait`, `browser_drag`
