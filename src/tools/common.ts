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

import type { Tool, ToolFactory, ToolResult } from "./tool";

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

/**
 * v0.9.1: the extension resolves {ok:false, error} for tab-scoped
 * failures (unbound tabId, no active tab, content-script not ready).
 * Turning that into an explicit isError result — instead of printing
 * a success line or snapshotting the wrong page — is what lets the
 * agent self-correct instead of guessing.
 */
function tabOpError(
  action: string,
  result: any,
  tabId?: number,
): ToolResult | null {
  if (!(result && typeof result === "object" && result.ok === false)) {
    return null;
  }
  const target = tabId !== undefined ? ` (requested tabId=${tabId})` : "";
  return {
    isError: true as const,
    content: [
      {
        type: "text",
        text:
          `${action} failed: ${result.error || "unknown error"}${target}\n\n` +
          `Tab IDs are agent-scoped: you can only act on tabs bound to you. ` +
          `Run browser_list_tabs to see your bound tabs and pass one of those tabIds explicitly.`,
      },
    ],
  };
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
    const failure = tabOpError("Navigate", result, tabId);
    if (failure) return failure;
    if (snapshot) {
      const snap = await captureAriaSnapshot(context, tabId);
      return snap;
    }
    // v0.9.0: the extension waits for content-script readiness before
    // replying and includes the loaded page's title in the result.
    const titleSuffix =
      result?.title && typeof result.title === "string"
        ? ` (title: "${result.title}")`
        : "";
    return {
      content: [
        {
          type: "text",
          text: `Navigated to ${url}${titleSuffix}${tabSuffix(result)}`,
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
    const failure = tabOpError("Go back", result, tabId);
    if (failure) return failure;
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
    const failure = tabOpError("Go forward", result, tabId);
    if (failure) return failure;
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
    const result = (await context.sendSocketMessage("browser_press_key", {
      key,
      tabId,
    })) as any;
    const failure = tabOpError(`Press key "${key}"`, result, tabId);
    if (failure) return failure;
    return captureAriaSnapshot(context, tabId, `Pressed key ${key}`);
  },
};
