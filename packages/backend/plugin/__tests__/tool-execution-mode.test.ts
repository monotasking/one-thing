/**
 * N3 —— 工具级并发声明 `executionMode`(pi 采纳线第三期)。
 *
 * 这一期是**纯声明式**的:调度器早就在了(`agent-loop/runner.ts` 的
 * `executionMode !== 'parallel'` → `ToolExecutionScheduler` 屏障),内置工具
 * 也早就带着声明;缺的只是插件工具的协议里没有这个字段,于是插件工具永远
 * 落在缺省(屏障)那一侧,作者无从表达"我这个只读工具可以并发"。
 *
 * 三条验收:声明透传、非法值拒注册(且只拒这一个工具)、缺省不变。
 */
import { describe, expect, it } from 'vitest'
import {
  CORE_PLUGIN_TOOL_EXECUTION_MODES,
  assertCorePluginToolExecutionMode,
  isCorePluginToolExecutionMode,
} from '../tool-execution-mode.js'
import { createCorePluginAPI } from '../api-builder.js'

interface CapturedTool {
  name: string
  executionMode?: unknown
}

function silentLogger() {
  const errors: string[] = []
  return {
    errors,
    logger: {
      log: () => {},
      error: (message: string) => { errors.push(message) },
    },
  }
}

function createToolApi() {
  const registered: Array<{ toolId: string; tool: CapturedTool }> = []
  const { errors, logger } = silentLogger()

  const { api } = createCorePluginAPI<
    { registerTool(tool: CapturedTool): void },
    CapturedTool,
    () => void,
    { name: string },
    object,
    () => string,
    () => void,
    () => void,
    () => [],
    object,
    object
  >({
    pluginId: 'n3',
    store: {},
    scheduler: {},
    logger,
    host: {
      registerTool: (_id, toolId, tool) => { registered.push({ toolId, tool }) },
      subscribeEvent: () => () => {},
      steer: () => {},
      followUp: () => {},
      notify: () => {},
      registerPromptContextProvider: () => () => {},
      registerBeforeContextCompactHook: () => () => {},
      registerAfterAssistantResponseHook: () => () => {},
      registerSkillRoot: () => () => {},
    },
  })

  return { api, registered, errors }
}

describe('N3 executionMode — 声明面', () => {
  it('只认两个字面量', () => {
    expect(CORE_PLUGIN_TOOL_EXECUTION_MODES).toEqual(['sequential', 'parallel'])
    expect(isCorePluginToolExecutionMode('sequential')).toBe(true)
    expect(isCorePluginToolExecutionMode('parallel')).toBe(true)
    expect(isCorePluginToolExecutionMode('paralell')).toBe(false)
    expect(isCorePluginToolExecutionMode(undefined)).toBe(false)
    expect(isCorePluginToolExecutionMode('')).toBe(false)
  })

  it('未声明放行(缺省即现状),声明了必须合法', () => {
    expect(assertCorePluginToolExecutionMode(undefined, 't')).toBeUndefined()
    expect(assertCorePluginToolExecutionMode('parallel', 't')).toBe('parallel')
    expect(assertCorePluginToolExecutionMode('sequential', 't')).toBe('sequential')
    expect(() => assertCorePluginToolExecutionMode('paralell', 't'))
      .toThrow(/executionMode "paralell"/)
    expect(() => assertCorePluginToolExecutionMode(null, 't')).toThrow()
    expect(() => assertCorePluginToolExecutionMode(1, 't')).toThrow()
  })

  it('api.registerTool 原样透传声明,不做任何归一化', () => {
    const { api, registered } = createToolApi()

    api.registerTool({ name: 'peek', executionMode: 'parallel' })
    api.registerTool({ name: 'cursor', executionMode: 'sequential' })

    expect(registered.map(item => item.toolId)).toEqual([
      'plugin:n3:peek',
      'plugin:n3:cursor',
    ])
    expect(registered[0].tool.executionMode).toBe('parallel')
    expect(registered[1].tool.executionMode).toBe('sequential')
  })

  it('不声明就是不声明 —— 宿主收到 undefined(缺省 = 屏障 = 今天的行为)', () => {
    const { api, registered } = createToolApi()

    api.registerTool({ name: 'plain' })

    expect(registered).toHaveLength(1)
    expect(registered[0].tool.executionMode).toBeUndefined()
  })

  it('非法值拒注册这一个工具,插件其余的工具照常', () => {
    const { api, registered, errors } = createToolApi()

    api.registerTool({ name: 'typo', executionMode: 'paralell' })
    expect(registered).toHaveLength(0)
    // 静默降级是这一条最容易犯的错:作者拼错之后必须看得到。
    expect(errors.some(message => message.includes('typo'))).toBe(true)

    api.registerTool({ name: 'ok', executionMode: 'parallel' })
    expect(registered.map(item => item.toolId)).toEqual(['plugin:n3:ok'])
  })
})
