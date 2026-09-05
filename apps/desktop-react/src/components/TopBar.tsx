import { AgentChip } from './AgentChip'
import { TopBarLeafActions, TopBarLeafTabs } from '../workbench/TopBarTabs'
import s from './TopBar.module.css'

/**
 * **顶栏就是中央区的标签条**(W1-b,设计 `docs/design/workbench-2026-09.md` §2.2
 * 「中央区的檐就是窗口顶栏(D 稿)」)。
 *
 * 用户原话:标签不要占聊天区域,聊天区现在多宽以后就多宽,把标签放到红绿灯那一栏上。
 * 于是这条带从左到右恰好三件:
 *   红绿灯让位 → 中央区各片叶的标签组(各坐各叶的正上方)→ 尾格(焦点叶的动作组 + AgentChip)
 *
 * 从前站在中间那一格的**会话名钮**因此退役 —— 它变成了中央区那片会话叶的标签
 * (单叶时 tab 条退化成一条身份带,左对齐,与修前逐像素同位)。会话标题不再由这只
 * 组件取:它是**内容自己的身份**,由聊天那一种内容发布到 `stage/live-title`
 * (`content/kinds/chat.tsx` 的 `ChatIdentity`),标签读表时活的盖静的。
 *
 * **可感知的行为变化(交卷时点名给用户)**:那颗钮从前点一下 = 点 Dock 上「会话总览」
 * 那块瓦(08-29 去接管化拍板)。标签是标签,点它只能是「切到这一格」——一个点下去
 * 开出另一块面的 tab 是在说谎。总览的入口今天只剩 Dock 那块瓦与它的快捷键。
 * 要不要把它补回来(补成动作组里的一颗、还是会话标签的右键菜单一行),是用户的拍点。
 *
 * ── 09-01:它同时**就是窗口的顶带**(用户看真机后的裁定)────────────────
 * 上一版给红绿灯单开了一条 28px 空带,顶栏排在它下面 —— 用户一眼看出那是
 * 白占一条:「header 与红绿灯放同一行,红绿灯稍往下来点」。于是那条独立带
 * (components/TitleBar.*)退役,拖拽职责并进这里:整条 `.bar` 是
 * `-webkit-app-region: drag`,左端一块定宽空元素给红绿灯让位。
 * 窗口本身没有系统标题栏(electron/main.ts 的 `titleBarStyle: 'hiddenInset'`),
 * 所以这一条**是**这扇窗唯一能拖动的地方。
 *
 * 拖拽判例(仓里踩过的坑,改这个文件前先读;真机门 `npm run gate:drag-region`):
 *  ① `-webkit-app-region` 只按**内容盒**算 —— 让位不能写成 `padding-left`,
 *     那样让出来的地方仍然可拖。必须是一个**真元素**占住它(`.traffic`),
 *     而且那个元素要有**面积**(`align-self: stretch`,80×0 血案见 CSS 里那段)。
 *  ② `no-drag` 只在 drag 元素**同一分支的子孙**上才生效。这条带上每一件可点的
 *     东西都得自己声明 no-drag,否则点它们等于按住窗口拖 —— 而且是**静默**失效,
 *     没有任何报错。**标签组因此绝不许 portal 出去**:portal 之后那句声明还在,
 *     人眼看不出任何异样,拖拽却当场破。几何靠 CSS 变量、DOM 留在带子里,
 *     判词写在 `workbench/TopBarTabs.tsx` 上。
 *     AgentChip 是别人的组件,所以由这里套一层 `.trailing` 来声明,
 *     不去改它的样式表(职责在顶栏这一侧:是我把它放进了拖拽区)。
 */
export function TopBar() {
  return (
    /*
     * ── 让位那两格属性**不在这里了**(W2)────────────────────────────────
     * 「有没有灯 / 是不是原生全屏」照旧只由宿主答(`useHostFullScreen` /
     * `useHostTrafficLights`,渲染层不拿 UA 猜),但那一问搬到了 `AppShell`:
     * 它现在有**两个**消费者(这条带子与全屏层那条檐带),而两者在 DOM 上是兄弟。
     * 判据问一次、属性写在共同的祖先(壳根)上,两条带子读同一个 `--topbar-lead`
     * —— 左缘因此永远对齐,也不会有第二处去问同一件事。
     */
    <header className={s.bar} data-testid="topbar">
      {/* 红绿灯让位区:一块什么都不画的定宽空元素。它不"画"那三颗灯(灯是原生的,
        * 由系统画在网页之上、不受 z-index 管),只负责两件事 —— 把标签推到灯的
        * 右边去,以及把这一段从拖拽把手里摘出来(拖到灯上应当是按灯,不是拖窗)。
        * 全屏时灯没了,这一块也跟着归 0(宽度过渡吃 --dur,动效档 none 直切)。 */}
      {/* `data-nodrop`(W6-b,设计 v3 §5 第一行「拒绝区:指针在红绿灯、顶栏尾格、
        * Dock 上」):**这块地方自述「一律不收」**,落点判据因此不认识红绿灯这回事
        * ——它只扫 `[data-nodrop]` 的矩形。再多一处不能放的地方 = 在那个元素上加
        * 一格属性,`workbench/drop.ts` 一个字都不改。 */}
      <div className={s.traffic} data-testid="topbar-traffic" data-nodrop="" aria-hidden="true" />
      {/* 中央区那几片叶的标签组。它是一格 flex 项,吃掉让位与尾格之间的全部剩余
        * 宽度;组本身是它的绝对定位子孙,所以**永不挤掉右端那一组动作**。 */}
      <TopBarLeafTabs />
      {/* 尾格不给 `aria-label`:它没有 role,一个只有名字没有角色的容器在无障碍树上
        * 是噪音(axe 的 `aria-*` 那一族会说话)。里面每一件自己都说得出自己是谁。 */}
      {/* 尾格同理:那儿坐着焦点叶的动作组与 AgentChip,拖一格标签到「分屏 ▸」上
        * 应当是「这里不能放」,不是「插到最后一格」。 */}
      <div className={s.trailing} data-testid="topbar-trailing" data-nodrop="">
        {/* 焦点叶的动作组(分屏 ▸ / 隐藏的标签 ⋯ / 型工具条)。设计 §2.2:
          * 「右端是焦点叶的动作组」——分屏出来的叶自己不画檐,也不画动作。 */}
        <TopBarLeafActions />
        <AgentChip />
      </div>
    </header>
  )
}
