import { ChevronDown } from './icons'
import { AgentChip } from './AgentChip'
import { useSessionsSource } from '../data/sessions-source'
import { findSession } from '../expose/projection'
import { useExposeStore } from '../expose/store'
import { useStageStore } from '../stage/store'
import { SESSIONS_ITEM_ID } from '../stage/items'
import { useT } from '../i18n'
import { useHostFullScreen } from './useHostFullScreen'
import s from './TopBar.module.css'

/**
 * 会话名是总览的入口:点一下 = 点 Dock 上那块「会话总览」瓦(08-29 去接管化拍板),
 * 所以它按用户给那块瓦设的打开方式开 —— 两个入口一条路,不是两套语义。
 * 标题本身仍然只是投影。
 *
 * 右侧那一格是 **agent 切换器**。原来站在这里的模型章(一枚写死的
 * `claude-opus-5`)08-30 退役:模型选择已经在 composer 上,顶栏再放一枚
 * 是同一件事说两遍。它当时连 i18n 键都没有(组件里一个字面量),
 * 所以这次退役没有留下任何孤儿键。
 *
 * ── 09-01:它同时**就是窗口的顶带**(用户看真机后的裁定)────────────────
 * 上一版给红绿灯单开了一条 28px 空带,顶栏排在它下面 —— 用户一眼看出那是
 * 白占一条:「header 与红绿灯放同一行,红绿灯稍往下来点」。于是那条独立带
 * (components/TitleBar.*)退役,拖拽职责并进这里:整条 `.bar` 是
 * `-webkit-app-region: drag`,左端一块定宽空元素给红绿灯让位。
 * 窗口本身没有系统标题栏(electron/main.ts 的 `titleBarStyle: 'hiddenInset'`),
 * 所以这一条**是**这扇窗唯一能拖动的地方。
 *
 * 拖拽判例(仓里踩过的坑,改这个文件前先读):
 *  ① `-webkit-app-region` 只按**内容盒**算 —— 让位不能写成 `padding-left`,
 *     那样让出来的地方仍然可拖。必须是一个**真元素**占住它(`.traffic`)。
 *  ② `no-drag` 只在 drag 元素**同一分支的子孙**上才生效。这条带上每一件
 *     可点的东西(标题下拉、右端的 AgentChip)都得自己声明 no-drag,
 *     否则点它们等于按住窗口拖 —— 而且是**静默**失效,没有任何报错。
 *     AgentChip 是别人的组件,所以由这里套一层 `.trailing` 来声明,
 *     不去改它的样式表(职责在顶栏这一侧:是我把它放进了拖拽区)。
 */
export function TopBar() {
  const t = useT()
  const currentSessionId = useExposeStore((st) => st.currentSessionId)
  const sessions = useSessionsSource((st) => st.sessions)
  const click = useStageStore((st) => st.clickDockIcon)
  // 会话标题是**数据**(用户或后端给这条会话起的名),不翻译;
  // 只有「还没有当前会话」时的兜底名才是界面文案。
  const title = findSession(sessions, currentSessionId)?.title ?? t('topbar.newSession')
  /*
   * 让位是**跟着灯走**的,不是一个常量(09-01 自查走查抓到:全屏下三颗灯已经
   * 由系统收起,左边那 80px 却还空着)。判据只能问宿主 —— 渲染层看不见 macOS
   * 的原生全屏,理由与实测读数写在 useHostFullScreen 里。
   */
  const fullScreen = useHostFullScreen()

  return (
    <header className={s.bar} data-testid="topbar" data-fullscreen={fullScreen ? 'true' : undefined}>
      {/* 红绿灯让位区:一块什么都不画的定宽空元素。它不"画"那三颗灯(灯是原生的,
        * 由系统画在网页之上、不受 z-index 管),只负责两件事 —— 把标题推到灯的
        * 右边去,以及把这一段从拖拽把手里摘出来(拖到灯上应当是按灯,不是拖窗)。
        * 全屏时灯没了,这一块也跟着归 0(宽度过渡吃 --dur,动效档 none 直切)。 */}
      <div className={s.traffic} data-testid="topbar-traffic" aria-hidden="true" />
      <button type="button" className={s.titleBtn} onClick={() => click(SESSIONS_ITEM_ID)}>
        <span className={s.title}>{title}</span>
        <ChevronDown className={s.titleIcon} strokeWidth={1.75} aria-hidden="true" />
      </button>
      <div className={s.trailing}>
        <AgentChip />
      </div>
    </header>
  )
}
