/**
 * @betterbrowsermcp/mcp — MCP server (single agent per process)
 *
 * Creates an MCP server instance bound to a single Context
 * (one WebSocket = one browser tab). Tools are exposed under
 * their standard names (browser_navigate, browser_click, ...)
 * — identical to @browsermcp/mcp@0.1.3.
 *
 * Multiple MCP processes (one per agent) on different ports give
 * the multi-agent capability. The browser extension binds tabs to
 * specific agents via the WebSocket path (/ws/<agentId>).
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import { appConfig } from "@/config";
import type { Context } from "@/context";
import type { Resource } from "@/resources/resource";
import type { Tool } from "@/tools/tool";

type Options = {
  name: string;
  version: string;
  tools: Tool[];
  resources: Resource[];
  context: Context;
};

export async function createServerWithTools(
  options: Options,
): Promise<Server> {
  const { name, version, tools, resources, context } = options;

  const server = new Server(
    { name, version },
    {
      capabilities: {
        tools: {},
        resources: {},
      },
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return { tools: tools.map((tool) => tool.schema) };
  });

  server.setRequestHandler(ListResourcesRequestSchema, async () => {
    return { resources: resources.map((resource) => resource.schema) };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const tool = tools.find((tool) => tool.schema.name === request.params.name);
    if (!tool) {
      return {
        content: [
          {
            type: "text",
            text: `Tool "${request.params.name}" not found. This MCP process is single-agent; check that you're calling the right MCP server.`,
          },
        ],
        isError: true,
      };
    }

    try {
      const result = await tool.handle(context, request.params.arguments);
      return result;
    } catch (error) {
      return {
        content: [{ type: "text", text: String(error) }],
        isError: true,
      };
    }
  });

  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    const resource = resources.find(
      (resource) => resource.schema.uri === request.params.uri,
    );
    if (!resource) {
      return { contents: [] };
    }
    const contents = await resource.read(context, request.params.uri);
    return { contents };
  });

  // The patched `server.close` chains: original close -> context close.
  // The original (inherited) close shuts down the MCP transport. We
  // capture the parent implementation explicitly to avoid the
  // recursion bug present in @browsermcp/mcp@0.1.3.
  const originalClose = server.close.bind(server);
  server.close = async () => {
    await originalClose();
    await context.close();
  };

  void appConfig;

  return server;
}
