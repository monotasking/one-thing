/**
 * 装应用菜单的那一半(K1)。**这只文件是整块里唯一 `import { Menu } from 'electron'`
 * 的落点** —— 判例与 `electron/browser/index.ts` 逐字相同:一个目录里只许一只文件
 * 碰 electron 的值,其余部分才进得了 vitest。
 *
 * 菜单**长什么样**不在这里,在隔壁 `app-menu.ts`(纯模板函数,零 electron 值导入,
 * 那边的文件头写着这张表为什么是这张表)。这里只做两件事:把模板装上去,以及
 * 在门的自述口开着时把**装完之后**的真实表写出来。
 */
import { writeFileSync } from 'node:fs'
import { Menu } from 'electron'
import { getLogger } from '@onething/backend/wiring/logging/index.js'
import {
  GATE_MENU_DUMP_ENV,
  KEYS_RESERVED_FOR_CONTENT,
  buildAppMenuTemplate,
  dumpMenuItems,
  isDevShell,
  type MenuItemLike,
} from './app-menu.js'

const log = getLogger('shell.menu')

/**
 * `main.ts` 在 `app.whenReady()` 之后、建窗之前调它(菜单要在第一扇窗出现前就位)。
 *
 * 门那一格(`ONETHING_GATE_MENU_DUMP`)写出去的是**装完之后**从
 * `Menu.getApplicationMenu()` 现读的表,不是模板 —— 模板只是请求,真实表才是事实
 * (角色展开成哪些项、角色自带哪个加速键,都要 Electron 装完才知道)。
 */
export function installAppMenu(env: NodeJS.ProcessEnv = process.env): void {
  const template = buildAppMenuTemplate({ dev: isDevShell(env), platform: process.platform })
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))

  const dumpPath = env[GATE_MENU_DUMP_ENV]?.trim()
  if (!dumpPath) return
  try {
    const menu = Menu.getApplicationMenu()
    /*
     * 保留表**跟着一起写出去**:门要断言「菜单没占内容层的键」,而那张表的产地
     * 只能有一个(仓根 09-02 法:能力自述、别人读表)。门自己抄一份 = 两个产地,
     * K2 改了表这道门会静静地按旧表判。
     */
    const payload = {
      dev: isDevShell(env),
      platform: process.platform,
      reserved: [...KEYS_RESERVED_FOR_CONTENT],
      menu: menu === null ? null : dumpMenuItems(menu.items as unknown as MenuItemLike[]),
    }
    writeFileSync(dumpPath, JSON.stringify(payload, null, 2), 'utf8')
  } catch (error) {
    log.warn('menu dump failed', { path: dumpPath }, error)
  }
}
