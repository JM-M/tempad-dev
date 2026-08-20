# MCP node selection

Status: implemented

## Decision

TemPad Dev exposes one mutating tool for session state, `select_node`, which points the current Figma
selection at an exact node:

```txt
agent has a node id
  -> select_node(nodeId, scrollIntoView?)
  -> resolve the node asynchronously (any page)
  -> load + switch page when the node lives elsewhere
  -> write figma.currentPage.selection
  -> optionally scroll and zoom the viewport
  -> read the live selection back as verification
  -> return the node, its page, and the previous selection
```

Every read tool already accepts a `nodeId`, so this tool exists for the human's benefit, not the
agent's: it puts the person in front of the node under discussion. The tool description says so
explicitly, to keep agents from calling it as a preamble to reading.

## Why a write tool at all

Selection is normally the human's channel for telling the agent what to work on, and moving it is
disruptive. Two cases justify the write:

- The agent has found the node the person is asking about and needs to show them which one it means,
  across a file where the node may be on another page.
- The agent is handing control back and wants the person's editor to be somewhere useful.

The response returns `previousSelection` so the agent can restore what the person had. That is a
deliberate alternative to adding a per-tool permission toggle: the extension's existing preference
already gates the whole MCP connection (`mcp/permissions.ts` covers the localhost origin, not
individual tools), and a second gate would add configuration without adding real protection.

## Verified runtime behavior

Writing selection through the internal `window.figma` mirror is not documented by Figma, and no other
code path in this repository writes to it, so the design was validated against a real file before it
was built (2026-08-20, unpacked build in a Chromium browser, 9-page design file with edit access):

| Behavior                                                 | Result                                                                                |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `figma.currentPage.selection = [node]`                   | Applies, and Figma's own UI moves — a real scene-graph write, not a detached wrapper. |
| `figma.viewport.scrollAndZoomIntoView([node])`           | Applies.                                                                              |
| `figma.setCurrentPageAsync`, `page.loadAsync`            | Present and functional.                                                               |
| `figma.getNodeByIdAsync` for a node on an unvisited page | Resolves.                                                                             |
| `figma.getNodeById` (sync) for the same node             | Returns `null`, and Figma logs its own deprecation warning.                           |

The last row drives the implementation. Cross-page selection **must** resolve through the async
lookup, so the handler uses `getNodeById` from `mcp/local-resources.ts` (async first, sync fallback,
connection-timeout retry) rather than calling `figma.getNodeById` directly the way `runtime.ts` does
for same-page reads. The sync path fails by returning `null` rather than throwing, so using it would
have produced a silent, mislabelled `NODE_NOT_VISIBLE` for every cross-page call.

## Verification, not optimism

After writing the selection the handler calls `syncSelection()` and then re-reads
`figma.currentPage.selection`, failing with `SELECTION_WRITE_FAILED` if the node is not there.

This is not defensive noise. The specific failure it guards against is a plausible one for an
undocumented API: an assignment that lands on a JavaScript wrapper without reaching the scene graph
would read back as success through that same wrapper. Re-reading the live selection is what
distinguishes a real write from an accepted one, and the same check keeps the panel's `selection` ref
consistent with the document.

## Availability and permissions

Selection writes require an editable Figma **design** file. Two gates, matching canvas authoring:

- `window.INITIAL_OPTIONS?.editor_type !== 'design'` → `SELECTION_UNSUPPORTED_EDITOR`, before any
  node lookup.
- The Plugin API exposes no file-permission flag, so read-only files are only detectable from the
  native mutation error. The handler normalizes a message matching
  `/\b(?:read|view)[ -]?only\b|\bedit access\b|\bpermission to edit\b/i` to `SELECTION_READ_ONLY`, and
  anything else to `SELECTION_WRITE_FAILED`.

The read-only pattern is copied from `mcp/tools/canvas/errors.ts` rather than imported, so this tool
carries no dependency on canvas authoring internals.

## Security note

`select_node` adds no transport surface: it travels the same broker path as every other tool, which
dispatches generically by tool name, and it needs no change to `mcp/permissions.ts`. It reads nothing
new out of the document and writes nothing that persists — selection and viewport are session state,
and the tool is annotated `destructiveHint: false, idempotentHint: true` accordingly.

The residual risk is nuisance: a client that already holds an authorized MCP connection can move the
person's viewport. That is bounded by the same connection consent that already allows reading the
whole file, and is why the tool is not silent — it always reports the node and page it moved to.

## Deliberate non-goals

- **No multi-node selection.** One `nodeId`, matching every other tool's parameter shape. Multi-select
  can be added later without breaking the contract.
- **No node search or discovery tool.** `get_structure` already returns id, name, type, and geometry
  trees. The remaining gap is cold start — an agent with nothing selected and no id has no entry
  point — and the proportionate fix is a root selector on `get_structure`, not a second tool
  competing for the agent's context budget.
- **No selection subscription.** Reading the current selection is already covered by the other tools.
