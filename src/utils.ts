/**
 * @betterbrowsermcp/mcp — utility helpers
 *
 * Inlined from @repo/utils so the project builds standalone.
 * Includes a non-murderous port-check helper (does NOT kill processes
 * on the port — the original `killProcessOnPort` was the cause of
 * the port-9009 fighting between multiple MCP clients).
 */

import net from "node:net";

/**
 * Sleep for `ms` milliseconds.
 */
export function wait(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(() => resolve(), ms);
  });
}

/**
 * Returns true if a process is already listening on `port` at `host`.
 * Does NOT kill anything — callers should treat a true result as a
 * hard error and decide whether to use a different port.
 *
 * We probe by trying to bind a temporary server. If the bind succeeds,
 * the port was free. If it fails with EADDRINUSE, something else owns
 * the port and we return true.
 */
export async function isPortInUse(
  port: number,
  host: string = "127.0.0.1",
): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => {
      // EADDRINUSE — port is taken
      resolve(true);
    });
    server.once("listening", () => {
      server.close(() => resolve(false));
    });
    server.listen(port, host);
  });
}

/**
 * Format a port-in-use error with a hint about which agent probably owns
 * the port, when known. Helps debugging multi-agent setups.
 */
export function portInUseError(port: number, host: string = "127.0.0.1"): Error {
  return new Error(
    `Port ${port} on ${host} is already in use. ` +
      `If another agent is already running, this is expected — check ` +
      `BROWSER_MCP_PORT. Otherwise, an orphan process is squatting on ` +
      `the port; run \`lsof -ti:${port} | xargs ps -p\` to investigate. ` +
      `(betterbrowsermcp v0.2.0+ refuses to silently kill other processes.)`,
  );
}
