import { useLayoutEffect } from 'react'
import { useExposeStore } from '../expose/store'
import { useT } from '../i18n'
import { Button } from '../ui/Button'
import { useWorkbenchStore } from './store'
import { CENTER_REGION } from './regions'
import { PaneTree } from './PaneTree'
import { leafCount } from './layout'
import s from './CenterRegion.module.css'
/*
 * 内容种类的注册 barrel。**谁要查表,谁负责保证表是装好的**(与 `FileViewer`
 * 那三张注册表逐字同一条判例)—— 这一层是拼贴树在壳里的唯一入口,它挂起来
 * 就意味着「屏幕上要画内容了」。
 *
 * 生产那条路仍然由 `main.tsx` 在 `startWorkbench()` 之前先 import 一次:
 * 那一步管的是**第一帧**(persist 的 merge 是同步的,它跑在这只组件挂载之前)。
 * 这一行管的是「不经过 main.tsx 的宿主」(用例、将来的第二个壳)。
 */
import '../content/kinds'

/**
 * **中央区那棵树的宿主**(W1,设计 §1.3)。
 *
 * 它只做两件事:把 store 上那棵树交给 `PaneTree`,以及报出「这个区域里有几片叶」——
 * 后者是叶檐那圈焦点边的判据(只有一片时不画:没有第二片可比,一圈边只是噪音)。
 *
 * ── 它挂在 `.center` 与从前那格 `.chatArea` 之间 ──────────────────────────
 * 位置是裁定死的:叶容器必须是 `.center` 的 **height:100% 后代**,才吃得到中央区
 * 那一格的高度。(09-13 起 `[data-dock-reserve]` 那四条让位规则打在 `.main` 上 ——
 * 平移形,整张网格朝那条边退,`.center` 与它的后代跟着缩;从前上下两边是内衬形、
 * 打在 `.center` 自己身上,那一版连同 `.composerDock` 的 bottom 覆写一起删了。)
 * W5-c 起 `.composerDock` **在树里**:它是会话那一种内容自己的器官,所以这一层
 * 与它之间没有任何关系 —— 屏幕上有几块输入框,是树上有几片会话叶的结果。
 */
export function CenterRegion() {
  const tree = useWorkbenchStore((st) => st.regions[CENTER_REGION])
  /*
   * 播种一次。**幂等**(`seed` 自己是),所以它与 `main.tsx` 里那一句不冲突 ——
   * 生产那条路早就播过了,这一句在那儿是恒等变换;不经过 `main.tsx` 的宿主
   * (用例)靠它拿到出厂布局。用 layout effect 而不是 effect:出厂那一格叶
   * 该在**第一次绘制之前**就位,不然会先画一帧空树。
   */
  useLayoutEffect(() => {
    useWorkbenchStore.getState().seed()
  }, [])
  if (!tree) return <CenterEmpty />
  const multi = leafCount(tree) > 1
  return (
    <div className={s.panes} data-pane-region={CENTER_REGION} data-pane-multi={multi || undefined}>
      <PaneTree node={tree} />
    </div>
  )
}

/**
 * **中央区什么都没有的那一态**(W7-t / A12)。
 *
 * ── 它为什么存在 ────────────────────────────────────────────────────────
 * 常驻那条规矩(`ContentKind.resident`)保证「最后一格会话关不掉」,所以正常用
 * 到不了这里;但这棵树**剪得成 `null`**(`tree.prune` 的原话:「判断『空了怎么办』
 * 不是树的事」),而修前那一句 `return null` 的下场是**整块中央区变成一片白**
 * ——一片白说不出任何事实,也给不出任何出路。
 *
 * 空态说两句话:这儿本来该有什么、以及**怎么让它回来**。那颗钮调的是 ⌘N 那**同一只
 * 动作**(`expose.newSessionInCurrentProject`,落在哪个项目下由它自己判)——
 * 键盘那条路与这颗钮走两个动作,迟早在某一条上悄悄分叉。
 *
 * ── 三张状态表 ──────────────────────────────────────────────────────────
 * ① 生命周期:挂载 = 那棵树被剪成 null;卸载 = 播种 / 新建回来一格,树重新在场。
 *    它自己没有异步、没有订阅,所以没有可拆卸的尾巴。
 * ② UI 生命状态:它**就是** empty 那一格 —— loading / error 不归它(建会话在飞
 *    的反馈由那颗钮自己给,见 ③)。
 * ③ UI 交互状态:那颗钮随 `ui/Button`(rest/hover/focus/active);建会话是一次
 *    往返,而这一处**刻意不画进行中反馈** —— 与 `useComposerSend` 里那两把闸
 *    同一条判词:建会话快到人看不见一帧,画一个转圈只会闪。
 *
 * 它**不戴 `data-pane-region`**(09-06 审查):那格属性说的是「这儿是中央区那棵
 * 树」,而空态恰恰是「那棵树不在场」。戴上去的下场是凡按它找树的选择器
 * (`[data-pane-region="center"] [data-pane-tab]` 之类)连空态一起命中。
 * 取件走 `data-testid="center-empty"`。
 */
function CenterEmpty() {
  const t = useT()
  return (
    <div className={s.empty} data-testid="center-empty">
      <p className={s.emptyText}>{t('workbench.centerEmpty')}</p>
      <Button
        variant="primary"
        onClick={() => void useExposeStore.getState().newSessionInCurrentProject()}
        data-testid="center-empty-new"
      >
        {t('workbench.centerEmptyNew')}
      </Button>
    </div>
  )
}
