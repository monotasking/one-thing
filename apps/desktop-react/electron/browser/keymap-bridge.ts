/**
 * 键位下沉与焦点同步(方案 §9-1 —— v2 里最大的那个洞)。
 *
 * ## 病
 *
 * `WebContentsView` 拿到焦点之后,键盘事件进的是**页面那个 webContents**;渲染进程
 * `focus/dispatch.ts` 上那条 window 捕获监听一个键都收不到。于是 ⌘K / ⌘P / 全部
 * 全局命令、`browser` 作用域自己的 ⌘L 统统死掉,Esc 退层、`returnTo` 归还、
 * I1「activeElement 永不是 body」也都不知道有一片原生视图在。
 *
 * 旧 Vue 壳靠**应用菜单加速器**绕过去(菜单加速器不管哪个 webContents 有焦点都响);
 * React 壳没有菜单,而且键位在渲染进程 `keymap/store.ts` 的 localStorage 里可以改绑
 * —— 主进程读不到那份表。
 *
 * ## 治法:保留键先于页面
 *
 * 渲染进程在键位表变化时把「**已绑定的组合键**」(全局命令 ∪ `browser` 作用域局部键)
 * 整表推下来;主进程给每片视图挂 `before-input-event`:
 *
 *   · 组合键在表里 → `preventDefault()` + 推回渲染进程,交给**唯一那个派发器**
 *     照常走(局部先接、全局兜底);
 *   · 不在表里 → 什么都不做,页面自己吃。
 *
 * 这正是 Chrome 自己「保留键先于页面」的形,也是 VS Code 对 webview 的做法。
 *
 * ## 规范化只有一份实现
 *
 * 两端要对同一个键说同一个名字,所以「怎么把一次按键写成一个串」必须是一份判据。
 * 它在这里(`chordOf`),渲染进程那一侧推表之前用同一套规则写好 —— 表是渲染进程
 * 发的,主进程只做**同一函数的另一次调用**来比对。修饰键按固定次序、全部小写,
 * 于是 `Shift+Cmd+P` 与 `cmd+shift+p` 是同一个串。
 */

import type { NativeViewPush } from '../native-view-protocol.js'
import type { NativeWebContents } from './tab.js'

/** Electron `before-input-event` 交来的那一份。 */
export interface NativeInputEvent {
  readonly type: string
  readonly key: string
  readonly code: string
  readonly control: boolean
  readonly alt: boolean
  readonly shift: boolean
  readonly meta: boolean
}

/** 可 `preventDefault()` 的那个壳。 */
export interface PreventableEvent {
  preventDefault(): void
}

/**
 * 一次按键 → 一个规范串。
 *
 * 修饰键次序固定 `cmd` → `ctrl` → `alt` → `shift`,主键小写。单独按修饰键
 * (`key === 'Meta'` 之类)不构成组合键,答空串 —— 空串永远不在表里,于是
 * 「按住 ⌘ 不放」不会被截下来。
 *
 * **这一侧不认识「主修饰键」「另一枚」这两个词,也不该认识**(K2):它收到的是
 * 一次**真按键**,只报哪几枚修饰键按着。壳那一侧的 `chordOfCombo` 负责把
 * `meta` / `ctrl` / `offHand` 三种**声明**按平台翻成同一套串 —— 于是 mac 上
 * 一条 `{offHand:true,key:'tab'}` 写出 `ctrl+tab`,而这里收到 `control: true`
 * 也写出 `ctrl+tab`,两端逐字相等(`browser-host.test.ts` 与
 * `keymap-downlink.test.ts` 各钉一半,后者还拿这只函数对过一遍)。
 */
export function chordOf(input: {
  key: string
  control?: boolean
  alt?: boolean
  shift?: boolean
  meta?: boolean
}): string {
  const key = input.key
  if (!key || key === 'Meta' || key === 'Control' || key === 'Alt' || key === 'Shift') return ''
  const parts: string[] = []
  if (input.meta) parts.push('cmd')
  if (input.control) parts.push('ctrl')
  if (input.alt) parts.push('alt')
  if (input.shift) parts.push('shift')
  parts.push(key.length === 1 ? key.toLowerCase() : key.toLowerCase())
  return parts.join('+')
}

function modifiersOf(input: NativeInputEvent): string[] {
  const out: string[] = []
  if (input.meta) out.push('cmd')
  if (input.control) out.push('ctrl')
  if (input.alt) out.push('alt')
  if (input.shift) out.push('shift')
  return out
}

export class KeymapBridge {
  private readonly push: (message: NativeViewPush) => void
  /** 渲染进程报来的全表。整表覆盖 —— 一份全表比一串增删更难对错。 */
  private bound: ReadonlySet<string> = new Set()

  constructor(push: (message: NativeViewPush) => void) {
    this.push = push
  }

  /** 收一次全表。串由渲染进程按 `chordOf` 的同一套规则写好。 */
  setBoundChords(chords: readonly string[]): void {
    this.bound = new Set(chords.map(chord => chord.trim().toLowerCase()).filter(Boolean))
  }

  /** 只给测试与诊断用。 */
  get boundCount(): number { return this.bound.size }

  /**
   * 给一片视图挂上三件事:按键拦截、拿到焦点、失去焦点。返回退订。
   *
   * 焦点双向同步的另一半(渲染进程 → 页面)是 `verb: 'focus'` 那条动词,由
   * `native-view-ipc.ts` 直接调 `webContents.focus()`,不经过这只类 —— 那一路上
   * 没有任何判据,多绕一层只会多一处可以走岔的地方。
   */
  attach(viewId: string, webContents: NativeWebContents): () => void {
    const onBeforeInput = (event: PreventableEvent, input: NativeInputEvent) => {
      // `keyUp` 不判:一次组合键的 down 已经被截下来了,再截 up 会让页面收到
      // 一个没有 down 的 up(有些编辑器据此认为修饰键卡住了)。
      if (input.type !== 'keyDown') return
      const chord = chordOf(input)
      if (!chord || !this.bound.has(chord)) return
      event.preventDefault()
      this.push({
        kind: 'key',
        viewId,
        key: input.key,
        code: input.code,
        modifiers: modifiersOf(input),
      })
    }
    const onFocus = () => { this.push({ kind: 'focus', viewId }) }
    const onBlur = () => { this.push({ kind: 'blur', viewId }) }

    webContents.on('before-input-event', onBeforeInput as never)
    webContents.on('focus', onFocus as never)
    webContents.on('blur', onBlur as never)

    return () => {
      const off = (webContents as unknown as {
        removeListener?: (event: string, listener: unknown) => void
      }).removeListener
      if (!off) return
      off.call(webContents, 'before-input-event', onBeforeInput)
      off.call(webContents, 'focus', onFocus)
      off.call(webContents, 'blur', onBlur)
    }
  }
}
