import type { StreamDeltaStamp } from '@shared/events/index.js'

/**
 * **水位表**(R 线 R2,`docs/stream-render-2026-09.md` L1)。
 *
 * ── 一句话 ────────────────────────────────────────────────────────────
 * 「这条消息的第 N 段,活流已经到了第几个字」。屏幕上那一段的长度 =
 * `max(账本可画长, 活水位)` —— **同一个字符串的两个前缀取长的那个**。
 *
 * ── 它替掉了什么 ──────────────────────────────────────────────────────
 * 从前壳侧另有一条内容车道(活尾巴),于是需要一整套对账机器:交接线、三把尺、
 * 顺序闸、覆盖限幅、重叠剪裁……六轮事故全部长在那条缝上。水位表让两条车道变成
 * **同一条流的两个前缀**:谁长画谁,「同一截只画一次」「只长不缩」从结构上恒成立,
 * 不再靠记账正确。对账这件事不是修好了,是**不存在了**。
 *
 * ── 三条纪律(逐条对着审查记录)────────────────────────────────────────
 *  · **只存连续前缀**(条 3):`charOffset` 恰等于当前水位才收。小于 = 回声(重连
 *    补发),丢;大于 = 中间缺了一段,**也丢**并计数 —— 带洞的字符串比没有更坏,
 *    账本 ≤2s 自己会把那一段补齐(自愈零成本)。
 *  · **按会话持有**(条 4):这个类是一个**值**,谁开会话谁 new 一份。模块里没有
 *    那一个全局实例 —— 多开 / Dock 活预览 / QuickLook 各读各的。
 *  · **分块攒 + 读时懒拼 + 记忆**(条 5):十万字的段每帧天真拼接是 O(n²)。
 *    delta 进数组,`text()` 才拼,拼完按块数记忆;下一帧没长新块就直接给上一份。
 */

/** 一段的活水位。 */
interface WaterPart {
  kind: StreamDeltaStamp['kind']
  /** 推理段的落点(流自己说的);另两种没有这一格。 */
  placement?: 'top' | 'inline'
  /** 分块攒着,不每帧拼(审查条 5)。 */
  chunks: string[]
  /** 已收到的字符数(= 下一条 delta 该来的偏移)。 */
  length: number
  /** 懒拼的成品与它对应的块数 —— 块数没变就直接给上一份。 */
  joined?: string
  joinedChunks?: number
}

/**
 * 一次**参数还在流**的调用。
 *
 * 它与文本那几段是同一件事的两种形:账本此刻画不出来的那一截。账本要等参数收齐
 * (`tool/call`)才有这次调用,而参数是逐片流的 —— 真机读数:说完一句话之后屏幕上
 * **295ms 什么都没有**,真实工具的参数长得多,空窗按比例放大到数秒。
 *
 * 身份与名字由 `tool:input-start` 事件给(引擎开这一段时就说了),参数正文由
 * `tool-input-delta` 带着 R1 的章来 —— 偏移照样要接得上(审查条 3 一视同仁)。
 */
interface WaterTool {
  toolName: string
  timestamp: number
  chunks: string[]
  length: number
  joined?: string
  joinedChunks?: number
}

/** 一条消息的活水位:按 `partIndex` 分格。 */
interface WaterMessage {
  parts: Map<number, WaterPart>
  /** 参数还在流的调用,按到达序(键 = toolCallId)。 */
  tools: Map<string, WaterTool>
  /** 只增不减的版本号 —— 下游 memo 的键(有没有长新东西,一个数就答得出)。 */
  version: number
}

export interface WaterFeedResult {
  /** 收下了(水位前进) / 回声(已经有了) / 缺段(前面断了,丢并计数)。 */
  outcome: 'accepted' | 'echo' | 'gap'
}

/** 一次还在收参数的调用(读者要的全部)。 */
export interface WaterToolView {
  id: string
  toolName: string
  timestamp: number
  argsText(): string
}

