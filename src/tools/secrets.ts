/**
 * @betterbrowsermcp/mcp — PQC secrets tools (v0.7.0+)
 *
 * These tools wrap the `pqc-secrets` CLI (FIPS 203 ML-KEM-768 +
 * AES-256-GCM) so the LLM can:
 *
 *   - list / read / add secrets in the PQC bundle at
 *     ~/.config/pqc-secrets/secrets.bundle.json
 *   - pipe a secret value into a form field via the existing
 *     browser_paste_text transport
 *   - capture a value from the page (via browser_copy_to_clipboard)
 *     and add it to the bundle
 *   - explicitly "unlock" a secret for the current tab's session so
 *     subsequent paste_text calls can use the in-memory value
 *     without going through a form-fill ceremony
 *
 * The bundle is AES-256-GCM encrypted at rest with an ML-KEM-768
 * wrapped data key. The ML-KEM-768 private key lives in the OS
 * keystore (macOS Keychain: service=pqc-secrets, account=
 * pqc-secrets-key). Decrypted values are NEVER written to disk
 * by this tool surface — they only live in process memory and the
 * MCP tool response.
 *
 * Tool list:
 *   - browser_secrets_status           report bundle health
 *   - browser_secrets_list             list secret names (no values)
 *   - browser_secrets_get(name)        return one secret's value
 *   - browser_secrets_load             load all secrets into the
 *                                     current tab's window scope
 *                                     via a synthetic JS env
 *                                     (window.__bbmcpSecrets__)
 *   - browser_secrets_add(name, value) add or update a secret
 *   - browser_secrets_add_from_clipboard(name) add using whatever
 *                                     is in the system clipboard
 *   - browser_secrets_unlock_agent(name) mark a secret "unlocked"
 *                                     for this tab's session
 *   - browser_secrets_lock_agent       clear all unlocked secrets
 *                                     for this tab
 *   - browser_secrets_copy_to_page(name, ref) atomic: get the value
 *                                     from the bundle, paste it
 *                                     into the focused (or ref'd)
 *                                     form field on the page
 *
 * Security notes:
 *   - Decrypted values flow through the MCP tool response, which
 *     Hermes routes to the LLM via the conversation. The values
 *     are transient: not persisted, not logged. (Hermes's
 *     mcp-stderr.log only logs tool NAMES, never payloads.)
 *   - The "unlock" path keeps the value in the MCP server's
 *     process memory and the page's window scope, not the OS
 *     clipboard. This avoids the clipboard-leak path that other
 *     automation tools suffer from.
 *   - The `browser_secrets_load` tool exposes values to page JS via
 *     window.__bbmcpSecrets__ (read-only by default). It does NOT
 *     trigger any paste event; pages that want to use a value must
 *     read it from window.__bbmcpSecrets__ explicitly.
 *   - The `PQC_KEYCHAIN_ACCOUNT` env var override matches the
 *     Python `pqc-secrets` skill convention. See pqc-secrets
 *     commit 7b6eac6 for context.
 */

