/**
 * @betterbrowsermcp/mcp — snapshot-based interactive tools
 *
 * Tools that operate on accessibility snapshot refs — click, hover,
 * type, selectOption, drag, and the snapshot reader itself.
 *
 * v0.2.0+: tabId passes through to the extension. The element
 * schema's tabId is forwarded in the WS message; the extension
 * routes to that tab (or the active tab if absent).
 */

import zodToJsonSchema from "zod-to-json-schema";

import {
  ClickTool,
  DragTool,
  HoverTool,
  SelectOptionTool,
  SnapshotTool,
  TypeTool,
} from "@/types";

import type { Context } from "@/context";
import { captureAriaSnapshot } from "@/utils/aria-snapshot";

import type { Tool, ToolResult } from "./tool";

/**
 * v0.9.1: when the element action itself fails (unbound tab, stale
 * ref, ELEMENT_NOT_FOUND), return an explicit isError result instead
 * of snapshotting whatever page the browser is on — a follow-up
 * snapshot of the WRONG page reads as success and derails the agent.
 */
function actionError(action: string, result: any): ToolResult | null {
  if (!(result && typeof result === "object" && result.ok === false)) {
    return null;
  }
  return {
    isError: true as const,
    content: [
      {
        type: "text",
        text:
          `${action} failed: ${result.error || "unknown error"}\n\n` +
          `Tab IDs are agent-scoped — run browser_list_tabs for your bound tabs. ` +
          `If the ref was stale, run browser_snapshot again for fresh refs.`,
      },
    ],
  };
}

export const snapshot: Tool = {
  schema: {
    name: SnapshotTool.shape.name.value,
    description: SnapshotTool.shape.description.value,
    inputSchema: zodToJsonSchema(SnapshotTool.shape.arguments),
  },
  handle: async (context: Context, params) => {
    const { tabId } = SnapshotTool.shape.arguments.parse(params);
    // When no tabId specified, the extension returns the active
    // tab's snapshot. When tabId is provided, the snapshot is
    // taken on that specific tab. We pass tabId through to
    // captureAriaSnapshot so it also routes the trailing
    // getUrl/getTitle calls to the same tab.
    return await captureAriaSnapshot(context, tabId);
  },
};

export const click: Tool = {
  schema: {
    name: ClickTool.shape.name.value,
    description: ClickTool.shape.description.value,
    inputSchema: zodToJsonSchema(ClickTool.shape.arguments),
  },
  handle: async (context: Context, params) => {
    const validatedParams = ClickTool.shape.arguments.parse(params);
    const action = (await context.sendSocketMessage(
      "browser_click",
      validatedParams,
    )) as any;
    const failure = actionError("Click", action);
    if (failure) return failure;
    const snapshot = await captureAriaSnapshot(
      context,
      validatedParams.tabId,
    );
    return {
      content: [
        {
          type: "text",
          text: `Clicked "${validatedParams.element}"`,
        },
        ...snapshot.content,
      ],
    };
  },
};

export const drag: Tool = {
  schema: {
    name: DragTool.shape.name.value,
    description: DragTool.shape.description.value,
    inputSchema: zodToJsonSchema(DragTool.shape.arguments),
  },
  handle: async (context: Context, params) => {
    const validatedParams = DragTool.shape.arguments.parse(params);
    const action = (await context.sendSocketMessage(
      "browser_drag",
      validatedParams,
    )) as any;
    const failure = actionError("Drag", action);
    if (failure) return failure;
    const snapshot = await captureAriaSnapshot(
      context,
      validatedParams.tabId,
    );
    return {
      content: [
        {
          type: "text",
          text: `Dragged "${validatedParams.startElement}" to "${validatedParams.endElement}"`,
        },
        ...snapshot.content,
      ],
    };
  },
};

export const hover: Tool = {
  schema: {
    name: HoverTool.shape.name.value,
    description: HoverTool.shape.description.value,
    inputSchema: zodToJsonSchema(HoverTool.shape.arguments),
  },
  handle: async (context: Context, params) => {
    const validatedParams = HoverTool.shape.arguments.parse(params);
    const action = (await context.sendSocketMessage(
      "browser_hover",
      validatedParams,
    )) as any;
    const failure = actionError("Hover", action);
    if (failure) return failure;
    const snapshot = await captureAriaSnapshot(
      context,
      validatedParams.tabId,
    );
    return {
      content: [
        {
          type: "text",
          text: `Hovered "${validatedParams.element}"`,
        },
        ...snapshot.content,
      ],
    };
  },
};

export const type: Tool = {
  schema: {
    name: TypeTool.shape.name.value,
    description: TypeTool.shape.description.value,
    inputSchema: zodToJsonSchema(TypeTool.shape.arguments),
  },
  handle: async (context: Context, params) => {
    const validatedParams = TypeTool.shape.arguments.parse(params);
    const action = (await context.sendSocketMessage(
      "browser_type",
      validatedParams,
    )) as any;
    const failure = actionError("Type", action);
    if (failure) return failure;
    const snapshot = await captureAriaSnapshot(
      context,
      validatedParams.tabId,
    );
    return {
      content: [
        {
          type: "text",
          text: `Typed "${validatedParams.text}" into "${validatedParams.element}"`,
        },
        ...snapshot.content,
      ],
    };
  },
};

export const selectOption: Tool = {
  schema: {
    name: SelectOptionTool.shape.name.value,
    description: SelectOptionTool.shape.description.value,
    inputSchema: zodToJsonSchema(SelectOptionTool.shape.arguments),
  },
  handle: async (context: Context, params) => {
    const validatedParams = SelectOptionTool.shape.arguments.parse(params);
    const action = (await context.sendSocketMessage(
      "browser_select_option",
      validatedParams,
    )) as any;
    const failure = actionError("Select option", action);
    if (failure) return failure;
    const snapshot = await captureAriaSnapshot(
      context,
      validatedParams.tabId,
    );
    return {
      content: [
        {
          type: "text",
          text: `Selected option(s) ${validatedParams.values.join(", ")} in "${validatedParams.element}"`,
        },
        ...snapshot.content,
      ],
    };
  },
};
