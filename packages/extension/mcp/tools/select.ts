import type { SelectNodeParametersInput, SelectNodeResult } from '@tempad-dev/shared'

import { SelectNodeParametersSchema, TEMPAD_MCP_ERROR_CODES } from '@tempad-dev/shared'

import { syncSelection } from '@/composables/selection'

import { createCodedError } from '../errors'
import { getNodeById } from '../local-resources'

const READ_ONLY_ERROR_PATTERN = /\b(?:read|view)[ -]?only\b|\bedit access\b|\bpermission to edit\b/i

function assertSelectionWritable(): void {
  if (typeof window === 'undefined' || window.INITIAL_OPTIONS?.editor_type !== 'design') {
    throw createCodedError(
      TEMPAD_MCP_ERROR_CODES.SELECTION_UNSUPPORTED_EDITOR,
      'Selecting nodes is available only when the current Figma editor type is design.'
    )
  }
}

function isSceneNode(node: BaseNode | null): node is SceneNode {
  return !!node && 'visible' in node && 'type' in node
}

function findPage(node: BaseNode): PageNode {
  let current: BaseNode | null = node.parent
  while (current && current.type !== 'PAGE') {
    current = current.parent
  }
  if (!current) {
    throw createCodedError(
      TEMPAD_MCP_ERROR_CODES.NODE_NOT_VISIBLE,
      `Node "${node.id}" is not attached to a page.`
    )
  }
  return current as PageNode
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message || 'Unknown error'
  if (typeof error === 'string') return error
  return String(error ?? 'Unknown error')
}

// The Plugin API exposes no file-permission flag, so normalize its native mutation error.
function selectionWriteError(error: unknown): Error {
  const message = errorMessage(error)
  if (READ_ONLY_ERROR_PATTERN.test(message)) {
    return createCodedError(
      TEMPAD_MCP_ERROR_CODES.SELECTION_READ_ONLY,
      'Selecting nodes requires edit access to the current Figma Design file.'
    )
  }
  return createCodedError(TEMPAD_MCP_ERROR_CODES.SELECTION_WRITE_FAILED, message)
}

async function resolveSceneNode(nodeId: string): Promise<SceneNode> {
  // Cross-page ids only resolve through the async lookup; the sync one cannot see unloaded pages.
  const node = await getNodeById(nodeId)
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

export async function handleSelectNode(
  args?: SelectNodeParametersInput
): Promise<SelectNodeResult> {
  assertSelectionWritable()

  const parsed = SelectNodeParametersSchema.safeParse(args ?? {})
  if (!parsed.success) {
    throw new Error(parsed.error.issues[0]?.message ?? 'select_node input is invalid.')
  }
  const { nodeId, scrollIntoView = true } = parsed.data

  const node = await resolveSceneNode(nodeId)
  const page = findPage(node)
  const previousSelection = figma.currentPage.selection.map((selected) => selected.id)
  const pageChanged = page.id !== figma.currentPage.id

  try {
    if (pageChanged) {
      await page.loadAsync()
      await figma.setCurrentPageAsync(page)
    }
    figma.currentPage.selection = [node]
    if (scrollIntoView) {
      figma.viewport.scrollAndZoomIntoView([node])
    }
  } catch (error) {
    throw selectionWriteError(error)
  }

  // Mirrors the live selection back into the panel state, which doubles as write verification.
  syncSelection()
  if (!figma.currentPage.selection.some((selected) => selected.id === node.id)) {
    throw createCodedError(
      TEMPAD_MCP_ERROR_CODES.SELECTION_WRITE_FAILED,
      `Node "${nodeId}" did not become the current selection.`
    )
  }

  return {
    id: node.id,
    name: node.name,
    type: node.type,
    page: {
      id: page.id,
      name: page.name
    },
    pageChanged,
    previousSelection
  }
}