import { execFile } from "node:child_process";
import { copyFile, readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { logAuditEvent, valueFingerprint } from "../audit";

import { zodToJsonSchema } from "zod-to-json-schema";

import {
  SecretsAddFromClipboardTool,
  SecretsAddTool,
  SecretsCopyToPageTool,
  SecretsGetTool,
  SecretsListTool,
  SecretsRotateTool,
  SecretsLoadTool,
  SecretsLockAgentTool,
  SecretsStatusTool,
  SecretsUnlockAgentTool,
} from "@/types";

import type { Tool } from "./tool";

const execFileP = promisify(execFile);

/* ------------------------------------------------------------------ *
 *  Configuration
 * ------------------------------------------------------------------ */

/**
 * Path to the pqc-secrets binary. Defaults to the user's standard
 * install location, but can be overridden via the
 * BROWSER_MCP_PQC_SECRETS_BIN env var (useful for sandboxing or
 * for testing against a mock).
 */
const PQC_SECRETS_BIN =
  process.env.BROWSER_MCP_PQC_SECRETS_BIN ||
  join(homedir(), "code", "ainish-coder", "bin", "pqc-secrets");

const PQC_BUNDLE_PATH = join(
  homedir(),
  ".config",
  "pqc-secrets",
  "secrets.bundle.json",
);

const PQC_PUBKEY_PATH = join(
  homedir(),
  ".config",
  "pqc-secrets",
  "recipient.pub",
);

/**
 * In-memory store of "unlocked" secrets per tabId. The agent can
 * `unlock` a secret so subsequent paste_text calls can use the
 * value directly (e.g., to fill a form field in a single tool
 * call) without exposing the value in an intermediate tool response.
 *
 * This is purely a server-side, process-memory cache. It is
 * cleared on `lock` and on server restart.
 */
const unlockedSecretsByTab = new Map<string, Record<string, string>>();

function getUnlocked(tabId: string | number | undefined): Record<string, string> {
  const k = tabId === undefined ? "__default__" : String(tabId);
  if (!unlockedSecretsByTab.has(k)) unlockedSecretsByTab.set(k, {});
  return unlockedSecretsByTab.get(k)!;
}

function clearUnlocked(tabId: string | number | undefined): void {
  const k = tabId === undefined ? "__default__" : String(tabId);
  unlockedSecretsByTab.delete(k);
}

/* ------------------------------------------------------------------ *
 *  Internal helpers
 * ------------------------------------------------------------------ */

interface PqcSecretsExecError extends Error {
  stderr: string;
  code: number | null;
}

async function pqc(args: string[]): Promise<{ stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await execFileP(PQC_SECRETS_BIN, args, {
      timeout: 15_000,
      maxBuffer: 4 * 1024 * 1024,
      env: {
        // Inherit the user's environment (so macOS Keychain access
        // prompts can be authorized against the user's identity)
        // but also pass the PQC env override the v0.6.1 binary supports.
        ...process.env,
        PQC_KEYCHAIN_ACCOUNT:
          process.env.PQC_KEYCHAIN_ACCOUNT || "pqc-secrets-key",
      },
    });
    return { stdout: stdout.toString(), stderr: stderr.toString() };
  } catch (e: unknown) {
    const ee = e as { stderr?: string; message?: string; code?: number };
    const err: PqcSecretsExecError = Object.assign(
      new Error(
        `pqc-secrets ${args.join(" ")} failed: ${ee?.stderr || ee?.message || String(ee)}`,
      ),
      { stderr: ee?.stderr || "", code: ee?.code ?? null },
    );
    throw err;
  }
}

interface ParsedSecret {
  name: string;
  value: string;
}

/**
 * Parse the output of `pqc-secrets export` into a list of
 * name/value pairs. The output format is one `export NAME="value"`
 * line per secret, with shell-quoted values.
 */
function parseExport(output: string): ParsedSecret[] {
  const out: ParsedSecret[] = [];
  for (const rawLine of output.split("\n")) {
    const line = rawLine.trim();
    if (!line.startsWith("export ")) continue;
    const rest = line.slice("export ".length);
    const eq = rest.indexOf("=");
    if (eq <= 0) continue;
    const name = rest.slice(0, eq).trim();
    let value = rest.slice(eq + 1).trim();
    // Strip surrounding single or double quotes if present
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out.push({ name, value });
  }
  return out;
}

/* ------------------------------------------------------------------ *
 *  browser_secrets_status — report bundle health
 * ------------------------------------------------------------------ */

