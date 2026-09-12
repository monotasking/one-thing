import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { render, screen as dom, waitFor } from '@testing-library/react'
import { contentKindOf } from '../../../workbench/kinds'
import { stageLauncherOf } from '../../../stage/launchers'
import { FOCUS_SCOPES } from '../../../focus/scopes'
import { findItem } from '../../../stage/items'
import { configureTerminalPort } from '../../../data/terminal-port'
import {
  configureTerminalScreenFactory,
  peekTerminalSession,
  resetTerminalRegistry,
} from '../registry'
import { resetTerminalMemory, rememberTerminalCwd, terminalCwdOf } from '../terminal-memory'
import { TerminalLeaf } from '../TerminalLeaf'
import { TERMINAL_KIND } from '../terminal-ref'
import { en } from '../../../i18n/en'
import { zh } from '../../../i18n/zh'
import type { TerminalPort } from '../../../data/terminal-port'
import type { TerminalScreen } from '../screen'
// 登记那一种内容与那块启动瓦(两处都是 import 副作用)。
import '../../kinds/terminal'
import '../../terminal-launcher'

/**
 * **叶那三档状态条 + 两处登记**(T1)。
 *
 * 这里的屏幕仍旧是一张记事本(`configureTerminalScreenFactory`),所以 jsdom 里
 * 一格 canvas 都不需要 —— 而那正是 `registry` 把屏幕做成注入口的第二个理由
 * (第一个是 xterm 在 import 的那一刻就探 canvas,判词写在那一格上)。
 */

/**
 * 这一组共用的那张记事本屏幕。**查找那三口由外面递进来**(T2):这一组要证的
 * 是「读数怎么画、键怎么送」,而「找得到找不到」是屏幕那一侧的事。
 */
function fakeScreen(find?: Partial<TerminalScreen>): TerminalScreen {
  return {
    element: document.createElement('div'),
    cols: 80,
    rows: 24,
    write: (_data, done) => done?.(),
    fit: () => null,
    resize: () => {},
    onData: () => {},
    onTitleChange: () => {},
    find: () => true,
    clearFind: () => {},
    onFindResults: () => {},
    refreshFace: () => {},
    attachKeyGuard: () => {},
    focusScreen: () => {},
    dispose: () => {},
    ...find,
  }
}

type Attach = Awaited<ReturnType<TerminalPort['attach']>>

function portWith(attach: Attach): TerminalPort {
  let onExit: ((fact: { terminalId: string; exitCode: number | null }) => void) | undefined
  const port: TerminalPort & { exit(code: number | null): void } = {
    ready: () => Promise.resolve(undefined),
    create: () => Promise.resolve({ success: false }),
    list: () => Promise.resolve({ success: true, terminals: [] }),
    write: () => Promise.resolve({ success: true }),
    resize: () => Promise.resolve({ success: true }),
    kill: () => Promise.resolve({ success: true }),
    attach: () => Promise.resolve(attach),
    ack: () => Promise.resolve({ success: true }),
    onData: () => () => {},
    onExit: (cb) => {
      onExit = cb
      return () => {
        onExit = undefined
      }
    },
    exit: (code) => onExit?.({ terminalId: 't1', exitCode: code }),
  }
  return port
}

const live: Attach = {
  success: true,
  info: { id: 't1', title: 'zsh', cwd: '/tmp/w', shell: '/bin/zsh', cols: 80, rows: 24, createdAt: 0 },
  chunks: [],
  lastSeq: 0,
  generation: 1,
}

/**
 * jsdom 没有 `ResizeObserver`。叶靠它跟着宿主量尺寸(9-9 那条「可见才量」),
 * 所以这里补一个**什么都不报**的假件 —— 这一组量的是状态条文案,不是尺寸。
 * (`ui/__tests__/flip-height.test.tsx` 里那一份是会报数的,体例相同。)
 */
class SilentResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

beforeEach(() => {
  ;(globalThis as { ResizeObserver?: unknown }).ResizeObserver = SilentResizeObserver
  configureTerminalScreenFactory(fakeScreen)
  resetTerminalMemory()
})

