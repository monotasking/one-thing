import { useImperativeHandle, useRef } from 'react'
import type { KeyboardEvent, RefObject } from 'react'
import { useFocusScope } from '../../focus/useFocusScope'
/* 引用种类的注册 barrel。**谁要查表,谁负责保证表是装好的**(与 `workbench/
 * CenterRegion` 对内容种类那一条逐字同判例)—— 草稿出口要查那一枚 chip 的
 * `expand`,所以这块面板自己保证表在。生产那条路仍旧由 `main.tsx` 先 import 一次。 */
import '../../references'
import { draftTokenTailPattern, expandReferenceToken, parseToken } from '../../references/registry'
import type { TokenHit } from '../../references/registry'
import type { ChipDraft } from '../../references/kind'
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
   * 把光标处的 `@xx` / `/xx` 换成一枚 chip。
   *
   * `kindId` 是**这一枚算哪一种引用**(注册表上的 id)。它落在 chip 的
   * `data-kind` 上,`text()` 交出去时据此查那一种的 `expand` —— 所以这个文件
   * 不必知道有几种引用、哪一种要展开成什么。
   *
   * `chip` 是那一种自述交出来的两格:写什么(`label`)、画成哪一形(`tone`)。
   * **两档 tone 是这块输入面自己的呈现词汇表**(皮肤在 `Composer.module.css`),
   * 不是种类名 —— 加一种引用不必在这里加一档,除非它真要长成第三个样子。
   *
   * `token` 是**这枚 chip 真正代表的那截文本**(`@` 引用是 `{{file:<绝对路径>}}`)。
   * 给了就挂在 `data-token` 上;不给 = 屏幕上写什么、交出去就是什么。
   *
   * `argHint` 是**这条命令还要人填的那一截**(`<path>` / `[分类]`),由
   * `data/commands-source.argHintOf` 解析好递进来 —— 这个文件一条业务规则都没有,
   * 当然也不该在这里再解析一遍 usage。给了就在那个空格之后挂一枚灰色幽灵占位,
   * 人打第一个字它就散(见 `dissolveArgGhost`)。
   */
  insert: (
    kindId: string,
    chip: ChipDraft,
    opts?: { token?: string; argHint?: string },
  ) => void
  /**
   * **从外面**落一枚引用 chip(B3-b:浏览器叶的「把这一页交给对话」)。
   *
   * 与 `insert` 的差别只有一句:`insert` 是**顶替**光标处那截 `@xx` / `/xx`
   * (它的调用方是抽屉,那截 token 就在光标前面),而这一只是**追加在末尾**
   * —— 从外面来的那一下,光标可能在任何地方,也可能这块面根本没有焦点。
   * 追加而不是「插在光标处」,是因为「光标此刻在哪」在外部动作发生的那一刻
   * 不是一个可靠的事实(人刚刚点的是浏览器叶上的一颗菜单项)。
   *
   * 与 `insert` 共用同一种 chip(`data-token` 挂 token),所以它走的是**同一条
   * 出站路** —— `readDraft` 交出 `data-token`。它挂的是 `{{page:<tabId>}}`,
   * 文件 token 那道展开只认 `{{file:`,所以页面这一枚原样过去,由 `chat-port`
   * 在发送那一刻物化成一件带出处的附件(那一页此刻长什么样,只有那一刻知道)。
   */
  appendReference: (label: string, opts: { token: string; tip?: string }) => void
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
 * 把这块可编辑区读成**交出去的那句话**。
 *
 * 与 `textContent` 的唯一差别是那一句 `data-token`:一枚文件 chip 屏幕上写的是
 * `@src/a.ts`(人心里的名字),而它真正代表的位置挂在 `data-token` 上
 * (`{{file:/abs/src/a.ts}}`)。「chip 是呈现,token 才是位置」正是
 * `@onething/runtime/prompts/prompt-references` 里 `FILE_REF_PATTERN` 那段注释说的事
 * (Vue 壳把 token 直接放在纯文本草稿里,由编辑器画成 chip;这块 contenteditable
 * 反过来,chip 是真节点、token 挂在它身上。两边**交出去的那句话逐字相同**,
 * 那才是要紧的)。
 *
 * ── 记号的展开就在这一句,而且只在这一句(09-12)──────────────────────────
 * 读到 `data-token` 之后**当场**问那一枚 chip 自报的种类要一句 `expand`
 * (`data-kind` → 注册表),于是这只函数交出去的已经是账本上最终落下的那串字节。
 * **这个文件不知道有几种引用**:哪一种要展开、展成什么样,是那一种自己的事;
 * 没有自述 / 没有 `expand` 的原样穿过去(浏览器叶那一枚 `{{page:…}}` 走的正是
 * 这一支 —— 它要到发送那一刻才知道那一页长什么样,物化仍归 `chat-port`)。
 *
 * 从前这道展开在 `chat-port.sendMessage` 里(理由是「单一出口」),而真机上它
 * 生出的是一条**永不消失的重复气泡**:发送那一刻 `chat-source` 先落一格乐观
 * overlay,`text` 是这里交出来的 token 句;出站时端口才展开,账本回来的是展开句;
 * `reconcileOverlay` 的认领判据是「正文逐字相同」,于是那一格 pending 永远等不到
 * 自己那条消息。**把展开挪到草稿的出口**,两边从此是同一串字节,认领一格不用改。
 * (存草稿存的是 `html()`,chip 是真节点 —— 所以展开只发生在「交出去」这条路上,
 * 存回来的稿里 token 一个字没变。)
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
    const el = node instanceof HTMLElement ? node : undefined
    const token = el?.dataset.token
    out += token === undefined ? readDraft(node) : expandReferenceToken(el?.dataset.kind, token)
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
    insert: (kindId, draft, opts) => {
      const el = ref.current
      if (!el) return
      const cur = caretToken(el)
      if (!cur) return
      const raw = cur.node.textContent ?? ''
      /*
       * 把 `@xx` / `/xx` 那一截原地摘掉,chip 补在原位,后半截原样跟上。
       * 那条尾巴**由注册表算出来**(触发字符与 token 字符集都是各种引用自述的并),
       * 所以这里既不写 `@`、也不写哪几个字符算 token —— 从前那句写死的
       * `/(@|\/)[\w.:-]*$/` 与 `parseToken` 是同一句语法的两半,漂开一次就会在
       * 框里留下半截 `/skill:`。
       */
      const before = raw.slice(0, cur.offset).replace(draftTokenTailPattern(), '')
      const rest = raw.slice(cur.offset)
      const chip = document.createElement('span')
      chip.className = draft.tone === 'reference' ? s.chip : s.cmdTok
      // 前缀(`@`)是那一种引用自己的写法,不是这块面板的规矩 —— label 自带。
      chip.textContent = draft.label
      chip.dataset.kind = kindId
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
    appendReference: (label, opts) => {
      const el = ref.current
      if (!el) return
      const chip = document.createElement('span')
      chip.className = s.chip
      chip.textContent = label
      chip.dataset.token = opts.token
      /*
       * **原生 `title` 在这里是允许的一格,而那不是例外主义**:禁令(「禁 native
       * `title=`,提示一律 `ui/Tooltip`」)管的是**组件**,而这一枚 chip 是
       * 手动造出来的 DOM 节点 —— 这块可编辑区是 composer 里唯一直接动 DOM 的地方
       * (文件头第一段),React 的 Tooltip 挂不上一个 `document.createElement`
       * 出来的节点。同一格在 `insert` 那一支里今天是**空缺**(文件 chip 没有
       * 提示),这一支有 URL 可说,所以说出来。
       */
      if (opts.tip) chip.title = opts.tip
      chip.contentEditable = 'false'
      // chip 之后恒有一个空格(与 `insert` 逐字同一条):接着打字就是接着说话。
      const gap = document.createTextNode(' ')
      el.appendChild(chip)
      el.appendChild(gap)
      const range = document.createRange()
      const sel = window.getSelection()
      range.setStart(gap, 1)
      range.collapse(true)
      sel?.removeAllRanges()
      sel?.addRange(range)
      /*
       * 焦点进这块面 —— 人刚刚说的是「把这一页交给对话」,下一件事就是打字。
       * 走树的 `activate()` 而不是 `el.focus()`:这是一次**跨作用域**的搬焦点
       * (从浏览器叶到输入面板),I3 禁的正是后者。
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
       * 就不同:`readDraft` 交出 `data-token` 上那截真正代表的文本(展开之后是
       * `@/abs/…`),`textContent` 交出屏幕上那几个字(`@src/a.ts`)。
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
