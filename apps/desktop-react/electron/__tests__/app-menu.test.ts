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
  AppMenuRenderer,
  KEYS_RESERVED_FOR_CONTENT,
  acceleratorOfChord,
  buildAppMenuTemplate,
  devReloadAccelerator,
  dumpMenuItems,
  isDevShell,
  isReservedForContent,
} from '../app-menu.js'
import type { AppMenuSpec } from '../native-view-protocol.js'

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
        id: undefined,
        label: 'Edit',
        role: 'editMenu',
        accelerator: undefined,
        type: 'submenu',
        enabled: undefined,
        submenu: [
          {
            id: undefined,
            label: 'Copy',
            role: 'copy',
            accelerator: 'CommandOrControl+C',
            type: undefined,
            enabled: undefined,
            submenu: undefined,
          },
        ],
      },
    ])
  })
})

/**
 * K4 单测:命令表投影出来的那几节。
 *
 * 三件事这里钉、真机门证不了:
 *  · **`registerAccelerator: false` 对全表成立** —— 它是硬约束(菜单只是投影,
 *    不许变成第二条键盘路)。真机门读的是装完之后的 `MenuItem`,而 Electron 不
 *    把这一格交回来,所以它的唯一守卫在这里;
 *  · **chord 串 → accelerator** 的逐条折法(平台两档);
 *  · **同签名不重建** —— Electron 的 `Menu` 不可变,换表就是整台重建。
 */