export const secretsStatus: Tool = {
  schema: {
    name: SecretsStatusTool.shape.name.value,
    description: SecretsStatusTool.shape.description.value,
    inputSchema: zodToJsonSchema(SecretsStatusTool.shape.arguments),
  },
  handle: async () => {
    const status: Record<string, unknown> = {
      pqcSecretsBin: PQC_SECRETS_BIN,
      binExists: existsSync(PQC_SECRETS_BIN),
      bundlePath: PQC_BUNDLE_PATH,
      bundleExists: existsSync(PQC_BUNDLE_PATH),
      pubkeyPath: PQC_PUBKEY_PATH,
      pubkeyExists: existsSync(PQC_PUBKEY_PATH),
    };

    if (status.bundleExists) {
      try {
        const st = statSync(PQC_BUNDLE_PATH);
        status.bundleSize = st.size;
        status.bundleMtime = st.mtime.toISOString();
      } catch {
        // ignore
      }
    }

    if (status.binExists && status.bundleExists) {
      try {
        const { stdout } = await pqc(["export"]);
        const parsed = parseExport(stdout);
        status.keychainReachable = true;
        status.secretCount = parsed.length;
        status.secretNames = parsed.map((p) => p.name);
      } catch (e: any) {
        status.keychainReachable = false;
        status.keychainError = e?.stderr || e?.message || String(e);
      }
    }

    const ok =
      status.binExists && status.bundleExists && status.keychainReachable;

    return {
      content: [
        {
          type: "text",
          text:
            `PQC secrets bundle status\n` +
            `  binary:        ${status.pqcSecretsBin} (${status.binExists ? "present" : "MISSING"})\n` +
            `  bundle:        ${status.bundlePath} (${status.bundleExists ? `${status.bundleSize}B, mtime ${status.bundleMtime}` : "MISSING"})\n` +
            `  pubkey:        ${status.pubkeyPath} (${status.pubkeyExists ? "present" : "MISSING"})\n` +
            `  keychain:      ${status.keychainReachable ? "reachable" : `UNREACHABLE — ${status.keychainError ?? "unknown error"}`}\n` +
            `  secret count:  ${status.secretCount ?? 0}\n` +
            (status.secretNames && (status.secretNames as string[]).length > 0
              ? `  secret names:  ${(status.secretNames as string[]).join(", ")}\n`
              : "") +
            `\n  RESULT: ${ok ? "READY" : "NOT READY — see keychain error above"}`,
        },
      ],
      isError: !ok,
    };
  },
};

/* ------------------------------------------------------------------ *
 *  browser_secrets_list — list secret names (no values)
 * ------------------------------------------------------------------ */

export const secretsList: Tool = {
  schema: {
    name: SecretsListTool.shape.name.value,
    description: SecretsListTool.shape.description.value,
    inputSchema: zodToJsonSchema(SecretsListTool.shape.arguments),
  },
  handle: async () => {
    try {
      const { stdout } = await pqc(["export"]);
      const parsed = parseExport(stdout);
      const names = parsed.map((p) => p.name);
      return {
        content: [
          {
            type: "text",
            text:
              `Found ${names.length} secret(s) in the PQC bundle:\n` +
              names.map((n) => `  - ${n}`).join("\n") +
              (names.length === 0 ? "  (bundle is empty)" : "") +
              `\n\nUse \`browser_secrets_get\` with a name to retrieve a value (returns plain text — handle with care).`,
          },
        ],
      };
    } catch (e: any) {
      return {
        content: [
          {
            type: "text",
            text:
              `Failed to list secrets: ${e?.stderr || e?.message || String(e)}\n\n` +
              `Common causes:\n` +
              `- macOS Keychain is blocking the pqc-secrets binary. Approve the prompt\n` +
              `  (click "Always Allow" so it doesn't repeat).\n` +
              `- The bundle is in an inconsistent state. Run \`pqc-secrets status\`\n` +
              `  from a terminal for more detail.`,
          },
        ],
        isError: true,
      };
    }
  },
};

/* ------------------------------------------------------------------ *
 *  browser_secrets_get — return one secret's value
 * ------------------------------------------------------------------ */

