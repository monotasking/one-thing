import { registerContentKind } from '../../workbench/kinds'
import { findItem } from '../../stage/items'
import { renderContent } from '../index'
import { t } from '../../i18n'
import type { ContentRef } from '../../workbench/kinds'

/**
 * **今天那 12 块瓦,整体登记为 `panel` 这一种**(设计 §1.1)。
 *
 * `key` = 瓦 id,`singleton: true` —— 一块瓦全应用只有一个实例,那是 `STAGE_ITEMS`
 * 与形态机从第一天起就成立的约定(`placements` 是按 id 记的一张表)。
 *
 * ── 这一种今天**没有消费者在树里** ──────────────────────────────────────
 * 瓦仍然走形态机那条老路(Dock / 架子 / 浮窗 / 舞台),W4 才把架子与浮窗换成树。
 * 它现在就登记,是为了三件事今天就成立:
 *  ① `renderContent(ref, visibility)` 的 memo key 换成 `refId`(派工规格第 5 条);
 *  ② 存量档案里若有 `panel:` 的 tab(手改 / 未来回退),`sanitize` 认得它,
 *    不会当未知种类剔掉;
 *  ③ 「加一种内容 = 它自己的模块 + 一行登记」这句话在**三种**上各验一次,
 *    而不是只在文件那一种上验。
 */
registerContentKind(
  {
    id: 'panel',
    singleton: true,
    // 标题读的是瓦表上那个静态名;活标题(浏览器瓦的当前网页名之类)由
    // `stage/live-title` 盖在上面 —— 两半的分工写在 `ContentKind.title` 上。
    title: (ref: ContentRef) => {
      const item = findItem(ref.key)
      return { text: item ? t(item.titleKey) : ref.key }
    },
    icon: (ref: ContentRef) => findItem(ref.key)?.icon ?? 'LayoutGrid',
    // 内容表那一层一个字没改:它仍然是「瓦 id → 组件」的唯一产地。
    render: (ref, visibility) => renderContent(ref.key, visibility),
  },
  import.meta.hot,
)
