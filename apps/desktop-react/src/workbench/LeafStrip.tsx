import { useCallback, useEffect, useMemo, useRef } from 'react'
import type { MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent, ReactNode } from 'react'
import { Tabs } from '../ui/Tabs'
import { renderTitleTip } from '../content/title-tip'
import { useHomeDir } from '../data/home-dir'
import { focusIntoRef } from './focus-into'
import { useLiveTitleStore } from '../stage/live-title'
import { useT } from '../i18n'
import { contentKindOf, mayCloseContent, partsOfContent, refId } from './kinds'
import type { LiveTitle } from '../stage/live-title'
import type { TabSpec, TabsOverflow } from '../ui/Tabs'
import type { ContentRef } from './kinds'
import s from './LeafStrip.module.css'

/**
 * **一条檐**(W1,设计 §2.2「一格一檐」)。
 *
 * 规则一句话:**一片叶只有一条檐,那条檐就是 tab 条;单 tab 时它退化成一条
 * 身份带(图标 + 名 + 未保存丸),右端是这一格的动作组。**
 *
 * ── 它为什么从 `PaneLeaf` 里出来(W1-a 修批)────────────────────────────
 * 因为这条檐有**第二个宿主**了。「打开方式」的出厂缺省档是「面板内」,那一档的
 * 查看器不在拼贴树里(设计 §2.1 明写保留:它是 `FilesPanel` 自己那条分栏),
 * 于是 W1-a 交卷时它一条檐都没有 —— 关一个文件只剩右键与 Esc,而多数用户第一眼
 * 看到的正是这一档。修法不是「给分栏再画一条」:**面板内也是一「格」,它该有
 * 同一条身份带**。所以这条檐成了一件基础件,两处消费同一件、同一份样式表。
 *
 * W1-b 又添了**第三个宿主**,而且是最重要的那个:中央叶那一条搬进了**窗口顶栏**
 * (`workbench/TopBarTabs.tsx`,设计 §2.2 的 D 稿 —— 聊天区里一个像素的檐都不画)。
 * 那一次搬家一个字都没改到这只文件:变的只是「这条檐画在哪儿」,它交出去的数据表
 * 与它认的那几个动作原样不动。这正是当初出文件时预言的那件事。
 *
 * W4 添了**第四、第五个宿主**:架子那片叶与浮窗那片根叶(它们的身子换成了同一棵
 * 拼贴树,而那两处没有第二条顶栏可借,所以檐画在叶顶 —— 浮窗那一形更是
 * 「标题栏**就是**根叶这条檐」)。它们也一个字没改到这只文件的画法,只多接了两口
 * 手势(`onTabPointerDown` / `onChromePointerDown`)。
 * 「切一格 tab 焦点进内容」那条裁定的**唯一产地**也在这只文件里
 * (`useSelectIntoContent`)—— 四个宿主同一句话,不许各写一遍。
 *
 * ── 分工 ────────────────────────────────────────────────────────────────
 *   `tabSpecOf`     一格 tab 的**数据表**:身份两半合一(种类自述的静态半 +
 *                   `stage/live-title` 的活半,活的盖静的)。两个宿主同一张表。
 *   `LeafStrip`     纯呈现:收一组 `TabSpec` + 型工具条 + 动作组,消费 `ui/Tabs`。
 *                   它**不认识树**,所以面板内那一档不必假装自己是一片叶。
 *   `SoloLeafStrip` 「恰一格」的那一形:收一个 `ContentRef` + 一口 `onClose`,
 *                   自己去表里取名字、取型工具条、按种类问 `beforeClose`。
 *                   给的正是**不在树里**的那些宿主(今天只有面板内分栏)。
 *
 * ── 状态表 ①:生命周期 ──────────────────────────────────────────────────
 *   挂载    宿主里出现这条檐(一片叶 / 面板内那条分栏长出来)
 *   首载    **不画载入态**:它说的是「这儿有哪几格」,那件事是同步已知的
 *   换宿主  中央叶 → 架子 / 浮窗(W4):檐不重挂,只换外框
 *   卸载    最后一格关掉 / 藏起来(叶被 `prune` 剪掉;面板内那条分栏收起来)
 *
 * ── 状态表 ②:UI 生命状态 ───────────────────────────────────────────────
 *   单 tab    退化成身份带(`data-single` 一格属性,CSS 收掉指示条与 hover 底)
 *             —— **同一条 tab 条,不是第二个组件**
 *   多 tab    正常 tab 条 + 溢出横滚(`ui/Tabs` 自带 `overflow-x:auto`)
 *   有动作组  宿主给了才画(中央叶:⋯ / 二合一;**面板内:不画** —— 它不是树,
 *             既没有「隐藏的标签」也分不了屏)
 *   超量      `--tab-max-w` 160 封顶 + 横滚,**永不换行**(挤压纪律);W7-t 起横滚
 *             有两条鼠标出口 —— 条上的**竖滚轮**映射成横滚(`ui/Tabs` 自己那一口),
 *             以及叶动作组那颗 ⋯ 里「看不见的」那一节(名单由 `onOverflow` 交出)
 *
 * ── 状态表 ③:UI 交互状态 ───────────────────────────────────────────────
 *   tab            rest / hover(`--st-hover`)/ focus(全局环)/ active(键盘位由
 *                  `ui/a11y/roving` 管)/ selected(`aria-selected` → `joined` 档里
 *                  是「与那片叶连成一块」:同底色 + 两只肩);
 *                  **单 tab 那一形只剩 rest 与 focus**(上面 CSS 收掉了另两样)
 *   tab · 拖拽中    抬起(`data-lift`)/ 让位(`data-shift`)/ 折起(`data-torn`)——
 *                  三格都由 `ui/tab-reorder` 直接写 DOM,一帧不经过 React
 *   tab · ✕        随 `ui/Tabs`(平时透明,hover 本 tab 或键盘走到时浮出)
 *   tab · 名       截断配 Tooltip 全名(`TabSpec.tip`,禁令区那条;文件那一种给的
 *                  是整条路径 —— 两个目录里的同名文件在屏幕上长得一模一样)
 *   tab · 未保存丸  **不是控件**(不进 Tab 序、无 hover/active),一枚 `ui/StatusDot`
 *   动作组各件      随宿主交进来的那些件(中央叶交的是两颗 `ui/IconButton`)
 */

