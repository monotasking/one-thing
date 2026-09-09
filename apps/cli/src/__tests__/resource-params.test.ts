/**
 * `parseResourceParams` —— 四支 `resource.*` 的参数解析(K4-d,还 K4-c 留账 5)。
 *
 * 纯函数,所以这一份不起 daemon:`resource-daemon.test.ts` 证的是「这四支在方法表
 * 上、参数原样落到转发口」(真 socket),这一份证的是**形状判据本身**。两份加起来
 * 才是「网络那一层没走样」+「判据没漏格」。
 */
import { describe, expect, it } from 'vitest'
import { parseResourceParams } from '../daemon-server.js'

describe('parseResourceParams', () => {
  it('resource.list 不收参数(给了也不看)', () => {
    expect(parseResourceParams('resource.list', undefined)).toEqual({ method: 'resource.list' })
    expect(parseResourceParams('resource.list', { junk: 1 })).toEqual({ method: 'resource.list' })
  })

  it('resource.describe 要 scheme', () => {
    expect(parseResourceParams('resource.describe', { scheme: 'session' }))
      .toEqual({ method: 'resource.describe', scheme: 'session' })
    expect(() => parseResourceParams('resource.describe', {}))
      .toThrow(/scheme is required/)
  })

  it('resource.read:ref / name 必填,query 不给就是空表', () => {
    expect(parseResourceParams('resource.read', {
      ref: 'session:s1', name: 'get', query: { limit: 5 }, sessionId: 'origin-1',
    })).toEqual({
      method: 'resource.read', ref: 'session:s1', name: 'get', query: { limit: 5 }, sessionId: 'origin-1',
    })
    expect(parseResourceParams('resource.read', { ref: 'session:s1', name: 'get' }))
      .toEqual({ method: 'resource.read', ref: 'session:s1', name: 'get', query: {} })
    expect(() => parseResourceParams('resource.read', { name: 'get' })).toThrow(/ref is required/)
    expect(() => parseResourceParams('resource.read', { ref: 'session:s1' })).toThrow(/name is required/)
  })

  it('resource.do:ref / op 必填,params 不给就是空表', () => {
    expect(parseResourceParams('resource.do', { ref: 'session:s1', op: 'rename', params: { name: 'x' } }))
      .toEqual({ method: 'resource.do', ref: 'session:s1', op: 'rename', params: { name: 'x' } })
    expect(parseResourceParams('resource.do', { ref: 'session:s1', op: 'rename' }))
      .toEqual({ method: 'resource.do', ref: 'session:s1', op: 'rename', params: {} })
    expect(() => parseResourceParams('resource.do', { ref: 'session:s1' })).toThrow(/op is required/)
  })

  /** 发起坐标缺席就是缺席 —— 不拿 ref 里那条会话顶上(K1 留账那个病)。 */
  it('sessionId 缺席不补,给了就得是非空字符串', () => {
    expect(parseResourceParams('resource.do', { ref: 'session:s1', op: 'rename' }))
      .not.toHaveProperty('sessionId')
    expect(parseResourceParams('resource.do', { ref: 'session:s1', op: 'rename', sessionId: null }))
      .not.toHaveProperty('sessionId')
    expect(() => parseResourceParams('resource.do', { ref: 'session:s1', op: 'rename', sessionId: 7 }))
      .toThrow(/sessionId must be a non-empty string/)
  })

  it('query / params 给了就得是对象(数组不算)', () => {
    expect(() => parseResourceParams('resource.read', { ref: 'r', name: 'get', query: 'nope' }))
      .toThrow(/query must be an object/)
    expect(() => parseResourceParams('resource.do', { ref: 'r', op: 'x', params: [1, 2] }))
      .toThrow(/params must be an object/)
  })

  /**
   * K4-c 那两例照旧:主体只能是 `system` 一支。判据搬了家(从四个调用点收进解析器),
   * **答案一个字没变** —— 允许一条桥自称 `user`,等于让任何连得上 socket 的进程一句话
   * 拿到用户主体。
   */
  it('主体:system 放行,user / agent 当场拒,不给就是不给', () => {
    expect(parseResourceParams('resource.do', {
      ref: 'session:s1', op: 'rename', principal: { kind: 'system', component: 'mcp:probe' },
    })).toMatchObject({ principal: { kind: 'system', component: 'mcp:probe' } })

    expect(parseResourceParams('resource.read', { ref: 'session:s1', name: 'get' }))
      .not.toHaveProperty('principal')

    expect(() => parseResourceParams('resource.do', {
      ref: 'session:s1', op: 'rename', principal: { kind: 'user', userId: 'local' },
    })).toThrow(/principal must be/)
    expect(() => parseResourceParams('resource.read', {
      ref: 'session:s1', name: 'get', principal: { kind: 'agent', agentId: 'a1' },
    })).toThrow(/principal must be/)
    expect(() => parseResourceParams('resource.do', {
      ref: 'session:s1', op: 'rename', principal: { kind: 'system', component: '  ' },
    })).toThrow(/principal must be/)
  })

  it('校验错一律是结构化的 ERR_VALIDATION', () => {
    try {
      parseResourceParams('resource.do', {})
      expect.unreachable('should have thrown')
    } catch (error) {
      expect((error as Error).name).toBe('ERR_VALIDATION')
    }
  })
})
