import { formatRefTag, scanRefTags } from '@onething/core/references'
import {
  expandReferenceToken,
  referencePartKinds,
  referenceTagOf,
  referenceTextKinds,
  referenceTokenOf,
  referenceWritesTag,
  resolveReferenceTag,
} from './registry'
import type { ReferencePart } from './kind'

/**
 * **把一条用户消息切成段** —— 全壳唯一的那一只(正本 §2)。
 *
 * 09-12 之前这件事是 `content/user-message.tsx` 里的两张 switch(正文一张、
 * 部件一张),每加一种引用就各加一个 case。今天两张都没了:切的判据**全部由
 * 各种类自述**(`parse.text` / `parse.part`),这只文件只管扫描与拼接,
 * 一个种类名都不认得。
 *
 * ── 交出去的形状:`{kindId, value}` 与它的投影 ───────────────────────────────
 * 画那一半要知道**这一段是哪一种**(去查它的 `render` / `open`),而切分表的
 * 既有读者(单测、正文拼接)只关心那一段本身。所以这里交出配对形,
 * `content/user-message.tsx` 的两只导出是它的投影 —— 一个事实,两种读法,
 * 不是两次计算。
 */

/** 文字那一段。它不是引用,所以不属于任何一种自述 —— `kindId` 恒为 null。 */
export interface TextSegmentValue {
  kind: 'text'
  text: string
}

export interface ResolvedSegment {
  /** null = 这一段是文字。 */
  kindId: string | null
  /** 文字段是 `{kind:'text', text}`;引用段是那一种自己 `toRef` 出来的东西。 */
  value: unknown
}

/** 相邻的文字并成一段:剥下来的尾巴与它后面那截正文本来就是同一句话。 */
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
 * 一截正文 → 若干段。
 *
 * `atStart` = **这一截是不是整条消息的开头**。只在开头认的那一族(命令)靠它;
 * 它是一个参数而不是一句 `out.length === 0`,因为部件那条路上开头那一截可能排在
 * 一枚引用**后面**(`/skill:x 干活` 折出来是 `[skill-ref, text(' 干活')]`),
 * 那时 `' 干活'` 不是开头。
 *
 * ── 扫描:每一步找**最早的那一处命中**,同处按自述的具体程度排 ────────────────
 * 多家共用同一条正则是常态(文件与目录都认 `@<路径>`,靠 `toRef` 答 null 互相
 * 让路),所以不能「谁先注册谁吃掉整段」。判据是位置:各家从当前位置各自往后找
 * 自己的第一处**真命中**(`toRef` 非 null),最早的那一处赢;同一位置上
 * `specificity` 大的先试(`/skill:x` 比 `/x` 具体)。
 *
 * ── `<ref/>` 是**一名与各家正则平级的扫描者**(B2,正本 §2.4)──────────────
 * 它不是「先把标签抽掉再按老规矩切」:那样等于给它开一条优先通道,而
 * `@/a/b.ts` 与 `<ref type="file" …/>` 在一句话里可以并排出现,谁在前面谁先被
 * 认走才是对的。所以它也只是一个「从 pos 往后找自己的第一处真命中」的家伙,
 * 参加同一场「最早命中者赢」。**认不出 type 的标签一个字都不吞** —— 它压根不
 * 进候选,于是原样留在正文里(用户气泡里那句话本来长什么样就长什么样)。
 */
