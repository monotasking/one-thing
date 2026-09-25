import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { FileACPSessionLinkStore, MemoryACPSessionLinkStore } from '../session-links.js'

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

  it('Claude 路的链接按 连接器id:会话id 落位,读回来形状不变', () => {
    const store = new MemoryACPSessionLinkStore()
    const link = { localSessionId: 's1', connectorId: 'claude-code-agent', externalSessionId: 'x1', cwd: '/w', createdAt: 3, lastUsedAt: 4 }
    store.putExternalLink(link)
    expect(store.getExternalLink('claude-code-agent', 's1')).toEqual(link)
    // 与 ACP 那一面互不串门。
    expect(store.getExternalLink('acp', 's1')).toBeUndefined()
  })

  it('首次读时并入旧的 external-agents 表:只补缺的键、写回一次、旧文件不删、重复读是空操作', () => {
    const { target, legacy } = paths()
    mkdirSync(join(legacy, '..'), { recursive: true })
    writeFileSync(legacy, JSON.stringify({
      'claude-code-agent:s1': { localSessionId: 's1', connectorId: 'claude-code-agent', externalSessionId: 'x1', cwd: '/w', createdAt: 3, lastUsedAt: 4 },
    }))
    const store = new FileACPSessionLinkStore(() => target, () => legacy)
    expect(store.getExternalLink('claude-code-agent', 's1')).toMatchObject({ externalSessionId: 'x1', createdAt: 3, lastUsedAt: 4 })
    expect(existsSync(legacy)).toBe(true)
    const written = JSON.parse(readFileSync(target, 'utf8'))
    expect(Object.keys(written.links)).toEqual(['claude-code-agent:s1'])

    // 这边已有同键(比旧表新)时不被旧表覆盖。
    store.putExternalLink({ localSessionId: 's1', connectorId: 'claude-code-agent', externalSessionId: 'x2', cwd: '/w', createdAt: 3, lastUsedAt: 8 })
    const again = new FileACPSessionLinkStore(() => target, () => legacy)
    expect(again.getExternalLink('claude-code-agent', 's1')?.externalSessionId).toBe('x2')
  })
})
