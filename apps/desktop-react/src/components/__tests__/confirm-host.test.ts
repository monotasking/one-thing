import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * **`ConfirmHost` 必须挂在壳的根上**(A2 的前提)。
 *
 * ── 为什么这一条值得一道门 ───────────────────────────────────────────────
 * `useConfirm()` 是「一个进程级单槽 hub + 一个挂一次的宿主」那种形状
 * (判词在 `ui/Dialog.tsx` 的 `useConfirm` 上):**宿主不在场时 `ask()` 返回的
 * promise 永远不 resolve** —— 不是抛错、不是答 false,是**那一下什么都不发生**。
 * 于是「会话删除」这条路的坏法是最难看的一种:点「删除…」、菜单关掉、
 * 屏幕上没有任何东西,而一格悬着的 promise 留在内存里。
 *
 * A2 的派工单说它「今天只在测试里挂着」,核下来**不是**:W6-a(`a8e76ae2`)
 * 给工作区删除那一问把它挂进了 `components/AppShell.tsx`,与 `ToastHost` /
 * `ViewerCloseHost` 同层。所以 A2 没有「把宿主挂进壳」这一步 —— 这一条钉的是
 * **它别再走掉**:删掉那一行,会话删除与工作区删除两条路同时静默失效,
 * 而两条路各自的用例都自带宿主(上面那种坏法在单测里看不见)。
 *
 * ── 为什么读源码而不是渲染 `AppShell` ───────────────────────────────────
 * 那只组件是整台壳的根:渲染它要一台数据面、一棵拼贴树、一条 SSE、一个宿主层。
 * 而这一条要证的事实只有一句话 ——「那一行在不在」。同一手的先例:
 * `float-window.test.tsx` / `topbar-drag.test.tsx` / `motion-tokens.test.ts`
 * 都读自己那份源文本。
 */
const SHELL = readFileSync(
  path.join(process.cwd(), 'src/components/AppShell.tsx'),
  'utf-8',
)

describe('AppShell:全局单槽宿主都挂着', () => {
  it('`ConfirmHost` 挂在壳上 —— 会话删除那一问的落点(A2)', () => {
    expect(SHELL).toContain('<ConfirmHost />')
    expect(SHELL).toMatch(/import \{ ConfirmHost \} from '\.\.\/ui\/Dialog'/)
  })

  it('与它同层那两只也在(同一族:一问一答要活过发起它的那块面)', () => {
    // 少了任何一只,对应那条路都是**静默**失效而不是报错 —— 所以三只一起钉。
    expect(SHELL).toContain('<ViewerCloseHost />')
    expect(SHELL).toContain('<ToastHost')
  })
})
