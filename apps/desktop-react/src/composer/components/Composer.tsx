import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { DragEvent } from 'react'
import { useT } from '../../i18n'
import { ChevronDown, resolveIcon } from '../../components/icons'
import { DEV_COMMANDS } from '../data'
import { BUILTIN_COMMANDS, mergeCommands, useCommandsSource } from '../../data/commands-source'
import { useMeterSource } from '../../data/meter-source'
import { useSkillsSource } from '../../data/skills-source'
import {
  ensureCatalog,
  modelMutation,
  selectKey,
  useCurrentModelSelection,
  useThinkingState,
} from '../../data/models-source'
import { useAsyncPending } from '../../data/kernel'
import { useExposeStore } from '../../expose/store'
import { composerSink, useComposerBusy } from '../sink'
import { readComposerDraft, saveComposerDraft } from '../drafts'
import type { ComposerDraft } from '../drafts'
import { revokeAllAttachments, useComposerStore } from '../store'
import { configureComposerReferenceSink } from '../references'
import { isTypingTarget, THINKING_LABEL_KEY, thinkingRungOf } from '../transitions'
import { useComposerSend } from '../useComposerSend'
import { useEscStop } from '../useEscStop'
import { usePickDrawer } from '../usePickDrawer'
import { FocusScope } from '../../focus/FocusScope'
import { ButtonBase } from '../../ui/ButtonBase'
import { useFloatDismiss } from '../../ui/float'
import { IconButton } from '../../ui/IconButton'
import { AskForm } from './AskForm'
import { AttachmentStack } from './AttachmentStack'
import { ComposerInput } from './ComposerInput'
import type { ComposerInputHandle } from './ComposerInput'
import { DrawerModelPicker } from './DrawerModelPicker'
import { DrawerPickList } from './DrawerPickList'
import { DrawerStatus } from './DrawerStatus'
import { ContextRing, MeterCard } from './MeterCard'
import { StatusBar } from './StatusBar'
import s from './Composer.module.css'

const PaperclipIcon = resolveIcon('Paperclip')
/* ui-consume-allow: kbd-select-handwritten — 这是**图标名**不是键名。批 9c 把
 * 候选列表整只搬进 `usePickDrawer`(它 import 了 `ui/a11y/list-selection`),
 * 这个文件从此一句 ↑↓ 走法都没有;规则按 `'ArrowUp'` 字面扫,而发送键那颗
 * 上箭头图标恰好就叫这个名。 */
const SendIcon = resolveIcon('ArrowUp')
/** 忙态下发送键换的那张脸:方形停止。实心 —— 停止是一个「按下去就结束」的动作。 */
const StopIcon = resolveIcon('Square')

