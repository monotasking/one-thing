import { useCallback, useEffect, useLayoutEffect, useRef } from 'react'
import type { RefObject } from 'react'
import { refId, registerContentKind } from '../../workbench/kinds'
import { CENTER_REGION } from '../../workbench/regions'
import { ErrorBoundary } from '../../components/ErrorBoundary'
import { FrameCoalescer } from '../../ui/frame-coalescer'
import { ChatStream } from '../ChatStream'
import { TocPanel } from '../../toc/TocPanel'
import { useChatToc } from '../../toc/useChatToc'
import { currentSessions, useSessionsSource } from '../../data/sessions-source'
import { findSession } from '../../expose/projection'
import { useLiveTitleStore } from '../../stage/live-title'
import { t, useT } from '../../i18n'
import { useExposeStore } from '../../expose/store'
import { NEW_SESSION_KEY, SESSION_KIND, sessionIdOfRef } from '../session-ref'
import { dropComposerDraft } from '../../composer/drafts'
import { disposeComposerStore } from '../../composer/store'
import { Composer } from '../../composer/components/Composer'
import type { ContentRef } from '../../workbench/kinds'
import s from './ChatLeaf.module.css'

/**
 * **会话这一种内容**(W5-b,设计 §1.1 / §2.3 / §8 W5;裁定 1)。
 *
 * W1 它叫 `chat`,是一格单例 `chat:main`;本批它改名 `session`,`key` 换成
 * **会话 id**,`singleton` 翻成 false —— 于是「两条会话并排各占一片叶」是树自己
 * 就成立的事,树、隐藏、标签、拖拽、持久化一个字都没改(那正是 W1 那三条自述
 * 上写的预言)。存量档案里那一格 `chat:main` 由 persist v2 翻成 `session:new`
 * (翻译表在 `content/legacy-refs.ts`)。
 *
 * ── 四条自述,每一条都替代了一处从前写死的判据 ──────────────────────────
 *  · `singleton: false` —— 会话多开的全部实现就是这一格;
 *  · `resident: { region: 'center', seed }` —— 出厂时中央区第一片叶里就是它
 *    (核心层因此不必知道「中央区装的是会话」),而且**这个区域里最后一格会话
 *    关不掉**(T0 拍点 2)。`seed()` 是裁定 2 那一格「延迟铸 key」:摆哪条会话
 *    只有这一种自己答得出;
 *  · **`regions` 缺席** —— 裁定 8:会话可以开到任何区域(架子 / 浮窗 / 分屏),
 *    于是 W3 那句「会话行落别处 = 结构化拒绝」自然解禁。拒绝那一句话现在由
 *    `ContentKind.regions` 生成(`workbench/useContentDrag.ts` 的缺省 accepts),
 *    没人再手写;
 *  · ~~`fullable: false`~~ —— **W5-c 撤掉了**(正本 `composer-in-leaf-2026-09.md`
 *    §2 / §6 第 5 条)。它从前存在的唯一理由是「输入框不在树里,会话叶进全屏
 *    会把它盖掉」;路线 A 之后输入框**就在这片叶里**(下面那格 `.composerDock`),
 *    跟着叶一起进全屏,那条理由当场没了。缺席 = 进得了全屏。
 *
 * ── 这片叶看哪条会话:`ref.key`,不是 expose 那一格 ──────────────────────
 * W5-a 时这一层读的是 `expose.currentSessionId`(全应用一份);本批换成
 * **这一格自己的 key** —— 叶就是「哪条会话」的产地,两片叶各说各的。反过来,
 * 「当前会话」变成了**投影**:焦点叶的会话是哪条,那一格就是哪条
 * (`content/session-projection.ts`)。方向反了过来,而底下三件(消息流 /
 * 目录接缝 / 目录 rail)一个字都没改 —— 它们从 W5-a 起就只认收到的那个 id。
 *
 * ── 输入框是这一种内容自己的器官(W5-c 路线 A)────────────────────────────
 * 从前它是外壳挂在整个中央区底部的一块浮层,显不显示与那一格装的是什么内容
 * 无关 —— 于是焦点在终端 / 浏览器 / 改动面上时它照样浮着、照样盖住那一格的底部
 * (用户报障:「composer 在其他 tab 页也存在,导致会遮挡内容」)。
 * 现在它由 `SessionLeaf` 自己渲染:**哪里有会话叶,哪里才有输入框**是结构上的
 * 事实,不需要任何判断。陌生能力演练:终端将来要一条自己的底栏,改的是
 * `content/kinds/terminal.tsx`,外壳零改动;两条会话并成 `pair` 时每半格自带
 * 一块,`pair` 模块零改动。
 */

