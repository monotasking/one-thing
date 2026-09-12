/**
 * **应用菜单(K1)** —— 方案正本 `apps/desktop-react/docs/keymap-responder-2026-09.md`
 * §1「应用菜单」段 / §2 P2 / §4「应用菜单」段 / §5 K1。
 *
 * ── 为什么这只文件必须存在(先量出来的,不是推断的)──────────────────────
 * 壳从来没有调过 `Menu.setApplicationMenu`(`grep -rn "Menu" electron/` 零命中),
 * 而 Electron 的文档原话是「The default menu will be created automatically if the
 * app does not set one」。2026-09-12 用仓里的 Electron 41.1.1 起一个**空 app**
 * (不建窗)读 `Menu.getApplicationMenu()`,量出来的那张表逐条是:
 *
 *   File → Close Window            `CommandOrControl+W`
 *   View → Reload                  `CmdOrCtrl+R`        ← 重载的是**整台壳**
 *   View → Force Reload            `Shift+CmdOrCtrl+R`
 *   View → Toggle Developer Tools  `Alt+Command+I`
 *   View → Actual Size             `CommandOrControl+0`
 *   View → Zoom In                 `CommandOrControl+Plus`
 *   View → Zoom Out                `CommandOrControl+-`
 *   View → Toggle Full Screen      `Control+Command+F`
 *   Window → Minimize              `CommandOrControl+M`
 *   App → Hide/Quit                `Command+H` / `CommandOrControl+Q`
 *
 * 这张表**没有人审过**,却是壳上优先级最高的一层键:菜单加速键只有在页面
 * `preventDefault` 了才不触发(Electron `before-input-event` 文档原话:preventDefault
 * 「prevents the page keydown/keyup events and the menu shortcuts」)。于是「⌘R
 * 重载这块内容」这条本该属于内容层的命令,今天一按就把整台壳重载了 —— 这正是 P2。
 *
 * ── 本单只做减法 ──────────────────────────────────────────────────────────
 * 留下的是**非留不可**的那些:macOS 的 `appMenu`(about / hide / quit 都在里面),
 * Edit 的八个角色(**没有它们 macOS 上输入框里 ⌘C/⌘V 不工作** —— 系统级的
 * 剪贴板动作在 mac 上是由菜单角色供的,不是由 Chromium 供的),Window 的
 * minimize / zoom / front,和一个 Help。
 *
 * 拿掉的是 View 整块(reload / forceReload / zoom* / toggleDevTools)与 File→Close;
 * 默认表里挂在 View 下的**全屏** `togglefullscreen` ⌃⌘F 不在拿掉之列,它搬到 Window。
 * `windowMenu` / `fileMenu` 这两个**复合角色**一并不用 —— 后者在 mac 上自带
 * `close` ⌘W,用了等于把刚拿掉的键又装回来。
 *
 * dev 档例外:开发者要 DevTools 与 Reload,所以那两条回来,但 Reload 的键**改到**
 * `⌃⌥⌘R`,与要还给内容层的 ⌘R 错开(dev 档的这条是可感知变化,只影响开发者)。
 *
 * ── 这只文件一个 electron 的**值**都不碰(只用类型)───────────────────────
 * 判例与 `electron/browser/` 同一条:那个目录里只有 `index.ts` 碰 electron,
 * 于是其余部分进得了 vitest。装菜单那一半住在隔壁 `app-menu-install.ts` ——
 * 它是唯一 `import { Menu } from 'electron'` 的落点。**别把它搬回来**:
 * 「node 下 electron 包解析出来是个路径字符串、`Menu` 恰好是 undefined 所以没炸」
 * 是碰巧,不是设计;单测里有一条读本文件源文本的用例钉着这件事。
 */
import type { MenuItemConstructorOptions } from 'electron'

