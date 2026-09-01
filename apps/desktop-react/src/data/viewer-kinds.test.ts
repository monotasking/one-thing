import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  VIEWER_KINDS,
  specOf,
  specOfPath,
  VIEWER_CHUNK_BYTES,
  VIEWER_OVERSIZE_BYTES,
  VIEWER_SKIP_LINES,
  containsNul,
  fileUrlOf,
  isBinaryExtension,
  isImagePath,
  isMarkdownPath,
  isSvgPath,
  resolveViewerKind,
  viewerKindOfPath,
  viewerLangOf,
} from './viewer-kinds'

/**
 * 分型表。一张纯表一组纯函数,所以逐条钉得死 —— 与 `file-icons.test.ts` 同测法。
 */

describe('预判(不用读就知道的那一半)', () => {
  it('图按扩展名认(svg 也算图)', () => {
    expect(viewerKindOfPath('/a/logo.png')).toBe('image')
    expect(viewerKindOfPath('/a/photo.JPEG')).toBe('image')
    expect(viewerKindOfPath('/a/icon.svg')).toBe('image')
    expect(isImagePath('/a/icon.svg')).toBe(true)
    expect(isSvgPath('/a/icon.svg')).toBe(true)
    expect(isSvgPath('/a/logo.png')).toBe(false)
  })

  it('markdown 三种扩展名', () => {
    expect(viewerKindOfPath('/a/README.md')).toBe('markdown')
    expect(viewerKindOfPath('/a/n.markdown')).toBe('markdown')
    expect(viewerKindOfPath('/a/doc.mdx')).toBe('markdown')
    expect(isMarkdownPath('/a/x.ts')).toBe(false)
  })

  it('二进制黑名单比字标那张表宽:归档 / pdf 也在里面', () => {
    expect(isBinaryExtension('/a/app.dylib')).toBe(true)
    expect(isBinaryExtension('/a/pack.zip')).toBe(true)
    expect(isBinaryExtension('/a/paper.pdf')).toBe(true)
    expect(isBinaryExtension('/a/main.ts')).toBe(false)
  })

  /*
   * 09-01(F2:media 从示例档转正)**行为变化,不是回归**:音视频从前同时在
   * binary 黑名单与 media 表里,靠「media 排在前面」压住。现在黑名单里那份副本
   * 删掉了 —— 一份内容在两张表里各写一次,「删掉 media 那一行会怎样」就说不清。
   * 这条断言把新事实钉死,顺便反证那份副本真的没了。
   */
  it('音视频不再落 binary:它们由 media 那一行认领(F2 转正)', () => {
    expect(isBinaryExtension('/a/clip.mp4')).toBe(false)
    expect(isBinaryExtension('/a/song.mp3')).toBe(false)
    expect(viewerKindOfPath('/a/clip.mp4')).toBe('media')
    expect(viewerKindOfPath('/a/song.mp3')).toBe('media')
  })

  it('其余一律 code —— 没有扩展名、认不出的扩展名都算(素文本不是错误)', () => {
    expect(viewerKindOfPath('/a/Makefile')).toBe('code')
    expect(viewerKindOfPath('/a/notes.weird')).toBe('code')
  })
})

describe('定型(读完之后)', () => {
  it('图**不吃体积闸** —— 它的字节从头到尾没被读进来,上限管不着它', () => {
    expect(
      resolveViewerKind({ path: '/a/huge.png', size: VIEWER_OVERSIZE_BYTES * 3 }),
    ).toBe('image')
  })

  it('太大压过二进制:两句话说的不是一件事', () => {
    expect(
      resolveViewerKind({ path: '/a/blob.bin', size: VIEWER_OVERSIZE_BYTES + 1 }),
    ).toBe('oversize')
    expect(resolveViewerKind({ path: '/a/blob.bin', size: 10 })).toBe('binary')
  })

  it('二进制三条判据取并:黑名单 / 后端说的 / NUL 探测', () => {
    expect(resolveViewerKind({ path: '/a/x.exe', size: 1 })).toBe('binary')
    expect(resolveViewerKind({ path: '/a/x.txt', size: 1, isBinary: true })).toBe('binary')
    expect(resolveViewerKind({ path: '/a/x.txt', size: 1, content: 'ELF\u0000\u0001' })).toBe(
      'binary',
    )
  })

  it('扩展名骗人时以实测为准:一个 ELF 叫 .txt 也不按文本画', () => {
    expect(resolveViewerKind({ path: '/a/notes.txt', content: 'hello' })).toBe('code')
    expect(resolveViewerKind({ path: '/a/notes.txt', content: 'h\u0000i' })).toBe('binary')
  })

  it('活到最后才分 markdown 与 code', () => {
    expect(resolveViewerKind({ path: '/a/README.md', size: 10, content: '# hi' })).toBe('markdown')
    expect(resolveViewerKind({ path: '/a/main.ts', size: 10, content: 'x' })).toBe('code')
  })

  it('恰好等于上限**不算**超 —— 闸是「超过」不是「达到」', () => {
    expect(resolveViewerKind({ path: '/a/x.log', size: VIEWER_OVERSIZE_BYTES })).toBe('code')
  })
})

