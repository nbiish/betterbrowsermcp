/**
 * @betterbrowsermcp/mcp — extension push-event buffer (v0.9.0)
 *
 * The extension can push unsolicited `{type: "event"}` frames over the
 * agent WebSocket (tab_removed, tab_updated, binding_changed). The
 * server does not proactively notify MCP clients, so these frames are
 * buffered per agent into a bounded ring buffer (cap 200, server-side
 * memory only).
 *
 * Drain semantics: `browser_poll_events` returns AND clears the
 * buffer. `browser_list_tabs` and `browser_snapshot` also append the
 * currently buffered events as compact one-liners (and clear them) so
 * agents notice tab changes without explicit polling.
 *
 * Unknown event names are stored verbatim — never choke on new types.
 */

export const EVENT_BUFFER_CAP = 200;

export type BrowserEvent = {
  /** Event name from the extension, e.g. "tab_removed". */
  event: string;
  /** Event payload (tabId, agentId?, url?, title? per the WS contract). */
  payload: Record<string, unknown>;
  /** ISO-8601 UTC timestamp captured on receipt. */
  receivedAt: string;
};

export class EventBuffer {
  private items: BrowserEvent[] = [];

  /** Append an event, evicting the oldest when over capacity. */
  push(event: BrowserEvent): void {
    if (this.items.length >= EVENT_BUFFER_CAP) {
      this.items.shift();
    }
    this.items.push(event);
  }

  /** Return all buffered events and clear the buffer. */
  drain(): BrowserEvent[] {
    const out = this.items;
    this.items = [];
    return out;
  }

  /** Number of buffered events (diagnostics). */
  get size(): number {
    return this.items.length;
  }
}

/**
 * Format buffered events as compact one-liners for embedding in tool
 * output. Never throws — event payloads are untrusted extension data.
 */
export function formatEventOneLiners(events: BrowserEvent[]): string[] {
  return events.map((e) => {
    const parts: string[] = [];
    const p = e.payload ?? {};
    if (p.tabId !== undefined) parts.push(`tabId=${String(p.tabId)}`);
    if (p.agentId !== undefined) parts.push(`agent=${String(p.agentId)}`);
    if (p.url !== undefined) parts.push(`url=${String(p.url)}`);
    if (p.title !== undefined) parts.push(`title=${String(p.title)}`);
    return `- ${e.receivedAt} ${e.event}${parts.length ? ` ${parts.join(" ")}` : ""}`;
  });
}