/**
 * 一块面板,三个器官(08-29 定稿的「Composer 形态学」):
 *
 *   本体行  —— write ⇄ ask 两种形态,交叉淡变;
 *   抽屉槽  —— **一个**槽,@ 文件 / 命令 / 模型 / 执行状态轮流住,后来者顶替先来者;
 *   状态条  —— 有执行时常驻,点它开合状态抽屉,执行完只换成绿点、不消失。
 *
 * 没有任何浮层菜单。两层不占布局的浮物挂在面板外:拍立得附件摞、读数明细卡 ——
 * 它们 absolute,所以 composer 的几何在任何时候都零变化。
 *
 * 这个文件只做**编排**:谁在场、谁让位、键盘归谁。判断在 transitions,状态在 store,
 * 三条自带状态的行为各自成 hook(09-02 批 9c 拆出来的四条切线):
 *   `usePickDrawer`    —— 抽屉里那两位输入驱动的住户(候选、键盘位、选中);
 *   `useComposerSend`  —— 发送的三口(命令岔口、惰性建会话、两把防重闸);
 *   `useEscStop`       —— Esc 的两段式停止(预备态与它的三条拆除路);
 *   ~~`useComposerKeys`~~ —— **09-03 R2 退役**:这块面的键不再是一条 window
 *   监听,而是响应链上那一格的声明(Esc 三层 = `onEscape`,ask 的 ← → =
 *   作用域根上的行内结构键)。
 * 留在这里的只剩「谁在场」:store 的订阅、三条 hook 的接线、和那棵树。
 *
 * ── 三张状态表(09-01 用户令「状态先行」) ──────────────────────────────────
 *
 * **① 生命周期**:挂载四处、卸载三处,**没有换宿主这回事** —— 这块面全仓只有
 * 一个落点(`components/AppShell.tsx:356`,舞台底部),不进浮窗 / 架子 / 盖,
 * 所以「檐怎么合、滚动谁管、尺寸谁定」三问在这里都不成立。
 *   挂载:① `openMeter(sessionId)` 订读数(换会话重订 + 重拉;无会话是缺席态,
 *   不发请求);② `ensureCatalog(selection.provider)` 拉当前这一家的目录(环要
 *   画百分比就得知道窗口多大;已拉过的直接返回);③ `ensurePluginCommands()` 与
 *   `ensureSkills(cwd)` —— **都不在这里**,它们懒在命令抽屉第一次开的时候
 *   (`usePickDrawer`);
 *   ④ `registerComposerFocus(…)` 登记「把光标交过来」那一口。
 *   卸载:① `revokeAllAttachments()`;② `registerComposerFocus(undefined)`;
 *   ③ Esc 预备态那只计时器(在 `useEscStop` 里收)。另有两个跟着 hook 走的
 *   监听(`useComposerKeys` 的 window keydown、`useFloatDismiss` 的点外关),
 *   各自 effect 自己收。
 *
 * **② UI 生命状态**(09-12 结清了候选列表那三态):
 *   · empty —— 候选列表的「无匹配」,而它现在**只在 ready 且真的零条**时才说;
 *   · loading —— 候选在飞且手上没有旧候选时,列表画一行「正在找…」(纯文字,
 *     Spinner 只许在按钮内 / 状态栏);有旧候选就**留屏**,不闪。切模型仍旧只在
 *     药丸上挂 `aria-busy`,建会话 / 跑命令那两段往返**刻意**不画(理由在
 *     `useComposerSend` 的两把闸上);
 *   · error —— 候选拉失败:旧候选留屏 + 一行弱色错误文字(不换底)。命令失败仍旧
 *     走 `notify` 的通知面、不落在这块面上。
 *   判据整张表在 `DrawerPickList` 的文件头(`fileStatus` 由 `usePickDrawer` 交下来)。
 *
 * **③ UI 交互状态**:
 *   · 药丸:rest / hover / focus 走 `ButtonBase` + `.modelPill` 皮肤;切模型在飞
 *     时挂 `aria-busy` 但**永不禁用**(禁了连抽屉都开不了,与 AgentChip 同一条
 *     律③),「不可再点」那一半的闸落在抽屉的 commit 里,两处读同一格
 *     (`selectKey(sessionId)`);
 *   · 发送键:一颗按钮两副面孔,`data-mode` 是「此刻是哪副面孔」的产地,
 *     `data-testid` 恒定(门按位置找它,不按状态找);
 *   · 输入框:占位符在 Esc 预备期换成「再按一次停止」—— 两段式的第一段是静默的;
 *   · **`disabled` 全文件 0 处,是刻意的**:没有一个控件会因为「在飞」而变灰。
 *     空话不禁发送键(按下去什么都不发,话还在框里),忙时它换的是脸不是可用性。
 */
