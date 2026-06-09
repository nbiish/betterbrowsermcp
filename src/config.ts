/**
 * @betterbrowsermcp/mcp — runtime configuration
 *
 * Each MCP process represents a SINGLE agent. The agent's identity
 * is configured via env vars:
 *
 *   BROWSER_MCP_AGENT_ID   Agent identifier (default: "default").
 *                          Used in the WebSocket path so the
 *                          extension can route tab bindings to the
 *                          right agent.
 *   BROWSER_MCP_PORT       WebSocket port (default 9009)
 *   BROWSER_MCP_BIND       Bind address (default 127.0.0.1)
 *   BROWSER_MCP_AUTH_TOKEN Optional shared-secret for the WebSocket
 *                          handshake
 *
 * Multiple MCP processes (one per agent) can run on the same machine,
 * each on its own port. The browser extension connects to all of them
 * and binds tabs to specific agents. See README.md for the full
 * multi-agent flow.
 *
 * v0.2.0 design:
 *   - One MCP process = one agent
 *   - One WebSocket endpoint per process at /ws/<agent-id>
 *   - Standard tool names (browser_navigate, browser_click, ...)
 *   - Port collision is a hard error (no silent murder of other
 *     processes — the source of the original @browsermcp/mcp war
 *     story in `~/.hermes/skills/browsermcp-setup`)
 *
 * Backward compat:
 *   - BROWSER_MCP_AGENT_ID unset → single "default" agent, WS at /ws/default
 *   - Tool names are identical to @browsermcp/mcp@0.1.3
 *   - The browser extension can be pointed at any WS path
 */

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = parseInt(raw, 10);
  if (Number.isNaN(n)) {
    process.stderr.write(
      `[betterbrowsermcp] ${name}=${raw} is not a number, using default ${fallback}\n`,
    );
    return fallback;
  }
  return n;
}

function envString(name: string, fallback: string): string {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  return raw;
}

function envBool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  return raw === "1" || raw.toLowerCase() === "true" || raw.toLowerCase() === "yes";
}

export const appConfig = {
  name: "Better Browser MCP",
  tagline: "Multi-agent local browser automation",
  description:
    "Better Browser MCP — drop-in upgrade of @browsermcp/mcp with " +
    "configurable ports, per-agent WebSocket paths, and hard-fail on " +
    "port collision (no more silent murder between agents). One MCP " +
    "process per agent; the browser extension binds tabs to specific " +
    "agents via the WebSocket path.",
  email: {
    defaultFrom: "nbiish@users.noreply.github.com",
  },
} as const;

export const mcpConfig = {
  /** Default WebSocket port. Override with BROWSER_MCP_PORT. */
  defaultWsPort: envInt("BROWSER_MCP_PORT", 9009),

  /** Bind address. Default 127.0.0.1 — never bind to 0.0.0.0 by default. */
  bindAddress: envString("BROWSER_MCP_BIND", "127.0.0.1"),

  /**
   * Agent identifier for THIS process. Used in the WebSocket path
   * (e.g. /ws/hermes) so the browser extension can route tab bindings
   * to the right agent. Default: "default".
   *
   * To run multiple agents on one machine, spawn one MCP process per
   * agent with a unique BROWSER_MCP_PORT and BROWSER_MCP_AGENT_ID:
   *
   *   # Hermes
   *   BROWSER_MCP_AGENT_ID=hermes BROWSER_MCP_PORT=9009 \
   *     npx @betterbrowsermcp/mcp@latest
   *
   *   # OMP
   *   BROWSER_MCP_AGENT_ID=omp BROWSER_MCP_PORT=9010 \
   *     npx @betterbrowsermcp/mcp@latest
   *
   *   # Codex
   *   BROWSER_MCP_AGENT_ID=codex BROWSER_MCP_PORT=9011 \
   *     npx @betterbrowsermcp/mcp@latest
   */
  agentId: envString("BROWSER_MCP_AGENT_ID", "default"),

  /**
   * Optional shared-secret token. If set, the extension must send
   * `{type: "auth", token: "..."}` as its first message or the
   * connection is closed with code 4401. Prevents rogue local processes
   * from controlling your browser tabs.
   */
  authToken: envString("BROWSER_MCP_AUTH_TOKEN", ""),

  /**
   * Path prefix for the WebSocket endpoint. The extension connects to
   * `ws://<bind>:<port><wsPathPrefix>/<agentId>`. Defaults to `/ws`.
   * The agent ID is appended automatically.
   */
  wsPathPrefix: envString("BROWSER_MCP_WS_PATH_PREFIX", "/ws"),

  errors: {
    noConnectedTab:
      "No tab is connected. Open a tab in your browser, click the Browser MCP extension icon, and select Connect.",
    noConnectedExtension:
      "No connection to browser extension. In order to proceed, you must first connect a tab by clicking the Better Browser MCP extension icon in the browser toolbar and clicking the 'Connect' button.",
    authFailed: "Authentication failed — invalid or missing auth token.",
  },
} as const;

/**
 * Path-based routing. Given an incoming HTTP upgrade request, returns
 * the agent ID it should be routed to, or null if the path is
 * invalid.
 *
 * Valid paths:
 *   /ws           — accepted only when the configured agentId is "default"
 *   /ws/          — same as above
 *   /ws/<id>      — must match the configured agentId
 *
 * The browser extension connects to /ws/<agentId> with the agentId
 * set via BROWSER_MCP_AGENT_ID on the server. Two MCP processes
 * running on different ports with different agent IDs are independent
 * — each has its own WS endpoint and its own MCP tool calls.
 */
export function parseAgentFromPath(url: string | undefined): string | null {
  if (!url) return null;
  const path = url.split("?")[0];
  const prefix = mcpConfig.wsPathPrefix;

  if (path === prefix || path === prefix + "/") {
    // Bare /ws — only valid when this server is the "default" agent
    if (mcpConfig.agentId === "default") {
      return "default";
    }
    return null;
  }

  if (path.startsWith(prefix + "/")) {
    const suffix = path.slice(prefix.length + 1);
    const agentId = suffix.split("/")[0];
    if (!agentId) return null;
    if (agentId !== mcpConfig.agentId) {
      // A different MCP process on a different port should handle
      // this agent ID. Reject so the client gets a clear signal.
      return null;
    }
    return agentId;
  }

  return null;
}

/**
 * Build the WebSocket URL the extension should connect to for THIS
 * process. Used by the server's startup banner and by tests.
 */
export function wsUrlForAgent(): string {
  const port = mcpConfig.defaultWsPort;
  const bind = mcpConfig.bindAddress;
  return `ws://${bind}:${port}${mcpConfig.wsPathPrefix}/${mcpConfig.agentId}`;
}
