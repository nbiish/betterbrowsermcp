/**
 * @betterbrowsermcp/mcp — per-process WebSocket context
 *
 * Each MCP process represents ONE agent. The Context holds the
 * live WebSocket connection to the browser tab bound to that
 * agent. The browser extension binds tabs to this process by
 * connecting to `ws://<bind>:<port>/ws/<agentId>`.
 *
 * Auth: when BROWSER_MCP_AUTH_TOKEN is set, the extension must
 * send `{type: "auth", token: "..."}` as its first message after
 * the WebSocket opens. Connections without a valid token are closed
 * with code 4401.
 */

import { WebSocket } from "ws";

import { mcpConfig } from "@/config";
import {
  createSocketMessageSender,
  type MessagePayload,
  type MessageType,
  type SocketMessageMap,
} from "@/messaging";

export class Context {
  /** The WebSocket bound to this context (one per process). */
  private _ws: WebSocket | undefined;
  /** Agent ID this process serves (from BROWSER_MCP_AGENT_ID). */
  public readonly agentId: string;
  /** Auth state — true once the extension sends a valid token. */
  private _authenticated: boolean;

  constructor(agentId: string) {
    this.agentId = agentId;
    // If no auth token is configured, treat all connections as
    // pre-authenticated. Otherwise wait for the handshake.
    this._authenticated = mcpConfig.authToken === "";
  }

  get ws(): WebSocket {
    if (!this._ws || this._ws.readyState !== this._ws.OPEN) {
      throw new Error(mcpConfig.errors.noConnectedExtension);
    }
    return this._ws;
  }

  set ws(ws: WebSocket) {
    this._ws = ws;
  }

  /**
   * Check if the given WebSocket is the one currently bound to this
   * context. Used by the WS server's close handler.
   */
  hasWsRef(ws: WebSocket): boolean {
    return this._ws === ws;
  }

  /**
   * Clear the WebSocket reference. Bypasses the throwing getter so
   * the close handler can call this safely even when the socket is
   * already gone.
   */
  clearWs(): void {
    this._ws = undefined;
  }

  hasWs(): boolean {
    return (
      !!this._ws &&
      this._ws.readyState === this._ws.OPEN &&
      this._authenticated
    );
  }

  isAuthenticated(): boolean {
    return this._authenticated;
  }

  markAuthenticated(): void {
    this._authenticated = true;
  }

  /**
   * Validate an incoming auth message. Returns true if the message is
   * a valid auth handshake for this server's configured token.
   *
   * When no token is configured, every auth message is treated as
   * valid (no-op).
   */
  validateAuth(msg: any): boolean {
    if (mcpConfig.authToken === "") return true;
    if (msg?.type !== "auth" || typeof msg.token !== "string") return false;
    return msg.token === mcpConfig.authToken;
  }

  /**
   * Send a typed request to the extension and await the response.
   * Throws if the WebSocket is not connected or the request times out.
   */
  async sendSocketMessage<T extends MessageType<SocketMessageMap>>(
    type: T,
    payload: MessagePayload<SocketMessageMap, T>,
    options: { timeoutMs?: number } = { timeoutMs: 30000 },
  ): Promise<unknown> {
    if (!this.hasWs()) {
      throw new Error(mcpConfig.errors.noConnectedExtension);
    }
    const { sendSocketMessage } = createSocketMessageSender(this.ws);
    try {
      return await sendSocketMessage(type, payload, options);
    } catch (e) {
      if (
        e instanceof Error &&
        e.message === mcpConfig.errors.noConnectedTab
      ) {
        throw new Error(mcpConfig.errors.noConnectedExtension);
      }
      throw e;
    }
  }

  /**
   * Close the WebSocket for this context. Idempotent.
   */
  async close(): Promise<void> {
    if (this._ws) {
      try {
        this._ws.close(1000, "context closed");
      } catch {
        // ignore
      }
      this._ws = undefined;
    }
  }
}
