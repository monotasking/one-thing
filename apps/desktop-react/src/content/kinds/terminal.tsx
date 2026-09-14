import { Suspense, lazy } from 'react'
import { registerContentKind } from '../../workbench/kinds'
import { t } from '../../i18n'
import { configureBlockRunPort } from '../blocks/shell/run-port'
import { closeTerminal, peekTerminalSession, requestTerminalFocus } from '../terminal/registry'
import { terminalCwdOf } from '../terminal/terminal-memory'
import { TERMINAL_KIND, terminalRef } from '../terminal/terminal-ref'
import type { ContentRef } from '../../workbench/kinds'

/**
 * **「一格终端」这一种内容**(T1,方案 §2.1-5)。
 *
 * `key` = 终端 id。`singleton: true` —— 同一格 PTY 在屏幕上只该有一份
 * (两份会各自 attach,后一次把前一次的代次顶掉,前那块屏当场停止回执;
 * 与「同一份文件开两棵树对照着看」不是一回事:文件是只读的,终端是一条流)。
 *
 * `level: 'space'`:终端开在项目目录里,而目录属于工作区(方案原话)。
 *
 * ── 标题三档由实例合,这里只读活标题 ────────────────────────────────────
 * OSC 标题 → cwd 末段 → shell 名。合它的是 `TerminalSession.titleOf`,发布它的
 * 是 `TerminalLeaf`(经 `stage/live-title`),而叶檐「活的盖静的」。所以这里的
 * `title` 是**静态那一半**:实例还没建起来(冷启动、还没渲染过)时先写一句
 * 「终端」,活标题一到就被盖掉。判词整段在 `stage/live-title.ts` 的文件头上。
 *
 * ── 关标签 = 杀,不弹确认(方案 §2.1-8)────────────────────────────────
 * 落点是 `dispose(ref)` 而不是 `beforeClose`:`beforeClose` 是**问一句**
 * (脏文件那一档),而这里没有要问的 —— 拍板就是「关 = 杀」。`dead` 那一档
 * 杀不着(PTY 早就不在了),`closeTerminal` 自己吞掉那一次失败并把小账本上
 * 那一笔忘掉,所以这里不分档。
 *
 * ── 叶是**懒加载**的,而这不是性能调优 ────────────────────────────────────
 * `@xterm/xterm` 在 **import 的那一刻**就去 `canvas.getContext`(它的 `Color.ts`
 * 在模块作用域里探一次颜色支持)。这张种类表被 `main.tsx` 与一大票渲染类测试
 * 静态 import,所以静态挂着那条边 = 每一个这样的测试都把 xterm 整只加载一遍、
 * 并在 jsdom 里各喊一声 "Not implemented"。`lazy` 把那条边推到**真的要画一格
 * 终端**的那一刻;`fallback` 是 `null` 而不是骨架 —— 那一瞬间要画的是一块黑屏,
 * 而一块黑屏本来就长这样(禁 spinner 那条的同一个方向)。
 *
 * ── 三张状态表 ──────────────────────────────────────────────────────────
 * 全部由 `TerminalLeaf` 自己说(它的组件头上那三张表)。这一层没有任何自己的
 * 状态:实例住在 `terminal/registry.ts`(模块级,寿命 = 那格 PTY),所以换宿主
 * 不重挂、重挂也不丢屏。
 */

const TerminalLeaf = lazy(() =>
  import('../terminal/TerminalLeaf').then((m) => ({ default: m.TerminalLeaf })),
)

/**
 * **两个产地的裁决:活的优先**(K2 修一轮)。
 *
 * 活的那一份跟着 `cd` 走 —— 人在项目里 `cd packages/core` 之后关掉这一格,⌘⇧T
 * 该回到 `packages/core`,不是回到它出生的目录。建的那一刻记的那一笔
 * (`terminal-memory`)是实例不在了之后唯一还读得到的东西,所以它是**回落**。
 *
 * 抽成纯函数是为了让这个次序**测得到**:两个产地都活在模块级单例里(一个是
 * xterm 那边的实例表、一个是 localStorage),在用例里同时摆出来要把半台终端拖
 * 进 jsdom;而要守的其实只有这一句「谁赢」。
 */
export function pickTerminalCwd(
  live: string | undefined,
  remembered: string | undefined,
): string | undefined {
  return live || remembered || undefined
}

/**
 * **这一格终端此刻在哪个目录**。两处都读不到 = `undefined`(壳这边不编一个
 * `~` 出来,让后端按它自己那条 spawn 规矩落地)。
 */
function cwdOfTerminal(id: string): string | undefined {
  return pickTerminalCwd(peekTerminalSession(id)?.get()?.cwd, terminalCwdOf(id))
}

/**
 * **在这个目录里开一台新 shell,并点名焦点**(`spawn` 与 `restore` 共用的唯一一只)。
 *
 * 「同类再开一格」与「把刚关掉的那一格重开」在这一种上是**同一件事**:都是
 * 「照这个目录再来一台」。共用一只函数,于是两条键不会在某一天悄悄分叉。
 *
 * 创建那一半复用启动瓦拆出来的 `createTerminalTab`(缺 cwd 时由它按自己那条
 * 缺省规矩落地);**动态** import 的理由与 `browser` 那一格逐字相同 —— 这张种类表
 * 被 `main.tsx` 与一大票渲染类测试静态 import,不该挂着启动瓦那整条边。
 */
