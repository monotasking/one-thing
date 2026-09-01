import { afterEach, describe, expect, it, vi } from 'vitest'

/**
 * **回滚口本身也要有反证**(R2 那批交的学费:档位跨门存活,门自己浑然不觉)。
 *
 * 三格:默认开 / 显式 `off` 关 / 读不到存储(隐私模式、非浏览器宿主)时**开**。
 * 最后一格是有意的:开关的默认值是「新路」,存储坏掉不该把整台悄悄切回旧路。
 */

const KEY = 'onething.blockStream'

async function load(value: string | null | (() => never)) {
  vi.resetModules()
  const getItem = typeof value === 'function' ? value : () => value
  vi.stubGlobal('localStorage', { getItem })
  return (await import('../flag')).BLOCK_STREAM
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.resetModules()
})

describe(`${KEY} 档位`, () => {
  it('没写过 = 开(默认走新路)', async () => {
    expect(await load(null)).toBe(true)
  })

  it('写了 off = 关(回滚口)', async () => {
    expect(await load('off')).toBe(false)
  })

  it('写了别的字 = 开 —— 只有 `off` 这一个词能关', async () => {
    expect(await load('yes')).toBe(true)
  })

  it('读存储抛异常 = 开,不是悄悄切回旧路', async () => {
    expect(
      await load(() => {
        throw new Error('SecurityError')
      }),
    ).toBe(true)
  })
})
