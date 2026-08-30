/**
 * @betterbrowsermcp/mcp — MCP over Streamable HTTP (v0.9.0)
 *
 * Mounted on the SAME HTTP server that hosts the WebSocket upgrade and
 * the / health endpoint:
 *
 *   POST /mcp            → the default agent (hub: "default",
 *                          single: BROWSER_MCP_AGENT_ID)
 *   POST /mcp/<agentId>  → that agent; in hub mode the path segment is
 *                          the agent identity for the HTTP session and
 *                          tool calls dispatch against that agent's
 *                          Context from the AgentRegistry
 *
 * Stateless mode (sessionIdGenerator: undefined): every POST is an
 * independent JSON-RPC exchange — no server-side MCP session state.
 * This matches the process model (the durable state is the per-agent
 * WebSocket Context, not the MCP session).
 *
 * Security: when the bind address is NOT loopback, a valid
 * BROWSER_MCP_AUTH_TOKEN is REQUIRED (Authorization: Bearer <token>,
 * constant-time compare). With a non-loopback bind and no token
 * configured, every request fails closed with 401 — there is no
 * unauthenticated network exposure path.
 */

import { createHash, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

import {
  appConfig,
  defaultAgentId,
  isLoopbackHost,
  mcpConfig,
} from "@/config";
import { agentRegistry } from "@/registry";
import { registerToolHandlers } from "@/server";
import { allTools } from "@/toolset";

import packageJSON from "../package.json";

const MAX_BODY_BYTES = 8 * 1024 * 1024;

function json(res: ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(payload));
}

/** Constant-time token comparison (hash both sides to equal length). */
function tokenMatches(provided: string, expected: string): boolean {
  const a = createHash("sha256").update(provided).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("payload too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

/**
 * Handle one HTTP request aimed at the MCP Streamable HTTP endpoint.
 * Registered as a request listener by src/ws.ts for /mcp* paths.
 */
export async function handleMcpHttpRequest(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const path = (req.url ?? "/").split("?")[0];

  // --- Resolve the agent from the path -----------------------------
  let agentId: string;
  if (path === "/mcp" || path === "/mcp/") {
    agentId = defaultAgentId();
  } else if (path.startsWith("/mcp/")) {
    agentId = path.slice("/mcp/".length).split("/")[0];
    if (!agentId) {
      json(res, 404, { error: "Missing agent ID in /mcp/<agentId> path." });
      return;
    }
  } else {
    json(res, 404, { error: "Not found." });
    return;
  }

  // --- Auth: required on non-loopback binds (fail closed) ----------
  if (!isLoopbackHost(mcpConfig.bindAddress)) {
    const header = req.headers.authorization ?? "";
    const provided = header.startsWith("Bearer ")
      ? header.slice("Bearer ".length).trim()
      : "";
    const ok =
      mcpConfig.authToken !== "" &&
      provided !== "" &&
      tokenMatches(provided, mcpConfig.authToken);
    if (!ok) {
      json(res, 401, {
        error:
          "Unauthorized. Non-loopback binds require a valid " +
          "BROWSER_MCP_AUTH_TOKEN (Authorization: Bearer <token>).",
      });
      return;
    }
  }

  // --- Stateless Streamable HTTP: POST only ------------------------
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    json(res, 405, {
      error:
        "Method not allowed. This endpoint is stateless — use POST with a JSON-RPC message.",
    });
    return;
  }

  let body: Buffer;
  try {
    body = await readBody(req);
  } catch (e: any) {
    json(res, e?.message === "payload too large" ? 413 : 400, {
      error: `Failed to read request body: ${e?.message || String(e)}`,
    });
    return;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString("utf8"));
  } catch {
    json(res, 400, { error: "Invalid JSON body." });
    return;
  }

  // --- Resolve the agent's Context from the registry ----------------
  const context = mcpConfig.hubMode
    ? agentRegistry.getOrCreate(agentId)
    : agentRegistry.get(agentId);
  if (!context) {
    json(res, 404, {
      error:
        `Unknown agent ${JSON.stringify(agentId)}. This single-agent ` +
        `process serves ${JSON.stringify(mcpConfig.agentId)} — set ` +
        "BROWSER_MCP_HUB=true to serve multiple agents on one port.",
    });
    return;
  }

  // --- Fresh stateless transport + MCP server per request -----------
  // registerToolHandlers does NOT patch server.close to close the
  // Context, so tearing down the per-request server leaves the
  // agent's WebSocket untouched.
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  const server = registerToolHandlers({
    name: appConfig.name,
    version: packageJSON.version,
    tools: allTools,
    resources: [],
    context,
  });

  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, parsed);
  } catch (e: any) {
    if (!res.headersSent) {
      json(res, 400, {
        error: `MCP request failed: ${e?.message || String(e)}`,
      });
    } else {
      try {
        res.end();
      } catch {
        // ignore
      }
    }
  } finally {
    try {
      await server.close();
    } catch {
      // ignore
    }
  }
}