async function spawnTerminalAt(cwd: string | undefined): Promise<ContentRef> {
  const { createTerminalTab } = await import('../terminal-launcher')
  const id = await createTerminalTab(cwd)
  requestTerminalFocus(id)
  return terminalRef(id)
}

registerContentKind(
  {
    id: TERMINAL_KIND,
    singleton: true,
    level: 'space',
    title: (ref: ContentRef) => {
      const live = peekTerminalSession(ref.key)?.get()
      // cwd 是一条**目录**路径(09-13 路径形);缺席照旧不挂提示。
      return {
        text: live?.title || t('item.terminal'),
        ...(live?.cwd ? { tip: { path: live.cwd, dir: true } } : {}),
      }
    },
    icon: () => 'Terminal',
    render: (ref) => (
      <Suspense fallback={null}>
        <TerminalLeaf id={ref.key} />
      </Suspense>
    ),
    /*
     * **激活这一格 = 键盘进这块屏幕**(与 `dir` 那一格同一条自述)。不声明的话
     * `focusIntoRef` 只能退回 `leaf` 那一层,而那是 `passThrough` —— 能不能穿
     * 进来要看这一刻这块面登记好了没有。对终端来说这不是小事:点开一格终端
     * 第一件想做的事就是打字。
     */
    focusInto: 'terminal',
    fullable: true,
    /*
     * **同类再开一格 = 在同一个目录里再开一台 shell**(K2,⌘T / ⌘N)。
     *
     * cwd 跟着**开它的那一格**走:人在项目目录的终端里按 ⌘T,想要的是第二台在
     * 同一个目录里的 shell(iTerm / VS Code 同此)。读不到那一格的 cwd(实例还
     * 没建起来)就**不给**,由 `createTerminalTab` 回落到当前会话那个工作目录 ——
     * 判词在它头上,壳这边不编一个 `~` 出来。
     *
     * **只创建不摆放**,焦点在这儿点名(`requestTerminalFocus`,那一格挂载时
     * 自己取走)。创建那一半复用启动瓦拆出来的 `createTerminalTab`,**动态**
     * import 的理由与 `browser` 那一格逐字相同。
     */
    spawn: async (ref) => spawnTerminalAt(cwdOfTerminal(ref.key)),
    /*
     * **关一格终端 = 杀 PTY,所以 ⌘⇧T 拿回来的必须是一台新 shell**(K2 修一轮)。
     *
     * 缺省那一档(影 = ref 自己)在这一种上是错的:那个 id 背后的 PTY 已经没了,
     * 重开只会把一格「已退出」的死壳摆回屏幕上 —— 那不是「重开」,是把尸体捡回来。
     * 所以这一种自述快照,而**影里装的是那台 shell 的身份中真正可复现的那一半**:
     * 它在哪个目录开着。
     *
     * cwd 两个产地,**活的优先**:实例还在时读它自己的 `cwd`(它跟着 `cd` 走,
     * 人关掉的那一刻在哪就是哪),读不到才回落到建的那一刻记的那一笔
     * (`terminal-memory`)。次序不能反——反了的话在项目里 `cd` 过的那格终端
     * 会被重开回它出生的目录。
     *
     * 两个产地此刻**都还读得到**,因为「关之前先留影」排在 `dispose` 之前
     * (判词在 `workbench/store.closeTab` 上);读不到就交 `{}`,让
     * `createTerminalTab` 按它自己那条缺省规矩落地(当前会话的工作目录)。
     */
    snapshot: (ref) => {
      const cwd = cwdOfTerminal(ref.key)
      return cwd ? { cwd } : {}
    },
    restore: async (snapshot) => {
      const shot = snapshot as { cwd?: unknown } | null
      return spawnTerminalAt(typeof shot?.cwd === 'string' ? shot.cwd : undefined)
    },
    dispose: (ref) => closeTerminal(ref.key),
  },
  import.meta.hot,
)

/**
 * **代码块那颗「运行」的执行器,装在这里**(2026-09-14)。
 *
 * 装配点选这只文件,是因为「这台壳画得出终端」与「这台壳跑得了脚本」是**同一个
 * 事实**:种类表上有 `terminal` 这一行,就说明宿主接得住 PTY。块层那一侧因此
 * 什么都不必知道 —— 没人装这一口,檐上就没有那颗钮(判词在 `blocks/shell/run-port.ts`)。
 *
 * **动态** import 的理由与上面 `spawnTerminalAt` 那段逐字相同:这张种类表被
 * `main.tsx` 与一大票渲染类测试静态 import,不该挂着启动瓦那整条边
 * (`run-script.ts` 静态吃 `terminal-launcher`,而那只文件在模块作用域里登记启动瓦)。
 *
 * 模块级副作用配 HMR 退役(CLAUDE.md 09-01 立法),摘的口就是这一口本身。
 */
configureBlockRunPort({
  run: (request) => import('../terminal/run-script').then((m) => m.runScriptInTerminal(request)),
})

import.meta.hot?.dispose(() => configureBlockRunPort(undefined))
