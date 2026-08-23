/**
 * E0(claude-code-integration-v2 §3):AgentExecutor 契约与骨架。
 *
 * 这个文件盯三件事,每一件都是「改造前后必须逐字节等价」的那种盯:
 *   1. 解析单点认得出 local / claude-code / acp,认不出的一律回落 local;
 *   2. 三处 Set 判定改成能力查询后行为不变(压缩关闭、鉴权豁免各一条);
 *   3. `executor` 字段接线不破坏向后兼容——线上 agents.json 里一行 executor
 *      都没有,Iris 全靠 providerId 走外部通路,这条不能因为接线而断。
 */
import { describe, expect, it } from 'vitest'
import {
  coreProviderOwnsItsContextWindow,
  getCoreProviderExecution,
  registerCoreProviderExecution,
  shouldStartAgentLoopContextCompact,
} from '@onething/core/engine'
import {
  agentExecutorOwnsContextWindow,
  createExternalAgentExecutor,
  createLocalAgentExecutor,
  isExternalAgentExecutorProvider,
  resolveAgentExecutor,
  resolveAgentExecutorId,
  resolveAgentExecutorSelection,
} from '../executor/index.js'
import { agentMind } from '../model.js'
import type { OnethingAgentDefinition } from '../store.js'
import {
  getProviderApiKeyWithAdapters,
  resolveProviderAuthWithAdapters,
} from '../../providers/provider-config.js'

describe('执行器解析单点(§3)', () => {
  it('本地是缺省落点:未知 providerId 不是「未知外部」,是本地', () => {
    for (const providerId of ['deepseek', 'claude', 'openai', 'qwen', '', undefined]) {
      const executor = resolveAgentExecutor(providerId)
      expect(executor.kind).toBe('local')
      expect(executor.id).toBe('local')
    }
    expect(resolveAgentExecutorId(undefined)).toBe('local')
  })

  it('claude-code-agent 解析成 external,能力按 connector 现状声明', () => {
    const executor = resolveAgentExecutor('claude-code-agent')
    expect(executor.id).toBe('claude-code-agent')
    expect(executor.kind).toBe('external')
    expect(executor.capabilities).toEqual({
      hostTools: true,
      // e610b0dc:steering 接通(priority:'now' 就地截断),能力表随连接器现状。
      steer: true,
      interrupt: true,
      contextWindow: 'theirs',
      persona: 'system',
    })
  })

  it('acp 解析成 external,不确定的能力填保守值', () => {
    const executor = resolveAgentExecutor('acp')
    expect(executor.id).toBe('acp')
    expect(executor.kind).toBe('external')
    expect(executor.capabilities).toEqual({
      hostTools: false,
      steer: false,
      interrupt: false,
      contextWindow: 'theirs',
      persona: 'prepend',
    })
  })

  it('本地执行器自己管上下文,外部执行器不归我们管', () => {
    expect(createLocalAgentExecutor().capabilities.contextWindow).toBe('ours')
    expect(agentExecutorOwnsContextWindow('deepseek')).toBe(false)
    expect(agentExecutorOwnsContextWindow('claude-code-agent')).toBe(true)
    expect(agentExecutorOwnsContextWindow('acp')).toBe(true)
  })

  it('未登记的 connectorId 仍是外部,但能力一条不敢声明', () => {
    const executor = createExternalAgentExecutor('codex-app-server')
    expect(executor.kind).toBe('external')
    expect(executor.capabilities).toEqual({
      hostTools: false,
      steer: false,
      interrupt: false,
      contextWindow: 'theirs',
      persona: 'prepend',
    })
  })

  it('E0 只给骨架:runTurn 尚未接驱动(E4),契约位先留空', () => {
    expect(resolveAgentExecutor('claude-code-agent').runTurn).toBeUndefined()
    expect(createLocalAgentExecutor().runTurn).toBeUndefined()
  })
})

