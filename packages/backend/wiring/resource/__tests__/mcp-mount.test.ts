/**
 * K5-a —— MCP 投影驱动的**寿命**(`docs/design/atom-2026-09.md` §10.2:外部提供者
 * 的寿命 = 连接期)。
 *
 * 一台真 `ResourceKernel`,一只假 manager(它就是「有哪几台连着、它们报了哪些工具」
 * 那一份快照),一只假订阅口(演「工具表可能变了」那一发)。§10.2 那张表的四行
 * 逐行断言:
 *
 *   未登记 → mount(连上) → 重挂(工具表变了) → 注销(断开) → 回到未登记。
 *
 * 反证②(拆掉断开时的注销)咬的是「断开之后注册表里没有它」那一条。
 */
import { describe, expect, it, vi } from 'vitest'
import { Catalog, ToolRunner } from '@onething/core/toolkit'
import { ResourceKernel, ResourceRegistry } from '@onething/core/resource'
import type { MCPServerState, MCPToolCallResult, MCPToolInfo } from '@onething/core/mcp'
import { syncResourceToolsIntoCatalog } from '../catalog-sync.js'
import { mountMcpResources, type McpResourceManagerPort } from '../mcp-mount.js'

function makeKernel(): ResourceKernel {
  const runner = new ToolRunner({
    authorizer: { async decide() { return { kind: 'allow' as const } } },
    observer: { on: () => {} },
    validator: { parse: <T>(_schema: unknown, input: unknown) => ({ ok: true as const, value: input as T }) },
  })
  return new ResourceKernel(new ResourceRegistry(), runner)
}

function tool(name: string, serverId: string, description = 'Does a thing.'): MCPToolInfo {
  return {
    name,
    description,
    inputSchema: { type: 'object', properties: {}, required: [] },
    serverId,
  }
}

function state(
  id: string,
  status: MCPServerState['status'],
  tools: MCPToolInfo[],
  name = id,
): MCPServerState {
  return {
    config: { id, name, transport: 'stdio', enabled: true },
    status,
    tools,
    resources: [],
    prompts: [],
  }
}

/**
 * 假 manager + 假订阅口。`push(states)` 换一份快照并发一次通知 —— 那正是生产上
 * `registerMCPTools()` 那一行干的事。
 */
function fakeMcp(initial: MCPServerState[] = []) {
  const listeners = new Set<() => void>()
  let states = initial
  const callTool = vi.fn(async (): Promise<MCPToolCallResult> => ({ success: true, content: [] }))
  const manager: McpResourceManagerPort = {
    getServerStates: () => states,
    callTool,
  }
  return {
    manager,
    callTool,
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    listenerCount: () => listeners.size,
    async push(next: MCPServerState[]): Promise<void> {
      states = next
      for (const listener of [...listeners]) listener()
      // 对账串在一条 promise 链上;两拍足够让「摘 + 装」都落地。
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
    },
  }
}

function schemes(kernel: ResourceKernel): string[] {
  return kernel.registry.list().map(spec => spec.scheme)
}

