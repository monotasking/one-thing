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
  const screen: TerminalScreen & {
    written: string[]
    flush(): void
    setFit(next: { cols: number; rows: number } | null): void
    type(data: string): void
    setTitle(title: string): void
    resized: [number, number][]
    disposed: boolean
  } = {
    element: { dataset: {} } as unknown as HTMLElement,
    cols: 80,
    rows: 24,
    written,
    resized: [],
    disposed: false,
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

  it('礼让键写成那个控制字节(`w` → 0x17)', async () => {
    const { port, session } = build()
    await session.attach()
    session.sendCourtesyKey('w')
    expect(port.writes).toEqual(['\x17'])
  })
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
