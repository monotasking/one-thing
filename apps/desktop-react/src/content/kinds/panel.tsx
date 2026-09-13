import { registerContentKind } from '../../workbench/kinds'
import { PANEL_KIND } from '../../stage/panel-ref'
import { findItem } from '../../stage/items'
import { renderContent } from '../index'
import { t } from '../../i18n'
import type { ContentRef } from '../../workbench/kinds'

/**
 * **今天那 11 块瓦,整体登记为 `panel` 这一种**(设计 §1.1;2026-09-13「模型服务」
 * 退役,从 12 变成 11 —— 这个数是**日志里的一句话**,瓦表才是产地)。
 *
 * `key` = 瓦 id,`singleton: true` —— 一块瓦全应用只有一个实例,那是 `STAGE_ITEMS`
 * 与形态机从第一天起就成立的约定(`placements` 是按 id 记的一张表)。
 *
 * ── 这一种今天**没有消费者在树里** ──────────────────────────────────────
 * **W4 起它有了真消费者**:架子与浮窗的身子换成了拼贴树,一块瓦就是树里的一格
 * tab(`{kind:'panel', key:<瓦 id>}`,产地 `stage/panel-ref.ts`)。下面那三条
 * 「今天就成立」的理由是 W1-a 写的,它们照旧成立:
 *  ① `renderContent(ref, visibility)` 的 memo key 换成 `refId`(派工规格第 5 条);
 *  ② 存量档案里若有 `panel:` 的 tab(手改 / 未来回退),`sanitize` 认得它,
 *    不会当未知种类剔掉;
 *  ③ 「加一种内容 = 它自己的模块 + 一行登记」这句话在**三种**上各验一次,
 *    而不是只在文件那一种上验。
 */
registerContentKind(
  {
    // 种类名的**唯一产地**在 `stage/panel-ref.ts`(那只文件是「瓦 id ⇄ 内容引用」
    // 那条缝;两处各写一个 `'panel'` 字面量迟早分叉)。
    id: PANEL_KIND,
    singleton: true,
    /**
     * **层级转问瓦表**(S1,dock-scope §2.2 / §2.4)。11 块瓦整体登记成这一种,
     * 而「工作区 / 设置 / 所有应用是 app 级、其余是 space 级」是**逐瓦**的事实 ——
     * 所以这一格是个函数,答案在 `stage/items.ts` 那张表的 `level` 一列上。
     *
     * 认不得的 key(存量档案里退役的瓦、手改过的档案)答 `space`:**缺省 = 今天的
     * 行为**,而「随人走」这种事不该由一格问不出主的 ref 白拿。
     */
    level: (ref: ContentRef) => findItem(ref.key)?.level ?? 'space',
    /**
     * **退役的瓦不再活在存量档案里**(2026-09-13,起因:模型服务并进设置页)。
     *
     * `sanitize` 从前只问得出「`panel` 这一种还在不在」,而一块瓦退役时种类好端端
     * 地在、没了的是**那一行**;于是 `panel:providers` 活下来,在标签条上变成一格
     * 点开是空白的 tab(`renderContent` 查不到表,答 null)。
     *
     * 判据就是瓦表本身 —— **这一种自己答得出**,核心层因此照旧不认识「瓦」。
     * 它与 v11 那段迁移不是一件事的两份实现:迁移清的是 stage 那本**家具**账
     * (浮窗矩形 / 位置记忆 / 隐藏表),这一口管的是**拼贴树**里那一格 tab,
     * 而且它不靠版本号 —— 每次水合都跑(存档是不可信输入)。
     */
    exists: (ref: ContentRef) => findItem(ref.key) !== undefined,
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
