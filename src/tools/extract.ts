/**
 * @betterbrowsermcp/mcp — extraction & SPA-state tools (v0.5.0+)
 *
 * These five tools target the friction that ARIA snapshots and blind
 * `browser_wait(time)` calls hit when driving complex SPAs (Stripe
 * dashboard, OpenAI console, dashboards that swap content via fetch).
 *
 *  - `browser_paste_text`   paste a string (or a captured clipboard
 *                           value) into a focused element. Synthetic
 *                           `paste` event so React/Vue/Angular
 *                           controlled inputs accept the value.
 *  - `browser_wait_for_text` poll the DOM for a substring; replace
 *                           blind sleeps. Returns a fresh snapshot.
 *  - `browser_get_attribute` read a single HTML attribute by ref.
 *                           Use `href` to extract a payment link.
 *  - `browser_extract_text`  read a single element's textContent.
 *  - `browser_evaluate`      run an arbitrary JS expression in the
 *                           page. Escape hatch for React state,
 *                           computed styles, custom data attrs.
 *
 * The extension's content script does the DOM work; the server is a
 * thin proxy that maps MCP tool calls to WS messages and shapes the
 * response for the LLM.
 */

import { zodToJsonSchema } from "zod-to-json-schema";

import {
  EvaluateTool,
  ExtractTextTool,
  GetAttributeTool,
  PasteTextTool,
  WaitForTextTool,
} from "@/types";

import { captureAriaSnapshot } from "@/utils/aria-snapshot";

import type { Tool } from "./tool";

/* ------------------------------------------------------------------ *
 *  paste_text — synthetic paste into a focused element
 * ------------------------------------------------------------------ */

export const pasteText: Tool = {
  schema: {
    name: PasteTextTool.shape.name.value,
    description: PasteTextTool.shape.description.value,
    inputSchema: zodToJsonSchema(PasteTextTool.shape.arguments),
  },
  handle: async (context, params) => {
    const validated = PasteTextTool.shape.arguments.parse(params);
    const result = (await context.sendSocketMessage("browser_paste_text", {
      text: validated.text,
      ref: validated.ref,
      element: validated.element,
      tabId: validated.tabId,
    })) as any;

    if (!result || !result.ok) {
      return {
        content: [
          {
            type: "text",
            text:
              `Failed to paste text${validated.ref ? ` into "${validated.element}" (ref=${validated.ref})` : " into the focused element"}: ${result?.error || "unknown error"}\n\n` +
              `Common causes:\n` +
              `- No element is focused and no \`ref\` was provided. Call \`browser_snapshot\` to find\n` +
              `  a target, or focus an element first with \`browser_click\`.\n` +
              `- The element is not an editable input/contenteditable. Paste requires a focusable,\n` +
              `  editable target.\n` +
              `- The page's CSP blocked the synthetic paste event. Real keyboard paste (Cmd+V)\n` +
              `  via \`browser_press_key\` may still work as a fallback.`,
          },
        ],
        isError: true,
      };
    }

    const targetDesc = validated.ref
      ? `"${validated.element}" (ref=${validated.ref})`
      : "the focused element";
    return {
      content: [
        {
          type: "text",
          text:
            `Pasted ${validated.text.length} character(s) into ${targetDesc} (tabId=${result.tabId ?? "n/a"}).\n\n` +
            `Note: the synthetic paste event does not write to the system clipboard. If the page's\n` +
            `event handler reads \`event.clipboardData.getData('text/plain')\` it will receive the\n` +
            `value; the OS clipboard is untouched. Use \`browser_copy_to_clipboard\` if you need\n` +
            `the value to live in the system clipboard too.`,
        },
      ],
    };
  },
};

/* ------------------------------------------------------------------ *
 *  wait_for_text — poll the DOM for a substring
 * ------------------------------------------------------------------ */

export const waitForText: Tool = {
  schema: {
    name: WaitForTextTool.shape.name.value,
    description: WaitForTextTool.shape.description.value,
    inputSchema: zodToJsonSchema(WaitForTextTool.shape.arguments),
  },
  handle: async (context, params) => {
    const validated = WaitForTextTool.shape.arguments.parse(params);
    const timeoutSec = validated.timeout ?? 30;

    // The extension polls every 500ms internally. It returns
    //   { ok: true, tabId, elapsedMs }
    // on match, or
    //   { ok: false, error, tabId, elapsedMs, bodyTextLength }
    // on timeout.
    const result = (await context.sendSocketMessage(
      "browser_wait_for_text",
      {
        text: validated.text,
        timeout: timeoutSec,
        tabId: validated.tabId,
      },
      { timeoutMs: (timeoutSec + 5) * 1000 }, // hard ceiling slightly over the soft timeout
    )) as any;

    if (!result || !result.ok) {
      const elapsed = result?.elapsedMs ? `${(result.elapsedMs / 1000).toFixed(1)}s` : "n/a";
      return {
        content: [
          {
            type: "text",
            text:
              `Timed out after ${timeoutSec}s waiting for text "${validated.text}" (elapsed: ${elapsed}).\n\n` +
              `Diagnostics:\n` +
              `- Page body text length: ${result?.bodyTextLength ?? "?"} chars\n` +
              `- Check whether the click/submit actually fired (\`browser_get_console_logs\`).\n` +
              `- The text may be inside a shadow DOM or iframe the snapshot can't reach.\n` +
              `- If the page navigated, you may need to call \`browser_navigate\` first then retry.\n` +
              `- As a last resort, use \`browser_evaluate\` to query the DOM directly:\n` +
              `    document.body.innerText.toLowerCase().includes("${validated.text.toLowerCase()}")`,
          },
        ],
        isError: true,
      };
    }

    const elapsed = `${(result.elapsedMs / 1000).toFixed(2)}s`;
    // On success, return a fresh snapshot so the LLM can act on
    // whatever just appeared.
    const snapshot = await captureAriaSnapshot(context, validated.tabId);
    return {
      content: [
        {
          type: "text",
          text: `Found text "${validated.text}" after ${elapsed} (tabId=${result.tabId ?? "n/a"}).`,
        },
        ...snapshot.content,
      ],
    };
  },
};

