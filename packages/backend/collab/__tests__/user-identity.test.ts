/**
 * 用户身份的单一属主(docs/design/agent-dm-user.md §2.2)。
 *
 * 两件只有在 settings 边界上才成立的事:
 *  1. **缺省链**——没配资料时 label 是「用户」、handle 是 'user'。这两个值是
 *     dm 与花名册的兜底,一旦飘了就是"配置之后才能被 @/被 dm";
 *  2. **每次现取**——改名即时生效。做过镜像的模块都会在某一天忘记让它失效。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  settings: { general: {} } as { general: { userProfile?: Record<string, string> } },
}))

vi.mock('../../store.js', () => ({
  getSettings: () => mocks.settings,
}))

const { collabUserPromptFields, resolveUserIdentity } = await import('../user-identity.js')

beforeEach(() => {
  mocks.settings = { general: {} }
})

describe('缺省回退链', () => {
  it('空资料 → 用户 / user', () => {
    expect(resolveUserIdentity()).toEqual({ label: '用户', handle: 'user' })
  })

  it('全空白也算没配置(空字符串不是名字)', () => {
    mocks.settings = { general: { userProfile: { name: '   ', handle: '  ' } } }
    expect(resolveUserIdentity()).toEqual({ label: '用户', handle: 'user' })
  })

  it('settings 整个取不到时不炸(启动早期/headless)', () => {
    mocks.settings = undefined as never
    expect(resolveUserIdentity()).toEqual({ label: '用户', handle: 'user' })
  })
})

describe('句柄清洗', () => {
  it('小写化 + 只留 [a-z0-9_-]', () => {
    mocks.settings = { general: { userProfile: { handle: 'Yi Tian!' } } }
    expect(resolveUserIdentity().handle).toBe('yitian')
  })

  it('截到 24 位', () => {
    mocks.settings = { general: { userProfile: { handle: 'a'.repeat(40) } } }
    expect(resolveUserIdentity().handle).toHaveLength(24)
  })

  it('清洗到空(纯中文句柄)落回 user —— 那一档永远可达', () => {
    mocks.settings = { general: { userProfile: { handle: '一天' } } }
    expect(resolveUserIdentity().handle).toBe('user')
  })
})

describe('头像', () => {
  it('两个头像字段都空时不出现在结果里(缺省由调用点给)', () => {
    expect(resolveUserIdentity().avatar).toBeUndefined()
    expect(resolveUserIdentity().avatarImage).toBeUndefined()
  })

  it('配了就原样带出', () => {
    mocks.settings = { general: { userProfile: { avatar: '🙂', avatarImage: 'me.png' } } }
    expect(resolveUserIdentity()).toMatchObject({ avatar: '🙂', avatarImage: 'me.png' })
  })
})

describe('现取,不做镜像', () => {
  it('改名后下一次调用就是新名字', () => {
    expect(resolveUserIdentity().label).toBe('用户')
    mocks.settings = { general: { userProfile: { name: '一天' } } }
    expect(resolveUserIdentity().label).toBe('一天')
  })
})

describe('注入片段', () => {
  it('三处 builder 拿到的是同一份身份', () => {
    mocks.settings = { general: { userProfile: { name: '一天', handle: 'YiTian' } } }
    expect(collabUserPromptFields()).toEqual({ userLabel: '一天', userHandle: 'yitian' })
  })
})