/**
 * **这七个键归内容层**,应用菜单一个都不许占。
 *
 * K2 / K3 会读这张表(命令表里 `tab.new` ⌘T / `content.new` ⌘N / `view.reload` ⌘R /
 * `view.zoom*` 各自认领它们),所以它导出在这里而不是写死在断言里:菜单这一侧要能
 * 单独证明「我没有占着别人的键」,而那个证明只有对着同一张表做才算数。
 */
export const KEYS_RESERVED_FOR_CONTENT = [
  'CmdOrCtrl+R',
  'CmdOrCtrl+W',
  'CmdOrCtrl+T',
  'CmdOrCtrl+N',
  'CmdOrCtrl+Plus',
  'CmdOrCtrl+-',
  'CmdOrCtrl+0',
] as const

/** 这七个键在 Electron 模型里还会以 `CommandOrControl+…` 的长写法出现(默认表就是)。 */
const RESERVED_EQUIVALENTS = new Set(
  KEYS_RESERVED_FOR_CONTENT.flatMap(key => [
    key.toLowerCase(),
    key.replace(/^CmdOrCtrl/, 'CommandOrControl').toLowerCase(),
    key.replace(/^CmdOrCtrl/, 'Command').toLowerCase(),
    key.replace(/^CmdOrCtrl/, 'Control').toLowerCase(),
  ]),
)

/** 一个加速键字符串是不是「内容层的那七个」之一(大小写与两种写法都算)。 */
export function isReservedForContent(accelerator: string | undefined): boolean {
  if (!accelerator) return false
  return RESERVED_EQUIVALENTS.has(accelerator.trim().toLowerCase())
}

/**
 * dev 档判据 —— **与 `main.ts` 里现有的那一条同源**:壳走不走 vite dev server,
 * 由 `ONETHING_REACT_DEV_SERVER_URL` 说了算(`main.ts` 的 `createWindow` 就是拿它
 * 分 `loadURL` / `loadFile`)。这里不另起一个 `NODE_ENV` 读法:两个产地迟早会分叉。
 */
export function isDevShell(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.ONETHING_REACT_DEV_SERVER_URL)
}

export interface AppMenuInput {
  /** dev 档(见 `isDevShell`):多一个 View,里面只有 DevTools 与换了键的 Reload。 */
  dev: boolean
  platform: NodeJS.Platform
}

/** dev 档 Reload 的键:与 ⌘R 错开(mac 用 ⌃⌥⌘R,别的平台用 Ctrl+Alt+Shift+R)。 */
export function devReloadAccelerator(platform: NodeJS.Platform): string {
  return platform === 'darwin' ? 'Control+Alt+Command+R' : 'Control+Alt+Shift+R'
}

/**
 * 纯模板函数:进得了 vitest(它一个 electron 的**值**都不碰,只用类型)。
 * 判例与 `electron/browser/` 同一条 —— 那个目录里只有 `index.ts` 碰 electron。
 */
