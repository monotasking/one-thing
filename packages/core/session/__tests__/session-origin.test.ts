/**
 * **账本产地印章的判据**(§17.7 #2+#1)。
 *
 * 它要回答的问题只有一个:"这本账和本机这个 store 是同一个吗"。所以这里问三件:
 * 指纹是**路径的纯函数**(写侧与 verify 各算各的,必须算出同一个数)、不同 store
 * 分得开、以及三栏的判定(本机 / 外来 / 无印章)。
 */

import { describe, expect, it } from 'vitest'
import {
  classifySessionOrigin,
  sessionOriginFingerprint,
} from '../events/origin.js'

const DESKTOP = '/Users/someone/.onething'
const SERVER = '/srv/onething-store'
const FIXTURE = '/var/folders/2m/T/onething-shadow-battery-abc123'

describe('产地印章 —— 指纹', () => {
  it('是路径的纯函数:同一个路径算多少次都一样', () => {
    expect(sessionOriginFingerprint(DESKTOP)).toBe(sessionOriginFingerprint(DESKTOP))
  })

  it('四条泳道各算各的,互不相同', () => {
    const stamps = [DESKTOP, SERVER, FIXTURE, `${DESKTOP}-2`].map(sessionOriginFingerprint)
    expect(new Set(stamps).size).toBe(stamps.length)
  })

  it('形状固定:12 位十六进制(账本行里是一个短标签,不是一条路径)', () => {
    for (const path of [DESKTOP, SERVER, FIXTURE, '', '/']) {
      expect(sessionOriginFingerprint(path)).toMatch(/^[0-9a-f]{12}$/)
    }
  })

  it('**不写路径进账本**:指纹里认不出家目录的任何一段', () => {
    const stamp = sessionOriginFingerprint(DESKTOP)
    expect(stamp).not.toContain('someone')
    expect(stamp).not.toContain('onething')
  })
})

describe('产地印章 —— 三栏判定', () => {
  const local = sessionOriginFingerprint(DESKTOP)

  it('印章对得上 = 本机产物', () => {
    expect(classifySessionOrigin({ store: local }, local)).toBe('local')
  })

  it('印章指向别的 store = 外来(跑错 store 的进程 / 拷进来的夹具)', () => {
    expect(classifySessionOrigin({ store: sessionOriginFingerprint(FIXTURE) }, local)).toBe('foreign')
    // vitest 写下的那种同样是外来 —— `host` 只是给人看的补充,判据仍是指纹。
    expect(
      classifySessionOrigin({ store: sessionOriginFingerprint(FIXTURE), host: 'test' }, local),
    ).toBe('foreign')
  })

  it('没有印章 = 存量账,**不猜**它是谁的(纪律 9:成对交付)', () => {
    expect(classifySessionOrigin(undefined, local)).toBe('unstamped')
    // 半成品同理:有这一格但值是空的,说明不了任何事。
    expect(classifySessionOrigin({ store: '' }, local)).toBe('unstamped')
  })
})
