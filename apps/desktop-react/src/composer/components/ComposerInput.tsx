import { useImperativeHandle, useRef } from 'react'
import type { KeyboardEvent, RefObject } from 'react'
import { parseToken } from '../transitions'
import type { TokenHit } from '../types'
import s from './Composer.module.css'

/**
 * 本体行的输入面。它是 composer 里**唯一**一块直接动 DOM 的地方,理由是
 * 行内 chip:@ 引用要变成一枚不可编辑的整体(退格是整枚删),
 * 而 React 的受控 value 表达不了「文本 + 不可编辑节点」的混排。
 *
 * 所以这里的分工是:光标在哪、插进哪 —— 宿主的事实,由这个文件量;
 * 「这截 token 算不算触发」「命中哪几条」—— 判断,全在 transitions 里。
 * 这个文件一条业务规则都不许有。
 */

export interface ComposerInputHandle {
  focus: () => void
  /**
   * 把光标处的 @xx / /xx 换成一枚 chip(files)或命令徽(commands)。
   *
   * `token` 是**这枚 chip 在草稿里真正代表的那截文本**(`@` 引用是
   * `{{file:<绝对路径>}}`)。给了就挂在 `data-token` 上,`text()` 交出去时
   * 用它顶替屏幕上那几个字;不给 = 屏幕上写什么、交出去就是什么。
   */
  insert: (kind: 'files' | 'commands', label: string, token?: string) => void
  text: () => string
  clear: () => void
}

/**
 * 把这块可编辑区读成**草稿文本**。
 *
 * 与 `textContent` 的唯一差别是那一句 `data-token`:一枚文件 chip 屏幕上写的是
 * `@src/a.ts`(人心里的名字),而草稿里它代表的是 `{{file:/abs/src/a.ts}}` ——
 * 「chip 是呈现,token 才是位置」正是 `@shared/prompt-references` 里
 * `FILE_REF_PATTERN` 那段注释说的事(Vue 壳把 token 直接放在纯文本草稿里,
 * 由编辑器画成 chip;这块 contenteditable 反过来,chip 是真节点、token 挂在它身上。
 * 两边**交出去的那句话逐字相同**,那才是要紧的)。
 *
 * 其余一切照旧:`<br>` 与 contenteditable 自己包出来的 `<div>` 都不产生换行,
 * 与从前 `textContent` 的行为逐字一致(那是既有口径,这一批不动)。
 */
function readDraft(root: Node): string {
  let out = ''
  for (const node of Array.from(root.childNodes)) {
    if (node.nodeType === Node.TEXT_NODE) {
      out += node.textContent ?? ''
      continue
    }
    const token = node instanceof HTMLElement ? node.dataset.token : undefined
    out += token ?? readDraft(node)
  }
  return out
}

interface Props {
  apiRef: RefObject<ComposerInputHandle | null>
  placeholder: string
  /** files / commands 抽屉是否开着 —— 开着时上下键与回车归抽屉,不归输入框 */
  picking: boolean
  onToken: (hit: TokenHit | null) => void
  onMove: (delta: number) => void
  onPick: () => void
  onEscape: () => void
  onSend: (text: string) => void
}

/**
 * 这一下按键是不是**输入法正在组字**发出来的。
 *
 * 08-31 用户真机报障:中文输入法下打 `hi`、按一下回车,消息发了**两次**。
 * 拼音输入法在候选框开着时按回车,浏览器会先发一个 `keydown`(那是给 IME 的
 * 「确认候选」),IME 结束组字之后**再**发一个真正的回车 keydown。从前这里两下
 * 都当成「发送」,于是同一句话被发两遍 —— 而第一遍还发在候选上屏之前,内容也不对。
 *
 * **两种问法都问**,因为它们的可用性不一样:
 *  · `nativeEvent.isComposing` 是现行标准(Chromium / Electron 上就是这一条),
 *    但它是 `KeyboardEvent` 上的字段,jsdom 造的合成事件里默认是 `undefined`;
 *  · `keyCode === 229` 是老 WebKit / 部分平台 IME 的老约定,今天仍有实现只给这个。
 * 缺哪一条都会漏掉一类宿主,而漏掉的后果正是这条报障。
 */
function isComposingKey(e: KeyboardEvent<HTMLDivElement>): boolean {
  const native = e.nativeEvent as unknown as { isComposing?: boolean; keyCode?: number }
  return native?.isComposing === true || native?.keyCode === 229
}

