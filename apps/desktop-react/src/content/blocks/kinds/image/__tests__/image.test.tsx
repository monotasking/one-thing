import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { BlockView } from '../../../BlockView'
import type { BlockCtx } from '../../../registry'
import { blockSourceText } from '../../../shell/source'
import { resetRemotePolicyForTest } from '../../../asset/remote-policy'
import { resetAssetDimensionsForTest, knownSize } from '../../../asset/dimensions'
import { useStageStore } from '../../../../../stage/store'
import { focusTree } from '../../../../../focus/registry'
import { MarkdownCanvas } from '../../../../viewer/kinds/markdown'
import { configureMediaImagePort, resetMediaImageCacheForTest } from '../../../../../data/media-image'

/**
 * 图片块上屏 —— 六种状态里在 jsdom 里证得出的那几种。
 *
 * jsdom 不加载图片(`<img>` 的 load / error 永远不会自己来),所以这里**手发**那两个
 * 事件:`onLoad` / `onError` 之后组件做什么是我们的代码,图片到底取不取得到是浏览器
 * 的事 —— 后一半的验收在真机上,不在这里假装(与 figure 把 mermaid mock 到边界上
 * 同一条判词)。
 */

const ctx: BlockCtx = { messageId: 'm1', streaming: false }
const withBase: BlockCtx = { ...ctx, baseDir: '/notes' }

beforeEach(() => {
  useStageStore.setState({ locale: 'zh' })
  resetRemotePolicyForTest()
  resetAssetDimensionsForTest()
  focusTree.reset()
})

const draw = (url: string, alt = '', c: BlockCtx = withBase, title?: string) =>
  render(<BlockView block={{ kind: 'image', ref: { kind: 'url', url }, alt, title }} ctx={c} />)

describe('gated:远程图先问人', () => {
  it('画的是占位卡 —— 有「加载图片」钮、有宿主名,而且**没挂 `<img>`**', () => {
    draw('https://example.com/a.png', '一张图')
    expect(screen.getByRole('button', { name: '加载图片' })).toBeTruthy()
    expect(screen.getByText('来自 example.com 的图片')).toBeTruthy()
    expect(screen.getByText('一张图')).toBeTruthy()
    expect(screen.queryByTestId('block-image')).toBeNull()
  })

  it('点了就放行这个宿主,当场转 loading(img 挂上、data-state=loading)', () => {
    draw('https://example.com/a.png')
    fireEvent.click(screen.getByRole('button', { name: '加载图片' }))
    const img = screen.getByTestId('block-image')
    expect(img.getAttribute('data-state')).toBe('loading')
    expect(img.getAttribute('src')).toBe('https://example.com/a.png')
  })
})

describe('unresolvable:诚实态,不挂 img', () => {
  it('相对路径 + 没有文档位置 → 说清原因并显出**作者写的那个地址**', () => {
    draw('img/a.png', '', ctx)
    expect(screen.getByText('相对路径,这里没有文档位置')).toBeTruthy()
    expect(screen.getByText('img/a.png')).toBeTruthy()
    expect(screen.queryByTestId('block-image')).toBeNull()
  })

  it('不支持的 scheme 同一个形', () => {
    draw('javascript:alert(1)')
    // 诚实行里显出地址;檐上那格 meta 对这种地址**什么都不说**(编不出来源就不编)。
    expect(screen.getByRole('note').textContent).toContain('不支持的地址')
    expect(screen.getByRole('note').textContent).toContain('javascript:alert(1)')
    expect(screen.queryByText('javascript:alert(1)', { selector: 'header *' })).toBeNull()
    expect(screen.queryByTestId('block-image')).toBeNull()
  })
})

