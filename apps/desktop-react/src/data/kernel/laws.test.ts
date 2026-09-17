import { describe, expect, it, vi } from 'vitest'
import { createMutation } from './mutation'
import { createQuery, createQueryFamily } from './query'

/**
 * 四律,一律一组,**每组配一个反证**。
 *
 * 反证的形式是**对照组**:同一段剧情跑两遍,一遍走 kernel,一遍走一个刻意
 * 手写的、没有这条性质的小实现。两遍读数不同,才说明断言守的是真东西而不是
 * 在陪跑 —— 一条「refetch 之后 data 还在」的断言,如果换成任何实现都是绿的,
 * 它就什么都没守住。
 *
 * 剧情用可控的 deferred(不是 setTimeout):并发折叠这一条要的正是「两发在
 * 同一时刻都还没落地」,拿计时器去撞那一刻是碰运气。
 */

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

/* ══ 律② 重拉期间旧内容保留在屏(keep-previous 是性质)══════════════════ */

describe('律② keep-previous', () => {
  it('refetch 在飞时 data 一直在,phase 停在 ready,inflight 单独说话', async () => {
    const gates = [deferred<string[]>(), deferred<string[]>()]
    let call = 0
    const q = createQuery<string[]>('t.keep', () => gates[call++].promise)

    const first = q.ensure()
    expect(q.get().phase).toBe('initial')
    expect(q.get().inflight).toBe(true)
    gates[0].resolve(['a'])
    await first

    expect(q.get().data).toEqual(['a'])
    expect(q.get().phase).toBe('ready')

    const second = q.refetch()
    // 这三行就是律②:在飞、旧数据还在、phase 没退回 initial。
    expect(q.get().inflight).toBe(true)
    expect(q.get().data).toEqual(['a'])
    expect(q.get().phase).toBe('ready')

    gates[1].resolve(['a', 'b'])
    await second
    expect(q.get().data).toEqual(['a', 'b'])
    expect(q.get().inflight).toBe(false)
  })

  it('失败**不清 data**:错误与旧答案共存,如实并陈', async () => {
    let call = 0
    const q = createQuery<string[]>('t.keep-error', async () => {
      call += 1
      if (call === 1) return ['a']
      throw new Error('402 Insufficient Balance')
    })
    await q.ensure()
    await q.refetch()

    expect(q.get().data).toEqual(['a'])
    expect(q.get().error).toBe('402 Insufficient Balance')
    expect(q.get().phase).toBe('ready')
  })

  it('反证:同一段剧情走「重拉先清空」的手写状态机,中途读到的是空', async () => {
    // 这就是今天壳里那几处手写的形状 —— 一个不分首载/重拉的 status。
    const hand = {
      data: undefined as string[] | undefined,
      status: 'idle' as 'idle' | 'loading' | 'ready',
      async load(value: string[]) {
        this.status = 'loading'
        this.data = undefined // ← 病灶:重拉清空
        this.data = await Promise.resolve(value)
        this.status = 'ready'
      },
    }
    await hand.load(['a'])
    const during = hand.load(['a', 'b'])
    expect(hand.data).toBeUndefined() // 屏幕在这一刻是空的 = 用户看见的「闪」
    expect(hand.status).toBe('loading') // 而且骨架的判据也塌了
    await during
  })
})

/* ══ 律① 写就地更新,失败回滚(乐观 / 回滚 / 对账三分家)═══════════════ */

