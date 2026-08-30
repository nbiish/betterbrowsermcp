/**
 * @betterbrowsermcp/mcp — agent registry (v0.9.0 hub mode)
 *
 * Hub mode (BROWSER_MCP_HUB=true) lets ONE process serve MULTIPLE
 * agents. The registry maps agentId → per-agent Context and lazily
 * creates Contexts on first connection:
 *
 *   - WS: any `/ws/<agentId>` path gets (or creates) its Context here.
 *   - HTTP MCP: `/mcp/<agentId>` dispatches tool calls against the
 *     same Context from this registry.
 *
 * Single-agent mode never touches the registry's multi-agent surface —
 * its Context lives directly in the WS server, byte-compatible with
 * v0.8.x behavior.
 */

import { Context } from "@/context";

export type AgentStatus = {
  agentId: string;
  connected: boolean;
  /**
   * Number of tabs bound in the extension for this agent, when the
   * extension answered a list_tabs probe; null when disconnected or
   * the probe timed out.
   */
  boundTabs: number | null;
};

export class AgentRegistry {
  private agents = new Map<string, Context>();

  /** Get an existing Context or lazily create one. */
  getOrCreate(agentId: string): Context {
    let ctx = this.agents.get(agentId);
    if (!ctx) {
      ctx = new Context(agentId);
      this.agents.set(agentId, ctx);
    }
    return ctx;
  }

  /**
   * Register an externally-created Context (single-agent mode uses this
   * so /mcp and the WS server share the exact same Context instance).
   */
  register(agentId: string, ctx: Context): void {
    this.agents.set(agentId, ctx);
  }

  get(agentId: string): Context | undefined {
    return this.agents.get(agentId);
  }

  has(agentId: string): boolean {
    return this.agents.has(agentId);
  }

  /** All known agent IDs (insertion order). */
  ids(): string[] {
    return [...this.agents.keys()];
  }

  /** Remove a Context entirely (unused; kept for completeness). */
  delete(agentId: string): void {
    this.agents.delete(agentId);
  }
}

/** Process-wide registry used in hub mode. */
export const agentRegistry = new AgentRegistry();