describe('loading → ready / error', () => {
  it('第一次见这张图:占位盒按最小高那一档(blank),img 已挂', () => {
    draw('a.png')
    expect(screen.getByTestId('block-image-frame').getAttribute('data-reserve')).toBe('blank')
    expect(screen.getByTestId('block-image').getAttribute('data-state')).toBe('loading')
  })

  it('onLoad 写尺寸表 + 转 ready,占位那一格整个撤掉', () => {
    draw('a.png')
    const img = screen.getByTestId('block-image')
    Object.defineProperty(img, 'naturalWidth', { value: 800, configurable: true })
    Object.defineProperty(img, 'naturalHeight', { value: 400, configurable: true })
    fireEvent.load(img)
    expect(knownSize('file:///notes/a.png')).toEqual({ w: 800, h: 400 })
    expect(screen.getByTestId('block-image').getAttribute('data-state')).toBe('ready')
    expect(screen.getByTestId('block-image-frame').getAttribute('data-reserve')).toBeNull()
  })

  it('**再挂一次:占位盒带 aspect-ratio** —— 第二次起零位移正是尺寸表的全部理由', () => {
    const first = draw('a.png')
    const img = screen.getByTestId('block-image')
    Object.defineProperty(img, 'naturalWidth', { value: 800, configurable: true })
    Object.defineProperty(img, 'naturalHeight', { value: 400, configurable: true })
    fireEvent.load(img)
    first.unmount()

    draw('a.png')
    const frame = screen.getByTestId('block-image-frame')
    expect(frame.getAttribute('data-reserve')).toBe('sized')
    expect(frame.style.getPropertyValue('--img-ratio')).toBe('800 / 400')
    expect(frame.style.getPropertyValue('--img-w')).toBe('800px')
  })

  it('onError → 诚实行「这张图没加载出来」+ 地址,img 撤掉', () => {
    draw('a.png', '替代文字')
    fireEvent.error(screen.getByTestId('block-image'))
    // 地址在檐上(meta)与诚实行里各出现一次 —— 这里问的是诚实行那一处。
    const line = screen.getByRole('note').textContent ?? ''
    expect(line).toContain('这张图没加载出来')
    expect(line).toContain('a.png')
    expect(line).toContain('替代文字')
    expect(screen.queryByTestId('block-image')).toBeNull()
  })

  it('alt 上到 `<img alt>` —— 图没出来时读屏与浏览器说的是同一句话', () => {
    draw('a.png', '一只猫')
    expect(screen.getByTestId('block-image').getAttribute('alt')).toBe('一只猫')
  })
})

describe('檐与源码', () => {
  it('檐上是身份词 + 来源(远程显宿主,本地显文件名)', () => {
    draw('https://example.com/pics/a.png')
    expect(screen.getByText('image')).toBeTruthy()
    expect(screen.getByText('example.com')).toBeTruthy()
  })

  it('本地图的 meta 是文件名', () => {
    draw('../img/cat.png')
    expect(screen.getByText('cat.png')).toBeTruthy()
  })

  it('「查看源码」重组回作者写的那一行,不是一段 JSON', () => {
    expect(blockSourceText({ kind: 'image', ref: { kind: 'url', url: 'a.png' }, alt: 'x' })).toBe(
      '![x](a.png)',
    )
    expect(
      blockSourceText({ kind: 'image', ref: { kind: 'url', url: 'a.png' }, alt: 'x', title: '题' }),
    ).toBe('![x](a.png "题")')
  })
})

/**
 * **查看器传 baseDir**(正本 §2 最后一格)。
 *
 * 单独一条,因为这是整条链上唯一一处「谁知道这份文档在哪儿」—— 块自己永远不知道,
 * 解析层也不知道。少了这一格,Obsidian 笔记里那 183 个相对路径全落 no-base 诚实态,
 * 而且屏幕上看起来只是「图没出来」,没有任何一处会报错。
 */
describe('查看器把文档位置递进来', () => {
  it('相对路径按**这份文件所在的目录**解开', () => {
    render(<MarkdownCanvas path="/vault/10 Notes/a.md" source="![](../img/cat.png)" />)
    expect(screen.getByTestId('block-image').getAttribute('src')).toBe('file:///vault/img/cat.png')
  })

  it('反过来说:同一段 markdown 在聊天里(没有文档位置)落诚实态', () => {
    render(<BlockView block={{ kind: 'image', ref: { kind: 'url', url: '../img/cat.png' }, alt: '' }} ctx={ctx} />)
    expect(screen.getByText('相对路径,这里没有文档位置')).toBeTruthy()
  })
})

