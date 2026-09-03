import { describe, expect, it } from 'vitest'
import {
  ALL_SCOPE,
  SCOPE_SPECS,
  projectScope,
  resolveScope,
  sameScope,
  scopeId,
  scopeMatches,
  scopeSpecOf,
  visibleScopes,
} from './scopes'
import { zh } from '../i18n/zh'
import { en } from '../i18n/en'
import { ONETHING_DIR, SESSIONS } from '../data/__fixtures__/sessions'
import { resolveIcon } from '../components/icons'

/**
 * 范围表的守卫。加一档范围 = 表加一行 + i18n 一对(设计 §6 演练第一条),
 * 所以这一组钉的正是那两件事缺一件就红。
 */
describe('SCOPE_SPECS 封闭表', () => {
  it('四档,一格不多一格不少,而且 kind 与索引一致', () => {
    expect(SCOPE_SPECS.map((s) => s.kind)).toEqual(['all', 'collab', 'loose', 'project'])
    for (const spec of SCOPE_SPECS) expect(scopeSpecOf({ kind: spec.kind, projectId: 'x' }).kind).toBe(spec.kind)
  })

  it('每一格的 labelKey 在 zh / en 两本字典里都真有一条', () => {
    for (const spec of SCOPE_SPECS) {
      expect(zh[spec.labelKey], `zh ${spec.kind}`).toBeTruthy()
      expect(en[spec.labelKey], `en ${spec.kind}`).toBeTruthy()
    }
  })

  it('图标给的是**名字**不是组件 —— 这一层是纯数据,不认识 React', () => {
    for (const spec of SCOPE_SPECS) expect(typeof spec.icon).toBe('string')
  })

  /*
   * 名字必须**真的在册**。`resolveIcon` 认不出来时不报错,它悄悄回退成 FolderTree
   * —— 于是侧栏会画出一列文件夹而没有任何人红。这一条把那条静默回退堵上
   * (09-04 把 loose 那格从 `Square` 换成 `MessageSquare` 时正是靠它自证)。
   */
  it('每一格的图标名在 components/icons 的注册表里真有一件', () => {
    const fallback = resolveIcon('__definitely-not-registered__')
    for (const spec of SCOPE_SPECS) {
      expect(resolveIcon(spec.icon), `${spec.kind} 的图标 ${spec.icon} 没注册`).not.toBe(fallback)
    }
  })
})

describe('归属:互斥且完备(每条会话至少落在 all,协作与无项目不重叠)', () => {
  it('协作三档 + 它们的子行不算「无项目」', () => {
    const room = SESSIONS.find((s) => s.id === 'rm-release')!
    expect(scopeMatches({ kind: 'collab' }, room)).toBe(true)
    expect(scopeMatches({ kind: 'loose' }, room)).toBe(false)
    // 房间带着工作目录,所以它同时也在那个项目里 —— 侧栏是**视角**不是分区,
    // 一条会话出现在两个视角里是对的(它只在一次分组里出现一次:时间)。
    expect(scopeMatches(projectScope(ONETHING_DIR), room)).toBe(true)
  })

  it('agent 私聊(swap)也是协作 —— 判据来自形态表,不是手抄的名单', () => {
    const swap = SESSIONS.find((s) => s.id === 'sw-pair')!
    expect(swap.kind).toBe('swap')
    expect(scopeMatches({ kind: 'collab' }, swap)).toBe(true)
  })

  it('all 恒真', () => {
    expect(SESSIONS.every((s) => scopeMatches(ALL_SCOPE, s))).toBe(true)
  })
})

describe('标识与相等', () => {
  it('项目那一档带上目录,别的档就是档名', () => {
    expect(scopeId(ALL_SCOPE)).toBe('all')
    expect(scopeId(projectScope('/a'))).toBe('project:/a')
    expect(sameScope(projectScope('/a'), projectScope('/a'))).toBe(true)
    expect(sameScope(projectScope('/a'), projectScope('/b'))).toBe(false)
  })
})

describe('侧栏该出现哪几格', () => {
  it('all 恒在;collab / loose 非空才出现', () => {
    expect(visibleScopes(SESSIONS).map(scopeId)).toEqual(['all', 'collab', 'loose'])
    const onlyChat = SESSIONS.filter((s) => s.id === 'os-provider')
    // 这一条有工作目录、不是协作 —— 两格合成范围都空。
    expect(visibleScopes(onlyChat).map(scopeId)).toEqual(['all'])
    expect(visibleScopes([]).map(scopeId)).toEqual(['all'])
  })

  it('**不带数字** —— 表上没有 count 这一格(08-30 计数禁令)', () => {
    for (const spec of SCOPE_SPECS) expect(spec).not.toHaveProperty('count')
  })
})

describe('resolveScope:站不住的那一格退回全部', () => {
  it('项目被删空 → all;还站得住的原样留着', () => {
    expect(resolveScope(projectScope('/不存在'), SESSIONS)).toEqual(ALL_SCOPE)
    expect(resolveScope(projectScope(ONETHING_DIR), SESSIONS)).toEqual(projectScope(ONETHING_DIR))
    expect(resolveScope({ kind: 'collab' }, [])).toEqual(ALL_SCOPE)
    // all 永远站得住,而且是**同一个引用**(不为此换一次状态)。
    expect(resolveScope(ALL_SCOPE, [])).toBe(ALL_SCOPE)
  })
})
