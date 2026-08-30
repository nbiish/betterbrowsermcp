#!/usr/bin/env node
/**
 * bbmcp-connect — zero-wiring onboarding for agent harnesses.
 *
 *   node scripts/bbmcp-connect.mjs --agent my-agent [--port 9223]
 *        [--bind localhost] [--no-start] [--token <env var NAME, not value>]
 *
 * Does:
 *   1. Health-checks the hub (GET /). If down and not --no-start, spawns
 *      `BROWSER_MCP_HUB=true BROWSER_MCP_PORT=<port> node dist/index.js`
 *      detached (log: /tmp/bbmcp-hub-<port>.log) and waits for health.
 *   2. Verifies YOUR MCP endpoint responds to `initialize`.
 *   3. Prints ready-to-paste MCP config for Warp / Claude Code / generic,
 *      plus the single user step (popup → Add agent) required for tab
 *      consent.
 *
 * Never prints or accepts secret values; --token takes an ENV VAR NAME and
 * only references it in emitted config.
 */
import { spawn } from "node:child_process";
import { existsSync, openSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--")
    ? process.argv[i + 1]
    : fallback;
}
const flag = (name) => process.argv.includes(`--${name}`);

const agent = arg("agent");
const port = parseInt(arg("port", "9223"), 10);
const bind = arg("bind", "localhost");
const noStart = flag("no-start");
const tokenEnvName = arg("token", null);

if (!agent || !/^[a-z0-9][a-z0-9-]*$/i.test(agent)) {
  console.error("usage: bbmcp-connect.mjs --agent <kebab-case-id> [--port 9223] [--bind localhost] [--no-start]");
  process.exit(2);
}

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const distIndex = join(repoRoot, "dist", "index.js");

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

const base = `http://${bind}:${port}`;
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
      params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "bbmcp-connect", version: "0.9.0" } },
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
2) ONE user step (consent gate — tabs are opt-in):
     Chrome → Better Browser MCP icon → "Add agent"
       id:   ${agent}
       port: ${port}
     → the agent card must show: connected

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