/** 宿主给这条檐的那几格。`single` 由格数自己判 —— 两个宿主不各判一遍。 */
interface LeafStripProps {
  /**
   * 非空 = 这条檐不画标签,改画这条头(内容自带的头,`ContentKind.stripHeader`)。
   * `tabs` 照旧收:溢出名单、无障碍名的数据来源不因为换画法而消失。
   */
  header?: ReactNode
  tabs: readonly TabSpec[]
  activeId: string | null
  /** tablist 的无障碍名(宿主经 i18n 给,组件里不落字面)。 */
  label: string
  /** 檐右端那组钮(中央叶:⋯ / 分屏)。没有就整格不画 —— 空 span 会多出一段 gap。 */
  actions?: ReactNode
  onSelect: (id: string) => void
  onClose: (id: string) => void
  /**
   * **按住一格 tab 意味着什么**(W4)。`ui/Tabs` 自己不认识拖拽,它只把按下这件事
   * 连同 id 递出去 —— 架子拿它把一格撕成浮窗。不接就是不接:没给这个 prop 时
   * tab 的行为与从前逐字相同(按下 → 松开 → onSelect)。
   */
  onTabPointerDown?: (id: string, e: ReactPointerEvent<HTMLElement>) => void
  /**
   * **「给这一格开动作菜单」这一句请求**(W6-c 立;W7-c 起点由标签条量)。
   * 与上面那一口同一条纪律:这条檐只把请求连同 id 与那一点递出去,开哪张表是
   * 宿主的语法 —— 面板内那一档(不在树里)不接它,那一档的右键行为一个字没变。
   */
  onTabMenu?: (id: string, at: { x: number; y: number }) => void
  /**
   * **右键檐上的空白处意味着什么**(W7-c 裁定 4)。架子与浮窗把「弹出为浮窗 /
   * 关闭整栏 / 钉到边 / 上舞台」这几件从檐上的钮搬进了叶菜单,而那两处的檐本来
   * 就有大片空白(标签条右边)—— 右键那块空白 = 开同一张叶菜单,于是那几件事
   * 在键盘、右键、菜单三条路上仍旧只有一个产地。中央区那一档不接它(顶栏那块
   * 空白是窗口的拖拽把手,右键归系统)。
   */
  onChromeContextMenu?: (e: ReactMouseEvent<HTMLElement>) => void
  /**
   * **按在檐的空白处意味着什么**(W4:浮窗的标题栏就是它根叶的这条檐,
   * 设计 §2.2)。按在 tab / 钮上时宿主自己判要不要让开 —— 这一层只负责把
   * 事件递出去,不替宿主决定「什么算空白」。
   */
  onChromePointerDown?: (e: ReactPointerEvent<HTMLElement>) => void
  /**
   * **条上有几格没露全**(W7-t / B1)。与上面那两口同一条纪律:这条檐只把
   * 标签条量出来的那份读数原样递出去,拿它画什么(那颗 ⋯ 与它那张表)是宿主的
   * 语法 —— 面板内那一档(不在树里,一格标签)不接它,行为一个字没变。
   */
  onOverflow?: (state: TabsOverflow) => void
  /** 中央叶用它给自己那条檐留取件口(`data-pane-chrome`);别的宿主不给。 */
  chromeId?: string
  /** 门与用例的取件口。 */
  testId?: string
}

