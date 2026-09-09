import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createMemoryTransport, createOnethingClient } from '@onething/client'
import type { MemoryTransport } from '@onething/client'
import type { RpcRequest } from '@shared/ipc/rpc'
import { ShellResourceHost } from '../shell-host'
import { WORKBENCH_SCHEME } from '../workbench-spec'
import { registerContentKind, refId, resetContentKinds } from '../../workbench/kinds'
import { startWorkbench, useWorkbenchStore } from '../../workbench/store'
import { CENTER_REGION } from '../../workbench/regions'
import { leavesOf, makeLeaf } from '../../workbench/tree'
import type { ContentRef } from '../../workbench/kinds'

/**
 * **壳侧提供者**(原子 K2b-2b,正本 `docs/design/atom-2026-09.md` §5 / §10.2 / §10.3)。
 *
 * 跑的是**真的** `@onething/client`(内存传输),不是一只手写的假客户端:那样
 * `mountShell` 的信封、`onAny` 的名字过滤、回执的编码三处都是真路 —— 一只手写的
 * 假客户端会把它们统统绕过去,于是这一组用例守的就只剩自己写的那几行。
 *
 * 六件事:
 *  ① `start()` → `mountShell` 一次,交上去的自述 scheme 是 `workbench`;
 *  ② 一条 `shellId` 对得上的 `open` → 树上多一格 + 回执是 `{kind:'ok'}`;
 *  ③ 一条**别扇壳**的命令 → 一个字都不做(SSE 是广播,归属判定只有这一句);
 *  ④ 认不得的做法 → 回执是 `{kind:'failed'}`(不静默,壳只有回执可读);
 *  ⑤ `read layout` → 回执那段文本是 JSON,而且含此刻的 tabs;
 *  ⑥ §10.3:开一格发 `opened`、关一格发 `closed`,同一拍改两次树只对一次差;
 *  ⑦ `stop()` → `unmountShell` 一次、表停掉、再推事件零反应。
 *
 * **反证**:① 把 `start()` 里那句 `command.shellId !== this.shellId` 拆掉 → ③ 红;
 * ② 把 `diff()` 里 `closed` 那半拆掉 → ⑥ 红。
 */

const doc = (key: string): ContentRef => ({ kind: 'doc', key })

let transport: MemoryTransport
let host: ShellResourceHost
/** 后端替身收到的那几本账。 */
let mounted: Array<Record<string, unknown>>
let unmounted: Array<Record<string, unknown>>
let results: Array<Record<string, unknown>>
let facts: Array<Record<string, unknown>>

/** 让内存传输那条 `events()` 迭代器真的挂上去(它是惰性拉的)。 */
async function tick(times = 3): Promise<void> {
  for (let i = 0; i < times; i += 1) await new Promise<void>((resolve) => setTimeout(resolve, 0))
}

/** 推一条壳命令。形与 `ResourceShellCommandEvent` 逐格相同(名字也是它的 `type`)。 */
function pushCommand(frame: {
  shellId: string
  callId: string
  kind?: 'op' | 'read'
  ref?: string | null
  op: string
  params?: Record<string, unknown>
}): void {
  transport.emit({
    name: 'resource:shell-command',
    data: {
      type: 'resource:shell-command',
      shellId: frame.shellId,
      callId: frame.callId,
      kind: frame.kind ?? 'op',
      ref: frame.ref === undefined ? `${WORKBENCH_SCHEME}:${CENTER_REGION}` : frame.ref,
      op: frame.op,
      params: frame.params ?? {},
      at: Date.now(),
    },
  })
}

function callsTo(method: string): RpcRequest[] {
  return transport.calls.filter((call) => call.domain === 'resources' && call.method === method)
}

beforeEach(async () => {
  resetContentKinds()
  registerContentKind({
    id: 'home',
    singleton: true,
    resident: { region: CENTER_REGION, seed: () => 'main' },
    regions: [CENTER_REGION],
    title: () => ({ text: '家' }),
    icon: () => 'Layers',
    render: () => null,
  })
  registerContentKind({
    id: 'doc',
    singleton: false,
    title: (ref) => ({ text: ref.key }),
    icon: () => 'FileText',
    render: () => null,
  })
  useWorkbenchStore.getState().reset()
  startWorkbench()

  mounted = []
  unmounted = []
  results = []
  facts = []
  transport = createMemoryTransport({
    handlers: {
      'resources.mountShell': (payload) => {
        mounted.push(payload as Record<string, unknown>)
        return { ok: true }
      },
      'resources.unmountShell': (payload) => {
        unmounted.push(payload as Record<string, unknown>)
        return { ok: true }
      },
      'resources.shellResult': (payload) => {
        results.push(payload as Record<string, unknown>)
        return { ok: true }
      },
      'resources.emit': (payload) => {
        facts.push(payload as Record<string, unknown>)
        return { ok: true }
      },
    },
  })
  host = new ShellResourceHost()
  await host.start(createOnethingClient({ transport }))
  await tick()
})