afterEach(() => {
  resetTerminalRegistry()
  configureTerminalPort(undefined)
  configureTerminalScreenFactory(undefined)
  resetTerminalMemory()
})

describe('状态条三档文案', () => {
  it('live:整行不画(没有消息就不占地方)', async () => {
    configureTerminalPort(portWith(live))
    render(<TerminalLeaf id="t1" />)
    await waitFor(() => expect(dom.getByTestId('terminal-leaf').dataset.terminalState).toBe('live'))
    expect(dom.queryByTestId('terminal-status')).toBeNull()
  })

  it('dead(重启后账上残留):「已结束」+「再开一个」', async () => {
    configureTerminalPort(portWith({ success: false, error: '没有这格终端' }))
    render(<TerminalLeaf id="t1" />)
    await waitFor(() => expect(dom.getByTestId('terminal-leaf').dataset.terminalState).toBe('dead'))
    // 测试环境的字典是 en(`useT` 按语言设置取,jsdom 里落英文)。
    expect(dom.getByTestId('terminal-status').textContent).toContain(en['terminal.dead'])
    expect(dom.getByTestId('terminal-status-action').textContent).toContain(
      en['terminal.openAnother'],
    )
    // 后端那句话就地一行并陈(零 Toast)。
    expect(dom.getByTestId('terminal-error').textContent).toContain('没有这格终端')
  })

  it('exited:「进程已退出(code)」+「再开一个」,屏幕保留', async () => {
    const port = portWith(live) as TerminalPort & { exit(code: number | null): void }
    configureTerminalPort(port)
    render(<TerminalLeaf id="t1" />)
    await waitFor(() => expect(dom.getByTestId('terminal-leaf').dataset.terminalState).toBe('live'))
    port.exit(130)
    await waitFor(() =>
      expect(dom.getByTestId('terminal-leaf').dataset.terminalState).toBe('exited'),
    )
    expect(dom.getByTestId('terminal-status').textContent).toContain('130')
    // 屏幕那块 DOM 还挂着 —— 人要看最后那几行。
    expect(dom.getByTestId('terminal-screen-host').childElementCount).toBe(1)
  })
})

describe('两处登记', () => {
  it('内容种类:单例、space 级、进得了全屏、激活就把焦点交给 `terminal` 作用域', () => {
    const kind = contentKindOf(TERMINAL_KIND)
    expect(kind).toBeTruthy()
    expect(kind!.singleton).toBe(true)
    expect(kind!.level).toBe('space')
    expect(kind!.fullable).toBe(true)
    expect(kind!.focusInto).toBe('terminal')
    // 关标签 = 杀:落点是 `dispose`(丢实例那条路),不是 `beforeClose`(问一句)。
    expect(typeof kind!.dispose).toBe('function')
    expect(kind!.beforeClose).toBeUndefined()
  })

  it('启动瓦:四口齐,而且 `residentKind` 指着自己那一种', () => {
    const launcher = stageLauncherOf('terminal')
    expect(launcher).toBeTruthy()
    expect(typeof launcher!.open).toBe('function')
    expect(typeof launcher!.dragRef).toBe('function')
    expect(launcher!.residentKind).toBe(TERMINAL_KIND)
    expect(launcher!.MenuRows).toBeTruthy()
  })

  it('瓦表上那一行出厂落**底架**(记忆压过它,那是形态机的事)', () => {
    expect(findItem('terminal')?.defaultPlacement).toEqual({ kind: 'edge', side: 'bottom' })
  })

  it('作用域声明三件:region 档、有局部键、**不认 Esc**(Esc 是 PTY 的键)', () => {
    expect(FOCUS_SCOPES.terminal.kind).toBe('region')
    // 五行礼让(Win / Linux;jsdom 的 UA 不是 mac)+ 一条 ⌘F(T2)。
    expect(FOCUS_SCOPES.terminal.keys?.length).toBe(6)
    expect(FOCUS_SCOPES.terminal.keys?.some((k) => k.action === 'find')).toBe(true)
    expect(FOCUS_SCOPES.terminal.passThrough).toBeUndefined()
    expect(zh[FOCUS_SCOPES.terminal.labelKey]).toBeTruthy()
    expect(en[FOCUS_SCOPES.terminal.labelKey]).toBeTruthy()
  })
})

