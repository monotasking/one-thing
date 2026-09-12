import { useImperativeHandle, useRef } from 'react'
import type { KeyboardEvent, RefObject } from 'react'
import { useFocusScope } from '../../focus/useFocusScope'
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
  /**
   * 那块可编辑区本身。**给树当落点用**(`Composer` 的 `restingTarget`)——
   * 从前这里是一口 `focus()`,谁想抢焦点就叫一声;R2 之后「焦点落在哪儿」是
   * 输入面板那一格作用域的**声明**,交出去的于是从一个动作变成一个事实。
   */
  element: () => HTMLElement | null
  /**
   * 把光标处的 @xx / /xx 换成一枚 chip(files)或命令徽(commands)。
   *
   * `token` 是**这枚 chip 在草稿里真正代表的那截文本**(`@` 引用是
   * `{{file:<绝对路径>}}`)。给了就挂在 `data-token` 上,`text()` 交出去时
   * 用它顶替屏幕上那几个字;不给 = 屏幕上写什么、交出去就是什么。
   *
   * `argHint` 是**这条命令还要人填的那一截**(`<path>` / `[分类]`),由
   * `data/commands-source.argHintOf` 解析好递进来 —— 这个文件一条业务规则都没有,
   * 当然也不该在这里再解析一遍 usage。给了就在那个空格之后挂一枚灰色幽灵占位,
   * 人打第一个字它就散(见 `dissolveArgGhost`)。
   */
  insert: (
    kind: 'files' | 'commands',
    label: string,
    opts?: { token?: string; argHint?: string },
  ) => void
  text: () => string
  clear: () => void
  /**
   * **这块可编辑区此刻的 HTML**(W7-t / B2)。存草稿存的是它而不是 `text()` ——
   * `@` 引用是**真节点**(不可编辑的 chip,真正代表的那截文本挂在 `data-token`
   * 上),存纯文本等于换一格会话回来 chip 就散成几个字,而散掉之后发出去的那句话
   * 与人看见的不再是同一句。
   */
  html: () => string
  /** 把一份存下来的稿铺回去(空串 = 清空,与 `clear()` 同义)。 */
  restore: (html: string) => void
}

/**
 * 把这块可编辑区读成**草稿文本**。
 *
 * 与 `textContent` 的唯一差别是那一句 `data-token`:一枚文件 chip 屏幕上写的是
 * `@src/a.ts`(人心里的名字),而草稿里它代表的是 `{{file:/abs/src/a.ts}}` ——
 * 「chip 是呈现,token 才是位置」正是 `@onething/runtime/prompts/prompt-references` 里
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
    /*
     * 参数幽灵占位整枚跳过(09-12):它是**画出来的一句提示**,不是人写的字。
     * 判据挂在它自己身上(`data-arg-ghost`),不靠类名 —— CSS Modules 的类名
     * 是编译期哈希,拿它当协议等于把样式表接进逻辑里。
     */
    if (node instanceof HTMLElement && node.dataset.argGhost !== undefined) continue
    const token = node instanceof HTMLElement ? node.dataset.token : undefined
    out += token ?? readDraft(node)
  }
  return out
}

/**
 * 幽灵占位**散掉**的那一刻(09-12)。
 *
 * 它只在一种情形下活着:插完之后**一个字都还没打**,而且光标就停在它前面
 * 那个空格的末尾。别的一切 —— 打了字、退格把空格吃掉了、光标挪到别处去了 ——
 * 都是「人已经在自己写这一截了」,提示当场退场。
 *
 * 判据写成「什么时候**留**」而不是「什么时候**摘**」,是因为留的条件恰好只有
 * 一条,而摘的情形数不完;按后者写,漏掉的每一种都会让一句灰字赖在屏幕上。
 */
