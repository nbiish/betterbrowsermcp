/**
 * @betterbrowsermcp/mcp — tool aggregation (v0.9.0)
 *
 * One shared toolset used by BOTH transports:
 *   - stdio MCP (single-agent mode, unchanged since v0.1.3)
 *   - Streamable HTTP MCP at /mcp(/<agentId>) (v0.9.0+)
 *
 * Tools are pure functions of (Context, params), so the same Tool[]
 * can be dispatched against any agent's Context from the registry.
 */

import * as clipboard from "@/tools/clipboard";
import * as common from "@/tools/common";
import { cursorTools } from "@/tools/cursor";
import * as custom from "@/tools/custom";
import * as extract from "@/tools/extract";
import * as manage from "@/tools/manage";
import { secretsTools } from "@/tools/secrets";
import * as snapshot from "@/tools/snapshot";
import type { Tool } from "@/tools/tool";

const commonTools: Tool[] = [common.pressKey, common.wait];

const customTools: Tool[] = [custom.getConsoleLogs, custom.screenshot];

// Multi-tab management tools — always registered, regardless of whether
// the user has bound any tabs yet. The LLM uses these to discover the
// available tabs, set the active one, and label them. v0.9.0 adds tab
// adoption (bind/unbind), advisory per-tab locks (acquire/release),
// readiness waiting, and event polling.
const manageTools: Tool[] = [
  manage.listTabs,
  manage.getTabInfo, // v0.9.1 alias of browser_list_tabs
  manage.openTab,
  manage.closeTab,
  manage.renameTab,
  manage.setActiveTab,
  manage.bindTab,
  manage.unbindTab,
  manage.acquireTab,
  manage.releaseTab,
  manage.waitForContent,
  manage.pollEvents,
];

// Clipboard tool — reads "Click to copy" content from any page that
// uses navigator.clipboard.writeText. Useful for Stripe publishable
// keys, secret keys, GitHub PATs, AWS access keys, etc.
const clipboardTools: Tool[] = [clipboard.copyToClipboard];

// Extraction & SPA-state tools (v0.5.0+) — paste, wait_for_text,
// get_attribute, extract_text, evaluate. See tools/extract.ts for
// the per-tool rationale and failure-mode guidance.
const extractTools: Tool[] = [
  extract.pasteText,
  extract.waitForText,
  extract.getAttribute,
  extract.extractText,
  extract.evaluate,
  // v0.6.0+ — React-friendly controlled-input writer + clearer.
  // These fix the v0.5.0 React failure: pasteText dispatches a
  // synthetic paste event but Stripe/GitHub/Vercel/Linear etc. all
  // have a React valueTracker that blocks the change. setInputValue
  // resets the tracker before calling the native value setter, so
  // controlled inputs see a real change. See tools/extract.ts.
  extract.setInputValue,
  extract.clearInput,
];

export const allTools: Tool[] = [
  common.navigate(true),
  common.goBack(true),
  common.goForward(true),
  snapshot.snapshot,
  snapshot.click,
  snapshot.hover,
  snapshot.type,
  snapshot.selectOption,
  ...commonTools,
  ...customTools,
  ...manageTools,
  ...clipboardTools,
  ...extractTools,
  ...secretsTools,
  ...cursorTools,
];