export function LeafStrip({
  header,
  tabs,
  activeId,
  label,
  actions,
  onSelect,
  onClose,
  onTabPointerDown,
  onTabMenu,
  onOverflow,
  onChromePointerDown,
  onChromeContextMenu,
  chromeId,
  testId,
}: LeafStripProps) {
  const select = useSelectIntoContent(activeId, onSelect)
  /*
   * **按下即激活**(W6-b,设计 v3 §4.2 第一行:「idle ──按下──▶ pressed(当场
   * 激活这个标签)」;§9 那张落差表的最后一行「按下不激活,click 才激活 → 按下
   * 即激活」)。
   *
   * 它是用户那句「点击和拖拽分不清」的解药:按下那一刻反馈已经给了(内容切过去
   * 了),后面要么松手结束,要么拖走。产地在这里而不在 `useTabDrag`,理由与
   * `useSelectIntoContent` 长在这只文件里同一条 —— 「切一格标签」是**四个宿主
   * 同一句话**的语义(它还要把焦点送进内容),而那只 hook 只管手势。
   *
   * **次序:先激活,再起手势**。反过来的话手势会在一棵还没翻面的树上算落点。
   * 激活走的是既有那条 `select`(= `useSelectIntoContent`),所以「切 tab 焦点进
   * 内容」这句话仍旧只有一个产地;点当前活动那一格时它是幂等的。
   *
   * **它不重建这条条**:`ui/Tabs` 的 key 是 `tab.id`,激活只换 `aria-selected`
   * 与内容区 —— 被按住的那个元素必须还在手里,不然后面每一发 pointermove 都
   * 落在一个已经不存在的节点上(样例第一版就是在这里失手的)。
   * `gate:drag` 场景 ② 断言「按下前后是同一个 DOM 节点」钉着这一条。
   *
   * ── **只有主键才激活**(U2,2026-09-08;W6-c 交卷时那条待拍就此了结)────────
   * 从前这一句对**任何**按钮都跑:右键一格非活动标签会先把它切过来再开菜单,
   * 中键(粘贴 / 关闭那一族的键)也切。Chrome 与 VS Code 都不切 —— 右键是「对
   * 这一格做点什么」,而不是「我要看它」;把它连带激活的代价是用户为了看一眼某格
   * 的菜单,当前那格的内容当场没了。
   *
   * 手势那一口(`onTabPointerDown` → `useTabDrag` → `DragSession`)**照旧无条件
   * 递出去**:它自己第一句就是 `if (e.button !== 0) return`(判词在 `Tabs` 的
   * `onTabMenu` 上:「那边让开,这边接住」)。在这里再判一次等于两处判据,而这一格
   * 判的是**激活**、那一格判的是**拖拽**,两件事。
   *
   * 右键那一路仍旧只做一件事:开菜单(`Tabs` 的 `onContextMenu` 一个字没动)。
   * 中键什么都不做 —— 它既不激活也不拖,与这台壳里别的地方一致。
   */
  const onTabDown = useCallback(
    (id: string, e: ReactPointerEvent<HTMLElement>) => {
      if (e.button === 0) select(id)
      onTabPointerDown?.(id, e)
    },
    [onTabPointerDown, select],
  )
  /** 头那一档里「这片叶唯一那一格」是谁(拖拽按它认格,见下面 `data-tab-id` 那一段)。 */
  const headerTab = header ? (tabs.find((tab) => tab.id === activeId) ?? tabs[0]) : undefined
  return (
    <div
      className={s.chrome}
      data-pane-chrome={chromeId}
      data-testid={testId}
      data-single={tabs.length <= 1 || undefined}
      onPointerDown={onChromePointerDown}
      onContextMenu={onChromeContextMenu}
    >
      {header ? (
        /*
          **内容自带的头占掉标签那一块**(待办 B 形 U1)。叶里只有这一格时才会走到这里
          (判据在 `PaneLeaf`),所以不画标签不会藏掉任何一格;宿主的钮与叶的动作组照旧在右端。
        */
        /*
          **这条头就是这片叶那唯一一格**(U1-fix,2026-09-18 用户报「没有 tab 了,拖不进 tab header」)。
          拖拽的量法按 `[data-tab-id]` 认格、按条的矩形认落区(`workbench/drop-geometry.ts`);
          头把标签条换掉之后,这片叶在那张地图上整条檐都没了 —— 拖到头上没有任何落点,
          连带正文上也开不出「并排」(那一档要先从条上查出活动标签是谁)。所以这一格自述
          「我是哪一格」:id 与 tab 同源(`activeId`),装了几份照旧由 `slots` 说。
        */
        /*
          **抓手**(U1-fix 第二半,同一条报障的另一头):没有标签就没有东西可抓,于是这扇窗
          **拖不进别人的标签条**,按住头只会挪窗子(真机:窗子从 321,171 挪到 205,45,全程没有拖影)。
          头自己说哪一块是抓手(`[data-strip-grab]`,内容那一侧标),按在上面 = 按在那一格标签上,
          与别处抓标签逐字同一条路(`onTabPointerDown` → `useTabDrag`)。`stopPropagation` 挡住檐那一层的
          拖窗手势 —— 不挡的话一次按下会同时挪窗又撕格。头上其余空白照旧拖窗。
        */
        <div
          className={s.header}
          data-strip-header=""
          data-tab-id={headerTab?.id}
          data-tab-slots={headerTab?.slots && headerTab.slots > 1 ? String(headerTab.slots) : undefined}
          onPointerDown={(event) => {
            if (!headerTab || !(event.target instanceof Element)) return
            if (!event.target.closest('[data-strip-grab]')) return
            event.stopPropagation()
            onTabPointerDown?.(headerTab.id, event)
          }}
        >
          {header}
        </div>
      ) : (
      <div className={s.tabs}>
        {/*
          **四个宿主一套标签语言**(W3-b 裁定 1;09-05 用户看真机后选甲)。
          这一格 `look` 不是可选项:这条檐**就是**拼贴台的标签条,顶栏组 / 架子叶 /
          浮窗叶 / 分屏叶画的都是它。W3-b 之前顶栏那一组另有一套三面描边的皮肤长在
          `TopBarTabs.module.css` 里,而这里画的是扁平下划线 —— 用户的原话是
          「两套标签语言」。皮肤整段搬进了 `ui/Tabs` 的 `joined` 档,这里只声明档位。
        */}
        <Tabs
          items={tabs as TabSpec[]}
          activeId={activeId}
          label={label}
          look="joined"
          onSelect={select}
          onClose={onClose}
          onTabPointerDown={onTabDown}
          onTabMenu={onTabMenu}
          onOverflow={onOverflow}
        />
      </div>
      )}
      {/* **型工具条那一格 W7-c 整格删掉**(裁定 2):内容的动作单产地是它自己的
        * 右键菜单,檐上不再有第二个入口。留在这里的只有宿主那一组钮。 */}
      {actions && <span className={s.actions}>{actions}</span>}
    </div>
  )
}