export const secretsGet: Tool = {
  schema: {
    name: SecretsGetTool.shape.name.value,
    description: SecretsGetTool.shape.description.value,
    inputSchema: zodToJsonSchema(SecretsGetTool.shape.arguments),
  },
  handle: async (_context, params) => {
    const { name, mode } = SecretsGetTool.shape.arguments.parse(params);
    try {
      const { stdout } = await pqc(["export"]);
      const parsed = parseExport(stdout);
      const match = parsed.find((p) => p.name === name);
      if (!match) {
        const available = parsed.map((p) => p.name).join(", ");
        return {
          content: [
            {
              type: "text",
              text:
                `Secret "${name}" not found in the PQC bundle.\n` +
                `Available: ${available || "(bundle is empty)"}\n\n` +
                `If you're unsure of the name, run \`browser_secrets_list\` first.`,
            },
          ],
          isError: true,
        };
      }
      // Default mode: 'plain' — return the raw value.
      // The value is returned as plain text in the tool response. It
      // will flow through the LLM conversation, which is acceptable
      // because the conversation itself is the operator's private
      // channel (PQC-encrypted Hermes transport). The value is never
      // written to disk by this tool surface.
      //
      // mode: 'redact' — return a length-only summary for LLM
      // summary work. Useful when the LLM wants to confirm a secret
      // exists without echoing the value into the conversation
      // history. The audit log records every read regardless of mode.
      if (mode === "redact") {
        // Audit: even a redact-mode read is recorded.
        logAuditEvent({ action: "get", mode: "redact", name });
        return {
          content: [
            {
              type: "text",
              text:
                `<redacted: ${name} length=${match.value.length}>\n\n` +
                `(Redacted mode: value is not returned. Use mode='plain' to retrieve the actual value.)`,
            },
          ],
        };
      }
      // Audit: log the get event with the value's fingerprint, never
      // the value itself. This lets the user verify "yes, the same
      // value is in the bundle" without exposing the value to anyone
      // reading the log.
      logAuditEvent({
        action: "get",
        mode: "plain",
        name,
        detail: `value-fp=${valueFingerprint(match.value)}`,
      });
      return {
        content: [
          {
            type: "text",
            text:
              `${name} = ${match.value}\n\n` +
              `(Returned as plain text. Do not echo this value to logs or commit it. ` +
              `For ongoing use across many tool calls in this session, prefer ` +
              `\`browser_secrets_unlock_agent\` so the value lives in the server's ` +
              `process memory rather than the conversation history.)`,
          },
        ],
      };
    } catch (e: any) {
      return {
        content: [
          {
            type: "text",
            text: `Failed to read secret "${name}": ${e?.stderr || e?.message || String(e)}`,
          },
        ],
        isError: true,
      };
    }
  },
};

/* ------------------------------------------------------------------ *
 *  browser_secrets_load — load all secrets into the page's window scope
 * ------------------------------------------------------------------ */

export const secretsLoad: Tool = {
  schema: {
    name: SecretsLoadTool.shape.name.value,
    description: SecretsLoadTool.shape.description.value,
    inputSchema: zodToJsonSchema(SecretsLoadTool.shape.arguments),
  },
  handle: async (context, params) => {
    const { names, tabId } = SecretsLoadTool.shape.arguments.parse(params);
    try {
      const { stdout } = await pqc(["export"]);
      const parsed = parseExport(stdout);
      const wanted = names && names.length > 0
        ? parsed.filter((p) => names.includes(p.name))
        : parsed;

      const map: Record<string, string> = {};
      for (const p of wanted) map[p.name] = p.value;

      // Inject the values into the page's window scope via the
      // extension's WebSocket transport. The content script sets
      // `window.__bbmcpSecrets__` (read-only) and fires a custom
      // event the page can listen for.
      await context.sendSocketMessage("browser_secrets_load", {
        secrets: map,
        tabId,
      });

      const summary = wanted.map((p) => p.name).join(", ") || "(none)";
      return {
        content: [
          {
            type: "text",
            text:
              `Loaded ${wanted.length} secret(s) into the page's window scope: ${summary}\n\n` +
              `The page can now read these via \`window.__bbmcpSecrets__\` (a frozen object).\n` +
              `For long-lived sessions, prefer \`browser_secrets_unlock_agent\` so the values\n` +
              `persist across navigations.`,
          },
        ],
      };
    } catch (e: any) {
      return {
        content: [
          {
            type: "text",
            text: `Failed to load secrets: ${e?.stderr || e?.message || String(e)}`,
          },
        ],
        isError: true,
      };
    }
  },
};

/* ------------------------------------------------------------------ *
 *  browser_secrets_add — add or update a secret
 * ------------------------------------------------------------------ */

