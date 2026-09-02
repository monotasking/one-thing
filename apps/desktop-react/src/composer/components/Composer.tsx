import { useEffect, useMemo, useRef, useState } from 'react'
import type { DragEvent } from 'react'
import { useT } from '../../i18n'
import { ChevronDown, resolveIcon } from '../../components/icons'
import { DEV_COMMANDS } from '../data'
import { BUILTIN_COMMANDS, mergeCommands, useCommandsSource } from '../../data/commands-source'
import { useMeterSource } from '../../data/meter-source'
import {
  ensureCatalog,
  modelMutation,
  selectKey,
  useCurrentModelSelection,
} from '../../data/models-source'
import { useAsyncPending } from '../../data/kernel'
import { useExposeStore } from '../../expose/store'
import { registerComposerFocus } from '../focus'
import { composerSink, useComposerBusy } from '../sink'
import { revokeAllAttachments, useComposerStore } from '../store'
import { useComposerKeys } from '../useComposerKeys'
import { useComposerSend } from '../useComposerSend'
import { useEscStop } from '../useEscStop'
import { usePickDrawer } from '../usePickDrawer'
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
 *   `useComposerKeys`  —— 这块面的全局键(Esc 三层次序、ask 的 ← → 翻题)。
 * 留在这里的只剩「谁在场」:store 的订阅、四条 hook 的接线、和那棵树。
 *
 * ── 三张状态表(09-01 用户令「状态先行」) ──────────────────────────────────
 *
 * **① 生命周期**:挂载四处、卸载三处,**没有换宿主这回事** —— 这块面全仓只有
 * 一个落点(`components/AppShell.tsx:356`,舞台底部),不进浮窗 / 架子 / 盖,
 * 所以「檐怎么合、滚动谁管、尺寸谁定」三问在这里都不成立。
 *   挂载:① `openMeter(sessionId)` 订读数(换会话重订 + 重拉;无会话是缺席态,
 *   不发请求);② `ensureCatalog(selection.provider)` 拉当前这一家的目录(环要
 *   画百分比就得知道窗口多大;已拉过的直接返回);③ `ensurePluginCommands()` ——
 *   **不在这里**,它懒在抽屉第一次开的时候(`usePickDrawer`);
 *   ④ `registerComposerFocus(…)` 登记「把光标交过来」那一口。
 *   卸载:① `revokeAllAttachments()`;② `registerComposerFocus(undefined)`;
 *   ③ Esc 预备态那只计时器(在 `useEscStop` 里收)。另有两个跟着 hook 走的
 *   监听(`useComposerKeys` 的 window keydown、`useFloatDismiss` 的点外关),
 *   各自 effect 自己收。
 *
 * **② UI 生命状态**:ready 是唯一在画的一态。
 *   · empty —— 只有候选列表有(`DrawerPickList` 的 `composer.noMatch`),按长度
 *     判,不读 status;
 *   · loading —— **一处都没画**:`@` 候选在飞时抽屉什么都不变(旧候选留屏),
 *     切模型只在药丸上挂 `aria-busy`,建会话 / 跑命令那两段往返**刻意**不画
 *     (理由在 `useComposerSend` 的两把闸上);
 *   · error —— **一处都没画**:`useFileMentionsSource` 有 `error` 一格而抽屉不读
 *     它,命令失败走 `notify` 的通知面、不落在这块面上。
 *   `@` 候选那三态的留账在 `data/file-mentions-source.ts:50` 与提交 ac384704 里
 *   各记过一次;**本批只记不补** —— 补它们是行为变化,要另批拍板。
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
   * 所以合表留在编排点:内置那七条是编译期常量,插件那一半由抽屉懒拉进 store。 */
  const pluginCommands = useCommandsSource((st) => st.pluginCommands)
  const allCommands = useMemo(
    () => mergeCommands(BUILTIN_COMMANDS, pluginCommands, DEV_COMMANDS),
    [pluginCommands],
  )

  /* 切线 D:抽屉里那两位输入驱动的住户。八格正好是下面两个组件要的全部。 */
  const pick = usePickDrawer({ allCommands, sessionId, inputRef, drawerKind, openAsk, closeDrawer })

  /* 切线 C:发送的三口。交出来的只有 `doSend` —— 输入框的回车与发送键读同一个它。 */
  const doSend = useComposerSend({ allCommands, sessionId, inputRef, openAsk, closeDrawer, send })

  /* 切线 A:Esc 的两段式停止。`armed` 唯一的消费点是下面输入框的占位符。 */
  const escStop = useEscStop(panelRef, busy, () => composerSink().abort())

  /* 切线 B:这块面的全局键。Esc 三层的次序在那个文件里,③ 由 `tryStop` 接。 */
  useComposerKeys({ mode, closeDrawer, rejectAsk, moveAsk, tryStop: escStop.tryStop })

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

  // 整块面板下场时把还挂着的缩略图 URL 销掉(造它的是 store,所以销也调 store 那口)。
  useEffect(() => revokeAllAttachments, [])

  /* 别处(建完一条新会话)要把光标交过来时,叫的就是登记在这里的这一口。
   * 登记的是一个每次都现读 ref 的闭包,所以它不随重渲染失效。 */
  useEffect(() => {
    registerComposerFocus(() => inputRef.current?.focus())
    return () => registerComposerFocus(undefined)
  }, [])

  /* ── 拖拽落区 = 整块面板 ──────────────────────────────────────────────── */
  const onDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault()
    setDragging(false)
    const list = Array.from(e.dataTransfer?.files ?? [])
    if (list.length) addFiles(list)
  }

  return (
    <div className={s.wrap}>
      <div className={s.anchor}>
        <MeterCard open={meterOpen} />
        <AttachmentStack />

        <div
          ref={panelRef}
          className={dragging ? `${s.panel} ${s.dragging}` : s.panel}
          onDragOver={(e) => {
            e.preventDefault()
            setDragging(true)
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={onDrop}
        >
          {status && (
            <StatusBar
              status={status}
              open={drawerKind === 'status'}
              onToggle={toggleStatusDrawer}
            />
          )}

          {/* 抽屉:一个槽,四种住户。开合是 grid-rows 0fr↔1fr,内容按 kind 换。 */}
          <div className={drawerKind ? `${s.drawer} ${s.drawerOpen}` : s.drawer}>
            <div className={s.drawerInner}>
              <div className={s.drawerBody}>
                {pick.picking && (
                  <DrawerPickList
                    kind={drawerKind === 'files' ? 'files' : 'commands'}
                    files={pick.files}
                    commands={pick.commands}
                    index={pick.index}
                    rowRef={pick.rowRef}
                    onPick={pick.applyPick}
                  />
                )}
                {drawerKind === 'model' && <DrawerModelPicker />}
                {drawerKind === 'status' && status && <DrawerStatus status={status} />}
              </div>
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
                  aria-label={
                    selection
                      ? t('composer.model', { name: selection.model })
                      : t('composer.modelUnset')
                  }
                  aria-expanded={drawerKind === 'model'}
                  aria-busy={switchingModel}
                  onClick={toggleModelDrawer}
                >
                  {selection ? selection.model : t('composer.modelUnset')}
                  <ChevronDown className={s.pillChev} strokeWidth={2} aria-hidden="true" />
                </ButtonBase>

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

            {/* ask 形态:本体的另一副样子,不是抽屉里的一块内容。 */}
            <div className={mode === 'ask' ? s.mode : `${s.mode} ${s.modeOff}`}>
              {askSpec && <AskForm spec={askSpec} />}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
