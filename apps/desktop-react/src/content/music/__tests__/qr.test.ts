import { describe, expect, it } from 'vitest'
import { QR_QUIET_ZONE, qrMatrix } from '../qr'

/**
 * 二维码那一格的反证(2026-09-18)。
 *
 * 判的是**同一条地址永远编出同一张码**:库里没有随机掩码选择(掩码按规范的罚分
 * 规则算),所以尺寸与黑块数是稳定读数 —— 快照钉住它们,换一版库若把纠错级别或
 * 版本挑法改了,这两个数会当场变。
 */

/** 一条真的网易云登录地址的形状。 */
const URL = 'https://music.163.com/login?codekey=8f3c1d5e-7a20-4b6f-9c11-2de4a8b07f63'

describe('qrMatrix', () => {
  it('固定地址 → 固定的矩阵尺寸与黑块数', () => {
    const matrix = qrMatrix(URL)
    expect({ moduleCount: matrix.moduleCount, darkCount: matrix.darkCount }).toMatchInlineSnapshot(`
      {
        "darkCount": 682,
        "moduleCount": 37,
      }
    `)
    // 编两遍完全一样 —— 屏上那张码不会在重渲时变个样子。
    expect(qrMatrix(URL)).toEqual(matrix)
  })

  it('静区四边各 4 个模块,而且算进 size 里(不是交给 CSS padding)', () => {
    const matrix = qrMatrix(URL)
    expect(QR_QUIET_ZONE).toBe(4)
    expect(matrix.size).toBe(matrix.moduleCount + QR_QUIET_ZONE * 2)
    // 每个黑块一个 `M x y h1v1h-1z` 子路径;最小坐标不小于静区,最大不超出码本身。
    const coords = [...matrix.path.matchAll(/M(\d+) (\d+)/g)].map(([, x, y]) => [Number(x), Number(y)])
    expect(coords).toHaveLength(matrix.darkCount)
    expect(Math.min(...coords.flat())).toBeGreaterThanOrEqual(QR_QUIET_ZONE)
    expect(Math.max(...coords.flat())).toBeLessThan(QR_QUIET_ZONE + matrix.moduleCount)
  })

  it('地址越长版本越高(typeNumber 0 = 自适应,不是钉死一版)', () => {
    expect(qrMatrix('https://a.test').moduleCount).toBeLessThan(qrMatrix(`${URL}${URL}`).moduleCount)
  })
})
