import { describe, expect, it } from 'vitest'
import { buildPickView, pickEntryAt } from '../drawer'
import type { PickInput } from '../drawer'
import type { ReferenceKind } from '../kind'

/**
 * 抽屉那一列怎么装配起来(纯函数)。09-12 之前这批判据钉的是
 * `composer/transitions.groupCommands`;那只函数整件退役了 —— **组就是种类**,
 * 所以「顺序固定 / 每组恰好一次 / 空组不出现 / 扁平序 = 各组顺次相连」四条今天
 * 钉在这里,而「分组只许一次」在结构上已经不可违反(一种引用恰好产出一组)。
 */

/** 一份最小自述:只有拾取那半边,够这一层用。 */
function kindWith(id: string, group?: { key: string; always?: boolean }): ReferenceKind {
  return {
    id,
    source: {
      trigger: '/',
      group: group as never,
      hint: 'composer.hintCommand',
      useQuery: () => ({ hits: [], status: 'ready' }),
      row: (hit: unknown) => ({ primary: String(hit) }),
    },
  }
}

function input(id: string, hits: string[], status: 'idle' | 'loading' | 'ready' | 'error' = 'ready', group?: { key: string; always?: boolean }): PickInput {
  return { kind: kindWith(id, group ?? { key: `head.${id}` }), result: { hits, status } }
}

describe('装配:组就是种类', () => {
  it('顺序就是交进来的顺序(= 登记序);每一组恰好出现一次', () => {
    const view = buildPickView([input('command', ['/new']), input('skill', ['/skill:a']), input('plugin', ['/note'])])
    expect(view.groups.map((g) => g.kindId)).toEqual(['command', 'skill', 'plugin'])
    expect(view.total).toBe(3)
  })

  it('空组不出现(「只当那组非空时画」落在这里,不落在渲染层)', () => {
    const view = buildPickView([input('command', ['/new']), input('skill', []), input('plugin', [])])
    expect(view.groups.map((g) => g.kindId)).toEqual(['command'])
  })

  it('自述 `always` 的那一组空着也画组头 —— 它是那个触发字符下唯一的一组', () => {
    const view = buildPickView([input('file', [], 'ready', { key: 'composer.headFiles', always: true })])
    expect(view.groups.map((g) => g.kindId)).toEqual(['file'])
    expect(view.groups[0].entries).toHaveLength(0)
    expect(view.note).toBe('composer.noMatch')
  })

  it('扁平序 = 各组顺次相连(键盘位与 applyPick 的下标都按它算)', () => {
    const view = buildPickView([input('command', ['/new', '/cd']), input('skill', ['/skill:a'])])
    expect(view.groups.map((g) => g.offset)).toEqual([0, 2])
    expect(pickEntryAt(view, 0)?.entry.hit).toBe('/new')
    expect(pickEntryAt(view, 2)).toEqual({ kindId: 'skill', entry: { row: { primary: '/skill:a' }, hit: '/skill:a' } })
    expect(pickEntryAt(view, 3)).toBeUndefined()
  })
})

describe('四态:那一行说哪句话', () => {
  it('问完了、确实一条都没有 → 「无匹配」', () => {
    expect(buildPickView([input('file', [])]).note).toBe('composer.noMatch')
  })

  it('还在飞 → 「正在找…」(**不是**「无匹配」:那是一句不成立的话)', () => {
    expect(buildPickView([input('file', [], 'loading')]).note).toBe('composer.searching')
    expect(buildPickView([input('file', [], 'idle')]).note).toBe('composer.searching')
  })

  it('这一发失败、手上也没有旧候选 → 一行错误文字', () => {
    expect(buildPickView([input('file', [], 'error')]).note).toBe('composer.searchFailed')
  })

  it('有候选就不说空话;失败与它**并陈**(律②:错误不抹掉旧答案)', () => {
    const view = buildPickView([input('file', ['a.ts'], 'error')])
    expect(view.note).toBeNull()
    expect(view.errorNote).toBe('composer.searchFailed')
  })

  it('有候选且这一发成功:两句都不说', () => {
    const view = buildPickView([input('file', ['a.ts'])])
    expect(view.note).toBeNull()
    expect(view.errorNote).toBeNull()
  })
})
