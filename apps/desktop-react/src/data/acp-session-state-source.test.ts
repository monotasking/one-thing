import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AcpSessionState } from '@shared/contracts/acp'
import {
  acpSessionStateKey,
  acpSessionStateQuery,
  agentIdOfSelection,
  configureAcpSessionStatePort,
  resetAcpSessionStateSource,
  sessionStateOfFrame,
  startAcpSessionStateSource,
} from './acp-session-state-source'

/**
 * 会话状态这一格的三条性质:冷读按「会话 × agent」、推送整张替换、冷读与推送赛跑时推送赢。
 * 「非 agent 会话零往返」是 hook 那一层的事,用例在 `composer/components/Composer.test.tsx` A2-c 段。
 */

const stateOf = (agentId: string, model: string): AcpSessionState => ({
  localSessionId: 's1',
  agentId,
  configOptions: [
    { id: 'model', name: 'Model', category: 'model', currentValue: model, choices: [{ value: model, name: model }] },
  ],
  commands: [],
  notices: [],
  process: { status: 'connected' },
})

let push: ((state: AcpSessionState) => void) | undefined
let answer: () => Promise<AcpSessionState | null>
const asked: unknown[] = []

beforeEach(() => {
  asked.length = 0
  push = undefined
  answer = async () => null
  configureAcpSessionStatePort({
    ready: async () => undefined,
    sessionState: (request) => {
      asked.push(request)
      return answer()
    },
    onSessionState: (callback) => {
      push = callback
      return () => {
        push = undefined
      }
    },
  })
})

afterEach(() => {
  resetAcpSessionStateSource()
  configureAcpSessionStatePort(undefined)
})

describe('acp-session-state-source', () => {
  it('冷读带 agentId;读到另一台的表 = 这一格没有', async () => {
    answer = async () => stateOf('other', 'x')
    const query = acpSessionStateQuery.get(acpSessionStateKey('s1', 'fake'))
    await query.ensure()
    expect(asked).toEqual([{ sessionId: 's1', agentId: 'fake' }])
    expect(query.get().data).toBeNull()
  })

  it('推送整张替换那一格;没人问过的格不建', async () => {
    await startAcpSessionStateSource()
    push?.(stateOf('fake', 'alpha'))
    expect(acpSessionStateQuery.keys()).toEqual([])
    const query = acpSessionStateQuery.get(acpSessionStateKey('s1', 'fake'))
    await query.ensure()
    push?.(stateOf('fake', 'beta'))
    expect(query.get().data?.configOptions[0]?.currentValue).toBe('beta')
  })

  it('冷读在飞时推来一帧:推送赢(冷读那份旧表不落格)', async () => {
    await startAcpSessionStateSource()
    let release: (value: AcpSessionState | null) => void = () => undefined
    answer = () => new Promise((resolve) => (release = resolve))
    const query = acpSessionStateQuery.get(acpSessionStateKey('s1', 'fake'))
    const done = query.ensure()
    // 等冷读真的出门(端口、ready 各过一拍),推送才算「冷读在飞时到的」。
    for (let i = 0; i < 10 && asked.length === 0; i += 1) await Promise.resolve()
    expect(asked).toHaveLength(1)
    push?.(stateOf('fake', 'fresh'))
    release(null)
    await done
    expect(query.get().data?.configOptions[0]?.currentValue).toBe('fresh')
  })

  it('帧的形不对就丢;缺的数组格补空', () => {
    expect(sessionStateOfFrame({ state: { agentId: 'x' } })).toBeNull()
    expect(sessionStateOfFrame(null)).toBeNull()
    const parsed = sessionStateOfFrame({ state: { localSessionId: 's', agentId: 'x' } })
    expect(parsed?.commands).toEqual([])
    expect(parsed?.process.status).toBe('disconnected')
  })

  it('agent 判据:只认 acp 那一族', () => {
    expect(agentIdOfSelection({ provider: 'acp', model: 'fake' })).toBe('fake')
    expect(agentIdOfSelection({ provider: 'xai', model: 'grok-4' })).toBeNull()
    expect(agentIdOfSelection(null)).toBeNull()
  })
})