/**
 * **激活一格 tab → 焦点进这片叶的内容**(09-05 裁定,W1-b × W4 的接缝之一)。
 *
 * ── 裁定原文与它治的病 ──────────────────────────────────────────────────
 * W4 之前,点架子上一格 tab 焦点会进那块内容 —— 但那是**侥幸**:那时 tab 条长在
 * 架子的 `<head>` 里、在每一格 `shelf-layer` 的**外面**,于是点完之后焦点不在任何
 * 一层里,`focus-follow` 的「架子切 tab」那一发 `activateScope` 送得进去。
 * W4 把 tab 条搬成**叶檐**(它长在叶里、叶又长在层里)之后,注册表那条
 * 「焦点已经在我里面就不往回拽」当场生效(`FocusTree.activate` 的判据①),
 * 焦点停在 tab 上 —— 中央区从 W1-a 起也是这个样子。
 *
 * 裁定不是把断言收弱,而是把行为定死,四个区域(中央顶栏组 / 架子叶檐 / 浮窗根叶
 * 檐 / 分屏出来的那几片叶)**同一句话**:
 *
 *   **tab 被激活(指针点击 / Enter / Space)→ 焦点进这片叶的内容;
 *     ←/→ roving 仍旧留在 tab 上。**
 *
 * 后半句是白拿的:`ui/Tabs` 走的是 APG 的**手动激活**档 —— ←/→ 只移焦点、不发
 * `onSelect`。所以这只 hook 挂在 `onSelect` 上就恰好只覆盖前半句,一个键都不必判。
 *
 * ── 为什么产地在这里,而不是四个宿主各写一遍 ──────────────────────────────
 * `LeafStrip` 是那条檐**唯一**的画法,四个宿主消费的是同一件。判据放在这里,
 * 「切 tab 进内容」就不可能在某一个宿主上悄悄分叉 —— 而分叉正是这次接缝要治的病。
 *
 * ── 那一句 `activateScope` 的产地在 `workbench/focus-into.ts`(W3 抽出去)────
 * W3 的拖拽落定给这句话添了第五个调用点(裁定 8:「落定后焦点跟到新叶,与
 * 『tab 激活 → 焦点进内容』**同一句**」)。同一句话有五个调用点还各写各的,
 * 迟早在某一条路上分叉 —— 而分叉正是这次接缝要治的病。这只 hook 保留的是
 * **等一拍**那半件(它有 `activeId` 这个现成的信号);送那半件在产地。
 *
 * ── 落点怎么找:问的是**那一格 tab 的层**,不是叶,也不是宿主层 ────────────
 * 每一格 tab 的内容层自己是一格 `leaf` 作用域,`owner` = 这一格的 refId
 * (判词在 `PaneLeaf.PaneTabLayer` 上),而 `leaf` 在表上自述 `passThrough` ——
 * 于是内核穿过它,一直走到内容自己那一格。三件事因此白拿:
 *  · 它认的是 refId,四个宿主同一句;
 *  · 后台那几层是 `inert`,`activateScope` 只在可交互的实例里挑,选不错人;
 *  · 送不进去(那一格还没铺根 / 那一种内容没有可聚焦的落点)一律答 false,
 *    焦点原地不动 —— 与形态机那条「送不进去不追」同一条纪律。
 *
 * ── 为什么要等一拍 ──────────────────────────────────────────────────────
 * 点下去那一刻,新选中的那一层还是 `inert`(它要等这次 store 更新提交完才翻面),
 * 当场问 `activateScope` 一定答 false。所以记一格「想进哪儿」,等 `activeId` 真的
 * 变成它、React 提交之后的 effect 里再送 —— 与 `stage/focus-follow` 那条
 * 「落焦必须排在提交之后」是同一条判例,不是这里新发明的。
 * 点的正是当前活动那一格时不会有重渲,那一路**当场送**(它已经不是 inert 了)。
 */
