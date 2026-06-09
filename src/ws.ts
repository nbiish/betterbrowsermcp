/**
 * @betterbrowsermcp/mcp — WebSocket server (one endpoint per process)
 *
 * Each MCP process binds one port and serves one WebSocket endpoint
 * at `/ws/<agentId>` where agentId is the configured BROWSER_MCP_AGENT_ID.
 *
 * The browser extension connects to this URL. The user can bind a
 * specific tab to this agent via the extension's UI. Multiple MCP
 * processes (different agents, different ports) coexist peacefully —
 * each is independent.
 *
 * Port collision behavior changed in v0.2.0:
 *   - Old (@browsermcp/mcp@0.1.3): silently kill whatever process owns
 *     the port (`lsof -ti:9009 | xargs kill -9`). Caused the
 *     port-9009 fighting between multiple MCP clients.
 *   - New (betterbrowsermcp@0.2.0+): hard-fail with a clear error
 *     message. Use `lsof -ti:<port> | xargs ps -p` to investigate
 *     before starting a second instance.
 *
 * Bind address defaults to 127.0.0.1 (localhost only). Never binds to
 * 0.0.0.0 — exposing browser automation to the network is a security
 * risk and there's no use case for it.
 */

import http from "node:http";
import { WebSocketServer, type WebSocket } from "ws";

import { appConfig, mcpConfig, parseAgentFromPath } from "@/config";
import { Context } from "@/context";
import { isPortInUse, portInUseError } from "@/utils";

/**
 * Create and start the WebSocket server for a single-agent MCP process.
 * Returns the HTTP server (needed to close on shutdown) and the single
 * Context that the tool handlers use to talk to the browser tab.
 */
export async function createWebSocketServer(): Promise<{
  httpServer: http.Server;
  wss: WebSocketServer;
  context: Context;
}> {
  const port = mcpConfig.defaultWsPort;
  const host = mcpConfig.bindAddress;
  const agentId = mcpConfig.agentId;

  // Refuse to start if the port is taken. The historical
  // `killProcessOnPort` behavior is the root cause of the port-9009
  // fighting between multiple MCP clients — see the
  // browsermcp-setup skill for the war story.
  if (await isPortInUse(port, host)) {
    throw portInUseError(port, host);
  }

  const httpServer = http.createServer((_req, res) => {
    // Health endpoint for diagnostic scripts. Returns JSON describing
    // the server state and the configured agent mode.
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        name: `${appConfig.name} (agent: ${agentId})`,
        bind: host,
        port,
        wsPath: `${mcpConfig.wsPathPrefix}/${agentId}`,
        authRequired: mcpConfig.authToken !== "",
      }),
    );
  });

  const wss = new WebSocketServer({ noServer: true });
  const context = new Context(agentId);

  httpServer.on("upgrade", (request, socket, head) => {
    const urlAgent = parseAgentFromPath(request.url);

    if (urlAgent === null) {
      // Path doesn't match this server's agent. Could be:
      //  - Wrong agent ID
      //  - Bare /ws when not in default-agent mode
      //  - Some other path entirely
      socket.write(
        "HTTP/1.1 404 Not Found\r\n" +
          "Content-Type: application/json\r\n\r\n" +
          JSON.stringify({
            error: "Path not found. This server is for agent " + JSON.stringify(agentId) + ". Did you mean to connect to a different MCP server on a different port?",
            configuredAgent: agentId,
            expectedPath: `${mcpConfig.wsPathPrefix}/${agentId}`,
          }),
      );
      socket.destroy();
      return;
    }

    wss.handleUpgrade(request, socket, head, (ws) => {
      handleConnection(ws, context);
    });
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(port, host, () => {
      httpServer.off("error", reject);
      resolve();
    });
  });

  return { httpServer, wss, context };
}

/**
 * Handle a new WebSocket connection. Registers the WebSocket with
 * the Context, sets up the auth handshake listener, and configures
 * disconnect cleanup.
 */
function handleConnection(ws: WebSocket, ctx: Context): void {
  ctx.ws = ws;

  // If an existing WebSocket is bound to this context, close it. This
  // happens when the extension reconnects (e.g. after a tab refresh).
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
