import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { installTerminalReloadDetach } from '../terminal-reload'
import type { NavigationDetails } from '../terminal-reload'

/**
 * **重载 detach 那一段接线**(T2)。
 *
 * 三条判据各一例(主框架 / 非同文档 / 非首次),外加**接线还在**那一条 ——
 * 最后那一条是本单反证的落点:派工单要的是「`markAllTerminalsDetached` 调用
 * 拆掉 → 断言红」,而那次调用住在 `main.ts` 里。`main.ts` 在 import 的那一刻
 * 就 `app.whenReady()`、注册 IPC、开窗,拿不进 vitest;所以这里读它的**源文本**
 * 问一句「那一行还在不在」。
 *
 * 源文本断言是**下策,用在这里是有意的**:它只钉一件「有没有接上」的事实,
 * 不钉任何行为(行为由上面三条钉),而它换来的是这条接线有一个会红的地方。
 */

const mainSource = readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), '../main.ts'),
  'utf-8',
)

function emitterSpy() {
  const listeners: ((details: NavigationDetails) => void)[] = []
  return {
    listeners,
    on: (_event: 'did-start-navigation', cb: (details: NavigationDetails) => void) => {
      listeners.push(cb)
    },
    off: (_event: 'did-start-navigation', cb: (details: NavigationDetails) => void) => {
      const at = listeners.indexOf(cb)
      if (at >= 0) listeners.splice(at, 1)
    },
    fire: (details: NavigationDetails) => {
      for (const cb of [...listeners]) cb(details)
    },
  }
}

const MAIN_FRAME: NavigationDetails = { isMainFrame: true, isSameDocument: false }

describe('installTerminalReloadDetach', () => {
  it('第一次导航(开窗那一发)不 detach,第二次才 detach', () => {
    const contents = emitterSpy()
    let calls = 0
    installTerminalReloadDetach(contents, () => {
      calls += 1
    })
    contents.fire(MAIN_FRAME)
    expect(calls).toBe(0)
    contents.fire(MAIN_FRAME)
    expect(calls).toBe(1)
    contents.fire(MAIN_FRAME)
    expect(calls).toBe(2)
  })

  it('子框架与同文档导航一格都不算(连「第一次」都不占)', () => {
    const contents = emitterSpy()
    let calls = 0
    installTerminalReloadDetach(contents, () => {
      calls += 1
    })
    contents.fire({ isMainFrame: false, isSameDocument: false })
    contents.fire({ isMainFrame: true, isSameDocument: true })
    // 上面两发都被判据挡掉,所以这一发仍旧是「第一次」。
    contents.fire(MAIN_FRAME)
    expect(calls).toBe(0)
    contents.fire(MAIN_FRAME)
    expect(calls).toBe(1)
  })

  it('摘钩子之后再重载也不 detach', () => {
    const contents = emitterSpy()
    let calls = 0
    const off = installTerminalReloadDetach(contents, () => {
      calls += 1
    })
    contents.fire(MAIN_FRAME)
    off()
    expect(contents.listeners).toHaveLength(0)
    contents.fire(MAIN_FRAME)
    expect(calls).toBe(0)
  })
})

describe('main.ts 上那一行接线', () => {
  it('窗口的 webContents 上真的装了它(拆掉这一行 → 本例红)', () => {
    expect(mainSource).toContain("import { installTerminalReloadDetach } from './terminal-reload.js'")
    expect(mainSource).toContain('installTerminalReloadDetach(window.webContents)')
  })

  it('关窗那条**没有**接(那条路上 PTY 是被真的杀掉的)', () => {
    expect(mainSource).not.toContain('markAllTerminalsDetached')
  })
})
