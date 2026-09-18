import { describe, expect, it } from 'vitest'
import { INSTALL_LOG_LINES, appendInstallLines } from '../music-setup-log'

/**
 * 安装输出那一格小账(2026-09-18)。判的是**一块 chunk 不等于一行**:子进程的管道
 * 按字节切,一行常常被劈成两半 —— 不接着写的话 `added 87 packages` 会在屏上碎成
 * 好几行,而那是安装那一段人唯一读得到的东西。
 */
describe('appendInstallLines', () => {
  it('第一块输出原样进去', () => {
    expect(appendInstallLines([], 'added 87 packages\n')).toEqual(['added 87 packages', ''])
  })

  it('没以换行收尾的那一行,下一块接着写', () => {
    const first = appendInstallLines([], 'added 87 pa')
    expect(first).toEqual(['added 87 pa'])
    expect(appendInstallLines(first, 'ckages in 6s\n')).toEqual(['added 87 packages in 6s', ''])
  })

  it('`\\r` 当换行:进度条原地重画的每一次各占一行,不挤成一行乱码', () => {
    expect(appendInstallLines([], 'downloading 10%\rdownloading 90%\r\ndone')).toEqual([
      'downloading 10%',
      'downloading 90%',
      'done',
    ])
  })

  it('空 chunk 不动那张表(引用都不换)', () => {
    const previous = ['a']
    expect(appendInstallLines(previous, '')).toBe(previous)
  })

  it('封顶之后只留最后那些行 —— 失败的原因常常在末尾', () => {
    const many = Array.from({ length: INSTALL_LOG_LINES + 40 }, (_, i) => `line ${i}`)
    const kept = appendInstallLines(many, '\nnpm ERR! code E404')
    expect(kept).toHaveLength(INSTALL_LOG_LINES)
    expect(kept[kept.length - 1]).toBe('npm ERR! code E404')
    expect(kept[0]).not.toBe('line 0')
  })
})