/** 光标之前那一截文本 + 它落在哪个文本节点上。不在文本节点里就没有 token 可言。 */
function caretToken(
  el: HTMLElement,
): { hit: TokenHit; node: Text; offset: number } | null {
  const sel = typeof window === 'undefined' ? null : window.getSelection()
  const node = sel?.anchorNode
  if (!node || node.nodeType !== Node.TEXT_NODE || !el.contains(node)) return null
  const offset = sel?.anchorOffset ?? 0
  const upto = (node.textContent ?? '').slice(0, offset)
  const hit = parseToken(upto, el.textContent ?? '')
  return hit ? { hit, node: node as Text, offset } : null
}

export function ComposerInput({
  apiRef,
  placeholder,
  picking,
  onToken,
  onMove,
  onPick,
  onEscape,
  onSend,
}: Props) {
  const ref = useRef<HTMLDivElement>(null)

  useImperativeHandle(apiRef, () => ({
    focus: () => ref.current?.focus(),
    text: () => (ref.current ? readDraft(ref.current) : ''),
    clear: () => {
      if (ref.current) ref.current.innerHTML = ''
    },
    insert: (kind, label, token) => {
      const el = ref.current
      if (!el) return
      const cur = caretToken(el)
      if (!cur) return
      const raw = cur.node.textContent ?? ''
      // 把 @xx / /xx 那一截原地摘掉,chip 补在原位,后半截原样跟上。
      const before = raw.slice(0, cur.offset).replace(/(@|\/)[\w.-]*$/, '')
      const rest = raw.slice(cur.offset)
      const chip = document.createElement('span')
      chip.className = kind === 'files' ? s.chip : s.cmdTok
      chip.textContent = kind === 'files' ? `@${label}` : label
      if (token) chip.dataset.token = token
      chip.contentEditable = 'false'
      const after = document.createTextNode(` ${rest}`)
      cur.node.textContent = before
      cur.node.parentNode?.insertBefore(chip, cur.node.nextSibling)
      chip.parentNode?.insertBefore(after, chip.nextSibling)
      // 光标落在 chip 后那个空格之后:接着打字就是接着说话。
      const range = document.createRange()
      const sel = window.getSelection()
      range.setStart(after, 1)
      range.collapse(true)
      sel?.removeAllRanges()
      sel?.addRange(range)
      el.focus()
    },
  }))

  const handleKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    /*
     * 组字期间这块输入面**整个归输入法**,一个键都不抢 —— 不只是回车:
     * 上下键在候选框里是翻页,Escape 是取消这次组字。抢走任何一个,中文用户就得
     * 在「选字」和「用这个应用」之间二选一。所以这一句写在最前面,不是塞进
     * 回车那个分支里。
     */
    if (isComposingKey(e)) return
    if (picking) {
      /* ui-consume-allow: kbd-select-handwritten — 这里只**转发**方向键,
       * 一格状态都不持有:走法与选中位在 Composer 那一头的 useListSelection 上
       * (`onMove` 直通它的 `move`)。这块输入面是 contenteditable,键必须在它
       * 身上接;把原语搬进来反而会让候选列表的状态长在输入框里。 */
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        onMove(1)
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        onMove(-1)
        return
      }
      if (e.key === 'Enter') {
        e.preventDefault()
        onPick()
        return
      }
      if (e.key === 'Escape') {
        // 抽屉先吃掉这一下:外层(舞台 / 浮窗)只在 !defaultPrevented 时才轮到它。
        e.preventDefault()
        onEscape()
        return
      }
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      onSend(ref.current?.textContent ?? '')
    }
  }

  // `data-testid` 是给门用的落点:aria-label 是翻译过的文案,会跟着系统语言变。
  return (
    <div
      ref={ref}
      className={s.input}
      contentEditable
      suppressContentEditableWarning
      role="textbox"
      /* contentEditable 本来就进 tab 序,但那是**浏览器行为**;role="textbox" 是
       * 给辅助技术的**声明**。两者要对上,声明了可编辑就得显式声明可聚焦,
       * 否则读屏软件按 ARIA 的说法去找焦点会落空(jsx-a11y 揪出的就是这条)。 */
      tabIndex={0}
      aria-multiline="true"
      aria-label={placeholder}
      data-testid="composer-input"
      data-placeholder={placeholder}
      onInput={() => onToken(ref.current ? (caretToken(ref.current)?.hit ?? null) : null)}
      onKeyDown={handleKeyDown}
    />
  )
}