describe('mcp 投影驱动的寿命(K5-a,§10.2)', () => {
  it('连上 → 注册表里有 mcp-<id>', async () => {
    const kernel = makeKernel()
    const mcp = fakeMcp()
    const stop = mountMcpResources({ kernel, manager: mcp.manager, subscribe: mcp.subscribe })
    await Promise.resolve()
    expect(schemes(kernel)).toEqual([])

    await mcp.push([state('brave', 'connected', [tool('brave_web_search', 'brave')])])
    expect(schemes(kernel)).toEqual(['mcp-brave'])
    expect(kernel.registry.get('mcp-brave')?.ops.braveWebSearch?.effects).toEqual(['mcp'])

    await stop()
  })

  it('断开 → 注册表里没有它(反证②)', async () => {
    const kernel = makeKernel()
    const mcp = fakeMcp([state('brave', 'connected', [tool('brave_web_search', 'brave')])])
    const stop = mountMcpResources({ kernel, manager: mcp.manager, subscribe: mcp.subscribe })
    await Promise.resolve()
    await Promise.resolve()
    expect(schemes(kernel)).toEqual(['mcp-brave'])

    await mcp.push([state('brave', 'disconnected', [])])
    expect(schemes(kernel)).toEqual([])

    // 回到「未登记」那一行:再来的调用是结构化的「不认识这个命名空间」。
    const outcome = await kernel.do('mcp-brave:server', 'braveWebSearch', {}, {
      principal: { kind: 'user', userId: 'local' },
    })
    expect(outcome.kind).toBe('failed')

    await stop()
  })

  it('只认连上的 —— error / connecting 的不挂', async () => {
    const kernel = makeKernel()
    const mcp = fakeMcp()
    const stop = mountMcpResources({ kernel, manager: mcp.manager, subscribe: mcp.subscribe })

    await mcp.push([
      state('a', 'error', [tool('t', 'a')]),
      state('b', 'connecting', [tool('t', 'b')]),
      state('c', 'connected', [tool('t', 'c')]),
    ])
    expect(schemes(kernel)).toEqual(['mcp-c'])

    await stop()
  })

  it('工具表变了 → 自述换了(先注销再登记)', async () => {
    const kernel = makeKernel()
    const mcp = fakeMcp()
    const stop = mountMcpResources({ kernel, manager: mcp.manager, subscribe: mcp.subscribe })

    await mcp.push([state('brave', 'connected', [tool('brave_web_search', 'brave')])])
    expect(Object.keys(kernel.registry.get('mcp-brave')!.ops)).toEqual(['braveWebSearch'])

    await mcp.push([
      state('brave', 'connected', [tool('brave_web_search', 'brave'), tool('brave_news', 'brave')]),
    ])
    expect(Object.keys(kernel.registry.get('mcp-brave')!.ops).sort())
      .toEqual(['braveNews', 'braveWebSearch'])
    // 地址没变 —— 重挂不改名。
    expect(schemes(kernel)).toEqual(['mcp-brave'])

    await stop()
  })

  it('自述逐字相同就不重挂 —— 一份不变的快照不该动一个正在被调用的命名空间', async () => {
    const kernel = makeKernel()
    const mcp = fakeMcp()
    const stop = mountMcpResources({ kernel, manager: mcp.manager, subscribe: mcp.subscribe })

    await mcp.push([state('brave', 'connected', [tool('brave_web_search', 'brave')])])
    const before = kernel.toolFor('mcp-brave')
    await mcp.push([state('brave', 'connected', [tool('brave_web_search', 'brave')])])
    // 同一只工具对象:没有摘过也没有重建过。
    expect(kernel.toolFor('mcp-brave')).toBe(before)

    await stop()
  })

  it('两台 id 归一撞名的 server 各得一个地址,而且与顺序无关', async () => {
    const kernel = makeKernel()
    const mcp = fakeMcp()
    const stop = mountMcpResources({ kernel, manager: mcp.manager, subscribe: mcp.subscribe })

    await mcp.push([
      state('My Server', 'connected', [tool('t', 'My Server')]),
      state('my_server', 'connected', [tool('t', 'my_server')]),
    ])
    expect(schemes(kernel).sort()).toEqual(['mcp-my-server', 'mcp-my-server-2'])

    await stop()
  })

  it('在位的那台不会被后来的挤掉名字 —— 即使后来的排在它前面', async () => {
    const kernel = makeKernel()
    const mcp = fakeMcp()
    const stop = mountMcpResources({ kernel, manager: mcp.manager, subscribe: mcp.subscribe })

    // 先只有 `my_server` 连着,它拿到 `mcp-my-server`。
    await mcp.push([state('my_server', 'connected', [tool('t', 'my_server')])])
    expect(schemes(kernel)).toEqual(['mcp-my-server'])

    // 再来一台归一后同名、而且 id 字典序排在它**前面**的(大写 M < 小写 m)。
    // 一趟分配会让新来的先拿走那个名字,把在位的挤成「撞名 → 跳过」。
    await mcp.push([
      state('My Server', 'connected', [tool('t', 'My Server')]),
      state('my_server', 'connected', [tool('t', 'my_server')]),
    ])
    expect(schemes(kernel).sort()).toEqual(['mcp-my-server', 'mcp-my-server-2'])
    // 在位的那台**没有改名**。
    const outcome = await kernel.do('mcp-my-server:server', 't', {}, {
      principal: { kind: 'user', userId: 'local' },
    })
    expect(outcome.kind).toBe('ok')
    expect(mcp.callTool).toHaveBeenCalledWith('my_server', 't', {})

    await stop()
  })

  it('id 归一之后什么都不剩 → 跳过它,不影响别人', async () => {
    const kernel = makeKernel()
    const mcp = fakeMcp()
    const stop = mountMcpResources({ kernel, manager: mcp.manager, subscribe: mcp.subscribe })

    await mcp.push([
      state('___', 'connected', [tool('t', '___')]),
      state('ok', 'connected', [tool('t', 'ok')]),
    ])
    expect(schemes(kernel)).toEqual(['mcp-ok'])

    await stop()
  })

  it('exposure:进注册表,不进工具目录 —— AI 走 McpTool', async () => {
    const kernel = makeKernel()
    const catalog = new Catalog()
    const stopCatalog = syncResourceToolsIntoCatalog(kernel, catalog)
    const mcp = fakeMcp()
    const stop = mountMcpResources({ kernel, manager: mcp.manager, subscribe: mcp.subscribe })

    await mcp.push([state('brave', 'connected', [tool('brave_web_search', 'brave')])])
    await Promise.resolve()

    expect(schemes(kernel)).toEqual(['mcp-brave'])
    expect(catalog.all().map(item => item.spec.id)).toEqual(['resources'])

    // 但 `resources` 元工具的 list 里有它 —— 它确实是一种资源。
    const meta = catalog.get('resources')!
    const listed = await meta.apply(
      await meta.plan({ list: true } as never, {} as never),
      { emit: () => {} } as never,
    )
    expect(listed.content.map(part => part.text ?? '').join('\n')).toContain('mcp-brave')

    stopCatalog()
    await stop()
  })

  it('一次 do 打到假客户端上,带的是真工具名', async () => {
    const kernel = makeKernel()
    const mcp = fakeMcp()
    const stop = mountMcpResources({ kernel, manager: mcp.manager, subscribe: mcp.subscribe })
    await mcp.push([state('brave', 'connected', [tool('brave_web_search', 'brave')])])

    const outcome = await kernel.do('mcp-brave:server', 'braveWebSearch', { q: 'x' }, {
      principal: { kind: 'user', userId: 'local' },
    })
    expect(outcome.kind).toBe('ok')
    expect(mcp.callTool).toHaveBeenCalledWith('brave', 'brave_web_search', { q: 'x' })

    await stop()
  })

  it('收尾:退订 + 全摘干净,而且幂等', async () => {
    const kernel = makeKernel()
    const mcp = fakeMcp([state('brave', 'connected', [tool('t', 'brave')])])
    const stop = mountMcpResources({ kernel, manager: mcp.manager, subscribe: mcp.subscribe })
    await Promise.resolve()
    await Promise.resolve()
    expect(schemes(kernel)).toEqual(['mcp-brave'])

    await stop()
    expect(schemes(kernel)).toEqual([])
    expect(mcp.listenerCount()).toBe(0)

    // 退订之后快照再变一次,不该长回来。
    await mcp.push([state('brave', 'connected', [tool('t', 'brave')])])
    expect(schemes(kernel)).toEqual([])

    await stop()
    expect(schemes(kernel)).toEqual([])
  })
})
