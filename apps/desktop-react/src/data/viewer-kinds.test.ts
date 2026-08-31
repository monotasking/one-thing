import { describe, expect, it } from 'vitest'
import {
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

  it('二进制黑名单比字标那张表宽:归档 / 音视频 / pdf 也在里面', () => {
    expect(isBinaryExtension('/a/app.dylib')).toBe(true)
    expect(isBinaryExtension('/a/pack.zip')).toBe(true)
    expect(isBinaryExtension('/a/clip.mp4')).toBe(true)
    expect(isBinaryExtension('/a/paper.pdf')).toBe(true)
    expect(isBinaryExtension('/a/main.ts')).toBe(false)
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
    expect(resolveViewerKind({ path: '/a/x.txt', size: 1, content: 'ELF\u0000' })).toBe(
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
