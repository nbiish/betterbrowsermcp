#!/usr/bin/env node
/**
 * @betterbrowsermcp/mcp — entry point
 *
 * Single-agent mode (default — unchanged, byte-compatible):
 *   One stdio MCP process = one agent. The process binds its own port
 *   and serves its own WebSocket endpoint. Spawn one process per agent.
 *
 * Hub mode (BROWSER_MCP_HUB=true, v0.9.0+):
 *   ONE long-lived process serves MANY agents:
 *     - any ws://host:port/ws/<agentId> is accepted (per-agent Context
 *       lazily created on first connect via the AgentRegistry)
 *     - MCP is additionally exposed over Streamable HTTP at
 *       /mcp and /mcp/<agentId> on the same HTTP server
 *     - GET / returns hub health JSON (mode + agents[])
 *   stdio is disabled in hub mode (there is no single agent to bind it
 *   to); the process stays alive on the HTTP server until SIGINT/SIGTERM.
 *
 * Environment variables (see config.ts for full reference):
 *   BROWSER_MCP_AGENT_ID   default: "default"
 *   BROWSER_MCP_PORT       default: 9009
 *   BROWSER_MCP_BIND       default: localhost
 *   BROWSER_MCP_AUTH_TOKEN optional (REQUIRED for non-loopback /mcp)
 *   BROWSER_MCP_HUB        default: false
 *
 * Example multi-agent setup (classic, one process per agent):
 *   # Hermes
 *   BROWSER_MCP_AGENT_ID=hermes BROWSER_MCP_PORT=9009 \
 *     npx @betterbrowsermcp/mcp@latest &
 *   # OMP
 *   BROWSER_MCP_AGENT_ID=omp BROWSER_MCP_PORT=9010 \
 *     npx @betterbrowsermcp/mcp@latest &
 *
 * Example hub setup (one process, many agents):
 *   BROWSER_MCP_HUB=true BROWSER_MCP_PORT=9009 node dist/index.js
 *   # extension connects to ws://localhost:9009/ws/hermes etc.
 *   # MCP clients POST JSON-RPC to http://localhost:9009/mcp/hermes
 */

import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { program } from "commander";

import { appConfig, mcpConfig, wsUrlForAgent } from "@/config";
import type { Resource } from "@/resources/resource";
import { createServerWithTools } from "@/server";
import { allTools } from "@/toolset";
import { createWebSocketServer } from "@/ws";

import packageJSON from "../package.json";

const resources: Resource[] = [];

function setupExitWatchdog(server: Server): void {
  process.stdin.on("close", async () => {
    setTimeout(() => process.exit(0), 15000);
    await server.close();
    process.exit(0);
  });
}

async function runHubMode(): Promise<void> {
  const { httpServer, extraHttpServers, boundAddresses } = await createWebSocketServer();

  process.stderr.write(
    `[betterbrowsermcp] ${appConfig.name} v${packageJSON.version}\n` +
      `[betterbrowsermcp] Mode: HUB (one process, many agents)\n` +
      `[betterbrowsermcp] WebSocket: ws://${mcpConfig.bindAddress}:${mcpConfig.defaultWsPort}${mcpConfig.wsPathPrefix}/<agentId>\n` +
      `[betterbrowsermcp] MCP over HTTP: http://${mcpConfig.bindAddress}:${mcpConfig.defaultWsPort}/mcp/<agentId>\n` +
      `[betterbrowsermcp] Health: http://${mcpConfig.bindAddress}:${mcpConfig.defaultWsPort}/\n` +
      `[betterbrowsermcp] Auth required: ${mcpConfig.authToken !== ""}\n` +
      `[betterbrowsermcp] Port-murder disabled (hard-fail on collision)\n`,
  );

  const shutdown = () => {
    for (const extra of extraHttpServers) extra.close();
    httpServer.close(() => process.exit(0));
    // Force-exit if connections linger.
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

async function runSingleAgentMode(): Promise<void> {
  // Start the WebSocket server first. If the port is already taken,
  // this throws a hard error and the process exits — that's the
  // intended behavior. Two MCP processes should use different ports
  // (configure via BROWSER_MCP_PORT).
  const { context } = await createWebSocketServer();

  // Banner on stderr (stdout is reserved for the MCP stdio transport —
  // mixing logs into it corrupts the protocol).
  process.stderr.write(
    `[betterbrowsermcp] ${appConfig.name} v${packageJSON.version}\n` +
      `[betterbrowsermcp] Agent: ${mcpConfig.agentId}\n` +
      `[betterbrowsermcp] WebSocket: ${wsUrlForAgent()}\n` +
      `[betterbrowsermcp] Auth required: ${mcpConfig.authToken !== ""}\n` +
      `[betterbrowsermcp] Port-murder disabled (hard-fail on collision)\n`,
  );

  const server = await createServerWithTools({
    name: appConfig.name,
    version: packageJSON.version,
    tools: allTools,
    resources,
    context,
  });
  setupExitWatchdog(server);

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

program
  .version("Version " + packageJSON.version)
  .name(packageJSON.name)
  .description(appConfig.description)
  .action(async () => {
    if (mcpConfig.hubMode) {
      await runHubMode();
      return;
    }
    await runSingleAgentMode();
  });
program.parse(process.argv);
