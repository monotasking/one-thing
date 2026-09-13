import { beforeEach, describe, expect, it } from 'vitest'
import { resolveAssetRef } from '../resolve'
import { allowHost, isHostAllowed, resetRemotePolicyForTest, REMOTE_ASSET_POLICY } from '../remote-policy'
import { knownSize, rememberSize, resetAssetDimensionsForTest } from '../dimensions'

/**
 * 资产层三件的单测 —— 全是纯函数,jsdom 都不用起。
 *
 * 这一组守的是**政策只有一处**:scheme 白名单、远程放行、相对路径怎么解,三件都在
 * `blocks/asset/` 里,图片组件一个字都不判。将来加 video 块时这一整组照旧成立 ——
 * 那正是「加功能不改骨架」的判据(正本 §5 的演练)。
 */

const url = (u: string) => ({ kind: 'url', url: u }) as const

beforeEach(() => {
  resetRemotePolicyForTest()
  resetAssetDimensionsForTest()
})

describe('scheme 分派', () => {
  it('data: 原样 ready —— 字节就在地址里', () => {
    expect(resolveAssetRef(url('data:image/png;base64,AAAA'), {})).toEqual({
      status: 'ready',
      src: 'data:image/png;base64,AAAA',
    })
  })

  it('file: 原样 ready(取不取得到是宿主的事实,不是解析的事)', () => {
    expect(resolveAssetRef(url('file:///a/b.png'), {})).toEqual({ status: 'ready', src: 'file:///a/b.png' })
  })

  it('`/绝对路径` → file:// URL,逐段编码(空格不会把地址截断)', () => {
    expect(resolveAssetRef(url('/uploads/a b.png'), {})).toEqual({
      status: 'ready',
      src: 'file:///uploads/a%20b.png',
    })
    // 作者按 CommonMark 写成 `%20` 的,先解再编 —— 不解会编成 `%2520`,一个不存在的目录。
    expect(resolveAssetRef(url('/Users/x/91%20Attachments/a.png'), {})).toEqual({
      status: 'ready',
      src: 'file:///Users/x/91%20Attachments/a.png',
    })
  })

  it('http(s) 默认 gated,带出宿主名', () => {
    expect(resolveAssetRef(url('https://example.com/a.png'), {})).toEqual({
      status: 'gated',
      host: 'example.com',
    })
  })

  it('**白名单之外的 scheme 一律拒**(§六 11:`javascript:` 不该有第二种下场)', () => {
    expect(resolveAssetRef(url('javascript:alert(1)'), { baseDir: '/base' })).toEqual({
      status: 'unresolvable',
      reason: 'scheme',
    })
    expect(resolveAssetRef(url('blob:http://x/y'), {})).toMatchObject({ reason: 'scheme' })
  })

  it('说不出宿主的 http 地址也拒 —— 按宿主放行的前提是有个宿主', () => {
    expect(resolveAssetRef(url('http://'), {})).toMatchObject({ status: 'unresolvable', reason: 'scheme' })
  })
})

describe('相对路径:解得开的前提是知道相对谁', () => {
  it('有 baseDir → 归一 `..` 之后拼成 file:// URL', () => {
    expect(resolveAssetRef(url('../img/a.png'), { baseDir: '/notes/daily' })).toEqual({
      status: 'ready',
      src: 'file:///notes/img/a.png',
    })
  })

  it('**`%20` 先解码再拼** —— 文件系统里那个目录叫「91 Attachments」', () => {
    expect(resolveAssetRef(url('../../91%20Attachments/x.png'), { baseDir: '/v/10 Notes/a' })).toEqual({
      status: 'ready',
      // 解码一次、`fileUrlOf` 编码一次 —— 不是 `91%2520Attachments` 那个不存在的目录。
      src: 'file:///v/91%20Attachments/x.png',
    })
  })

  it('解不开的百分号序列原样用,不抛(一整块内容不该为一个坏名字炸掉)', () => {
    expect(resolveAssetRef(url('a%zz.png'), { baseDir: '/b' })).toEqual({
      status: 'ready',
      src: 'file:///b/a%25zz.png',
    })
  })

  it('没有 baseDir → no-base(聊天今天就是这一档,不拿页面 URL 去拼)', () => {
    expect(resolveAssetRef(url('img/a.png'), {})).toEqual({ status: 'unresolvable', reason: 'no-base' })
  })

  it('路径里带冒号不算 scheme —— `./a:b.png` 仍是相对路径', () => {
    expect(resolveAssetRef(url('./a:b.png'), { baseDir: '/b' })).toMatchObject({ status: 'ready' })
  })
})

describe('远程放行表', () => {
  it('出厂是 gate 档 —— 翻它就是改那一行常量', () => {
    expect(REMOTE_ASSET_POLICY).toBe('gate')
  })

  it('gated → allowHost → 同宿主全部 ready(按宿主放行,不是按图)', () => {
    expect(resolveAssetRef(url('https://cdn.x.com/1.png'), {})).toMatchObject({ status: 'gated' })
    allowHost('cdn.x.com')
    expect(isHostAllowed('cdn.x.com')).toBe(true)
    expect(resolveAssetRef(url('https://cdn.x.com/1.png'), {})).toEqual({
      status: 'ready',
      src: 'https://cdn.x.com/1.png',
    })
    // 同一次运行里的第二张图不再问人。
    expect(resolveAssetRef(url('https://cdn.x.com/2.png'), {})).toMatchObject({ status: 'ready' })
    // 别的宿主一个都没跟着放行。
    expect(resolveAssetRef(url('https://other.com/3.png'), {})).toMatchObject({ status: 'gated' })
  })

  it('reset 之后回到默认 —— 用例与热更退役共用这一口', () => {
    allowHost('cdn.x.com')
    resetRemotePolicyForTest()
    expect(isHostAllowed('cdn.x.com')).toBe(false)
  })
})

describe('尺寸表', () => {
  it('记得住 → 下次问得出(第二次起零位移靠的就是它)', () => {
    rememberSize('file:///a.png', 800, 600)
    expect(knownSize('file:///a.png')).toEqual({ w: 800, h: 600 })
  })

  it('**零 / 负数不记** —— 那是「还没量出来」,不是一个尺寸(除它会得到 NaN)', () => {
    rememberSize('file:///b.png', 0, 0)
    expect(knownSize('file:///b.png')).toBeUndefined()
  })

  it('没记过的问出 undefined,不抛', () => {
    expect(knownSize('file:///never.png')).toBeUndefined()
  })
})
