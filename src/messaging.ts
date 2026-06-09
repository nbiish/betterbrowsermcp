/**
 * @betterbrowsermcp/mcp — WebSocket messaging
 *
 * Inlined from @repo/messaging/types and @r2r/messaging/ws/sender so the
 * project builds standalone. The protocol is request/response with
 * per-message IDs:
 *
 *   server -> extension:  { id, type, payload }   (request)
 *   extension -> server:  { id, type, payload: { requestId, result|error } }
 *                                                  (response)
 *
 * Extension -> server messages (tool results, screenshots, snapshots,
 * console logs) come back over the same socket.
 */

import { WebSocket } from "ws";

/* ------------------------------------------------------------------ *
 *  Message types
 * ------------------------------------------------------------------ */

export type MessageType<T extends Record<string, unknown>> = keyof T & string;

/**
 * Request payload sent from MCP server to browser extension.
 * Each request gets a unique id; the extension echoes it back in the
 * response so the server can correlate.
 */
export type RequestPayload = {
  url?: string;
  ref?: string;
  element?: string;
  key?: string;
  time?: number;
  text?: string;
  submit?: boolean;
  startElement?: string;
  startRef?: string;
  endElement?: string;
  endRef?: string;
  values?: string[];
  [key: string]: unknown;
};

/**
 * Response payload sent from browser extension back to MCP server.
 */
export type ResponsePayload = {
  requestId: string;
  result?: unknown;
  error?: string;
};

/**
 * Authentication handshake — sent by the extension as its first message
 * if the server is configured with BROWSER_MCP_AUTH_TOKEN. The server
 * validates and closes the connection with code 4401 if the token is
 * missing or wrong.
 */
export type AuthPayload = {
  token: string;
};

/**
 * Map of message type -> payload shape. Add new tool types here and
 * they'll be type-checked at every call site.
 */
export type SocketMessageMap = {
  // Requests server -> extension (DOM tools, v0.1.x)
  browser_navigate: RequestPayload;
  browser_go_back: RequestPayload;
  browser_go_forward: RequestPayload;
  browser_wait: RequestPayload;
  browser_press_key: RequestPayload;
  browser_snapshot: RequestPayload;
  browser_click: RequestPayload;
  browser_hover: RequestPayload;
  browser_type: RequestPayload;
  browser_select_option: RequestPayload;
  browser_screenshot: RequestPayload;
  browser_get_console_logs: RequestPayload;
  browser_drag: RequestPayload;
  getUrl: RequestPayload;
  getTitle: RequestPayload;
  // Tab management (v0.2.0+)
  browser_list_tabs: RequestPayload;
  browser_open_tab: RequestPayload;
  browser_close_tab: RequestPayload;
  browser_rename_tab: RequestPayload;
  browser_set_active_tab: RequestPayload;
  // Clipboard (v0.4.0+)
  browser_copy_to_clipboard: RequestPayload;
};

/**
 * Extract the payload type for a given message type.
 */
export type MessagePayload<
  T extends Record<string, unknown>,
  K extends keyof T,
> = K extends keyof T ? T[K] : never;

/* ------------------------------------------------------------------ *
 *  Socket message sender
 * ------------------------------------------------------------------ */

export type SendOptions = {
  timeoutMs?: number;
};

/**
 * Create a sender bound to a single WebSocket. Each call to
 * `sendSocketMessage(type, payload)` generates a unique id, sends the
 * request, and resolves with the response — or rejects on timeout,
 * socket error, or extension-reported error.
 *
 * Listens for `messageResponse` events on the WebSocket and matches
 * them to outstanding requests by id. Cleans up all listeners on
 * success, error, or close.
 */
export function createSocketMessageSender(ws: WebSocket) {
  async function sendSocketMessage<T extends MessageType<SocketMessageMap>>(
    type: T,
    payload: MessagePayload<SocketMessageMap, T>,
    options: SendOptions = { timeoutMs: 30000 },
  ): Promise<unknown> {
    const { timeoutMs } = options;
    const id = generateId();
    const message = { id, type, payload };

    return new Promise((resolve, reject) => {
      let timeoutId: NodeJS.Timeout | undefined;

      const cleanup = () => {
        ws.off("message", onMessage);
        ws.off("error", onError);
        ws.off("close", onClose);
        if (timeoutId) clearTimeout(timeoutId);
      };

      const onError = (_err: Error) => {
        cleanup();
        reject(new Error("WebSocket error occurred"));
      };

      const onClose = () => {
        cleanup();
        reject(new Error("WebSocket closed before response"));
      };

      const onMessage = (raw: import("ws").RawData) => {
        let parsed: any;
        try {
          parsed = JSON.parse(raw.toString());
        } catch {
          return; // ignore non-JSON frames
        }
        if (parsed?.type !== "messageResponse") return;
        const responsePayload = parsed.payload;
        if (!responsePayload || responsePayload.requestId !== id) return;
        cleanup();
        if (responsePayload.error) {
          reject(new Error(responsePayload.error));
        } else {
          resolve(responsePayload.result);
        }
      };

      if (timeoutMs) {
        timeoutId = setTimeout(() => {
          cleanup();
          reject(new Error(`WebSocket response timeout after ${timeoutMs}ms`));
        }, timeoutMs);
      }

      ws.on("message", onMessage);
      ws.once("error", onError);
      ws.once("close", onClose);

      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(message));
      } else {
        cleanup();
        reject(new Error("WebSocket is not open"));
      }
    });
  }

  return { sendSocketMessage };
}

function generateId(): string {
  return (
    Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 10)
  );
}
