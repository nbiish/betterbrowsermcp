/**
 * @betterbrowsermcp/mcp — clipboard tools
 *
 * browser_copy_to_clipboard — clicks a "Click to copy" button on
 * the page and returns the value the page wrote to the clipboard.
 *
 * The content script patches navigator.clipboard.writeText to
 * capture the value as it is written, then returns it to the LLM.
 * This is a much more reliable way to read "click to copy" content
 * than reading the system clipboard (which requires the page to be
 * focused and a user gesture).
 *
 * Common use cases:
 * - Stripe publishable key / secret key copy buttons
 * - GitHub PAT copy buttons
 * - AWS access key copy buttons
 * - Any other UI that says "Click to copy"
 *
 * The returned value is plain text. For secret material, the LLM
 * should pipe it to the user's PQC secrets store (e.g. via the
 * pqc-secrets CLI) rather than persisting it in chat history or
 * unencrypted state. See the AGENTS.md for the project's PQC
 * policy (FIPS 203/204/205 for secrets operations).
 */

import { zodToJsonSchema } from "zod-to-json-schema";

import { CopyToClipboardTool } from "@/types";

import type { Tool } from "./tool";

export const copyToClipboard: Tool = {
  schema: {
    name: CopyToClipboardTool.shape.name.value,
    description: CopyToClipboardTool.shape.description.value,
    inputSchema: zodToJsonSchema(CopyToClipboardTool.shape.arguments),
  },
  handle: async (context, params) => {
    const { ref, element, tabId } = CopyToClipboardTool.shape.arguments.parse(params);
    const result = (await context.sendSocketMessage("browser_copy_to_clipboard", {
      ref,
      tabId,
    })) as any;

    if (!result || !result.ok) {
      return {
        content: [
          {
            type: "text",
            text:
              `Failed to copy via element "${element}": ${result?.error || "unknown error"}\n\n` +
              `Common causes:\n` +
              `- The element's click handler does not call navigator.clipboard.writeText\n` +
              `  (e.g. it opens a modal showing the value, or it uses document.execCommand).\n` +
              `- The element wasn't actually clickable (covered by another element, disabled, etc.).\n` +
              `- A browser permission blocked the clipboard write.\n\n` +
              `If the value is shown in a modal on the page after clicking, snapshot the page again\n` +
              `and look for a text node containing the value (or call browser_get_console_logs to\n` +
              `see if there are any React/state errors that prevented the modal from rendering).`,
          },
        ],
        isError: true,
      };
    }

    const value = String(result.value || "");
    // The value can be a long secret — print it in a way that the
    // LLM can capture it for downstream tool calls (e.g. piping
    // to pqc-secrets add). We include a clear header so the LLM
    // knows what to do with it.
    return {
      content: [
        {
          type: "text",
          text:
            `Copied value via element "${element}" (ref=${ref}, tabId=${result.tabId ?? "n/a"}):\n\n` +
            `\`\`\`\n${value}\n\`\`\`\n\n` +
            `Next steps (for secret material):\n` +
            `- To save to the user's PQC secrets bundle, run: \`pqc-secrets add <NAME> '<value>'\`\n` +
            `  (or load it into the current shell via \`secrets-load\`).\n` +
            `- For non-secret material, this value can be used directly in subsequent tool calls.\n` +
            `- Do NOT paste this value into the chat history or commit it to the repo.\n` +
            `- The captured value is also available to the page in the system clipboard (the\n` +
            `  underlying navigator.clipboard.writeText call still happened).`,
        },
      ],
    };
  },
};
