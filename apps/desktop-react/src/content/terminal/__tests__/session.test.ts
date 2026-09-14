import { describe, expect, it, vi } from 'vitest'
import { ACK_THRESHOLD_UNITS, TerminalSession, titleOf } from '../session'
import type { TerminalPort } from '../../../data/terminal-port'
import type { TerminalScreen } from '../screen'

/**
 * **协议那一层的守卫**(T1)。
 *
 * 这一组量的全是 `TerminalSession` 要答对的那几个问题 —— 回放、去重、重置、
 * 代次、生死、隐藏时不报尺寸。它一格 xterm 都不需要:屏幕是个口
 * (`screen.ts` 的 `TerminalScreen`),这里塞一张记事本进去。
 *
 * 反证纪律(每条守卫断言至少真跑一次「拆掉即红」),三条写在用例名里:
 *  · 把 `feed` 里 `seq <= lastSeq` 那一句拆掉 → 「旧帧一律丢」红;
 *  · 把 `fit()` 里「量不出来就什么都不做」拆掉 → 「隐藏时不报尺寸」红;
 *  · 把 `countAck` 的代次判据拆掉 → 「上一代的回调不许拿新代次回执」红。
 */

/** 一张记事本屏幕。它只记下别人让它做过什么。 */
function fakeScreen() {
  const written: string[] = []
  const dones: (() => void)[] = []
  let size: { cols: number; rows: number } | null = null
  let onDataCb: ((data: string) => void) | undefined
  let onTitleCb: ((title: string) => void) | undefined
  let onFindCb: ((results: { index: number; count: number }) => void) | undefined
  const screen: TerminalScreen & {
    written: string[]
    flush(): void
    setFit(next: { cols: number; rows: number } | null): void
    type(data: string): void
    setTitle(title: string): void
    resized: [number, number][]
    disposed: boolean
    finds: [string, 'next' | 'previous'][]
    cleared: number
    findAnswer: boolean
    report(index: number, count: number): void
  } = {
    element: { dataset: {} } as unknown as HTMLElement,
    cols: 80,
    rows: 24,
    written,
    resized: [],
    disposed: false,
    finds: [],
    cleared: 0,
    findAnswer: true,
    write: (data, done) => {
      written.push(data)
      if (done) dones.push(done)
    },
    /** 把攒着的「画完了」回调一次性跑掉(真 xterm 是异步回调的)。 */
    flush: () => {
      for (const done of dones.splice(0)) done()
    },
    fit: () => size,
    setFit: (next) => {
      size = next
    },
    resize: (cols, rows) => {
      screen.resized.push([cols, rows])
    },
    onData: (cb) => {
      onDataCb = cb
    },
    onTitleChange: (cb) => {
      onTitleCb = cb
    },
    /* 查找那三口(T2)。记事本只记「被问了什么」,答案由用例钉。 */
    find: (term, direction) => {
      screen.finds.push([term, direction])
      return screen.findAnswer
    },
    clearFind: () => {
      screen.cleared += 1
    },
    onFindResults: (cb) => {
      onFindCb = cb
    },
    report: (index, count) => onFindCb?.({ index, count }),
    type: (data) => onDataCb?.(data),
    setTitle: (title) => onTitleCb?.(title),
    refreshFace: () => {},
    attachKeyGuard: () => {},
    focusScreen: () => {},
    dispose: () => {
      screen.disposed = true
    },
  }
  return screen
}

type Attach = Awaited<ReturnType<TerminalPort['attach']>>

