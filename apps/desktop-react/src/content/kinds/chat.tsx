import { useCallback, useRef } from 'react'
import { registerContentKind } from '../../workbench/kinds'
import { CENTER_REGION } from '../../workbench/regions'
import { ErrorBoundary } from '../../components/ErrorBoundary'
import { ChatStream } from '../ChatStream'
import { TocPanel } from '../../toc/TocPanel'
import { useChatToc } from '../../toc/useChatToc'
import { t } from '../../i18n'
import s from './ChatLeaf.module.css'

/**
 * **聊天这一种内容**(W1,设计 §1.1 / §2.3)。
 *
 * ── 它的三条自述,每一条都替代了一处从前写死的判据 ──────────────────────
 *  · `singleton: true` —— 今天全应用只有一条会话在屏上。W5(会话多开)把它翻成
 *    false,`key` 换成 sessionId,树、隐藏、标签一个字都不用改;
 *  · `resident: { region: 'center', key: 'main' }` —— 出厂时中央区第一片叶里就是它
 *    (核心层因此不必知道「中央区装的是聊天」),而且**这个区域里最后一格聊天关不掉**
 *    (T0 拍点 2)。判据是「同种还剩几个」,不是「它是不是 chat」;
 *  · `regions: ['center']` —— 设计 §1.1 那张表里写着「今天只有 chat 在 T4 之前
 *    限定 center」。撕进浮窗 / 钉到边由 W5 解禁,解禁 = 改这一行。
 *
 * ── `chatRef` / `useChatToc` **跟着叶走** ────────────────────────────────
 * 从前它们长在 `AppShell` 上(滚动 ref 一份,两个消费者:TOC 当前键与目录跳转)。
 * 聊天区成为一片叶之后它们跟着搬进来 —— 判据是「谁真的用它」:这条 ref 只被
 * 这一片叶里的两件用,挂在外壳上等于让每一次目录高亮重渲整台壳。
 */

/**
 * 聊天叶的身体。**这一层不是一个新组件族** —— 它就是从前 `AppShell` 里
 * `.chatArea` 那一段,原样搬进来。
 *
 * ── 三张状态表 ──────────────────────────────────────────────────────────
 *  ① 生命周期:挂载 = 中央树里出现这一格(出厂即有);**换宿主**(将来撕进浮窗)
 *     = 这棵树真重挂,滚动位由 `ChatStream` 自己的进场落底接;卸载 = 只可能发生在
 *     整台壳卸载时(它是常驻的,关不掉也藏不掉)。无模块级副作用 → 不需要 HMR dispose
 *     (这只文件末尾那一段是给**注册**配的,不是给组件配的)。
 *  ② UI 生命状态:空 / 载入中 / 就绪 / 错误全部由 `ChatStream` 自己说
 *     (它有自己的空态与错误行);目录 rail 在没有锚点时整条不在场。
 *  ③ UI 交互状态:这一层不画任何控件,交互状态全在它包着的两件上。
 */
function ChatLeaf() {
  // 聊天滚动容器只有一个 ref,两个消费者:TOC 当前键 与 目录跳转。
  const chatRef = useRef<HTMLDivElement>(null)
  const { currentIndex, flashMessageId, syncFromScroll, pickTurn } = useChatToc(chatRef)
  /*
   * 09-01 用户裁定退役了「滚动降淡」之后,这条监听只剩这一件事。
   * 它仍然套一层 `useCallback`:`ChatStream` 把它挂在滚动容器上,身份一变就重挂一次监听。
   */
  const onScroll = useCallback(() => {
    syncFromScroll()
  }, [syncFromScroll])

  return (
    <div className={s.chatArea}>
      {/* 聊天区与输入框**各一界**:消息流炸了还能打字,输入框炸了还能读历史。
        * (输入框不在这片叶里 —— 它是 `.center` 上那一格落位带,W5 才归属焦点叶。) */}
      <ErrorBoundary where="chat">
        <ChatStream scrollRef={chatRef} onScroll={onScroll} flashMessageId={flashMessageId} />
      </ErrorBoundary>
      <TocPanel currentIndex={currentIndex} onPick={pickTurn} />
    </div>
  )
}

registerContentKind(
  {
    id: 'chat',
    singleton: true,
    resident: { region: CENTER_REGION, key: 'main' },
    regions: [CENTER_REGION],
    // 标题读的是当下语言 —— `PaneLeaf` 自己 `useT()` 订着 locale,所以切语言
    // 会重渲那条 tab 条,这一句于是重跑一次(非组件上下文的 `t()` 用法)。
    title: () => ({ text: t('focus.scope.chat') }),
    icon: () => 'MessagesSquare',
    render: () => <ChatLeaf />,
  },
  import.meta.hot,
)