/**
 * 会话叶的身体。
 *
 * ── 三张状态表 ──────────────────────────────────────────────────────────
 *  ① 生命周期:挂载 = 某棵树里出现这一格(出厂那一片、或者从会话列表拖一行
 *     进来、或者分屏);**换宿主**(搬进架子 / 撕成浮窗)由结构共享保证不重挂;
 *     **换会话**(`replaceRef`)换的是这一格的 refId,内容层按 refId 分格,
 *     所以那是一次**这一格**的重挂,兄弟叶一动不动(零重挂断言守的正是后半句);
 *     卸载 = 这一格被关掉 / 藏起来 / 整区收掉。数据机器的寿命**不跟着挂载走**
 *     —— 它由「树里 ∪ 隐藏表里还有没有这条会话」决定(判词在
 *     `content/session-projection.ts` 的那本引用账上),所以藏起来的会话叶
 *     照样收流。无模块级副作用 → 组件这一层不需要 HMR dispose。
 *     **输入框跟着这片叶同生共死**(W5-c):一片会话叶恰好一块,换宿主不重挂,
 *     藏起来时留着但不可交互(整片叶 `content-visibility: hidden` + inert),
 *     这一格被关掉时连它那份 store 一起释放(见下面 `ContentKind.dispose`)。
 *  ② UI 生命状态:空 / 载入中 / 就绪 / 错误全部由 `ChatStream` 自己说;
 *     目录 rail 在没有锚点时整条不在场;输入框自己那三张表在 `Composer` 的文件头。
 *  ③ UI 交互状态:这一层不画任何控件 —— 它只摆三件半(消息流 / 目录 / 输入框
 *     那一格落位带),交互状态全在它包着的那几件上。
 */
function SessionLeaf({ contentRef }: { contentRef: ContentRef }) {
  /*
   * **这一片叶看哪条会话 = 这一格自己的 key**(W5-b)。保留键读作空串
   * ——「还没绑会话」那一态,与从前 `currentSessionId === ''` 逐字同义。
   */
  const sessionId = sessionIdOfRef(contentRef) ?? ''
  // 聊天滚动容器只有一个 ref,两个消费者:TOC 当前键 与 目录跳转。
  const chatRef = useRef<HTMLDivElement>(null)
  /* 两个几何读数的量点(W5-c:整只 hook 从 `AppShell` 搬来,判词在它自己头上)。 */
  const areaRef = useRef<HTMLDivElement>(null)
  const dockRef = useRef<HTMLDivElement>(null)
  useComposerGeometry(areaRef, dockRef)
  const { currentIndex, flashMessageId, syncFromScroll, pickTurn } = useChatToc(sessionId, chatRef)
  /*
   * 09-01 用户裁定退役了「滚动降淡」之后,这条监听只剩这一件事。
   * 它仍然套一层 `useCallback`:`ChatStream` 把它挂在滚动容器上,身份一变就重挂一次监听。
   */
  const onScroll = useCallback(() => {
    syncFromScroll()
  }, [syncFromScroll])

  return (
    <div className={s.chatArea} ref={areaRef}>
      <SessionIdentity contentRef={contentRef} sessionId={sessionId} />
      {/* 聊天区与输入框**各一界**:消息流炸了还能打字,输入框炸了还能读历史。 */}
      <ErrorBoundary where="chat">
        <ChatStream
          sessionId={sessionId}
          scrollRef={chatRef}
          onScroll={onScroll}
          flashMessageId={flashMessageId}
        />
      </ErrorBoundary>
      <TocPanel sessionId={sessionId} currentIndex={currentIndex} onPick={pickTurn} />
      {/*
        * ── 输入框的**落位带**(W5-c 路线 A)────────────────────────────────
        * 它绝对定位贴着这片叶的底,于是不占一格 flex,正文从玻璃底下流过。
        * 两个属性各有一个读者,都不是样式:`data-composer-dock` 是外壳那条
        * 「Dock 停底边时让位」规则的抓手(跨 CSS module 的类名会被哈希,所以按
        * 属性选,与 `[data-panel-layer]` 同一个先例);`data-testid` 是三道真机门
        * 的采样点。
        */}
      <div className={s.composerDock} ref={dockRef} data-composer-dock data-testid="composer-dock">
        <ErrorBoundary where="composer">
          <Composer sessionId={sessionId} owner={refId(contentRef)} />
        </ErrorBoundary>
      </div>
    </div>
  )
}

