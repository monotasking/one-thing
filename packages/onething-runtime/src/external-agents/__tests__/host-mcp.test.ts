/**
 * 宿主工具面的三块(E3,docs/design/claude-code-integration-v2.md §2)。
 *
 * 这个文件只能站在**产品层**说话:它拿不到 store、拿不到真的协作执行器(那条边
 * 是架构禁令,`architecture-boundaries.test.ts` 钉着)。所以工具用替身,验的是
 * 三件与业务无关但错了会静默串房/静默关门的事:
 *
 *  1. **场子门真的在门口**——注入哪几个由 venue 决定,普通对话一个都不给;
 *  2. **并发不串房**——两间房同时跑,各自的 handler 只看得见自己的语境;
 *  3. **绑定的生命周期**——解绑之后的迟到调用得到一句可行动的话,而不是打在
 *     一份过期语境上。
 *
 * 真执行器接上之后那条持牌链的验收在 `app/external-agents/__tests__/`。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import type { HostMcpHostTool } from '../host-mcp/tools.js'
import {
  activeHostToolContextCount,
  bindHostToolContext,
  clearHostToolContexts,
  createHostMcpServer,
  filterHostToolSurface,
  HOST_MCP_SERVER_NAME,
  HOST_MCP_TOOL_CANDIDATES,
  HOST_MCP_TURN_GONE,
  hostMcpToolName,
  isHostMcpToolName,
  resolveHostToolContext,
  resolveHostToolSurface,
  stripHostMcpToolPrefix,
  toHostMcpToolDefinition,
  type CreateSdkMcpServerFn,
} from '../host-mcp/index.js'

/**
 * 一个只记账的工具替身:它把收到的 `ctx.sessionId` 原样吐回来。
 *
 * R4b:形状从旧 `ToolInfo` 换成 `HostMcpHostTool`(这个文件本来就只填那三格,
 * 见 `host-mcp/tools.ts` 的头注释)。
 */
function echoTool(id: string): HostMcpHostTool {
  return {
    id,
    description: `${id} description`,
    parameters: z.object({ content: z.string() }),
    async execute(args: Record<string, unknown>, ctx: { sessionId: string }) {
      return { output: `${id}@${ctx.sessionId}:${String(args.content ?? '')}` }
    },
  }
}

beforeEach(() => {
  clearHostToolContexts()
})

describe('MCP 全名:两类工具的分界线', () => {
  it('宿主工具带前缀,SDK 自带工具不带', () => {
    expect(hostMcpToolName('send_message')).toBe('mcp__onething__send_message')
    expect(isHostMcpToolName('mcp__onething__send_message')).toBe(true)
    // SDK 自带的那些 —— 它们仍走 canUseTool 那座桥。
    expect(isHostMcpToolName('Bash')).toBe(false)
    expect(isHostMcpToolName('AskUserQuestion')).toBe(false)
    // 别人家的 MCP 服务器也不是我们的工具。
    expect(isHostMcpToolName('mcp__playwright__click')).toBe(false)
    expect(isHostMcpToolName(undefined)).toBe(false)
  })

  it('事件流出口把前缀抹掉 —— 打字灯/步骤渲染因此认得出它', () => {
    expect(stripHostMcpToolPrefix('mcp__onething__send_message')).toBe('send_message')
    // 不带前缀的原样过,包括别人家的 MCP 工具(那不是我们的工具,不该被改名)。
    expect(stripHostMcpToolPrefix('Bash')).toBe('Bash')
    expect(stripHostMcpToolPrefix('mcp__playwright__click')).toBe('mcp__playwright__click')
  })
})