export function Composer() {
  const t = useT()
  const drawerKind = useComposerStore((st) => st.drawerKind)
  const mode = useComposerStore((st) => st.mode)
  const askSpec = useComposerStore((st) => st.askSpec)
  const status = useComposerStore((st) => st.status)
  const closeDrawer = useComposerStore((st) => st.closeDrawer)
  const toggleModelDrawer = useComposerStore((st) => st.toggleModelDrawer)
  const toggleStatusDrawer = useComposerStore((st) => st.toggleStatusDrawer)
  const addFiles = useComposerStore((st) => st.addFiles)
  const openAsk = useComposerStore((st) => st.openAsk)
  const moveAsk = useComposerStore((st) => st.moveAsk)
  const rejectAsk = useComposerStore((st) => st.rejectAsk)
  const send = useComposerStore((st) => st.send)
  /* 引擎在不在跑 —— 唯一产地在 data/chat-source.ts,这里只是接上订阅。 */
  const busy = useComposerBusy()

  /* ── D2 波一:药丸与读数的三条接线。它们在这一层而不是各自的组件里,理由同
   * 四条 hook 的接线:这个文件做**编排**(谁在场、谁要什么事实),组件只画。 */
  const sessionId = useExposeStore((st) => st.currentSessionId)
  // 药丸上写谁:三层事实里推出来的那一个(见 resolveModelSelection)。
  const selection = useCurrentModelSelection(sessionId)
  /* 律③:切模型这一发在飞时,药丸上 `aria-busy`(判据全文见文件头第③表)。 */
  const switchingModel = useAsyncPending(modelMutation, selectKey(sessionId))
  /*
   * 药丸右半那一格档位(09-05 庚)。判据在 `thinkingStateOf`(它照抄发送链),
   * 落到「屏幕上是哪一根档」在 `thinkingRungOf` —— 这一层只把两者接起来。
   * `null` = 这一型不思考 / 目录还没到 → 药丸只写名,不写「· 未知」。
   */
  const thinking = useThinkingState(selection)
  const thinkingRung = thinkingRungOf(thinking)
  const openMeter = useMeterSource((st) => st.open)
  const refreshMeter = useMeterSource((st) => st.refresh)

  // 读数跟着会话走:换一条就重订 + 重拉(没有会话时是缺席态,不发请求)。
  useEffect(() => {
    void openMeter(sessionId || null)
  }, [sessionId, openMeter])

  /* 环要画出百分比就得知道**这个模型的窗口多大**,而窗口在 provider 目录里。
   * 所以当前这一家的目录是要拉的 —— 但只拉这一家(抽屉打开时才拉其余的)。
   * 已经拉过的直接返回,所以这个 effect 反复跑不产生往返。 */
  useEffect(() => {
    if (selection?.provider) void ensureCatalog(selection.provider)
  }, [selection?.provider])

  const panelRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<ComposerInputHandle | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const [dragging, setDragging] = useState(false)
  const [meterOpen, setMeterOpen] = useState(false)

  /* 命令表是**两条切线共用的一件事实**(抽屉要拿它筛候选,发送要拿它认命令),
   * 所以合表留在编排点:内置那七条是编译期常量,插件与技能两半由抽屉懒拉进各自的
   * store(技能按 cwd)。四张表的先后在 `mergeCommands` 里排定,不在这里排。 */
  const pluginCommands = useCommandsSource((st) => st.pluginCommands)
  const skillCommands = useSkillsSource((st) => st.commands)
  const allCommands = useMemo(
    () =>
      mergeCommands({
        builtin: BUILTIN_COMMANDS,
        skill: skillCommands,
        plugin: pluginCommands,
        dev: DEV_COMMANDS,
      }),
    [skillCommands, pluginCommands],
  )

  /* 切线 D:抽屉里那两位输入驱动的住户。十格正好是下面两个组件要的全部。 */
  const pick = usePickDrawer({ allCommands, sessionId, inputRef, drawerKind, openAsk, closeDrawer })

  /* 切线 C:发送的三口。交出来的只有 `doSend` —— 输入框的回车与发送键读同一个它。 */
  const doSend = useComposerSend({ allCommands, sessionId, inputRef, openAsk, closeDrawer, send })

  /*
   * ── 切线 A:Esc 的两段式停止 ──────────────────────────────────────────
   * 「焦点在这块面板里」那个前提 R2 之后**不再是一句判据,而是结构**:
   * `tryStop` 的唯一调用点是下面那句 `onEscape`,而树只在这块面在活动路径上时
   * 才问它(理由整段写在 `useEscStop` 的文件头)。
   */
  const escStop = useEscStop(busy, () => composerSink().abort())

  /*
   * ── 切线 B 退役:Esc 三层成了一句 `onEscape` ────────────────────────────
   * 次序一个字没改(ask 拒答 → 收抽屉 → 两段停止),换的是它靠什么成立:从前是
   * 一条 window keydown 监听里的三条分支,现在是这块面在响应链上那一格的
   * `onEscape` —— **答 true = 这一下归我**,由那唯一的派发器代劳 preventDefault
   * 并停止继续往外问。三条都不成立就答 false,这一下原样传给外面的层
   * (§11 拍点 3 的裁定:输入面板先答,轮不到它才是退层链)。
   *
   * `drawerKind` 仍然**当场现读**(`getState()`)而不是订阅:它每敲一个字都在变,
   * 而这只闭包走 `escapeRef`,读到的永远是这一帧的事实(理由与从前那条
   * 「不进依赖表,免得每敲一个字重排一次 window 监听队列」同源)。
   */
  const onEscape = useCallback(() => {
    if (mode === 'ask') {
      rejectAsk()
      return true
    }
    if (useComposerStore.getState().drawerKind) {
      closeDrawer()
      return true
    }
    // 没有任何一层浮着:焦点在这块面板里、且引擎在跑 → 两段式停止。
    return escStop.tryStop()
  }, [mode, rejectAsk, closeDrawer, escStop])

  /**
   * 落点:**write 形态是那块可编辑区,ask 形态是自由答案那一格**。
   *
   * 两格不是一件事的两种写法:ask 在场时那块可编辑区整个不可见(`.modeOff`),
   * 把焦点送到一块看不见的东西上,人看到的就是「光标不见了」。而 ask 这一形里
   * 唯一能打字的地方就是「其他」那一行 —— 所以它是那一形的落点。
   * `askFreeRef` 由 `AskForm` 铺(它自己不再写任何 `.focus()`:点记号 = 一句
   * `activate()`,焦点落哪儿由这一格答)。
   */
  const askFreeRef = useRef<HTMLSpanElement>(null)
  const restingTarget = useCallback(
    () => (mode === 'ask' ? askFreeRef.current : inputRef.current?.element() ?? null),
    [mode],
  )

  /* ── 点 composer 外面:瞬态抽屉(模型)一律关,选没选都关 ────────────────
   * 只关模型:files / commands 由输入驱动,状态抽屉是人主动开的,都不该被一次
   * 别处的点击收走。
   *
   * 09-01 批 4:这一段从手写迁进 `ui/float` 的 `useFloatDismiss` —— 它就是那件
   * 原语说的「点外关」,判据(点没点在我这块面里)与 Menu / Popover 逐字相同。
   * `outside: 'capture'` —— 照旧走捕获阶段,免得被别处的 stopPropagation 挡住
   * (Select / Tabs / FloatWindow / AgentChip 各有一句 onPointerDown 掐断,
   * React 合成事件那一下会连原生冒泡一起停)。
   *
   * 从前这里还有一格 `escape: false`(「这块面的 Esc 是自己那三层,不许原语插
   * 一脚」)。09-02 R1 之后**原语里已经没有 Esc 那一半了** —— 它归响应链,而
   * composer 本批还没接树(R2),所以它自己那三层照旧由 `useComposerKeys` 的
   * window 监听接。那格 prop 随着浮层栈一起退役,语义一个字没变。 */
  useFloatDismiss(panelRef, closeDrawer, drawerKind === 'model', { outside: 'capture' })

  /*
   * ── **一条会话一份草稿**(W7-t / B2,判词整段在 `composer/drafts.ts`)────────
   *
   * 这块面板只有一只(路线 B:它在 `.center` 上、不进树),而屏幕上会话有好几条
   * —— 修前的下场是真机读数第 79 条:在 A 里打的字跟着切标签跑到 B 里,再打一句
   * 就把 A 的稿顶掉了。修法与 W5-a 同一条路:**状态按 sessionId 分家**,这只组件
   * 渲染的是「当前活动会话那一份」。
   *
   * 三件事写在这一段里:
   *  · **`useLayoutEffect`**:铺稿要排在这一帧绘制**之前**,不然切标签会先闪一帧
   *    上一条会话的字。它的 cleanup 也因此排在 `revokeAllAttachments` 那条
   *    passive cleanup **之前** —— 整台壳下场时稿先存走(附件跟着进表),
   *    那一口才不会把刚存走的 URL 销掉;
   *  · **先存旧的、再铺新的**,两件在同一拍里做完;
   *  · 附件那半边走 store 的 `setState`(它是这块面板的状态产地),
   *    `attachments` / `attOpen` 两格一起搬 —— 摞开着与摞里有什么是同一件事的两半。
   *
   * `sessionId` 是**投影**(焦点叶那一格活动会话标签,`content/session-projection`),
   * 所以「切一格会话标签」与「从列表里换一条会话」走的是同一条路,不必各接一遍。
   */
  const shown = useRef<string | null>(null)
  /*
   * **「此刻这块面板的一份稿」只有一个说法**(09-06 审查):存稿有两处
   * (换会话时存旧的 / 卸载时存当下那份),两处各拼一遍 `{ html, attachments,
   * attOpen }` 的下场是草稿再多一格字段就要改两处 —— 而漏改的那一处不会报错,
   * 只会悄悄丢掉那一格。这只闭包因此是**唯一产地**:它读的是这块面板此刻的
   * 两个真相(可编辑区的 HTML、store 里的附件),不带任何时机的判断。
   */
  const snapshotDraft = useCallback((): ComposerDraft => {
    const live = useComposerStore.getState()
    return {
      html: inputRef.current?.html() ?? '',
      attachments: live.attachments,
      attOpen: live.attOpen,
    }
  }, [])
  useLayoutEffect(() => {
    const prev = shown.current
    if (prev === sessionId) return
    if (prev !== null) saveComposerDraft(prev, snapshotDraft())
    const next = readComposerDraft(sessionId)
    inputRef.current?.restore(next.html)
    /* `ComposerState.attachments` 是可变数组,草稿表里那份是 readonly ——
     * 交出去的是**一份拷贝**,于是表里那份不会被这块面板后面的增删改到。 */
    useComposerStore.setState({ attachments: [...next.attachments], attOpen: next.attOpen })
    shown.current = sessionId
  }, [sessionId, snapshotDraft])
  useLayoutEffect(
    () => () => {
      const at = shown.current
      if (at === null) return
      saveComposerDraft(at, snapshotDraft())
      /* 存走之后本地这一份就不是「还挂着的」了 —— 交给下面那口销的只该是
       * 真的没人要的。附件的 URL 此刻活在草稿表里,由 `dropComposerDraft` 销。 */
      useComposerStore.setState({ attachments: [], attOpen: false })
    },
    [snapshotDraft],
  )

  // 整块面板下场时把还挂着的缩略图 URL 销掉(造它的是 store,所以销也调 store 那口)。
  useEffect(() => revokeAllAttachments, [])

  /*
   * **外面往输入框里落一枚引用**的那条缝(B3-b;判词整段在 `composer/references.ts`)。
   * 登记在这里而不是在 store 里,是因为落点是**这块可编辑区的 DOM**(chip 是真节点),
   * 而摸得着它的只有这只句柄。登记与撤销都由这只 effect 管 —— 一处开一处关。
   */
  useEffect(
    () =>
      configureComposerReferenceSink((reference) => {
        inputRef.current?.appendReference(reference.label, {
          token: reference.token,
          ...(reference.tip ? { tip: reference.tip } : {}),
        })
      }),
    [],
  )

  /* ── 拖拽落区 = 整块面板 ──────────────────────────────────────────────── */
  const onDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault()
    setDragging(false)
    const list = Array.from(e.dataTransfer?.files ?? [])
    if (list.length) addFiles(list)
  }

  return (
    <FocusScope
      scope="composer"
      rootRef={panelRef}
      restingTarget={restingTarget}
      onEscape={onEscape}
    >
      {({ scopeProps }) => (
    <div className={s.wrap}>
      <div className={s.anchor}>
        <MeterCard open={meterOpen} />
        <AttachmentStack />

        {/*
          * ── ask 的 ← → 是**行内结构键**,所以它挂在作用域根上 ─────────────
          * 结构键不进任何表(快捷键三层的第三层),它们是这套形态语法本身;
          * 而「翻到上一题 / 下一题」正是 ask 这一形里的结构导航。判据一个字没改:
          * ask 在场、且焦点不在任何输入面里(写字的人按方向键是在移动光标)——
          * 只是「焦点在哪儿」从 `document.activeElement` 换成了这一下按键的 target
          * (真机上两者恒等,而后者不必去问一个全局)。
          */}
        {/* eslint-disable-next-line jsx-a11y/no-static-element-interactions --
          * 规则拦的是「给死元素装交互却不给焦点」——这块面的焦点在里面那些真控件上
          * (输入框 / 药丸 / 发送键),这里挂的是**容器级手势**的委托,
          * 与 `search/components/SearchPanel` 那一处同判例。 */}
        <div
          {...scopeProps}
          className={dragging ? `${s.panel} ${s.dragging}` : s.panel}
          /* 玻璃那块面自己的把手 —— `gate:chat-follow` 要量它的矩形与它此刻
           * 透不透明(§5.6)。`data-testid` 恒定,门按位置找它、不按状态找。 */
          data-testid="composer-panel"
          onDragOver={(e) => {
            e.preventDefault()
            setDragging(true)
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={onDrop}
          onKeyDown={(e) => {
            if (mode !== 'ask') return
            if (e.target instanceof Element && isTypingTarget(e.target)) return
            if (e.key === 'ArrowLeft') {
              e.preventDefault()
              moveAsk(-1)
            }
            if (e.key === 'ArrowRight') {
              e.preventDefault()
              moveAsk(1)
            }
          }}
        >
          {status && (
            <StatusBar
              status={status}
              open={drawerKind === 'status'}
              onToggle={toggleStatusDrawer}
            />
          )}

          {/*
            * 抽屉:一个槽,四种住户,内容按 kind 换。
            *
            * ── 09-12 两处改动,骨架一格没动 ─────────────────────────────────
            * ① 它**浮在面板上方**(`position: absolute; bottom: 100%`),不再占
            *    面板的高 —— 于是 `--composer-h` 与抽屉开不开无关,消息流不再被顶。
            *    判词整段在 `.drawer` 的 CSS 上;DOM 上它仍是 `.panel` 的孩子,
            *    响应链作用域 / `useFloatDismiss` 的「外面」/ `:has(.drawerOpen)`
            *    三样因此一个字不改。
            * ② `.drawerInner` 那层没了:它唯一的活是给 `grid-rows 0fr↔1fr` 当
            *    裁剪盒,而那条展开已经判掉(高度一帧到位)。裁剪归 `.drawer`
            *    自己的 `overflow: hidden`(圆角也要它)。
            *
            * `drawerFixed` 只挂给**打字驱动**的两位住户(`pick.picking`):它们的
            * 内容逐字在变,所以要一个不变的框(用户:「直接看到一个固定长度、
            * 固定宽度的最终结果」)。模型 / 执行状态是人主动开的、内容不随打字变,
            * 高照旧由内容定。
            */}
          <div
            className={[s.drawer, drawerKind ? s.drawerOpen : '', pick.picking ? s.drawerFixed : '']
              .filter(Boolean)
              .join(' ')}
            data-testid="composer-drawer"
          >
            <div className={s.drawerBody}>
              {pick.picking && (
                <DrawerPickList
                  kind={drawerKind === 'files' ? 'files' : 'commands'}
                  files={pick.files}
                  fileStatus={pick.fileStatus}
                  commandGroups={pick.commandGroups}
                  index={pick.index}
                  rowRef={pick.rowRef}
                  onPick={pick.applyPick}
                />
              )}
              {drawerKind === 'model' && <DrawerModelPicker />}
              {drawerKind === 'status' && status && <DrawerStatus status={status} />}
            </div>
          </div>

          <div className={s.bodyRow}>
            <div className={mode === 'write' ? s.mode : `${s.mode} ${s.modeOff}`}>
              <div className={s.writeRow}>
                <ComposerInput
                  apiRef={inputRef}
                  placeholder={t(escStop.armed ? 'composer.escStopHint' : 'composer.placeholder')}
                  picking={pick.picking}
                  onToken={pick.onToken}
                  onMove={(delta) => pick.move(delta)}
                  onPick={() => pick.applyPick(pick.index)}
                  onEscape={closeDrawer}
                  onSend={doSend}
                />

                <input
                  ref={fileRef}
                  type="file"
                  multiple
                  className={s.hiddenFile}
                  tabIndex={-1}
                  onChange={(e) => {
                    addFiles(Array.from(e.target.files ?? []))
                    e.target.value = ''
                  }}
                />

                {/*
                  * ── 下行 = 工具行(09-03 用户拍板 B:本体行改两行)────────────────
                  * 报障两条同一个根:①窄档里模型药丸在连字符处折成两行;②输入面多行时
                  * 回形针 / 药丸 / 圆环悬在输入面的竖中线上、发送键沉在底部。病根是
                  * **四件与文本同行** —— 单行沉底只治第二条的症状,第一条照旧。
                  * 所以输入面独占上行撑满,四件退到自己的一行:左边回形针 + 药丸,
                  * 右边圆环 + 发送。四件的 DOM 顺序 / aria-label / data-testid /
                  * data-mode / onClick 一个字没动 —— 挪的是行,不是身份。
                  */}
                <div className={s.toolRow}>
                  <div className={s.toolsLeft}>
                    {/* 回形针消费 `ui/IconButton`(sm 档 22×22,图标 14px —— 与从前
                      * 「--sp-1 内边距 + --composer-attach-icon」逐像素相同)。
                      * 本地那条 `.toolBtn:hover`(只换字色、不换底)是 `icon-button-hover`
                      * 门唯一那条命中,随这次迁移一起删 —— 配方从此只有库件一个产地。 */}
                    <IconButton
                      icon={PaperclipIcon}
                      className={s.toolBtn}
                      label={t('composer.attach')}
                      onClick={() => fileRef.current?.click()}
                    />

                    {/*
                      * 三层事实都答不上来时药丸写的是「选择模型」——**不拿目录里
                      * 第一家第一型去顶**(SessionSummary.model 早就定下的口径)。
                      */}
                    {/* 药丸是结构件(裸钮三类判第③类):描边丸形是这块面自己的语汇,
                      * 所以只接 `ui/ButtonBase` 清 UA,`.modelPill` 皮肤一个像素不动。 */}
                    <ButtonBase
                      className={s.modelPill}
                      /*
                       * 无障碍名要**跟屏幕上一样多**:药丸右半画着档字,只念模型名
                       * 等于让读屏的人听不到「此刻想得多深」。所以有档时换一条带
                       * level 的话,那个词就是 `THINKING_LABEL_KEY` 里屏幕上那一个;
                       * 不思考的型没有档可念,仍走原来那条(不念「思考 无」)。
                       */
                      aria-label={
                        selection
                          ? thinkingRung
                            ? t('composer.modelWithThinking', {
                                name: selection.model,
                                level: t(THINKING_LABEL_KEY[thinkingRung]),
                              })
                            : t('composer.model', { name: selection.model })
                          : t('composer.modelUnset')
                      }
                      aria-expanded={drawerKind === 'model'}
                      aria-busy={switchingModel}
                      onClick={toggleModelDrawer}
                    >
                      {/* 文字必须自成一块:`text-overflow: ellipsis` 只作用于**块级容器里的
                        * 行内文本**,写在这枚 inline-flex 钮身上是空话。截断的产地因此是
                        * `.modelPillLabel`,药丸自己只负责「永不折行」那一半。 */}
                      <span className={s.modelPillLabel}>
                        {selection ? selection.model : t('composer.modelUnset')}
                      </span>
                      {/*
                        * 「GPT-5.5 · 高」的后半截。它是**不弯腰的那一件**:名字长了截断
                        * 名字(律一 —— 一行恰有一个弯腰件),档位这两个字一直看得见,
                        * 否则「此刻想得多深」会先于模型名消失。这一型不思考就整块不画,
                        * 不留一个孤零零的间隔点。
                        */}
                      {thinkingRung && (
                        <span className={s.modelPillLevel}>
                          {t(THINKING_LABEL_KEY[thinkingRung])}
                        </span>
                      )}
                      <ChevronDown className={s.pillChev} strokeWidth={2} aria-hidden="true" />
                    </ButtonBase>
                  </div>

                  <div className={s.toolsRight}>
                    {/* 开卡的那一眼要是最新的:悬停 / 聚焦时顺手再拉一次读数
                        (Vue 壳 InputBox 的同一判例)。没有会话时 refresh 是恒等。 */}
                    <ContextRing
                      onEnter={() => {
                        setMeterOpen(true)
                        void refreshMeter()
                      }}
                      onLeave={() => setMeterOpen(false)}
                    />

                    {/*
                     * 一颗按钮两副面孔:闲时发送(↑),忙时停止(■)。
                     *
                     * **不是两颗按钮**,理由是手感:发送键的位置是肌肉记忆里的一个点,
                     * 在旁边再长一颗停止键会让那个点在两种状态下指向不同的东西。
                     * `data-testid` 因此**恒定**(门按位置找它,不按状态找),
                     * 状态挂在 `data-mode` 上 —— 那才是「它此刻是哪副面孔」的产地。
                     *
                     * ── 09-01 批 3.5 的裁定:**签名件走 `ui/ButtonBase`** ────────
                     * 批 3 在这里当场停,报的缺口是「IconButton 不透传」。缺口这批补上了
                     * (IconButton 现在摊 ButtonHTMLAttributes),但**这一处仍然不迁
                     * IconButton** —— 编排拍定:发送键是 accent **实底圆**的签名件,
                     * 而 `ui/IconButton` 是「檐上那种钮」,无边框、无实底、只换字色。
                     * 把实底主色塞进 IconButton 等于给它长一整个实底家族,那件立件的
                     * 前提(配方单一)当场没了。所以走裸钮三类判第③类:
                     * **结构性交互件 → `ui/ButtonBase`**(只清 UA,一个像素都不画),
                     * 皮肤 `.sendBtn` 原样留在本地当签名件皮肤。
                     * `data-mode` / `aria-label` / `onClick` 经 ButtonBase 原样透传,
                     * `type='button'` 是它的默认档,所以这里不必再写一遍。
                     */}
                    <ButtonBase
                      className={s.sendBtn}
                      aria-label={busy ? t('composer.stop') : t('composer.send')}
                      data-testid="composer-send"
                      data-mode={busy ? 'stop' : 'send'}
                      onClick={() =>
                        busy ? composerSink().abort() : doSend(inputRef.current?.text() ?? '')
                      }
                    >
                      {busy ? (
                        <StopIcon
                          className={s.sendIcon}
                          strokeWidth={2.4}
                          fill="currentColor"
                          aria-hidden="true"
                        />
                      ) : (
                        <SendIcon className={s.sendIcon} strokeWidth={2.4} aria-hidden="true" />
                      )}
                    </ButtonBase>
                  </div>
                </div>
              </div>
            </div>

            {/* ask 形态:本体的另一副样子,不是抽屉里的一块内容。 */}
            <div className={mode === 'ask' ? s.mode : `${s.mode} ${s.modeOff}`}>
              {askSpec && <AskForm spec={askSpec} freeRef={askFreeRef} />}
            </div>
          </div>
        </div>
      </div>
    </div>
      )}
    </FocusScope>
  )
}

