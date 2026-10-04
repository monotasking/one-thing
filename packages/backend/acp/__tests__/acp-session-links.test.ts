import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { FileACPSessionLinkStore, MemoryACPSessionLinkStore } from '../acp-session-links.js'

function paths() {
  const root = mkdtempSync(join(tmpdir(), 'acp-links-'))
  return {
    root,
    target: join(root, 'acp', 'session-links.json'),
    legacy: join(root, 'external-agents', 'session-links.json'),
  }
}

describe('ACP 会话链接表 —— 两条外部 agent 路同吃一张表(A0-3)', () => {
  it('ACP 链接经契约那一面写入时保留开会话时记下的选项', () => {
    const store = new MemoryACPSessionLinkStore()
    store.putLink({ agentId: 'pi', localSessionId: 's1', acpSessionId: 'a1', cwd: '/w', options: { model: 'm' }, updatedAt: 1 })
    store.putExternalLink({
      localSessionId: 's1', connectorId: 'acp', agentId: 'pi', externalSessionId: 'a2', cwd: '/w', createdAt: 5, lastUsedAt: 9,
    })
    expect(store.getLink('pi', 's1')).toEqual({
      agentId: 'pi', localSessionId: 's1', acpSessionId: 'a2', cwd: '/w', options: { model: 'm' }, createdAt: 1, updatedAt: 9,
    })
    expect(store.getExternalLink('acp', 's1')).toEqual({
      localSessionId: 's1', connectorId: 'acp', agentId: 'pi', externalSessionId: 'a2', cwd: '/w', createdAt: 1, lastUsedAt: 9,
    })
  })

  it('非 ACP 连接器的链接按 连接器id:会话id 落位,读回来形状不变', () => {
    const store = new MemoryACPSessionLinkStore()
    const link = { localSessionId: 's1', connectorId: 'other-connector', externalSessionId: 'x1', cwd: '/w', createdAt: 3, lastUsedAt: 4 }
    store.putExternalLink(link)
    expect(store.getExternalLink('other-connector', 's1')).toEqual(link)
    // 与 ACP 那一面互不串门。
    expect(store.getExternalLink('acp', 's1')).toBeUndefined()
  })

  it('首次读时并入旧的 external-agents 表:只补缺的键、写回一次、旧文件不删、重复读是空操作', () => {
    const { target, legacy } = paths()
    mkdirSync(join(legacy, '..'), { recursive: true })
    writeFileSync(legacy, JSON.stringify({
      'other-connector:s1': { localSessionId: 's1', connectorId: 'other-connector', externalSessionId: 'x1', cwd: '/w', createdAt: 3, lastUsedAt: 4 },
    }))
    const store = new FileACPSessionLinkStore(() => target, () => legacy)
    expect(store.getExternalLink('other-connector', 's1')).toMatchObject({ externalSessionId: 'x1', createdAt: 3, lastUsedAt: 4 })
    expect(existsSync(legacy)).toBe(true)
    const written = JSON.parse(readFileSync(target, 'utf8'))
    expect(Object.keys(written.links)).toEqual(['other-connector:s1'])

    // 这边已有同键(比旧表新)时不被旧表覆盖。
    store.putExternalLink({ localSessionId: 's1', connectorId: 'other-connector', externalSessionId: 'x2', cwd: '/w', createdAt: 3, lastUsedAt: 8 })
    const again = new FileACPSessionLinkStore(() => target, () => legacy)
    expect(again.getExternalLink('other-connector', 's1')?.externalSessionId).toBe('x2')
  })
})

describe('A6-b:退役的 claude-code-agent 链接并成 ACP claude-code 链接', () => {
  it('表里的旧记录:键换成 claude-code:<会话>、agentId claude-code、会话 id 原样,旧键删,写回一次', () => {
    const { target } = paths()
    mkdirSync(join(target, '..'), { recursive: true })
    writeFileSync(target, JSON.stringify({
      version: 1,
      links: {
        'claude-code-agent:s1': {
          agentId: 'claude-code-agent', connectorId: 'claude-code-agent', localSessionId: 's1',
          acpSessionId: 'native-1', cwd: '/w', options: {}, createdAt: 3, updatedAt: 4,
        },
        // 同一条本地会话已经有 ACP 那条路写的链接:留 ACP 的,旧记录只删不搬。
        'claude-code-agent:s2': {
          agentId: 'claude-code-agent', connectorId: 'claude-code-agent', localSessionId: 's2',
          acpSessionId: 'native-old', cwd: '/w', options: {}, createdAt: 1, updatedAt: 2,
        },
        'claude-code:s2': {
          agentId: 'claude-code', localSessionId: 's2', acpSessionId: 'native-new', cwd: '/w', options: { model: 'm' }, createdAt: 5, updatedAt: 6,
        },
      },
      profiles: {},
    }))
    const store = new FileACPSessionLinkStore(() => target, () => undefined)
    expect(store.getLink('claude-code', 's1')).toEqual({
      agentId: 'claude-code', localSessionId: 's1', acpSessionId: 'native-1', cwd: '/w', options: {}, createdAt: 3, updatedAt: 4,
    })
    expect(store.getExternalLink('acp', 's1')).toEqual({
      localSessionId: 's1', connectorId: 'acp', agentId: 'claude-code', externalSessionId: 'native-1', cwd: '/w', createdAt: 3, lastUsedAt: 4,
    })
    expect(store.getExternalLink('claude-code-agent', 's1')).toBeUndefined()
    expect(store.getLink('claude-code', 's2')?.acpSessionId).toBe('native-new')

    const written = readFileSync(target, 'utf8')
    expect(Object.keys(JSON.parse(written).links).sort()).toEqual(['claude-code:s1', 'claude-code:s2'])
    // 一次性:再读一遍不再搬、不再写。
    const again = new FileACPSessionLinkStore(() => target, () => undefined)
    expect(again.getLink('claude-code', 's1')?.acpSessionId).toBe('native-1')
    expect(readFileSync(target, 'utf8')).toBe(written)
  })

  it('旧 external-agents 表里的 claude-code-agent 记录直接落成 ACP claude-code 链接,重复读不再写', () => {
    const { target, legacy } = paths()
    mkdirSync(join(legacy, '..'), { recursive: true })
    writeFileSync(legacy, JSON.stringify({
      'claude-code-agent:s1': { localSessionId: 's1', connectorId: 'claude-code-agent', externalSessionId: 'native-1', cwd: '/w', createdAt: 3, lastUsedAt: 4 },
    }))
    const store = new FileACPSessionLinkStore(() => target, () => legacy)
    expect(store.getExternalLink('acp', 's1')).toMatchObject({ agentId: 'claude-code', externalSessionId: 'native-1', cwd: '/w' })
    const written = readFileSync(target, 'utf8')
    expect(Object.keys(JSON.parse(written).links)).toEqual(['claude-code:s1'])
    const again = new FileACPSessionLinkStore(() => target, () => legacy)
    expect(again.getLink('claude-code', 's1')?.acpSessionId).toBe('native-1')
    expect(readFileSync(target, 'utf8')).toBe(written)
  })
})
