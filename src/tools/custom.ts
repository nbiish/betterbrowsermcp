/**
 * @betterbrowsermcp/mcp — custom (non-snapshot) tools
 *
 * screenshot and getConsoleLogs — work directly on the current page
 * without needing a snapshot ref.
 *
 * v0.2.0+: tabId is forwarded to the extension; the screenshot
 * tool returns image data scoped to the targeted tab.
 */

import { zodToJsonSchema } from "zod-to-json-schema";

import { GetConsoleLogsTool, ScreenshotTool } from "@/types";

import type { Tool } from "./tool";

export const getConsoleLogs: Tool = {
  schema: {
    name: GetConsoleLogsTool.shape.name.value,
    description: GetConsoleLogsTool.shape.description.value,
    inputSchema: zodToJsonSchema(GetConsoleLogsTool.shape.arguments),
  },
  handle: async (context, params) => {
    const { tabId } = GetConsoleLogsTool.shape.arguments.parse(params);
    const consoleLogs = (await context.sendSocketMessage(
      "browser_get_console_logs",
      { tabId },
    )) as any;
    const text: string = (Array.isArray(consoleLogs) ? consoleLogs : [])
      .map((log) => JSON.stringify(log))
      .join("\n");
    return {
      content: [{ type: "text", text }],
    };
  },
};

export const screenshot: Tool = {
  schema: {
    name: ScreenshotTool.shape.name.value,
    description: ScreenshotTool.shape.description.value,
    inputSchema: zodToJsonSchema(ScreenshotTool.shape.arguments),
  },
  handle: async (context, params) => {
    const { tabId } = ScreenshotTool.shape.arguments.parse(params);
    // The extension captures the tab's visible area and returns
    // { image, mimeType, tabId, label } over WS. We surface just
    // the image as MCP ImageContent.
    const result = (await context.sendSocketMessage("browser_screenshot", {
      tabId,
    })) as any;
    return {
      content: [
        {
          type: "image",
          data: String(result?.image ?? ""),
          mimeType: result?.mimeType ?? "image/png",
        },
      ],
    };
  },
};
