import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import '../../content/kinds/dir'
import '..'
import { makeLeaf } from '../../workbench/tree'
import { presentedByContent, referenceRootOfContent } from '../../workbench/kinds'
import type { ContentRef } from '../../workbench/kinds'
import { referenceKindOf } from '../registry'
import type { PaneNode } from '../../workbench/tree'
import { collectReferenceRoots, isWithinRoot, normalizeRootPath } from '../roots'
import { collectPresented } from '../presented'
import type { ResolvedSegment } from '../segment'

/**
 * `@` 的根表与呈现事实(09-18,正本 `docs/composer-open-dir-mentions-2026-09.md` §2.2 / §2.5.0)。
 *
 * 两只都是纯函数,种类表用假的递进去 —— 所以这里证的是**判据**,不是某一种内容的自述;
 * 自述那一半(dir 那两行)由最后一段的真表用例钉。
 */

const ref = (kind: string, key: string): ContentRef => ({ kind, key })
/** 假的种类表:`box` 这种内容开着时提供一个根、呈现一个资源;别的种类都不答。 */
const rootOf = (r: ContentRef) => (r.kind === 'box' ? r.key : null)
const presentsOf = (r: ContentRef) => (r.kind === 'box' ? `box:${r.key}` : null)

function regions(entries: Record<string, ContentRef[][]>): Record<string, PaneNode> {
  const out: Record<string, PaneNode> = {}
  for (const [region, leaves] of Object.entries(entries)) {
    // 一个区域一片叶就够这组用例用了;多片叶走同一条 `leavesOf`。
    out[region] = makeLeaf(`${region}-leaf`, leaves.flat())
  }
  return out
}

describe('collectReferenceRoots', () => {
  it('工作目录永远第一格,不论它有没有开成面板', () => {
    expect(collectReferenceRoots('/work/', {}, rootOf)).toEqual([{ path: '/work', primary: true }])
    expect(collectReferenceRoots(null, {}, rootOf)).toEqual([])
  })

  it('开着的内容按阅读序进来(中央在边之前),后台标签也算', () => {
    const tree = regions({
      'edge:right': [[ref('box', '/far/right')]],
      center: [[ref('session', 's1'), ref('box', '/far/a'), ref('box', '/far/b')]],
    })
    expect(collectReferenceRoots('/work', tree, rootOf)).toEqual([
      { path: '/work', primary: true },
      { path: '/far/a', primary: false },
      { path: '/far/b', primary: false },
      { path: '/far/right', primary: false },
    ])
  })

  it('被覆盖的丢(工作目录里的子目录、重复开的同一个),包住前面的留', () => {
    const tree = regions({
      center: [[ref('box', '/work/sub'), ref('box', '/far/'), ref('box', '/far'), ref('box', '/')]],
    })
    expect(collectReferenceRoots('/work', tree, rootOf)).toEqual([
      { path: '/work', primary: true },
      { path: '/far', primary: false },
      { path: '/', primary: false },
    ])
  })

  it('不是绝对路径的答案不算根(`~` 由后端展,不在这里猜)', () => {
    expect(collectReferenceRoots(null, regions({ center: [[ref('box', '~/x'), ref('box', '')]] }), rootOf)).toEqual([])
  })

  it('路径判据:尾斜杠归一、前缀要到分隔符为止', () => {
    expect(normalizeRootPath('/a/b//')).toBe('/a/b')
    expect(normalizeRootPath('/')).toBe('/')
    expect(isWithinRoot('/a/bc', '/a/b')).toBe(false)
    expect(isWithinRoot('/a/b/c', '/a/b')).toBe(true)
    expect(isWithinRoot('/anything', '/')).toBe(true)
  })
})

describe('collectPresented', () => {
  const segments: ResolvedSegment[] = [
    { kindId: null, value: { kind: 'text', text: 'look at ' } },
    { kindId: 'thing', value: { id: 'x' } },
    { kindId: 'mute', value: { id: 'y' } },
    { kindId: 'thing', value: { id: 'x' } },
  ]
  const refPresents = (kindId: string, value: unknown) =>
    kindId === 'thing' ? `thing:${(value as { id: string }).id}` : null

  it('引用在前、开着的在后;同一条 uri + via 只出现一次;不答的种类不算', () => {
    const tree = regions({ center: [[ref('box', '/far/a'), ref('box', '/far/a'), ref('session', 's1')]] })
    expect(collectPresented(segments, tree, refPresents, presentsOf)).toEqual([
      { uri: 'thing:x', via: 'reference' },
      { uri: 'box:/far/a', via: 'open' },
    ])
  })

  it('同一个资源既被引用又开着 = 两条事实(它们说的是两件事)', () => {
    const both = (kindId: string) => (kindId === 'thing' ? 'box:/far/a' : null)
    const tree = regions({ center: [[ref('box', '/far/a')]] })
    expect(collectPresented(segments, tree, both, presentsOf)).toEqual([
      { uri: 'box:/far/a', via: 'reference' },
      { uri: 'box:/far/a', via: 'open' },
    ])
  })

  it('什么都没有 = 空表(发送路径据此不带这一格)', () => {
    expect(collectPresented(undefined, {}, refPresents, presentsOf)).toEqual([])
  })
})

describe('真表:目录那两种自述', () => {
  it('开着的目录面板 = 一个根 + 一条呈现;目录引用 = 一条呈现;文件引用不答', () => {
    const panel = ref('dir', '/far/docs')
    expect(referenceRootOfContent(panel)).toBe('/far/docs')
    expect(presentedByContent(panel)).toBe('dir:/far/docs')
    expect(referenceKindOf('dir')?.presents?.({ kind: 'dirRef', path: '/far/docs/' })).toBe('dir:/far/docs')
    expect(referenceKindOf('file')?.presents).toBeUndefined()
  })
})

/**
 * 骨架守卫:两只读表的模块与工作台核心里**不出现任何种类名、任何 scheme**
 * (「加功能不许改骨架」—— 终端哪天也要提供根,改的是终端那一种,不是这里)。
 */
describe('structure', () => {
  const HERE = dirname(fileURLToPath(import.meta.url))
  const codeOf = (relative: string) =>
    readFileSync(resolve(HERE, '..', relative), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .map((line) => line.replace(/(^|[^:])\/\/.*$/, '$1'))
      .join('\n')

  it.each(['roots.ts', 'presented.ts'])('%s 不认识任何一种内容或资源', (file) => {
    const code = codeOf(file)
    for (const word of ["'dir'", '"dir"', 'DIR_KIND', "'terminal'", 'external_directory']) {
      expect(code, `${file} mentions ${word}`).not.toContain(word)
    }
    // scheme 只在字符串字面量开头算(`workdir: string` 里那个 `dir:` 是参数名)。
    expect(code).not.toMatch(/['"`][a-z]+:\//)
  })
})
