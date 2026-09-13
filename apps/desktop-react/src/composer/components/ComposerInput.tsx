import { useCallback, useImperativeHandle, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { KeyboardEvent, RefObject } from 'react'
import { useFocusScope } from '../../focus/useFocusScope'
/* 引用种类的注册 barrel。**谁要查表,谁负责保证表是装好的**(与 `workbench/
 * CenterRegion` 对内容种类那一条逐字同判例)—— 草稿出口要查那一枚 chip 的
 * `token` / `expand`,画它又要查 `render`,所以这块面板自己保证表在。
 * 生产那条路仍旧由 `main.tsx` 先 import 一次。 */
import '../../references'
import { ReferenceChip } from '../../references/ReferenceChip'
import { projectSegmentsToText } from '../../references/segment'
import type { ResolvedSegment, TextSegmentValue } from '../../references/segment'
import {
  draftTokenTailPattern,
  expandReferenceToken,
  parseToken,
  referenceTokenOf,
} from '../../references/registry'
import type { TokenHit } from '../../references/registry'
import rs from '../../references/ReferenceChip.module.css'
import s from './Composer.module.css'

/**
 * 本体行的输入面。它是 composer 里**唯一一块直接动 DOM、并且往 DOM 里挂 portal
 * 的地方**(09-14 改了半句判词,见下),理由是行内 chip:@ 引用要变成一枚不可
 * 编辑的整体(退格是整枚删),而 React 的受控 value 表达不了「文本 + 不可编辑
 * 节点」的混排。
 *
 * 所以这里的分工是:光标在哪、插进哪 —— 宿主的事实,由这个文件量;
 * 「这截 token 算不算触发」「命中哪几条」「这一枚画成什么」—— 判断,全在
 * 注册表与各家自述里。这个文件一条业务规则都不许有。
 *
 * ── 09-14:chip 不再是「手画的一个 span」,是**一枚宿主节点 + 一格 portal** ──
 * 从前 `insert` 用 `document.createElement` 亲手画出那枚 chip(类名 `.chip` /
 * `.cmdTok`、`textContent = label`),于是同一枚引用在草稿里一种写法、在气泡里
 * 另一种写法(`render(ref)`)—— 用户按下回车看见的是 chip → 整串路径 → 另一种
 * chip,两次换形。今天草稿里那一枚是:
 *
 *   一枚空的 `contenteditable=false` span(`data-kind` / `data-ref` / `data-token`)
 *   + `createPortal(<ReferenceChip kindId value />, 那枚 span)`
 *
 * 于是输入框、在飞的乐观气泡、落账的气泡是**同一个 React 组件、同一份
 * `render(ref)`**,连 hover / tooltip / 可不可点都一样。判词全文在正本 §6.2。
 *
 * **宿主节点表由「扫」维护,不由「记」维护**:退格整枚删、粘贴、撤销、铺回一份
 * 存下来的稿 —— 每一条都会改那几枚节点,而 React 这一侧并不在场。所以四处同步点
 * (`insert` / `appendReference` / `restore`+`clear` / `onInput`)调的是同一只
 * `syncHosts()`:现读 DOM 里所有带 `data-ref` 的节点,与上一拍逐个比身份,
 * **变了才 setState**。打一行普通的字不会让这块面板重渲一次。
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
   * `kindId` 是**这一枚算哪一种引用**(注册表上的 id),`ref` 是那一种自述
   * `draft.toRef(hit)` 交出来的**那一枚引用本身**。两格一起落在宿主节点的
   * `data-kind` / `data-ref` 上:草稿出口据此算记号(`draft.token`)与展开
   * (`draft.expand`),portal 据此画(`render`)。所以这个文件不必知道有几种
   * 引用、哪一种写成什么样。
   *
   * `argHint` 是**这条命令还要人填的那一截**(`<path>` / `[分类]`),由
   * `data/commands-source.argHintOf` 解析好递进来 —— 这个文件一条业务规则都没有,
   * 当然也不该在这里再解析一遍 usage。给了就在那个空格之后挂一枚灰色幽灵占位,
   * 人打第一个字它就散(见 `dissolveArgGhost`)。
   */
  insert: (kindId: string, ref: unknown, opts?: { argHint?: string }) => void
  /**
   * **从外面**落一枚引用 chip(B3-b:浏览器叶的「把这一页交给对话」)。
   *
   * 与 `insert` 的差别只有一句:`insert` 是**顶替**光标处那截 `@xx` / `/xx`
   * (它的调用方是抽屉,那截 token 就在光标前面),而这一只是**追加在末尾**
   * —— 从外面来的那一下,光标可能在任何地方,也可能这块面根本没有焦点。
   * 追加而不是「插在光标处」,是因为「光标此刻在哪」在外部动作发生的那一刻
   * 不是一个可靠的事实(人刚刚点的是浏览器叶上的一颗菜单项)。
   *
   * 落下来的是**同一种宿主节点**,所以它走的是同一条出站路、画的是同一枚 chip。
   */
  appendReference: (kindId: string, ref: unknown) => void
  /**
   * 这块可编辑区此刻的**段序列** —— 「段是真相」那句话的产地(09-14)。
   *
   * 文字段原样,引用段是那一枚 Ref 本人。交出去之后有两个读者:`text()`
   * (投影成线上那句话)与发送那一刻的乐观气泡(原样画)。
   */
  segments: () => ResolvedSegment[]
  /** 交出去的那句话。它是 `segments()` 的**投影**,不是第二次计算(见下)。 */
  text: () => string
  clear: () => void
  /**
   * **这块可编辑区此刻的 HTML**(W7-t / B2)。存草稿存的是它而不是 `text()` ——
   * `@` 引用是**真节点**(不可编辑的 chip,那一枚引用本身挂在 `data-ref` 上),
   * 存纯文本等于换一格会话回来 chip 就散成几个字,而散掉之后发出去的那句话
   * 与人看见的不再是同一句。
   *
   * portal 画进去的那几个元素**在这份 HTML 里**(它们是宿主节点的真孩子)——
   * 无害:`restore` 铺回去之后 `syncHosts()` 会重新给每枚宿主挂一格 portal,
   * React 接管那枚节点时先把里面清空。段的来源自始至终是 `data-ref`,不是
   * 里面画着什么。
   */
  html: () => string
  /** 把一份存下来的稿铺回去(空串 = 清空,与 `clear()` 同义)。 */
  restore: (html: string) => void
}