describe('律① 乐观与回滚', () => {
  it('乐观补丁立刻上屏;失败回滚回补丁之前,并交出后端原话', async () => {
    const q = createQuery<string[]>('t.opt', async () => ['a'])
    await q.ensure()

    const seen: string[] = []
    const m = createMutation<string, void>('t.opt.write', {
      key: (id) => id,
      optimistic: (id) => q.patch((prev) => [...(prev ?? []), id]),
      run: async () => {
        throw new Error('存不进去')
      },
      onError: (error) => seen.push(error.message),
    })

    const running = m.run('b')
    // 上屏零延迟:还没 await 呢,屏幕已经是写完的样子。
    expect(q.get().data).toEqual(['a', 'b'])
    expect(m.isPending('b')).toBe(true)

    await running
    expect(q.get().data).toEqual(['a']) // 回滚:后端没认下的牌不留在屏幕上
    expect(seen).toEqual(['存不进去'])
    expect(m.get().error).toBe('存不进去')
    expect(m.isPending('b')).toBe(false)
  })

  it('成功走 settle 对账:invalidate 后台补拉,**不清屏**', async () => {
    const gates = [deferred<string[]>(), deferred<string[]>()]
    let call = 0
    const q = createQuery<string[]>('t.settle', () => gates[call++].promise)
    const first = q.ensure()
    gates[0].resolve(['a'])
    await first
    // 有订阅者,invalidate 才会补拉 —— 没人看的面不该偷偷发请求。
    q.subscribe(() => undefined)

    const m = createMutation<string, void>('t.settle.write', {
      optimistic: () => q.patch(['a', 'b']),
      run: async () => undefined,
      settle: () => q.invalidate(),
    })

    await m.run('b')
    // 对账那一发还在飞:屏幕仍是乐观值,phase 一刻都没退回骨架。
    expect(q.get().inflight).toBe(true)
    expect(q.get().data).toEqual(['a', 'b'])
    expect(q.get().phase).toBe('ready')

    gates[1].resolve(['a', 'b', 'server-said-c'])
    await gates[1].promise
    await Promise.resolve()
    expect(q.get().data).toEqual(['a', 'b', 'server-said-c'])
  })

  it('反证:回滚不是 kernel 给的时,手抄的那一份会漏 —— 屏幕留着假牌', async () => {
    const board = { rows: ['a'] }
    // 「乐观在这里写、回滚在那里抄」是今天写口的普遍形状。抄漏一格就留假牌。
    async function handWritten(id: string) {
      board.rows = [...board.rows, id]
      try {
        throw new Error('存不进去')
      } catch {
        // ← 这里本该把 rows 退回去。抄的时候漏了,而且没人看得出来。
      }
    }
    await handWritten('b')
    expect(board.rows).toEqual(['a', 'b']) // 后端没认下,屏幕上却有
  })
})

/* ══ 并发折叠(同 key 复用在飞的那一发)══════════════════════════════════ */