function appendText(out: ResolvedSegment[], text: string, atStart: boolean): void {
  if (!text) return
  const kinds = referenceTextKinds()
  let pos = 0

  if (atStart) {
    const heads = kinds
      .filter((k) => k.parse!.text!.at === 'start')
      .sort((a, b) => (b.parse!.text!.specificity ?? 0) - (a.parse!.text!.specificity ?? 0))
    for (const kind of heads) {
      const spec = kind.parse!.text!
      spec.pattern.lastIndex = 0
      const m = spec.pattern.exec(text)
      if (!m) continue
      const hit = spec.toRef(m)
      if (!hit) continue
      pushText(out, text.slice(0, hit.start))
      out.push({ kindId: kind.id, value: hit.ref })
      pos = Math.max(hit.end, hit.start + 1)
      break
    }
  }

  /*
   * 全文那一族。每一家一份自己的 `lastIndex` 游标 —— 正则对象是各家自述里的
   * **同一个**,所以扫描前必须自己摆位;共用一个游标会让两家互相吃掉命中。
   */
  const scanners = kinds
    .filter((k) => k.parse!.text!.at !== 'start')
    .map((k) => ({
      kind: k,
      re: new RegExp(k.parse!.text!.pattern.source, ensureGlobal(k.parse!.text!.pattern.flags)),
      /** 上一轮找到、这一轮还够得着的那一处(位置只会往后走,所以不必重扫)。 */
      found: null as { ref: unknown; start: number; end: number } | null,
      /** 它自己那条正则已经扫到头了 —— 此后每一轮都不必再问它。 */
      done: false,
    }))

  /*
   * 标签那一名扫描者。全文**只扫一遍**(编解码器的 `scanRefTags` 是一次线性
   * 走),认得出的按位置排好;循环里只是往前挪一格游标 —— 一条 500 枚标签的
   * 消息因此是 O(正文长度 + 枚数),不是 O(枚数 × 种类数)。
   */
  const tagHits: { kindId: string; ref: unknown; start: number; end: number }[] = []
  for (const hit of scanRefTags(text)) {
    const resolved = resolveReferenceTag(hit.tag)
    if (!resolved) continue
    tagHits.push({ kindId: resolved.kindId, ref: resolved.value, start: hit.start, end: hit.end })
  }
  let tagAt = 0

  while (pos <= text.length) {
    let best: { kindId: string; ref: unknown; start: number; end: number } | null = null
    while (tagAt < tagHits.length && tagHits[tagAt].start < pos) tagAt += 1
    if (tagAt < tagHits.length) best = tagHits[tagAt]
    for (const scanner of scanners) {
      if (scanner.found && scanner.found.start < pos) scanner.found = null
      if (!scanner.found && !scanner.done) {
        scanner.re.lastIndex = pos
        let m: RegExpExecArray | null
        while ((m = scanner.re.exec(text)) !== null) {
          const hit = scanner.kind.parse!.text!.toRef(m)
          if (hit) {
            scanner.found = hit
            break
          }
          // 这一处不是它的 —— 接着找它自己的下一处(零宽命中要手动往前挪一格)。
          if (scanner.re.lastIndex === m.index) scanner.re.lastIndex = m.index + 1
        }
        if (!scanner.found) scanner.done = true
      }
      const hit = scanner.found
      if (hit && (!best || hit.start < best.start)) {
        best = { kindId: scanner.kind.id, ...hit }
      }
    }
    if (!best) break
    pushText(out, text.slice(pos, best.start))
    out.push({ kindId: best.kindId, value: best.ref })
    // 吃掉的那一段必须真的往前走一格,不然同一处会被反复认领。
    pos = Math.max(best.end, best.start + 1)
  }

  pushText(out, text.slice(pos))
}

function ensureGlobal(flags: string): string {
  return flags.includes('g') ? flags : `${flags}g`
}

/**
 * **段 → 那句话**(09-14;「段是真相,文本是投影」在代码里的那一句)。
 *
 * 它是 `segmentReferenceText` 的**左逆**:文字段原样,引用段问那一种自述要一截
 * 记号(`draft.token(ref)`)再当场展开(`draft.expand`)—— 也就是说,交出来的
 * 已经是**账本上最终落下的那串字节**(展开在草稿的出口,判词在
 * `ComposerInput.readDraft` 与正本 §2 修正③)。
 *
 * 唯一的读者是输入框的 `text()`:那块可编辑区里 chip 是真节点,`segments()` 把
 * 它读成段,这一只再把段投影成句子。**两者互为投影**是一条单测钉着的不变量 ——
 * 少了它,「屏幕上的这一枚」与「发出去的那几个字」就又有了两个产地。
 *
 * 落不了稿的那一种(没有 `draft`)在句子里**不占字**:那是「它进不了草稿」的
 * 直接推论,不是一格漏判。
 *
 * ── 两条出站路,判据由那一种自述(B2,正本 §2.4)──────────────────────────
 *  · 有线上标签、而且没说 `wire: 'token'` → `<ref type="…" …/>`;
 *  · 否则 → 旧的 `token → expand`(命令 / 技能:它们是一句话的主语,引擎照它
 *    执行,改成标签就变了语义;网页那一枚的记号要在发送那一刻才物化)。
 *
 * 判据只有 `referenceWritesTag` 一句,这只文件照旧一个种类名都不认得。
 */