function fakePort(attach: Attach) {
  let onData: ((fact: { terminalId: string; seq: number; data: string }) => void) | undefined
  let onExit: ((fact: { terminalId: string; exitCode: number | null }) => void) | undefined
  const acks: { bytes: number; generation: number }[] = []
  const writes: string[] = []
  const resizes: [number, number][] = []
  let attachAnswer = attach
  const port: TerminalPort & {
    acks: typeof acks
    writes: typeof writes
    resizes: typeof resizes
    push(seq: number, data: string): void
    exit(code: number | null): void
    setAttach(next: Attach): void
    writeAnswer: { success: boolean; error?: string }
  } = {
    acks,
    writes,
    resizes,
    writeAnswer: { success: true },
    ready: () => Promise.resolve(undefined),
    create: () => Promise.resolve({ success: false }),
    list: () => Promise.resolve({ success: true, terminals: [] }),
    write: (_id, data) => {
      writes.push(data)
      return Promise.resolve(port.writeAnswer)
    },
    resize: (_id, cols, rows) => {
      resizes.push([cols, rows])
      return Promise.resolve({ success: true })
    },
    kill: () => Promise.resolve({ success: true }),
    attach: () => Promise.resolve(attachAnswer),
    ack: (_id, bytes, generation) => {
      acks.push({ bytes, generation })
      return Promise.resolve({ success: true })
    },
    onData: (cb) => {
      onData = cb
      return () => {
        onData = undefined
      }
    },
    onExit: (cb) => {
      onExit = cb
      return () => {
        onExit = undefined
      }
    },
    push: (seq, data) => onData?.({ terminalId: 't1', seq, data }),
    exit: (code) => onExit?.({ terminalId: 't1', exitCode: code }),
    setAttach: (next) => {
      attachAnswer = next
    },
  }
  return port
}

const okAttach = (over: Partial<Attach> = {}): Attach => ({
  success: true,
  info: { id: 't1', title: 'zsh', cwd: '/tmp/work', shell: '/bin/zsh', cols: 100, rows: 30, createdAt: 0 },
  chunks: [{ seq: 1, data: 'hello' }],
  lastSeq: 1,
  generation: 1,
  ...over,
})

function build(attach: Attach = okAttach()) {
  const screen = fakeScreen()
  const port = fakePort(attach)
  const session = new TerminalSession('t1', { port, screen })
  return { screen, port, session }
}

describe('attach:回放、网格、重置', () => {
  it('先按 info 钉住网格,再逐条回放;lastSeq 与 cwd 记下来', async () => {
    const { screen, session } = build()
    await session.attach()
    expect(screen.resized).toEqual([[100, 30]])
    expect(screen.written).toEqual(['hello'])
    expect(session.get().state).toBe('live')
    expect(session.get().cwd).toBe('/tmp/work')
  })

  it('truncated 时**先写一个全重置**再回放(ring 绕过一圈,回放可能从半条转义序列开始)', async () => {
    const { screen, session } = build(okAttach({ truncated: true }))
    await session.attach()
    expect(screen.written).toEqual(['\x1bc', 'hello'])
  })

  it('回放那一段**不记账**(契约原话:replayed chunks must NOT be acked)', async () => {
    const { screen, port, session } = build(
      okAttach({ chunks: [{ seq: 1, data: 'x'.repeat(ACK_THRESHOLD_UNITS * 2) }] }),
    )
    await session.attach()
    screen.flush()
    expect(port.acks).toEqual([])
  })

  it('attach 不成功 = `dead`(账上有 id,机器上没有那格 PTY)', async () => {
    const { session } = build({ success: false, error: '没有这格终端' })
    await session.attach()
    expect(session.get().state).toBe('dead')
    expect(session.get().error).toBe('没有这格终端')
  })
})

describe('推送:按 seq 去重', () => {
  it('**旧帧一律丢**(反证:拆掉 `seq <= lastSeq` 这一句,这条当场红)', async () => {
    const { screen, port, session } = build()
    await session.attach()
    screen.written.length = 0
    port.push(1, '回放里已经有的') // 旧
    port.push(2, '新的')
    port.push(2, '重复的') // 同号
    port.push(3, '再一条')
    expect(screen.written).toEqual(['新的', '再一条'])
  })
})

describe('流控:按字节、带代次', () => {
  it('攒够阈值才回执一次,而且带的是当下那个代次', async () => {
    const { screen, port, session } = build()
    await session.attach()
    port.push(2, 'a'.repeat(ACK_THRESHOLD_UNITS - 1))
    screen.flush()
    expect(port.acks).toEqual([]) // 还没攒够
    port.push(3, 'bb')
    screen.flush()
    expect(port.acks).toEqual([{ bytes: ACK_THRESHOLD_UNITS + 1, generation: 1 }])
  })

  it('**上一代的回调不许拿新代次去回执**(反证:拆掉 `countAck` 的代次判据即红)', async () => {
    const { screen, port, session } = build()
    await session.attach()
    port.push(2, 'a'.repeat(ACK_THRESHOLD_UNITS))
    // 这一段还没「画完」,此刻重新 attach 一次:代次换成 2、账本清零。
    port.setAttach(okAttach({ generation: 2, lastSeq: 9, chunks: [] }))
    await session.attach()
    screen.flush() // 上一代那一段现在才回调
    expect(port.acks).toEqual([])
  })
})

