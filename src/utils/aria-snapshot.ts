import { Context } from "@/context";
import { ToolResult } from "@/tools/tool";

/**
 * Capture a YAML accessibility snapshot of the page bound to
 * `tabId` (or, when omitted, the agent's active tab).
 *
 * The snapshot is the primary way the LLM "sees" the page — it
 * produces a tree of accessibility-tree-relevant nodes with stable
 * ref IDs that subsequent tool calls (browser_click, browser_type,
 * etc.) can reference. Refs are stable for the lifetime of the
 * page; a re-snapshot reassigns them.
 *
 * The output also embeds:
 *   - The tabId and label of the tab that was actually captured
 *     (so the LLM knows which tab it just snapshotted, useful in
 *     multi-tab setups)
 *   - The full list of bound tabs (so the LLM can pick a
 *     different one for the next call)
 *   - A trailing "use browser_set_active_tab to switch" hint
 */
export async function captureAriaSnapshot(
  context: Context,
  tabId?: number,
  status: string = "",
): Promise<ToolResult> {
  const url = (await context.sendSocketMessage("getUrl", { tabId })) as any;
  const title = (await context.sendSocketMessage("getTitle", {
    tabId,
  })) as any;
  const tabsResult = (await context.sendSocketMessage("browser_list_tabs", {
    tabId,
  })) as any;
  const snapshot = (await context.sendSocketMessage("browser_snapshot", {
    tabId,
  })) as any;

  // The extension returns a list of bound tabs. We embed a
  // compact summary in the snapshot text so the LLM always knows
  // what's available without a separate tool call.
  let tabsBlock = "";
  if (tabsResult && Array.isArray(tabsResult.tabs)) {
    const lines = tabsResult.tabs.map((t: any) => {
      const marker = t.isActive ? " ← active" : "";
      return `  - tabId=${t.tabId}  label="${t.label}"  url=${t.url}${marker}`;
    });
    tabsBlock = `\n- Bound tabs for this agent:\n${lines.join("\n")}\n`;
  }

  return {
    content: [
      {
        type: "text",
        text: `${status ? `${status}\n` : ""}
- Page URL: ${typeof url === "object" ? url.url : url}
- Page Title: ${typeof title === "object" ? title.title : title}
${tabsBlock}
- Page Snapshot
\`\`\`yaml
${typeof snapshot === "object" ? snapshot.snapshot : snapshot}
\`\`\`
`,
      },
    ],
  };
}
