import { useLayoutEffect } from 'react'
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
 * 位置是裁定死的:`[data-dock-reserve]` 那四条让位规则打在 `.center` 上,
 * 而叶容器必须是 `.center` 的 **height:100% 后代**,那几条内衬才对得上。
 * `.composerDock` **留在 `.center` 上不进树**(W5 才归属焦点叶)。
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
  if (!tree) return null
  const multi = leafCount(tree) > 1
  return (
    <div className={s.panes} data-pane-region={CENTER_REGION} data-pane-multi={multi || undefined}>
      <PaneTree node={tree} />
    </div>
  )
}