describe('NUL 探测', () => {
  it('只扫开头一段:窗口之外的 NUL 看不见(这是有意的,不是漏)', () => {
    expect(containsNul('a\u0000b')).toBe(true)
    expect(containsNul(`${'x'.repeat(100)}\u0000`, 10)).toBe(false)
    expect(containsNul('没有空字节')).toBe(false)
  })
})

describe('高亮语言:表只有一份', () => {
  it('走的是 files-source 的那张表,不抄第二份', () => {
    expect(viewerLangOf('/a/main.ts')).toBe('typescript')
    expect(viewerLangOf('/a/README.md')).toBe('markdown')
    // 表里没有 = 素文本。**这不是错误**,是这台不认识它。
    expect(viewerLangOf('/a/main.zig')).toBeNull()
  })
})

describe('file:// URL', () => {
  it('逐段编码,分隔的斜杠留着', () => {
    expect(fileUrlOf('/Users/me/a.png')).toBe('file:///Users/me/a.png')
  })

  it('段内的 # 与空格被编码 —— 整条 encodeURI 会把 # 当片段分隔符,名字被截断', () => {
    expect(fileUrlOf('/a/note#1.png')).toBe('file:///a/note%231.png')
    expect(fileUrlOf('/a/my photo.png')).toBe('file:///a/my%20photo.png')
  })
})

describe('常量表', () => {
  it('三个闸的量级关系:一段 < 上限,而行数闸是行不是字节', () => {
    expect(VIEWER_CHUNK_BYTES).toBeLessThan(VIEWER_OVERSIZE_BYTES)
    expect(VIEWER_SKIP_LINES).toBeGreaterThan(0)
  })
})

/* ── 扩展性:加一型只动三处 ────────────────────────────────────────────── */

const here = path.dirname(fileURLToPath(import.meta.url))

/**
 * 09-01 用户定的交卷判据:**加一种文件类型只动三处** ——
 *   ① 这个文件(ViewerFile 联合加一支 + VIEWER_KINDS 加一行);
 *   ② `content/viewer/kinds/<新型>.tsx`(它长什么样);
 *   ③ `content/viewer/kinds/index.ts`(一行 import)。
 * 头、脚、跳转条、键位、落点、状态留存、右键菜单一个字不改。
 *
 * 这一组守的是那条判据里**最容易破**的一半:一旦有人在 `viewer-source` 里
 * 写回一个 `switch (kind)`,第四处就诞生了,而它不会有任何报错。
 */
describe('扩展性:加一型只动三处', () => {
  it('表与联合同宽:每一支 kind 都在表里有一行,反之亦然', () => {
    const kinds = VIEWER_KINDS.map((k) => k.kind)
    expect(new Set(kinds).size).toBe(kinds.length)
    // 联合里的每一支都取得到(取不到 specOf 会抛)。
    for (const kind of kinds) expect(specOf(kind).kind).toBe(kind)
  })

  it('每一行都能从一次读的事实造出自己那一支(build 的返回 kind 与行对齐)', () => {
    for (const spec of VIEWER_KINDS) {
      const made = spec.build({
        path: '/a/x.bin',
        name: 'x.bin',
        content: '',
        size: 0,
        want: 0,
      })
      expect(made.kind).toBe(spec.kind)
      expect(made.path).toBe('/a/x.bin')
    }
  })

  it('`viewer-source` 里没有第四处:它一个具体的型名都不认识', () => {
    /*
     * 判据按**源文本**:那个文件从前有一个七支的 switch(`case 'markdown':` …),
     * 那正是「加一型要动九处」里最容易漏的一处。现在它只调
     * `resolveViewerSpec(...).build(...)`。
     * 唯一允许留下的型名是 `EditableViewerFile` 那一行 —— 它说的是**类型**
     * (哪几支有 content 这一格能写回去),不是分型判断。
     */
    const source = readFileSync(path.join(here, 'viewer-source.ts'), 'utf-8')
    const stripped = source
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '')
      .replace(/export type EditableViewerFile[^\n]*\n/, '')
      .replace(/export function isEditableFile[\s\S]*?\n}\n/, '')
    expect(stripped).not.toMatch(/case '(code|markdown|image|media|binary|oversize|error)'/)
    expect(stripped).toMatch(/resolveViewerSpec\(/)
  })

  it('「不读字节」是表上那一格 `direct`,不是散在代码里的条件', () => {
    expect(VIEWER_KINDS.filter((k) => k.direct).map((k) => k.kind)).toEqual(['image', 'media'])
    // direct 的两型不吃体积闸:一张 40MB 的 png 该画就画。
    expect(resolveViewerKind({ path: '/a/huge.png', size: VIEWER_OVERSIZE_BYTES * 3 })).toBe('image')
    expect(resolveViewerKind({ path: '/a/huge.mp4', size: VIEWER_OVERSIZE_BYTES * 3 })).toBe('media')
    // 不 direct 的照吃。
    expect(resolveViewerKind({ path: '/a/huge.ts', size: VIEWER_OVERSIZE_BYTES * 3 })).toBe('oversize')
  })

  it('specOfPath 认不出扩展名就落兜底那一行(code),不抛也不回 undefined', () => {
    expect(specOfPath('/a/Makefile').kind).toBe('code')
    expect(specOfPath('/a/x.weird').kind).toBe('code')
  })
})