describe('工具集由 venue 门决定', () => {
  it('群房回合:发言 + 看板 + 历史 + 笔记', () => {
    // kind='agent' = W18 之后房回合真正跑的那条会话。
    expect(resolveHostToolSurface({ sessionKind: 'agent', sessionDm: false }))
      .toEqual(['send_message', 'board', 'history', 'notebook'])
  })

  it('pair 房(两位同事的房)与群房同一份工具面 —— dm 说的是「单成员托管私聊」', () => {
    expect(resolveHostToolSurface({ sessionKind: 'agent', sessionDm: false }))
      .toEqual(resolveHostToolSurface({ sessionKind: 'agent' }))
  })

  it('单成员 dm 房(用户 ↔ agent 托管私聊):同样四个,走的是 collab-dm 那一格', () => {
    expect(resolveHostToolSurface({ sessionKind: 'agent', sessionDm: true }))
      .toEqual(['send_message', 'board', 'history', 'notebook'])
  })

  it('工作台会话:notebook 在,而它并不在工作台的工具地板里', () => {
    // 实证「地板 ≠ 门」:`COLLAB_WORK_REQUIRED_TOOLS` 只有 board/send_message,
    // 而 history/notebook 在 work 场子里是成立的(tool-surface.ts 的论证)。
    expect(resolveHostToolSurface({ sessionKind: 'work' }))
      .toEqual(['send_message', 'board', 'history', 'notebook'])
  })

  it('普通对话:一个都不注 —— 这是场子门第一次对外部 agent 真正生效', () => {
    // 没配白名单的 agent 在这里 `resolveAgentToolSurface` 返回 null(不限制),
    // 只过白名单那一道的话四个协作工具会全注进去 —— 那正是 history 泄露用户
    // 私聊的那条路径的形状。
    expect(resolveHostToolSurface({})).toEqual([])
    expect(resolveHostToolSurface({ sessionKind: 'chat' })).toEqual([])
    // 网关按远端身份建出来的会话 kind 为空 —— 归一化把它算成 chat。
    expect(resolveHostToolSurface({ sessionKind: undefined, ownTools: null })).toEqual([])
  })

  it('agent 自己收窄过的白名单说了算(地板并集之外的不注)', () => {
    // 白名单里没有 notebook,而 union 地板会把 send_message/board/history 叠回来;
    // notebook 那一格靠 `collab-notebook` grant 也会被叠回来 —— 所以这里验的是
    // 「白名单存在时结果仍由那个函数说了算」,而不是我们绕过它。
    const surface = resolveHostToolSurface({
      sessionKind: 'agent',
      ownTools: ['read'],
    })
    expect(surface).toEqual(['send_message', 'board', 'history', 'notebook'])
  })

  it('候选集从场子一览表推,不是手抄的第二份名单', () => {
    expect([...HOST_MCP_TOOL_CANDIDATES])
      .toEqual(['send_message', 'board', 'history', 'notebook'])
  })

  it('filterHostToolSurface:allowlist=null 只剩场子门这一道', () => {
    expect(filterHostToolSurface({ allowlist: null, venue: 'chat' })).toEqual([])
    expect(filterHostToolSurface({ allowlist: null, venue: 'room' }))
      .toEqual(['send_message', 'board', 'history'])
    expect(filterHostToolSurface({ allowlist: ['board'], venue: 'agent' })).toEqual(['board'])
  })
})

describe('进程内 MCP 服务器:起、停、枚举', () => {
  const fakeCreate = vi.fn((options: Parameters<CreateSdkMcpServerFn>[0]) => ({
    type: 'sdk' as const,
    name: options.name,
    instance: { tools: options.tools?.map(tool => tool.name) ?? [] },
  }))

  // 花括号是必须的:`mockClear()` 返回 mock 本身,而 vitest 把 beforeEach 的
  // 函数型返回值当**清理回调**调用 —— 简写形式会让每个测试结束时无参调一次这个
  // 替身,报一句与被测代码毫无关系的 TypeError。
  beforeEach(() => {
    fakeCreate.mockClear()
  })

  it('起一台:名字、工具全名、alwaysLoad', async () => {
    const server = await createHostMcpServer({
      execSessionId: 'exec-1',
      tools: [echoTool('send_message'), echoTool('board')],
      createSdkMcpServer: fakeCreate,
    })

    expect(server?.name).toBe(HOST_MCP_SERVER_NAME)
    expect(server?.config.type).toBe('sdk')
    expect(server?.toolNames).toEqual([
      'mcp__onething__send_message',
      'mcp__onething__board',
    ])
    // 发言权不许被 tool search 藏起来。
    expect(fakeCreate.mock.calls[0][0].alwaysLoad).toBe(true)
    // 参数模式递的是 zod **raw shape**(SDK 的 `tool()` 收的就是这个形状)。
    expect(Object.keys(fakeCreate.mock.calls[0][0].tools![0].inputSchema)).toEqual(['content'])
  })

  it('一个工具都没有就不起 —— 一台空服务器只是工具列表里的一行噪音', async () => {
    const server = await createHostMcpServer({
      execSessionId: 'exec-1',
      tools: [],
      createSdkMcpServer: fakeCreate,
    })
    expect(server).toBeUndefined()
    expect(fakeCreate).not.toHaveBeenCalled()
  })

  it('SDK 取不到时降级而不是抛 —— 注入不上还有收养兜底,抛出去这一轮什么都没有', async () => {
    const warn = vi.fn()
    const server = await createHostMcpServer({
      execSessionId: 'exec-1',
      tools: [echoTool('send_message')],
      createSdkMcpServer: (() => {
        throw new Error('module not found')
      }) as unknown as CreateSdkMcpServerFn,
      logger: { warn },
    })
    expect(server).toBeUndefined()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('host tools not injected'))
  })
})

