import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { SearchAddon } from '@xterm/addon-search'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { appAlreadyTookKey } from './key-courtesy'
import { configureTerminalScreenFactory } from './registry'
import { currentTerminalFace } from './theme'
import '@xterm/xterm/css/xterm.css'

/**
 * **一块屏幕**(T1)—— `TerminalSession` 与 xterm 之间那层薄壳。
 *
 * ── 它为什么存在 ────────────────────────────────────────────────────────
 * 状态机(`session.ts`)要判的是**协议**:回放、去重、代次、流控、生死。那套
 * 判据一行都不该需要一个真的 canvas 才跑得起来 —— 而 xterm 在 jsdom 里连
 * `open()` 都要量字形。所以屏幕是一个**口**:生产里它背后是 xterm,单测里是一
 * 张记事本。这与 `data/*-port.ts` 的 `configureXxxPort` 是同一条判例
 * (窄面在前,真实现在后)。
 *
 * 这只文件因此是全仓**唯一**认识 `@xterm/*` 的地方,也是那张样式表唯一的 import
 * 处(它是 xterm 自己的结构样式 —— 光标、选区、视口的几何,不是本壳的皮肤;
 * 颜色与字面由 `theme.ts` 从 `--term-*` 现算之后作为值交进去)。
 */

/** 一次查找此刻的读数。`index` 从 0 起;`-1` = 没有活动命中(含超出高亮上限)。 */
export interface TerminalFindResults {
  index: number
  count: number
}

export type TerminalFindDirection = 'next' | 'previous'

export interface TerminalScreen {
  /** 这块屏幕的宿主元素。组件挂载时 `appendChild` 它,卸载时**不销毁**。 */
  readonly element: HTMLElement
  /** 当前列数 / 行数(fit 之后)。 */
  readonly cols: number
  readonly rows: number
  /**
   * 写一段字节。`done` 在这一段**真的画上去之后**回调 —— 流控的账按它记
   * (判词在 `session.ts` 的 ack 那一段)。
   */
  write(data: string, done?: () => void): void
  /** 按容器重新量一次;量不出(容器没尺寸)答 null,**不发 resize**(9-9)。 */
  fit(): { cols: number; rows: number } | null
  /** 直接钉列数行数(attach 回放前照 `info` 钉,好让回放的字节落在同一张网格上)。 */
  resize(cols: number, rows: number): void
  /** 用户敲的键。 */
  onData(cb: (data: string) => void): void
  /** OSC 标题(`\x1b]0;…\x07`)。活标题的第一顺位。 */
  onTitleChange(cb: (title: string) => void): void
  /**
   * 在这块屏幕的回滚缓冲里找一处。**答「这一次找到了没有」**。
   *
   * `incremental` 只在往下找时有意义(插件自己的规矩:它让选区随着人打字一格
   * 一格长出去),所以那一格由**方向**决定,不给调用方一个开关 —— 一块屏幕
   * 只该有一种查找手感。
   */
  find(term: string, direction: TerminalFindDirection): boolean
  /** 收起查找:清掉高亮与选区。空词也走它。 */
  clearFind(): void
  /**
   * 命中读数。**装饰关掉时永不回调**(插件的规矩,判词在 `theme.ts` 的
   * `TerminalFace.find` 上)—— 那一档由调用方按 `find()` 的布尔答案兜底。
   */
  onFindResults(cb: (results: TerminalFindResults) => void): void
  /** 主题换了:把新的颜色与字面交进去。 */
  refreshFace(): void
  /** 键盘礼让那一行:应用已经拿走的键不再进 PTY(判据 = `defaultPrevented`)。 */
  attachKeyGuard(): void
  /**
   * 把键盘交给屏幕里那个收字的元素(xterm 的 textarea)。
   *
   * **名字里带 `Screen` 是有意的**:`.focus()` 这个拼法是 I3 硬闸的判据
   * (`ui:consume` 的 `focus-outside-focus`),而这条链上真正碰 DOM 的只有
   * xterm 那一句。中间这两层叫 `focusScreen` 之后,全仓需要豁免的就只剩**一处**
   * ——一处豁免看得住,三处就开始有人抄。
   */
  focusScreen(): void
  dispose(): void
}

