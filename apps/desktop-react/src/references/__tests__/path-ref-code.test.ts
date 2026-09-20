import { describe, expect, it } from 'vitest'
import '..'
import {
  looksLikeDirPath,
  looksLikeFilePath,
  parseCodePathRef,
} from '../kinds/path-ref'
import { resolveReferenceCode } from '../registry'

/**
 * **一格行内码整格是一枚引用吗**(09-20,判词整段在 `kinds/path-ref.ts` 的
 * 「行内码整格是一条路径」一节)。
 *
 * 这只文件量的是那两句纯判据本身,以及注册表把它们接起来之后的答案。渲染那一半
 * (画成 chip / 画成 `<code>`、点了去哪)在 `ref-tag-kinds.test.tsx`。
 */

/** 命中就交出那一枚 `FileRef`,不中答 undefined —— 写成一句,下面逐条读起来是表。 */
function fileOf(text: string): Record<string, unknown> | undefined {
  const hit = resolveReferenceCode(text)
  return hit?.kindId === 'file' ? (hit.value as Record<string, unknown>) : undefined
}

function dirOf(text: string): Record<string, unknown> | undefined {
  const hit = resolveReferenceCode(text)
  return hit?.kindId === 'dir' ? (hit.value as Record<string, unknown>) : undefined
}

describe('① 文件:命中', () => {
  it('中文文件名整条留着', () => {
    expect(fileOf('/Users/me/course/J12-回溯.md')).toEqual({
      kind: 'fileRef',
      path: '/Users/me/course/J12-回溯.md',
    })
  })

  it('`~/` 起笔照认,而且一个字不展(渲染层没有 homedir 这个事实)', () => {
    expect(fileOf('~/proj/a.ts')).toEqual({ kind: 'fileRef', path: '~/proj/a.ts' })
  })

  it.each([
    ['/Users/me/a.ts:12', { line: 12 }],
    ['/Users/me/a.ts:12-30', { line: 12, endLine: 30 }],
    ['/Users/me/a.ts:12:5', { line: 12, col: 5 }],
    ['/Users/me/a.ts#L12', { line: 12 }],
    ['/Users/me/a.ts#L12-L30', { line: 12, endLine: 30 }],
  ])('位置后缀 %s 解成那几格', (text, loc) => {
    expect(fileOf(text)).toEqual({ kind: 'fileRef', path: '/Users/me/a.ts', ...loc })
  })

  it('带了位置就不必有扩展名 —— `/etc/hosts:3` 指的是第 3 行,不可能是目录', () => {
    expect(fileOf('/etc/hosts:3')).toEqual({ kind: 'fileRef', path: '/etc/hosts', line: 3 })
  })

  it('一段也算文件:扩展名够了就不另要段数', () => {
    expect(fileOf('/a.ts')).toEqual({ kind: 'fileRef', path: '/a.ts' })
  })
})

describe('② 文件:不命中(每条挡的是一类假引用)', () => {
  it.each([
    ['/api/files/read', '没有扩展名的路由形 —— 08-19 那条既有裁定'],
    ['/usr/bin', '目录,没有扩展名'],
    ['/v1.0', '`.0` 不含字母,那是版本号不是扩展名'],
    ['/etc/hosts', '无扩展名又没给位置,判不出它是一份文件'],
    ['a/b.ts', '相对路径:首字符就出局'],
    ['/a b.ts', '含空白 —— 认空格就得猜哪个空格是路径的一部分'],
    ['npm run dev', '一句命令,首字符出局'],
    ['/Users/me/x.ts 和别的', '整格不是一条路径,而且不许在码里挖字'],
    ['', '空串'],
    [' /a/b.ts ', '首尾空白是排版,不是路径'],
    ['/Users/me/proj/', '尾斜杠一票否决 —— 那是目录自己说的话'],
  ])('%s 不是文件(%s)', (text) => {
    expect(fileOf(text)).toBeUndefined()
  })
})

describe('③ 目录', () => {
  it.each([
    ['/Users/me/proj/src/'],
    ['~/notes/'],
    ['/tmp/build-out/'],
  ])('%s 是目录', (text) => {
    expect(dirOf(text)).toEqual({ kind: 'dirRef', path: text })
  })

  it.each([
    ['/api/users/', '不从任何一个本机根起笔 —— 那是一条 REST 路由'],
    ['/Users/', '只有根,一段太短'],
    ['/', '连根都算不上'],
    ['/Users/me/proj/src', '没有尾斜杠 = 不是目录(壳没有 stat)'],
  ])('%s 不是目录(%s)', (text) => {
    expect(dirOf(text)).toBeUndefined()
  })
})

describe('④ 两句纯判据本身', () => {
  it('`parseCodePathRef` 只拆形状,不判文件还是目录', () => {
    const hit = parseCodePathRef('/Users/me/proj/')
    expect(hit).toEqual({ path: '/Users/me/proj/' })
    expect(looksLikeFilePath(hit!)).toBe(false)
    expect(looksLikeDirPath(hit!)).toBe(true)
  })

  it('行号写成 0:后缀照剥、行号当没给 —— 它指的还是那份文件', () => {
    expect(parseCodePathRef('/a/b.ts:0')).toEqual({ path: '/a/b.ts' })
    expect(fileOf('/a/b.ts:0')).toEqual({ kind: 'fileRef', path: '/a/b.ts' })
  })

  it('区间反着写当只给了起点 —— 落行只认 `line`', () => {
    expect(parseCodePathRef('/a/b.ts:30-12')).toEqual({ path: '/a/b.ts', line: 30 })
  })

  it('整格就是一个位置(前面没有路径)不成立', () => {
    expect(parseCodePathRef(':12')).toBeNull()
  })
})
