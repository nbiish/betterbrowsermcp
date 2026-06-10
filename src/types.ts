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

// ============================================================
//  Extraction & SPA-state tools (v0.5.0+)
// ============================================================

export const PasteTextTool = z.object({
  name: z.literal("browser_paste_text"),
  description: z.literal(
    "Paste text into a focused element on the page. If `ref` is provided, that element is focused first; otherwise the currently focused element receives the paste. Counterpart to `browser_copy_to_clipboard` — copy a value with the copy tool, then paste it elsewhere. Dispatches a synthetic `paste` event (clipboardData.setData + 'insertFromPaste') so React/Vue/Angular controlled inputs accept the value. Use for Stripe webhook secret fields, generated API key fields, or any text you need to push into a form.",
  ),
  arguments: z.object({
    text: z
      .string()
      .describe("The text to paste into the focused element"),
    ref: z
      .string()
      .optional()
      .describe(
        "Optional element ref. If provided, the element is focused before the paste event is dispatched. If omitted, the currently focused element is used.",
      ),
    element: z
      .string()
      .optional()
      .describe(
        "Human-readable description of the target element (required if `ref` is set, for permission)",
      ),
    tabId: TabIdParam,
  }),
});

export const WaitForTextTool = z.object({
  name: z.literal("browser_wait_for_text"),
  description: z.literal(
    "Wait for a specific text to appear anywhere in the page DOM (case-insensitive substring match). Polls every 500ms until the text is found or the timeout elapses. Replaces blind `browser_wait(time)` calls. Returns a fresh ARIA snapshot once the text appears. Use after clicking a submit button, or to wait for a Stripe dashboard to finish loading. On timeout, returns an error with the current page text length so you can diagnose what is or isn't rendering.",
  ),
  arguments: z.object({
    text: z
      .string()
      .describe(
        "The text (or substring) to wait for. Case-insensitive. Whitespace-normalized.",
      ),
    timeout: z
      .number()
      .optional()
      .default(30)
      .describe(
        "Maximum seconds to wait. Default 30. Use 5-10 for fast SPAs, 60+ for dashboard loads.",
      ),
    tabId: TabIdParam,
  }),
});

export const GetAttributeTool = z.object({
  name: z.literal("browser_get_attribute"),
  description: z.literal(
    "Read a single HTML attribute from an element referenced by snapshot ref. Use `attr: 'href'` to get a link's URL (e.g. extract a Stripe payment link from a share button), `attr: 'value'` for current input values, `attr: 'aria-label'` for accessibility text, or any custom `data-*` attribute. Returns the attribute value as a string, or an empty string if the attribute is not set. Cheaper and more precise than a full snapshot when you need one specific value.",
  ),
  arguments: ElementSchema.extend({
    attr: z
      .string()
      .describe(
        "The HTML attribute name to read (e.g. 'href', 'value', 'aria-label', 'data-testid')",
      ),
  }),
});

export const ExtractTextTool = z.object({
  name: z.literal("browser_extract_text"),
  description: z.literal(
    "Extract the `textContent` of a single element by ref. Cheaper than a full snapshot when you just need the visible text of one element. Returns the text as a plain string with whitespace normalized. Use to grab a heading, a status message, or a single field's value without paying the snapshot cost.",
  ),
  arguments: ElementSchema,
});

export const EvaluateTool = z.object({
  name: z.literal("browser_evaluate"),
  description: z.literal(
    "Run an arbitrary JavaScript expression in the page's main frame context. Returns the JSON-serializable result. Escape hatch for when ARIA snapshots cannot introspect something — React/Vue component state, computed styles, custom data attributes, third-party widget internals, hidden DOM the snapshot can't reach. The result must be JSON-serializable and is capped at 10KB. The expression runs in the page's global scope via indirect eval (sees `window`, `document`, etc.) and any side effects DO persist — only call this with code you have reviewed.",
  ),
  arguments: z.object({
    expression: z
      .string()
      .describe(
        "JavaScript expression to evaluate. The last expression value is returned. Example: `document.querySelector('h1').textContent` or `Array.from(document.querySelectorAll('a')).map(a => a.href)`.",
      ),
    tabId: TabIdParam,
  }),
});

// ============================================================
//  PQC secrets integration (v0.7.0+)
//
//  These tools wrap the `pqc-secrets` CLI (FIPS 203 ML-KEM-768 +
//  AES-256-GCM) so the LLM can read, list, and add secrets to
//  the PQC bundle at ~/.config/pqc-secrets/secrets.bundle.json
//  and pipe values into form fields via the existing paste_text
//  transport. See src/tools/secrets.ts for full architecture notes.
// ============================================================

export const SecretsStatusTool = z.object({
  name: z.literal("browser_secrets_status"),
  description: z.literal(
    "Report PQC bundle health: binary path, bundle path + mtime, keychain reachability, count of secrets, secret names. Returns plain READY/NOT READY verdict. Use this first to verify the pqc-secrets stack is wired before calling get/list/add.",
  ),
  arguments: z.object({}),
});

