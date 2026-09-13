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
import type { AppMenuSpec } from './native-view-protocol.js'

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
  /**
   * **命令表投影出来的那几节**(K4)。缺席 = 还没收到过(壳刚 `whenReady`,
   * 渲染进程还没起来)—— 那时画的就是 K1 那张只做减法的表,与从前逐字相同。
   */
  menu?: AppMenuSpec
  /**
   * 点一项要做什么。`buildAppMenuTemplate` 是纯模板,所以「点了之后」是**参数** ——
   * 真实现是把 `{ kind: 'command', id }` 推回渲染进程(`app-menu-install.ts`)。
   */
  onCommand?: (id: string) => void
}

/**
 * **规范串 → Electron 的加速键**(K4)。纯函数,读不出就是 `null`(不猜)。
 *
 * 串这一侧已经**解释过平台**了(判词在渲染层 `keymap/chord.ts`):
 * mac 上主修饰键写 `cmd`、另一枚写 `ctrl`;Win / Linux 上主修饰键写 `ctrl`、
 * 另一枚写 `cmd`(那是 Win 键)。所以这里的映射也按平台分:
 *
 *  · **主修饰键** → `CommandOrControl`(Electron 自己按平台画成 ⌘ / Ctrl);
 *  · **另一枚** → mac 画 `Control`、其余画 `Super`。
 *
 * 主键按 Electron 的键名表折(`enter` → `Return`、`arrowleft` → `Left`、
 * 空格 → `Space`、`+` → `Plus`;标点原样)。折不出来的一律 `null` —— 一项没有
 * 加速键只是少画一个键面,而**猜**出来的键面是一句假话。
 */
const ACCELERATOR_KEYS: Record<string, string> = {
  enter: 'Return',
  escape: 'Escape',
  tab: 'Tab',
  backspace: 'Backspace',
  delete: 'Delete',
  insert: 'Insert',
  home: 'Home',
  end: 'End',
  pageup: 'PageUp',
  pagedown: 'PageDown',
  arrowup: 'Up',
  arrowdown: 'Down',
  arrowleft: 'Left',
  arrowright: 'Right',
  ' ': 'Space',
  '+': 'Plus',
}

/** Electron 的加速键里原样收得下的标点(文档那句「Punctuations like ~, !, @, #, $」)。 */
const ACCELERATOR_PUNCTUATION = new Set([
  '`', '~', '-', '=', '[', ']', '\\', ';', "'", ',', '.', '/', '!', '@', '#', '$', '%', '^', '&', '*',
  '(', ')', '_', '{', '}', '|', ':', '"', '<', '>', '?',
])

export function acceleratorOfChord(chord: string, platform: NodeJS.Platform): string | null {
  const mac = platform === 'darwin'
  const text = chord.trim().toLowerCase()
  if (!text) return null
  /* 主键本身是 `+` 的那一档要单独认(`cmd++` 的末位是键不是分隔符),与 `keymap/chord.ts` 同判例。 */
  let mods: string[]
  let key: string
  if (text === '+') {
    mods = []
    key = '+'
  } else if (text.endsWith('+')) {
    const head = text.slice(0, -1)
    if (!head.endsWith('+')) return null
    mods = head.slice(0, -1).split('+').filter(Boolean)
    key = '+'
  } else {
    const parts = text.split('+')
    const last = parts.pop()
    if (!last) return null
    mods = parts.filter(Boolean)
    key = last
  }
  const out: string[] = []
  for (const mod of mods) {
    if (mod === 'alt') out.push('Alt')
    else if (mod === 'shift') out.push('Shift')
    else if (mod === (mac ? 'cmd' : 'ctrl')) out.push('CommandOrControl')
    else if (mod === (mac ? 'ctrl' : 'cmd')) out.push(mac ? 'Control' : 'Super')
    else return null
  }
  const named = ACCELERATOR_KEYS[key]
  if (named) out.push(named)
  else if (/^[a-z0-9]$/.test(key)) out.push(key.toUpperCase())
  else if (/^f([1-9]|1[0-9]|2[0-4])$/.test(key)) out.push(key.toUpperCase())
  else if (ACCELERATOR_PUNCTUATION.has(key)) out.push(key)
  else return null
  return out.join('+')
}

