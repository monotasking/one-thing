import { describe, expect, it } from 'vitest'
import { act, render, screen } from '@testing-library/react'
import { createQueryFamily } from './query'
import type { Query } from './query'
import type { HeldSnapshot } from './react'
import { useQuery, useQueryHeld } from './react'

/**
 * kernel 的 **React 那一头**的守卫。
 *
 * 为什么另开一个文件而不是塞进 `laws.test.ts`:那一份是**零 React** 的
 * deferred 剧本(见它的文件头),验的是原语本身的四条性质;hook 的用例要
 * 渲染、要 `act`、要 jsdom,混进去会把那份剧本的判据变成「渲染器怎么调度」。
 *
 * 这一份验的只有一条律:**律②′ 换键在飞时旧内容留在屏上**。
 * 反证的形式与 `laws.test.ts` 同源 —— 同一段剧情跑两遍,一遍走 `useQueryHeld`,
 * 一遍走裸 `useQuery`,两遍读数不同才说明断言守的是真东西。
 */

/* ── 剧本装置 ────────────────────────────────────────────────────────────── */

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  // 失败那一支落在 kernel 的 catch 里,这里再挂一个空的免得测试环境报未处理拒绝。
  promise.catch(() => undefined)
  return { promise, resolve, reject }
}

/**
 * 一族「一格一道闸」的 query:剧情自己决定哪一发什么时候落地、落成什么。
 * 「换键」在用例里就是把另一格的 `Query` 当 prop 递进去 —— 与真面上换词一样,
 * 换的是**一个新的格**,不是同一格的内容。
 */
function gatedFamily() {
  const gates = new Map<string, ReturnType<typeof deferred<string[]>>>()
  const family = createQueryFamily<string[]>('t.held', (ctx) => {
    const gate = deferred<string[]>()
    gates.set(ctx.key, gate)
    return gate.promise
  })
  /** 起一发并把它落地成 `value`。`ensure()` 是同步发车的,所以闸当场就有。 */
  async function land(key: string, value: string[]): Promise<void> {
    await act(async () => {
      const flying = family.get(key).ensure()
      gates.get(key)?.resolve(value)
      await flying
    })
  }
  /** 起一发但**不落地** —— 「在飞」那一段就是这一手撑住的。 */
  async function fly(key: string): Promise<void> {
    await act(async () => {
      void family.get(key).ensure()
    })
  }
  /** 起飞的那一发摔了。 */
  async function fail(key: string, message: string): Promise<void> {
    await act(async () => {
      const flying = family.get(key).ensure()
      gates.get(key)?.reject(new Error(message))
      await flying
    })
  }
  return { family, land, fly, fail, gateOf: (key: string) => gates.get(key) }
}

/** 屏上那份读数摊平成一行字 —— 断言照这一行读,比逐格 expect 更像「屏上是什么」。 */
function readout(snapshot: {
  data: string[] | undefined
  phase: string
  error: string | undefined
  stale?: boolean
  shownKey: string
}): string {
  return [
    `data=${snapshot.data === undefined ? '-' : snapshot.data.join(',')}`,
    `phase=${snapshot.phase}`,
    `stale=${snapshot.stale === true ? 'yes' : 'no'}`,
    `key=${snapshot.shownKey}`,
    `error=${snapshot.error ?? '-'}`,
  ].join(' ')
}

function Held({ query }: { query: Query<string[]> }) {
  const held = useQueryHeld(query)
  return <output data-testid="held">{readout(held)}</output>
}

function Bare({ query }: { query: Query<string[]> }) {
  const snapshot = useQuery(query)
  return <output data-testid="bare">{readout({ ...snapshot, shownKey: query.key })}</output>
}

const held = () => screen.getByTestId('held').textContent
const bare = () => screen.getByTestId('bare').textContent

/* ══ 律②′ 换键在飞,上一把键的答案留在屏上 ════════════════════════════════ */