afterEach(() => {
  host.stop()
  resetContentKinds()
  useWorkbenchStore.getState().reset()
})

describe('登记(§10.2「已登记」那一行)', () => {
  it('start() 交一次自述,scheme 是 workbench,而且每条做法都自述了 ui_change', () => {
    expect(mounted).toHaveLength(1)
    expect(mounted[0].shellId).toBe(host.shellId)
    const spec = mounted[0].spec as { scheme: string; ops: Record<string, { effects: string[] }> }
    expect(spec.scheme).toBe('workbench')
    expect(Object.keys(spec.ops).sort()).toEqual(
      ['activate', 'close', 'exitFull', 'float', 'full', 'move', 'open', 'summon'],
    )
    for (const [name, op] of Object.entries(spec.ops)) {
      expect(op.effects, `${name} 的效果类`).toEqual(['ui_change'])
    }
  })

  it('参数名一个都不叫 ref / op / read —— 那三个是内核的判别键与地址键', () => {
    const spec = mounted[0].spec as { ops: Record<string, { params: { properties?: object } }> }
    for (const [name, op] of Object.entries(spec.ops)) {
      const keys = Object.keys(op.params.properties ?? {})
      for (const forbidden of ['ref', 'op', 'read']) {
        expect(keys, `${name} 的参数`).not.toContain(forbidden)
      }
    }
  })
})

describe('一条命令的一整趟', () => {
  it('shellId 对得上的 open → 树上多一格,回执是 ok', async () => {
    pushCommand({ shellId: host.shellId, callId: 'c1', op: 'open', params: { target: 'doc:a' } })
    await tick()

    expect(leavesOf(useWorkbenchStore.getState().regions[CENTER_REGION])[0].tabs.map(refId))
      .toEqual(['home:main', 'doc:a'])
    expect(results).toHaveLength(1)
    expect(results[0]).toMatchObject({
      shellId: host.shellId,
      callId: 'c1',
      result: { kind: 'ok', text: 'opened doc:a' },
    })
  })

  it('**别扇壳**的命令一个字都不做 —— SSE 是广播,归属判定只有那一句', async () => {
    pushCommand({ shellId: 'someone-else', callId: 'c2', op: 'open', params: { target: 'doc:b' } })
    await tick()

    expect(leavesOf(useWorkbenchStore.getState().regions[CENTER_REGION])[0].tabs.map(refId))
      .toEqual(['home:main'])
    expect(results).toHaveLength(0)
  })

  it('认不得的做法 → 回执是 failed(不静默:壳只有回执可读)', async () => {
    pushCommand({ shellId: host.shellId, callId: 'c3', op: 'teleport', params: {} })
    await tick()

    expect(results).toHaveLength(1)
    expect(results[0].result).toMatchObject({ kind: 'failed' })
    expect((results[0].result as { message: string }).message).toContain('unknown op')
  })

  it('没开着的那一格切不过去,也说出来', async () => {
    pushCommand({ shellId: host.shellId, callId: 'c4', op: 'activate', params: { target: 'doc:ghost' } })
    await tick()

    expect(results[0].result).toMatchObject({ kind: 'failed' })
    expect((results[0].result as { message: string }).message).toContain('is not open')
  })

  it('read layout:那段文本是 JSON,而且含此刻的 tabs', async () => {
    useWorkbenchStore.getState().openRef(doc('a'))
    pushCommand({ shellId: host.shellId, callId: 'c5', kind: 'read', op: 'layout' })
    await tick()

    const text = (results[0].result as { kind: string; text: string }).text
    const layout = JSON.parse(text) as { regions: Array<{ region: string; leaves: Array<{ tabs: string[] }> }> }
    expect(layout.regions[0].region).toBe(CENTER_REGION)
    expect(layout.regions[0].leaves[0].tabs).toEqual(['home:main', 'doc:a'])
  })

  it('同一条 callId 只跑一次(投递重复时的结构性幂等)', async () => {
    pushCommand({ shellId: host.shellId, callId: 'c6', op: 'open', params: { target: 'doc:a' } })
    pushCommand({ shellId: host.shellId, callId: 'c6', op: 'open', params: { target: 'doc:a' } })
    await tick()
    expect(results).toHaveLength(1)
  })
})