export const secretsAdd: Tool = {
  schema: {
    name: SecretsAddTool.shape.name.value,
    description: SecretsAddTool.shape.description.value,
    inputSchema: zodToJsonSchema(SecretsAddTool.shape.arguments),
  },
  handle: async (_context, params) => {
    const { name, value, merge, dry_run } = SecretsAddTool.shape.arguments.parse(params);
    try {
      // Read existing secrets first (unless we want to replace the
      // entire bundle, in which case `merge: false`).
      const existing: ParsedSecret[] = merge
        ? parseExport((await pqc(["export"])).stdout)
        : [];

      // Build the new secrets map, with `name` overwriting any
      // existing entry of the same name.
      const map: Record<string, string> = {};
      for (const e of existing) map[e.name] = e.value;
      const wasExisting = name in map;
      const previousValue = map[name];
      map[name] = value;

      // dry_run: compute diff and return without writing. This is
      // safe-by-default — no real change to the bundle.
      if (dry_run) {
        const added = merge && !wasExisting ? 1 : 0;
        const modified = merge && wasExisting && previousValue !== value ? 1 : 0;
        const unchanged = merge && wasExisting && previousValue === value ? 1 : 0;
        const preview = merge
          ? (wasExisting
              ? `Modified existing "${name}" (length ${previousValue!.length} -> ${value.length})`
              : `Added new "${name}" (length ${value.length})`)
          : `Would REPLACE entire bundle with just "${name}" (${Object.keys(map).length} existing secrets would be wiped)`;
        return {
          content: [
            {
              type: "text",
              text:
                `DRY RUN — no changes written.\n` +
                `Action: ${preview}\n` +
                `Diff: +${added} added, ~${modified} modified, =${unchanged} unchanged\n` +
                `Resulting bundle would have ${Object.keys(map).length} secret(s).\n\n` +
                `Re-run with dry_run=false (or omit it) to actually write.`,
            },
          ],
        };
      }

      // Build the stdin payload for `pack` — KEY=VALUE lines,
      // one per secret, separated by newlines. pack will AES-256-GCM
      // encrypt the payload with a fresh data key + KEM shared
      // secret, then atomic-rename over the bundle file.
      const stdinPayload = Object.entries(map)
        .map(([k, v]) => `${k}=${v}`)
        .join("\n");

      // Pack with a fresh data key + KEM shared secret.
      // pack always generates fresh randomness, so the bundle
      // is effectively re-keyed. The recipient pubkey (and its
      // private key in the keychain) is unchanged.
      const { spawn } = await import("node:child_process");
      await new Promise<void>((resolve, reject) => {
        const child = spawn(PQC_SECRETS_BIN, ["pack"], {
          env: {
            ...process.env,
            PQC_KEYCHAIN_ACCOUNT:
              process.env.PQC_KEYCHAIN_ACCOUNT || "pqc-secrets-key",
          },
        });
        let stderr = "";
        child.stderr.on("data", (d) => (stderr += d.toString()));
        child.on("close", (code) => {
          if (code === 0) resolve();
          else
            reject(
              new Error(
                `pqc-secrets pack exited ${code}: ${stderr || "<no stderr>"}`,
              ),
            );
        });
        child.on("error", reject);
        child.stdin.write(stdinPayload);
        child.stdin.end();
      });

      // Audit: record the add with the value's fingerprint, never
      // the value itself.
      logAuditEvent({
        action: merge ? "add" : "add",
        name,
        detail: `merge=${merge}; total=${Object.keys(map).length}; value-fp=${valueFingerprint(value)}`,
      });
      return {
        content: [
          {
            type: "text",
            text:
              `Added secret "${name}" to the PQC bundle (${Object.keys(map).length} total now).\n` +
              `Bundle re-encrypted at ${PQC_BUNDLE_PATH}.`,
          },
        ],
      };
    } catch (e: any) {
      return {
        content: [
          {
            type: "text",
            text: `Failed to add secret "${name}": ${e?.stderr || e?.message || String(e)}`,
          },
        ],
        isError: true,
      };
    }
  },
};

