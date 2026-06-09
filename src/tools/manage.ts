/**
 * @betterbrowsermcp/mcp — multi-tab management tools
 *
 * Tools that let the LLM (and the user via the extension popup)
 * manage which tabs are bound to the agent, what they're labeled,
 * and which one is the "active" tab for unspecific tool calls.
 *
 * The actual tab state lives in the browser extension
 * (chrome.storage.local). These tools just forward the request
 * over the WebSocket and return whatever the extension says.
 *
 * Tool list:
 *   - browser_list_tabs       list bound tabs (with labels)
 *   - browser_open_tab        open a new tab and bind it
 *   - browser_close_tab       close a bound tab
 *   - browser_rename_tab      set a label
 *   - browser_set_active_tab  which tab is "active"
 */

import { zodToJsonSchema } from "zod-to-json-schema";

import {
  CloseTabTool,
  ListTabsTool,
  OpenTabTool,
  RenameTabTool,
  SetActiveTabTool,
} from "@/types";

import type { Tool } from "./tool";

export const listTabs: Tool = {
  schema: {
    name: ListTabsTool.shape.name.value,
    description: ListTabsTool.shape.description.value,
    inputSchema: zodToJsonSchema(ListTabsTool.shape.arguments),
  },
  handle: async (context) => {
    const result = (await context.sendSocketMessage(
      "browser_list_tabs",
      {},
    )) as any;
    const tabs = Array.isArray(result?.tabs) ? result.tabs : [];
    if (tabs.length === 0) {
      return {
        content: [
          {
            type: "text",
            text:
              "No browser tabs are bound to this agent. Use browser_open_tab " +
              "to open one, or ask the user to open a tab and bind it via the " +
              "Better Browser MCP extension popup.",
          },
        ],
      };
    }
    const lines = tabs.map((t: any) => {
      const marker = t.isActive ? " ← ACTIVE" : "";
      return `  - tabId=${t.tabId}\n    label: ${t.label}\n    url:   ${t.url}\n    title: ${t.title}${marker}`;
    });
    const activeMarker = result.activeTabId
      ? `\nActive tab: tabId=${result.activeTabId} (use browser_set_active_tab to switch)`
      : "\nNo active tab set. Tool calls without tabId will fail until you call browser_set_active_tab.";
    return {
      content: [
        {
          type: "text",
          text: `Bound tabs (${tabs.length}):${activeMarker}\n\n${lines.join("\n\n")}`,
        },
      ],
    };
  },
};

export const openTab: Tool = {
  schema: {
    name: OpenTabTool.shape.name.value,
    description: OpenTabTool.shape.description.value,
    inputSchema: zodToJsonSchema(OpenTabTool.shape.arguments),
  },
  handle: async (context, params) => {
    const { url, label } = OpenTabTool.shape.arguments.parse(params);
    const result = (await context.sendSocketMessage("browser_open_tab", {
      url,
      label,
    })) as any;
    return {
      content: [
        {
          type: "text",
          text:
            `Opened new tab (tabId=${result?.tabId})${
              result?.label ? ` labeled "${result.label}"` : ""
            }${result?.url ? `, navigated to ${result.url}` : ""}.\n\n` +
            "The tab is now the agent's active tab. Subsequent tool calls " +
            "without a tabId will route here. " +
            "Use browser_rename_tab to set a custom label, or " +
            "browser_list_tabs to see all bound tabs.",
        },
      ],
    };
  },
};

export const closeTab: Tool = {
  schema: {
    name: CloseTabTool.shape.name.value,
    description: CloseTabTool.shape.description.value,
    inputSchema: zodToJsonSchema(CloseTabTool.shape.arguments),
  },
  handle: async (context, params) => {
    const { tabId } = CloseTabTool.shape.arguments.parse(params);
    const result = (await context.sendSocketMessage("browser_close_tab", {
      tabId,
    })) as any;
    if (!result?.ok) {
      return {
        content: [{ type: "text", text: `Close failed: ${result?.error || "unknown"}` }],
        isError: true,
      };
    }
    return {
      content: [
        {
          type: "text",
          text: `Closed tab ${tabId}. The binding has been removed automatically.`,
        },
      ],
    };
  },
};

export const renameTab: Tool = {
  schema: {
    name: RenameTabTool.shape.name.value,
    description: RenameTabTool.shape.description.value,
    inputSchema: zodToJsonSchema(RenameTabTool.shape.arguments),
  },
  handle: async (context, params) => {
    const { tabId, label } = RenameTabTool.shape.arguments.parse(params);
    const result = (await context.sendSocketMessage("browser_rename_tab", {
      tabId,
      label,
    })) as any;
    if (!result?.ok) {
      return {
        content: [{ type: "text", text: `Rename failed: ${result?.error || "unknown"}` }],
        isError: true,
      };
    }
    return {
      content: [
        {
          type: "text",
          text: `Renamed tab ${tabId} to "${label}". Future tool calls and snapshot output will use this label.`,
        },
      ],
    };
  },
};

export const setActiveTab: Tool = {
  schema: {
    name: SetActiveTabTool.shape.name.value,
    description: SetActiveTabTool.shape.description.value,
    inputSchema: zodToJsonSchema(SetActiveTabTool.shape.arguments),
  },
  handle: async (context, params) => {
    const { tabId } = SetActiveTabTool.shape.arguments.parse(params);
    const result = (await context.sendSocketMessage("browser_set_active_tab", {
      tabId,
    })) as any;
    if (!result?.ok) {
      return {
        content: [{ type: "text", text: `Set active failed: ${result?.error || "unknown"}` }],
        isError: true,
      };
    }
    return {
      content: [
        {
          type: "text",
          text: `Set tab ${tabId}${result?.label ? ` ("${result.label}")` : ""} as the active tab. Tool calls that omit tabId will now route here.`,
        },
      ],
    };
  },
};