describe('并发折叠', () => {
  it('同一格同时只有一发:三个消费者共用在飞的那一发', async () => {
    const gate = deferred<string[]>()
    const fetcher = vi.fn(async () => gate.promise)
    const fam = createQueryFamily<string[]>('t.fold', fetcher)
    const q = fam.get('claude')

    const a = q.ensure()
    const b = q.ensure()
    const c = q.ensure()
    expect(fetcher).toHaveBeenCalledTimes(1)

    gate.resolve(['x'])
    await Promise.all([a, b, c])
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(q.get().data).toEqual(['x'])
  })

  it('两下「刷新」连点也折成一发 —— 强制与强制之间没有第二种意图', async () => {
    const gate = deferred<string[]>()
    const fetcher = vi.fn(async () => gate.promise)
    const q = createQuery<string[]>('t.fold-hard', fetcher)
    const a = q.refetch()
    const b = q.refetch()
    expect(fetcher).toHaveBeenCalledTimes(1)
    gate.resolve(['x'])
    await Promise.all([a, b])
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('别的格不折进来:一族里每一格各拉各的', async () => {
    const fetcher = vi.fn(async (ctx: { key: string }) => [ctx.key])
    const fam = createQueryFamily<string[]>('t.fold2', fetcher)
    await Promise.all([fam.get('a').ensure(), fam.get('b').ensure()])
    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(fam.get('a').get().data).toEqual(['a'])
    expect(fam.get('b').get().data).toEqual(['b'])
  })

  it('在飞的是非强制而这次是「刷新」:排在后面再发一发,不静默吞掉这个意图', async () => {
    const gates = [deferred<string[]>(), deferred<string[]>()]
    const forced: boolean[] = []
    let call = 0
    const q = createQuery<string[]>('t.fold3', (ctx) => {
      forced.push(ctx.force)
      return gates[call++].promise
    })

    const soft = q.ensure()
    const hard = q.refetch()
    gates[0].resolve(['old'])
    await soft
    gates[1].resolve(['new'])
    await hard

    expect(forced).toEqual([false, true])
    expect(q.get().data).toEqual(['new'])
  })

  it('反证:没有折叠的手写版,三个消费者发三发', async () => {
    const fetcher = vi.fn(async () => ['x'])
    async function handWritten() {
      return fetcher()
    }
    await Promise.all([handWritten(), handWritten(), handWritten()])
    expect(fetcher).toHaveBeenCalledTimes(3)
  })
})

/* ══ 律④ 快照身份稳定 ═══════════════════════════════════════════════════ */

describe('律④ 身份稳定', () => {
  it('读数没变就是同一个快照对象', async () => {
    const q = createQuery<string[]>('t.id', async () => ['a'])
    await q.ensure()
    expect(q.get()).toBe(q.get())
  })

  it('答案逐字相同的一次重拉:data 不换引用,dataRev 不动,时刻照样前进', async () => {
    const rows = ['a', 'b']
    // equals 一给,「答案没变」就是可判定的事实 —— 于是行组件不必重渲。
    const q = createQuery<string[]>('t.id2', async () => [...rows], {
      equals: (a, b) => a.length === b.length && a.every((item, i) => item === b[i]),
    })
    await q.ensure()
    const first = q.get()

    await q.refetch()
    const second = q.get()

    expect(second.data).toBe(first.data) // 同一个数组 —— key 不漂,行不重挂
    expect(second.dataRev).toBe(first.dataRev)
    expect(second.updatedAt).toBeGreaterThanOrEqual(first.updatedAt)
    expect(second).not.toBe(first) // 但快照本身变了(时刻前进了),如实说
  })

  it('答案真的变了:dataRev 前进一格', async () => {
    let served = ['a']
    const q = createQuery<string[]>('t.id3', async () => served, {
      equals: (a, b) => a.length === b.length && a.every((item, i) => item === b[i]),
    })
    await q.ensure()
    const before = q.get().dataRev
    served = ['a', 'b']
    await q.refetch()
    expect(q.get().dataRev).toBe(before + 1)
  })

  it('反证:每次都新造一份的手写版,引用每次都换 —— 整表重挂', async () => {
    const load = async () => ['a', 'b']
    const first = await load()
    const second = await load()
    expect(second).not.toBe(first) // 同样的内容,不同的身份
  })
})

/* ══ 顺带钉死的几条形状 ═════════════════════════════════════════════════ */

describe('ensure / invalidate 的边界', () => {
  it('ensure 问过一次就不再问;refetch 每次都问', async () => {
    const fetcher = vi.fn(async () => ['a'])
    const q = createQuery<string[]>('t.ensure', fetcher)
    await q.ensure()
    await q.ensure()
    expect(fetcher).toHaveBeenCalledTimes(1)
    await q.refetch()
    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  it('失败过的算没问过:下一次 ensure 会重试', async () => {
    const fetcher = vi.fn(async () => {
      throw new Error('nope')
    })
    const q = createQuery<string[]>('t.ensure2', fetcher)
    await q.ensure()
    await q.ensure()
    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  it('没人订阅时 invalidate 只标脏,不偷偷发请求', async () => {
    const fetcher = vi.fn(async () => ['a'])
    const q = createQuery<string[]>('t.inv', fetcher)
    await q.ensure()
    q.invalidate()
    expect(fetcher).toHaveBeenCalledTimes(1)
    await q.ensure() // 脏了,所以这一次真的问
    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  it('在飞时再标脏:那一发落定之后**再问一次**(它的答案是变化之前取的)', async () => {
    let answer = 'old'
    let release: () => void = () => undefined
    const fetcher = vi.fn(() => new Promise<string[]>(resolve => { const now = answer; release = () => resolve([now]) }))
    const q = createQuery<string[]>('t.inv3', fetcher)
    q.subscribe(() => undefined)
    const first = q.refetch()
    answer = 'new'
    q.invalidate() // 外部在这一刻改了数据
    release()
    await first
    await Promise.resolve()
    expect(fetcher).toHaveBeenCalledTimes(2)
    release()
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(q.get().data).toEqual(['new'])
  })

  it('有订阅者时 invalidate 后台补拉', async () => {
    const fetcher = vi.fn(async () => ['a'])
    const q = createQuery<string[]>('t.inv2', fetcher)
    await q.ensure()
    q.subscribe(() => undefined)
    q.invalidate()
    await Promise.resolve()
    expect(fetcher).toHaveBeenCalledTimes(2)
  })
})

/* ══ 一族的两口:drop(键指的东西没了)与 subscribe(整族)══════════════ */

describe('QueryFamily.drop —— 与 invalidate 是两件事', () => {
  it('丢格 = 那个键从家里消失,再问就是一次真的首载', async () => {
    const fetcher = vi.fn(async () => ['a'])
    const fam = createQueryFamily<string[]>('t.drop', fetcher)
    await fam.get('x').ensure()
    expect(fam.keys()).toEqual(['x'])

    fam.drop('x')
    expect(fam.keys()).toEqual([])
    await fam.get('x').ensure()
    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  /**
   * **反证(对照组)**:同一段剧情换成 `invalidate`,读数当场不同 ——
   * 有人订着的那一格会**后台补拉一发**(问的还是那个已经不存在的东西),
   * 而且格还留在家里。这两行读数说明 `drop` 守的是真东西,不是 `invalidate` 的别名。
   */
  it('反证:换成 invalidate,格还在、而且当场多发一发', async () => {
    const fetcher = vi.fn(async () => ['a'])
    const fam = createQueryFamily<string[]>('t.drop-vs-inv', fetcher)
    await fam.get('x').ensure()
    fam.get('x').subscribe(() => undefined)

    fam.invalidate('x')
    await Promise.resolve()
    expect(fetcher).toHaveBeenCalledTimes(2) // 补拉了
    expect(fam.keys()).toEqual(['x']) // 格还在

    fam.drop('x')
    await Promise.resolve()
    expect(fetcher).toHaveBeenCalledTimes(2) // drop 不发请求
    expect(fam.keys()).toEqual([])
  })

  it('还订着那一格的人当场看见「回到出厂」', async () => {
    const fam = createQueryFamily<string[]>('t.drop-emit', async () => ['a'])
    const seat = fam.get('x')
    await seat.ensure()
    let heard = 0
    seat.subscribe(() => {
      heard += 1
    })
    fam.drop('x')
    expect(heard).toBe(1)
    expect(seat.get().phase).toBe('initial')
    expect(seat.get().data).toBeUndefined()
  })

  it('没建过的键是恒等变换:不建格、不喊人', () => {
    const fam = createQueryFamily<string[]>('t.drop-miss', async () => ['a'])
    let heard = 0
    fam.subscribe(() => {
      heard += 1
    })
    fam.drop('never')
    expect(fam.keys()).toEqual([])
    expect(heard).toBe(0)
  })
})

describe('QueryFamily.subscribe —— 订整族', () => {
  it('任何一格 emit 都喊一次,包括订阅之后才建出来的那一格', async () => {
    const fam = createQueryFamily<string[]>('t.fam-sub', async () => ['a'])
    let heard = 0
    const off = fam.subscribe(() => {
      heard += 1
    })
    await fam.get('later').ensure() // 订的时候这一格还不存在
    expect(heard).toBeGreaterThan(0)

    const before = heard
    off()
    await fam.get('other').ensure()
    expect(heard).toBe(before) // 退订之后一声都不再喊
  })

  /**
   * **反证**:整族订阅**不能**顺手把每一格算成「有人在看」。
   * 若家长是靠 `entry.subscribe()` 实现的,`listeners.size > 0` 会恒真,
   * 于是「没人看就只标脏」那一档当场消失 —— 这一条读的正是那个读数。
   */
  it('反证:只订整族不算「有人在看」,invalidate 仍然只标脏', async () => {
    const fetcher = vi.fn(async () => ['a'])
    const fam = createQueryFamily<string[]>('t.fam-sub-quiet', fetcher)
    await fam.get('x').ensure()
    fam.subscribe(() => undefined)

    fam.invalidate('x')
    await Promise.resolve()
    expect(fetcher).toHaveBeenCalledTimes(1) // 没有偷偷补拉
    await fam.get('x').ensure()
    expect(fetcher).toHaveBeenCalledTimes(2) // 但确实脏了
  })
})

describe('mutation 的忙态是逐格的', () => {
  it('两格各忙各的;整体读数说「有人在忙」', async () => {
    const gates = new Map<string, ReturnType<typeof deferred<void>>>()
    const m = createMutation<string, void>('t.busy', {
      key: (id) => id,
      run: (id) => {
        const gate = deferred<void>()
        gates.set(id, gate)
        return gate.promise
      },
    })

    const a = m.run('a')
    expect(m.isPending('a')).toBe(true)
    expect(m.isPending('b')).toBe(false)
    expect(m.isPending()).toBe(true)

    gates.get('a')!.resolve()
    await a
    expect(m.isPending()).toBe(false)
  })

  it('同一格连点两下:第一发收尾不解禁第二发', async () => {
    const gates: ReturnType<typeof deferred<void>>[] = []
    const m = createMutation<string, void>('t.busy2', {
      key: (id) => id,
      run: () => {
        const gate = deferred<void>()
        gates.push(gate)
        return gate.promise
      },
    })
    const first = m.run('a')
    const second = m.run('a')
    gates[0].resolve()
    await first
    expect(m.isPending('a')).toBe(true)
    gates[1].resolve()
    await second
    expect(m.isPending('a')).toBe(false)
  })

  it('run 不抛 —— 失败已经在原语里处理完了', async () => {
    const m = createMutation<void, string>('t.throw', {
      run: async () => {
        throw new Error('boom')
      },
    })
    await expect(m.run(undefined)).resolves.toBeUndefined()
  })
})

/* ══ 撤回:同一格上后一发发车时,前一发的信号被拉 ════════════════════════ */

/**
 * 09-07 事故第四条修的 kernel 一半:一发取数被顶掉之后,它可能正让后端去扫一整棵
 * 目录树(真机上那是两条 462% CPU 的 `rg`)。kernel 说不出「该等多久」,但它说得出
 * **「这一发的答案已经没人要了」** —— 那就是 `FetchContext.signal`。
 *
 * 三条边界一起钉:①律①②③ 一格不变(在飞的那一发照旧跑完、答案照旧落地);
 * ②被顶掉的那一发**不留 error**;③`reset()` 也拉。
 */
describe('FetchContext.signal(撤回)', () => {
  it('同格连发两次:第一发的 signal 被 abort,第二发的没有', async () => {
    const gates = [deferred<string[]>(), deferred<string[]>()]
    const signals: AbortSignal[] = []
    let call = 0
    const q = createQuery<string[]>('t.abort', (ctx) => {
      signals.push(ctx.signal!)
      return gates[call++].promise
    })

    const soft = q.ensure()
    // 「刷新」= 第二发真的发车(这是今天唯一一种不被折叠的连发)。
    const hard = q.refetch()
    /*
     * 反证:把 `start` 里那句 `running.abort.abort(SUPERSEDED)` 注掉 →
     * 这一条当场红(第一发的信号一直是 false),而真机上那两条 rg 就是这么活下来的。
     */
    expect(signals[0].aborted).toBe(true)

    gates[0].resolve(['old'])
    await soft
    gates[1].resolve(['new'])
    await hard

    expect(signals).toHaveLength(2)
    expect(signals[1].aborted).toBe(false)
    // 律②③ 一格不变:两发都跑完,后一发的答案落地。
    expect(q.get().data).toEqual(['new'])
    expect(q.get().error).toBeUndefined()
  })

  it('被顶掉的那一发抛出来也**不留 error**(那句 abort 是 kernel 自己让它说的)', async () => {
    const gates = [deferred<string[]>(), deferred<string[]>()]
    let call = 0
    const q = createQuery<string[]>('t.abort2', async (ctx) => {
      const at = call++
      try {
        return await gates[at].promise
      } catch (error) {
        // 认信号的 fetcher 在被撤回时抛的就是这一句。
        if (ctx.signal?.aborted) throw new Error('aborted')
        throw error
      }
    })

    const soft = q.ensure()
    const hard = q.refetch()
    gates[0].reject(new Error('cancelled'))
    await soft
    expect(q.get().error).toBeUndefined()
    gates[1].resolve(['new'])
    await hard
    expect(q.get().data).toEqual(['new'])
  })

  it('不认这一格的 fetcher 行为逐字不变(纯加参数)', async () => {
    const gates = [deferred<string[]>(), deferred<string[]>()]
    let call = 0
    const q = createQuery<string[]>('t.abort3', () => gates[call++].promise)
    const soft = q.ensure()
    const hard = q.refetch()
    gates[0].resolve(['old'])
    await soft
    gates[1].resolve(['new'])
    await hard
    expect(q.get().data).toEqual(['new'])
    expect(call).toBe(2)
  })

  it('`reset()` 也拉信号:回到出厂 = 在飞那一发的答案也不要了', async () => {
    const gate = deferred<string[]>()
    let seen: AbortSignal | undefined
    const q = createQuery<string[]>('t.abort4', (ctx) => {
      seen = ctx.signal
      return gate.promise
    })
    const flying = q.ensure()
    expect(seen?.aborted).toBe(false)
    q.reset()
    expect(seen?.aborted).toBe(true)
    gate.resolve(['x'])
    await flying
  })
})
