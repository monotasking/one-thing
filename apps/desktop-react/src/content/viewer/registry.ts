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
 *   registerViewer     型处理器:match → Body(+ 可选 viewModes / status)
 *   registerNavigator  ⌘L 跳转条的候选提供者(**跳转只有这一个入口**)
 *   registerKeymap     键位档:模式标 / 命令行 / 状态栏那个开关(键位路由归响应链)
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

/**
 * **一档看法**(W7-c)。`markdown` 的「渲染 / 源码」是今天唯一一组。
 * 它是纯数据:菜单读它画一行 `MenuItem checked`,选中就把 `patch` 打进 `view`。
 */
export interface ViewerViewMode {
  id: string
  labelKey: MessageKey
  /** 此刻是不是这一档(菜单里那个勾)。 */
  on(view: ViewerView): boolean
  /** 选它 = 往 `view` 上打这一格补丁。 */
  patch: Partial<ViewerView>
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
  /**
   * **这一型自己那组互斥的看法**(W7-c;从前是 `Toolbar` 那件 React 元素)。
   *
   * 改成**数据**而不是组件,是因为它的落点从「叶檐上一格工具条」搬进了
   * **内容区自己的右键菜单**(W7-c 裁定 2:动作单产地是右键菜单,顶栏不再有
   * 内容工具条槽位)。菜单里一行就是一行,它要的不是一件会自己读 store 的组件,
   * 而是「有哪几档、此刻是哪一档、选它写什么」这三句话 —— 交组件的话菜单还得
   * 反过来去猜它渲染出了什么。
   */
  viewModes?: readonly ViewerViewMode[]
  /** 那一组的小标题(菜单里那一节的名字)。有 `viewModes` 就得有它。 */
  viewModesLabelKey?: MessageKey
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

  /** 认领了就给,都不认就是 undefined(**不落兜底** —— 判词在 `resolveViewerByKind`)。 */
  matchOnly(file: ViewerFile): ViewerHandler | undefined {
    return this.handlers.find((h) => h.match(file))
  }

  /**
   * 摘掉一个处理器。**唯一的用户是 HMR 退役**(见下面 disposeViewerKind)——
   * 产品运行期没有「卸载一种文件型」这回事,所以它不出现在 registerViewer 旁边
   * 的公开 API 里,而是走那一口专门的拆卸函数。
   */
  unregister(id: string): void {
    const at = this.handlers.findIndex((h) => h.id === id)
    if (at >= 0) this.handlers.splice(at, 1)
    if (this.fallbackId === id) this.fallbackId = undefined
  }
}

const viewers = new ViewerHandlerRegistry()

export function registerViewer(handler: ViewerHandler, options?: { fallback?: boolean }): void {
  viewers.register(handler, options)
}

export function resolveViewer(file: ViewerFile): ViewerHandler {
  return viewers.resolve(file)
}

/**
 * **只知道「是哪一型」时取处理器**(W7-c)。
 *
 * 内容区的右键菜单要在文件**还没读进来**时就说得出「视图」那一节画不画
 * (树行上右键的那一路手上一个字节都没有),而它手上只有 `data/viewer-kinds`
 * 那张纯表预判出来的 `kind`。
 *
 * 这一句合法的理由写在 `ViewerHandler.match` 上:**每个处理器的 match 一律只读
 * `file.kind`**(那条规矩就写在那格字段上 —— 不许自己再抄一份扩展名名单)。
 * 所以一个只带 `kind` 的探针恰好是它们真正读的那一格;哪天有处理器违约去读别的
 * 字段,它在这里会答不出来,而不是答错。
 */
export function resolveViewerByKind(kind: ViewerFile['kind']): ViewerHandler | undefined {
  const probe = { kind } as ViewerFile
  return viewers.ids().length > 0 ? viewers.matchOnly(probe) : undefined
}

export function registeredViewerIds(): string[] {
  return viewers.ids()
}

/**
 * **HMR 退役的唯一一口**(09-01 立法:模块级副作用必须配 dispose)。
 *
 * 这三张表都是**模块级单例注册**,而且都「重复注册即抛」——热更时旧模块不退役,
 * 新模块 import 进来当场抛「查看器型重复注册」,整块面白屏。生产构建里
 * `import.meta.hot` 是 undefined,调用点整段被 tree-shake。
 *
 * 三张表共用这一口而不是各写各的:注册在一个文件里,拆卸也该在同一个文件里
 * (「不许写第二套:两套拆卸迟早漏一格」)。
 */
export function disposeRegistrations(options: {
  viewers?: readonly string[]
  navigators?: readonly string[]
  keymaps?: readonly string[]
}): void {
  for (const id of options.viewers ?? []) viewers.unregister(id)
  for (const id of options.navigators ?? []) {
    const at = navigators.findIndex((n) => n.id === id)
    if (at >= 0) navigators.splice(at, 1)
  }
  for (const id of options.keymaps ?? []) {
    const at = keymaps.findIndex((k) => k.id === id)
    if (at >= 0) keymaps.splice(at, 1)
  }
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
 * ── 键位**路由**已经不在这张表里了(09-03 R2)────────────────────────────
 * 从前这里还有一格 `bindings: Record<string, ViewerCommand>`(`mod+s` 那种写法)
 * 与一只 `commandFor` 纯函数,查看器把它挂在自己根元素上当面域局部键。R2 把
 * 面域局部键整族迁进了响应链:声明的正本是 `focus/scopes.ts` 的
 * `FOCUS_SCOPES.viewer.keys`,落点是 `FileViewer` 交给 `<FocusScope>` 的
 * `keyHandlers`。留着 `bindings` 就是同一份声明的第二个产地 —— 而两个产地
 * 迟早分叉,分叉那天没有一条测试会红,只有用户按下去发现响的是上一版。
 *
 * **键位档本身留着**:它管的是模式标(Vim 的 NORMAL / INSERT)、命令行那一条、
 * 与状态栏上那个开关 —— 那几件与「哪个键做哪件事」不是一回事。
 * 留账:vim 档将来要改键位路由时,改的是 `FOCUS_SCOPES.viewer.keys` 怎么按档
 * 取值,不是把 bindings 加回来(那是拍板件,不该被顺手改动替用户回答)。
 */
export interface ViewerKeymap {
  id: string
  nameKey: MessageKey
  /** 模式标(Vim 档才有)。空 = 无模式。 */
  modes?: readonly string[]
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