function dissolveArgGhost(el: HTMLElement): void {
  const ghost = el.querySelector('[data-arg-ghost]')
  if (!(ghost instanceof HTMLElement)) return
  const prev = ghost.previousSibling
  const lead = prev && prev.nodeType === Node.TEXT_NODE ? (prev.textContent ?? '') : ''
  const sel = typeof window === 'undefined' ? null : window.getSelection()
  const caretHere = sel?.anchorNode === prev && sel?.anchorOffset === lead.length
  if (lead === ' ' && caretHere) return
  ghost.remove()
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
  /* 这块可编辑区住在输入面板那一格作用域里,所以拿到的是它的句柄。 */
  const { activate } = useFocusScope()

  useImperativeHandle(apiRef, () => ({
    element: () => ref.current,
    text: () => (ref.current ? readDraft(ref.current) : ''),
    clear: () => {
      if (ref.current) ref.current.innerHTML = ''
    },
    html: () => ref.current?.innerHTML ?? '',
    /*
     * 铺一份稿回去。写 `innerHTML` 是这块面板本来就有的那一手(`clear()` 写的是
     * 空串,同一句),而**这份 HTML 的来源只有它自己**(上一拍从这块可编辑区
     * 读出来的),所以没有第二方的字节进这里。
     */
    restore: (html) => {
      if (!ref.current) return
      ref.current.innerHTML = html
      /*
       * 铺回来的稿里**不留幽灵占位**:它说的是「你接下来要打的是这一截」,
       * 而换一格会话回来的那一刻这句话已经过期了(人早就不在那次补全的现场)。
       * 摘在这里而不是在 `html()` 里滤:存下来的字节保持「这块面板当时长什么样」,
       * 过期的只是这一句提示。
       */
      for (const ghost of Array.from(ref.current.querySelectorAll('[data-arg-ghost]'))) {
        ghost.remove()
      }
    },
    insert: (kind, label, opts) => {
      const el = ref.current
      if (!el) return
      const cur = caretToken(el)
      if (!cur) return
      const raw = cur.node.textContent ?? ''
      // 把 @xx / /xx 那一截原地摘掉,chip 补在原位,后半截原样跟上。
      // `:` 与 parseToken 那条命令正则同步放行 —— 技能引用叫 `/skill:<名字>`,
      // 少这一格就会在框里留下半截 `/skill:`(两处是同一句语法的两半)。
      const before = raw.slice(0, cur.offset).replace(/(@|\/)[\w.:-]*$/, '')
      const rest = raw.slice(cur.offset)
      const chip = document.createElement('span')
      chip.className = kind === 'files' ? s.chip : s.cmdTok
      chip.textContent = kind === 'files' ? `@${label}` : label
      if (opts?.token) chip.dataset.token = opts.token
      chip.contentEditable = 'false'
      /*
       * chip 之后**恒有一个空格**,光标落在它后面 —— 接着打字就是接着说话。
       * 从前这里是一个 `' ' + rest` 的文本节点;现在空格与后半截分成两个节点,
       * 是为了让幽灵占位能插在**它们中间**(空格 → 提示 → 原来的后半截)。
       * 没有 argHint 时两个节点与从前那一个在草稿上逐字等价。
       *
       * (那个空格从来都在;09-12 之前它看不见,病根在 `.input` 少了
       * `white-space: pre-wrap` —— 行尾空白被折叠掉了。判词在那条 CSS 上。)
       */
      const gap = document.createTextNode(' ')
      const tail = document.createTextNode(rest)
      cur.node.textContent = before
      cur.node.parentNode?.insertBefore(chip, cur.node.nextSibling)
      chip.parentNode?.insertBefore(gap, chip.nextSibling)
      let mark: Node = gap
      if (opts?.argHint) {
        const ghost = document.createElement('span')
        ghost.className = s.argGhost
        ghost.textContent = opts.argHint
        ghost.contentEditable = 'false'
        ghost.dataset.argGhost = ''
        gap.parentNode?.insertBefore(ghost, gap.nextSibling)
        mark = ghost
      }
      mark.parentNode?.insertBefore(tail, mark.nextSibling)
      // 光标落在 chip 后那个空格之后(幽灵占位在它右边,人打的字从它左边长出来)。
      const range = document.createRange()
      const sel = window.getSelection()
      range.setStart(gap, 1)
      range.collapse(true)
      sel?.removeAllRanges()
      sel?.addRange(range)
      /*
       * 插完一枚 chip 之后光标回到这块可编辑区 —— **作用域内部**的一次移动,
       * 所以走树的 `activate()`(它把焦点送到这块面声明的落点上,而在 write
       * 形态下那个落点就是这块可编辑区),不再自己 `el.focus()`。
       * 插入点已经在上面设好了:focus 一块 contenteditable 不会动 selection。
       */
      activate('programmatic')
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
      /*
       * **回车与发送键读同一口**(09-12 顺手结清)。从前这里是 `textContent`,
       * 而发送键走的是 `text()`(= `readDraft`)—— 两者对一枚 chip 的答案本来
       * 就不同:`readDraft` 交出 `data-token` 上那截真正代表的文本
       * (`{{file:/abs/…}}`),`textContent` 交出屏幕上那几个字(`@src/a.ts`)。
       * 也就是说同一句话「按回车发」和「点发送发」发出去的不是同一句。
       * 参数幽灵占位让这道口子变得不能再留(它在 textContent 里,在草稿里没有),
       * 所以两口在这里合成一口:**草稿只有一个读法**。
       */
      onSend(ref.current ? readDraft(ref.current) : '')
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
      onInput={() => {
        // 先散提示、再报 token:摘掉那枚节点会改变光标前后的节点结构,
        // 而 `caretToken` 读的正是那个结构。次序反过来就会按摘之前的现场报。
        if (ref.current) dissolveArgGhost(ref.current)
        onToken(ref.current ? (caretToken(ref.current)?.hit ?? null) : null)
      }}
      onKeyDown={handleKeyDown}
    />
  )
}