export function buildAppMenuTemplate({ dev, platform }: AppMenuInput): MenuItemConstructorOptions[] {
  const mac = platform === 'darwin'
  const template: MenuItemConstructorOptions[] = []

  if (mac) {
    // `appMenu` 是 mac 上那个以 app 名命名的第一格:about / services / hide /
    // hideOthers / unhide / quit 全在里面,一个键都不在保留表上。
    template.push({ role: 'appMenu' })
  } else {
    // Win / Linux 没有 appMenu,退出只能自己给一格 File。**只放 quit**:
    // `fileMenu` 复合角色会把 `close` ⌘W 带回来。
    template.push({ label: 'File', submenu: [{ role: 'quit' }] })
  }

  /*
   * Edit —— 这一格是**功能性的**,不是装饰:macOS 上输入框里的 ⌘C / ⌘V / ⌘Z
   * 靠的就是这些角色。删掉它 = 真机上复制粘贴不工作(所以单测 ② 钉的是它们在)。
   */
  template.push({
    label: 'Edit',
    submenu: [
      { role: 'undo' },
      { role: 'redo' },
      { type: 'separator' },
      { role: 'cut' },
      { role: 'copy' },
      { role: 'paste' },
      { role: 'pasteAndMatchStyle' },
      { role: 'delete' },
      { role: 'selectAll' },
    ],
  })

  if (dev) {
    /*
     * dev 档才有的 View。**只有两条**,而且 Reload 换了键 —— ⌘R 要留给内容层
     * (「重载这块内容」),菜单再占着它就等于产品行为由一张没人审的表决定。
     */
    template.push({
      label: 'View',
      submenu: [
        { role: 'toggleDevTools' },
        { role: 'reload', accelerator: devReloadAccelerator(platform) },
      ],
    })
  }

  /*
   * Window —— **三个角色逐个写**,不用 `windowMenu`:那个复合角色在 mac 上还会
   * 带上别的东西,而这一格要的就是「最小化 / 缩放 / 全部前置」这三件窗口动作。
   * `zoom` / `front` 是 mac 专有角色,别的平台只留 `minimize`。
   *
   * **全屏(⌃⌘F)留着**(09-12 用户拍):它不在内容层那七个键里,而且每个 mac
   * 应用都有它 —— 默认表把它挂在 View 下,而 View 整块被拿掉了,所以它跟着窗口
   * 那一族走,排在 `front` 之后。
   */
  template.push({
    label: 'Window',
    submenu: mac
      ? [
          { role: 'minimize' },
          { role: 'zoom' },
          { type: 'separator' },
          { role: 'front' },
          { role: 'togglefullscreen' },
        ]
      : [{ role: 'minimize' }, { role: 'togglefullscreen' }],
  })

  /*
   * Help —— 空 submenu。默认表里那四条(Learn More / Documentation / Community
   * Discussions / Search Issues)指的是 **Electron 自己**的站点,不是这个产品的;
   * 而这个产品今天没有文档站,**不编外链**。有了就是这里一行。
   */
  template.push({ role: 'help', submenu: [] })

  return template
}

/**
 * 门用的自述口:`ONETHING_GATE_MENU_DUMP=<path>` 一设,装完菜单就把
 * `Menu.getApplicationMenu()` 逐项写成 JSON 到那个路径。判例与
 * `electron/browser/download.ts` 的 `ONETHING_GATE_DOWNLOADS_DIR` 同族 ——
 * **只在 `ONETHING_GATE_` 前缀下生效**,产品路径上一个字都读不到它。
 *
 * **为什么门只能读表、不能去按键**:菜单加速键走的是 macOS 的 NSApp `sendEvent`,
 * 而门里那套 CDP `Input.dispatchKeyEvent` 是直接喂给 `WebContents` 的合成事件,
 * **根本不经过 NSApp** —— 拿 CDP 去按 ⌘R 什么都不会发生,那不叫「菜单没占这个键」。
 * 所以这条自述口是这件事唯一可证的形。(写在这里免得下一个人再去试一遍。)
 */
export const GATE_MENU_DUMP_ENV = 'ONETHING_GATE_MENU_DUMP'

/** `Menu.getApplicationMenu()` 交回来的东西的结构形(便于纯函数化与单测)。 */
export interface MenuItemLike {
  label?: string
  role?: string
  accelerator?: string
  type?: string
  submenu?: { items: MenuItemLike[] } | undefined
}

export interface MenuDumpRow {
  label?: string
  role?: string
  accelerator?: string
  type?: string
  submenu?: MenuDumpRow[]
}

/** 纯函数:把菜单树压成门读得懂的行(递归)。 */
export function dumpMenuItems(items: readonly MenuItemLike[]): MenuDumpRow[] {
  return items.map(item => ({
    label: item.label || undefined,
    role: item.role || undefined,
    accelerator: item.accelerator || undefined,
    type: item.type && item.type !== 'normal' ? item.type : undefined,
    submenu: item.submenu ? dumpMenuItems(item.submenu.items) : undefined,
  }))
}
