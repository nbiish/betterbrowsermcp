/**
 * @betterbrowsermcp/mcp — tool input schemas
 *
 * Zod schemas that define the input contract for every MCP tool the server
 * exposes. Inlined from @repo/types/mcp/tool so the project builds
 * standalone without the upstream monorepo.
 *
 * v0.2.0+: every browser_* tool accepts an optional `tabId` parameter
 * (number) for multi-tab routing. If omitted, the extension routes
 * to the agent's active tab (or the first bound tab if no active
 * is set).
 *
 * Adding a new tool: add the Zod schema here, add it to the MCPTool
 * discriminated union, then wire it into the tools/* handlers.
 */

import { z } from "zod";

/**
 * Optional tab selector. When omitted, the extension routes the
 * tool call to the agent's active tab (or the first bound tab).
 * Pass a specific tabId to target a particular bound tab.
 */
const TabIdParam = z
  .number()
  .int()
  .positive()
  .optional()
  .describe(
    "Optional tab ID to target. When omitted, routes to the agent's active tab. Use browser_list_tabs to see available tab IDs.",
  );

const ElementSchema = z.object({
  element: z
    .string()
    .describe(
      "Human-readable element description used to obtain permission to interact with the element",
    ),
  ref: z
    .string()
    .describe("Exact target element reference from the page snapshot"),
  tabId: TabIdParam,
});

export const NavigateTool = z.object({
  name: z.literal("browser_navigate"),
  description: z.literal("Navigate to a URL"),
  arguments: z.object({
    url: z.string().describe("The URL to navigate to"),
    tabId: TabIdParam,
  }),
});

export const GoBackTool = z.object({
  name: z.literal("browser_go_back"),
  description: z.literal("Go back to the previous page"),
  arguments: z.object({ tabId: TabIdParam }),
});

export const GoForwardTool = z.object({
  name: z.literal("browser_go_forward"),
  description: z.literal("Go forward to the next page"),
  arguments: z.object({ tabId: TabIdParam }),
});

export const WaitTool = z.object({
  name: z.literal("browser_wait"),
  description: z.literal("Wait for a specified time in seconds"),
  arguments: z.object({
    time: z.number().describe("The time to wait in seconds"),
  }),
});

export const PressKeyTool = z.object({
  name: z.literal("browser_press_key"),
  description: z.literal("Press a key on the keyboard"),
  arguments: z.object({
    key: z
      .string()
      .describe(
        "Name of the key to press or a character to generate, such as `ArrowLeft` or `a`",
      ),
    tabId: TabIdParam,
  }),
});

export const SnapshotTool = z.object({
  name: z.literal("browser_snapshot"),
  description: z.literal(
    "Capture accessibility snapshot of the current page. Use this for getting references to elements to interact with. The snapshot also lists all bound tabs so the LLM can pick a different tab via tabId on subsequent calls.",
  ),
  arguments: z.object({ tabId: TabIdParam }),
});

export const ClickTool = z.object({
  name: z.literal("browser_click"),
  description: z.literal("Perform click on a web page"),
  arguments: ElementSchema,
});

export const DragTool = z.object({
  name: z.literal("browser_drag"),
  description: z.literal("Perform drag and drop between two elements"),
  arguments: z.object({
    startElement: z
      .string()
      .describe(
        "Human-readable source element description used to obtain the permission to interact with the element",
      ),
    startRef: z
      .string()
      .describe("Exact source element reference from the page snapshot"),
    endElement: z
      .string()
      .describe(
        "Human-readable target element description used to obtain the permission to interact with the element",
      ),
    endRef: z
      .string()
      .describe("Exact target element reference from the page snapshot"),
    tabId: TabIdParam,
  }),
});

export const HoverTool = z.object({
  name: z.literal("browser_hover"),
  description: z.literal("Hover over element on page"),
  arguments: ElementSchema,
});

export const TypeTool = z.object({
  name: z.literal("browser_type"),
  description: z.literal("Type text into editable element"),
  arguments: ElementSchema.extend({
    text: z.string().describe("Text to type into the element"),
    submit: z
      .boolean()
      .describe("Whether to submit entered text (press Enter after)"),
  }),
});

export const SelectOptionTool = z.object({
  name: z.literal("browser_select_option"),
  description: z.literal("Select an option in a dropdown"),
  arguments: ElementSchema.extend({
    values: z
      .array(z.string())
      .describe(
        "Array of values to select in the dropdown. This can be a single value or multiple values.",
      ),
  }),
});

