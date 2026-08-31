import type { ComponentType } from 'react'
import type { MessageKey } from '../../i18n'
import type { ViewerFile, ViewerView } from '../../data/viewer-source'

/**
 * **查看器 = 壳,能力从三张注册表来**(08-31 claude design 定稿的核心改判)。
 *
 * 从前的写法是查看器自己 `switch (kind)`:加一种型 = 改查看器。定稿把它翻过来 ——
 * 查看器只画头(身份与去向)、脚(状态栏)、跳转条、编辑与确认这几件**公共**的事;
 * 「这种文件长什么样」「⌘L 能跳到哪儿」「哪个键做哪件事」分别由三张表回答:
 *
 *   registerViewer     型处理器:match → Body(+ 可选 Toolbar / status)
 *   registerNavigator  ⌘L 跳转条的候选提供者(**跳转只有这一个入口**)
 *   registerKeymap     键位档:把手势映射到**已注册的能力**,不新增能力
 *
 * 三张表共用同一套规矩(与块注册表 `content/blocks/registry.ts` 逐条同款):
 *  1. **重复注册 = 抛错**,不静默覆盖 —— 静默后胜会让「我改了怎么没生效」变成
 *     一小时的排查;
 *  2. **注册只发生在一个 barrel**(`./kinds/index.ts` 等),import 那个文件就是
 *     「这台上有哪些型 / 哪些跳法 / 哪些键位档」,一眼看全;
 *  3. **查不到不是错误**:型查不到落兜底处理器(诚实态),跳法查不到就没有那一行。
 *
 * ── 处理器碰不到头和脚 ────────────────────────────────────────────────────
 * 与块壳同一条分界:处理器**只给 body**,外加两件**声明**(脚上那几格开关、
 * 状态栏左段那句「语言/编码」)。这条分界买到的是「查看器长什么样」的结构保证 ——
 * 头上的路径复制、未保存丸、打开方式,在任何一种型下都在同一个位置、同一种画法,
 * 新型的作者根本没有做错的机会,因为那些代码不在他手里。
 */

/* ── ① 型处理器 ────────────────────────────────────────────────────────── */

/** 处理器画 body 时手上有的东西。**只读事实 + 一组窄回调**,没有 store。 */
export interface ViewerBodyProps {
  file: ViewerFile
  view: ViewerView
  /**
   * 改一格看的姿势(图的缩放、折行开关都走它)。
   *
   * **当前行不在这里落点** —— 它只由 ⌘L 跳转条落(定稿:跳转只有那一个入口)。
   * 从前这里有一条 `onCurrentLine`,让「点一行」也能落点;砍掉的理由是无障碍:
   * 一行代码不是控件,给它挂点击必须同时给键盘路径,而给每一行配一颗按钮会把
   * 整份文件在读屏里念成一列按钮。少一个入口,换一条干净的可达性。
   */
  onView(patch: Partial<ViewerView>): void
  /** 去文件管理器。宿主给 —— 诚实态那颗钮要它。 */
  onReveal?: () => void
}

/** 脚上那几格开关里,**这一型自己**的那些(壳画公共的三格)。 */
export interface ViewerStatusItem {
  id: string
  labelKey: MessageKey
  /** 按下去了没有(aria-pressed 的那一格)。 */
  on?: boolean
  onToggle(): void
}

