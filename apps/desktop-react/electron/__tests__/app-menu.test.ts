/**
 * K1 单测:应用菜单模板。
 *
 * **被测模块 `electron/app-menu.ts` 不许 import electron 的值** —— 只许 `import type`。
 * 装菜单那一半住 `app-menu-install.ts`,它才是唯一碰 `Menu` 的落点(与
 * `browser/index.ts` 同判例)。这条不是靠「反正 node 下 `Menu` 恰好是 undefined、
 * 没被调到所以不炸」撑着的 —— 那是碰巧不是设计 —— 而是由下面那条**读源文本**的
 * 用例钉住的。装上去那一半归真机门 ㉑。
 *
 * ⌘C / ⌘V 在真机门里证不了(菜单加速键走 NSApp 的 sendEvent,门里那套 CDP
 * 合成键根本不经过它),所以「Edit 的角色在不在」这件事的唯一守卫是这里的 ②。
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it, expect } from 'vitest'
import type { MenuItemConstructorOptions } from 'electron'
import {
  KEYS_RESERVED_FOR_CONTENT,
  buildAppMenuTemplate,
  devReloadAccelerator,
  dumpMenuItems,
  isDevShell,
  isReservedForContent,
} from '../app-menu.js'

type Row = MenuItemConstructorOptions

function walk(items: readonly Row[]): Row[] {
  return items.flatMap(item => {
    const kids = Array.isArray(item.submenu) ? walk(item.submenu as Row[]) : []
    return [item, ...kids]
  })
}

const rolesOf = (items: readonly Row[]): string[] =>
  walk(items).flatMap(item => (item.role ? [String(item.role)] : []))

const acceleratorsOf = (items: readonly Row[]) =>
  walk(items).map(item => item.accelerator).filter((accel): accel is string => Boolean(accel))

const BANNED_ROLES = [
  'reload',
  'forceReload',
  'zoomIn',
  'zoomOut',
  'resetZoom',
  'toggleDevTools',
  'close',
  'fileMenu',
  'windowMenu',
]

describe('应用菜单模板', () => {
  for (const platform of ['darwin', 'win32', 'linux'] as const) {
    it(`① prod 档没有任何一个被拿掉的角色(${platform})`, () => {
      const roles = rolesOf(buildAppMenuTemplate({ dev: false, platform }))
      for (const banned of BANNED_ROLES) expect(roles).not.toContain(banned)
    })

    it(`② Edit 的角色都在 —— 没有它们 macOS 上 ⌘C/⌘V 不工作(${platform})`, () => {
      const roles = rolesOf(buildAppMenuTemplate({ dev: false, platform }))
      for (const needed of ['undo', 'redo', 'cut', 'copy', 'paste', 'selectAll']) {
        expect(roles).toContain(needed)
      }
    })

    it(`⑤ 模板里没有一个加速键落在内容层那七个上(${platform},dev / prod 两档)`, () => {
      for (const dev of [false, true]) {
        for (const accel of acceleratorsOf(buildAppMenuTemplate({ dev, platform }))) {
          expect(
            isReservedForContent(accel),
            `${accel} 落在 KEYS_RESERVED_FOR_CONTENT 上(${platform}/${dev ? 'dev' : 'prod'})`,
          ).toBe(false)
        }
      }
    })
  }

  it('③ mac 档第一项是 appMenu;Win / Linux 是只放 quit 的 File', () => {
    expect(buildAppMenuTemplate({ dev: false, platform: 'darwin' })[0]?.role).toBe('appMenu')
    const win = buildAppMenuTemplate({ dev: false, platform: 'win32' })
    expect(win[0]?.label).toBe('File')
    expect(rolesOf([win[0] as Row])).toEqual(['quit'])
    expect(rolesOf(win)).not.toContain('appMenu')
  })

  it('④ dev 档有 toggleDevTools,而 Reload 的键不是 ⌘R', () => {
    const mac = buildAppMenuTemplate({ dev: true, platform: 'darwin' })
    expect(rolesOf(mac)).toContain('toggleDevTools')
    const reload = walk(mac).find(item => item.role === 'reload')
    expect(reload).toBeDefined()
    expect(reload?.accelerator).toBe(devReloadAccelerator('darwin'))
    expect(reload?.accelerator).not.toBe('CmdOrCtrl+R')
    expect(isReservedForContent(reload?.accelerator)).toBe(false)
  })

  it('保留表长这样,而且长写法 / 大小写都算命中', () => {
    expect([...KEYS_RESERVED_FOR_CONTENT]).toEqual([
      'CmdOrCtrl+R',
      'CmdOrCtrl+W',
      'CmdOrCtrl+T',
      'CmdOrCtrl+N',
      'CmdOrCtrl+Plus',
      'CmdOrCtrl+-',
      'CmdOrCtrl+0',
    ])
    // 默认菜单里那几条就是长写法 —— 判据要认得出它们,不然这道守卫形同虚设。
    expect(isReservedForContent('CommandOrControl+W')).toBe(true)
    expect(isReservedForContent('cmdorctrl+r')).toBe(true)
    expect(isReservedForContent('Command+0')).toBe(true)
    expect(isReservedForContent('Alt+Command+I')).toBe(false)
    expect(isReservedForContent(undefined)).toBe(false)
  })

  it('⌃⌘F 全屏留着(09-12 用户拍):它挂在 Window 那一族里', () => {
    for (const platform of ['darwin', 'win32', 'linux'] as const) {
      const window = buildAppMenuTemplate({ dev: false, platform })
        .find(item => item.label === 'Window')
      expect(rolesOf([window as Row])).toContain('togglefullscreen')
    }
  })

  it('被测模块只许 `import type` electron —— 读源文本钉住(先剥注释)', () => {
    const here = path.dirname(fileURLToPath(import.meta.url))
    const source = readFileSync(path.join(here, '..', 'app-menu.ts'), 'utf8')
      // 病历文本里就写着 `import { Menu } from 'electron'` 这句话(讲的是别把它搬回来),
      // 不剥注释这条断言会被自己的判词弄红 —— 仓里读源文本的门都先剥一遍。
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^[ \t]*\/\/.*$/gm, '')
    const electronImports = source.match(/^\s*import\s[^\n]*?from\s*'electron'/gm) ?? []
    expect(electronImports.length).toBeGreaterThan(0)
    for (const line of electronImports) {
      expect(line, `${line.trim()} —— 这只文件只许 import type`).toMatch(/^\s*import\s+type\s/)
    }
    // 动态 import / require 也算值导入,一并堵掉。
    expect(source).not.toMatch(/import\s*\(\s*'electron'\s*\)/)
    expect(source).not.toMatch(/require\s*\(\s*'electron'\s*\)/)
  })

  it('dev 档判据与 main.ts 同源:看 ONETHING_REACT_DEV_SERVER_URL', () => {
    expect(isDevShell({})).toBe(false)
    expect(isDevShell({ ONETHING_REACT_DEV_SERVER_URL: '' })).toBe(false)
    expect(isDevShell({ ONETHING_REACT_DEV_SERVER_URL: 'http://127.0.0.1:5199/' })).toBe(true)
  })

  it('dump 是纯函数,递归压平且丢掉 normal 这种废话', () => {
    expect(
      dumpMenuItems([
        { label: 'Edit', role: 'editMenu', type: 'submenu', submenu: { items: [
          { label: 'Copy', role: 'copy', accelerator: 'CommandOrControl+C', type: 'normal' },
        ] } },
      ]),
    ).toEqual([
      {
        label: 'Edit',
        role: 'editMenu',
        accelerator: undefined,
        type: 'submenu',
        submenu: [
          { label: 'Copy', role: 'copy', accelerator: 'CommandOrControl+C', type: undefined, submenu: undefined },
        ],
      },
    ])
  })
})
