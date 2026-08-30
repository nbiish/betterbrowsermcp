import { Context } from "@/context";
import { formatEventOneLiners } from "@/events";
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

  // v0.9.1: the extension resolves {ok:false, error} when the target
  // tab is not bound to THIS agent (tabs are agent-scoped) or when no
  // active tab is set. Surface that explicitly instead of formatting
  // "undefined" into every header — a misleading snapshot costs the
  // agent more than a clean error. The bound-tab roster (when readable)
  // is embedded so the agent can immediately pick a valid tabId.
  const firstError = [url, title, snapshot].find(
    (r: any) => r && typeof r === "object" && r.ok === false,
  ) as any;
  if (firstError) {
    let rosterBlock =
      "\n\nNo tabs are bound to this agent yet — call browser_open_tab first.";
    if (tabsResult && Array.isArray(tabsResult.tabs) && tabsResult.tabs.length > 0) {
      const lines = tabsResult.tabs.map(
        (t: any) => `  - tabId=${t.tabId}  label="${t.label}"  url=${t.url}`,
      );
      rosterBlock = `\n\nTabs you CAN act on:\n${lines.join("\n")}`;
    }
    const why =
      tabId !== undefined
        ? " Tab IDs are agent-scoped — that tab may belong to another agent."
        : "";
    return {
      isError: true,
      content: [
        {
          type: "text",
          text:
            `${status ? `${status}\n` : ""}Snapshot failed: ${
              firstError.error || "target tab is not bound to this agent"
            }.${why}${rosterBlock}\n\n` +
            `Tip: pass an explicit tabId from the list above on every call when driving multiple tabs.`,
        },
      ],
    };
  }

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

  // v0.9.0+: append any buffered extension events (tab_removed,
  // tab_updated, binding_changed) so agents notice tab changes while
  // snapshotting, without a separate browser_poll_events call. This
  // drains the buffer.
  const eventLines = formatEventOneLiners(context.drainEvents());
  const eventsBlock = eventLines.length
    ? `- Recent tab events (${eventLines.length} drained):\n${eventLines.map((l) => `  ${l}`).join("\n")}\n`
    : "";

  // Null-safe header values: a missing URL/title renders as
  // "(unknown)", never a literal "undefined".
  const urlText = (typeof url === "object" ? url?.url : url) ?? "(unknown)";
  const titleText =
    (typeof title === "object" ? title?.title : title) || "(untitled)";
  const snapshotText =
    typeof snapshot === "object" ? snapshot?.snapshot : snapshot;
  return {
    content: [
      {
        type: "text",
        text: `${status ? `${status}\n` : ""}
- Page URL: ${urlText}
- Page Title: ${titleText}
${tabsBlock}${eventsBlock}
- Page Snapshot
\`\`\`yaml
${snapshotText ?? "(snapshot unavailable)"}
\`\`\`
`,
      },
    ],
  };
}