export const ScreenshotTool = z.object({
  name: z.literal("browser_screenshot"),
  description: z.literal("Take a screenshot of the current page"),
  arguments: z.object({ tabId: TabIdParam }),
});

export const GetConsoleLogsTool = z.object({
  name: z.literal("browser_get_console_logs"),
  description: z.literal("Get the console logs from the browser"),
  arguments: z.object({ tabId: TabIdParam }),
});

// ============================================================
//  Multi-tab management tools (v0.2.0+)
// ============================================================

export const ListTabsTool = z.object({
  name: z.literal("browser_list_tabs"),
  description: z.literal(
    "List all browser tabs bound to this agent. Returns tabId, label, URL, title, and which one is the agent's active tab. Use this to discover what's available before issuing tool calls that need a specific tab.",
  ),
  arguments: z.object({}),
});

export const OpenTabTool = z.object({
  name: z.literal("browser_open_tab"),
  description: z.literal(
    "Open a new browser tab and bind it to this agent. Optionally provide a URL (will navigate after open) and a human-readable label (the LLM uses the label to refer to the tab in subsequent calls). The new tab is set as the agent's active tab.",
  ),
  arguments: z.object({
    url: z
      .string()
      .optional()
      .describe("Optional URL to navigate to after the tab opens"),
    label: z
      .string()
      .optional()
      .describe(
        "Human-readable label for this tab (e.g. 'Stripe dashboard', 'OpenAI console'). If omitted, the tab's hostname or title is used.",
      ),
  }),
});

export const CloseTabTool = z.object({
  name: z.literal("browser_close_tab"),
  description: z.literal(
    "Close a browser tab previously bound to this agent. The tab's binding is automatically removed.",
  ),
  arguments: z.object({
    tabId: z.number().int().positive().describe("Tab ID to close"),
  }),
});

export const RenameTabTool = z.object({
  name: z.literal("browser_rename_tab"),
  description: z.literal(
    "Set a human-readable label on a bound tab. The label is what the LLM uses to refer to the tab in conversation and in browser_list_tabs output.",
  ),
  arguments: z.object({
    tabId: z.number().int().positive().describe("Tab ID to rename"),
    label: z.string().describe("New label for the tab"),
  }),
});

export const SetActiveTabTool = z.object({
  name: z.literal("browser_set_active_tab"),
  description: z.literal(
    "Set which bound tab is the agent's active tab. Tool calls that don't specify a tabId route to the active tab. Use this to switch the agent's focus between bound tabs.",
  ),
  arguments: z.object({
    tabId: z
      .number()
      .int()
      .positive()
      .describe("Tab ID to make active. Must be bound to this agent."),
  }),
});

export const CopyToClipboardTool = z.object({
  name: z.literal("browser_copy_to_clipboard"),
  description: z.literal(
    "Click a 'Click to copy' button on the page and return the value the page wrote to the clipboard. Use this for Stripe's publishable key / secret key copy buttons, GitHub PAT copy buttons, AWS access key copy buttons, and any other 'click to copy' UI patterns. The content script patches navigator.clipboard.writeText to capture the value as it is written, then returns it to the LLM.\n\nThe returned value is plain text (the literal content of the copy button). For secret material, the LLM should pipe it to the user's PQC secrets store (e.g. via the pqc-secrets CLI) rather than persisting it in chat history or unencrypted state.",
  ),
  arguments: z.object({
    element: z
      .string()
      .describe(
        "Human-readable element description used to obtain permission to interact with the element",
      ),
    ref: z
      .string()
      .describe("Exact target element reference from the page snapshot"),
    tabId: TabIdParam,
  }),
});

export const MCPTool = z.discriminatedUnion("name", [
  // Common
  NavigateTool,
  GoBackTool,
  GoForwardTool,
  WaitTool,
  PressKeyTool,
  SnapshotTool,
  // Snapshot-based
  ClickTool,
  DragTool,
  HoverTool,
  TypeTool,
  SelectOptionTool,
  // Custom
  ScreenshotTool,
  GetConsoleLogsTool,
  // Tab management
  ListTabsTool,
  OpenTabTool,
  CloseTabTool,
  RenameTabTool,
  SetActiveTabTool,
  // Clipboard
  CopyToClipboardTool,
]);