/**
 * 一节 → 一格顶层菜单。**每一项 `registerAccelerator: false`** —— 这是硬约束:
 * 加速键在这里**只用来显示**。真正的派发永远是壳里那唯一一个派发器
 * (菜单点击也走它,见 `focus/dispatch.dispatchHostCommand`);让菜单真的注册这个
 * 键,同一下按键会先被 NSApp 的菜单吃掉、再被壳自己接一次 —— 响两次,或者更糟:
 * 菜单那一份不认识活动路径,于是「⌘T 在浏览器里开标签、在别处什么都不做」这条
 * 裁定当场失效。单测 ⑧ 对**全表**钉着这一格。
 */
function menuSectionTemplate(
  section: AppMenuSpec['sections'][number],
  platform: NodeJS.Platform,
  onCommand: ((id: string) => void) | undefined,
): MenuItemConstructorOptions {
  return {
    label: section.label,
    submenu: section.items.map((item): MenuItemConstructorOptions => {
      const accelerator = item.chord ? acceleratorOfChord(item.chord, platform) : null
      return {
        /* id = 命令 id:门按它取件,`ONETHING_GATE_MENU_CLICK` 也按它点。 */
        id: item.id,
        label: item.label,
        enabled: item.enabled,
        ...(accelerator ? { accelerator, registerAccelerator: false } : {}),
        click: () => { onCommand?.(item.id) },
      }
    }),
  }
}

/** dev 档 Reload 的键:与 ⌘R 错开(mac 用 ⌃⌥⌘R,别的平台用 Ctrl+Alt+Shift+R)。 */
export function devReloadAccelerator(platform: NodeJS.Platform): string {
  return platform === 'darwin' ? 'Control+Alt+Command+R' : 'Control+Alt+Shift+R'
}

/**
 * 纯模板函数:进得了 vitest(它一个 electron 的**值**都不碰,只用类型)。
 * 判例与 `electron/browser/` 同一条 —— 那个目录里只有 `index.ts` 碰 electron。
 */
export function buildAppMenuTemplate({ dev, platform, menu, onCommand }: AppMenuInput): MenuItemConstructorOptions[] {
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

  /*
   * **命令表投影出来的那几节**(K4),排在 Edit 之后、别的一切之前。
   *
   * 它们是这台壳自己的命令,不是系统角色 —— 所以它们挨着 Edit 站,而 Window /
   * Help 仍然收尾(每个 mac 应用都是这个次序)。dev 档那格 View 排在它们后面:
   * 它是开发者的东西,不该插在产品命令中间。
   */
  for (const section of menu?.sections ?? []) {
    if (section.items.length === 0) continue
    template.push(menuSectionTemplate(section, platform, onCommand))
  }

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
  id?: string
  label?: string
  role?: string
  accelerator?: string
  type?: string
  enabled?: boolean
  submenu?: { items: MenuItemLike[] } | undefined
}

export interface MenuDumpRow {
  /** 命令 id(K4 起投影出来的项带它;角色项没有)。 */
  id?: string
  label?: string
  role?: string
  accelerator?: string
  type?: string
  /** **只在 false 时写出去**:门问的是「这一项此刻画不画灰」,而绝大多数项恒 true。 */
  enabled?: boolean
  submenu?: MenuDumpRow[]
}

/** 纯函数:把菜单树压成门读得懂的行(递归)。 */
export function dumpMenuItems(items: readonly MenuItemLike[]): MenuDumpRow[] {
  return items.map(item => ({
    id: item.id || undefined,
    label: item.label || undefined,
    role: item.role || undefined,
    accelerator: item.accelerator || undefined,
    type: item.type && item.type !== 'normal' ? item.type : undefined,
    enabled: item.enabled === false ? false : undefined,
    submenu: item.submenu ? dumpMenuItems(item.submenu.items) : undefined,
  }))
}