/** 宿主节点表里的一格。`id` 只为 React 的 key —— DOM 节点本身不是一个稳定的键。 */
interface ChipHost {
  id: number
  node: HTMLElement
  kindId: string
  ref: unknown
}

/**
 * 发号器。**它是模块级的可变状态,而这里不配 HMR dispose** —— 判词:
 * 那条法要退役的是「寿命跟着模块实例走、退不掉就会留下第二份活口」的东西
 * (订阅 / 计时器 / 监听 / 注册表)。这一格既不持有任何人,也没有第二份:
 * 它只管**别发出重号**,而热更之后框里那几枚节点身上的号还在(`html()` 存着),
 * 归零反倒会与它们撞车。所以它靠下面 `scanHosts` 那句「见过更大的就抬上去」
 * 自愈,而不是靠归零。
 */
let hostSeq = 0

/**
 * 现读这块可编辑区里的宿主节点(文档序)。
 *
 * 判据是 `data-ref` **在不在**,不是类名 —— CSS Modules 的类名是编译期哈希,
 * 拿它当协议等于把样式表接进逻辑里(与幽灵占位那条 `data-arg-ghost` 同判)。
 * 认不出 JSON 的那一枚整格跳过:它不是一枚引用,后面那条读法会把它当文字。
 */
function scanHosts(root: HTMLElement): ChipHost[] {
  const out: ChipHost[] = []
  for (const node of Array.from(root.querySelectorAll<HTMLElement>('[data-ref]'))) {
    const kindId = node.dataset.kind
    const raw = node.dataset.ref
    if (!kindId || raw === undefined) continue
    let ref: unknown
    try {
      ref = JSON.parse(raw)
    } catch {
      continue
    }
    /*
     * 号只为 React 的 key(DOM 节点本身不是一个稳定的键)。铺回一份存下来的稿时
     * 号跟着 HTML 一起回来 —— 所以发号器要**抬到见过的最大号之上**,不然下一枚新
     * chip 会发一个与铺回来那几枚撞车的号,两格 portal 抢同一个 key。
     */
    if (node.dataset.hostId === undefined) node.dataset.hostId = String((hostSeq += 1))
    const id = Number(node.dataset.hostId)
    if (Number.isFinite(id) && id > hostSeq) hostSeq = id
    out.push({ id, node, kindId, ref })
  }
  return out
}