describe('语境绑定:并发隔离与生命周期', () => {
  it('两间房同时跑,各自的 handler 只看得见自己的会话', async () => {
    // 每轮一台服务器,execSessionId 闭包进 handler —— 隔离是结构事实,不是纪律。
    const releaseA = bindHostToolContext({
      agentId: 'fe', roomSessionId: 'room-A', execSessionId: 'exec-A', leaseId: 'lease-A',
    })
    const releaseB = bindHostToolContext({
      agentId: 'pm', roomSessionId: 'room-B', execSessionId: 'exec-B', leaseId: 'lease-B',
    })
    const handlerA = toHostMcpToolDefinition(echoTool('send_message'), 'exec-A').handler
    const handlerB = toHostMcpToolDefinition(echoTool('send_message'), 'exec-B').handler
    expect(activeHostToolContextCount()).toBe(2)

    // 交错调用 —— 一个模块级的「当前回合」变量会让后绑的那个赢,而症状是一句话
    // 落进了错的房,不报错。
    const [a, b, a2] = await Promise.all([
      handlerA({ content: '甲' }, undefined),
      handlerB({ content: '乙' }, undefined),
      handlerA({ content: '丙' }, undefined),
    ])
    expect(a.content[0].text).toBe('send_message@exec-A:甲')
    expect(b.content[0].text).toBe('send_message@exec-B:乙')
    expect(a2.content[0].text).toBe('send_message@exec-A:丙')

    releaseA()
    releaseB()
    expect(activeHostToolContextCount()).toBe(0)
  })

  it('解绑之后的迟到调用:一句可行动的话,不是一次静默失败', async () => {
    const release = bindHostToolContext({
      agentId: 'fe', roomSessionId: 'room-1', execSessionId: 'exec-1',
    })
    const execute = vi.fn(echoTool('send_message').execute)
    const handler = toHostMcpToolDefinition({ ...echoTool('send_message'), execute }, 'exec-1').handler
    release()

    const result = await handler({ content: '迟到了' }, undefined)
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toBe(HOST_MCP_TURN_GONE)
    expect(execute).not.toHaveBeenCalled()
  })

  it('旧服务器不能借用同一执行会话的新 owner 或新牌，当前服务器照常执行', async () => {
    const execute = vi.fn(async (_args, ctx) => ({ output: JSON.stringify(ctx.executionContext) }))
    const tool: HostMcpHostTool = { ...echoTool('send_message'), execute }
    const releaseOld = bindHostToolContext({
      agentId: 'fe', roomSessionId: 'room-1', execSessionId: 'exec-1', leaseId: 'lease-old',
      executionContext: { userId: 'alice', workspaceId: 'team-a' },
    })
    const oldHandler = toHostMcpToolDefinition(tool, 'exec-1').handler
    const releaseCurrent = bindHostToolContext({
      agentId: 'fe', roomSessionId: 'room-1', execSessionId: 'exec-1', leaseId: 'lease-current',
      executionContext: { userId: 'bob', workspaceId: 'team-b' },
    })
    const currentHandler = toHostMcpToolDefinition(tool, 'exec-1').handler
    releaseOld()
    expect(await oldHandler({}, undefined)).toEqual({
      isError: true, content: [{ type: 'text', text: HOST_MCP_TURN_GONE }],
    })
    expect(execute).not.toHaveBeenCalled()
    const current = await currentHandler({}, undefined)
    expect(current.isError).toBeUndefined()
    expect(JSON.parse(current.content[0].text)).toEqual({ userId: 'bob', workspaceId: 'team-b' })
    expect(execute).toHaveBeenCalledTimes(1)
    releaseCurrent()
    expect((await currentHandler({}, undefined)).isError).toBe(true)
    expect(execute).toHaveBeenCalledTimes(1)
  })

  it('解绑按身份:一次迟到的收尾不会把已经起跑的下一轮的语境删掉', async () => {
    const releaseFirst = bindHostToolContext({
      agentId: 'fe', roomSessionId: 'room-1', execSessionId: 'exec-1', leaseId: 'lease-1',
    })
    // 同一条会话上的下一轮覆盖上来。
    bindHostToolContext({
      agentId: 'fe', roomSessionId: 'room-1', execSessionId: 'exec-1', leaseId: 'lease-2',
    })
    releaseFirst()

    expect(activeHostToolContextCount()).toBe(1)
    expect(resolveHostToolContext('exec-1')?.leaseId).toBe('lease-2')
  })

  it('release 幂等 —— 它挂在 finally 上,重复调用是常态', () => {
    const release = bindHostToolContext({
      agentId: 'fe', roomSessionId: 'room-1', execSessionId: 'exec-1',
    })
    release()
    release()
    expect(activeHostToolContextCount()).toBe(0)
  })

  it('执行器抛了才算真错 —— 而它必须让模型看见,不能静默成空', async () => {
    const throwing = {
      ...echoTool('board'),
      execute: async () => {
        throw new Error('board store offline')
      },
    } as unknown as HostMcpHostTool
    bindHostToolContext({ agentId: 'fe', roomSessionId: 'room-1', execSessionId: 'exec-1' })
    const handler = toHostMcpToolDefinition(throwing, 'exec-1').handler

    const result = await handler({}, undefined)
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain('board store offline')
  })
})
