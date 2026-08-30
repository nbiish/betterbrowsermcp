/**
 * @betterbrowsermcp/mcp — WebSocket + HTTP server
 *
 * Single-agent mode (default, unchanged since v0.2.0):
 *   One process binds one port and serves one WebSocket endpoint at
 *   `/ws/<agentId>` where agentId is the configured BROWSER_MCP_AGENT_ID.
 *
 * Hub mode (BROWSER_MCP_HUB=true, v0.9.0+):
 *   ONE process serves MANY agents. Any `/ws/<agentId>` path is routed
 *   to a per-agent Context that is lazily created on first connect
 *   (AgentRegistry in src/registry.ts). The auth handshake is enforced
 *   per Context exactly as in single-agent mode.
 *
 * The same HTTP server also hosts:
 *   - GET  /            health JSON (mode, agents[] with connected/boundTabs)
 *   - POST /mcp(/<id>)  MCP over Streamable HTTP (src/http.ts)
 *
 * Port collision behavior changed in v0.2.0:
 *   - Old (@browsermcp/mcp@0.1.3): silently kill whatever process owns
 *     the port (`lsof -ti:9009 | xargs kill -9`). Caused the
 *     port-9009 fighting between multiple MCP clients.
 *   - New (betterbrowsermcp@0.2.0+): hard-fail with a clear error
 *     message. Use `lsof -ti:<port> | xargs ps -p` to investigate
 *     before starting a second instance.
 *
 * Bind address defaults to localhost (loopback only). Never binds to a
 * wildcard address by default — exposing browser automation to the
 * network is a security risk; a non-loopback bind requires
 * BROWSER_MCP_AUTH_TOKEN (enforced in src/http.ts for MCP-over-HTTP).
 */

import http from "node:http";
import { WebSocketServer, type WebSocket } from "ws";

import {
  appConfig,
  defaultAgentId,
  mcpConfig,
  parseAgentFromPath,
} from "@/config";
import { Context } from "@/context";
import { isEventFrame } from "@/messaging";
import { agentRegistry, type AgentStatus } from "@/registry";
import { isPortInUse, portInUseError } from "@/utils";

import { handleMcpHttpRequest } from "./http";

export type WsServerHandle = {
  httpServer: http.Server;
  wss: WebSocketServer;
  /**
   * Single-agent mode: THE Context of this process.
   * Hub mode: the Context of the configured/default agent (still valid
   * for the stdio MCP server; other agents live in the registry).
   */
  context: Context;
  hubMode: boolean;
};

/**
 * Create and start the WebSocket (+HTTP MCP) server.
 */
export async function createWebSocketServer(): Promise<WsServerHandle> {
  const port = mcpConfig.defaultWsPort;
  const host = mcpConfig.bindAddress;
  const agentId = mcpConfig.agentId;
  const hubMode = mcpConfig.hubMode;

  // Refuse to start if the port is taken. The historical
  // `killProcessOnPort` behavior is the root cause of the port-9009
  // fighting between multiple MCP clients — see the
  // browsermcp-setup skill for the war story.
  if (await isPortInUse(port, host)) {
    throw portInUseError(port, host);
  }

  const wss = new WebSocketServer({ noServer: true });

  // The primary Context: configured agent. It ALWAYS lives in the
  // registry so /ws/<agentId>, /mcp/<agentId> and the stdio MCP server
  // all share the exact same Context instance.
  const context = hubMode
    ? agentRegistry.getOrCreate(defaultAgentId())
    : new Context(agentId);
  if (!hubMode) {
    agentRegistry.register(agentId, context);
  }

  const httpServer = http.createServer((req, res) => {
    const path = (req.url ?? "/").split("?")[0];
    if (path === "/mcp" || path.startsWith("/mcp/")) {
      // MCP over Streamable HTTP (same HTTP server, v0.9.0+).
      void handleMcpHttpRequest(req, res);
      return;
    }
    // Health endpoint for diagnostic scripts. Returns JSON describing
    // the server state, the mode, and the known agents.
    void handleHealthRequest(res, context, hubMode);
  });

  httpServer.on("upgrade", (request, socket, head) => {
    const urlAgent = parseAgentFromPath(request.url);

    if (urlAgent === null) {
      // Path doesn't match this server. Could be:
      //  - Wrong agent ID (single-agent mode)
      //  - Bare /ws when not in default-agent mode and not hub
      //  - Some other path entirely
      socket.write(
        "HTTP/1.1 404 Not Found\r\n" +
          "Content-Type: application/json\r\n\r\n" +
          JSON.stringify({
            error:
              "Path not found. This server is for agent " +
              JSON.stringify(agentId) +
              ". Did you mean to connect to a different MCP server on a different port?",
            configuredAgent: agentId,
            expectedPath: `${mcpConfig.wsPathPrefix}/${agentId}`,
            hubMode,
          }),
      );
      socket.destroy();
      return;
    }

    // Hub mode: lazily create the per-agent Context on first connect.
    // Single-agent mode: the pre-created Context (urlAgent === agentId).
    const targetCtx = hubMode ? agentRegistry.getOrCreate(urlAgent) : context;

    wss.handleUpgrade(request, socket, head, (ws) => {
      handleConnection(ws, targetCtx);
    });
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(port, host, () => {
      httpServer.off("error", reject);
      resolve();
    });
  });

  return { httpServer, wss, context, hubMode };
}

