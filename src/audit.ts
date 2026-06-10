/**
 * @betterbrowsermcp/mcp — PQC secrets audit log (v0.8.0+)
 *
 * Append-only log of every secret operation. Lives at
 * ~/.config/pqc-secrets/audit.log with mode 0o600 (owner-only RW).
 * Format: one event per line, tab-separated, with a UTC ISO-8601
 * timestamp as the first field.
 *
 *   <utc-ts>\t<actor>\t<action>\t[<key>=<value>]\t<tabId>
 *
 * Fields:
 *   utc-ts: ISO-8601 UTC with millisecond precision (sortable)
 *   actor:  "hermes" (the MCP server process) — reserved for future
 *           multi-actor scenarios where multiple MCP servers or other
 *           consumers share the same keychain entry
 *   action: one of {get, list, add, add_from_clipboard, rotate,
 *           load, unlock, lock, copy_to_page, status, fail}
 *   key=value: optional, present for {get, add, add_from_clipboard,
 *           unlock, lock, copy_to_page}; the value is the secret NAME,
 *           never the value itself
 *   tabId: optional, the browser tab id (string) when applicable;
 *           "-" if not applicable
 *
 * Retention: the file is allowed to grow without bound by default.
 * Run the bundled archive helper (see audit-log reference §3 in
 * the pqc-secrets skill) monthly to roll old entries into
 * audit.log.YYYY-MM. The user can grep the log to answer
 * questions like:
 *   - "did my agent paste STRIPE_SECRET into the right form field?"
 *   - "when did I last add a secret, and which one?"
 *   - "is anything reading secrets while I'm not looking?"
 *
 * Errors writing to the audit log are non-fatal — the secret op
 * still succeeds. The MCP server logs a warning to stderr instead.
 * Rationale: the user values "I can always read my secrets" over
 * "I have a complete audit trail". The log is best-effort, not
 * security-critical.
 */

import { appendFile, mkdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";

const PQC_DIR = join(homedir(), ".config", "pqc-secrets");
const AUDIT_PATH = join(PQC_DIR, "audit.log");
const AUDIT_MODE = 0o600; // owner-only RW — secret metadata leak risk if world-readable

const TAB_FIELD = "-";
const ACTOR = "hermes";

export type AuditAction =
  | "get"
  | "list"
  | "add"
  | "add_from_clipboard"
  | "rotate"
  | "load"
  | "unlock"
  | "lock"
  | "copy_to_page"
  | "status"
  | "fail";

export interface AuditEvent {
  action: AuditAction;
  name?: string; // secret name; never the value
  mode?: "plain" | "redact"; // for get events
  tabId?: string | number;
  detail?: string; // free-form context (e.g., "bundle-fp=abc...; new-fp=def...")
  error?: string; // present on fail events
}

/**
 * Compute a short hash fingerprint of a secret value, for the
 * audit log. NEVER log the value itself. The fingerprint lets
 * the user verify "yes, the same value is in the bundle" without
 * exposing the value to anyone reading the log.
 */
export function valueFingerprint(value: string): string {
  const h = createHash("sha3-256").update(value).digest("hex");
  return `sha3:${h.slice(0, 16)}`;
}

let warnedAboutAuditDir = false;

async function ensureAuditFile(): Promise<void> {
  try {
    await stat(AUDIT_PATH);
  } catch (e: any) {
    if (e?.code === "ENOENT") {
      // Create the directory if it doesn't exist.
      try {
        await mkdir(dirname(AUDIT_PATH), { recursive: true });
      } catch {
        // best-effort
      }
      // First write — open the file with append mode. The mode
      // 0o600 is applied at open time; subsequent appends inherit.
      try {
        await appendFile(AUDIT_PATH, "", { mode: AUDIT_MODE });
      } catch (err: any) {
        if (!warnedAboutAuditDir) {
          warnedAboutAuditDir = true;
          console.warn(
            `[pqc-audit] could not initialize audit log at ${AUDIT_PATH}: ` +
              `${err?.message || err}`,
          );
        }
      }
    }
  }
}

/**
 * Append a single audit event. Non-blocking best-effort — never
 * throws. Always returns immediately (the fs write is awaited but
 * the error path is swallowed).
 */
export async function logAuditEvent(event: AuditEvent): Promise<void> {
  try {
    await ensureAuditFile();
    const ts = new Date().toISOString();
    const name = event.name ?? "-";
    const mode = event.mode ?? "-";
    const tab = event.tabId === undefined ? TAB_FIELD : String(event.tabId);
    const detail = event.detail ? `\t${event.detail}` : "";
    const err = event.error ? `\terror=${JSON.stringify(event.error).slice(0, 200)}` : "";
    const line = `${ts}\t${ACTOR}\t${event.action}\tname=${name}\tmode=${mode}\ttab=${tab}${detail}${err}\n`;
    await appendFile(AUDIT_PATH, line, { mode: AUDIT_MODE });
  } catch (err: any) {
    if (!warnedAboutAuditDir) {
      warnedAboutAuditDir = true;
      console.warn(
        `[pqc-audit] could not write audit log entry: ${err?.message || err}`,
      );
    }
  }
}

export const AUDIT_LOG_PATH = AUDIT_PATH;