/**
 * **悬浮输入框的两个几何读数**(§5.6;W5-c 从 `components/AppShell.tsx` 原样搬来)。
 *
 * 输入框绝对定位在这片叶的底部之后,有两件事只有真实的排版说得出来:
 *
 *   `--composer-h`  输入框此刻多高。消息流的底部内衬、`scroll-padding-bottom`、
 *                   跟随丸的落位全读它。它会变 —— 打字长高、抽屉开合、附件摞进出、
 *                   状态条出现,每一样都改一次高度,所以它不能是一个魔法数。
 *   `--center-h`    **这片叶多高**。抽屉的高度上限要读它(§5.6:`min(既有上限,
 *                   40%)`)—— 「正文永远露出上半截」这句话只有知道一共有多高才成立。
 *
 * ── 搬家改了什么、没改什么 ────────────────────────────────────────────────
 * 落点从 `.center` 换成 `.chatArea`:**三个消费者(消息流内衬、跟随丸、目录键列)
 * 都在 `.chatArea` 之内**,变量靠继承走,它们一个字不改。`--center-h` 的语义
 * 因此从「中央区多高」收窄成「这片叶多高」—— 而那正是那条上限该有的意思
 * (中央区单叶时两者逐像素相同;分屏时上限跟着自己这半格缩,是对的)。
 * 名字没改:它被三份样式表按名字读着,改名是另一单。
 *
 * ── 它为什么曾经打转,以及为什么现在写在下一帧(09-14)────────────────────
 * 这里从前写着「写 CSS 变量本身不改任何几何,所以没有回路」—— 那句话错了一半。
 * `--composer-h` 的第一个读者是消息流滚动容器的 `padding-block-end`
 * (`ChatStream.module.css`),而 ResizeObserver 缺省量的是 **content-box**:内边距
 * 一变,那只容器的 content-box 当场变,它与输入框底座是 `.chatArea` 下**同深度的
 * 兄弟** —— Chrome 于是判「同深度上还有没派送的通知」,用户屏幕上每打一行字弹一次
 * 「ResizeObserver loop completed with undelivered notifications」(隔离真机:
 * 12 行 5 次、清空 1 次、6 行长文 5 次,每一次前 1ms 都是这只回调)。
 * 治法与 `ui/Tabs` 同一条律(`ui/frame-coalescer.ts` 文件头):**观察器回调只读不写,
 * 量到的东西在下一帧交出去**。挂载那一次仍同步 —— 它不在任何派发循环里,而消息流
 * 的首帧内衬要靠它。代价是输入框长高之后内衬晚一帧跟上(60Hz 下 16ms),而从前
 * 那一帧浏览器本来就把这份通知推到了下一帧,只是顺手报了个错。
 *
 * ── 生命周期 ──────────────────────────────────────────────────────────────
 * 挂载即观察、卸载即断开并**把两格变量抹掉**(留着等于让下一次挂载先读到一份
 * 陈旧的高度)。它是组件级的,不是模块级的 —— 没有跨模块实例存活的东西,
 * 所以不需要 HMR dispose。
 */
function useComposerGeometry(
  areaRef: RefObject<HTMLDivElement | null>,
  dockRef: RefObject<HTMLDivElement | null>,
): void {
  useLayoutEffect(() => {
    const area = areaRef.current
    const dock = dockRef.current
    if (!area || !dock || typeof ResizeObserver !== 'function') return

    const write = (name: string, px: number) => {
      area.style.setProperty(name, `${Math.round(px)}px`)
    }
    const measure = () => {
      write('--composer-h', dock.getBoundingClientRect().height)
      write('--center-h', area.getBoundingClientRect().height)
    }
    measure()

    const coalescer = new FrameCoalescer(measure)
    const observer = new ResizeObserver(() => coalescer.schedule())
    observer.observe(dock)
    observer.observe(area)
    return () => {
      coalescer.cancel()
      observer.disconnect()
      area.style.removeProperty('--composer-h')
      area.style.removeProperty('--center-h')
    }
  }, [areaRef, dockRef])
}

