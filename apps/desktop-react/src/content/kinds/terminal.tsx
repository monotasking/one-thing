import { Suspense, lazy } from 'react'
import { registerContentKind } from '../../workbench/kinds'
import { t } from '../../i18n'
import { closeTerminal, peekTerminalSession } from '../terminal/registry'
import { TERMINAL_KIND } from '../terminal/terminal-ref'
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

registerContentKind(
  {
    id: TERMINAL_KIND,
    singleton: true,
    level: 'space',
    title: (ref: ContentRef) => {
      const live = peekTerminalSession(ref.key)?.get()
      return { text: live?.title || t('item.terminal'), tip: live?.cwd }
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
    dispose: (ref) => closeTerminal(ref.key),
  },
  import.meta.hot,
)