describe('K4 · 菜单从命令表画', () => {
  const spec: AppMenuSpec = {
    sections: [
      {
        label: '标签',
        items: [
          { id: 'tab.new', label: '新标签', chord: 'cmd+t', enabled: true },
          { id: 'tab.next', label: '下一个标签', chord: 'ctrl+tab', enabled: false },
          { id: 'expose.pin', label: '置顶', chord: null, enabled: false },
        ],
      },
    ],
  }

  it('⑥ 几节排在 Edit 之后、Window 之前', () => {
    const labels = buildAppMenuTemplate({ dev: false, platform: 'darwin', menu: spec })
      .map(item => item.label ?? String(item.role))
    expect(labels.indexOf('标签')).toBeGreaterThan(labels.indexOf('Edit'))
    expect(labels.indexOf('标签')).toBeLessThan(labels.indexOf('Window'))
  })

  it('⑦ 一项一行:id / 标签 / 加速键 / 画不画灰,都从表上来', () => {
    const section = buildAppMenuTemplate({ dev: false, platform: 'darwin', menu: spec })
      .find(item => item.label === '标签')
    const items = (section?.submenu ?? []) as Row[]
    expect(items.map(i => i.id)).toEqual(['tab.new', 'tab.next', 'expose.pin'])
    expect(items[0]?.accelerator).toBe('CommandOrControl+T')
    // mac 上 `ctrl` 是「另一枚」,画成 Control(不是 CommandOrControl)。
    expect(items[1]?.accelerator).toBe('Control+Tab')
    expect(items[0]?.enabled).toBe(true)
    expect(items[1]?.enabled).toBe(false)
    // 没绑键 = 没有加速键那一格(不是空串)。
    expect(items[2]?.accelerator).toBeUndefined()
  })

  it('⑧ **全表** `registerAccelerator: false` —— 菜单只显示,不注册键', () => {
    for (const platform of ['darwin', 'win32', 'linux'] as const) {
      for (const dev of [false, true]) {
        const rows = walk(buildAppMenuTemplate({ dev, platform, menu: spec }))
        const withAccel = rows.filter(row => row.accelerator && row.id)
        expect(withAccel.length).toBeGreaterThan(0)
        for (const row of withAccel) {
          expect(row.registerAccelerator, `${String(row.id)} 注册了加速键`).toBe(false)
        }
      }
    }
  })

  it('⑨ 点一项 = 把命令 id 交出去(菜单自己不做任何事)', () => {
    const seen: string[] = []
    const section = buildAppMenuTemplate({
      dev: false,
      platform: 'darwin',
      menu: spec,
      onCommand: id => { seen.push(id) },
    }).find(item => item.label === '标签')
    const items = (section?.submenu ?? []) as Row[]
    ;(items[0]?.click as () => void)()
    expect(seen).toEqual(['tab.new'])
  })

  it('⑩ chord → accelerator:两档平台各自认哪一枚是主修饰键', () => {
    // mac:cmd = 主修饰键,ctrl = 另一枚。
    expect(acceleratorOfChord('cmd+shift+f', 'darwin')).toBe('CommandOrControl+Shift+F')
    expect(acceleratorOfChord('ctrl+tab', 'darwin')).toBe('Control+Tab')
    expect(acceleratorOfChord('cmd+alt+arrowleft', 'darwin')).toBe('CommandOrControl+Alt+Left')
    expect(acceleratorOfChord('cmd+enter', 'darwin')).toBe('CommandOrControl+Return')
    expect(acceleratorOfChord('cmd+`', 'darwin')).toBe('CommandOrControl+`')
    expect(acceleratorOfChord('cmd+=', 'darwin')).toBe('CommandOrControl+=')
    expect(acceleratorOfChord('cmd+shift++', 'darwin')).toBe('CommandOrControl+Shift+Plus')
    // Win / Linux:ctrl = 主修饰键,cmd(串里)= Win 键 = Super。
    expect(acceleratorOfChord('ctrl+shift+f', 'win32')).toBe('CommandOrControl+Shift+F')
    expect(acceleratorOfChord('cmd+tab', 'win32')).toBe('Super+Tab')
    // 读不出的一律 null —— **不猜**(一个猜出来的键面是一句假话)。
    expect(acceleratorOfChord('hyper+f', 'darwin')).toBeNull()
    expect(acceleratorOfChord('cmd+', 'darwin')).toBeNull()
    expect(acceleratorOfChord('', 'darwin')).toBeNull()
    expect(acceleratorOfChord('cmd+片', 'darwin')).toBeNull()
  })

  it('⑪ 同签名不重建;签名变了才重建', () => {
    const drawn: MenuItemConstructorOptions[][] = []
    const renderer = new AppMenuRenderer({
      render: template => { drawn.push(template) },
      input: () => ({ dev: false, platform: 'darwin' }),
      onCommand: () => {},
    })
    renderer.install()
    expect(drawn.length).toBe(1)
    expect(renderer.apply(spec)).toBe(true)
    expect(drawn.length).toBe(2)
    // 逐字相同的另一份(不是同一个对象)—— 判据是签名,不是引用。
    expect(renderer.apply(JSON.parse(JSON.stringify(spec)) as AppMenuSpec)).toBe(false)
    expect(drawn.length).toBe(2)
    const moved: AppMenuSpec = {
      sections: [{ ...spec.sections[0], items: [{ ...spec.sections[0].items[0], enabled: false }] }],
    }
    expect(renderer.apply(moved)).toBe(true)
    expect(drawn.length).toBe(3)
    expect(renderer.itemOf('tab.new')?.enabled).toBe(false)
    expect(renderer.itemOf('nope')).toBeUndefined()
  })

  /**
   * **第二道闸:模板逐字相同不重建**(「菜单栏一直闪」那条报障立的保险)。
   *
   * 投影不同、落出来的模板却逐字相同的一档是真实存在的:一条键面串读不出来
   * (`acceleratorOfChord` 答 null)与没有键面,画到菜单上是同一张表。第一道
   * (投影签名)放行它,这一道必须挡住 —— 每一次 `setApplicationMenu` 都会让
   * macOS 把整条菜单栏重画一遍。每一次真画、每一次跳过都要报给排障口。
   */
  it('⑪b 模板逐字相同不重建,真画与跳过都报读数', () => {
    const drawn: MenuItemConstructorOptions[][] = []
    const draws: { seq: number; itemCount: number; reason: string }[] = []
    const skips: { reason: string; identical: string }[] = []
    const renderer = new AppMenuRenderer({
      render: template => { drawn.push(template) },
      input: () => ({ dev: false, platform: 'darwin' }),
      onCommand: () => {},
      onDraw: info => { draws.push(info) },
      onSkip: info => { skips.push(info) },
    })
    renderer.install()
    // 同一台进程再装一次:模板逐字相同 → 不重建。
    renderer.install()
    expect(drawn.length).toBe(1)
    expect(skips).toEqual([{ reason: 'install', identical: 'template' }])
    expect(draws).toEqual([{ seq: 1, itemCount: expect.any(Number), reason: 'install' }])
    expect(draws[0].itemCount).toBeGreaterThan(0)

    expect(renderer.apply(spec)).toBe(true)
    expect(draws.at(-1)).toMatchObject({ seq: 2, reason: 'spec' })
    // 投影变了(一条读不出来的键面串),模板没变 —— 第一道放行,第二道挡住。
    const unreadable: AppMenuSpec = {
      sections: spec.sections.map((section) => ({
        ...section,
        items: section.items.map((item) => (item.chord === null ? { ...item, chord: 'hyper+f' } : item)),
      })),
    }
    expect(JSON.stringify(unreadable)).not.toBe(JSON.stringify(spec))
    expect(renderer.apply(unreadable)).toBe(false)
    expect(drawn.length).toBe(2)
    expect(skips.at(-1)).toEqual({ reason: 'spec', identical: 'template' })
    // 投影逐字相同 → 第一道就挡住。
    expect(renderer.apply(JSON.parse(JSON.stringify(unreadable)) as AppMenuSpec)).toBe(false)
    expect(skips.at(-1)).toEqual({ reason: 'spec', identical: 'spec' })
    expect(drawn.length).toBe(2)
  })

  /**
   * **投影出来的项画得出内容层那七个键,而那不违反 K1** —— 判据是「占没占着」,
   * 不是「画没画出来」:`registerAccelerator: false` 的项一个键都不向系统注册,
   * 而「菜单栏上看得见 ⌘T」恰恰是 K4 要做出来的东西(macOS 用户找快捷键的第一
   * 反应)。K1 那句话管的是**角色项**,真机门 ㉑ 因此只数不带 `id` 的那些。
   */
  it('⑬ 一项画着 ⌘T 不算「占着」—— 它没注册,K1 那条仍然成立', () => {
    const rows = walk(buildAppMenuTemplate({ dev: false, platform: 'darwin', menu: spec }))
    const tabNew = rows.find(row => row.id === 'tab.new')
    expect(isReservedForContent(tabNew?.accelerator)).toBe(true)
    expect(tabNew?.registerAccelerator).toBe(false)
    // 角色项那一族照旧:一个都不许落在保留表上(⑤ 在无投影那一档已经钉过)。
    for (const row of rows.filter(item => !item.id && item.accelerator)) {
      expect(isReservedForContent(row.accelerator)).toBe(false)
    }
  })

  it('⑫ 没收到过投影 = K1 那张只做减法的表,逐字不变', () => {
    expect(buildAppMenuTemplate({ dev: false, platform: 'darwin' }))
      .toEqual(buildAppMenuTemplate({ dev: false, platform: 'darwin', menu: { sections: [] } }))
  })
})
