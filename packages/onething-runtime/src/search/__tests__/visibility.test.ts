/**
 * S6 —— 会话域能力的可见范围规则(拍点辛 a;§6.4b)。
 *
 * 这一层只问「**形**对不对」:三个主体各走哪一支、端口没装时是关还是开、范围怎么
 * 变成 `FacetFilter`。「谁是成员 / 哪个空间」的判据在装配层,由
 * `backend/wiring/search/__tests__/visibility.test.ts` 考。
 */

import { describe, expect, it } from 'vitest'
import { matchesFacetFilter } from '@onething/core/search/index/types'
import type { SearchPrincipal } from '@onething/core/search'
import {
  configureSearchVisibilityPort,
  getSearchVisibilityPort,
  sessionScopeVisibility,
} from '../capabilities/visibility.js'
import { chatsSearchManifest } from '../capabilities/sessions.js'
import { messagesSearchManifest } from '../capabilities/messages.js'

const user: SearchPrincipal = { kind: 'user', id: 'local' }
const agent: SearchPrincipal = { kind: 'agent', id: 'a1', sessionId: 's-here' }
const plugin: SearchPrincipal = { kind: 'plugin', id: 'p1' }

describe('三个主体各走一支', () => {
  it('用户全可见 —— 空范围,fanout 那一侧原样放行', () => {
    expect(sessionScopeVisibility(user)).toEqual({})
  })

  it('插件只见自己产的;今天没有插件产会话文档,所以是**空集**而不是全可见', () => {
    expect(sessionScopeVisibility(plugin)).toEqual({ sessionId: [] })
  })

  it('端口没装 → agent 空集(答不出授权就放行,那不是降级是绕过)', () => {
    expect(getSearchVisibilityPort()).toBeNull()
    expect(sessionScopeVisibility(agent)).toEqual({ sessionId: [] })
  })

  it('端口装上 → 它给的那串会话号', () => {
    const restore = configureSearchVisibilityPort({
      visibleSessionIds: principal => (principal.id === 'a1' ? ['s1', 's2'] : []),
    })
    expect(sessionScopeVisibility(agent)).toEqual({ sessionId: ['s1', 's2'] })
    restore()
    expect(getSearchVisibilityPort()).toBeNull()
  })

  it('还原而不是清空 —— 两份宿主先后起落不互相抹', () => {
    const first = configureSearchVisibilityPort({ visibleSessionIds: () => ['a'] })
    const second = configureSearchVisibilityPort({ visibleSessionIds: () => ['b'] })
    second()
    expect(sessionScopeVisibility(agent)).toEqual({ sessionId: ['a'] })
    first()
  })
})

describe('空集在两侧都是「恒不命中」,不是一个洞', () => {
  it('core 的 matchesFacetFilter:空数组恒假', () => {
    expect(matchesFacetFilter('s1', [])).toBe(false)
    expect(matchesFacetFilter(undefined, [])).toBe(false)
  })

  it('非空清单:在里面就真,不在就假', () => {
    expect(matchesFacetFilter('s1', ['s1', 's2'])).toBe(true)
    expect(matchesFacetFilter('s9', ['s1', 's2'])).toBe(false)
  })
})

describe('两份自述都挂了这条规则', () => {
  it('messages 与 chats 用的是**同一条** —— 一间看不见的房,连房名都不该出现', () => {
    expect(messagesSearchManifest.visibility).toBe(sessionScopeVisibility)
    expect(chatsSearchManifest.visibility).toBe(sessionScopeVisibility)
  })

  it('范围的键是自述里声明过的 facet —— core 只搬,不解释', () => {
    const restore = configureSearchVisibilityPort({ visibleSessionIds: () => ['s1'] })
    const scope = sessionScopeVisibility(agent)
    for (const key of Object.keys(scope)) {
      expect(messagesSearchManifest.facets?.some(facet => facet.key === key)).toBe(true)
      expect(chatsSearchManifest.facets?.some(facet => facet.key === key)).toBe(true)
    }
    restore()
  })
})