/* ------------------------------------------------------------------ *
 *  browser_secrets_add_from_clipboard
 * ------------------------------------------------------------------ */

export const secretsAddFromClipboard: Tool = {
  schema: {
    name: SecretsAddFromClipboardTool.shape.name.value,
    description: SecretsAddFromClipboardTool.shape.description.value,
    inputSchema: zodToJsonSchema(SecretsAddFromClipboardTool.shape.arguments),
  },
  handle: async (_context, params) => {
    const { name } = SecretsAddFromClipboardTool.shape.arguments.parse(params);
    // The user must have already copied the value to the system
    // clipboard (e.g. via Cmd+C after selecting a "Click to copy"
    // button or a text selection). The extension reads the
    // clipboard and the server adds it to the bundle.
    return {
      content: [
        {
          type: "text",
          text:
            `This tool requires the user to have already copied the value to the\n` +
            `system clipboard. Have them:\n` +
            `  1. Select the value on the page (or click a "Click to copy" button)\n` +
            `  2. Press Cmd+C (or use the page's own copy action)\n` +
            `  3. Then re-run \`browser_secrets_add_from_clipboard\` with name="${name}"\n\n` +
            `Note: this tool is intentionally a no-op stub in v0.7.0. The full\n` +
            `implementation needs a small extension-side message handler that reads\n` +
            `navigator.clipboard.readText() and forwards to the server. That's\n` +
            `scheduled for v0.7.1 — see the v0.7.0 worktree TODO.`,
        },
      ],
      isError: true,
    };
  },
};

/* ------------------------------------------------------------------ *
 *  browser_secrets_unlock_agent / lock_agent
 * ------------------------------------------------------------------ */

export const secretsUnlockAgent: Tool = {
  schema: {
    name: SecretsUnlockAgentTool.shape.name.value,
    description: SecretsUnlockAgentTool.shape.description.value,
    inputSchema: zodToJsonSchema(SecretsUnlockAgentTool.shape.arguments),
  },
  handle: async (_context, params) => {
    const { name, tabId } = SecretsUnlockAgentTool.shape.arguments.parse(params);
    try {
      const { stdout } = await pqc(["export"]);
      const parsed = parseExport(stdout);
      const match = parsed.find((p) => p.name === name);
      if (!match) {
        return {
          content: [
            {
              type: "text",
              text: `Secret "${name}" not found. Run \`browser_secrets_list\` to see available names.`,
            },
          ],
          isError: true,
        };
      }
      const u = getUnlocked(tabId);
      u[name] = match.value;
      // Audit: record the unlock with the value's fingerprint.
      logAuditEvent({
        action: "unlock",
        name,
        tabId,
        detail: `value-fp=${valueFingerprint(match.value)}`,
      });
      return {
        content: [
          {
            type: "text",
            text:
              `Unlocked "${name}" for tab ${tabId}.\n` +
              `The value is now cached in the server's process memory for this tab.\n` +
              `Use \`browser_secrets_lock_agent\` (or close the tab) to clear it.\n` +
              `To inject the value into a form field, use \`browser_secrets_copy_to_page\`.`,
          },
        ],
      };
    } catch (e: any) {
      return {
        content: [
          {
            type: "text",
            text: `Failed to unlock "${name}": ${e?.stderr || e?.message || String(e)}`,
          },
        ],
        isError: true,
      };
    }
  },
};

export const secretsLockAgent: Tool = {
  schema: {
    name: SecretsLockAgentTool.shape.name.value,
    description: SecretsLockAgentTool.shape.description.value,
    inputSchema: zodToJsonSchema(SecretsLockAgentTool.shape.arguments),
  },
  handle: async (_context, params) => {
    const { tabId, name } = SecretsLockAgentTool.shape.arguments.parse(params);
    if (name) {
      const u = getUnlocked(tabId);
      delete u[name];
      logAuditEvent({ action: "lock", name, tabId });
      return {
        content: [
          { type: "text", text: `Locked secret "${name}" for tab ${tabId}.` },
        ],
      };
    }
    clearUnlocked(tabId);
    logAuditEvent({ action: "lock", tabId, detail: "all-unlocked-cleared" });
    return {
      content: [
        {
          type: "text",
          text: `Locked all unlocked secrets for tab ${tabId}.`,
        },
      ],
    };
  },
};