describe('生死', () => {
  it('exit 推送 → `exited`,退出码上屏;屏幕保留', async () => {
    const { screen, port, session } = build()
    await session.attach()
    port.exit(130)
    expect(session.get().state).toBe('exited')
    expect(session.get().exitCode).toBe(130)
    expect(screen.disposed).toBe(false)
  })

  it('`exited` 之后用户按键一个字节都不发', async () => {
    const { screen, port, session } = build()
    await session.attach()
    port.exit(0)
    screen.type('ls\r')
    expect(port.writes).toEqual([])
  })

  /*
   * 程序化写入(2026-09-14,代码块那颗「运行」)。守的是**它与键盘同一条路**:
   * 同一个 `send`、同一条生死判据。反证:把 `input` 改成直调 `deps.port.write`
   * → 「`exited` 之后一字节都不发」当场红(那条判据只写在 `send` 里)。
   */
  it('`input` 直达 PTY —— 与键盘同一条路', async () => {
    const { port, session } = build()
    await session.attach()
    await session.input('echo hi\n')
    expect(port.writes).toEqual(['echo hi\n'])
  })

  it('`exited` 之后 `input` 同样一个字节都不发', async () => {
    const { port, session } = build()
    await session.attach()
    port.exit(0)
    await session.input('echo hi\n')
    expect(port.writes).toEqual([])
  })

  it('一发往返报了不成功 → `detached`(这份订阅不再可信),屏幕停在最后一帧', async () => {
    const { screen, port, session } = build()
    await session.attach()
    port.writeAnswer = { success: false, error: '没有这格终端' }
    screen.type('x')
    await Promise.resolve()
    await Promise.resolve()
    expect(session.get().state).toBe('detached')
    expect(screen.disposed).toBe(false)
  })

  it('死讯不许被一次迟到的 attach 盖掉', async () => {
    const { port, session } = build()
    const flying = session.attach()
    port.exit(1)
    await flying
    expect(session.get().state).toBe('exited')
  })

  it('`dispose()` 只拆这一侧:屏幕销毁、**PTY 一个字都不碰**', async () => {
    const { screen, port, session } = build()
    await session.attach()
    const killed = vi.spyOn(port, 'kill')
    session.dispose()
    expect(screen.disposed).toBe(true)
    expect(killed).not.toHaveBeenCalled()
  })
})

describe('尺寸:9-9', () => {
  it('**量不出来就什么都不报**(反证:拆掉 `fit()` 里那句 null 判据即红 —— 隐藏层里会发 resize(0,0))', async () => {
    const { screen, port, session } = build()
    await session.attach()
    port.resizes.length = 0
    screen.setFit(null) // 容器没尺寸(content-visibility: hidden)
    session.fit()
    expect(port.resizes).toEqual([])
    screen.setFit({ cols: 120, rows: 40 }) // 切回来了
    session.fit()
    expect(port.resizes).toEqual([[120, 40]])
  })

  it('`exited` / `dead` 之后不报尺寸(那头没有人收)', async () => {
    const { screen, port, session } = build()
    await session.attach()
    port.exit(0)
    port.resizes.length = 0
    screen.setFit({ cols: 120, rows: 40 })
    session.fit()
    expect(port.resizes).toEqual([])
  })
})

describe('用户按键与礼让键', () => {
  it('按键直调 `write`,**不过资源管线**', async () => {
    const { screen, port, session } = build()
    await session.attach()
    screen.type('ls\r')
    expect(port.writes).toEqual(['ls\r'])
  })

  /*
   * ── 「礼让键写成那个控制字节」随 K0 退役 ──────────────────────────────
   * 那条用例钉的是 `sendCourtesyKey`:壳先 `preventDefault` 掉 `Ctrl+W`,再自己
   * 往 PTY 写一个 `\x17`。K0 把礼让表改成 `claims`(认领并**放行**),派发器不再
   * 截这一下,xterm 收到原生 keydown 自己就会写那个字节 —— 少了一次翻译,也就
   * 没有了「哪个字母对哪个字节」这份第二真相。等价性改由
   * `focus/__tests__/transitions.test.ts` 的认领那一组钉(Win 档 Ctrl+P → `claim`、
   * 不跑 `toggle:search`、事件未被 preventDefault)。
   */
})

