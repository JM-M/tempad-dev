import { TEMPAD_MCP_ERROR_CODES } from '@tempad-dev/shared'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  getNodeById: vi.fn(),
  syncSelection: vi.fn()
}))

vi.mock('@/mcp/local-resources', () => ({
  getNodeById: mocks.getNodeById
}))

vi.mock('@/composables/selection', () => ({
  syncSelection: mocks.syncSelection
}))

type TestPage = {
  id: string
  type: 'PAGE'
  name: string
  parent: null
  children: TestSceneNode[]
  selection: TestSceneNode[]
  loadAsync: ReturnType<typeof vi.fn>
}

type TestSceneNode = {
  id: string
  name: string
  type: string
  visible: boolean
  parent: TestPage | TestSceneNode | null
}

function createPage(id: string, name: string): TestPage {
  return {
    id,
    type: 'PAGE',
    name,
    parent: null,
    children: [],
    selection: [],
    loadAsync: vi.fn().mockResolvedValue(undefined)
  }
}

function createNode(id: string, page: TestPage, overrides: Partial<TestSceneNode> = {}) {
  const node: TestSceneNode = {
    id,
    name: `Node ${id}`,
    type: 'FRAME',
    visible: true,
    parent: page,
    ...overrides
  }
  page.children.push(node)
  return node
}

const calls: string[] = []

function stubFigma(currentPage: TestPage) {
  const figma = {
    currentPage,
    setCurrentPageAsync: vi.fn(async (page: TestPage) => {
      calls.push('setCurrentPageAsync')
      figma.currentPage = page
    }),
    viewport: {
      scrollAndZoomIntoView: vi.fn(() => {
        calls.push('scrollAndZoomIntoView')
      })
    }
  }
  vi.stubGlobal('figma', figma)
  return figma
}

function stubEditorType(editorType?: string) {
  vi.stubGlobal('window', {
    INITIAL_OPTIONS: editorType === undefined ? undefined : { editor_type: editorType }
  })
}

async function importSelect() {
  vi.resetModules()
  return import('@/mcp/tools/select')
}

async function expectCode(promise: Promise<unknown>, code: string) {
  await expect(promise).rejects.toMatchObject({ code })
}

beforeEach(() => {
  calls.length = 0
  stubEditorType('design')
})

afterEach(() => {
  // resetAllMocks, not clearAllMocks: mockResolvedValue implementations would otherwise
  // leak into the next test and quietly resolve a node it never asked for.
  vi.resetAllMocks()
  vi.unstubAllGlobals()
})