/* ------------------------------------------------------------------ *
 *  browser_secrets_copy_to_page — atomic get → paste
 * ------------------------------------------------------------------ */

export const secretsCopyToPage: Tool = {
  schema: {
    name: SecretsCopyToPageTool.shape.name.value,
    description: SecretsCopyToPageTool.shape.description.value,
    inputSchema: zodToJsonSchema(SecretsCopyToPageTool.shape.arguments),
  },
  handle: async (context, params) => {
    const { name, ref, element, tabId } =
      SecretsCopyToPageTool.shape.arguments.parse(params);

    // Prefer the in-memory unlocked cache, fall back to pqc export
    const u = getUnlocked(tabId);
    let value = u[name];
    if (!value) {
      try {
        const { stdout } = await pqc(["export"]);
        const parsed = parseExport(stdout);
        const match = parsed.find((p) => p.name === name);
        if (!match) {
          return {
            content: [
              {
                type: "text",
                text: `Secret "${name}" not found.`,
              },
            ],
            isError: true,
          };
        }
        value = match.value;
      } catch (e: any) {
        return {
          content: [
            {
              type: "text",
              text: `Failed to read "${name}": ${e?.stderr || e?.message || String(e)}`,
            },
          ],
          isError: true,
        };
      }
    }

    // Reuse the existing paste_text transport — the value never
    // hits the conversation history because we go server-side
    // straight to the content script.
    const result = (await context.sendSocketMessage("browser_paste_text", {
      text: value,
      ref,
      element: element ?? `secret field for ${name}`,
      tabId,
    })) as any;

    if (!result || !result.ok) {
      logAuditEvent({
        action: "copy_to_page",
        name,
        tabId,
        error: result?.error || "unknown",
      });
      return {
        content: [
          {
            type: "text",
            text: `Failed to paste "${name}" into the field: ${result?.error || "unknown error"}`,
          },
        ],
        isError: true,
      };
    }
    // Audit: record the successful paste. value-fp lets the user
    // verify the pasted value matches what's in the bundle.
    logAuditEvent({
      action: "copy_to_page",
      name,
      tabId,
      detail: `value-fp=${valueFingerprint(value)}; ref=${ref ?? "-"}`,
    });
    return {
      content: [
        {
          type: "text",
          text:
            `Pasted secret "${name}" (${value.length} chars) into ${ref ? `ref=${ref}` : "the focused element"} on tab ${tabId}.`,
        },
      ],
    };
  },
};

/* ------------------------------------------------------------------ *
 *  browser_secrets_rotate — re-encrypt the bundle with a fresh
 *  data key + KEM shared secret. Identity key in keychain stays.
 * ------------------------------------------------------------------ */

import { createHash } from "node:crypto";

async function bundleFingerprint(path: string): Promise<string> {
  const buf = await readFile(path);
  const h = createHash("sha3-256").update(buf).digest("hex");
  return `sha3:${h}`;
}

