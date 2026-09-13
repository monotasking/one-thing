/**
 * 装应用菜单的那一半(K1;K4 起它还收命令表的投影)。**这只文件是整块里唯一
 * `import { Menu } from 'electron'` 的落点** —— 判例与 `electron/browser/index.ts`
 * 逐字相同:一个目录里只许一只文件碰 electron 的值,其余部分才进得了 vitest。
 *
 * 菜单**长什么样**不在这里,在隔壁 `app-menu.ts`(纯模板函数 + `AppMenuRenderer`,
 * 零 electron 值导入,那边的文件头写着这张表为什么是这张表)。这里只做三件事:
 * 把模板装上去、在门的自述口开着时把**装完之后**的真实表写出来、以及把菜单上
 * 点的那一下交回渲染进程。
 *
 * ── 为什么是模块级的一份 ────────────────────────────────────────────────
 * `Menu.setApplicationMenu` 本来就是**进程级**的单槽:一个 app 只有一张应用菜单。
 * 把它做成一个要被人持有的对象,等于凭空造出「这台机器上有第二张菜单」的可能。
 * 所以这里与 `app.whenReady()` 那一行同形:一个进程一份。
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { Menu } from 'electron'
import { getLogger } from '@onething/backend/wiring/logging/index.js'
import {
  AppMenuRenderer,
  GATE_MENU_CLICK_ENV,
  GATE_MENU_DUMP_ENV,
  KEYS_RESERVED_FOR_CONTENT,
  dumpMenuItems,
  isDevShell,
  type MenuItemLike,
} from './app-menu.js'
import type { AppMenuSpec } from './native-view-protocol.js'

const log = getLogger('shell.menu')

let environment: NodeJS.ProcessEnv = process.env
/**
 * 点一项要把命令推给谁。宿主在装完浏览器那一块之后填它
 * (`configureAppMenuCommandSender`)—— 菜单先于窗口装上(K1 的次序:第一扇窗
 * 出现之前),所以**「能点」比「点了有人收」早一拍**是结构性的,不是疏漏:
 * 那一拍里菜单上只有角色项,投影出来的那几节还一条都没有。
 */
let sendCommand: ((id: string) => void) | undefined
/** 门那一格点过的 id(同一个不重复点)。 */
let lastGateClick: string | undefined
let gateClickTimer: NodeJS.Timeout | undefined

const renderer = new AppMenuRenderer({
  render: template => { Menu.setApplicationMenu(Menu.buildFromTemplate(template)) },
  input: () => ({ dev: isDevShell(environment), platform: process.platform }),
  onCommand: id => {
    if (!sendCommand) {
      log.debug('menu command dropped; no renderer attached', { id })
      return
    }
    sendCommand(id)
  },
})

/**
 * `main.ts` 在 `app.whenReady()` 之后、建窗之前调它(菜单要在第一扇窗出现前就位)。
 */
export function installAppMenu(env: NodeJS.ProcessEnv = process.env): void {
  environment = env
  renderer.install()
  writeDump()
  startGateClickWatcher()
}

/**
 * **收一份新的菜单投影**(K4)。渲染进程算完整张推下来(判词在
 * `keymap/menu-projection.ts`),这里只画。
 *
 * 回「重画了没有」:Electron 的 `Menu` 不可变,换表只能整台重建,所以同签名
 * 不重建是一条真的省事 —— 判据与实现都在 `AppMenuRenderer` 上,单测钉着。
 */
export function applyAppMenuSpec(menu: AppMenuSpec | undefined): boolean {
  const drawn = renderer.apply(menu)
  if (drawn) writeDump()
  return drawn
}

/**
 * 菜单点击的去处。宿主装浏览器那一块时把推送口递进来,返回撤销 ——
 * 窗口没了(或者那一块装不起来)之后菜单上点一下只会记一行 debug,不会抛。
 */
export function configureAppMenuCommandSender(send: (id: string) => void): () => void {
  sendCommand = send
  return () => {
    if (sendCommand === send) sendCommand = undefined
  }
}

/**
 * 门那一格(`ONETHING_GATE_MENU_DUMP`)写出去的是**装完之后**从
 * `Menu.getApplicationMenu()` 现读的表,不是模板 —— 模板只是请求,真实表才是事实
 * (角色展开成哪些项、角色自带哪个加速键,都要 Electron 装完才知道)。
 *
 * K4 起每重画一次就重写一次:门要看的正是「切到浏览器叶之后 `tab.new` 那一项
 * 变成 `enabled`」,而那句话只在新的那一份里。
 */
function writeDump(): void {
  const dumpPath = environment[GATE_MENU_DUMP_ENV]?.trim()
  if (!dumpPath) return
  try {
    const menu = Menu.getApplicationMenu()
    /*
     * 保留表**跟着一起写出去**:门要断言「菜单没占内容层的键」,而那张表的产地
     * 只能有一个(仓根 09-02 法:能力自述、别人读表)。门自己抄一份 = 两个产地,
     * K2 改了表这道门会静静地按旧表判。
     */
    const payload = {
      dev: isDevShell(environment),
      platform: process.platform,
      reserved: [...KEYS_RESERVED_FOR_CONTENT],
      menu: menu === null ? null : dumpMenuItems(menu.items as unknown as MenuItemLike[]),
    }
    writeFileSync(dumpPath, JSON.stringify(payload, null, 2), 'utf8')
  } catch (error) {
    log.warn('menu dump failed', { path: dumpPath }, error)
  }
}

/**
 * 门那格点击口。**只在 `ONETHING_GATE_MENU_CLICK` 设了路径时才起**,而且起的是
 * 一只 `unref` 的轮询 —— 不用 `fs.watch` 是因为它在 macOS 上对「写一个还不存在的
 * 文件」这一档要看编辑器怎么写(rename vs truncate),而门只写一次,轮询 150ms
 * 既确定又没有平台分支。
 *
 * 点法:**走菜单项自己的 `click`**(`MenuItem.click()`),不是绕过菜单直接推命令
 * —— 绕过去的话这道门证的就不是菜单了。画灰的项按不动(Electron 的 `MenuItem`
 * 在 `enabled: false` 时 `click()` 是空动作),而那正是门要的第二句话。
 */
function startGateClickWatcher(): void {
  const clickPath = environment[GATE_MENU_CLICK_ENV]?.trim()
  if (!clickPath || gateClickTimer) return
  gateClickTimer = setInterval(() => {
    let id: string
    try {
      id = readFileSync(clickPath, 'utf8').trim()
    } catch {
      return // 还没写 —— 这是常态,不记日志。
    }
    if (!id || id === lastGateClick) return
    lastGateClick = id
    const item = Menu.getApplicationMenu()?.getMenuItemById(id)
    if (!item) {
      log.warn('gate menu click: no such item', { id })
      return
    }
    item.click()
  }, 150)
  gateClickTimer.unref?.()
}
