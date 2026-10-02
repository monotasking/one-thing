import { describe, expect, it } from 'vitest'
import {
  createMemberToken,
  createPageToken,
  expandFileTokens,
  extractMemberTokens,
  extractPageTokens,
} from '../prompt-references.js'

describe('page reference tokens', () => {
  const tabs: Record<string, { url: string; title: string }> = {
    'tab-1': { url: 'https://github.com/pull/7', title: 'Example PR' },
    'tab-2': { url: 'https://vuejs.org/guide/', title: 'Vue Guide' },
  }
  const resolve = (tabId: string) => tabs[tabId] ?? null

  it('strips a live token (plus its trailing space) and reports the page', () => {
    const { text, pages } = extractPageTokens(
      `summarize ${createPageToken('tab-1')} please`,
      resolve,
    )
    expect(text).toBe('summarize please')
    expect(pages).toEqual([
      { tabId: 'tab-1', url: 'https://github.com/pull/7', title: 'Example PR' },
    ])
  })

  it('strips tokens whose tab is gone without reporting them', () => {
    const { text, pages } = extractPageTokens(
      `summarize ${createPageToken('tab-9')} please`,
      resolve,
    )
    expect(text).toBe('summarize please')
    expect(pages).toEqual([])
  })

  it('never leaks the URL into the text', () => {
    const { text } = extractPageTokens(createPageToken('tab-1'), resolve)
    expect(text).toBe('')
    expect(text).not.toContain('github.com')
  })

  it('reports a tab once even when mentioned twice', () => {
    const token = createPageToken('tab-1')
    const { text, pages } = extractPageTokens(`${token} vs ${token}`, resolve)
    expect(text).toBe('vs ')
    expect(pages).toHaveLength(1)
  })

  it('handles multiple distinct tabs in order', () => {
    const { pages } = extractPageTokens(
      `${createPageToken('tab-2')} and ${createPageToken('tab-1')}`,
      resolve,
    )
    expect(pages.map(page => page.tabId)).toEqual(['tab-2', 'tab-1'])
  })

  it('leaves file tokens for the file expander untouched', () => {
    const mixed = `read {{file:/repo/a.ts}} and ${createPageToken('tab-1')}`
    const { text } = extractPageTokens(mixed, resolve)
    expect(text).toBe('read {{file:/repo/a.ts}} and ')
    expect(expandFileTokens(text)).toBe('read @/repo/a.ts and ')
  })
})

describe('member reference tokens (W14a 身份 id 化)', () => {
  const members: Record<string, { name: string }> = {
    fe: { name: '小李' },
    pm: { name: '阿明' },
  }
  const resolve = (agentId: string) => members[agentId] ?? null

  it('materializes back INTO the text as @名字 and reports the id', () => {
    const { text, mentions } = extractMemberTokens(
      `${createMemberToken('fe')} 登录页什么时候能好`,
      resolve,
    )
    expect(text).toBe('@小李 登录页什么时候能好')
    expect(mentions).toEqual([{ agentId: 'fe', label: '小李' }])
  })

  it('keeps the separating space the insertion added', () => {
    const { text } = extractMemberTokens(
      `问一下 ${createMemberToken('pm')} 和 ${createMemberToken('fe')}`,
      resolve,
    )
    expect(text).toBe('问一下 @阿明 和 @小李')
  })

  it('reports a member once even when mentioned twice, keeping both in the text', () => {
    const token = createMemberToken('fe')
    const { text, mentions } = extractMemberTokens(`${token} 和 ${token} 都要`, resolve)
    expect(text).toBe('@小李 和 @小李 都要')
    expect(mentions).toEqual([{ agentId: 'fe', label: '小李' }])
  })

  it('drops a dead token (deleted agent) with one trailing space — never a raw token', () => {
    const { text, mentions } = extractMemberTokens(
      `${createMemberToken('ghost')} 在吗`,
      resolve,
    )
    expect(text).toBe('在吗')
    expect(text).not.toContain('{{member:')
    expect(mentions).toEqual([])
  })

  it('paints the CURRENT name — a rename while the draft sat open lands in the text', () => {
    const { text, mentions } = extractMemberTokens(
      createMemberToken('fe'),
      () => ({ name: '李工' }),
    )
    expect(text).toBe('@李工')
    expect(mentions).toEqual([{ agentId: 'fe', label: '李工' }])
  })

  it('leaves page and file tokens to their own expanders', () => {
    const mixed = `${createMemberToken('fe')} 看 {{file:/repo/a.ts}} 和 ${createPageToken('tab-1')}`
    const { text } = extractMemberTokens(mixed, resolve)
    expect(text).toBe('@小李 看 {{file:/repo/a.ts}} 和 {{page:tab-1}}')
  })
})