/** 两拍宿主表是不是同一张(身份 + 序)。相同就不 setState —— 打字不该让这块面重渲。 */
function sameHosts(a: readonly ChipHost[], b: readonly ChipHost[]): boolean {
  return a.length === b.length && a.every((one, i) => one.node === b[i].node)
}

/**
 * 把这块可编辑区读成**段**。
 *
 * 三支,顺序即语义:
 *  · 文本节点 —— 原样一段文字;
 *  · 参数幽灵占位(`data-arg-ghost`)—— 整枚跳过。它是**画出来的一句提示**,
 *    不是人写的字;判据挂在它自己身上,不靠类名;
 *  · 宿主节点(`data-ref`)—— 一段引用,值就是那一枚 Ref 本人。
 *    **不往里递归**:里面是 portal 画出来的 chip,那是呈现不是内容。
 *  · 只有 `data-token` 没有 `data-ref` 的 —— 09-14 之前那一形的 chip
 *    (热更之后可能还躺在框里)。当场展成它代表的那截文本,于是**交出去的
 *    那句话一个字不变**,只是它不再是一枚 chip。
 *  · 其余元素 —— 递归。`<br>` 与 contenteditable 自己包出来的 `<div>` 都不产生
 *    换行,与从前 `textContent` 的行为逐字一致(那是既有口径,这一批不动)。
 */
function readSegments(root: Node, out: ResolvedSegment[] = []): ResolvedSegment[] {
  for (const node of Array.from(root.childNodes)) {
    if (node.nodeType === Node.TEXT_NODE) {
      pushText(out, node.textContent ?? '')
      continue
    }
    if (!(node instanceof HTMLElement)) {
      // 不是元素也不是文本(注释 / SVG …)—— 照旧往下走,与从前 `readDraft` 逐字同。
      readSegments(node, out)
      continue
    }
    if (node.dataset.argGhost !== undefined) continue
    const raw = node.dataset.ref
    if (raw !== undefined && node.dataset.kind) {
      try {
        out.push({ kindId: node.dataset.kind, value: JSON.parse(raw) })
        continue
      } catch {
        /* 认不出就当它是几个字 —— 往下掉到递归那一支。 */
      }
    }
    const token = node.dataset.token
    if (token !== undefined) {
      pushText(out, expandReferenceToken(node.dataset.kind, token))
      continue
    }
    readSegments(node, out)
  }
  return out
}

