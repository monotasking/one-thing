/**
 * 右栏开合初值(im-workbench-layout.md W-Q2)。
 *
 * 这个文件的前身是 `useShellMode.test.ts` —— C0 的 workbench↔classic 回滚闸已于
 * 2026-08-05 退役(docs/design/product-two-forms-chatgpt-shell.md D2),形态判定
 * 那一半跟着删了,只剩右栏初值这一半。
 *
 * 两类断言:
 *  1. 纯函数 —— 右栏初值,直接喂数据;
 *  2. 源文件文本 —— 挂载线与 CSS 纪律只存在于源文件里,vue-test-utils 不套用
 *     scoped CSS,渲染断言看不见它们,所以直接读源文件。
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  WORKBENCH_INSPECTOR_MIN_VIEWPORT_WIDTH,
  resolveInspectorDefaultOpen,
} from '../useInspectorDefault'

function readRendererFile(relativePath: string) {
  return readFileSync(new URL(`../../${relativePath}`, import.meta.url), 'utf8')
}

describe('resolveInspectorDefaultOpen', () => {
  const wide = WORKBENCH_INSPECTOR_MIN_VIEWPORT_WIDTH
  const base = { stored: null }

  it('阈值就是 W-Q2 拍板的 1400', () => {
    expect(WORKBENCH_INSPECTOR_MIN_VIEWPORT_WIDTH).toBe(1400)
  })

  it('没存过时按窗宽给默认值(≥1400 展开)', () => {
    expect(resolveInspectorDefaultOpen({ ...base, viewportWidth: wide })).toBe(true)
    expect(resolveInspectorDefaultOpen({ ...base, viewportWidth: wide + 200 })).toBe(true)
    expect(resolveInspectorDefaultOpen({ ...base, viewportWidth: wide - 1 })).toBe(false)
    expect(resolveInspectorDefaultOpen({ ...base, viewportWidth: 1200 })).toBe(false)
  })

  it('窗宽取不到就当窄窗:宁可少开,不要把中栏挤没', () => {
    expect(resolveInspectorDefaultOpen({ ...base, viewportWidth: Number.NaN })).toBe(false)
    expect(resolveInspectorDefaultOpen({ ...base, viewportWidth: 0 })).toBe(false)
  })

  it('存过的用户选择永远胜出 —— 默认不是强制', () => {
    expect(resolveInspectorDefaultOpen({ viewportWidth: 1920, stored: false })).toBe(false)
    expect(resolveInspectorDefaultOpen({ viewportWidth: 1000, stored: true })).toBe(true)
  })
})

describe('App.vue 的挂载线', () => {
  const app = readRendererFile('App.vue')

  it('右栏初值只算一次,且等设置真的落地之后', () => {
    const mounted = app.slice(app.indexOf('settingsStore.loadSettings(),'))
    expect(mounted.slice(0, 200)).toContain('applyInspectorDefaultOnce()')
    expect(app).toContain('let inspectorDefaultApplied = false')
  })

  /**
   * 落点自外壳布局收敛 L0 起统一在 `layoutPrefs` store(单 key
   * `onething.layout.v1`),旧的裸 `localStorage['inspectorOpen']` 由 store 首次读时
   * 迁移并删除。仍然**不开 appState 字段** —— 那一条判决没变,只是换了落点。
   */
  it('用户的开合落盘,归 layoutPrefs store(不另开 appState 字段)', () => {
    expect(app).toContain('stored: layoutPrefs.workbenchOpen,')
    expect(app).toContain('layoutPrefs.setWorkbenchOpen(open)')
    // App.vue 自己不再碰 localStorage —— 布局偏好只有 store 一个读写点。
    expect(app).not.toContain("const INSPECTOR_OPEN_STORAGE_KEY = 'inspectorOpen'")
    expect(app).not.toContain('function readStoredInspectorOpen')
    expect(app).not.toContain('function writeStoredInspectorOpen')
  })

  /**
   * 外壳形态开关(workbench↔classic)于 2026-08-05 整套退役:U0 删了判定与设置
   * 字段,U0b 删了 CSS 门与根属性本身。这条钉住它没被人加回来 —— 再加一个同名
   * 不同物的"形态"会和 U3 的产品形态搅在一起。
   */
  it('外壳形态开关连根没了:根属性、判定、CSS 门一个不剩', () => {
    // 扫**用法**不扫字面量 —— 那段说明它为什么被删的注释当然会提到这个名字。
    expect(app).not.toContain("setAttribute('data-shell-mode'")
    expect(app).not.toMatch(/\[data-shell-mode/)
    expect(app).not.toContain('resolveShellMode')
    expect(app).not.toMatch(/watch\(shellMode/)
  })
})

