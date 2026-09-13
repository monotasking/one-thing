import { describe, expect, it } from 'vitest'
import {
  contentKindOf,
  focusIntoScopeOf,
  isCompanionRef,
  isKnownContent,
  isSingletonContent,
  parseRefId,
  refId,
  residencyLevelOf,
} from '../../../workbench/kinds'
import { CHANGE_KIND, changePartsOf, changePathOf, changeRef, changeRootOf } from '../change-ref'
import '../index'

/**
 * **`change` 那一种内容的自述 + 它那格 key 的往返**(批⑤,正本
 * `apps/desktop-react/docs/changes-file-view-2026-09.md` §6.3 第一条)。
 *
 * 这一组只问「表上那几格写的是什么」与「key 拼得回来吗」—— 那块正文长什么样归
 * `content/__tests__/changes-panel.test.tsx`。
 *
 * **反证**(逐条真跑过):
 *  · `changeRef` 里那两句转义拆掉 → 「路径里带 `|`」那一条当场红;
 *  · `change.tsx` 的 `focusInto` 拿掉 → ④ 红(而且真机上 ↵ 之后焦点留在列里);
 *  · 给它补一格 `companion: {}` → ⑤ 红(它会跟着切会话被收走)。
 */

const ROOT = '/Users/dev/code/start-electron'
const PATH = 'apps/desktop-react/src/content/changes/ChangeList.tsx'

describe('`change` 那一种内容的自述', () => {
  it('① 它在表上', () => {
    expect(contentKindOf(CHANGE_KIND)).toBeDefined()
  })

  it('② **不是单例** —— 同一个文件的改动可以在两片叶里各开一格', () => {
    expect(isSingletonContent(changeRef(ROOT, PATH))).toBe(false)
  })

  it('③ 标题 = 文件名,tip = 路径形的全路径', () => {
    const title = contentKindOf(CHANGE_KIND)!.title(changeRef(ROOT, PATH))
    expect(title.text).toBe('ChangeList.tsx')
    expect(title.tip).toEqual({ path: `${ROOT}/${PATH}` })
  })

  it('③ 图标按**文件**认(`tabIconOf`),不是「改动」那一枚', () => {
    // 同一个文件的 `file:` 与 `change:` 两格图标逐字相同 —— 标签上认的是这个文件。
    const icon = contentKindOf(CHANGE_KIND)!.icon(changeRef(ROOT, PATH))
    expect(icon).toBe(contentKindOf('file')!.icon({ kind: 'file', key: `${ROOT}/${PATH}` }))
  })

  it('④ 激活它 = 焦点进 `diff` 那格作用域', () => {
    expect(focusIntoScopeOf(changeRef(ROOT, PATH))).toBe('diff')
  })

  it('⑤ **不是伴随面** —— 它与 `file` 同一档:人开出来的一格,不跟着会话收放', () => {
    expect(isCompanionRef(changeRef(ROOT, PATH))).toBe(false)
  })

  it('⑥ 记在**工作区**那本账上(与全部内容同一档)', () => {
    expect(residencyLevelOf(changeRef(ROOT, PATH))).toBe('space')
  })

  it('⑦ `exists` 只剔**拆不出两段**的 key(存量档案 / 被截断的那一格)', () => {
    expect(isKnownContent(changeRef(ROOT, PATH))).toBe(true)
    expect(isKnownContent({ kind: CHANGE_KIND, key: 'no-separator' })).toBe(false)
    expect(isKnownContent({ kind: CHANGE_KIND, key: `${ROOT}|` })).toBe(false)
    expect(isKnownContent({ kind: CHANGE_KIND, key: `|${PATH}` })).toBe(false)
  })
})

describe('`change-ref` 那格 key:往返不失真', () => {
  it('造与反问是互逆的', () => {
    const ref = changeRef(ROOT, PATH)
    expect(changeRootOf(ref)).toBe(ROOT)
    expect(changePathOf(ref)).toBe(PATH)
    expect(changePartsOf(ref)).toEqual({ root: ROOT, path: PATH })
  })

  it('**经 `refId → parseRefId` 一个来回,两段逐字不变**(拼贴树落盘走的就是这条路)', () => {
    const ref = changeRef(ROOT, PATH)
    const back = parseRefId(refId(ref))
    expect(back).toEqual(ref)
    expect(changePartsOf(back!)).toEqual({ root: ROOT, path: PATH })
  })

  it('路径里带冒号:`parseRefId` 在**第一个**冒号处切,所以不受影响', () => {
    const weird = 'src/a:b.ts'
    const back = parseRefId(refId(changeRef(ROOT, weird)))
    expect(changePartsOf(back!)).toEqual({ root: ROOT, path: weird })
  })

  it('两段里真有 `|` 也拆得对(unix 路径允许它 —— 所以那一格要转义)', () => {
    const weird = 'src/a|b.ts'
    const root = '/tmp/re|po'
    const back = parseRefId(refId(changeRef(root, weird)))
    expect(changePartsOf(back!)).toEqual({ root, path: weird })
  })

  it('拆不出两段非空 = null(不是空串,不是半个)', () => {
    expect(changePartsOf({ kind: CHANGE_KIND, key: 'nothing' })).toBeNull()
    expect(changePartsOf({ kind: CHANGE_KIND, key: '' })).toBeNull()
    expect(changePartsOf({ kind: 'dir', key: `${ROOT}|${PATH}` })).toBeNull()
  })
})