export interface ViewerHandler {
  /** 表里的键,也是 `data-viewer-kind` 的值。 */
  id: string
  /**
   * 认不认这一份文件。**判据一律来自 `data/viewer-kinds.ts` 那张纯表** ——
   * 处理器这里只写一行委托,不许自己再抄一份扩展名名单(两处必然分叉)。
   */
  match(file: ViewerFile): boolean
  Body: ComponentType<ViewerBodyProps>
  /** 头上那一格「这一型自己的动作」(折行 / 源码⇄渲染 / 缩放两档)。 */
  Toolbar?: ComponentType<ViewerBodyProps>
  /** 状态栏左段那句「语言 · 编码 · 换行符」—— 只有处理器知道该说什么。 */
  status?(props: ViewerBodyProps): string | undefined
  /** 状态栏右段这一型自己的开关(折行就是这么来的)。 */
  statusItems?(props: ViewerBodyProps): ViewerStatusItem[]
  /**
   * 这一型的 body **按行寻址吗**;回行数,不按行寻址就缺席。
   *
   * 它是壳判断「要不要画『行 n:1 ⌘L』那一格、⌘L 开不开得动」的**唯一**判据 ——
   * 写成「id === 'code'」的话,壳就又认识具体的型了(那正是这三张表要拆掉的)。
   */
  lineCount?(props: ViewerBodyProps): number | undefined
  /** 这一型能不能编辑(铅笔露不露出来)。缺席 = 不能。 */
  editable?: boolean
}

class ViewerHandlerRegistry {
  private readonly handlers: ViewerHandler[] = []
  private fallbackId: string | undefined

  register(handler: ViewerHandler, options?: { fallback?: boolean }): void {
    if (this.handlers.some((h) => h.id === handler.id)) {
      throw new Error(`查看器型重复注册:${handler.id}(同一个 id 只能有一个处理器)`)
    }
    this.handlers.push(handler)
    if (options?.fallback) this.fallbackId = handler.id
  }

  /** 按注册次序取第一个认领的;都不认就落兜底。 */
  resolve(file: ViewerFile): ViewerHandler {
    const hit = this.handlers.find((h) => h.match(file))
    if (hit) return hit
    const fallback = this.handlers.find((h) => h.id === this.fallbackId)
    if (!fallback) {
      // 走到这里说明注册 barrel 没被 import —— 这是装配错误不是内容错误。
      throw new Error('查看器注册表还没装:兜底处理器缺席(是不是漏了 import ./kinds)')
    }
    return fallback
  }

  ids(): string[] {
    return this.handlers.map((h) => h.id)
  }
}

const viewers = new ViewerHandlerRegistry()

export function registerViewer(handler: ViewerHandler, options?: { fallback?: boolean }): void {
  viewers.register(handler, options)
}

export function resolveViewer(file: ViewerFile): ViewerHandler {
  return viewers.resolve(file)
}

export function registeredViewerIds(): string[] {
  return viewers.ids()
}

/* ── ② 跳转提供者(⌘L 是唯一入口)──────────────────────────────────────── */

export interface ViewerJumpCandidate {
  id: string
  /** 屏幕上那一行字。 */
  label: string
  /** 落点(1 基行号)。 */
  line: number
  /** 次要说明(第几个命中、哪一段 diff …)。 */
  hint?: string
}

export interface ViewerNavigatorContext {
  file: ViewerFile
  /** 这份内容一共几行(行号档要它夹范围)。 */
  lineCount: number
}

export interface ViewerNavigator {
  id: string
  /**
   * 触发它的前缀符号。空串 = 没有前缀(输入纯数字就是它)。
   * `#` 符号、`/` 检索 …… 一格一个符号,不许两个提供者抢同一个。
   */
  sigil: string
  labelKey: MessageKey
  /**
   * 给候选。**缺席 = 还没接上**:跳转条把它画成一行灰的,说出「还没接上」,
   * 而不是把它藏起来(同「打开方式」那六档的诚实降级 —— 藏起来的能力
   * 接上那天没人会去找)。
   */
  list?(query: string, ctx: ViewerNavigatorContext): ViewerJumpCandidate[]
  /**
   * 这一档的候选是**一串要走一遍的命中**,还是一个落点。
   *
   * true(检索档)= 落一次点之后**跳转条不关**,↵ 再按一下走到下一个、绕回第一个;
   * 缺席(行号档)= 落点即达,跳完就收 —— 「跳到第 42 行」没有「下一个 42 行」。
   * 判据放在提供者身上而不是壳里的一个 `id === 'search'`,理由与 `lineCount`
   * 那一条逐字相同:壳一旦认识具体的档,这张表就白分了。
   */
  cycle?: boolean
}