describe('cwd 小账本', () => {
  it('记 → 取 → 忘;同一个 id 覆盖不重复长', () => {
    rememberTerminalCwd('a', '/one')
    rememberTerminalCwd('a', '/two')
    expect(terminalCwdOf('a')).toBe('/two')
    resetTerminalMemory()
    expect(terminalCwdOf('a')).toBeUndefined()
  })

  it('封顶 32 条,先进先出', () => {
    for (let i = 0; i < 40; i += 1) rememberTerminalCwd(`t${i}`, `/d${i}`)
    expect(terminalCwdOf('t0')).toBeUndefined()
    expect(terminalCwdOf('t39')).toBe('/d39')
    expect(terminalCwdOf('t8')).toBe('/d8')
  })
})

/**
 * **查找行那四态**(T2)。状态表在 `session.ts` 的 `TerminalFindState` 上,
 * 这里量的是它在屏幕上的那一半:什么时候画、读数写什么、两颗钮什么时候禁。
 *
 * 反证:把 `content/find-readout.ts` 里「`total <= 0` 答 '0'」那一支改成 `return null`
 * → 「开零命中:读数写 0」当场红。
 */
describe('查找行', () => {
  async function mounted(screen?: Partial<TerminalScreen>) {
    configureTerminalScreenFactory(() => fakeScreen(screen))
    configureTerminalPort(portWith(live))
    render(<TerminalLeaf id="t1" />)
    await waitFor(() => expect(dom.getByTestId('terminal-leaf').dataset.terminalState).toBe('live'))
    const session = peekTerminalSession('t1')
    expect(session).toBeTruthy()
    return session!
  }

  it('关:整行不画', async () => {
    await mounted()
    expect(dom.queryByTestId('terminal-find')).toBeNull()
  })

  it('开无输入:行在、读数不画、两颗钮禁着(禁令区:不给一颗按了没用的钮)', async () => {
    const session = await mounted()
    session.openFind()
    await waitFor(() => expect(dom.getByTestId('terminal-find')).toBeTruthy())
    expect(dom.queryByTestId('terminal-find-count')).toBeNull()
    expect((dom.getByTestId('terminal-find-prev') as HTMLButtonElement).disabled).toBe(true)
    expect((dom.getByTestId('terminal-find-next') as HTMLButtonElement).disabled).toBe(true)
  })

  it('开有命中:读数「3/17」', async () => {
    let report: ((r: { index: number; count: number }) => void) | undefined
    const session = await mounted({
      onFindResults: (cb) => {
        report = cb
      },
    })
    session.openFind()
    session.setFindQuery('err')
    report?.({ index: 2, count: 17 })
    await waitFor(() =>
      expect(dom.getByTestId('terminal-find-count').textContent).toBe('3/17'),
    )
  })

  it('开零命中:读数写「0」,**什么都不弹**', async () => {
    const session = await mounted({ find: () => false })
    session.openFind()
    session.setFindQuery('nope')
    await waitFor(() => expect(dom.getByTestId('terminal-find-count').textContent).toBe('0'))
  })

  it('那颗 × 收起这一行(Esc 走的是同一只 `closeFind`)', async () => {
    const session = await mounted()
    session.openFind()
    await waitFor(() => expect(dom.getByTestId('terminal-find')).toBeTruthy())
    dom.getByTestId('terminal-find-close').click()
    await waitFor(() => expect(dom.queryByTestId('terminal-find')).toBeNull())
  })
})

/*
 * 读数三档那组纯函数断言**不在这里了**(B3-b):判据与网页查找行合成了一只
 * (`content/find-readout.ts`),断言跟着搬去 `content/__tests__/find-readout.test.ts`。
 * 上面「开有命中 / 开零命中」两条留着 —— 它们量的是**这块屏幕消费了它**,
 * 而那正是合一之后这个文件该守的东西。
 */
