import { describe, expect, it } from 'vitest'
import { extractLocalRefs, resolveScratchpadRefPath } from '../scratchpad-refs'

const DIR = '/Users/me/.onething/scratchpads'

describe('extractLocalRefs', () => {
  it('认出 markdown 图片,并标成图片', () => {
    const refs = extractLocalRefs('看这个 ![shot](/Users/me/shot.png) 行不行', DIR)

    expect(refs).toEqual([
      expect.objectContaining({
        absolutePath: '/Users/me/shot.png',
        fileName: 'shot.png',
        mimeType: 'image/png',
        isImage: true,
      }),
    ])
  })

  it('相对路径以纸所在目录为基准', () => {
    const refs = extractLocalRefs('![](assets/a.jpg)', DIR)

    expect(refs[0].absolutePath).toBe(`${DIR}/assets/a.jpg`)
    expect(refs[0].mimeType).toBe('image/jpeg')
  })

  it('http / data 目标不是本地文件,一律不认', () => {
    const refs = extractLocalRefs(
      '![](https://example.com/a.png) ![](data:image/png;base64,AAA)',
      DIR,
    )

    expect(refs).toEqual([])
  })

  it('`@<绝对路径>` 这一种也算引用', () => {
    const refs = extractLocalRefs('参考 @/Users/me/spec.pdf 里的第 3 节', DIR)

    expect(refs[0]).toMatchObject({
      absolutePath: '/Users/me/spec.pdf',
      mimeType: 'application/pdf',
      isImage: false,
    })
  })

  it('同一个文件写两遍只出一条', () => {
    const refs = extractLocalRefs('![](/a/x.png) 又是 ![again](/a/x.png)', DIR)

    expect(refs).toHaveLength(1)
  })

  it('不认识的扩展名不当图片', () => {
    const refs = extractLocalRefs('![](/a/thing.bin)', DIR)

    expect(refs[0]).toMatchObject({ isImage: false, mimeType: 'application/octet-stream' })
  })

  it('空正文没有引用', () => {
    expect(extractLocalRefs('', DIR)).toEqual([])
  })
})

describe('resolveScratchpadRefPath', () => {
  it('绝对路径原样返回', () => {
    expect(resolveScratchpadRefPath('/abs/a.png', DIR)).toBe('/abs/a.png')
  })

  it('`..` 退一级', () => {
    expect(resolveScratchpadRefPath('../images/a.png', DIR))
      .toBe('/Users/me/.onething/images/a.png')
  })

  it('没有基准目录时原样返回 —— 猜一个基准比不解析更糟', () => {
    expect(resolveScratchpadRefPath('a.png', '')).toBe('a.png')
  })
})
