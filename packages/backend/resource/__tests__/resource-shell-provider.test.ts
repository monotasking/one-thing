/**
 * 壳交上来的做法在 core 的 plan 期怎么判(第④步批 2b,内置浏览器搬出 core 进程时落在这里的三条判据)。
 *
 *  ① 自述里 `userOnly` 的做法:非用户主体(模型 / 系统 / 插件)当场抛 `ShellOpUserOnlyError`,排在一切之前;
 *  ② 用户主体一律零效果(地址栏上那颗「前进」是人自己按的,08-18 判例),其余主体按自述的静态上界;
 *  ③ 卡上那句人话:壳交 `describeTemplate` 就按这一次的参数渲染,`[...]` 那一段缺一格就整段不出现;没交就是标题。
 *
 * 从前 ①② 写在内置浏览器自己的 provider 里(`apps/desktop-react/electron/browser/resource-provider.ts` 的 `plan`),
 * 搬成壳侧命名空间之后壳不在授权路上,所以这几条只能由这里钉。
 */
import { describe, expect, it } from 'vitest'
import type { SerializedResourceSpec } from '@shared/ipc/resources.js'
import {
  ShellOpUserOnlyError,
  ShellResourceProvider,
  renderDescribeTemplate,
  resourceSpecFromShell,
} from '../resource-shell-provider.js'

const SPEC: SerializedResourceSpec = {
  scheme: 'browser',
  title: 'test browser',
  reads: {},
  ops: {
    navigate: {
      title: 'Navigate a tab.',
      params: { type: 'object', properties: { url: { type: 'string' } } },
      effects: ['browser_navigate'],
      home: 'shell',
      describeTemplate: 'Send the browser to {url}',
    },
    open: {
      title: 'Open a tab.',
      params: { type: 'object', properties: { url: { type: 'string' }, profile: { type: 'string' } } },
      effects: ['browser_navigate'],
      home: 'shell',
      describeTemplate: 'Open a browser tab[ at {url}][ as {profile}]',
    },
    respondPermission: {
      title: 'Answer a page permission question.',
      params: { type: 'object', properties: {} },
      effects: ['ui_change'],
      home: 'shell',
      userOnly: true,
    },
  },
  events: {},
} as unknown as SerializedResourceSpec

const provider = new ShellResourceProvider(resourceSpecFromShell(SPEC), {} as never)
const ref = { scheme: 'browser', path: 't1' }
const ctx = (kind: 'user' | 'agent' | 'system') => ({
  principal: kind === 'user' ? { kind, userId: 'local' } : { kind, id: `${kind}-1` },
}) as never

describe('ShellResourceProvider.plan(第④步批 2b)', () => {
  it('userOnly:非用户主体在 plan 期当场拒,用户主体照常零效果', async () => {
    for (const kind of ['agent', 'system'] as const) {
      await expect(provider.plan('respondPermission', ref, {}, ctx(kind))).rejects.toBeInstanceOf(ShellOpUserOnlyError)
    }
    const intent = await provider.plan('respondPermission', ref, {}, ctx('user'))
    expect(intent.effects).toEqual([])
  })

  it('人零效果、模型顶格:同一条 navigate,人那一份没有效果,模型那一份是自述的上界', async () => {
    const byUser = await provider.plan('navigate', ref, { url: 'https://x.test' }, ctx('user'))
    expect(byUser.effects).toEqual([])
    const byAgent = await provider.plan('navigate', ref, { url: 'https://x.test' }, ctx('agent'))
    expect(byAgent.effects.map(effect => effect.kind)).toEqual(['browser_navigate'])
    // 卡上那句人话按这一次的参数渲染,地址原样带出来。
    expect(byAgent.preview?.title).toBe('Send the browser to https://x.test')
  })

  it('自述里没有的做法是硬错,不是一条零效果的免检计划', async () => {
    await expect(provider.plan('format-disk', ref, {}, ctx('agent'))).rejects.toThrow()
  })
})

describe('renderDescribeTemplate', () => {
  it('[...] 那一段缺一格就整段不出现;空模板答空串', () => {
    const template = 'Open a browser tab[ at {url}][ as {profile}]'
    expect(renderDescribeTemplate(template, {})).toBe('Open a browser tab')
    expect(renderDescribeTemplate(template, { url: 'https://a.test' })).toBe('Open a browser tab at https://a.test')
    expect(renderDescribeTemplate(template, { url: 'https://a.test', profile: 'work' })).toBe('Open a browser tab at https://a.test as work')
    expect(renderDescribeTemplate(template, { profile: { not: 'a string' } })).toBe('Open a browser tab')
    expect(renderDescribeTemplate('', { url: 'x' })).toBe('')
  })
})
