import { stageLauncherOf } from './launchers'
import { useStageStore } from './store'

/**
 * **点开一块瓦**(W6-a)—— Dock 与「所有应用」两处共用的唯一一只。
 *
 * 一句判据,**读表不写 if**:这块瓦自述了自己是**启动瓦**(`./launchers.ts`)就
 * 照它说的做,否则走那条老路 `clickDockIcon`(按它自己的打开方式开 / 收)。
 *
 * 它单独一只文件而不是长在 `./launchers.ts` 里,是为了让那张**表**保持零 store
 * 依赖 —— 表是契约,这一只是接线。两处调用点各写一遍 `stageLauncherOf(id) ?? …`
 * 的下场是它们迟早分叉(而分叉的第一处必然是「表上没有这块瓦时怎么办」)。
 */
export function openStageItem(id: string): void {
  const launcher = stageLauncherOf(id)
  if (launcher) {
    launcher.open()
    return
  }
  useStageStore.getState().clickDockIcon(id)
}

/**
 * **召唤一块瓦**(`toggle:<面>` 那族键盘命令的落点)。同一句判据:
 * 启动瓦照它说的做,其余走那条四态召唤(没开就开 / 看不见就露出来 /
 * 看得见没聚焦就只聚焦 / 焦点已在里面就收起来)。
 *
 * ── 启动瓦那一支为什么只有「开」这一半 ────────────────────────────────────
 * 四态判据问的是 `placements[<瓦 id>]` —— 一块**面**此刻在哪。启动瓦开出来的
 * 不是那块面,是一格内容(目录那块瓦 → `files-root:<路径>`),它住在拼贴树里,
 * 形态机那张表上根本没有它的名字。所以这条路今天只兑现「开 / 前置」那一半,
 * **收起来那一半按 Esc 或那块面自己的 ✕**。留账在交卷报里(W6-c 谈:
 * 召唤要不要认得「一族内容」)。
 */
export function summonStageItem(id: string): void {
  const launcher = stageLauncherOf(id)
  if (launcher) {
    launcher.open()
    return
  }
  useStageStore.getState().summonItem(id)
}
