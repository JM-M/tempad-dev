import type {
  GetCodeParametersInput,
  GetCodeResult,
  GetScreenshotParametersInput,
  GetScreenshotResult,
  GetStructureParametersInput,
  GetStructureResult,
  GetTokenDefsParametersInput,
  GetTokenDefsResult
} from '@tempad-dev/shared'

import { TEMPAD_MCP_ERROR_CODES } from '@tempad-dev/shared'

import { selection } from '@/ui/state'

import type { GetCodeRuntimeOptions } from './tools/code'

import { createCodedError } from './errors'
import { handleApplyCanvas } from './tools/canvas'
import { handleGetCode as runGetCode } from './tools/code'
import { handleGetDesignSystem } from './tools/design-system'
import { handleGetScreenshot as runGetScreenshot } from './tools/screenshot'
import { handleSelectNode } from './tools/select'
import { handleGetStructure as runGetStructure } from './tools/structure'
import { handleGetTokenDefs as runGetTokenDefs } from './tools/token'

function isSceneNode(node: BaseNode | null): node is SceneNode {
  return !!node && 'visible' in node && 'type' in node
}

function resolveSingleNode(nodeId?: string): SceneNode {
  if (nodeId) {
    const node = figma.getNodeById(nodeId)
    if (!node) {
      throw createCodedError(
        TEMPAD_MCP_ERROR_CODES.NODE_NOT_VISIBLE,
        `Node "${nodeId}" does not exist in the current document.`
      )
    }
    if (!isSceneNode(node)) {
      throw createCodedError(
        TEMPAD_MCP_ERROR_CODES.NODE_NOT_VISIBLE,
        `Node "${nodeId}" exists but is not a supported scene node.`
      )
    }
    if (!node.visible) {
      throw createCodedError(
        TEMPAD_MCP_ERROR_CODES.NODE_NOT_VISIBLE,
        `Node "${nodeId}" exists but is hidden.`
      )
    }
    return node
  }

  const [selectedNode] = selection.value
  if (selection.value.length !== 1 || !selectedNode?.visible) {
    throw createCodedError(
      TEMPAD_MCP_ERROR_CODES.INVALID_SELECTION,
      'Select exactly one visible node (or provide nodeId) to proceed.'
    )
  }

  return selectedNode
}

export type WindowGetCodeParametersInput = GetCodeParametersInput & {
  _unbounded?: boolean
}

async function handleGetCode(
  args?: GetCodeParametersInput,
  runtimeOptions?: GetCodeRuntimeOptions
): Promise<GetCodeResult> {
  const node = resolveSingleNode(args?.nodeId)
  const { preferredLang, resolveTokens, vectorMode } = args ?? {}
  return runGetCode([node], preferredLang, resolveTokens, vectorMode, runtimeOptions)
}

async function handleWindowGetCode(args?: WindowGetCodeParametersInput): Promise<GetCodeResult> {
  const { _unbounded, ...rest } = args ?? {}
  return handleGetCode(rest, {
    unbounded: _unbounded
  })
}

async function handleGetTokenDefs(args?: GetTokenDefsParametersInput): Promise<GetTokenDefsResult> {
  const { names, includeAllModes } = args ?? {}
  if (!names?.length) {
    throw new Error('names is required and must include at least one canonical token name.')
  }
  return runGetTokenDefs(names, includeAllModes)
}

async function handleGetScreenshot(
  args?: GetScreenshotParametersInput
): Promise<GetScreenshotResult> {
  const node = resolveSingleNode(args?.nodeId)
  return runGetScreenshot(node)
}