describe('ChatPanel 的阅读列纪律', () => {
  const chatPanel = readRendererFile('components/chat/ChatPanel.vue')

  it('阅读列公式拆成变量后展开仍与改造前逐字符等价', () => {
    expect(chatPanel).toContain('--chat-measure-cap: max(58%, calc(100% - 144px));')
    expect(chatPanel).toContain('--chat-content-width: min(var(--content-measure, 46rem), var(--chat-measure-cap));')
    /* L5:窄栏降级从窗口宽改成**这一格聊天面自己的宽度**(P7)。容器由宿主承担
       (`.tab-content` / `.thread-chat-detail`)—— 元素查不了自己。 */
    expect(chatPanel).toContain('@container chat-surface (max-width: 768px)')
    expect(chatPanel).not.toContain('@media (max-width: 768px)')
  })

  /**
   * 纪律仍然成立:谁要在 `.chat-panel` 上加高特异性的覆盖,只许改
   * `--content-measure` / `--chat-measure-cap` 这两枚**输入**变量。直接写派生的
   * `--chat-content-width` 会压过本文件末尾 768 / 480 两个 `@container` 里 (0,1,0)
   * 的 `.chat-panel` 覆盖,把窄窗降级整个废掉。
   */
  it('不许有人直接写派生的 --chat-content-width 去压窄窗降级', () => {
    const lines = chatPanel.split('\n')
    const overrides = lines.reduce<string[]>((blocks, line, index) => {
      const selector = line.trimStart()
      if (selector.startsWith(':root[') || selector.startsWith('html[')) {
        blocks.push(lines.slice(index, index + 6).join('\n'))
      }
      return blocks
    }, [])

    for (const block of overrides) {
      expect(block).not.toContain('--chat-content-width:')
    }
    expect(chatPanel).toContain('@container chat-surface (max-width: 480px)')
  })

  /**
   * 容器必须由**宿主**声明:`.chat-panel` 是查询的主语,而 `container-type` 只为
   * **后代**建容器 —— 元素查不了自己。少一处宿主 = 那一份聊天面的窄栏降级静默失效
   * (只会在真机上看出来),所以两处宿主都钉住。
   */
  it('两处聊天面宿主都声明了 chat-surface 容器', () => {
    const chatWindow = readRendererFile('components/chat/ChatWindow.vue')
    const threadDetail = readRendererFile('components/workbench/ThreadChatDetail.vue')

    for (const source of [chatWindow, threadDetail]) {
      expect(source).toContain('container-type: inline-size;')
      expect(source).toContain('container-name: chat-surface;')
    }
  })

  /* 侧栏那条窄窗 `@media` 在 L5 删除(理由写在它原来的位置):窄窗降级的唯一事实
     在 `useShellLayout` 的预算里,CSS 里再留一条按窗口宽走的路就是 P7 本身。 */
  it('侧栏不再有按窗口宽走的第二条降级路', () => {
    const sidebar = readRendererFile('components/sidebar/Sidebar.vue')
    // 扫**规则**不扫字面量 —— 那段说明它为什么被删的注释当然会提到这个查询。
    expect(sidebar.split('\n').filter(line => line.trimStart().startsWith('@media'))).toEqual([])
  })
})
