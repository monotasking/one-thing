/**
 * K5-a —— 一台外部 server 的工具表 → 一份资源自述。
 *
 * 这只文件钉的是**投影本身**(纯函数,没有连接、没有内核):归一的四种病、自述
 * 过不过契约门、指纹按什么变,以及那句「AI 走 `McpTool`」写在自述里而不是写在出口
 * 那一侧。寿命(连上 / 断开 / 重挂)在 `backend/wiring/resource/__tests__/mcp-mount.test.ts`。
 */

import { describe, expect, it } from 'vitest'
import { describeResourceSpecProblem } from '@onething/core/resource'
import type { MCPToolInfo } from '@onething/core/mcp'
import {
  MCP_RESOURCE_SCHEME_PREFIX,
  MCP_RESOURCE_SINGLETON_PATH,
  mcpResourceOpName,
  mcpResourceScheme,
  projectMcpResource,
} from '../resource-spec.js'

function tool(name: string, description?: string): MCPToolInfo {
  return {
    name,
    ...(description !== undefined ? { description } : {}),
    inputSchema: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] },
    serverId: 'srv',
  }
}

describe('mcpResourceScheme', () => {
  it('prefixes the normalized server id', () => {
    expect(mcpResourceScheme('brave')).toBe(`${MCP_RESOURCE_SCHEME_PREFIX}brave`)
    expect(mcpResourceScheme('My_Server')).toBe(`${MCP_RESOURCE_SCHEME_PREFIX}my-server`)
    // uuid 一样过得去(`createCoreId()` 生成的 id 就长这样)。
    expect(mcpResourceScheme('9f2c1a0b-77de-4b1e-9a11-000000000000'))
      .toBe(`${MCP_RESOURCE_SCHEME_PREFIX}9f2c1a0b-77de-4b1e-9a11-000000000000`)
  })

  it('the prefix is what makes a digit-leading id legal', () => {
    // 前缀存在的第一个理由(见 `MCP_RESOURCE_SCHEME_PREFIX` 那格注释)。
    expect(mcpResourceScheme('2fa')).toBe(`${MCP_RESOURCE_SCHEME_PREFIX}2fa`)
  })

  it('disambiguates ids that normalize onto each other', () => {
    const taken = new Set<string>()
    const first = mcpResourceScheme('My Server', taken)!
    taken.add(first)
    const second = mcpResourceScheme('my_server', taken)!
    expect(first).toBe(`${MCP_RESOURCE_SCHEME_PREFIX}my-server`)
    expect(second).toBe(`${MCP_RESOURCE_SCHEME_PREFIX}my-server-2`)
    expect(second).not.toBe(first)
  })

  it('gives up rather than inventing an address', () => {
    expect(mcpResourceScheme('')).toBeNull()
    expect(mcpResourceScheme('___')).toBeNull()
    expect(mcpResourceScheme('服务器')).toBeNull()
  })
})

describe('mcpResourceOpName', () => {
  it('camelizes the two shapes MCP tool names actually come in', () => {
    expect(mcpResourceOpName('brave_web_search')).toBe('braveWebSearch')
    expect(mcpResourceOpName('get-library-docs')).toBe('getLibraryDocs')
  })

  it('leaves an already-camel name alone', () => {
    expect(mcpResourceOpName('getLibraryDocs')).toBe('getLibraryDocs')
    expect(mcpResourceOpName('GetDocs')).toBe('getDocs')
  })

  it('drops leading digits — a member name must start with a letter', () => {
    expect(mcpResourceOpName('2fa_check')).toBe('faCheck')
  })

  it('returns null when nothing usable is left', () => {
    expect(mcpResourceOpName('___')).toBeNull()
    expect(mcpResourceOpName('')).toBeNull()
  })
})