async function handleGetStructure(args?: GetStructureParametersInput): Promise<GetStructureResult> {
  const { nodeId, root, options } = args ?? {}
  const depth = options?.depth

  // The parameters schema rejects this over MCP; window.tempadTools callers bypass it.
  if (nodeId !== undefined && root !== undefined) {
    throw new Error('Pass either nodeId or root, not both.')
  }

  if (root === 'page') {
    // The page itself is not a scene node, so its children are the outlinable roots. Depth stays
    // relative to the page, so depth 1 lists those children alone rather than expanding each one.
    // That also keeps the ids honest: deeper limits let wrapper flattening replace a single-child
    // frame with its child, which would hand back ids that are not the page's own frames.
    const children = nearestFirst(
      figma.currentPage.children.filter((child) => child.visible),
      figma.currentPage.selection ?? selection.value
    )
    return runGetStructure(children, depth === undefined ? undefined : depth - 1, options?.native)
  }

  // A multi-selection outlines each selected node side by side, so a whole flow can be read in one
  // call. Hidden nodes drop out; a selection with none left falls through to the single-node error.
  // Figma's own selection is read first: the synced copy only refreshes on canvas clicks and
  // shortcuts, so a selection made in the layers panel can lag behind it.
  const selected = figma.currentPage?.selection ?? selection.value
  if (nodeId === undefined && selected.length > 1) {
    const visible = selected.filter((node) => node.visible)
    if (visible.length) return runGetStructure(visible, depth, options?.native)
  }

  return runGetStructure([resolveSingleNode(nodeId)], depth, options?.native)
}

// The page outline is capped, so on a large page the frames past the cap are unreachable. With a
// selection, the page's children are ordered nearest it first, so the frames around what the person
// is looking at always make the cut. Without one, layer order stands.
function nearestFirst(children: SceneNode[], selected: readonly SceneNode[]): SceneNode[] {
  const anchors = selected.map(pageCenter).filter((point) => point !== null)
  if (!anchors.length) return children

  const distance = (node: SceneNode) => {
    const center = pageCenter(node)
    if (!center) return Number.POSITIVE_INFINITY
    return Math.min(...anchors.map((a) => Math.hypot(center.x - a.x, center.y - a.y)))
  }
  return children
    .map((node, index) => ({ node, index, distance: distance(node) }))
    .sort((a, b) => a.distance - b.distance || a.index - b.index)
    .map(({ node }) => node)
}

function pageCenter(node: SceneNode): { x: number; y: number } | null {
  const box = 'absoluteBoundingBox' in node ? node.absoluteBoundingBox : null
  if (!box) return null
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 }
}

export const MCP_TOOL_HANDLERS = {
  apply_canvas: handleApplyCanvas,
  get_code: handleGetCode,
  get_design_system: handleGetDesignSystem,
  get_token_defs: handleGetTokenDefs,
  get_screenshot: handleGetScreenshot,
  get_structure: handleGetStructure,
  select_node: handleSelectNode
}

export type MCPHandlers = typeof MCP_TOOL_HANDLERS

export type TempadWindowHandlers = Omit<MCPHandlers, 'get_code'> & {
  get_code: (args?: WindowGetCodeParametersInput) => Promise<GetCodeResult>
}

declare global {
  interface Window {
    tempadTools?: Partial<TempadWindowHandlers>
  }
}

export const WINDOW_TEMPAD_TOOL_HANDLERS: TempadWindowHandlers = {
  ...MCP_TOOL_HANDLERS,
  get_code: handleWindowGetCode
}

function isMcpToolName(name: string): name is keyof MCPHandlers {
  return Object.hasOwn(MCP_TOOL_HANDLERS, name)
}

export async function runMcpTool(name: string, args: unknown): Promise<unknown> {
  if (!isMcpToolName(name)) {
    throw new Error(`No handler registered for tool "${name}".`)
  }
  const handler = MCP_TOOL_HANDLERS[name] as (args?: unknown) => Promise<unknown>
  return handler(args)
}

function exposeToolsOnWindow(): void {
  if (typeof window === 'undefined') {
    return
  }
  window.tempadTools = {
    ...(window.tempadTools ?? {}),
    ...WINDOW_TEMPAD_TOOL_HANDLERS
  }
}

exposeToolsOnWindow()