/**
 * **这一格此刻在显示哪条会话**(W1-b;W5-b 起它按 `ref.key` 各说各的)。
 * 一个**零 DOM 的叶子组件**。
 *
 * 设计 §2.2 的 D 稿:「只有一片会话叶时,顶栏画的就是那一个标签 = 今天的会话
 * 标题」。会话多开之后这句话推广成:**每一格会话标签画的是它自己那条会话的名字**
 * —— 而那正是「身份由内容自答」这条契约的字面兑现(键 = refId,一格一份)。
 *
 * 为什么单独占一个零 DOM 的组件,而不是几行写进 `SessionLeaf`:那样 `SessionLeaf`
 * 就订上了整张会话表,**会话列表一动整条聊天流重渲一遍**(09-03 流式卡死那一批
 * 的同型病:订阅按「谁真的读那个值」算,不按「谁方便挂」算)。这样一来重渲的
 * 只有它自己,而它渲染 `null`。
 *
 * 生命周期:随这片叶挂载 / 卸载;卸载时**收回**那格活标题(留着等于让下一次挂载
 * 先读到一份陈旧的名字)。组件级,不是模块级 —— 不需要 HMR dispose。
 */
function SessionIdentity({
  contentRef,
  sessionId,
}: {
  contentRef: ContentRef
  sessionId: string
}): null {
  const tr = useT()
  const sessions = useSessionsSource((st) => st.sessions)
  // 会话标题是**数据**(用户或后端给这条会话起的名),不翻译;
  // 只有「这一格还没绑会话」时的兜底名才是界面文案。
  const text = findSession(sessions, sessionId)?.title ?? tr('topbar.newSession')
  const id = refId(contentRef)
  useEffect(() => {
    useLiveTitleStore.getState().setLiveTitle(id, { text })
    return () => useLiveTitleStore.getState().setLiveTitle(id, null)
  }, [id, text])
  return null
}

/**
 * **播种时摆哪条会话**(`ContentKind.resident.seed` 的落点,裁定 2)。
 *
 * 「此刻的当前会话」——但它得**真的还在名册上**:死会话清洗那一拍会调到这里
 * (`sweepRefs` 把最后一格常驻原位换成新播的那一格),而那时投影里那条恰恰是
 * 刚被删掉的。名册里没有 = 答保留键,也就是「一片还没绑会话的会话叶」。
 *
 * 名册还没到(冷启动头几帧)时**也答保留键**:那时 `currentSessions()` 是空表,
 * 而「猜一条会话」比「诚实地画一片空会话叶」糟得多 —— 投影随后会把它换掉。
 *
 * 它长在这只文件里而不是投影那只,是因为 `seed()` 是**这一种内容的自述**:
 * 「出厂那一片摆哪条会话」只有会话自己答得出。核心层照旧不认识这个字符串。
 */
export function seedSessionKey(): string {
  const id = useExposeStore.getState().currentSessionId
  if (!id) return NEW_SESSION_KEY
  return currentSessions().some((session) => session.id === id) ? id : NEW_SESSION_KEY
}