/**
 * **媒体库图**(G 线 P5-a,正本 `docs/stream-geometry-2026-09.md` §23)。生图流写进账本的是
 * `![Generated Image|mediaId:<id>](media://<id>.png)`;字节经 RPC `media.readFile` 取。
 * 端口在这里换成假的:RPC 到底取不取得到是后端的事(`resolve-file.test.ts` 与真机门),
 * 这里证的是壳拿到答复之后画什么。
 */
describe('media://:经 RPC 取字节', () => {
  const GENERATED = { kind: 'url', url: 'media://media_1.png' } as const
  const PNG = 'data:image/png;base64,iVBORw0KGgo='
  const drawMedia = (alt = 'Generated Image|mediaId:media_1') =>
    render(<BlockView block={{ kind: 'image', ref: GENERATED, alt }} ctx={ctx} />)

  beforeEach(() => {
    resetMediaImageCacheForTest()
  })

  it('取的路上占位盒在、`<img>` 未挂;取到之后 img 挂上,alt 剥掉 `|mediaId:`,檐上 meta = 文件名', async () => {
    let answer!: (value: { dataUrl: string | null }) => void
    const readFile = vi.fn(() => new Promise<{ dataUrl: string | null }>((resolve) => { answer = resolve }))
    configureMediaImagePort({ readFile })
    drawMedia()
    expect(screen.getByTestId('block-image-frame').getAttribute('data-reserve')).toBe('blank')
    expect(screen.queryByTestId('block-image')).toBeNull()
    await waitFor(() => expect(readFile).toHaveBeenCalledWith('media_1.png'))
    answer({ dataUrl: PNG })
    const img = await screen.findByTestId('block-image')
    expect(img.getAttribute('src')).toBe(PNG)
    expect(img.getAttribute('alt')).toBe('Generated Image')
    expect(screen.getByText('media_1.png')).toBeTruthy()
    // 没有「不支持的地址」那一行 —— 这正是 P5-a 之前屏幕上的样子。
    expect(screen.queryByText('不支持的地址')).toBeNull()
    configureMediaImagePort(undefined)
  })

  it('取不到(null)→「这张图没加载出来」+ 作者写的地址,alt 同样剥标记', async () => {
    configureMediaImagePort({ readFile: async () => ({ dataUrl: null }) })
    drawMedia()
    await waitFor(() => expect(screen.getByRole('note').textContent).toContain('这张图没加载出来'))
    const line = screen.getByRole('note').textContent ?? ''
    expect(line).toContain('media://media_1.png')
    expect(line).toContain('Generated Image')
    expect(line).not.toContain('mediaId:')
    expect(screen.queryByTestId('block-image')).toBeNull()
    configureMediaImagePort(undefined)
  })

  it('尺寸表按 `ref.url` 记(不按几 MB 的 data URL):第二次挂载在字节到之前就占 sized', async () => {
    configureMediaImagePort({ readFile: async () => ({ dataUrl: PNG }) })
    const first = drawMedia()
    const img = await screen.findByTestId('block-image')
    Object.defineProperty(img, 'naturalWidth', { value: 8, configurable: true })
    Object.defineProperty(img, 'naturalHeight', { value: 8, configurable: true })
    fireEvent.load(img)
    expect(knownSize('media://media_1.png')).toEqual({ w: 8, h: 8 })
    expect(knownSize(PNG)).toBeUndefined()
    first.unmount()
    resetMediaImageCacheForTest()

    configureMediaImagePort({ readFile: () => new Promise(() => undefined) })
    drawMedia()
    const frame = screen.getByTestId('block-image-frame')
    expect(frame.getAttribute('data-reserve')).toBe('sized')
    expect(frame.style.getPropertyValue('--img-ratio')).toBe('8 / 8')
    configureMediaImagePort(undefined)
  })

  it('「查看源码」仍是引擎写的原行 —— 机器标记只在显示时剥', () => {
    expect(blockSourceText({ kind: 'image', ref: GENERATED, alt: 'Generated Image|mediaId:media_1' })).toBe(
      '![Generated Image|mediaId:media_1](media://media_1.png)',
    )
  })
})