/**
 * 门用的第二格自述口:`ONETHING_GATE_MENU_CLICK=<path>` 一设,主进程**盯着那个
 * 文件**,里面写进一个命令 id 就在菜单上点它一次(同一个 id 不重复点)。
 *
 * ── 为什么是**路径**而不是直接写命令 id ──────────────────────────────────
 * 门要证的不是「点得动」,是「**这个时候**点它会开出一格浏览器标签」——
 * 而 `tab.new` 在任何一片会话叶拿到焦点时就已经 `enabled` 了。env 里塞一个 id
 * 说得出「点什么」,说不出「什么时候」,于是门只能赌自己先到;换成一个文件,
 * 时机由门自己写那一下决定,与它前面十几条一样是确定的。
 *
 * 判例与 `GATE_MENU_DUMP_ENV` 逐字相同:**只在 `ONETHING_GATE_` 前缀下生效**,
 * 产品路径上一个字都读不到它。
 */
export const GATE_MENU_CLICK_ENV = 'ONETHING_GATE_MENU_CLICK'

/**
 * 一份菜单表的签名。**同签名不重建** —— Electron 的 `Menu` 是不可变的,换一份
 * 表只能整台重建(`setApplicationMenu(buildFromTemplate(...))`),而重建会让
 * macOS 把菜单栏重画一遍。渲染进程那一侧已经按同一条规矩去过一次重(它的签名
 * 还多算了保留键表那一半),这里是第二道:换语言 / 换焦点那种**只动一半**的帧
 * 到这儿仍然可能与上一次逐字相同(比如两片都答不出任何命令的面互切)。
 */
export function menuSpecSignature(menu: AppMenuSpec | undefined): string {
  return menu ? JSON.stringify(menu) : ''
}

/**
 * **菜单此刻长什么样**,以及「要不要重画」这一问 —— 有状态的那一小格。
 *
 * 它住在这只**零 electron 值导入**的文件里(与 `buildAppMenuTemplate` 同一条
 * 判例),所以「同签名不重建」是一条跑得动的单测,不是一句注释:真正的
 * `Menu.setApplicationMenu` 由构造时注入的 `render` 代表,装它的那一半仍然只在
 * `app-menu-install.ts` 里碰 electron。
 */
export class AppMenuRenderer {
  private readonly render: (template: MenuItemConstructorOptions[]) => void
  private readonly input: () => { dev: boolean; platform: NodeJS.Platform }
  private readonly onCommand: (id: string) => void
  private spec: AppMenuSpec | undefined
  private signature: string | undefined

  constructor(options: {
    render: (template: MenuItemConstructorOptions[]) => void
    input: () => { dev: boolean; platform: NodeJS.Platform }
    onCommand: (id: string) => void
  }) {
    this.render = options.render
    this.input = options.input
    this.onCommand = options.onCommand
  }

  /** K1 那一趟:壳刚 `whenReady`,还没有任何投影 —— 画的就是只做减法的那张。 */
  install(): void {
    this.draw()
  }

  /**
   * 收一份新投影。**回的是「重画了没有」** —— 门与单测都要这句话,而一个布尔比
   * 「你自己再算一遍签名」诚实。
   */
  apply(menu: AppMenuSpec | undefined): boolean {
    const next = menuSpecSignature(menu)
    if (next === (this.signature ?? '')) return false
    this.signature = next
    this.spec = menu
    this.draw()
    return true
  }

  /** 此刻这张表里那一项是什么样(门的点击口按 id 取件)。 */
  itemOf(id: string): AppMenuSpec['sections'][number]['items'][number] | undefined {
    for (const section of this.spec?.sections ?? []) {
      for (const item of section.items) if (item.id === id) return item
    }
    return undefined
  }

  private draw(): void {
    const { dev, platform } = this.input()
    this.render(buildAppMenuTemplate({ dev, platform, menu: this.spec, onCommand: this.onCommand }))
  }
}