describe('mcp/tools/select', () => {
  it('selects a node on the current page and scrolls to it by default', async () => {
    const page = createPage('page-1', 'Frames')
    const previous = createNode('1:1', page)
    const target = createNode('1:2', page)
    page.selection = [previous]
    const figma = stubFigma(page)
    mocks.getNodeById.mockResolvedValue(target)

    const { handleSelectNode } = await importSelect()
    const result = await handleSelectNode({ nodeId: '1:2' })

    expect(page.selection).toEqual([target])
    expect(figma.viewport.scrollAndZoomIntoView).toHaveBeenCalledWith([target])
    expect(figma.setCurrentPageAsync).not.toHaveBeenCalled()
    expect(mocks.syncSelection).toHaveBeenCalled()
    expect(result).toEqual({
      id: '1:2',
      name: 'Node 1:2',
      type: 'FRAME',
      page: { id: 'page-1', name: 'Frames' },
      pageChanged: false,
      previousSelection: ['1:1']
    })
  })

  it('leaves the viewport alone when scrollIntoView is false', async () => {
    const page = createPage('page-1', 'Frames')
    const target = createNode('1:2', page)
    const figma = stubFigma(page)
    mocks.getNodeById.mockResolvedValue(target)

    const { handleSelectNode } = await importSelect()
    const result = await handleSelectNode({ nodeId: '1:2', scrollIntoView: false })

    expect(figma.viewport.scrollAndZoomIntoView).not.toHaveBeenCalled()
    expect(page.selection).toEqual([target])
    expect(result.previousSelection).toEqual([])
  })

  it('loads and switches pages before selecting a node on another page', async () => {
    const current = createPage('page-1', 'Frames')
    const other = createPage('page-2', 'Website components')
    const group = { id: '8:0', name: 'Group', type: 'GROUP', visible: true, parent: other }
    const target = createNode('8:288', other, { parent: group as unknown as TestSceneNode })
    const figma = stubFigma(current)
    mocks.getNodeById.mockResolvedValue(target)

    const { handleSelectNode } = await importSelect()
    const result = await handleSelectNode({ nodeId: '8:288' })

    expect(other.loadAsync).toHaveBeenCalled()
    expect(figma.setCurrentPageAsync).toHaveBeenCalledWith(other)
    // The page must be current before the selection is written, or the write lands on the wrong page.
    expect(calls).toEqual(['setCurrentPageAsync', 'scrollAndZoomIntoView'])
    expect(other.selection).toEqual([target])
    expect(result.pageChanged).toBe(true)
    expect(result.page).toEqual({ id: 'page-2', name: 'Website components' })
  })

  it('rejects when the editor type is not design', async () => {
    stubEditorType('dev')
    stubFigma(createPage('page-1', 'Frames'))

    const { handleSelectNode } = await importSelect()

    await expectCode(
      handleSelectNode({ nodeId: '1:2' }),
      TEMPAD_MCP_ERROR_CODES.SELECTION_UNSUPPORTED_EDITOR
    )
    expect(mocks.getNodeById).not.toHaveBeenCalled()
  })

  it('rejects when INITIAL_OPTIONS is absent', async () => {
    stubEditorType(undefined)
    stubFigma(createPage('page-1', 'Frames'))

    const { handleSelectNode } = await importSelect()

    await expectCode(
      handleSelectNode({ nodeId: '1:2' }),
      TEMPAD_MCP_ERROR_CODES.SELECTION_UNSUPPORTED_EDITOR
    )
  })

  it.each([
    ['an unknown id', null, 'does not exist'],
    ['a non-scene node', { id: '1:2', type: 'PAGE' }, 'not a supported scene node']
  ])('rejects %s', async (_label, resolved, message) => {
    const page = createPage('page-1', 'Frames')
    stubFigma(page)
    mocks.getNodeById.mockResolvedValue(resolved)

    const { handleSelectNode } = await importSelect()
    const promise = handleSelectNode({ nodeId: '1:2' })

    await expectCode(promise, TEMPAD_MCP_ERROR_CODES.NODE_NOT_VISIBLE)
    await expect(promise).rejects.toThrow(new RegExp(message))
  })

  it('rejects a hidden node', async () => {
    const page = createPage('page-1', 'Frames')
    const target = createNode('1:2', page, { visible: false })
    stubFigma(page)
    mocks.getNodeById.mockResolvedValue(target)

    const { handleSelectNode } = await importSelect()

    await expectCode(handleSelectNode({ nodeId: '1:2' }), TEMPAD_MCP_ERROR_CODES.NODE_NOT_VISIBLE)
  })

  it('rejects a node that is not attached to a page', async () => {
    const page = createPage('page-1', 'Frames')
    stubFigma(page)
    mocks.getNodeById.mockResolvedValue({
      id: '1:2',
      name: 'Orphan',
      type: 'FRAME',
      visible: true,
      parent: null
    })

    const { handleSelectNode } = await importSelect()

    await expectCode(handleSelectNode({ nodeId: '1:2' }), TEMPAD_MCP_ERROR_CODES.NODE_NOT_VISIBLE)
  })

  it('rejects invalid input', async () => {
    stubFigma(createPage('page-1', 'Frames'))

    const { handleSelectNode } = await importSelect()

    await expect(handleSelectNode({ nodeId: '' })).rejects.toThrow()
    await expect(
      handleSelectNode({ nodeId: '1:2', bogus: true } as unknown as { nodeId: string })
    ).rejects.toThrow()
  })

  it('normalizes a native read-only failure', async () => {
    const page = createPage('page-1', 'Frames')
    const target = createNode('1:2', page)
    stubFigma(page)
    Object.defineProperty(page, 'selection', {
      get: () => [],
      set: () => {
        throw new Error('Cannot write to a view-only file')
      }
    })
    mocks.getNodeById.mockResolvedValue(target)

    const { handleSelectNode } = await importSelect()
    const promise = handleSelectNode({ nodeId: '1:2' })

    await expectCode(promise, TEMPAD_MCP_ERROR_CODES.SELECTION_READ_ONLY)
    await expect(promise).rejects.toThrow(/requires edit access/)
  })

  it('surfaces other native failures as a write failure', async () => {
    const page = createPage('page-1', 'Frames')
    const target = createNode('1:2', page)
    stubFigma(page)
    Object.defineProperty(page, 'selection', {
      get: () => [],
      set: () => {
        throw new Error('Something else broke')
      }
    })
    mocks.getNodeById.mockResolvedValue(target)

    const { handleSelectNode } = await importSelect()
    const promise = handleSelectNode({ nodeId: '1:2' })

    await expectCode(promise, TEMPAD_MCP_ERROR_CODES.SELECTION_WRITE_FAILED)
    await expect(promise).rejects.toThrow(/Something else broke/)
  })

  it.each([
    ['a thrown string', 'This file is view-only', TEMPAD_MCP_ERROR_CODES.SELECTION_READ_ONLY],
    ['a thrown non-error value', { status: 500 }, TEMPAD_MCP_ERROR_CODES.SELECTION_WRITE_FAILED]
  ])('normalizes %s', async (_label, thrown, code) => {
    const page = createPage('page-1', 'Frames')
    const target = createNode('1:2', page)
    stubFigma(page)
    Object.defineProperty(page, 'selection', {
      get: () => [],
      set: () => {
        // Figma's internal runtime is not guaranteed to throw Error instances.
        throw thrown
      }
    })
    mocks.getNodeById.mockResolvedValue(target)

    const { handleSelectNode } = await importSelect()

    await expectCode(handleSelectNode({ nodeId: '1:2' }), code)
  })

  it('fails when the write is silently ignored', async () => {
    const page = createPage('page-1', 'Frames')
    const target = createNode('1:2', page)
    stubFigma(page)
    // A wrapper that accepts the assignment without applying it would otherwise report success.
    Object.defineProperty(page, 'selection', {
      get: () => [],
      set: () => {}
    })
    mocks.getNodeById.mockResolvedValue(target)

    const { handleSelectNode } = await importSelect()

    await expectCode(
      handleSelectNode({ nodeId: '1:2' }),
      TEMPAD_MCP_ERROR_CODES.SELECTION_WRITE_FAILED
    )
  })
})