/** 一段此刻的活水位读数(读者要的全部)。 */
export interface WaterPartView {
  partIndex: number
  kind: StreamDeltaStamp['kind']
  placement?: 'top' | 'inline'
  length: number
  text(): string
}

export class StreamWater {
  private readonly messages = new Map<string, WaterMessage>()
  /** 「理论不可能」的计数器(审查条 13:自愈 + 计数,永不 throw)。 */
  private gaps = 0

  /**
   * 一条盖过章的裸 delta 进水位。
   *
   * `gen` 进键:换代(编辑重发 / 重跑)是整段替换,不是就地改(审查条 1)。
   * R1 的 `gen` 恒 0,这一格因此今天只是把位子占住。
   */
  feed(stamp: StreamDeltaStamp, text: string, placement?: 'top' | 'inline'): WaterFeedResult {
    if (!text) return { outcome: 'echo' }
    const message = this.forMessage(stamp.messageId)
    const key = partKey(stamp.partIndex, stamp.gen)
    const part = message.parts.get(key)

    if (!part) {
      // 一段的第一条必须是它的第 0 个字;半路加入的那一段等账本(它 ≤2s 就到)。
      if (stamp.charOffset !== 0) {
        this.gaps += 1
        return { outcome: 'gap' }
      }
      message.parts.set(key, {
        kind: stamp.kind,
        ...(placement ? { placement } : {}),
        chunks: [text],
        length: text.length,
      })
      message.version += 1
      return { outcome: 'accepted' }
    }

    if (stamp.charOffset < part.length) return { outcome: 'echo' }
    if (stamp.charOffset > part.length) {
      this.gaps += 1
      return { outcome: 'gap' }
    }

    part.chunks.push(text)
    part.length += text.length
    if (placement && !part.placement) part.placement = placement
    message.version += 1
    return { outcome: 'accepted' }
  }

  /** 这条消息此刻的水位(按 partIndex 升序)。没有就是空数组。 */
  parts(messageId: string): WaterPartView[] {
    const message = this.messages.get(messageId)
    if (!message) return []
    const out: WaterPartView[] = []
    for (const [key, part] of message.parts) {
      out.push({
        partIndex: partIndexOf(key),
        kind: part.kind,
        ...(part.placement ? { placement: part.placement } : {}),
        length: part.length,
        text: () => joinPart(part),
      })
    }
    return out.sort((a, b) => a.partIndex - b.partIndex)
  }

  /**
   * 一次调用开始收参数(`tool:input-start`)。
   *
   * **只记身份与名字**,不判落点、不判状态:落点由锚点说(这次调用还没有锚点,
   * 于是它落在末尾 —— 而「刚开始的这一次」本来就该在最后),状态由账本说。
   * 幂等:同一个 id 再来一次不重复建卡(重连回放会把同一条事件送两遍)。
   */
  openTool(messageId: string, toolCallId: string, toolName: string, timestamp: number): void {
    if (!messageId || !toolCallId) return
    const message = this.forMessage(messageId)
    if (message.tools.has(toolCallId)) return
    message.tools.set(toolCallId, { toolName, timestamp, chunks: [], length: 0 })
    message.version += 1
  }

  /**
   * 一片参数。**没建过卡的 id 一律不认** —— 名字只有 `tool:input-start` 说得出,
   * 没有名字的一行是编出来的。偏移接不上照样丢(审查条 3)。
   */
  feedToolArgs(messageId: string, toolCallId: string, charOffset: number, text: string): WaterFeedResult {
    const tool = this.messages.get(messageId)?.tools.get(toolCallId)
    if (!tool || !text) return { outcome: 'echo' }
    if (charOffset < tool.length) return { outcome: 'echo' }
    if (charOffset > tool.length) {
      this.gaps += 1
      return { outcome: 'gap' }
    }
    tool.chunks.push(text)
    tool.length += text.length
    this.forMessage(messageId).version += 1
    return { outcome: 'accepted' }
  }