describe('executor 字段接线的向后兼容(域模型 M7)', () => {
  function agent(overrides: Partial<OnethingAgentDefinition>): OnethingAgentDefinition {
    return {
      id: 'a',
      name: 'A',
      systemPrompt: '',
      createdAt: 1,
      updatedAt: 1,
      ...overrides,
    }
  }

  it('只配了 providerId 的老 agent:解析结果与改造前一致', () => {
    // Iris 的真实形状——executor 字段从未写过,靠 providerId 走外部通路。
    const iris = agent({ model: { providerId: 'claude-code-agent', modelId: 'sonnet' } })
    expect(resolveAgentExecutorSelection(iris)).toEqual({
      type: 'external',
      connectorId: 'claude-code-agent',
    })
    expect(resolveAgentExecutor(iris).kind).toBe('external')
    expect(resolveAgentExecutor(iris).id).toBe('claude-code-agent')

    // 普通同事同理不受影响。
    const local = agent({ model: { providerId: 'deepseek' } })
    expect(resolveAgentExecutorSelection(local)).toEqual({ type: 'native' })
    expect(resolveAgentExecutor(local).kind).toBe('local')

    // 连 model 绑定都没有的远古行。
    expect(resolveAgentExecutorSelection(agent({}))).toEqual({ type: 'native' })
  })

  it('显式 executor 字段优先于 providerId 推导', () => {
    const overridden = agent({
      model: { providerId: 'deepseek' },
      executor: { type: 'external', connectorId: 'acp' },
    })
    expect(resolveAgentExecutorId(overridden)).toBe('acp')
    expect(resolveAgentExecutor(overridden).kind).toBe('external')

    const pinnedNative = agent({
      model: { providerId: 'deepseek' },
      executor: { type: 'native' },
    })
    expect(resolveAgentExecutorId(pinnedNative)).toBe('local')
  })

  it('心智面投影给的是解析结果,不是「存了什么就是什么」', () => {
    // 接线前这里会对 Iris 撒谎说 native——字段无人消费时看不出来。
    expect(agentMind(agent({ model: { providerId: 'claude-code-agent' } })).executor).toEqual({
      type: 'external',
      connectorId: 'claude-code-agent',
    })
    expect(agentMind(agent({ model: { providerId: 'deepseek' } })).executor).toEqual({
      type: 'native',
    })
    // 投影结果再喂回解析器必须是不动点(否则就是个陷阱)。
    const mind = agentMind(agent({ model: { providerId: 'claude-code-agent' } }))
    expect(resolveAgentExecutorId(mind)).toBe('claude-code-agent')
  })
})

describe('Set 判定 → 能力查询:行为等价', () => {
  it('压缩门:上下文归执行体自己管时,压缩不发生', () => {
    // 改造前判据是 `isCoreExternalAgentProvider(providerId)`;这两条是同一批入参。
    // 2026-08-23:`getAgentLoopContextBlockReason`(hard-limit 阻断)随触发器一起删除,
    // 这道门只剩"压不压"一个观测点。
    for (const providerId of ['acp', 'claude-code-agent']) {
      expect(coreProviderOwnsItsContextWindow(providerId)).toBe(true)
      expect(shouldStartAgentLoopContextCompact({
        turn: 2,
        providerId,
        compactEnabled: true,
      })).toBe(false)
    }

    // 本地 provider 一步不让:压缩照开。
    expect(coreProviderOwnsItsContextWindow('deepseek')).toBe(false)
    expect(shouldStartAgentLoopContextCompact({
      turn: 2,
      providerId: 'deepseek',
      compactEnabled: true,
    })).toBe(true)
  })

  it('压缩门认的是登记表而不是写死名单:新登记一个外部执行体就该关门', () => {
    const providerId = '__test-codex-executor__'
    expect(shouldStartAgentLoopContextCompact({
      turn: 2,
      providerId,
      compactEnabled: true,
    })).toBe(true)

    registerCoreProviderExecution(providerId, { kind: 'external', contextWindow: 'theirs' })
    expect(shouldStartAgentLoopContextCompact({
      turn: 2,
      providerId,
      compactEnabled: true,
    })).toBe(false)

    // 复位,免得污染同进程里的其它用例。
    registerCoreProviderExecution(providerId, { kind: 'local', contextWindow: 'ours' })
    expect(shouldStartAgentLoopContextCompact({
      turn: 2,
      providerId,
      compactEnabled: true,
    })).toBe(true)
  })

  it('runtime 的执行器表已下沉到 core:两侧对同一 id 的事实一致', () => {
    for (const providerId of ['acp', 'claude-code-agent']) {
      const executor = resolveAgentExecutor(providerId)
      expect(getCoreProviderExecution(providerId)).toEqual({
        kind: executor.kind,
        contextWindow: executor.capabilities.contextWindow,
      })
    }
    expect(getCoreProviderExecution('deepseek')).toEqual({ kind: 'local', contextWindow: 'ours' })
  })

  it('鉴权豁免:外部执行体拿到空凭据,本地 provider 照常走 resolveApiKey', async () => {
    const adapters = {
      providerConfig: undefined,
      isOAuthProvider: () => false,
      refreshOAuthToken: async () => ({ accessToken: 'oauth-token' }),
      resolveApiKey: () => 'sk-local',
      resolveOAuthAuth: async () => null,
    }

    for (const providerId of ['acp', 'claude-code-agent']) {
      expect(isExternalAgentExecutorProvider(providerId)).toBe(true)
      expect(await getProviderApiKeyWithAdapters({ ...adapters, providerId })).toBe('')
      expect(await resolveProviderAuthWithAdapters({ ...adapters, providerId })).toEqual({
        kind: 'api-key',
        apiKey: '',
      })
    }

    expect(isExternalAgentExecutorProvider('deepseek')).toBe(false)
    expect(await getProviderApiKeyWithAdapters({ ...adapters, providerId: 'deepseek' }))
      .toBe('sk-local')
    expect(await resolveProviderAuthWithAdapters({ ...adapters, providerId: 'deepseek' }))
      .toEqual({ kind: 'api-key', apiKey: 'sk-local' })
  })
})
