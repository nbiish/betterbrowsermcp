#!/usr/bin/env node
/**
 * bbmcp-connect — zero-wiring, zero-user-input onboarding for agents.
 *
 *   node scripts/bbmcp-connect.mjs [--agent my-agent] [--port 9223]
 *        [--bind localhost] [--no-start] [--token <env var NAME, not value>]
 *
 * Every argument is optional:
 *   --agent  defaults to $BBMCP_AGENT_ID or a generated "agent-xxxx".
 *   --port   defaults to auto-discovery: reuse a hub already listening
 *            anywhere in 9223-9237, else start one on the first free
 *            port in that range.
 *
 * Does:
 *   1. Discovers an existing hub (health-signature probe across the
 *      port range) or starts one detached on a free port
 *      (log: /tmp/bbmcp-hub-<port>.log) and waits for health.
 *   2. Verifies YOUR MCP endpoint responds to `initialize` — this
 *      registers the agent on the hub, which the browser extension
 *      auto-attaches to within ~30s. No popup step, no ports for the
 *      user to type, nothing to configure.
 *   3. Prints ready-to-paste MCP config for Warp / Claude Code /
 *      generic streamable-HTTP clients.
 *
 * Never prints or accepts secret values; --token takes an ENV VAR NAME
 * and only references it in emitted config.
 */
import { spawn } from "node:child_process";
import { existsSync, openSync } from "node:fs";
import net from "node:net";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--")
    ? process.argv[i + 1]
    : fallback;
}
const flag = (name) => process.argv.includes(`--${name}`);

const agent =
  arg("agent") || process.env.BBMCP_AGENT_ID || `agent-${Math.random().toString(36).slice(2, 6)}`;
const explicitPort = arg("port", null);
const bind = arg("bind", "localhost");
const noStart = flag("no-start");
const tokenEnvName = arg("token", null);

if (!/^[a-z0-9][a-z0-9-]*$/i.test(agent)) {
  console.error(`invalid agent id "${agent}" — use kebab-case (letters, digits, dashes)`);
  process.exit(2);
}

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const distIndex = join(repoRoot, "dist", "index.js");

const PORT_MIN = 9223;
const PORT_MAX = 9237;
const PROBE_TIMEOUT_MS = 800;