const navigators: ViewerNavigator[] = []

export function registerNavigator(navigator: ViewerNavigator): void {
  if (navigators.some((n) => n.id === navigator.id)) {
    throw new Error(`跳转提供者重复注册:${navigator.id}`)
  }
  if (navigators.some((n) => n.sigil === navigator.sigil)) {
    throw new Error(`跳转前缀被占了:「${navigator.sigil}」(一个符号只能有一个提供者)`)
  }
  navigators.push(navigator)
}

export function listNavigators(): readonly ViewerNavigator[] {
  return navigators
}

/**
 * 一句输入 → 哪个提供者接。最长前缀优先,谁都不匹配就落空前缀那一个(行号档)。
 * **这是跳转条唯一的分岔点** —— 滚动、高亮、历史统统归壳。
 */
export function navigatorFor(query: string): ViewerNavigator | undefined {
  const withSigil = navigators
    .filter((n) => n.sigil && query.startsWith(n.sigil))
    .sort((a, b) => b.sigil.length - a.sigil.length)[0]
  return withSigil ?? navigators.find((n) => n.sigil === '')
}

/* ── ③ 键位档 ──────────────────────────────────────────────────────────── */

/**
 * 键位能触发的**全部**能力。这张联合是封闭的,而且刻意与查看器已有的动作一一对应
 * ——「键位只把手势映射到已注册能力,**不新增能力**」是定稿的原话:一个键位档
 * 不该能做出一件用鼠标做不到的事。
 */
export type ViewerCommand = 'save' | 'jump' | 'find' | 'toggleWrap' | 'toggleEdit' | 'close'

/**
 * `find`(⌘F)与 `jump`(⌘L)不是两条路,是**同一条路的两个入口**:
 * 两者都开那一条跳转条,差别只在 ⌘F 把 `/` 那个前缀先替用户打上 ——
 * 于是「检索」在这台上没有第二套 UI、第二套键、第二处高亮。
 */

export interface ViewerKeymap {
  id: string
  nameKey: MessageKey
  /** 模式标(Vim 档才有)。空 = 无模式。 */
  modes?: readonly string[]
  /** 组合键 → 能力。键的写法:`mod+s`(mod = ⌘ / Ctrl)。 */
  bindings: Record<string, ViewerCommand>
  /**
   * 底部那条 `:` 命令行(Vim 档)。**F1 只立表形与状态栏开关位**,
   * hjkl / gg / G / :42 / `/搜索` 的绑定实现留后批 —— 留账写在 keymaps.ts。
   */
  commandLine?: boolean
  /** 绑定是不是真接上了。false = 状态栏照常给开关,但只有默认那两条键真响。 */
  implemented?: boolean
}

const keymaps: ViewerKeymap[] = []

export function registerKeymap(keymap: ViewerKeymap): void {
  if (keymaps.some((k) => k.id === keymap.id)) {
    throw new Error(`键位档重复注册:${keymap.id}`)
  }
  keymaps.push(keymap)
}

export function listKeymaps(): readonly ViewerKeymap[] {
  return keymaps
}

export function keymapById(id: string): ViewerKeymap | undefined {
  return keymaps.find((k) => k.id === id)
}

/**
 * 一次按键 → 一件能力(或什么都不是)。**纯函数**,所以键位表逐条钉得死。
 * 组合写法与 `keymap/transitions.ts` 的出厂表同一口径:mod = ⌘(mac)/ Ctrl。
 */
export function commandFor(
  keymap: ViewerKeymap | undefined,
  event: { key: string; metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; altKey: boolean },
): ViewerCommand | undefined {
  if (!keymap) return undefined
  const parts: string[] = []
  if (event.metaKey || event.ctrlKey) parts.push('mod')
  if (event.shiftKey) parts.push('shift')
  if (event.altKey) parts.push('alt')
  parts.push(event.key.toLowerCase())
  return keymap.bindings[parts.join('+')]
}