export const secretsRotate: Tool = {
  schema: {
    name: SecretsRotateTool.shape.name.value,
    description: SecretsRotateTool.shape.description.value,
    inputSchema: zodToJsonSchema(SecretsRotateTool.shape.arguments),
  },
  handle: async (_context, params) => {
    SecretsRotateTool.shape.arguments.parse(params);
    if (!existsSync(PQC_BUNDLE_PATH)) {
      return {
        content: [
          {
            type: "text",
            text: `No bundle at ${PQC_BUNDLE_PATH}. Nothing to rotate.`,
          },
        ],
        isError: true,
      };
    }
    // 1. Capture old fingerprint for the audit message.
    const oldFp = await bundleFingerprint(PQC_BUNDLE_PATH);

    // 2. Backup the existing bundle. Use UTC timestamp for the
    //    suffix to keep backups sortable and avoid name collisions.
    const utcStamp = new Date().toISOString().replace(/[:.]/g, "-");
    const backupPath = `${PQC_BUNDLE_PATH}.bak.${utcStamp}`;
    try {
      await copyFile(PQC_BUNDLE_PATH, backupPath);
    } catch (e: any) {
      return {
        content: [
          {
            type: "text",
            text:
              `Failed to back up existing bundle before rotate: ` +
              `${e?.message || String(e)}\nRotate aborted.`,
          },
        ],
        isError: true,
      };
    }

    // 3. Read all existing secrets via export (decrypts with the
    //    CURRENT data key).
    let secrets: ParsedSecret[];
    try {
      const { stdout } = await pqc(["export"]);
      secrets = parseExport(stdout);
    } catch (e: any) {
      // Restore backup if we couldn't read the current bundle.
      try {
        await copyFile(backupPath, PQC_BUNDLE_PATH);
      } catch {
        // best effort
      }
      return {
        content: [
          {
            type: "text",
            text:
              `Failed to read existing bundle before rotate: ` +
              `${e?.stderr || e?.message || String(e)}\n` +
              `Backup preserved at ${backupPath}.`,
          },
        ],
        isError: true,
      };
    }

    // 4. Re-pack with a fresh data key + KEM shared secret.
    //    pack always generates fresh randomness, so the bundle
    //    is effectively re-keyed. The recipient pubkey (and its
    //    private key in the keychain) is unchanged.
    const stdinPayload = secrets
      .map((s) => `${s.name}=${s.value}`)
      .join("\n");

    try {
      const { spawn } = await import("node:child_process");
      await new Promise<void>((resolve, reject) => {
        const child = spawn(PQC_SECRETS_BIN, ["pack"], {
          env: {
            ...process.env,
            PQC_KEYCHAIN_ACCOUNT:
              process.env.PQC_KEYCHAIN_ACCOUNT || "pqc-secrets-key",
          },
        });
        let stderr = "";
        child.stderr.on("data", (d) => (stderr += d.toString()));
        child.on("close", (code) => {
          if (code === 0) resolve();
          else
            reject(
              new Error(
                `pqc-secrets pack exited ${code}: ${stderr || "<no stderr>"}`,
              ),
            );
        });
        child.on("error", reject);
        child.stdin.write(stdinPayload);
        child.stdin.end();
      });
    } catch (e: any) {
      // Restore the backup on pack failure.
      try {
        await copyFile(backupPath, PQC_BUNDLE_PATH);
      } catch {
        // If restore failed, the .bak is still on disk for manual recovery.
      }
      return {
        content: [
          {
            type: "text",
            text:
              `Rotate failed during re-pack: ` +
              `${e?.stderr || e?.message || String(e)}\n` +
              `Original bundle restored from ${backupPath}.`,
          },
        ],
        isError: true,
      };
    }

    // 5. Capture new fingerprint and report.
    const newFp = await bundleFingerprint(PQC_BUNDLE_PATH);

    // Audit: record the rotate event with both fingerprints.
    logAuditEvent({
      action: "rotate",
      detail: `old=${oldFp}; new=${newFp}; count=${secrets.length}; backup=${backupPath}`,
    });

    return {
      content: [
        {
          type: "text",
          text:
            `Rotated PQC bundle.\n` +
            `Old fingerprint: ${oldFp}\n` +
            `New fingerprint: ${newFp}\n` +
            `Previous bundle backed up to ${backupPath} (retain for 7 days, then ` +
            `delete with: rm ${backupPath}).\n` +
            `${secrets.length} secret(s) re-encrypted with a fresh data key and a ` +
            `fresh ML-KEM-768 shared secret. The identity keypair in the ` +
            `keychain is unchanged.`,
        },
      ],
    };
  },
};

/* ------------------------------------------------------------------ *
 *  tool array
 * ------------------------------------------------------------------ */

export const secretsTools: Tool[] = [
  secretsStatus,
  secretsList,
  secretsGet,
  secretsLoad,
  secretsAdd,
  secretsAddFromClipboard,
  secretsUnlockAgent,
  secretsLockAgent,
  secretsCopyToPage,
  secretsRotate,
];
