# Cursor Primitive Design Spec

## Gap
betterbrowsermcp exposes `click`, `type`, and `select`, but no programmatic mouse cursor.
The Stripe dashboard is a real-world proof why this matters:
- Secret key is masked until hover.
- Copy buttons use hover-triggered UI.
- Dropdowns/menus need hover or click-hold.
- Modals/overlays need precise positioning.

## Target Verb Set (minimal surface)

### 1. `move`
Move cursor to absolute viewport coordinates.
Input: `{x: number, y: number}` or `{element: string (selector)}`
CDP: `Input.dispatchMouseEvent` type=`mouseMoved`

### 2. `hover`
Move cursor to element center and fire mouseenter/mouseover.
Input: `{selector: string}` or `{ref: string}` + `{duration_ms?: number}` to hold
CDP: `mouseMoved` to center of target rect

### 3. `click`
Move to target → left mousedown → left mouseup.
Input: `{selector: string}` or `{ref: string}` or `{x: number, y: number}`
CDP: `mousePressed` (left) + `mouseReleased` (left)

### 4. `click-hold`
Move to target → mousedown → wait → mouseup.
Use for “press and hold to reveal secret” or drag initiation.
Input: `{selector|ref|xy, hold_ms: number (default 500)}`
CDP: `mousePressed` + sleep + `mouseReleased`

### 5. `drag`
Drag from start to end. Single chord, no intermediate stops needed.
Input: `{start: {selector|ref|xy}, end: {selector|ref|xy}}`
CDP: `mousePressed` at start → `mouseMoved` (browser tracks held button) at end → `mouseReleased`

### 6. `scroll`
Scroll at a target element or viewport.
Input: `{selector|ref|xy?, deltaY: number, deltaX?: number}` where 100 = one notch
CDP: `Input.dispatchMouseEvent` type=`mouseWheel`

### 7. `submit`
Submit a form or fire Enter on a focused element.
Input: `{selector|ref?}` — if omitted, fires Enter on currently focused element
CDP: `Input.dispatchKeyEvent` keyDown/keyUp for Enter, or `requestSubmit()` via evaluate

### 8. `context-menu`
Right-click at target.
Input: `{selector|ref|xy}`
CDP: `mousePressed` (right) + `mouseReleased` (right)

## Targeting Contract
- **`selector`**: CSS selector scoped to document. Prefer text-based or ARIA selectors
  over fragile indices.
- **`ref`**: If a snapshot is fresh, accept `@eNN` shorthand and map to the
  underlying DOM node via the snapshot’s nodeId.
- **`xy`**: Absolute viewport pixel coordinates. Origin = top-left of viewport.
- Resolution order in implementation: `selector` → `ref` → `xy`.

## Return Shape (all verbs)
```json
{
  "ok": true,
  "target": {"selector": "...", "rect": {"x":..., "y":..., "width":..., "height":...}},
  "cursor": {"x": ..., "y": ...},
  "action": "click",
  "result": "clicked"
}
```

## Retry Rules
- Element-not-found → do NOT invent a fallback. Return `{ok:false, error:"ELEMENT_NOT_FOUND", selector, hint}`.
- Element offscreen → scrollIntoView first via `Page.bringToFront` + `DOM.scrollIntoViewIfNeeded`, then retry once.
- Target under shadow DOM → resolve via `querySelector` with `shadowRoot` traversal.
- Zero-size element → use its nearest scrollable ancestor’s rect center.

## Stripe-Specific Use Cases This Unlocks
1. **Hover secret key dots** → reveal hidden key → `click-hold` to force reveal if single-click is swallowed.
2. **Hover copy button** → click it → read clipboard via `browser_copy_to_clipboard` or evaluate `navigator.clipboard`.
3. **Hover sidebar nav** → click Payment Links / API keys.
4. **Scroll product table** → `scroll` on the table container to reach more items.

## Why Not Just Synthesize Clicks via JS?
- `element.click()` skips `mouseenter`/`mouseover`/`mousedown` chains that
  Stripe’s React code listens for.
- CDP `Input.dispatchMouseEvent` fires real OS-level pointer events, same as
  a human user. This is what Stripe’s tooltips, secret-key reveal, and copy
  buttons actually respond to.

## Risks / Mitigations
- **CSP blocks `unsafe-eval`** (already hit): our existing `evaluate` tool uses
  indirect eval, which Stripe’s CSP allows. Keep cursor strictly CDP-based,
  no inline eval needed for the cursor itself.
- **Coordinate drift on DPR 2x screens**: CDP uses CSS pixels, not device pixels.
  Use `window.visualViewport` to map if needed — but in practice Stripe’s
  react-templates work in CSS px so CDP px matches.
- **Hover menus that require slight movement**: some CSS-only dropdowns need
  `mouseMoved` *after* hover, not just on arrival. Implement as
  `hover(selector, duration_ms)` which holds position before releasing.

## Phase 1 Todos
1. Wire `Input.dispatchMouseEvent` into extension background/content script
2. Add 8 tool verbs to MCP server tools list + Zod schema
3. Test against Stripe: hover secret dots → copy key
4. Use the revealed keys to fix PQC bundle
5. Use cursor to create 3 Payment Links via Stripe API directly (faster than UI automation)
