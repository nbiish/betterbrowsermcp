/**
 * @betterbrowsermcp/mcp — common browser tools
 *
 * navigate, goBack, goForward, wait, pressKey — low-level browser
 * navigation primitives that don't depend on ARIA snapshots.
 *
 * v0.2.0+: every tool forwards the optional `tabId` to the
 * extension, which routes the call to the correct tab. The
 * extension's response may include the resolved `tabId` and
 * `label` of the tab that was actually used; we surface those
 * in the tool result text so the LLM can confirm which tab
 * got operated on.
 */

import { zodToJsonSchema } from "zod-to-json-schema";

import {
  GoBackTool,
  GoForwardTool,
  NavigateTool,
  PressKeyTool,
  WaitTool,
} from "@/types";

import { captureAriaSnapshot } from "@/utils/aria-snapshot";

import type { Tool, ToolFactory } from "./tool";

/** Stringify the {tabId, label} suffix that the extension returns,
 *  so the LLM always knows which tab the call landed on. */
function tabSuffix(meta: any): string {
  if (!meta) return "";
  if (meta.label && meta.tabId !== undefined) {
    return ` (tab: ${meta.label} [${meta.tabId}])`;
  }
  if (meta.tabId !== undefined) return ` (tab ${meta.tabId})`;
  if (meta.label) return ` (tab: ${meta.label})`;
  return "";
}

export const navigate: ToolFactory = (snapshot) => ({
  schema: {
    name: NavigateTool.shape.name.value,
    description: NavigateTool.shape.description.value,
    inputSchema: zodToJsonSchema(NavigateTool.shape.arguments),
  },
  handle: async (context, params) => {
    const { url, tabId } = NavigateTool.shape.arguments.parse(params);
    const result = (await context.sendSocketMessage("browser_navigate", {
      url,
      tabId,
    })) as any;
    if (snapshot) {
      const snap = await captureAriaSnapshot(context, tabId);
      return snap;
    }
    return {
      content: [
        {
          type: "text",
          text: `Navigated to ${url}${tabSuffix(result)}`,
        },
      ],
    };
  },
});

export const goBack: ToolFactory = (snapshot) => ({
  schema: {
    name: GoBackTool.shape.name.value,
    description: GoBackTool.shape.description.value,
    inputSchema: zodToJsonSchema(GoBackTool.shape.arguments),
  },
  handle: async (context, params) => {
    const { tabId } = GoBackTool.shape.arguments.parse(params);
    const result = (await context.sendSocketMessage("browser_go_back", {
      tabId,
    })) as any;
    if (snapshot) {
      return captureAriaSnapshot(context, tabId);
    }
    return {
      content: [
        {
          type: "text",
          text: `Navigated back${tabSuffix(result)}`,
        },
      ],
    };
  },
});

export const goForward: ToolFactory = (snapshot) => ({
  schema: {
    name: GoForwardTool.shape.name.value,
    description: GoForwardTool.shape.description.value,
    inputSchema: zodToJsonSchema(GoForwardTool.shape.arguments),
  },
  handle: async (context, params) => {
    const { tabId } = GoForwardTool.shape.arguments.parse(params);
    const result = (await context.sendSocketMessage("browser_go_forward", {
      tabId,
    })) as any;
    if (snapshot) {
      return captureAriaSnapshot(context, tabId);
    }
    return {
      content: [
        {
          type: "text",
          text: `Navigated forward${tabSuffix(result)}`,
        },
      ],
    };
  },
});

export const wait: Tool = {
  schema: {
    name: WaitTool.shape.name.value,
    description: WaitTool.shape.description.value,
    inputSchema: zodToJsonSchema(WaitTool.shape.arguments),
  },
  handle: async (context, params) => {
    const { time } = WaitTool.shape.arguments.parse(params);
    await new Promise((resolve) => setTimeout(resolve, time * 1000));
    return captureAriaSnapshot(context, undefined, `Waited for ${time} seconds`);
  },
};

export const pressKey: Tool = {
  schema: {
    name: PressKeyTool.shape.name.value,
    description: PressKeyTool.shape.description.value,
    inputSchema: zodToJsonSchema(PressKeyTool.shape.arguments),
  },
  handle: async (context, params) => {
    const { key, tabId } = PressKeyTool.shape.arguments.parse(params);
    await context.sendSocketMessage("browser_press_key", { key, tabId });
    return captureAriaSnapshot(context, tabId, `Pressed key ${key}`);
  },
};
