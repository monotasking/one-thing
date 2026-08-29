import { useCallback, useEffect, useRef, useState } from 'react'
import type { DragEvent } from 'react'
import { useT } from '../../i18n'
import { ChevronDown, resolveIcon } from '../../components/icons'
import { ASK_DEMO_SPEC, MOCK_COMMANDS, MOCK_FILES } from '../data'
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

  const panelRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<ComposerInputHandle | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const [dragging, setDragging] = useState(false)
  const [meterOpen, setMeterOpen] = useState(false)

  const picking = drawerKind === 'files' || drawerKind === 'commands'
  const files = drawerKind === 'files' ? matchFiles(MOCK_FILES, pickQuery) : []
  const commands = drawerKind === 'commands' ? matchCommands(MOCK_COMMANDS, pickQuery) : []
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

  const doSend = useCallback(
    (text: string) => {
      if (send(text)) inputRef.current?.clear()
      inputRef.current?.focus()
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
   * Esc 分两层:ask 形态在场时整单拒绝,否则收抽屉。两种都 preventDefault ——
   * 外层(舞台 / 浮窗)按既有约定只在 !defaultPrevented 时才轮到它。
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
  }, [mode, closeDrawer, rejectAsk, moveAsk])

  // 整块面板下场时把还挂着的缩略图 URL 销掉(造它的是 store,所以销也调 store 那口)。
  useEffect(() => revokeAllAttachments, [])

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
                  placeholder={t('composer.placeholder')}
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

                <button
                  type="button"
                  className={s.sendBtn}
                  aria-label={t('composer.send')}
                  data-testid="composer-send"
                  onClick={() => doSend(inputRef.current?.text() ?? '')}
                >
                  <SendIcon className={s.sendIcon} strokeWidth={2.4} aria-hidden="true" />
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
