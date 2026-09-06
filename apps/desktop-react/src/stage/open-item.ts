import { stageLauncherOf } from './launchers'
import { useStageStore } from './store'

/**
 * **召唤一块瓦**(W7-p 裁定 6 起,Dock 点击与 `toggle:<面>` 那族键盘命令的**同一只**)。
 *
 * 一句判据,**读表不写 if**:这块瓦自述了自己是**启动瓦**(`./launchers.ts`)就先问
 * 它代表哪一格内容,否则它就是一块面,按面走。两条路末端都是同一台四态机器
 * (`stage/store.summonItem` / `.summonRef` → `summon.summonFromSituation`):
 * 没开就开、看不见就露出来、看得见没聚焦就只聚焦、焦点已在里面就收起来。
 *
 * 它单独一只文件而不是长在 `./launchers.ts` 里,是为了让那张**表**保持零 store
 * 依赖 —— 表是契约,这一只是接线。
 *
 * ── 启动瓦从前整条**绕过**召唤,那是审计 A 的 A11 现场 ────────────────────
 * W6-a 写的是「启动瓦照它说的做」,一句 `launcher.open()` 就返回。于是:目录面板
 * 已经钉在左架子上、架子收成细梁时,点那块瓦**什么都看不见** —— `openDirectoryPanel`
 * 把同一格内容再摆一次是恒等变换,而「把架子展开」从来没人做。
 *
 * 今天先问**驻留投影**:它代表的那格内容已经在某片叶上 → 对那个位置走四态;
 * 哪儿都没有 → 才 `open()`。「它代表哪格内容」问的是 `StageLauncher.dragRef`
 * (那一口答的本来就是这句话,拖拽只是它的第一个消费者 —— 判词在那张表上)。
 * 表上没有 `dragRef` 的启动瓦(将来可能有)照旧直接 `open()`:那时「它代表哪格
 * 内容」根本没有答案,先问也问不出东西。
 */
export function summonStageItem(id: string): void {
  const launcher = stageLauncherOf(id)
  if (launcher) {
    const ref = launcher.dragRef?.() ?? null
    // 已经开着 → 四态(展开架子 / 置顶浮窗 / 点名 tab / 送焦点 / 收起来)。
    if (ref && useStageStore.getState().summonRef(ref) !== null) return
    launcher.open()
    return
  }
  useStageStore.getState().summonItem(id)
}

/**
 * **点开一块瓦**。W7-p 裁定 6 起它与 `summonStageItem` 是**同一件**:点瓦与按
 * 快捷键从此逐字相同(审计 A 的 A7/A8:同一块浮窗已在最上面时,点瓦答「再置顶
 * 一次」= 零反馈,按键答「送焦点」;再来一下点瓦还是零反馈,按键收起来 ——
 * 两台机器讲两种语言,而用户只有一套心智)。
 *
 * 名字留着两个,是因为两处调用点的**词汇**不同(Dock 与「所有应用」说「点开」,
 * 键盘说「召唤」);**产地只有一个** —— 这一句 `=` 就是那个事实,没有第二份实现
 * 可供下一个人「只改其中一条」。
 */
export const openStageItem = summonStageItem