describe('律②′ useQueryHeld —— 换键在飞不清屏', () => {
  it('换键在飞:旧 data 留在屏上、stale 为真、shownKey 还是旧键;新格落地即换新且 stale 归假', async () => {
    const { family, land, fly, gateOf } = gatedFamily()
    const { rerender } = render(<Held query={family.get('a')} />)
    await land('a', ['a1', 'a2'])
    expect(held()).toBe('data=a1,a2 phase=ready stale=no key=t.held:a error=-')

    // 换键 + 新格起飞:新格自己还什么都没有,屏上那份必须**原样留着**,
    // 而且如实说清它是上一把键的。
    await act(async () => {
      rerender(<Held query={family.get('b')} />)
    })
    await fly('b')
    expect(held()).toBe('data=a1,a2 phase=initial stale=yes key=t.held:a error=-')

    // 新格落地 = 当场放手,一帧都不多留。
    await act(async () => {
      gateOf('b')?.resolve(['b1'])
      await Promise.resolve()
    })
    expect(held()).toBe('data=b1 phase=ready stale=no key=t.held:b error=-')
  })

  it('反证:同一段剧情走裸 useQuery,换键那一帧当场读到 undefined', async () => {
    const { family, land, fly } = gatedFamily()
    const { rerender } = render(<Bare query={family.get('a')} />)
    await land('a', ['a1', 'a2'])
    expect(bare()).toBe('data=a1,a2 phase=ready stale=no key=t.held:a error=-')

    await act(async () => {
      rerender(<Bare query={family.get('b')} />)
    })
    await fly('b')
    // 这一行就是检索面「Load more 跳回顶部」的病根:列表当场空了,容器高度归零,
    // 浏览器把 scrollTop 钳成 0。
    expect(bare()).toBe('data=- phase=initial stale=no key=t.held:b error=-')
  })

  it('新键失败:旧 data 仍留在屏上,而 error 如实透出(与律②在同一格里的做法逐字一致)', async () => {
    const { family, land, fail } = gatedFamily()
    const { rerender } = render(<Held query={family.get('a')} />)
    await land('a', ['a1'])

    await act(async () => {
      rerender(<Held query={family.get('b')} />)
    })
    await fail('b', '搜不动了')
    expect(held()).toBe('data=a1 phase=initial stale=yes key=t.held:a error=搜不动了')
  })

  it('同键 refetch:逐字等于 useQuery —— data 不清空,而且 stale 恒假', async () => {
    const { family, land, gateOf } = gatedFamily()
    const q = family.get('a')
    render(<Held query={q} />)
    await land('a', ['a1'])

    await act(async () => {
      void q.refetch()
    })
    // 律② 本来就守住了 data;这里要钉的是**没有人被冤枉成 stale**。
    expect(held()).toBe('data=a1 phase=ready stale=no key=t.held:a error=-')

    await act(async () => {
      gateOf('a')?.resolve(['a1', 'a2'])
      await Promise.resolve()
    })
    expect(held()).toBe('data=a1,a2 phase=ready stale=no key=t.held:a error=-')
  })

  it('同键 reset:垫子不许把已经清掉的答案顶回来(同键逐字等于 useQuery)', async () => {
    const { family, land } = gatedFamily()
    const q = family.get('a')
    render(<Held query={q} />)
    await land('a', ['a1'])

    await act(async () => {
      q.reset()
    })
    expect(held()).toBe('data=- phase=initial stale=no key=t.held:a error=-')
  })

  it('换回旧键:那一格自己还攥着答案,所以是它自己的 data、stale 假', async () => {
    const { family, land, fly } = gatedFamily()
    const { rerender } = render(<Held query={family.get('a')} />)
    await land('a', ['a1'])
    await act(async () => {
      rerender(<Held query={family.get('b')} />)
    })
    await fly('b')
    expect(held()).toBe('data=a1 phase=initial stale=yes key=t.held:a error=-')

    await act(async () => {
      rerender(<Held query={family.get('a')} />)
    })
    expect(held()).toBe('data=a1 phase=ready stale=no key=t.held:a error=-')
  })

  it('卸载不漏订阅:换键那一次退掉旧格,卸载后退订与订阅一样多', async () => {
    const { family, land } = gatedFamily()
    let subscribed = 0
    let unsubscribed = 0
    const wrapped = new Map<string, Query<string[]>>()
    // 同一把键必须交出**同一个对象** —— 换一个新壳等于换 useCallback 的身份,
    // 那会把「每渲染都重订一次」误算成泄漏。
    const stable = (key: string): Query<string[]> => {
      const existing = wrapped.get(key)
      if (existing) return existing
      const inner = family.get(key)
      const created: Query<string[]> = {
        ...inner,
        subscribe(listener: () => void) {
          subscribed += 1
          const off = inner.subscribe(listener)
          return () => {
            unsubscribed += 1
            off()
          }
        },
      }
      wrapped.set(key, created)
      return created
    }

    const { rerender, unmount } = render(<Held query={stable('a')} />)
    await land('a', ['a1'])
    await act(async () => {
      rerender(<Held query={stable('b')} />)
    })
    expect(subscribed).toBe(2)
    expect(unsubscribed).toBe(1) // 旧格当场退订,只剩 b 那一份在订
    unmount()
    expect(unsubscribed).toBe(subscribed)
  })
})

/* ── 快照身份(律④)—— 读数没变就不该换引用 ──────────────────────────── */

describe('useQueryHeld 的读数身份', () => {
  it('父组件白重渲一次,交出去的还是同一个对象', async () => {
    const { family, land } = gatedFamily()
    const seen: HeldSnapshot<string[]>[] = []
    function Probe({ query }: { query: Query<string[]> }) {
      const snapshot = useQueryHeld(query)
      seen.push(snapshot)
      return <output data-testid="held">{readout(snapshot)}</output>
    }
    const q = family.get('a')
    const { rerender } = render(<Probe query={q} />)
    await land('a', ['a1'])
    const before = seen[seen.length - 1]

    await act(async () => {
      rerender(<Probe query={q} />)
    })
    expect(seen[seen.length - 1]).toBe(before)
  })
})
