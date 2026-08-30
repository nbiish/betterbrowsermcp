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
 *   - browser_bind_tab        adopt an existing tab (v0.9.0+)
 *   - browser_unbind_tab      release a tab without closing (v0.9.0+)
 *   - browser_acquire_tab     advisory per-tab lock (v0.9.0+)
 *   - browser_release_tab     release the advisory lock (v0.9.0+)
 *   - browser_wait_for_content  wait for content-script readiness (v0.9.0+)
 *   - browser_poll_events     drain buffered tab events (v0.9.0+)
 */

import { zodToJsonSchema } from "zod-to-json-schema";

import { formatEventOneLiners } from "@/events";
import {
  AcquireTabTool,
  BindTabTool,
  CloseTabTool,
  ListTabsTool,
  OpenTabTool,
  PollEventsTool,
  ReleaseTabTool,
  RenameTabTool,
  SetActiveTabTool,
  UnbindTabTool,
  WaitForContentTool,
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
      const windowField =
        t.windowId !== undefined ? `\n    windowId: ${t.windowId}` : "";
      const activeInWindow =
        t.activeInWindow !== undefined
          ? `\n    activeInWindow: ${t.activeInWindow}`
          : "";
      return `  - tabId=${t.tabId}\n    label: ${t.label}\n    url:   ${t.url}\n    title: ${t.title}${windowField}${activeInWindow}${marker}`;
    });
    const activeMarker = result.activeTabId
      ? `\nActive tab: tabId=${result.activeTabId} (use browser_set_active_tab to switch)`
      : "\nNo active tab set. Tool calls without tabId will fail until you call browser_set_active_tab.";
    // v0.9.0+: append buffered extension events so agents notice tab
    // changes without explicit polling (drains the buffer).
    const events = context.drainEvents();
    const eventLines = formatEventOneLiners(events);
    const eventsBlock = eventLines.length
      ? `\n\nRecent tab events (${eventLines.length} drained):\n${eventLines.join("\n")}`
      : "";
    return {
      content: [
        {
          type: "text",
          text: `Bound tabs (${tabs.length}):${activeMarker}\n\n${lines.join("\n\n")}${eventsBlock}`,
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
    const { url, label, makeActive } =
      OpenTabTool.shape.arguments.parse(params);
    const result = (await context.sendSocketMessage("browser_open_tab", {
      url,
      label,
      makeActive,
    })) as any;
    const focusNote = makeActive
      ? "The tab is now the agent's active tab. Subsequent tool calls " +
        "without a tabId will route here."
      : "The tab was opened in the BACKGROUND (makeActive=false, the " +
        "default) — browser focus and the agent's active tab are " +
        "unchanged. Use explicit tabId=" +
        `${result?.tabId ?? "<this tab's id>"} on subsequent calls, or ` +
        "browser_set_active_tab to switch focus.";
    return {
      content: [
        {
          type: "text",
          text:
            `Opened new tab (tabId=${result?.tabId})${
              result?.label ? ` labeled "${result.label}"` : ""
            }${result?.url ? `, navigated to ${result.url}` : ""}.\n\n` +
            `${focusNote} ` +
            "Use browser_rename_tab to set a custom label, " +
            "browser_wait_for_content to wait until it is ready, or " +
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

// ============================================================
//  Tab adoption, advisory locks & readiness (v0.9.0+)
// ============================================================

export const bindTab: Tool = {
  schema: {
    name: BindTabTool.shape.name.value,
    description: BindTabTool.shape.description.value,
    inputSchema: zodToJsonSchema(BindTabTool.shape.arguments),
  },
  handle: async (context, params) => {
    const { tabId } = BindTabTool.shape.arguments.parse(params);
    const result = (await context.sendSocketMessage("browser_bind_tab", {
      tabId,
    })) as any;
    if (!result?.ok) {
      return {
        content: [
          { type: "text", text: `Bind failed: ${result?.error || "unknown"}` },
        ],
        isError: true,
      };
    }
    return {
      content: [
        {
          type: "text",
          text:
            `Bound tab ${result?.tabId ?? tabId}${
              result?.label ? ` ("${result.label}")` : ""
            } to this agent. The tab was adopted without opening or ` +
            "focusing it. Drive it with explicit tabId on every call; " +
            "acquire an advisory lock first (browser_acquire_tab) if other " +
            "agents may also target it.",
        },
      ],
    };
  },
};

export const unbindTab: Tool = {
  schema: {
    name: UnbindTabTool.shape.name.value,
    description: UnbindTabTool.shape.description.value,
    inputSchema: zodToJsonSchema(UnbindTabTool.shape.arguments),
  },
  handle: async (context, params) => {
    const { tabId } = UnbindTabTool.shape.arguments.parse(params);
    const result = (await context.sendSocketMessage("browser_unbind_tab", {
      tabId,
    })) as any;
    if (!result?.ok) {
      return {
        content: [
          {
            type: "text",
            text: `Unbind failed: ${result?.error || "unknown"}`,
          },
        ],
        isError: true,
      };
    }
    return {
      content: [
        {
          type: "text",
          text: `Unbound tab ${tabId}. The tab stays open in the browser; this agent no longer routes calls to it.`,
        },
      ],
    };
  },
};

export const acquireTab: Tool = {
  schema: {
    name: AcquireTabTool.shape.name.value,
    description: AcquireTabTool.shape.description.value,
    inputSchema: zodToJsonSchema(AcquireTabTool.shape.arguments),
  },
  handle: async (context, params) => {
    const { tabId, ttlMs } = AcquireTabTool.shape.arguments.parse(params);
    const result = (await context.sendSocketMessage("browser_acquire_tab", {
      tabId,
      ttlMs,
    })) as any;
    if (!result?.ok) {
      const holder = result?.holder ? ` (held by ${result.holder})` : "";
      return {
        content: [
          {
            type: "text",
            text:
              `Tab ${tabId} is BUSY${holder}. Another agent holds the ` +
              `advisory lock${result?.error === "BUSY" ? "" : ` (${result?.error || "unknown"})`}. ` +
              "Wait for the lock to expire and retry, or coordinate " +
              "through the user.",
          },
        ],
        isError: true,
      };
    }
    return {
      content: [
        {
          type: "text",
          text:
            `Acquired advisory lock on tab ${tabId} (lockId=${result?.lockId ?? "?"}, ttl=${ttlMs}ms). ` +
            "Release it with browser_release_tab when done. The lock is " +
            "advisory: held in extension memory, auto-expires after the TTL.",
        },
      ],
    };
  },
};

export const releaseTab: Tool = {
  schema: {
    name: ReleaseTabTool.shape.name.value,
    description: ReleaseTabTool.shape.description.value,
    inputSchema: zodToJsonSchema(ReleaseTabTool.shape.arguments),
  },
  handle: async (context, params) => {
    const { tabId, lockId } = ReleaseTabTool.shape.arguments.parse(params);
    const result = (await context.sendSocketMessage("browser_release_tab", {
      tabId,
      lockId,
    })) as any;
    if (!result?.ok) {
      return {
        content: [
          {
            type: "text",
            text: `Release failed: ${result?.error || "unknown"}`,
          },
        ],
        isError: true,
      };
    }
    return {
      content: [
        {
          type: "text",
          text: `Released advisory lock on tab ${tabId}.`,
        },
      ],
    };
  },
};

export const waitForContent: Tool = {
  schema: {
    name: WaitForContentTool.shape.name.value,
    description: WaitForContentTool.shape.description.value,
    inputSchema: zodToJsonSchema(WaitForContentTool.shape.arguments),
  },
  handle: async (context, params) => {
    const { tabId, timeoutS } = WaitForContentTool.shape.arguments.parse(params);
    const result = (await context.sendSocketMessage(
      "browser_wait_for_content",
      { tabId, timeoutS },
      { timeoutMs: (timeoutS + 5) * 1000 },
    )) as any;
    if (!result?.ok) {
      return {
        content: [
          {
            type: "text",
            text:
              `Timed out after ${timeoutS}s waiting for content-script readiness` +
              `${tabId ? ` on tab ${tabId}` : ""}. The page may still be ` +
              "loading, the content script may not be injected (try a page " +
              "reload), or the tab may be closed (check browser_list_tabs).",
          },
        ],
        isError: true,
      };
    }
    return {
      content: [
        {
          type: "text",
          text:
            `Content script ready${result?.url ? ` at ${result.url}` : ""}` +
            `${result?.title ? ` ("${result.title}")` : ""}` +
            `${result?.tabId ? ` on tab ${result.tabId}` : ""}. Safe to ` +
            "snapshot/click now.",
        },
      ],
    };
  },
};

export const pollEvents: Tool = {
  schema: {
    name: PollEventsTool.shape.name.value,
    description: PollEventsTool.shape.description.value,
    inputSchema: zodToJsonSchema(PollEventsTool.shape.arguments),
  },
  handle: async (context) => {
    const events = context.drainEvents();
    if (events.length === 0) {
      return {
        content: [
          {
            type: "text",
            text:
              "No buffered tab events. Events accumulate while you work " +
              "(tab_removed, tab_updated, binding_changed) and are also " +
              "appended to browser_list_tabs / browser_snapshot output.",
          },
        ],
      };
    }
    const lines = formatEventOneLiners(events);
    return {
      content: [
        {
          type: "text",
          text:
            `Drained ${lines.length} buffered tab event(s) (buffer cleared):\n` +
            lines.join("\n"),
        },
      ],
    };
  },
};