export const SecretsListTool = z.object({
  name: z.literal("browser_secrets_list"),
  description: z.literal(
    "List all secret names in the PQC bundle. Does NOT return values — use browser_secrets_get for that. Failures usually mean macOS is blocking the pqc-secrets binary's keychain access (user must approve the prompt).",
  ),
  arguments: z.object({}),
});

export const SecretsGetTool = z.object({
  name: z.literal("browser_secrets_get"),
  description: z.literal(
    "Decrypt and return the value of one secret from the PQC bundle. Returns plain text — handle with care. For ongoing use across many tool calls in the same session, prefer browser_secrets_unlock_agent so the value lives in the server's process memory rather than the conversation history.",
  ),
  arguments: z.object({
    name: z
      .string()
      .describe(
        "Exact secret name (case-sensitive). Use browser_secrets_list to discover names.",
      ),
  }),
});

export const SecretsLoadTool = z.object({
  name: z.literal("browser_secrets_load"),
  description: z.literal(
    "Load secrets into the page's window scope as a frozen read-only object at `window.__bbmcpSecrets__`. Fires a CustomEvent('bbmcp:secrets-loaded') the page can listen for. Does NOT trigger any paste event — pages that want to use a value must read it from window.__bbmcpSecrets__ explicitly. Useful when the page itself needs API access (e.g. a JS-driven form).",
  ),
  arguments: z.object({
    names: z
      .array(z.string())
      .optional()
      .describe(
        "Optional list of secret names to load. If omitted, all secrets are loaded.",
      ),
    tabId: TabIdParam,
  }),
});

export const SecretsAddTool = z.object({
  name: z.literal("browser_secrets_add"),
  description: z.literal(
    "Add or update one secret in the PQC bundle. Re-encrypts the entire bundle atomically. By default merges with existing secrets (merge=true); pass merge=false to REPLACE the entire bundle. Use the latter only if you're sure you want to wipe existing entries — the user will be asked to confirm in v0.7.1.",
  ),
  arguments: z.object({
    name: z
      .string()
      .describe("Secret name (case-sensitive; the env var name on export)."),
    value: z
      .string()
      .describe("Secret value. Will be AES-256-GCM encrypted at rest."),
    merge: z
      .boolean()
      .optional()
      .default(true)
      .describe(
        "If true (default), keep existing secrets and add/update this one. If false, REPLACE the entire bundle with just this one secret — destructive.",
      ),
  }),
});

export const SecretsAddFromClipboardTool = z.object({
  name: z.literal("browser_secrets_add_from_clipboard"),
  description: z.literal(
    "Add a secret to the PQC bundle using the current system clipboard contents as the value. Use this after a user has selected/copied a key from a dashboard (Stripe, GitHub, etc.) and wants to store it encrypted. NOTE: v0.7.0 ships as a stub — the full implementation needs a small extension-side clipboard read handler; scheduled for v0.7.1.",
  ),
  arguments: z.object({
    name: z
      .string()
      .describe("Secret name to add/update with the clipboard value."),
  }),
});

export const SecretsUnlockAgentTool = z.object({
  name: z.literal("browser_secrets_unlock_agent"),
  description: z.literal(
    "Mark a secret as 'unlocked' for a specific tab. The value is cached in the MCP server's process memory (not the OS clipboard, not the page). Subsequent browser_secrets_copy_to_page calls for the same tab can use the cached value without going through browser_secrets_get (which exposes the value in the conversation history). Clear with browser_secrets_lock_agent.",
  ),
  arguments: z.object({
    name: z
      .string()
      .describe("Secret name to unlock for this tab's session."),
    tabId: TabIdParam,
  }),
});

export const SecretsLockAgentTool = z.object({
  name: z.literal("browser_secrets_lock_agent"),
  description: z.literal(
    "Clear the unlocked-secrets cache for a tab. Pass `name` to lock just one secret, or omit to clear all unlocked secrets for the tab. Also called automatically when the tab is closed.",
  ),
  arguments: z.object({
    tabId: TabIdParam,
    name: z
      .string()
      .optional()
      .describe(
        "If set, only this secret is cleared. If omitted, all unlocked secrets for the tab are cleared.",
      ),
  }),
});

export const SecretsCopyToPageTool = z.object({
  name: z.literal("browser_secrets_copy_to_page"),
  description: z.literal(
    "Atomic: read a secret from the PQC bundle (or from the unlocked cache) and paste it into a form field on the page. Uses the existing browser_paste_text transport so it works on React-controlled inputs (the v0.6.0 valueTracker reset). The secret value flows server-side straight to the content script — it does NOT pass through the conversation history.",
  ),
  arguments: ElementSchema.extend({
    name: z
      .string()
      .describe("Secret name to paste into the field."),
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
  // Extraction & SPA-state (v0.5.0+)
  PasteTextTool,
  WaitForTextTool,
  GetAttributeTool,
  ExtractTextTool,
  EvaluateTool,
  // PQC secrets integration (v0.7.0+)
  SecretsStatusTool,
  SecretsListTool,
  SecretsGetTool,
  SecretsLoadTool,
  SecretsAddTool,
  SecretsAddFromClipboardTool,
  SecretsUnlockAgentTool,
  SecretsLockAgentTool,
  SecretsCopyToPageTool,
]);
