import type { FocusScopeId, FocusScopeSpec, ScopedKey } from './types'

/**
 * **作用域封闭表**(R0)。一格 = 一种「能接键盘的面」的**声明**:它的行为档、
 * 它的名字、它自己那几个局部键。树上有几份实例与这张表无关(§4.8)。
 *
 * ── 加一格的规矩 ────────────────────────────────────────────────────────
 * 加一个作用域 = ①这张表加一行 ②`types.ts` 的 `FocusScopeId` 加一格
 * ③它的 labelKey 在 zh/en 两本字典里成对存在。三件缺一件当场红
 * (`__tests__/scopes.test.ts`)。**这张表是封闭的**:没有「运行时注册一个新
 * 作用域种类」这条路 —— 那正是浮层栈那种「谁在上面靠猜」的来源。
 *
 * ── labelKey 为什么有的复用有的新开 ──────────────────────────────────────
 * i18n 纪律是「同一句话只该有一个键」。查看器已经有 `viewer.label`、Dock 已经有
 * `dock.label`、四块内容面在 Dock 瓦上已经有 `item.*` —— 再开一份
 * `focus.scope.viewer` 就是同一句话的第二个产地。所以**能复用的复用,真缺的才补**,
 * 补的那 14 条统一在 `focus.scope.*` 家族下。哪一格复用了谁,下表 labelKey 那一列
 * 自己写着。
 *
 * ── 局部键:今天只有两格有 ───────────────────────────────────────────────
 * `viewer` 三条、`files` 两条 —— 它们是从 `keymap/scopes.ts` 的 `SCOPED_KEYS`
 * **搬进来**的(R0 只搬声明,落点仍在各面自己的 element listener 上,R2 才迁)。
 * 旧那张表现在从这里派生,所以两处不可能分叉:它们是同一份数据的两种投影。
 *
 * 一格声明的变化:旧表里叫 `files.row`(键长在**行**上),这里归到 `files`
 * 作用域名下 —— 树上不会有「一行」这么细的作用域(行是文件树内部的 roving 目标,
 * 不是一块能接键盘的面)。旧 id 由 `keymap/scopes.ts` 的兼容表原样发出去,
 * 所以既有测试与既有读者一个字都不用改;R2 迁落点时那格兼容表随之退役。
 */

const VIEWER_KEYS: readonly ScopedKey[] = [
  { scope: 'viewer', combo: { meta: true, key: 's' }, labelKey: 'viewer.save', action: 'save' },
  { scope: 'viewer', combo: { meta: true, key: 'l' }, labelKey: 'viewer.jumpLabel', action: 'jump' },
  { scope: 'viewer', combo: { meta: true, key: 'f' }, labelKey: 'viewer.findLabel', action: 'find' },
]

/**
 * 文件树两条键面同一个动作(⌘I 与 ⌘↵ 都是「详情」)。**两行,不是一行两键**:
 * 表要能逐条说出「⌘↵ 被谁占着」,一行装两个组合就说不出口了。
 */
const FILES_KEYS: readonly ScopedKey[] = [
  { scope: 'files', combo: { meta: true, key: 'i' }, labelKey: 'files.detailAction', action: 'detail' },
  {
    scope: 'files',
    combo: { meta: true, key: 'enter' },
    labelKey: 'files.detailAction',
    action: 'detail',
  },
]

export const FOCUS_SCOPES: Readonly<Record<FocusScopeId, FocusScopeSpec>> = {
  /* ── root:整台壳,只有一个 ──────────────────────────────────────────── */
  root: { id: 'root', kind: 'root', labelKey: 'a11y.appTitle' },

  /* ── region:内容面(§4.1 第三行)───────────────────────────────────── */
  viewer: { id: 'viewer', kind: 'region', labelKey: 'viewer.label', keys: VIEWER_KEYS },
  files: { id: 'files', kind: 'region', labelKey: 'item.files', keys: FILES_KEYS },
  composer: { id: 'composer', kind: 'region', labelKey: 'focus.scope.composer' },
  search: { id: 'search', kind: 'region', labelKey: 'item.search' },
  expose: { id: 'expose', kind: 'region', labelKey: 'item.sessions' },
  chat: { id: 'chat', kind: 'region', labelKey: 'focus.scope.chat' },
  settings: { id: 'settings', kind: 'region', labelKey: 'item.settings' },
  dock: { id: 'dock', kind: 'region', labelKey: 'dock.label' },

  /* ── layer:四个 Placement 宿主(§4.1 第二行)────────────────────────── */
  'stage-layer': { id: 'stage-layer', kind: 'layer', labelKey: 'focus.scope.stageLayer' },
  'float-layer': { id: 'float-layer', kind: 'layer', labelKey: 'focus.scope.floatLayer' },
  'shelf-layer': { id: 'shelf-layer', kind: 'layer', labelKey: 'focus.scope.shelfLayer' },
  'cover-layer': { id: 'cover-layer', kind: 'layer', labelKey: 'focus.scope.coverLayer' },

  /* ── float:非模态临时面,Esc 缺省关自己 ─────────────────────────────── */
  jumpbar: { id: 'jumpbar', kind: 'float', labelKey: 'focus.scope.jumpbar' },
  drawer: { id: 'drawer', kind: 'float', labelKey: 'focus.scope.drawer' },
  zoom: { id: 'zoom', kind: 'float', labelKey: 'focus.scope.zoom' },
  tooltip: { id: 'tooltip', kind: 'float', labelKey: 'focus.scope.tooltip' },

  /* ── modal:Tab 出不去 ──────────────────────────────────────────────── */
  dialog: { id: 'dialog', kind: 'modal', labelKey: 'focus.scope.dialog' },
  menu: { id: 'menu', kind: 'modal', labelKey: 'focus.scope.menu' },
  palette: { id: 'palette', kind: 'modal', labelKey: 'focus.scope.palette' },
  /*
   * **popover 归 modal,不是 float**(R1 收编时改的一格,设计 §4.1 那张表里它
   * 写在 float 行)。理由是那张表的 `float` 行括号里写着「非模态」,而**那个
   * 「模态」说的是 ARIA**(要不要 `aria-modal`、读屏能不能看见外面);行为档
   * `modal` 说的是**Tab 走不走得出去**,两个词在这里刚好错开。
   * `ui/Popover` 今天就在圈禁 Tab(它消费 `useFocusTrap`,文件头写着「圈禁与
   * aria-modal 是两件事:附属浮层要前者不要后者」)。归 float 会当场少掉圈禁 ——
   * 那是可感知的行为变化,而 R1 守的是逐条相同。所以按**它今天的行为**归档。
   */
  popover: { id: 'popover', kind: 'modal', labelKey: 'focus.scope.popover' },
}

/** 全表,按声明序。 */
export const FOCUS_SCOPE_LIST: readonly FocusScopeSpec[] = Object.values(FOCUS_SCOPES)

/** 全部局部键,拍平。设置页的撞键表与 `keymap/scopes.ts` 的派生都读它。 */
export const FOCUS_SCOPED_KEYS: readonly ScopedKey[] = FOCUS_SCOPE_LIST.flatMap(
  (spec) => spec.keys ?? [],
)

export function focusScopeKeysOf(scope: FocusScopeId): readonly ScopedKey[] {
  return FOCUS_SCOPES[scope].keys ?? []
}