function useSelectIntoContent(
  activeId: string | null,
  onSelect: (id: string) => void,
): (id: string) => void {
  const wanted = useRef<string | null>(null)
  const select = useCallback(
    (id: string) => {
      onSelect(id)
      if (id === activeId) {
        // 已经是活动那一格:这一下不会有重渲,当场送。
        focusIntoRef(id)
        return
      }
      wanted.current = id
    },
    [activeId, onSelect],
  )
  useEffect(() => {
    if (wanted.current === null || wanted.current !== activeId) return
    wanted.current = null
    focusIntoRef(activeId)
  }, [activeId])
  return select
}

/**
 * 一格 tab 的**数据表**。身份两半合在这里:静态那一半问种类(`kind.title`),
 * 活的那一半读 `live-title`(键 = refId,由内容自己发布)—— **活的盖静的**。
 *
 * 纯函数而不是 hook:中央叶要对**一组** ref 各算一格(hook 不能在循环里调),
 * 而 `titles` 那张表整份订一次就够。
 */
export function tabSpecOf(
  ref: ContentRef,
  titles: Record<string, LiveTitle>,
  opts: { closable?: boolean; home?: boolean; preview?: string; homeDir?: string | null } = {},
): TabSpec {
  const id = refId(ref)
  const kind = contentKindOf(ref.kind)
  const live = titles[id]
  const still = kind?.title(ref)
  return {
    id,
    label: live?.text ?? still?.text ?? ref.key,
    icon: kind?.icon(ref),
    dirty: live?.dirty ?? still?.dirty ?? false,
    /*
     * 截断的名字必须说得出全名(禁令区那条)。文件那一种给的是整条路径。
     *
     * **在这儿就画成节点**(09-13):`ui/Tabs` 与 `ui/Tooltip` 一样不认识
     * 「路径」,而「这句提示是不是路径」是产地自述的一格
     * (`LiveTitle.tip`)—— 这只函数只读表,一个字都不猜。
     * `homeDir` 由宿主在组件顶层取一次往下传:这只是纯函数(中央叶要对一组
     * ref 各算一格),而 hook 不能在循环里调。
     */
    tip: renderTitleTip(live?.tip ?? still?.tip, opts.homeDir ?? null),
    closable: opts.closable ?? true,
    // 「这一组的家」(W1-b):判据由宿主从种类自述里取,这只函数只搬运。
    home: opts.home ?? false,
    /*
     * **这一格装了几份**(W6-b)。问的是**种类自述的复合表**
     * (`ContentKind.composite.parts`),所以这只函数照旧不认识 `pair` 这四个
     * 字母,而下一种复合内容出现时它一个字都不用改。
     * 落点判据从 DOM 上读它(`[data-tab-slots]`),用来答「两格的标签不能再并」
     * 与「内容区左带仅 host 单格」两条 —— 判词在 `workbench/drop.TabBox` 上。
     */
    slots: partsOfContent(ref)?.length ?? 1,
    /*
     * **这一格用哪一档宽度上限**(W7-t / B6)。问的仍旧是**种类自述**
     * (`ContentKind.tabWide`),所以这只函数照旧不认识 `pair` 这四个字母,
     * 而下一种「天生装两个名字」的内容出现时它一个字都不用改。
     */
    wide: kind?.tabWide === true,
    /*
     * **这一格是不是预览格**(C2)。它与上面几格不同:判据**不问种类**,问的是
     * **这片叶**(`PaneLeafNode.previewIndex`)—— 同一条会话可以在一片叶里是预览格、
     * 在另一片叶里是普通标签。所以它由宿主算好之后连同那句状态词一起交进来,
     * 这只函数照旧只搬运(判词在 `TabSpec.preview` 与 `leaf-tabs.useLeafTabSpecs`)。
     */
    preview: opts.preview,
  }
}