describe('活标题三档', () => {
  it('OSC 标题 → cwd 末段 → shell 名', () => {
    expect(titleOf('npm run dev', '/a/b', 'zsh')).toBe('npm run dev')
    expect(titleOf('   ', '/a/b/', 'zsh')).toBe('b')
    expect(titleOf('', undefined, 'zsh')).toBe('zsh')
    expect(titleOf('', undefined, '')).toBe('')
  })

  it('OSC 一到就盖掉 cwd 那一档', async () => {
    const { screen, session } = build()
    await session.attach()
    expect(session.get().title).toBe('work')
    screen.setTitle('vim README.md')
    expect(session.get().title).toBe('vim README.md')
  })
})

/**
 * **查找那四档**(T2)。判词整段在 `session.ts` 的 `TerminalFindState` 上:
 * 它住在实例上而不是组件里,因为「找的是什么词 / 屏幕上亮着哪几处」的寿命是
 * 那格 PTY,不是这一次挂载。
 *
 * 反证(每条真跑过「拆掉即红」):
 *  · 把 `setFindQuery` 里「空词 = 清高亮」那一支拆掉 → 「空词清高亮」红;
 *  · 把 `runFind` 里 `if (!found)` 那一句拆掉 → 「找不到读数是 0」红;
 *  · 把 `onFindResults` 回调开头那句 `if (!this.find.open) return` 拆掉 →
 *    「收起之后迟到的读数不许再画上来」红。
 */
describe('终端内查找', () => {
  it('开 → 打字 → 就地往下找一次(增量那一档由屏幕自己管)', async () => {
    const { screen, session } = build()
    await session.attach()
    expect(session.get().find).toEqual({ open: false, query: '', index: -1, count: 0 })
    session.openFind()
    expect(session.get().find.open).toBe(true)
    session.setFindQuery('err')
    expect(screen.finds).toEqual([['err', 'next']])
  })

  it('空词清高亮、读数归零(**不是**去找一个空串)', async () => {
    const { screen, session } = build()
    await session.attach()
    session.openFind()
    session.setFindQuery('err')
    screen.report(2, 17)
    expect(session.get().find).toMatchObject({ index: 2, count: 17 })
    screen.finds.length = 0
    session.setFindQuery('')
    expect(screen.finds).toEqual([])
    expect(screen.cleared).toBe(1)
    expect(session.get().find).toMatchObject({ query: '', index: -1, count: 0 })
  })

  it('找不到:读数是 0(装饰关着时这条布尔答案是唯一的读数来源)', async () => {
    const { screen, session } = build()
    await session.attach()
    session.openFind()
    screen.findAnswer = false
    session.setFindQuery('nope')
    expect(session.get().find).toMatchObject({ count: 0, index: -1 })
  })

  it('上一处 / 下一处按方向问屏幕;词空着时一格都不动', async () => {
    const { screen, session } = build()
    await session.attach()
    session.openFind()
    session.findNext()
    session.findPrevious()
    expect(screen.finds).toEqual([])
    session.setFindQuery('err')
    screen.finds.length = 0
    session.findPrevious()
    session.findNext()
    expect(screen.finds).toEqual([
      ['err', 'previous'],
      ['err', 'next'],
    ])
  })

  it('收起:清高亮、读数归零、**词留着**;迟到的读数不许再画上来', async () => {
    const { screen, session } = build()
    await session.attach()
    session.openFind()
    session.setFindQuery('err')
    screen.report(0, 3)
    session.closeFind()
    expect(screen.cleared).toBe(1)
    expect(session.get().find).toEqual({ open: false, query: 'err', index: -1, count: 0 })
    screen.report(1, 9)
    expect(session.get().find).toMatchObject({ index: -1, count: 0 })
  })
})
