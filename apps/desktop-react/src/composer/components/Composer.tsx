import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { DragEvent } from 'react'
import { useT } from '../../i18n'
import { ChevronDown, resolveIcon } from '../../components/icons'
import { ASK_DEMO_SPEC, MOCK_COMMANDS, MOCK_FILES } from '../data'
import { ESC_STOP_WINDOW_MS } from '../../components/motion'
import { registerComposerFocus } from '../focus'
import { composerSink, useComposerBusy } from '../sink'
import { revokeAllAttachments, useComposerStore } from '../store'
import { clampPickIndex, matchCommands, matchFiles } from '../transitions'
import type { TokenHit } from '../types'
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
 * 这个文件只做**编排**:谁在场、谁让位、键盘归谁。判断在 transitions,状态在 store。
 */
export function Composer() {
  const t = useT()
  const drawerKind = useComposerStore((st) => st.drawerKind)
  const pickQuery = useComposerStore((st) => st.pickQuery)
  const pickIndex = useComposerStore((st) => st.pickIndex)
  const model = useComposerStore((st) => st.model)
  const mode = useComposerStore((st) => st.mode)
  const askSpec = useComposerStore((st) => st.askSpec)
  const status = useComposerStore((st) => st.status)
  const showPick = useComposerStore((st) => st.showPick)
  const movePick = useComposerStore((st) => st.movePick)
  const setPickIndex = useComposerStore((st) => st.setPickIndex)
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

  const panelRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<ComposerInputHandle | null>(null)

  /* Esc 停止的两段式预备态(拍板与窗口见下方 Esc 注释)。armed 期间占位符换话。 */
  const [escStopArmed, setEscStopArmed] = useState(false)
  const escStopTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const disarmEscStop = useCallback(() => {
    if (escStopTimer.current) clearTimeout(escStopTimer.current)
    escStopTimer.current = null
    setEscStopArmed(false)
  }, [])
  const armEscStop = useCallback(() => {
    if (escStopTimer.current) clearTimeout(escStopTimer.current)
    setEscStopArmed(true)
    escStopTimer.current = setTimeout(() => {
      escStopTimer.current = null
      setEscStopArmed(false)
    }, ESC_STOP_WINDOW_MS)
  }, [])
  // 引擎收尾就拆预备(那一轮已经停了,残留的「再按一次」是在说谎);卸载清计时器。
  useEffect(() => {
    if (!busy) disarmEscStop()
  }, [busy, disarmEscStop])
  useEffect(
    () => () => {
      if (escStopTimer.current) clearTimeout(escStopTimer.current)
    },
    [],
  )
  const fileRef = useRef<HTMLInputElement>(null)
  const [dragging, setDragging] = useState(false)
  const [meterOpen, setMeterOpen] = useState(false)

  const picking = drawerKind === 'files' || drawerKind === 'commands'
  /* 这两条**必须** useMemo:它们进了下面 applyPick 的依赖数组,而数组字面量
   * 每帧都是新身份 —— 不 memo 的话 applyPick 每帧重建,它的 useCallback 等于没写,
   * 吃它的子组件也就每帧重渲染一次。exhaustive-deps 揪出来的就是这条(真 bug 类:
   * 白写的 memo 化)。改的是身份稳定性,不是取值本身 —— 行为一字未变。 */
  const files = useMemo(
    () => (drawerKind === 'files' ? matchFiles(MOCK_FILES, pickQuery) : []),
    [drawerKind, pickQuery],
  )
  const commands = useMemo(
    () => (drawerKind === 'commands' ? matchCommands(MOCK_COMMANDS, pickQuery) : []),
    [drawerKind, pickQuery],
  )
  const pickLen = drawerKind === 'files' ? files.length : commands.length
  const index = clampPickIndex(pickIndex, pickLen)

  /* ── 输入框吐出来的 token:有就开对应抽屉,没有就把选择器收掉 ─────────────
   * 「收掉」只收 files / commands 两位住户 —— 模型与执行状态不是输入驱动的,
   * 打字不该把它们关了。 */
  const onToken = useCallback(
    (hit: TokenHit | null) => {
      if (hit) {
        showPick(hit.kind, hit.query)
        return
      }
      const kind = useComposerStore.getState().drawerKind
      if (kind === 'files' || kind === 'commands') closeDrawer()
    },
    [showPick, closeDrawer],
  )

  const applyPick = useCallback(
    (i: number) => {
      if (drawerKind === 'files') {
        const file = files[i]
        if (file) inputRef.current?.insert('files', file)
        closeDrawer()
        return
      }
      if (drawerKind !== 'commands') return
      const cmd = commands[i]
      if (!cmd) return
      // dev-only:这一批没有引擎,`/ask-demo` 是 ask 形态唯一的扳机。
      // 真接上 ask_user 事件后删掉这条分支与 data.ts 里那一行,形态本身不动。
      if (cmd.action === 'ask-demo') {
        inputRef.current?.clear()
        openAsk(ASK_DEMO_SPEC)
        return
      }
      inputRef.current?.insert('commands', cmd.name)
      closeDrawer()
    },
    [drawerKind, files, commands, closeDrawer, openAsk],
  )

  /*
   * 「此刻正为这句话建一条会话」。ref 而不是 state:它不画任何东西 ——
   * 建会话是一次往返,不该为它长出一个转圈的发送键。
   *
   * 它挡的是**建会话在飞的那段窗口里的第二下发送**(中文输入法一次回车发两下是
   * 真发生过的事)。编排点自己那道闸只防「同时建两条」,防不了「建完之后两下各
   * 补发一次」—— 所以闸必须在这一层:在飞时后来的那几下当没按,话还在框里,无损。
   */
  const starting = useRef(false)

  const doSend = useCallback(
    (text: string) => {
      if (send(text)) {
        inputRef.current?.clear()
        inputRef.current?.focus()
        return
      }
      /*
       * send 说没交出去,两种可能:空话,或者**还没有当前会话**。
       * 空话到此为止(它本来就不该离开输入框);有话则是首开草稿态那一下 ——
       * 「发送」在这里的意思是「开始一段对话」:先惰性建一条,再把这句话发进去。
       * 判空在这里自己做一次,是因为 send 的 false 不区分原因,而这两条路的
       * 归宿完全不同(一条什么都不做,一条要建会话)。
       */
      if (!text.trim() || starting.current) {
        inputRef.current?.focus()
        return
      }
      starting.current = true
      void (async () => {
        try {
          const sessionId = await composerSink().startSession()
          // 没建成:编排点已经 notify(error) 过了,这里**不再加一条 toast**,
          // 也**不清输入框** —— 那句话还在人手里,人可以直接再按一次。
          if (sessionId && send(text)) inputRef.current?.clear()
        } finally {
          starting.current = false
          inputRef.current?.focus()
        }
      })()
    },
    [send],
  )

  /* ── 点 composer 外面:瞬态抽屉(模型)一律关,选没选都关 ────────────────
   * 只关模型:files / commands 由输入驱动,状态抽屉是人主动开的,都不该被一次
   * 别处的点击收走。用捕获阶段,免得被内部的 stopPropagation 挡住。 */
  useEffect(() => {
    if (drawerKind !== 'model') return
    const onDown = (e: PointerEvent) => {
      if (!panelRef.current?.contains(e.target as Node)) closeDrawer()
    }
    window.addEventListener('pointerdown', onDown, true)
    return () => window.removeEventListener('pointerdown', onDown, true)
  }, [drawerKind, closeDrawer])

  /* ── 全局键:Esc 与 ask 的翻题 ──────────────────────────────────────────
   * Esc 分三层,次序即「退掉最近打开的那一层」:
   *   ① ask 形态在场 → 整单拒绝;
   *   ② 抽屉开着     → 收抽屉;
   *   ③ 焦点在这块面板里且引擎在跑 → **停止**(与发送键的忙态同义,D1 开工批)。
   * 三种都 preventDefault —— 外层(舞台 / 浮窗)按既有约定只在
   * !defaultPrevented 时才轮到它,所以「Esc 逐层退出」那条全局承诺没有被抢。
   *
   * ③ 排在最后而不是最前:ask 与抽屉是**看得见的一层**,先退看得见的那层是
   * Esc 在这套壳里一以贯之的语义;没有任何一层浮着时,Esc 才落到「停下这一轮」。
   * 「焦点在这块面板里」是必要条件 —— 不加的话,在总览 / 检索面板里按 Esc
   * 退层时会顺手把后台那一轮停掉,那是一次看不见的破坏。
   *
   * **08-31 拍板:与 Vue 壳同口径,连按两次才停**。第一下只「预备」——占位符
   * 换成「再按一次停止」那句(有草稿时占位符本来不可见,预备就是静默的,
   * 与 Vue 同样的取舍);ESC_STOP_WINDOW_MS(2000ms)内第二下才交 abort。
   * 窗口过期、引擎收尾、面板卸载都拆除预备态。
   *
   * ← → 只在焦点不在任何输入面里时才翻题:写字的人按方向键是在移动光标。 */
  useEffect(() => {
    const typing = () => {
      const el = document.activeElement
      if (!(el instanceof HTMLElement)) return false
      // contenteditable 两种问法都要问:isContentEditable 是浏览器的算好值,
      // 属性是它的产地 —— 只信前者会在没实现该字段的宿主(jsdom)上漏判。
      return (
        el.tagName === 'INPUT' ||
        el.tagName === 'TEXTAREA' ||
        el.isContentEditable ||
        el.getAttribute('contenteditable') === 'true'
      )
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (mode === 'ask') {
          e.preventDefault()
          rejectAsk()
          return
        }
        if (useComposerStore.getState().drawerKind) {
          e.preventDefault()
          closeDrawer()
          return
        }
        // 没有任何一层浮着:焦点在这块面板里、且引擎在跑 → 两段式停止。
        const inPanel = panelRef.current?.contains(document.activeElement) ?? false
        if (busy && inPanel) {
          e.preventDefault()
          if (escStopArmed) {
            disarmEscStop()
            composerSink().abort()
          } else {
            armEscStop()
          }
        }
        return
      }
      if (mode !== 'ask' || typing()) return
      if (e.key === 'ArrowLeft') {
        e.preventDefault()
        moveAsk(-1)
      }
      if (e.key === 'ArrowRight') {
        e.preventDefault()
        moveAsk(1)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [mode, busy, escStopArmed, armEscStop, disarmEscStop, closeDrawer, rejectAsk, moveAsk])

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
                {picking && (
                  <DrawerPickList
                    kind={drawerKind === 'files' ? 'files' : 'commands'}
                    files={files}
                    commands={commands}
                    index={index}
                    onHover={setPickIndex}
                    onPick={applyPick}
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
                  placeholder={t(escStopArmed ? 'composer.escStopHint' : 'composer.placeholder')}
                  picking={picking}
                  onToken={onToken}
                  onMove={(delta) => movePick(delta, pickLen)}
                  onPick={() => applyPick(index)}
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
                <button
                  type="button"
                  className={s.toolBtn}
                  aria-label={t('composer.attach')}
                  onClick={() => fileRef.current?.click()}
                >
                  <PaperclipIcon className={s.attachIcon} strokeWidth={1.8} aria-hidden="true" />
                </button>

                <button
                  type="button"
                  className={s.modelPill}
                  aria-label={t('composer.model', { name: model })}
                  aria-expanded={drawerKind === 'model'}
                  onClick={toggleModelDrawer}
                >
                  {model}
                  <ChevronDown className={s.pillChev} strokeWidth={2} aria-hidden="true" />
                </button>

                <ContextRing
                  onEnter={() => setMeterOpen(true)}
                  onLeave={() => setMeterOpen(false)}
                />

                {/*
                 * 一颗按钮两副面孔:闲时发送(↑),忙时停止(■)。
                 *
                 * **不是两颗按钮**,理由是手感:发送键的位置是肌肉记忆里的一个点,
                 * 在旁边再长一颗停止键会让那个点在两种状态下指向不同的东西。
                 * `data-testid` 因此**恒定**(门按位置找它,不按状态找),
                 * 状态挂在 `data-mode` 上 —— 那才是「它此刻是哪副面孔」的产地。
                 */}
                <button
                  type="button"
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
                </button>
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