/** xterm 背后那一份。`open()` 立刻做 —— 元素还没进文档也行,fit 那一步才要尺寸。 */
export function createXtermScreen(): TerminalScreen {
  const element = document.createElement('div')
  element.dataset.terminalScreen = ''
  element.style.width = '100%'
  element.style.height = '100%'

  const face = currentTerminalFace()
  const term = new Terminal({
    theme: face.theme,
    ...(face.fontFamily ? { fontFamily: face.fontFamily } : {}),
    ...(face.fontSize ? { fontSize: face.fontSize } : {}),
    cursorBlink: true,
    allowProposedApi: true,
    // 回滚缓冲归 xterm(它就是干这个的);core 那边的 ring 只管**断线回放**。
    scrollback: 5000,
  })
  const fitAddon = new FitAddon()
  term.loadAddon(fitAddon)
  term.loadAddon(new WebLinksAddon())
  const searchAddon = new SearchAddon()
  term.loadAddon(searchAddon)
  term.open(element)

  /*
   * 查找的装饰颜色随主题走,所以它是一格**可变**的选项而不是常量:`refreshFace`
   * 换一份新的,下一次 `find()` 就画在新颜色上(已经画着的那几处由插件自己在
   * 下一次搜索时重铺 —— 一次查找的寿命本来就只有「查找行开着」那一会儿)。
   */
  let findDecorations = face.find

  return {
    element,
    get cols() {
      return term.cols
    },
    get rows() {
      return term.rows
    },
    write: (data, done) => term.write(data, done),
    fit: () => {
      /*
       * **9-9**:`content-visibility: hidden` 下容器没有尺寸,`FitAddon.fit()`
       * 会算出 0 列 —— 发一条 `resize(0,0)` 会让 PTY 重排乱屏。所以量不出来就
       * 答 null,由调用方决定什么都不做(切回来时补一次)。
       */
      const proposed = fitAddon.proposeDimensions()
      if (!proposed) return null
      const { cols, rows } = proposed
      if (!Number.isFinite(cols) || !Number.isFinite(rows) || cols <= 0 || rows <= 0) return null
      if (cols !== term.cols || rows !== term.rows) term.resize(cols, rows)
      return { cols, rows }
    },
    resize: (cols, rows) => {
      if (cols > 0 && rows > 0) term.resize(cols, rows)
    },
    onData: (cb) => {
      term.onData(cb)
    },
    onTitleChange: (cb) => {
      term.onTitleChange(cb)
    },
    find: (term_, direction) => {
      const options = {
        ...(findDecorations ? { decorations: findDecorations } : {}),
        ...(direction === 'next' ? { incremental: true } : {}),
      }
      return direction === 'next'
        ? searchAddon.findNext(term_, options)
        : searchAddon.findPrevious(term_, options)
    },
    clearFind: () => searchAddon.clearDecorations(),
    onFindResults: (cb) => {
      searchAddon.onDidChangeResults((e) => cb({ index: e.resultIndex, count: e.resultCount }))
    },
    refreshFace: () => {
      const next = currentTerminalFace()
      term.options.theme = next.theme
      if (next.fontFamily) term.options.fontFamily = next.fontFamily
      if (next.fontSize) term.options.fontSize = next.fontSize
      findDecorations = next.find
    },
    attachKeyGuard: () => {
      /*
       * **xterm 侧只做这一件事**(9-1 末段)。谁先接由**树**答:唯一那个派发器
       * 住在 window 的**捕获**相位,整条传播路径的第一站,它跑在 xterm 挂在
       * textarea 上的那条监听之前。所以这里不抄第二张键表 —— 判据就是一句
       * 「应用已经拿走了吗」:`defaultPrevented` 为真 = 局部键或全局命令已经
       * 认领过这一下,PTY 不该再收到它一次。
       *
       * 反过来也成立:派发器问不到人就**不** `preventDefault`,于是 Ctrl+C /
       * Ctrl+D / Esc / Tab / 方向键照常进 PTY —— 它们根本不必出现在任何表里。
       */
      term.attachCustomKeyEventHandler((event) => !appAlreadyTookKey(event))
    },
    /*
     * ui-consume-allow: focus-outside-focus — **作用域内部**的移动,不跨作用域:
     * 焦点已经在 `terminal` 这一格上(落点是那个占位容器),这一句只是把它从
     * 容器交给容器里 xterm 自己那个收字的 textarea。判据与 `ui/a11y/roving` /
     * `ui/inline-edit` 逐字同一条(I3 的原话:「后三处是作用域内部的移动」),
     * 而跨作用域搬焦点这只文件一处都没有 —— 那条路仍旧只有 `activateScope()`。
     */
    focusScreen: () => term.focus(),
    dispose: () => term.dispose(),
  }
}

/*
 * **自己登记**(判词在 `registry.ts` 的 `makeScreen` 上):注册表不认识 xterm,
 * 所以这一句必须由**这只文件**说。它是一格幂等的闩;拉起这只文件的是
 * `TerminalLeaf`,而那是唯一真需要一块屏幕的路。
 */
configureTerminalScreenFactory(createXtermScreen)

if (import.meta.hot) {
  import.meta.hot.dispose(() => configureTerminalScreenFactory(undefined))
}