registerContentKind(
  {
    id: SESSION_KIND,
    /*
     * **不是单例**(裁定 1):两条会话可以并排各占一片叶,同一条会话也可以在
     * 两处各开一格(拖一份到旁边对照着看 —— 与 `file` 同一条理由)。
     */
    singleton: false,
    /*
     * 常驻中央区。`seed()` 每次播种现问一次「此刻该摆哪条会话」——
     * 判据本体在 `content/session-projection.ts`(它认得投影与名册),
     * 这一行只是把那句话挂在自己的自述上。
     */
    resident: { region: CENTER_REGION, seed: seedSessionKey },
    /*
     * **`regions` 缺席 = 哪个区域都行**(裁定 8)。W1 这里写着 `[CENTER_REGION]`,
     * 那时的注脚是「撕进浮窗 / 钉到边由 W5 解禁,解禁 = 改这一行」——
     * 兑现的方式正是**删掉**这一行。
     */
    /**
     * **静态那一半**。会话名是数据,所以能问到名册就问名册(两片叶的标签因此
     * 各画各的名字,不必等活标题那一半到);问不到(还没绑 / 名册还没到)才落回
     * 界面文案。活的那一半由 `SessionIdentity` 发布进 `stage/live-title`,
     * 活的盖静的。
     *
     * 读的是当下语言 —— 檐自己 `useT()` 订着 locale,切语言会重渲 tab 条,
     * 这一句于是重跑一次(非组件上下文的 `t()` 用法)。
     */
    title: (ref) => {
      const id = sessionIdOfRef(ref) ?? ''
      const named = id ? findSession(currentSessions(), id)?.title : undefined
      return { text: named ?? t('topbar.newSession') }
    },
    icon: () => 'MessagesSquare',
    render: (ref) => <SessionLeaf contentRef={ref} />,
    /*
     * **激活这一格 = 焦点进它的输入面板**(W7-t / B3,`ContentKind.focusInto`)。
     *
     * 报障:点一格会话标签,焦点落在消息流上,直接打字进不去。而 §3.5 规则 1/2
     * 的原话就是「应用启动时是主内容(有会话则是它的输入面板)」「开会话 → 它的
     * 输入面板」—— 切一格会话标签与开一条会话是同一件事的两种手势,该落在同一处。
     *
     * 它是**这一种的自述**,不是 `focus-into` 里的一条 if:壳只读表,于是那只
     * 文件里一个种类名都没有(判词在 `ContentKind.focusInto` 上)。
     */
    focusInto: 'composer',
    /*
     * **同类再开一格 = 建一条新会话**(K2,⌘T / ⌘N 在一片会话叶上)。
     *
     * 走的是 `newSessionDetached` —— 与 ⌘N 那条老路**同一条创建路、同一个项目
     * 判据**(当前环境会话所属的项目),差的只是摆放那一半:那一条在焦点会话叶
     * 上原位换会话,这一条什么都不摆,由叫它的那片叶摆到当前标签旁边。判词整段
     * 在 `expose/store.ts` 的 `NewSessionSeat` 上。
     *
     * 这一种**不点名焦点**:摆进来的新那一格自带一块输入面板(W5-c),而摆放那
     * 一头会激活它 —— 激活走 `focusIntoRef`,它读的正是下面那格 `focusInto`,
     * 于是焦点落在**新那一格自己的**输入框上。不需要在这里搬第二次。
     *
     * 建不成(后端拒 / 一次创建已经在飞)答 `null`,叶那一头什么都不做。
     */
    spawn: async () => {
      const id = await useExposeStore.getState().newSessionDetached()
      return id ? { kind: SESSION_KIND, key: id } : null
    },
    /**
     * **关掉 = 丢实例**(与 `file` / `pair` 同一条)。这一种要清的是**这条会话
     * 那块输入面板留下的两样**:那一份草稿(W7-t / B2)与那一份面板状态
     * (W5-c-2)。输入框里没发出去的话、挂着的附件、开着的抽屉都跟着会话走,
     * 会话被关掉之后留着它们等于让下一次开同一条会话读到一份陈年的现场。
     *
     * 数据机器(`chat-source`)的寿命**不在这里** —— 它由引用账管(判词在
     * `content/session-projection.ts`:六条路会让一格会话离开树,`dispose` 只是
     * 其中一条,各写一遍迟早漏)。草稿相反:它只有「这条会话被真的关掉」这一个
     * 丢弃时机,藏起来的会话叶照样该留着稿。
     */
    dispose: (ref) => {
      /*
       * **空串是一格键,不是缺席**(09-06 审查逮到的账):`sessionIdOfRef` 对
       * 「新会话」那格保留键答的是 `''`(「是会话叶,但还没绑」),对「根本不是
       * 会话」才答 `null` —— 两者在调用方这里从来不是一件事(判词在
       * `content/session-ref.ts` 与 `composer/drafts.ts` 上,后者明写「不拿空串
       * 当缺席」)。修前这一句写的是 `if (id)`,于是**关掉「新会话」那一格永远
       * 丢不掉它的稿**(连同挂着的附件 URL),与「关掉 = 唯一的丢弃时机」相悖。
       */
      const id = sessionIdOfRef(ref)
      if (id === null) return
      dropComposerDraft(id)
      /*
       * **这条会话那块输入面板的状态**(W5-c-2):抽屉、搜索词、ask、附件、状态条
       * 都住在 `composerStoreFor(id)` 那一份里,与草稿同一个丢弃时机、同一条
       * 「藏起来的会话叶照样留着」。少这一句 = 关掉再开同一条会话,人会看见上一
       * 次留在那儿的抽屉与附件。
       */
      disposeComposerStore(id)
    },
  },
  import.meta.hot,
)