export function projectSegmentsToText(segments: readonly ResolvedSegment[]): string {
  let out = ''
  for (const seg of segments) {
    if (seg.kindId === null) {
      out += (seg.value as TextSegmentValue).text
      continue
    }
    if (referenceWritesTag(seg.kindId)) {
      const tag = referenceTagOf(seg.kindId, seg.value)
      if (tag) out += formatRefTag(tag)
      continue
    }
    const token = referenceTokenOf(seg.kindId, seg.value)
    if (token !== undefined) out += expandReferenceToken(seg.kindId, token)
  }
  return out
}

/**
 * **正文切分表**。引用全文都认,只在开头认的那一族只认开头那一个词。
 */
export function segmentReferenceText(text: string): ResolvedSegment[] {
  const out: ResolvedSegment[] = []
  appendText(out, text, true)
  return out
}

/**
 * **部件切分表**。
 *
 * 与 runtime 的 `displayTextFromPromptParts` 同一条纪律:**不认识的一律不画**。
 * 「不认识就原样摆出来」在这里是错的 —— 一格 `skill-ref` 的 `content` 正是那份
 * 4862 字的 SKILL.md,而那正是 09-12 报障要治的病。
 */
/**
 * 一格部件里的**显示文字**,不是文字就 `null`。
 *
 * 全壳唯一那一句 —— 切分(下面)与认领(`data/chat-fold.ts` 的
 * `reconcileOverlay` 兜底)读的是同一条判据。分成两处写,总有一天它们会对
 * 「哪几格算文字」有两种意见。
 */
function textOfPart(part: ReferencePart): string | null {
  return part.type === 'text' ? part.content ?? '' : null
}

/**
 * 把账本上的一条用户消息**还原成发送方手里那句话**:文字格原样,引用格按各家
 * 自述的 `parse.part.typed` 还原成用户打的形(`/skill:x`),没说的不占字。
 *
 * 用处只有一个:`reconcileOverlay` 的文本兜底比对(09-13 真机:旧引擎不认
 * `messageId` 时,`/skill:x 干活` 的账本 parts 是 `[skill-ref, text(' 干活')]`,
 * 只拼文字格得到 ` 干活` ≠ 发出的那句 → 那格乐观气泡永远留屏 = 用户看见的
 * 第二条)。**它不是 `displayContent` 的替代品**:屏幕上引用那几格由各自的
 * `render` 画,这里还原的是字节不是形。
 */
export function displayTextOfParts(parts: readonly ReferencePart[]): string {
  const kinds = referencePartKinds()
  let out = ''
  for (const part of parts) {
    const text = textOfPart(part)
    if (text !== null) {
      out += text
      continue
    }
    // 引用那几格:各家自述说它在用户打的那句里长什么样(`typed`),没说就不占字。
    const kind = kinds.find((k) => k.parse!.part!.type === part.type)
    out += kind?.parse!.part!.typed?.(part) ?? ''
  }
  return out
}

export function segmentReferenceParts(parts: readonly ReferencePart[]): ResolvedSegment[] {
  const out: ResolvedSegment[] = []
  const kinds = referencePartKinds()
  let atStart = true
  for (const part of parts) {
    const text = textOfPart(part)
    if (text !== null) {
      appendText(out, text, atStart)
    } else {
      const kind = kinds.find((k) => k.parse!.part!.type === part.type)
      const ref = kind?.parse!.part!.toRef(part)
      if (kind && ref) out.push({ kindId: kind.id, value: ref })
    }
    atStart = false
  }
  return out
}
