// @vitest-environment happy-dom
/**
 * Media 视图本体(P2 按设计稿重做之后)。
 *
 * 前身是 `MediaPanel.test.ts` —— 那个文件同时钉两件事:媒体视图的行为,和那个
 * 自带顶部导航的**全屏工作区容器**的导航行为。P1 拆掉容器(六个面板改成右侧
 * 工作台的页签)之后,导航那一半的守卫搬去
 * `components/workbench/__tests__/RightWorkbenchPanel.test.ts`;P2 把留下的这一半
 * 按新形态重写:分组、服务端筛选、同层详情、多选、右键菜单、两种空态、骨架。
 */
import { enableAutoUnmount, mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import MediaPanelContent from '../MediaPanelContent.vue'
import { confirmStack, settleConfirm } from '@/composables/useConfirm'
import { destroyUiOverlayHost } from '@/services/ui-overlay-host'
import type { MediaAsset } from '@/types'

/** 原生 `confirm()` 早已是 promise 服务(ui:gate 的 native-confirm 一条)。 */
async function answerConfirm(accepted: boolean): Promise<void> {
  await vi.waitFor(() => expect(confirmStack.value.length).toBeGreaterThan(0))
  settleConfirm(confirmStack.value[confirmStack.value.length - 1].id, accepted)
}

const DAY = 24 * 60 * 60 * 1000
/** 固定"今天"的锚点,免得跨零点跑测试时分组标签漂移。 */
const TODAY = new Date(2026, 7, 13, 12, 0, 0).getTime()
const YESTERDAY = TODAY - DAY

const storeState = vi.hoisted(() => ({
  mediaStore: {
    assets: [] as MediaAsset[],
    images: [] as MediaAsset[],
    isLoading: false,
    isRebuilding: false,
    loadMedia: vi.fn(),
    removeMedia: vi.fn(),
    ingestFiles: vi.fn(async () => ({
      success: true,
      assets: [] as MediaAsset[],
      created: 0,
      skipped: 0,
      errors: [] as { fileName: string; error: string }[],
    })),
    getImageUrl: vi.fn((asset: MediaAsset) => `media://${asset.id}.png`),
  },
  sessionsStore: {
    sessions: [] as { id: string; name: string }[],
  },
}))

/**
 * media 域走通用 RPC 通道之后(P4c 第三批),「读一张图的 base64」不再挂在壳上 ——
 * 它是 `mediaApi.readImageBase64({ filePath })`。
 */
const mediaClientState = vi.hoisted(() => ({
  mediaApi: {
    readImageBase64: vi.fn(async () => 'data:image/png;base64,QUJD'),
  },
}))

vi.mock('@/platform/media-client', () => mediaClientState)

const platformState = vi.hoisted(() => ({
  platformApi: {
    onImageGenerated: vi.fn(() => vi.fn()),
    openImageGallery: vi.fn(),
    openPath: vi.fn(),
    revealPath: vi.fn(),
    // 默认按**桌面**摆:localFileSystem 真、路径能拿到、剪贴板图片存在。
    // 需要 web 形态的用例自己改这几项(平台差异正是要被断言的东西)。
    capabilities: { localFileSystem: true },
    getPathForFile: vi.fn(() => ''),
    showOpenDialog: vi.fn(async () => ({ canceled: true, filePaths: [] as string[] })),
    ingestMediaFiles: vi.fn(),
    saveMediaAs: vi.fn(async (): Promise<{
      success: boolean
      canceled?: boolean
      path?: string
      error?: string
    }> => ({ success: true, path: '/tmp/copy.png' })),
    writeClipboardImage: vi.fn(async () => ({ success: true })),
  },
}))

/**
 * 假 store 必须是**响应式**的:视图把筛选交给了服务端,于是"这组条件捞不着东西"
 * 只能靠 mock 在挂载**之后**把 `assets` 换掉来表达 —— 裸对象换了不会重算。
 * 用 `reactive` 包一层并把持有位换成代理,测试仍旧照常直接赋值。
 */
vi.mock('@/stores/media', async () => {
  const { reactive } = await import('vue')
  storeState.mediaStore = reactive(storeState.mediaStore) as typeof storeState.mediaStore
  return { useMediaStore: () => storeState.mediaStore }
})

vi.mock('@/stores/sessions', () => ({
  useSessionsStore: () => storeState.sessionsStore,
}))

vi.mock('@/platform', () => ({
  platformApi: platformState.platformApi,
}))

function imageAsset(overrides: Partial<MediaAsset>): MediaAsset {
  return {
    id: 'asset-1',
    kind: 'image',
    source: 'user-upload',
    mimeType: 'image/png',
    size: 1024,
    fileName: 'upload.png',
    filePath: '/tmp/upload.png',
    links: [],
    createdAt: TODAY,
    ...overrides,
  }
}

function fileAsset(overrides: Partial<MediaAsset>): MediaAsset {
  return imageAsset({
    id: 'file-1',
    kind: 'file',
    mimeType: 'application/pdf',
    fileName: 'brief.pdf',
    filePath: '/tmp/brief.pdf',
    ...overrides,
  })
}

/** 跨两天 + 图片与文件都有的一份底料 —— 分组、状态条、序号都读它。 */
function defaultAssets(): MediaAsset[] {
  return [
    imageAsset({ id: 'upload-1', source: 'user-upload', fileName: 'pasted.png', createdAt: TODAY, size: 2048 }),
    imageAsset({
      id: 'generated-1',
      source: 'ai-generated',
      fileName: 'generated.png',
      metadata: { prompt: 'a glass city', model: 'gpt-image-1' },
      createdAt: YESTERDAY,
      size: 4096,
    }),
    fileAsset({ id: 'file-1', fileName: 'brief.pdf', createdAt: YESTERDAY, size: 1024 }),
  ]
}

function mountPanel() {
  return mount(MediaPanelContent, { attachTo: document.body })
}

/**
 * 每例结束就卸载。不是卫生习惯,是**必需**:一个留在页面上的实例还挂着自己的
 * window keydown 监听,而某些用例故意把 Select 的下拉开着走人 —— 那枚下拉的
 * esc-stack 会在捕获期吃掉下一例的 Esc,详情页于是"按了没反应"(真踩过)。
 */
enableAutoUnmount(afterEach)

describe('MediaPanelContent', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    vi.setSystemTime(TODAY)
    storeState.mediaStore.assets = defaultAssets()
    storeState.mediaStore.isLoading = false
    storeState.mediaStore.isRebuilding = false
    storeState.mediaStore.loadMedia.mockResolvedValue(undefined)
    storeState.mediaStore.removeMedia.mockResolvedValue(undefined)
    storeState.sessionsStore.sessions = []
    storeState.mediaStore.ingestFiles.mockResolvedValue({
      success: true, assets: [], created: 0, skipped: 0, errors: [],
    })
    platformState.platformApi.onImageGenerated.mockReturnValue(vi.fn())
    // 每例回到桌面形态;要 web 的用例自己翻。
    platformState.platformApi.capabilities.localFileSystem = true
    platformState.platformApi.showOpenDialog.mockResolvedValue({ canceled: true, filePaths: [] })
    platformState.platformApi.saveMediaAs.mockResolvedValue({ success: true, path: '/tmp/copy.png' })
    platformState.platformApi.writeClipboardImage.mockResolvedValue({ success: true })
    mediaClientState.mediaApi.readImageBase64.mockResolvedValue('data:image/png;base64,QUJD')
  })

  afterEach(() => {
    confirmStack.value = []
    destroyUiOverlayHost()
    vi.clearAllMocks()
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  // ── 骨架 ────────────────────────────────────────────────────────────────

  it('builds the view on the shared panel shell', () => {
    const wrapper = mountPanel()

    expect(wrapper.find('.panel-shell').exists()).toBe(true)
    expect(wrapper.find('.panel-shell-controls').exists()).toBe(true)
    expect(wrapper.find('.panel-shell-status').exists()).toBe(true)
  })

  // ── 控制区 ──────────────────────────────────────────────────────────────

  it('offers a compact search box, an "all kinds" select and a source pill', () => {
    const wrapper = mountPanel()

    expect(wrapper.find('.media-filter-bar').exists()).toBe(true)
    expect(wrapper.find('.filter-search.is-compact').exists()).toBe(true)
    // 类型下拉是**唯一**的 Select 了:来源改成分段丸。
    expect(wrapper.findAll('.app-select-control')).toHaveLength(1)
    expect(wrapper.find('.segmented-pill').exists()).toBe(true)
    expect(wrapper.findAll('.segmented-pill-item').map(item => item.text()))
      .toEqual(['全部', '上传', '生成'])
    // kind 现在有「全部」这一档,且默认停在它上面。
    expect(wrapper.find('.media-kind-filter').text()).toContain('全部')
  })

  /* 下拉是**在流内**渲染的(Select 的 `teleported` 缺省 false),住在
     `.content-header` 这个自建层叠上下文里 —— 于是工作台把 pane 关进自己的
     stacking context 之后,它照旧盖在自己的内容上。这条断言钉的就是"在流内"。 */
  it('renders the kind dropdown inside the control strip, not teleported away', async () => {
    const wrapper = mountPanel()

    await wrapper.find('.media-kind-filter .app-select-control').trigger('click')

    expect(wrapper.find('.content-header .app-select-dropdown').exists()).toBe(true)
    expect(wrapper.findAll('.media-kind-filter .app-select-option').map(o => o.text()))
      .toEqual(['全部', '图片', '文件', '音频', '视频'])
  })

  // ── 服务端筛选:loadMedia 的 query 形状 ─────────────────────────────────

  it('loads the index once on mount with an empty server query', async () => {
    mountPanel()

    await vi.waitFor(() => expect(storeState.mediaStore.loadMedia).toHaveBeenCalled())
    expect(storeState.mediaStore.loadMedia).toHaveBeenCalledWith({ rebuild: false, force: false, query: {} })
    expect(storeState.mediaStore.loadMedia).not.toHaveBeenCalledWith(expect.objectContaining({ rebuild: true }))
  })

  it('pushes kind and source into the MediaQuery instead of filtering in the browser', async () => {
    const wrapper = mountPanel()
    storeState.mediaStore.loadMedia.mockClear()

    await wrapper.find('.media-kind-filter .app-select-control').trigger('click')
    const imageOption = wrapper.findAll('.media-kind-filter .app-select-option')
      .find(option => option.text().includes('图片'))
    await imageOption!.trigger('click')

    expect(storeState.mediaStore.loadMedia).toHaveBeenLastCalledWith({
      rebuild: false,
      force: false,
      query: { kind: 'image' },
    })

    storeState.mediaStore.loadMedia.mockClear()
    await wrapper.findAll('.segmented-pill-item')[1].trigger('click')

    expect(storeState.mediaStore.loadMedia).toHaveBeenLastCalledWith({
      rebuild: false,
      force: false,
      query: { kind: 'image', source: 'user-upload' },
    })
  })

  /**
   * 「文件」这一档故意**不下发** kind:服务端是精确比较,而产品语义里
   * 文件 = `file ∪ document`,下发 `kind:'file'` 会把 document 静默吃掉。
   */
  it('keeps the file ∪ document union client-side rather than narrowing the query', async () => {
    storeState.mediaStore.assets = [
      fileAsset({ id: 'doc-1', kind: 'document', fileName: 'notes.md', createdAt: TODAY }),
      fileAsset({ id: 'file-1', kind: 'file', fileName: 'brief.pdf', createdAt: TODAY }),
      imageAsset({ id: 'img-1', createdAt: TODAY }),
    ]
    const wrapper = mountPanel()
    storeState.mediaStore.loadMedia.mockClear()

    await wrapper.find('.media-kind-filter .app-select-control').trigger('click')
    const fileOption = wrapper.findAll('.media-kind-filter .app-select-option')
      .find(option => option.text().includes('文件'))
    await fileOption!.trigger('click')

    expect(storeState.mediaStore.loadMedia).toHaveBeenLastCalledWith({
      rebuild: false,
      force: false,
      query: {},
    })
    expect(wrapper.findAll('.media-file-row')).toHaveLength(2)
    expect(wrapper.findAll('.media-tile')).toHaveLength(0)
  })

  it('debounces the search box before it reaches the query', async () => {
    const wrapper = mountPanel()
    storeState.mediaStore.loadMedia.mockClear()

    await wrapper.find('.filter-search-input').setValue('glass')
    expect(storeState.mediaStore.loadMedia).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(300)
    expect(storeState.mediaStore.loadMedia).toHaveBeenLastCalledWith({
      rebuild: false,
      force: false,
      query: { search: 'glass' },
    })
  })

  // ── 分组 ────────────────────────────────────────────────────────────────

  it('groups by day, images as a grid and files as their own group', () => {
    const wrapper = mountPanel()

    const headers = wrapper.findAll('.ledger-group-header .lgh-label').map(node => node.text())
    expect(headers).toEqual(['今天', '昨天', '文件 · 昨天'])

    const groups = wrapper.findAll('.media-group')
    expect(groups[0].findAll('.media-tile')).toHaveLength(1)
    expect(groups[1].findAll('.media-tile')).toHaveLength(1)
    expect(groups[2].findAll('.media-file-row')).toHaveLength(1)
    // 组头 sticky —— 长列表里日期要一直贴着顶。
    expect(wrapper.find('.ledger-group-header').classes()).toContain('is-sticky')
  })

  it('flips the day order when the sort toggle is pressed', async () => {
    const wrapper = mountPanel()
    expect(wrapper.find('.sort-toggle').text()).toContain('最新在前')

    await wrapper.find('.sort-toggle').trigger('click')

    expect(wrapper.find('.sort-toggle').text()).toContain('最旧在前')
    expect(wrapper.findAll('.ledger-group-header .lgh-label').map(n => n.text()))
      .toEqual(['昨天', '文件 · 昨天', '今天'])
  })

  // ── 详情 ────────────────────────────────────────────────────────────────

  it('pushes the detail view in over the pane and takes the back button home', async () => {
    const wrapper = mountPanel()

    expect(wrapper.find('.detail-view').exists()).toBe(false)
    await wrapper.findAll('.media-tile')[0].trigger('click')

    const detail = wrapper.find('.detail-view')
    expect(detail.exists()).toBe(true)
    expect(detail.find('.detail-title').text()).toBe('pasted.png')
    // 「当前 / 全部」序号按展示次序算(今天的图 → 昨天的图 → 昨天的文件)。
    expect(detail.find('.detail-index').text()).toBe('1 / 3')
    // 打开项才有字幕 scrim。
    expect(wrapper.findAll('.tile-caption')).toHaveLength(1)

    await wrapper.find('.detail-back').trigger('click')
    expect(wrapper.find('.detail-view').exists()).toBe(false)
  })

  it('walks to the next and previous asset with the arrow keys, and leaves on Esc', async () => {
    const wrapper = mountPanel()
    await wrapper.findAll('.media-tile')[0].trigger('click')

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight' }))
    await wrapper.vm.$nextTick()
    expect(wrapper.find('.detail-index').text()).toBe('2 / 3')

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft' }))
    await wrapper.vm.$nextTick()
    expect(wrapper.find('.detail-index').text()).toBe('1 / 3')

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    await wrapper.vm.$nextTick()
    expect(wrapper.find('.detail-view').exists()).toBe(false)
  })

  it('lists the spec rows and resolves the owning session title', async () => {
    storeState.mediaStore.assets = [
      imageAsset({
        id: 'generated-1',
        source: 'ai-generated',
        fileName: 'generated.png',
        width: 1024,
        height: 768,
        metadata: { prompt: 'a glass city', model: 'gpt-image-1' },
        links: [{ sessionId: 'sess-9', messageId: 'msg-2' }],
        createdAt: TODAY,
      }),
    ]
    storeState.sessionsStore.sessions = [{ id: 'sess-9', name: '玻璃城市' }]

    const wrapper = mountPanel()
    await wrapper.findAll('.media-tile')[0].trigger('click')

    const labels = wrapper.findAll('.spec-row .spec-label').map(node => node.text())
    expect(labels).toEqual(['文件名', '格式', '尺寸', '来源', '创建于', '所属会话'])
    expect(wrapper.find('.detail-body').text()).toContain('1024 × 768')
    expect(wrapper.find('.detail-body').text()).toContain('玻璃城市')
    expect(wrapper.find('.prompt-excerpt').text()).toBe('a glass city')
  })

  it('reveals a local file but hides the desktop-only actions for a served URL', async () => {
    storeState.mediaStore.assets = [imageAsset({ id: 'local-1', filePath: '/tmp/local.png', createdAt: TODAY })]
    const localWrapper = mountPanel()
    await localWrapper.findAll('.media-tile')[0].trigger('click')

    const revealButton = localWrapper.findAll('.detail-footer .text-action')
      .find(button => button.text() === '显示于访达')
    expect(revealButton).toBeTruthy()
    await revealButton!.trigger('click')
    expect(platformState.platformApi.revealPath).toHaveBeenCalledWith('/tmp/local.png')

    storeState.mediaStore.assets = [imageAsset({ id: 'served-1', filePath: '/api/media/file/served.png', createdAt: TODAY })]
    const webWrapper = mountPanel()
    await webWrapper.findAll('.media-tile')[0].trigger('click')

    const footerText = webWrapper.find('.detail-footer').text()
    expect(footerText).not.toContain('显示于访达')
    expect(footerText).not.toContain('copy path')
    expect(footerText).toContain('delete')
  })

  // ── 多选 ────────────────────────────────────────────────────────────────

  it('turns a click into a pick while in select mode and removes the picked set', async () => {
    const wrapper = mountPanel()

    await wrapper.find('.select-pill').trigger('click')
    expect(wrapper.find('.select-pill').text()).toBe('完成')
    expect(wrapper.find('.bulk-bar').exists()).toBe(true)
    expect(wrapper.findAll('.selection-mark').length).toBeGreaterThan(0)

    await wrapper.findAll('.media-tile')[0].trigger('click')
    // 多选态下点瓦片是勾选,不是打开详情。
    expect(wrapper.find('.detail-view').exists()).toBe(false)
    expect(wrapper.find('.bulk-count').text()).toBe('已选 1 项')

    const removeButton = wrapper.findAll('.bulk-bar .text-action')
      .find(button => button.text() === '移出')
    await removeButton!.trigger('click')
    await answerConfirm(true)

    await vi.waitFor(() =>
      expect(storeState.mediaStore.removeMedia).toHaveBeenCalledWith('upload-1'))
    expect(storeState.mediaStore.removeMedia).toHaveBeenCalledTimes(1)
  })

  it('picks every visible asset from the bulk bar', async () => {
    const wrapper = mountPanel()
    await wrapper.find('.select-pill').trigger('click')

    const selectAll = wrapper.findAll('.bulk-bar .text-action')
      .find(button => button.text() === '全选')
    await selectAll!.trigger('click')

    expect(wrapper.find('.bulk-count').text()).toBe('已选 3 项')
  })

  // ── 右键菜单 ────────────────────────────────────────────────────────────

  it('disables the source jump when the asset carries no usable link', async () => {
    const wrapper = mountPanel()

    await wrapper.findAll('.media-tile')[0].trigger('contextmenu')
    await wrapper.vm.$nextTick()

    const items = wrapper.findComponent({ name: 'ContextMenu' }).props('items') as {
      id: string
      disabled?: boolean
    }[]
    const byId = Object.fromEntries(items.map(item => [item.id, item]))

    expect(items.map(item => item.id)).toEqual([
      'preview', 'insert', 'copy-image', 'save-as', 'jump', 'reveal', 'remove',
    ])
    expect(byId.preview.disabled).toBe(false)
    // P3 之后三条都通了(图片 + 有路径 + 宿主接得住剪贴板图片)。
    expect(byId.insert.disabled).toBe(false)
    expect(byId['copy-image'].disabled).toBe(false)
    expect(byId['save-as'].disabled).toBe(false)
    // links 空 → 跳转禁用。
    expect(byId.jump.disabled).toBe(true)
  })

  it('keeps copy-image disabled when the asset is not an image or the host cannot do it', async () => {
    storeState.mediaStore.assets = [
      fileAsset({ id: 'doc-1', createdAt: TODAY }),
      imageAsset({ id: 'img-1', createdAt: TODAY }),
    ]
    const wrapper = mountPanel()
    const menu = wrapper.findComponent({ name: 'ContextMenu' })
    const itemById = () => Object.fromEntries(
      (menu.props('items') as { id: string; disabled?: boolean }[]).map(item => [item.id, item]))

    // 文件行不是图片 —— 「复制图片」没有主语。
    await wrapper.find('.media-file-row').trigger('contextmenu')
    await wrapper.vm.$nextTick()
    expect(itemById()['copy-image'].disabled).toBe(true)
    // 但「另存为」对文件照样成立(它只要一条路径)。
    expect(itemById()['save-as'].disabled).toBe(false)

    // 宿主接不住剪贴板图片时保持禁用,而不是按下去再报错。
    const restore = platformState.platformApi.writeClipboardImage
    ;(platformState.platformApi as { writeClipboardImage?: unknown }).writeClipboardImage = undefined
    await wrapper.findAll('.media-tile')[0].trigger('contextmenu')
    await wrapper.vm.$nextTick()
    expect(itemById()['copy-image'].disabled).toBe(true)
    ;(platformState.platformApi as { writeClipboardImage?: unknown }).writeClipboardImage = restore
  })

  it('enables the jump only when both ids are non-empty, and emits it upward', async () => {
    storeState.mediaStore.assets = [
      imageAsset({ id: 'blank-link', links: [{ sessionId: '', messageId: '' }], createdAt: TODAY }),
      imageAsset({ id: 'linked', links: [{ sessionId: 'sess-1', messageId: 'msg-1' }], createdAt: TODAY }),
    ]
    const wrapper = mountPanel()
    const menu = wrapper.findComponent({ name: 'ContextMenu' })

    await wrapper.findAll('.media-tile')[0].trigger('contextmenu')
    await wrapper.vm.$nextTick()
    let jump = (menu.props('items') as { id: string; disabled?: boolean }[]).find(i => i.id === 'jump')
    expect(jump!.disabled).toBe(true)

    await wrapper.findAll('.media-tile')[1].trigger('contextmenu')
    await wrapper.vm.$nextTick()
    jump = (menu.props('items') as { id: string; disabled?: boolean }[]).find(i => i.id === 'jump')
    expect(jump!.disabled).toBe(false)

    menu.vm.$emit('select', 'jump')
    expect(wrapper.emitted('jump-to-source')).toEqual([[{ sessionId: 'sess-1', messageId: 'msg-1' }]])
  })

  it('drops the Finder row for served URLs and folds to four rows in select mode', async () => {
    storeState.mediaStore.assets = [imageAsset({ id: 'served-1', filePath: '/api/media/file/x.png', createdAt: TODAY })]
    const wrapper = mountPanel()
    const menu = wrapper.findComponent({ name: 'ContextMenu' })

    await wrapper.findAll('.media-tile')[0].trigger('contextmenu')
    await wrapper.vm.$nextTick()
    expect((menu.props('items') as { id: string }[]).map(i => i.id)).not.toContain('reveal')

    await wrapper.find('.select-pill').trigger('click')
    await wrapper.vm.$nextTick()
    expect((menu.props('items') as { id: string }[]).map(i => i.id))
      .toEqual(['bulk-insert', 'bulk-save', 'bulk-remove', 'exit-select'])
  })

  it('opens the gallery from the preview row', async () => {
    const wrapper = mountPanel()
    await wrapper.findAll('.media-tile')[0].trigger('contextmenu')
    await wrapper.vm.$nextTick()

    wrapper.findComponent({ name: 'ContextMenu' }).vm.$emit('select', 'preview')
    expect(platformState.platformApi.openImageGallery).toHaveBeenCalledWith('upload-1')
  })

  it('removes a single asset from the menu once the ask is answered', async () => {
    const wrapper = mountPanel()
    await wrapper.findAll('.media-tile')[0].trigger('contextmenu')
    await wrapper.vm.$nextTick()

    wrapper.findComponent({ name: 'ContextMenu' }).vm.$emit('select', 'remove')
    await answerConfirm(true)

    await vi.waitFor(() =>
      expect(storeState.mediaStore.removeMedia).toHaveBeenCalledWith('upload-1'))
  })

  // ── 四态 ────────────────────────────────────────────────────────────────

  it('shows the empty library screen and dims (but keeps) the controls', () => {
    storeState.mediaStore.assets = []

    const wrapper = mountPanel()

    expect(wrapper.find('.empty-state').exists()).toBe(true)
    expect(wrapper.text()).toContain('还没有素材')
    expect(wrapper.find('.empty-state.is-filtered').exists()).toBe(false)
    expect(wrapper.find('.content-header').classes()).toContain('is-dimmed')
    // 暗下来不等于拿走 —— 控制区仍然在 DOM 里,仍然可点。
    expect(wrapper.find('.filter-search-input').exists()).toBe(true)
  })

  it('shows the filtered-empty screen instead, and clearing the filter goes home', async () => {
    const wrapper = mountPanel()

    await wrapper.findAll('.segmented-pill-item')[2].trigger('click')
    storeState.mediaStore.assets = []
    await wrapper.vm.$nextTick()

    expect(wrapper.find('.empty-state.is-filtered').exists()).toBe(true)
    expect(wrapper.text()).toContain('没有匹配的素材')
    expect(wrapper.find('.content-header').classes()).not.toContain('is-dimmed')

    const clearButton = wrapper.findAll('.empty-state .text-action')
      .find(button => button.text() === '清除筛选')
    await clearButton!.trigger('click')

    expect(wrapper.find('.empty-state.is-filtered').exists()).toBe(false)
    expect(wrapper.text()).toContain('还没有素材')
  })

  it('draws a fading skeleton on the first load, with the only spinner in the status bar', () => {
    storeState.mediaStore.assets = []
    storeState.mediaStore.isLoading = true

    const wrapper = mountPanel()

    expect(wrapper.find('.panel-skeleton').exists()).toBe(true)
    expect(wrapper.findAll('.panel-skeleton-tile')).toHaveLength(8)
    expect(wrapper.findAll('.panel-skeleton-row')).toHaveLength(2)
    expect(wrapper.find('.panel-skeleton-tile').attributes('style')).toContain('0.9')
    // 内容区永远没有 spinner —— 那是状态条的独占物(PanelShell)。
    expect(wrapper.find('.panel-shell-body .panel-shell-spinner').exists()).toBe(false)
    expect(wrapper.find('.panel-shell-status .panel-shell-spinner').exists()).toBe(true)
    expect(wrapper.find('.panel-shell-status').text()).toContain('正在索引')
  })

  it('keeps a running tally in the status bar', () => {
    const wrapper = mountPanel()

    // 2048 + 4096 + 1024 = 7168 bytes = 7 KB
    expect(wrapper.find('.panel-shell-status').text()).toBe('3 项 · 共 7 KB')
  })

  // ── P3:入库 / 插入 / 复制 / 另存 ─────────────────────────────────────────

  /** 拖放事件的最小可用替身:happy-dom 的 DragEvent 不带 dataTransfer。 */
  function dragPayload(count: number, altKey = false) {
    return {
      altKey,
      dataTransfer: {
        types: ['Files'],
        items: Array.from({ length: count }, () => ({ kind: 'file' })),
        files: [],
      },
    }
  }

  function fakeFile(name: string, type = 'image/png', size = 12): File {
    return { name, type, size } as unknown as File
  }

  it('shows the drop overlay with the live file count while a file drag hovers', async () => {
    const wrapper = mountPanel()

    expect(wrapper.find('.drop-overlay').exists()).toBe(false)

    await wrapper.find('.media-panel-content').trigger('dragenter', dragPayload(3))
    await wrapper.find('.media-panel-content').trigger('dragover', dragPayload(3))

    expect(wrapper.find('.drop-overlay').exists()).toBe(true)
    // 体积在 dragover 阶段拿不到(DataTransferItem 不给 size),所以只写文件数。
    expect(wrapper.find('.drop-meta').text()).toBe('3 个文件')
    expect(wrapper.find('.drop-chip').text()).toContain('⌥')

    await wrapper.find('.media-panel-content').trigger('dragleave', dragPayload(3))
    expect(wrapper.find('.drop-overlay').exists()).toBe(false)
  })

  it('sends dropped desktop files as paths, never as base64', async () => {
    platformState.platformApi.getPathForFile.mockReturnValue('/Users/me/shot.png')
    const wrapper = mountPanel()

    await wrapper.find('.media-panel-content').trigger('dragenter', dragPayload(1))
    await wrapper.find('.media-panel-content').trigger('drop', {
      ...dragPayload(1),
      dataTransfer: { ...dragPayload(1).dataTransfer, files: [fakeFile('shot.png')] },
    })
    await vi.waitFor(() => expect(storeState.mediaStore.ingestFiles).toHaveBeenCalled())

    expect(storeState.mediaStore.ingestFiles).toHaveBeenCalledWith({
      files: [{ filePath: '/Users/me/shot.png', fileName: 'shot.png', mimeType: 'image/png' }],
      source: 'user-upload',
    })
    // 入库后按**当前筛选**重取,不是盲目拉全量。
    await vi.waitFor(() =>
      expect(storeState.mediaStore.loadMedia).toHaveBeenCalledWith(
        expect.objectContaining({ force: true })))
  })

  it('inserts into the composer as well when ⌥ was held at release', async () => {
    platformState.platformApi.getPathForFile.mockReturnValue('/Users/me/shot.png')
    storeState.mediaStore.ingestFiles.mockResolvedValue({
      success: true,
      assets: [imageAsset({ id: 'fresh-1', fileName: 'shot.png', filePath: '/store/shot.png' })],
      created: 1,
      skipped: 0,
      errors: [],
    })
    const attached: unknown[] = []
    window.addEventListener('onething:composer-attach', event =>
      attached.push((event as CustomEvent).detail))

    const wrapper = mountPanel()
    await wrapper.find('.media-panel-content').trigger('dragenter', dragPayload(1, true))
    await wrapper.find('.media-panel-content').trigger('drop', {
      ...dragPayload(1, true),
      dataTransfer: { ...dragPayload(1, true).dataTransfer, files: [fakeFile('shot.png')] },
    })

    await vi.waitFor(() => expect(attached).toHaveLength(1))
    expect(attached[0]).toMatchObject({
      fileName: 'shot.png',
      mediaType: 'image',
      filePath: '/store/shot.png',
      // 图片顺手读出字节 → 原生投递,而不是退回路径引用。
      base64Data: 'QUJD',
    })
  })

  it('opens the host picker on desktop and the input fallback on the web', async () => {
    storeState.mediaStore.assets = []
    platformState.platformApi.showOpenDialog.mockResolvedValue({
      canceled: false,
      filePaths: ['/Users/me/a.pdf'],
    })
    const wrapper = mountPanel()

    await wrapper.find('.empty-state button').trigger('click')
    await vi.waitFor(() => expect(storeState.mediaStore.ingestFiles).toHaveBeenCalledWith({
      files: [{ filePath: '/Users/me/a.pdf', fileName: 'a.pdf' }],
      source: 'user-upload',
    }))

    // web:没有本地文件系统 → 不问宿主对话框,点隐藏的 <input type=file>。
    platformState.platformApi.capabilities.localFileSystem = false
    platformState.platformApi.showOpenDialog.mockClear()
    const webWrapper = mountPanel()
    const input = webWrapper.find('input[type="file"]')
    const click = vi.spyOn(input.element as HTMLInputElement, 'click')

    await webWrapper.find('.empty-state button').trigger('click')
    expect(click).toHaveBeenCalled()
    expect(platformState.platformApi.showOpenDialog).not.toHaveBeenCalled()
  })

  it('copies an image through the host clipboard and reports the outcome', async () => {
    const wrapper = mountPanel()
    await wrapper.findAll('.media-tile')[0].trigger('contextmenu')
    await wrapper.vm.$nextTick()

    wrapper.findComponent({ name: 'ContextMenu' }).vm.$emit('select', 'copy-image')
    await vi.waitFor(() =>
      expect(platformState.platformApi.writeClipboardImage).toHaveBeenCalledWith('/tmp/upload.png'))
    await vi.waitFor(() =>
      expect(wrapper.find('.panel-shell-status').text()).toBe('已复制图片'))
  })

  it('saves one asset through the host dialog and stays quiet on cancel', async () => {
    const wrapper = mountPanel()
    await wrapper.findAll('.media-tile')[0].trigger('contextmenu')
    await wrapper.vm.$nextTick()

    platformState.platformApi.saveMediaAs.mockResolvedValue({ success: false, canceled: true })
    wrapper.findComponent({ name: 'ContextMenu' }).vm.$emit('select', 'save-as')
    await vi.waitFor(() => expect(platformState.platformApi.saveMediaAs).toHaveBeenCalledWith({
      filePath: '/tmp/upload.png',
      fileName: 'pasted.png',
    }))
    // 取消不是失败,状态条不该冒一句"另存失败"。
    expect(wrapper.find('.panel-shell-status').text()).toBe('3 项 · 共 7 KB')
  })

  it('asks for a directory once and then saves every picked asset into it', async () => {
    platformState.platformApi.showOpenDialog.mockResolvedValue({
      canceled: false,
      filePaths: ['/Users/me/Desktop'],
    })
    const wrapper = mountPanel()

    await wrapper.find('.select-pill').trigger('click')
    const selectAll = wrapper.findAll('.bulk-bar .text-action')
      .find(button => button.text() === '全选')
    await selectAll!.trigger('click')

    const saveAll = wrapper.findAll('.bulk-bar .text-action')
      .find(button => button.text() === '另存为')
    await saveAll!.trigger('click')

    await vi.waitFor(() =>
      expect(platformState.platformApi.saveMediaAs).toHaveBeenCalledTimes(3))
    // 一次目录选择,三次静默复制 —— 不是三次保存框。
    expect(platformState.platformApi.showOpenDialog).toHaveBeenCalledTimes(1)
    expect(platformState.platformApi.showOpenDialog).toHaveBeenCalledWith(
      expect.objectContaining({ properties: ['openDirectory'] }))
    expect(platformState.platformApi.saveMediaAs).toHaveBeenCalledWith(
      expect.objectContaining({ targetDir: '/Users/me/Desktop' }))
  })

  it('references the open asset in the chat from the detail footer', async () => {
    const attached: unknown[] = []
    window.addEventListener('onething:composer-attach', event =>
      attached.push((event as CustomEvent).detail))

    const wrapper = mountPanel()
    await wrapper.findAll('.media-tile')[0].trigger('click')
    await wrapper.vm.$nextTick()

    const reference = wrapper.findAll('.detail-footer .text-action')
      .find(button => button.text() === '在聊天中引用')
    await reference!.trigger('click')

    await vi.waitFor(() => expect(attached).toHaveLength(1))
    expect(attached[0]).toMatchObject({ fileName: 'pasted.png', mediaType: 'image' })
  })
})