/**
 * **恰一格的那一形**:给「不在拼贴树里」的宿主(今天只有 `FilesPanel` 那条分栏)。
 *
 * 它与中央叶单 tab 时那条身份带是**同一件**(同组件、同样式表、同数据表),
 * 所以两处逐像素相同 —— 这正是修批要的:面板内那一档不是「没有檐」,
 * 而是「同一条檐,只是恰好只有一格」。
 *
 * **关闭语义与中央叶逐字相同**:先问种类(`beforeClose` —— 脏文件那一问),
 * 答 `'close'` 才把 `onClose` 交出去。那一问必须在**檐**这一侧发起:
 * 被关掉的那棵树自己问不了自己(判据整件在 `kinds.mayCloseContent`,单产地)。
 */
export function SoloLeafStrip({
  contentRef,
  onClose,
  testId,
}: {
  contentRef: ContentRef
  onClose: () => void
  testId?: string
}) {
  const t = useT()
  const titles = useLiveTitleStore((st) => st.titles)
  // 家目录在组件顶层取一次往下传(`tabSpecOf` 是纯函数,不是 hook)。
  const homeDir = useHomeDir()
  const id = refId(contentRef)
  const tabs = useMemo(
    () => [tabSpecOf(contentRef, titles, { homeDir })],
    [contentRef, titles, homeDir],
  )
  const close = useCallback(() => {
    void (async () => {
      if (await mayCloseContent(contentRef)) onClose()
    })()
  }, [contentRef, onClose])
  return (
    <LeafStrip
      tabs={tabs}
      activeId={id}
      label={t('workbench.leafTabs')}
      onSelect={() => {
        /* 只有一格,切给谁?这一口是 `ui/Tabs` 的受控约定要的,不是一件功能。 */
      }}
      onClose={close}
      testId={testId}
    />
  )
}