describe('§10.3 opened / closed', () => {
  it('start() 时对已经开着的那些先发一轮 opened(壳连上时它们也是「打开中」)', () => {
    // 出厂那一格常驻内容。地址是**壳自己的命名空间**,那格内容在载荷里。
    expect(facts).toHaveLength(1)
    expect(facts[0]).toMatchObject({
      shellId: host.shellId,
      ref: `${WORKBENCH_SCHEME}:${CENTER_REGION}`,
      event: 'opened',
      payload: { ref: 'home:main' },
    })
  })

  it('开一格发 opened,关一格发 closed', async () => {
    facts.length = 0
    useWorkbenchStore.getState().openRef(doc('a'))
    await tick(1)
    expect(facts.map((row) => [row.event, (row.payload as { ref: string }).ref]))
      .toEqual([['opened', 'doc:a']])

    facts.length = 0
    const leaf = leavesOf(useWorkbenchStore.getState().regions[CENTER_REGION])[0]
    useWorkbenchStore.getState().closeTab(leaf.id, leaf.tabs.findIndex((tab) => refId(tab) === 'doc:a'))
    await tick(1)
    expect(facts.map((row) => [row.event, (row.payload as { ref: string }).ref]))
      .toEqual([['closed', 'doc:a']])
  })

  it('同一拍改两次树 → 只对一次差:中途那一格从来没露过面,所以一条事实都不该有', async () => {
    facts.length = 0
    /*
     * 一拍之内:先开 `doc:a`,再把整棵树换成装着 `doc:b` 的那一棵。屏幕上从来
     * 没有出现过 `doc:a` —— 它在同一个同步段里生灭。所以**唯一**该发出去的事实
     * 是 `opened doc:b`。
     *
     * 这一条同时就是合批的反证:把 `scheduleDiff` 那层微任务拆掉、每次 `set` 都
     * 当场 `diff()` 的话,这里会变成三条(`opened doc:a` / `closed doc:a` /
     * `opened doc:b`)—— 一格没人看见的内容凭空多出一对开关。
     */
    useWorkbenchStore.getState().openRef(doc('a'))
    useWorkbenchStore.setState({
      regions: { [CENTER_REGION]: makeLeaf('L9', [{ kind: 'home', key: 'main' }, doc('b')]) },
    })
    await tick(1)

    expect(facts.map((row) => `${String(row.event)} ${(row.payload as { ref: string }).ref}`))
      .toEqual(['opened doc:b'])
  })

  it('一拍里两件真事 → 两条事实,一条不多一条不少', async () => {
    // `doc:a` 先落定(它已经在账上了),再在同一拍里把它换成 `doc:b`。
    useWorkbenchStore.getState().openRef(doc('a'))
    await tick(1)
    facts.length = 0

    useWorkbenchStore.setState({
      regions: { [CENTER_REGION]: makeLeaf('L9', [{ kind: 'home', key: 'main' }, doc('b')]) },
    })
    await tick(1)

    expect(facts.map((row) => `${String(row.event)} ${(row.payload as { ref: string }).ref}`).sort())
      .toEqual(['closed doc:a', 'opened doc:b'])
  })

  it('隐藏**不算**关闭 —— 实例还在,位置记忆还记着', async () => {
    useWorkbenchStore.getState().openRef(doc('a'))
    await tick(1)
    facts.length = 0

    const leaf = leavesOf(useWorkbenchStore.getState().regions[CENTER_REGION])[0]
    useWorkbenchStore.getState().hideTab(leaf.id, leaf.tabs.findIndex((tab) => refId(tab) === 'doc:a'))
    await tick(1)
    expect(facts).toEqual([])

    // 真的丢掉那一格隐藏才是关闭。
    useWorkbenchStore.getState().dropHidden('doc:a')
    await tick(1)
    expect(facts.map((row) => [row.event, (row.payload as { ref: string }).ref]))
      .toEqual([['closed', 'doc:a']])
  })
})

describe('§10.2 已注销', () => {
  it('stop() 撤一次,再推命令零反应', async () => {
    host.stop()
    await tick()
    expect(callsTo('unmountShell')).toHaveLength(1)
    expect(unmounted[0]).toMatchObject({ shellId: host.shellId })

    const before = results.length
    pushCommand({ shellId: host.shellId, callId: 'c7', op: 'open', params: { target: 'doc:z' } })
    useWorkbenchStore.getState().openRef(doc('z2'))
    await tick()
    expect(results).toHaveLength(before)
    expect(leavesOf(useWorkbenchStore.getState().regions[CENTER_REGION])[0].tabs.map(refId))
      .not.toContain('doc:z')
  })

  it('stop() 是幂等的', async () => {
    host.stop()
    host.stop()
    await tick()
    expect(callsTo('unmountShell')).toHaveLength(1)
  })
})
