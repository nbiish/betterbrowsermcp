#!/usr/bin/env node
/**
 * @betterbrowsermcp/mcp — entry point
 *
 * Single-agent MCP process. Spawn one process per agent you want to
 * support. Each process binds its own port and serves its own
 * WebSocket endpoint. The browser extension connects to all known
 * endpoints and lets the user bind each tab to a specific agent.
 *
 * Environment variables (see config.ts for full reference):
 *   BROWSER_MCP_AGENT_ID   default: "default"
 *   BROWSER_MCP_PORT       default: 9009
 *   BROWSER_MCP_BIND       default: 127.0.0.1
 *   BROWSER_MCP_AUTH_TOKEN optional
 *
 * Example multi-agent setup:
 *   # Hermes
 *   BROWSER_MCP_AGENT_ID=hermes BROWSER_MCP_PORT=9009 \
 *     npx @betterbrowsermcp/mcp@latest &
 *   # OMP
 *   BROWSER_MCP_AGENT_ID=omp BROWSER_MCP_PORT=9010 \
 *     npx @betterbrowsermcp/mcp@latest &
 *   # Codex
 *   BROWSER_MCP_AGENT_ID=codex BROWSER_MCP_PORT=9011 \
 *     npx @betterbrowsermcp/mcp@latest &
 *
 * Then point the browser extension at all three endpoints:
 *   ws://127.0.0.1:9009/ws/hermes
 *   ws://127.0.0.1:9010/ws/omp
 *   ws://127.0.0.1:9011/ws/codex
 */

import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { program } from "commander";

import { appConfig, mcpConfig, wsUrlForAgent } from "@/config";
import type { Resource } from "@/resources/resource";
import { createServerWithTools } from "@/server";
import * as common from "@/tools/common";
import * as custom from "@/tools/custom";
import * as manage from "@/tools/manage";
import * as snapshot from "@/tools/snapshot";
import type { Tool } from "@/tools/tool";
import { createWebSocketServer } from "@/ws";

import packageJSON from "../package.json";

function setupExitWatchdog(server: Server): void {
  process.stdin.on("close", async () => {
    setTimeout(() => process.exit(0), 15000);
    await server.close();
    process.exit(0);
  });
}

const commonTools: Tool[] = [common.pressKey, common.wait];

const customTools: Tool[] = [custom.getConsoleLogs, custom.screenshot];

// Multi-tab management tools — always registered, regardless of whether
// the user has bound any tabs yet. The LLM uses these to discover the
// available tabs, set the active one, and label them.
const manageTools: Tool[] = [
  manage.listTabs,
  manage.openTab,
  manage.closeTab,
  manage.renameTab,
  manage.setActiveTab,
];

const snapshotTools: Tool[] = [
  common.navigate(true),
  common.goBack(true),
  common.goForward(true),
  snapshot.snapshot,
  snapshot.click,
  snapshot.hover,
  snapshot.type,
  snapshot.selectOption,
  ...commonTools,
  ...customTools,
  ...manageTools,
];

const resources: Resource[] = [];

async function createServer(): Promise<Server> {
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

  return createServerWithTools({
    name: appConfig.name,
    version: packageJSON.version,
    tools: snapshotTools,
    resources,
    context,
  });
}

program
  .version("Version " + packageJSON.version)
  .name(packageJSON.name)
  .description(appConfig.description)
  .action(async () => {
    const server = await createServer();
    setupExitWatchdog(server);

    const transport = new StdioServerTransport();
    await server.connect(transport);
  });
program.parse(process.argv);