  /** 这条消息此刻还在收参数的那几次调用(按到达序)。 */
  tools(messageId: string): WaterToolView[] {
    const message = this.messages.get(messageId)
    if (!message) return []
    const out: WaterToolView[] = []
    for (const [id, tool] of message.tools) {
      out.push({ id, toolName: tool.toolName, timestamp: tool.timestamp, argsText: () => joinTool(tool) })
    }
    return out
  }

  /**
   * 账本认领了这几个 id —— 那几次调用**按身份退役**,不按长度。
   *
   * 一次调用是不是「账本有了」是个是非题,没有「交出去一半」这回事。
   */
  settleTools(messageId: string, ledgerIds: ReadonlySet<string>): void {
    const message = this.messages.get(messageId)
    if (!message) return
    for (const id of message.tools.keys()) {
      if (ledgerIds.has(id)) message.tools.delete(id)
    }
    if (message.parts.size === 0 && message.tools.size === 0) this.messages.delete(messageId)
  }

  /** 下游 memo 的键:这条消息的水位长过没有(只增不减)。 */
  version(messageId: string): number {
    return this.messages.get(messageId)?.version ?? 0
  }

  /**
   * **清格**:账本对这一段画得出来的长度已经追平水位 —— 那一格退役。
   *
   * 这是第六不变式的落点:打包行到达那一帧只做这件事,而清格**不改 `max` 的结果**
   * (账本 ≥ 水位才清),所以屏幕上零像素变化。清干净了整条消息也一起丢。
   */
  settle(messageId: string, drawableByPart: ReadonlyMap<number, number>): void {
    const message = this.messages.get(messageId)
    if (!message) return
    let changed = false
    for (const [key, part] of message.parts) {
      const drawable = drawableByPart.get(partIndexOf(key))
      if (drawable !== undefined && drawable >= part.length) {
        message.parts.delete(key)
        changed = true
      }
    }
    if (message.parts.size === 0 && message.tools.size === 0) this.messages.delete(messageId)
    // 清格不动 version:它答的是「长过新东西没有」,退役不是长新东西。
    void changed
  }

  /** 这一轮收尾 / 这条消息换代:整条丢。 */
  clearMessage(messageId: string): void {
    this.messages.delete(messageId)
  }

  /** 换会话 / 卸载。 */
  clear(): void {
    this.messages.clear()
  }

  /** 遥测:缺段丢弃了几条(生产应恒 0;不为 0 = 前缀定律被上游破坏)。 */
  get gapCount(): number {
    return this.gaps
  }

  private forMessage(messageId: string): WaterMessage {
    const found = this.messages.get(messageId)
    if (found) return found
    const created: WaterMessage = { parts: new Map(), tools: new Map(), version: 0 }
    this.messages.set(messageId, created)
    return created
  }
}

/**
 * 键 = `partIndex` 与 `gen` 合成的一个数。
 *
 * 用一个数而不是字符串:这条路每帧走,字符串键每帧造一批垃圾。`gen` 今天恒 0,
 * 留 20 位给它(百万级换代,够用到宇宙热寂)。
 */
const GEN_SHIFT = 1_048_576
const partKey = (partIndex: number, gen: number): number => gen * GEN_SHIFT + partIndex
const partIndexOf = (key: number): number => key % GEN_SHIFT

/** 参数原文的懒拼(与正文同一条规矩)。 */
function joinTool(tool: WaterTool): string {
  if (tool.joined !== undefined && tool.joinedChunks === tool.chunks.length) return tool.joined
  const joined = tool.chunks.join('')
  tool.joined = joined
  tool.joinedChunks = tool.chunks.length
  return joined
}

/** 懒拼 + 记忆(审查条 5)。 */
function joinPart(part: WaterPart): string {
  if (part.joined !== undefined && part.joinedChunks === part.chunks.length) return part.joined
  const joined = part.chunks.join('')
  part.joined = joined
  part.joinedChunks = part.chunks.length
  return joined
}