async function healthy() {
  try {
    const res = await fetch(`${base}/`);
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function log(msg) { console.log(`[bbmcp-connect] ${msg}`); }

/** True iff something answering the bbmcp health signature listens on port. */
async function probeHub(port) {
  try {
    const res = await fetch(`http://localhost:${port}/`, {
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    if (!res.ok) return false;
    const j = await res.json().catch(() => null);
    return Boolean(j && (j.mode === "hub" || /better browser mcp/i.test(String(j.name || ""))));
  } catch {
    return false;
  }
}

/** True iff port is bindable right now. */
function portFree(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once("error", () => resolve(false));
    srv.once("listening", () => srv.close(() => resolve(true)));
    srv.listen(port, "*********");
  });
}

/**
 * Port resolution order:
 *   1. explicit --port (power users pin it; hard-fails on collision)
 *   2. an existing hub anywhere in the range (REUSE, never fight it)
 *   3. the first free port in the range (fresh hub goes here)
 */
async function resolvePort() {
  if (explicitPort) return parseInt(explicitPort, 10);
  for (let p = PORT_MIN; p <= PORT_MAX; p++) {
    if (await probeHub(p)) {
      log(`found existing hub on port ${p} — reusing it`);
      return p;
    }
  }
  for (let p = PORT_MIN; p <= PORT_MAX; p++) {
    if (await portFree(p)) {
      log(`no hub found — will start one on free port ${p}`);
      return p;
    }
  }
  console.error(`No free port in ${PORT_MIN}-${PORT_MAX} and no hub to reuse. Free one or pass --port.`);
  process.exit(1);
}

const port = await resolvePort();
const base = `http://localhost:${port}`;
const mcpUrl = `${base}/mcp/${agent}`;
log(`bbmcp-connect: agent=${agent} port=${port}`);

async function ensureServer() {
  let health = await healthy();
  if (health) return { health, started: false };
  if (noStart) {
    console.error(`No server at ${base} and --no-start given. Start it manually:`);
    console.error(`  BROWSER_MCP_HUB=true BROWSER_MCP_PORT=${port} node ${distIndex}`);
    process.exit(1);
  }
  if (!existsSync(distIndex)) {
    console.error(`No server at ${base} and no build to start one from.`);
    console.error(`Missing: ${distIndex}`);
    console.error(`Fix:  cd ${repoRoot} && npm install && npm run build`);
    console.error(`Then re-run this script, or start the hub manually:`);
    console.error(`  BROWSER_MCP_HUB=true BROWSER_MCP_PORT=${port} node ${distIndex}`);
    process.exit(1);
  }
  const logPath = `/tmp/bbmcp-hub-${port}.log`;
  const logFd = openSync(logPath, "a");
  const child = spawn(process.execPath, [distIndex], {
    env: { ...process.env, BROWSER_MCP_HUB: "true", BROWSER_MCP_PORT: String(port), BROWSER_MCP_BIND: bind },
    detached: true,
    stdio: ["ignore", logFd, logFd],
  });
  child.unref();
  for (let i = 0; i < 40; i++) {
    await sleep(250);
    health = await healthy();
    if (health) return { health, started: true };
  }
  console.error(`Hub did not become healthy at ${base}. Check /tmp/bbmcp-hub-${port}.log`);
  process.exit(1);
}

async function verifyMcp() {
  const headers = {
    "Content-Type": "application/json",
    "Accept": "application/json, text/event-stream",
  };
  const res = await fetch(mcpUrl, {
    method: "POST",
    headers,
    body: JSON.stringify({
      jsonrpc: "2.0", id: 1, method: "initialize",
      params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "bbmcp-connect", version: "0.9.1" } },
    }),
  });
  if (!res.ok) throw new Error(`initialize failed: HTTP ${res.status} ${await res.text()}`);
  const sid = res.headers.get("mcp-session-id");
  return { sessionHeader: sid ? "yes" : "no" };
}

const { health, started } = await ensureServer();
if (started) log(`hub started (pid file: none — managed by your OS; health: ${base}/)`);
log(`hub healthy: mode=${health.mode} agents=${health.agents.length}`);

const { sessionHeader } = await verifyMcp();
log(`MCP endpoint verified: ${mcpUrl} (session header: ${sessionHeader})`);

const tokenField = tokenEnvName ? `,\n        "headers": { "Authorization": "Bearer \${${tokenEnvName}}" }` : "";
const serverJson = `{\n    "bbmcp": {\n      "url": "${mcpUrl}"${tokenField}\n    }\n  }`;

console.log(`
===========================================================
 bbmcp ready for agent "${agent}"
===========================================================

1) MCP endpoint : ${mcpUrl}

2) Extension    : NOTHING TO DO. The extension auto-discovers the
   hub and attaches to every registered agent (within ~30s; your
   initialize above just registered you). If the card has not gone
   green, reload the extension once — the manual fallback is:
   Chrome → Better Browser MCP icon → Add agent → id: ${agent}, port: ${port}

3) Wire your harness (paste):

   Warp (Settings → Agents → MCP servers, agent config file, or --mcp):
     ${serverJson.replace(/\n/g, "\n   ")}

   Claude Code:
     claude mcp add --transport http bbmcp ${mcpUrl}

   Generic streamable-HTTP client:
     POST ${mcpUrl}
     Headers: Content-Type: application/json
              Accept: application/json, text/event-stream${tokenEnvName ? `\n              Authorization: Bearer \${${tokenEnvName}}` : ""}
     Body:    {"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"<harness>","version":"0.0.1"}}}
     Then:    notifications/initialized → tools/list → tools/call

4) First tools to run: browser_open_tab → browser_list_tabs
   You only ever see tabs bound to you. The user binds their own tabs
   via "Bind to ${agent}" — that is explicit consent.

Skill/playbook: .agents/skills/bbmcp/SKILL.md
`);