describe('projectMcpResource', () => {
  const scheme = `${MCP_RESOURCE_SCHEME_PREFIX}srv`

  it('passes the contract gate as written — no kernel change', () => {
    const { spec } = projectMcpResource({
      scheme,
      title: 'Brave Search',
      tools: [tool('brave_web_search', 'Search the web. Returns a list of results.')],
    })
    expect(describeResourceSpecProblem(spec)).toBeNull()
  })

  it('makes one op per tool, with the mcp effect and a core home', () => {
    const { spec, toolNames } = projectMcpResource({
      scheme,
      title: 'Brave Search',
      tools: [tool('brave_web_search'), tool('get-library-docs')],
    })
    expect(Object.keys(spec.ops)).toEqual(['braveWebSearch', 'getLibraryDocs'])
    expect(spec.ops.braveWebSearch.effects).toEqual(['mcp'])
    expect(spec.ops.braveWebSearch.home).toBe('core')
    // params 就是那只工具自己的 inputSchema —— 不翻译、不补默认。
    expect(spec.ops.braveWebSearch.params).toEqual({
      type: 'object',
      properties: { q: { type: 'string' } },
      required: ['q'],
    })
    // 真正的工具名留在对照表里,而不是自述里。
    expect(toolNames.get('braveWebSearch')).toBe('brave_web_search')
    expect(toolNames.get('getLibraryDocs')).toBe('get-library-docs')
  })

  it('titles an op with the first sentence of its description, or its tool name', () => {
    const { spec } = projectMcpResource({
      scheme,
      title: 'Brave Search',
      tools: [
        tool('a_tool', 'Search the web. A much longer second sentence nobody needs in a menu row.'),
        tool('b_tool'),
      ],
    })
    expect(spec.ops.aTool.title).toBe('Search the web.')
    expect(spec.ops.bTool.title).toBe('b_tool')
  })

  it('keeps two tools whose names normalize onto each other', () => {
    const { spec, toolNames } = projectMcpResource({
      scheme,
      title: 'Two',
      tools: [tool('get_docs'), tool('get-docs')],
    })
    expect(Object.keys(spec.ops).sort()).toEqual(['getDocs', 'getDocs2'])
    // 两只都还指得回真名 —— 归一撞名时丢掉一只不是选项。
    expect([...toolNames.values()].sort()).toEqual(['get-docs', 'get_docs'])
  })

  it('drops a tool whose name has nothing usable in it, and keeps the rest', () => {
    const { spec } = projectMcpResource({ scheme, title: 'Odd', tools: [tool('___'), tool('ok_one')] })
    expect(Object.keys(spec.ops)).toEqual(['okOne'])
  })

  it('orders ops by tool name, not by the order the server reported them', () => {
    const forward = projectMcpResource({ scheme, title: 'T', tools: [tool('a'), tool('b')] })
    const backward = projectMcpResource({ scheme, title: 'T', tools: [tool('b'), tool('a')] })
    expect(Object.keys(forward.spec.ops)).toEqual(Object.keys(backward.spec.ops))
    // 同一台 server 两次连接必须给出同一份自述 —— 它会进提示词。
    expect(forward.fingerprint).toBe(backward.fingerprint)
  })

  it('has empty reads and events (§3: 手工补)', () => {
    const { spec } = projectMcpResource({ scheme, title: 'T', tools: [tool('a')] })
    expect(spec.reads).toEqual({})
    expect(spec.events).toEqual({})
    expect(spec.state).toBeUndefined()
  })

  it('declares itself out of the model-facing catalog — AI goes through McpTool', () => {
    const { spec } = projectMcpResource({ scheme, title: 'T', tools: [tool('a')] })
    expect(spec.exposure?.aiTool).toBe(false)
  })

  it('changes its fingerprint when the tool table changes, and only then', () => {
    const one = projectMcpResource({ scheme, title: 'T', tools: [tool('a', 'One.')] })
    const same = projectMcpResource({ scheme, title: 'T', tools: [tool('a', 'One.')] })
    const added = projectMcpResource({ scheme, title: 'T', tools: [tool('a', 'One.'), tool('b')] })
    const retitled = projectMcpResource({ scheme, title: 'T2', tools: [tool('a', 'One.')] })
    const redescribed = projectMcpResource({ scheme, title: 'T', tools: [tool('a', 'Two.')] })

    expect(same.fingerprint).toBe(one.fingerprint)
    expect(added.fingerprint).not.toBe(one.fingerprint)
    expect(retitled.fingerprint).not.toBe(one.fingerprint)
    expect(redescribed.fingerprint).not.toBe(one.fingerprint)
  })

  it('addresses a single instance', () => {
    expect(MCP_RESOURCE_SINGLETON_PATH).toBe('server')
  })
})