/* ------------------------------------------------------------------ *
 *  get_attribute — read one HTML attribute by ref
 * ------------------------------------------------------------------ */

export const getAttribute: Tool = {
  schema: {
    name: GetAttributeTool.shape.name.value,
    description: GetAttributeTool.shape.description.value,
    inputSchema: zodToJsonSchema(GetAttributeTool.shape.arguments),
  },
  handle: async (context, params) => {
    const validated = GetAttributeTool.shape.arguments.parse(params);
    const result = (await context.sendSocketMessage("browser_get_attribute", {
      ref: validated.ref,
      attr: validated.attr,
      tabId: validated.tabId,
    })) as any;

    if (!result || !result.ok) {
      return {
        content: [
          {
            type: "text",
            text:
              `Failed to read attribute "${validated.attr}" from "${validated.element}" (ref=${validated.ref}): ${result?.error || "unknown error"}\n\n` +
              `The ref may be stale (re-run \`browser_snapshot\` to get fresh refs).`,
          },
        ],
        isError: true,
      };
    }

    const value = String(result.value ?? "");
    return {
      content: [
        {
          type: "text",
          text:
            `Attribute "${validated.attr}" on "${validated.element}" (ref=${validated.ref}, tabId=${result.tabId ?? "n/a"}):\n\n` +
            `\`\`\`\n${value}\n\`\`\`\n\n` +
            (value === ""
              ? `(empty string — attribute is not set on this element)\n`
              : ""),
        },
      ],
    };
  },
};

/* ------------------------------------------------------------------ *
 *  extract_text — read one element's textContent by ref
 * ------------------------------------------------------------------ */

export const extractText: Tool = {
  schema: {
    name: ExtractTextTool.shape.name.value,
    description: ExtractTextTool.shape.description.value,
    inputSchema: zodToJsonSchema(ExtractTextTool.shape.arguments),
  },
  handle: async (context, params) => {
    const validated = ExtractTextTool.shape.arguments.parse(params);
    const result = (await context.sendSocketMessage("browser_extract_text", {
      ref: validated.ref,
      tabId: validated.tabId,
    })) as any;

    if (!result || !result.ok) {
      return {
        content: [
          {
            type: "text",
            text:
              `Failed to extract text from "${validated.element}" (ref=${validated.ref}): ${result?.error || "unknown error"}\n\n` +
              `The ref may be stale. Run \`browser_snapshot\` to get fresh refs.`,
          },
        ],
        isError: true,
      };
    }

    const text = String(result.text ?? "");
    return {
      content: [
        {
          type: "text",
          text:
            `Text from "${validated.element}" (ref=${validated.ref}, tabId=${result.tabId ?? "n/a"}):\n\n` +
            `\`\`\`\n${text}\n\`\`\``,
        },
      ],
    };
  },
};

/* ------------------------------------------------------------------ *
 *  evaluate — run an arbitrary JS expression in the page
 * ------------------------------------------------------------------ */

const EVAL_OUTPUT_CAP = 10 * 1024; // 10KB

export const evaluate: Tool = {
  schema: {
    name: EvaluateTool.shape.name.value,
    description: EvaluateTool.shape.description.value,
    inputSchema: zodToJsonSchema(EvaluateTool.shape.arguments),
  },
  handle: async (context, params) => {
    const validated = EvaluateTool.shape.arguments.parse(params);
    const result = (await context.sendSocketMessage("browser_evaluate", {
      expression: validated.expression,
      tabId: validated.tabId,
    })) as any;

    if (!result || !result.ok) {
      return {
        content: [
          {
            type: "text",
            text:
              `\`browser_evaluate\` failed: ${result?.error || "unknown error"}\n\n` +
              `If the error is a SyntaxError, the expression was not valid JavaScript.\n` +
              `If it is a ReferenceError, a referenced name does not exist in the page scope.\n` +
              `If it is a TypeError, the operation is not allowed on the value at hand.\n` +
              `The expression runs in the page's main frame; cross-origin iframes are not reachable.`,
          },
        ],
        isError: true,
      };
    }

    let raw = result.value;
    let serialized: string;
    let truncated = false;

    try {
      serialized = JSON.stringify(raw, null, 2);
    } catch (e) {
      // The extension should have already JSON-serialized; if we
      // still can't, the value is something exotic (BigInt, Symbol, etc.)
      return {
        content: [
          {
            type: "text",
            text:
              `\`browser_evaluate\` returned a value that cannot be JSON-serialized.\n` +
              `Original error: ${(e as Error).message}\n\n` +
              `Tip: coerce to a string/number/array explicitly in the expression.\n` +
              `Example: \`Array.from(document.querySelectorAll('a')).map(a => a.href)\` returns a plain array.`,
          },
        ],
        isError: true,
      };
    }

    if (serialized.length > EVAL_OUTPUT_CAP) {
      serialized = serialized.slice(0, EVAL_OUTPUT_CAP) + "\n... (truncated, 10KB cap exceeded)";
      truncated = true;
    }

    return {
      content: [
        {
          type: "text",
          text:
            `Result of \`${validated.expression}\` (tabId=${result.tabId ?? "n/a"}):\n\n` +
            `\`\`\`json\n${serialized}\n\`\`\`` +
            (truncated ? "\n\n(Output truncated at 10KB.)" : ""),
        },
      ],
    };
  },
};