async function handleHealthRequest(
  res: http.ServerResponse,
  primaryContext: Context,
  hubMode: boolean,
): Promise<void> {
  // Collect per-agent status. boundTabs requires an extension round
  // trip; probe connected agents with a short timeout so / stays fast.
  const agentIds = hubMode ? agentRegistry.ids() : [primaryContext.agentId];
  const contexts = agentIds.map((id) =>
    hubMode ? agentRegistry.getOrCreate(id) : primaryContext,
  );

  const statuses: AgentStatus[] = await Promise.all(
    contexts.map(async (ctx, i): Promise<AgentStatus> => {
      const base: AgentStatus = {
        agentId: agentIds[i],
        connected: ctx.hasWs(),
        boundTabs: null,
      };
      if (!base.connected) return base;
      try {
        const result = (await ctx.sendSocketMessage(
          "browser_list_tabs",
          {},
          { timeoutMs: 750 },
        )) as any;
        const tabs = Array.isArray(result?.tabs) ? result.tabs : [];
        base.boundTabs = tabs.length;
      } catch {
        // Extension didn't answer in time — report connected w/o count.
      }
      return base;
    }),
  );

  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(
    JSON.stringify({
      name: hubMode
        ? `${appConfig.name} (hub)`
        : `${appConfig.name} (agent: ${mcpConfig.agentId})`,
      mode: hubMode ? "hub" : "single",
      bind: mcpConfig.bindAddress,
      port: mcpConfig.defaultWsPort,
      wsPath: hubMode
        ? `${mcpConfig.wsPathPrefix}/<agentId>`
        : `${mcpConfig.wsPathPrefix}/${mcpConfig.agentId}`,
      wsPathPrefix: hubMode ? mcpConfig.wsPathPrefix : undefined,
      mcpHttpPath: hubMode ? "/mcp/<agentId>" : "/mcp",
      authRequired: mcpConfig.authToken !== "",
      agents: statuses,
    }),
  );
}

/**
 * Handle a new WebSocket connection. Registers the WebSocket with
 * the Context, sets up the auth handshake listener, buffers
 * extension push events, and configures disconnect cleanup.
 */
function handleConnection(ws: WebSocket, ctx: Context): void {
  ctx.ws = ws;

  ws.on("message", (raw) => {
    if (!ctx.isAuthenticated()) {
      let msg: any;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        ws.close(4400, "malformed auth message");
        return;
      }
      if (ctx.validateAuth(msg)) {
        ctx.markAuthenticated();
      } else {
        ws.close(4401, mcpConfig.errors.authFailed);
      }
      return;
    }

    // Post-auth frames. Request/response correlation lives in
    // messaging.ts's per-call listeners; here we only capture
    // unsolicited push events. Unknown frame types are ignored —
    // never choke on them (frozen WS contract v0.9.0 item 8).
    let frame: any;
    try {
      frame = JSON.parse(raw.toString());
    } catch {
      return; // ignore non-JSON frames
    }
    if (isEventFrame(frame)) {
      ctx.pushEvent({
        event: frame.event,
        payload:
          frame.payload && typeof frame.payload === "object"
            ? frame.payload
            : {},
        receivedAt: new Date().toISOString(),
      });
    }
  });

  ws.on("close", () => {
    if (ctx.hasWsRef(ws)) {
      ctx.clearWs();
    }
  });
  ws.on("error", () => {
    ctx.clearWs();
  });
}
