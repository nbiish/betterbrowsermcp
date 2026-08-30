/**
 * @betterbrowsermcp/mcp — CDP cursor tools (Phase 4)
 *
 * Pass-through verbs matching the extension's CDP cursor primitive
 * (docs/cursor-primitive.md). The server does NO targeting logic:
 * each handler validates the input, forwards the payload VERBATIM
 * over the WebSocket (selector/ref/x/y + optional tabId intact),
 * and passes the extension's result straight back to the LLM.
 *
 * Error passthrough: extension-reported errors (TAB_LOCKED, BUSY,
 * ELEMENT_NOT_FOUND, ...) surface as-is, both as thrown WS errors
 * and as structured {ok:false, error} payloads.
 *
 * Verbs: move, hover, click, click_hold, drag, scroll, submit,
 * context_menu.
 */

import { zodToJsonSchema } from "zod-to-json-schema";
import type { z } from "zod";

import {
  CursorClickHoldTool,
  CursorClickTool,
  CursorContextMenuTool,
  CursorDragTool,
  CursorHoverTool,
  CursorMoveTool,
  CursorScrollTool,
  CursorSubmitTool,
} from "@/types";

import type { MessageType, SocketMessageMap } from "@/messaging";

import type { Tool } from "./tool";

type CursorToolSchema = z.ZodObject<{
  name: z.ZodLiteral<string>;
  description: z.ZodLiteral<string>;
  arguments: z.ZodObject<any>;
}>;

/**
 * Shared implementation for every cursor verb: parse → forward
 * verbatim → pass the result through (with a one-line verdict so
 * the LLM can skim success/failure before the raw JSON).
 */
function cursorVerbTool(Schema: CursorToolSchema): Tool {
  const verb: string = Schema.shape.name.value;
  return {
    schema: {
      name: verb,
      description: Schema.shape.description.value,
      inputSchema: zodToJsonSchema(Schema.shape.arguments),
    },
    handle: async (context, params) => {
      // Parse to validate + apply schema defaults (e.g. hold_ms: 500),
      // then forward the parsed payload untouched — tabId included.
      const args = Schema.shape.arguments.parse(params ?? {}) as Record<
        string,
        unknown
      >;
      let result: any;
      try {
        result = await context.sendSocketMessage(
          verb as MessageType<SocketMessageMap>,
          args,
        );
      } catch (error) {
        // Extension-reported error string passes through verbatim
        // (TAB_LOCKED, BUSY, ELEMENT_NOT_FOUND, WS timeouts, ...).
        return {
          content: [
            { type: "text", text: `${verb} failed: ${String(error)}` },
          ],
          isError: true,
        };
      }
      if (result && typeof result === "object" && result.ok === false) {
        const selector = result.selector ? ` selector=${result.selector}` : "";
        const hint = result.hint ? ` (hint: ${result.hint})` : "";
        return {
          content: [
            {
              type: "text",
              text: `${verb} failed: ${result.error ?? "unknown"}${selector}${hint}`,
            },
          ],
          isError: true,
        };
      }
      return {
        content: [
          {
            type: "text",
            text: `${verb} ok. ${JSON.stringify(result)}`,
          },
        ],
      };
    },
  };
}

// CDP cursor verbs (Phase 4) — one entry per frozen wire contract.
export const cursorMove = cursorVerbTool(CursorMoveTool);
export const cursorHover = cursorVerbTool(CursorHoverTool);
export const cursorClick = cursorVerbTool(CursorClickTool);
export const cursorClickHold = cursorVerbTool(CursorClickHoldTool);
export const cursorDrag = cursorVerbTool(CursorDragTool);
export const cursorScroll = cursorVerbTool(CursorScrollTool);
export const cursorSubmit = cursorVerbTool(CursorSubmitTool);
export const cursorContextMenu = cursorVerbTool(CursorContextMenuTool);

export const cursorTools: Tool[] = [
  cursorMove,
  cursorHover,
  cursorClick,
  cursorClickHold,
  cursorDrag,
  cursorScroll,
  cursorSubmit,
  cursorContextMenu,
];