/** 相邻的文字并成一段(与 `references/segment.ts` 的那一只同一条纪律)。 */
function pushText(out: ResolvedSegment[], text: string): void {
  if (!text) return
  const last = out[out.length - 1]
  if (last && last.kindId === null) {
    ;(last.value as TextSegmentValue).text += text
    return
  }
  out.push({ kindId: null, value: { kind: 'text', text } satisfies TextSegmentValue })
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
  /**
   * 交出去那一下。**段与它的投影一起交**(09-14):乐观气泡画的是段、发出去的
   * 是那句话,两者必须来自同一次读取 —— 分两口读就是两个产地,而中间隔着的那
   * 一拍里人可能已经又打了一个字。
   */
  onSend: (text: string, segments: ResolvedSegment[]) => void
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
  /**
   * 此刻框里那几枚宿主节点。它是**DOM 的投影**,不是第二份真相 ——
   * 产地永远是那几枚节点身上的 `data-kind` / `data-ref`。
   */
  const [hosts, setHosts] = useState<readonly ChipHost[]>([])
  const syncHosts = useCallback(() => {
    const el = ref.current
    const next = el ? scanHosts(el) : []
    setHosts((prev) => (sameHosts(prev, next) ? prev : next))
  }, [])

  /** 造一枚宿主节点。空的 —— 里面画什么由 portal 说。 */
  const makeHost = useCallback((kindId: string, value: unknown): HTMLElement => {
    const host = document.createElement('span')
    host.className = rs.host
    host.dataset.kind = kindId
    host.dataset.ref = JSON.stringify(value)
    /*
     * `data-token` 是这一枚在线上那句话里占的那截字。它由 `draft.token(ref)` 算,
     * 落在节点上只为两件事:存下来的稿一眼看得懂,以及热更之后旧节点仍认得出。
     * **段的产地是 `data-ref`** —— 投影那一句现算,不读这一格(不然记号与 Ref
     * 就有了两个真相)。
     */
    const token = referenceTokenOf(kindId, value)
    if (token !== undefined) host.dataset.token = token
    host.contentEditable = 'false'
    return host
  }, [])

  useImperativeHandle(apiRef, () => ({
    element: () => ref.current,
    segments: () => (ref.current ? readSegments(ref.current) : []),
    /*
     * ── 交出去的那句话 = 段的投影,而且只有这一条路 ─────────────────────────
     * 与 `textContent` 的唯一差别是那一枚引用:屏幕上写的是 basename(呈现),
     * 而它真正代表的位置由 `draft.token(ref)` 算出来、再由 `draft.expand` 展开
     * (`{{file:/abs/src/a.ts}}` → `@/abs/src/a.ts`)。
     *
     * **展开就在这一句,而且只在这一句**(09-12):从前这道展开在
     * `chat-port.sendMessage` 里(理由是「单一出口」),而真机上它生出的是一条
     * **永不消失的重复气泡** —— 发送那一刻 `chat-source` 先落一格乐观 overlay,
     * `text` 是这里交出来的 token 句;出站时端口才展开,账本回来的是展开句;
     * `reconcileOverlay` 的认领判据是「正文逐字相同」,于是那一格 pending 永远
     * 等不到自己那条消息。把展开挪到草稿的出口,两边从此是同一串字节。
     * (存草稿存的是 `html()`,chip 是真节点 —— 展开只发生在「交出去」这条路上,
     * 存回来的稿里 token 一个字没变。)
     */
    text: () => (ref.current ? projectSegmentsToText(readSegments(ref.current)) : ''),
    clear: () => {
      if (ref.current) ref.current.innerHTML = ''
      syncHosts()
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
      // 铺回来的那几枚宿主要重新挂上 portal —— 它们是新节点,上一张表里没有。
      syncHosts()
    },
    insert: (kindId, value, opts) => {
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
      const chip = makeHost(kindId, value)
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
      syncHosts()
      /*
       * 插完一枚 chip 之后光标回到这块可编辑区 —— **作用域内部**的一次移动,
       * 所以走树的 `activate()`(它把焦点送到这块面声明的落点上,而在 write
       * 形态下那个落点就是这块可编辑区),不再自己 `el.focus()`。
       * 插入点已经在上面设好了:focus 一块 contenteditable 不会动 selection。
       */
      activate('programmatic')
    },
    appendReference: (kindId, value) => {
      const el = ref.current
      if (!el) return
      const chip = makeHost(kindId, value)
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
      syncHosts()
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
       * 而发送键走的是 `text()` —— 两者对一枚 chip 的答案本来就不同。也就是说
       * 同一句话「按回车发」和「点发送发」发出去的不是同一句。参数幽灵占位让
       * 这道口子变得不能再留(它在 textContent 里,在草稿里没有),所以两口在
       * 这里合成一口:**草稿只有一个读法**,而 09-14 起那个读法是**段**。
       */
      const segments = ref.current ? readSegments(ref.current) : []
      onSend(projectSegmentsToText(segments), segments)
    }
  }

  // `data-testid` 是给门用的落点:aria-label 是翻译过的文案,会跟着系统语言变。
  return (
    <>
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
          /*
           * 退格把一枚 chip 整个删掉(或者粘贴 / 撤销带进来几枚)之后对账。
           * **不是每一下都 setState** —— `syncHosts` 先比身份,一样就是恒等
           * (判词在它自己那儿):打一行普通的字,这块面板一次都不重渲。
           */
          syncHosts()
          onToken(ref.current ? (caretToken(ref.current)?.hit ?? null) : null)
        }}
        onKeyDown={handleKeyDown}
      />
      {/*
        * 每一枚宿主节点一格 portal。它们画进的是**那块可编辑区里面**的节点,
        * 所以 DOM 上它们就长在 chip 该在的位置;React 这一侧它们是这只组件的
        * 孩子,于是 hover / tooltip / 点击与气泡里那一枚逐字同一套。
        */}
      {hosts.map((host) => createPortal(
        <ReferenceChip kindId={host.kindId} value={host.ref} />,
        host.node,
        String(host.id),
      ))}
    </>
  )
}
