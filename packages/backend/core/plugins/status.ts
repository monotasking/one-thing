/**
 * 插件流状态(R6)。
 *
 * 插件在做一件耗时的事时,要能在会话气泡里说一句"我正在做什么" —— 这是插件
 * 唯一一处**出现在对话流里**的界面。
 *
 * 四条设计约束,每条都对应一个具体的坏结局:
 *
 * 1. **一个泛化成员,不是每插件一个类型。** ContentPart 上只加
 *    `{ type: 'plugin-status', pluginId, id, label }` 一种。若按插件加类型,
 *    每来一个插件就要改一次 shared 的 ContentPart 契约 —— 那正是 soul-memory 让
 *    宿主改了 16,989 行的那种形状。R6 的验收口径就是:**此后新增插件状态零改动
 *    那个契约文件**。
 *
 * 2. **状态只在流内有意义。** 它是气泡里的一行临时指示器;没有正在跑的流就没有
 *    气泡,它没有落点。宿主注入 `isStreaming(sessionId)`,不在流内的 show 直接
 *    拒绝 —— 否则那条 `content:part` 到了 renderer 会因为解析不出 messageId 而
 *    落进待发队列,并在**下一次**流开始时贴到一条毫不相干的新消息上(几小时后
 *    诈尸),而强制清扫又永远不会触发(没有流就没有结束事件)。
 *    把状态挂到会话级视图层是另一个产品决策,不该在这里顺手引入。
 *
 * 3. **生命周期由宿主兜底,不由插件保证。** 插件 show 之后可能抛错、被熔断、
 *    被停用、或者干脆忘了 clear。任何一种都会在用户的对话里留下一个**永远转圈**
 *    的状态,而用户没有任何办法让它消失。
 *
 * 4. **状态是一个按 (pluginId, id) 寻址的格子,不是一条追加的消息。**
 *    同一个 id 重复 show 是**更新**(改 label),不是再堆一个;label 没变则
 *    什么也不发 —— 一个每 10ms 汇报一次的插件否则会在十秒内冲掉 EventBus 的
 *    环形缓冲,而 SSE 断线重连正是拿那个缓冲做 `?after=` 重放。
 *
 * 注册表在 core:四个宿主共用同一份寻址与清扫语义,宿主只负责把它接到自己的
 * 事件总线上。
 */

/** ContentPart 上那个泛化成员的类型名。 */
export const PLUGIN_STATUS_PART_TYPE = 'plugin-status'

/** 单条状态的过线形状(与 shared 契约里那个 ContentPart 成员同构)。 */
export interface CorePluginStatusPart {
  type: typeof PLUGIN_STATUS_PART_TYPE
  pluginId: string
  id: string
  label: string
  /**
   * 这条投递表示"撤下"而不是"挂起"。
   *
   * ContentPart 是一个只能追加的数组,没有"删除某一项"的事件 —— 而状态天然
   * 需要撤下。与其为 R6 新开一条投递轨,不如让同一个成员携带这一位:消费端据此
   * 把对应格子标记为已撤下(**不从数组里摘掉** —— 摘掉会让后面所有 part 的
   * 下标平移,而渲染层的 key 依赖"流式期间只追加"这个不变量)。
   */
  cleared?: boolean
  /**
   * 起始**墙钟**(可选)。渲染侧拿它自算 `now - startedAt` 走秒,所以一条会走
   * 秒的状态在总线上仍然只有起、变、落三条事件。宿主每秒补一条带 elapsed 的
   * 事件是同一件事的坏做法:它按秒冲环形缓冲,而那个缓冲是 SSE 重连的重放依据。
   *
   * **`api.status` 不暴露它**:插件说的是"我在做什么",时长是宿主自己知道的事。
   * 目前唯一的写入方是 SDK 外部会话的后台任务翻译层。
   */
  startedAt?: number
  /**
   * 结算之后定格的总时长。有值 ⇒ 这条状态已收场:渲染侧停止走秒,并且不再把它
   * 当成"流内 transient"扫掉(它已经是既成事实,不是一个还在转的圈)。
   */
  durationMs?: number
}

/**
 * 每个**插件**在一个会话里的状态条数上限。
 *
 * 配额按插件而不是按会话:按会话的话,一个跑飞的插件占满 20 格之后,其它插件
 * 一条也挂不上 —— 而 show 只返回 null 不抛,受害的插件根本无从感知。
 */
export const CORE_PLUGIN_STATUS_MAX_PER_PLUGIN = 5

/** 一个会话最多有多少个插件挂着状态。 */
export const CORE_PLUGIN_STATUS_MAX_PLUGINS_PER_SESSION = 8

/**
 * 账本里最多同时存在多少个会话。
 *
 * 没有这个上限的话,`show(randomUUID())` 循环能无界撑大账本 —— 而且每一个新
 * 会话 id 还会在 EventBus 里长出一个永不回收的环形缓冲。
 */
export const CORE_PLUGIN_STATUS_MAX_SESSIONS = 64

/** label 的长度上限 —— 它是一行提示,不是一段日志。 */
export const CORE_PLUGIN_STATUS_MAX_LABEL = 120

/**
 * id 的长度上限。
 *
 * 它同时是账本的键、DOM 的 key、以及跨进程载荷的一部分 —— 三处都不该接受一段
 * 无界字符串。
 */
export const CORE_PLUGIN_STATUS_MAX_ID = 64

/** 同一个格子两次投递之间的最小间隔(毫秒)。 */
export const CORE_PLUGIN_STATUS_THROTTLE_MS = 200

/** id / pluginId 允许的字符 —— 控制字符与分隔符一律拒绝。 */
const SAFE_STATUS_ID = /^[A-Za-z0-9._:-]+$/

export interface CorePluginStatusKey {
  pluginId: string
  id: string
}

export interface CorePluginStatusRecord extends CorePluginStatusKey {
  sessionId: string
  label: string
  /** 最近一次**投递**的时刻 —— 合并窗用。 */
  emittedAt: number
  /** label 变了但被合并窗压住,还没投递出去。 */
  dirty: boolean
}

/**
 * 账本键。
 *
 * 用长度前缀而不是分隔符:任何单字符分隔符都要求"id 里不含它"这个额外假设,
 * 而长度前缀无论内容如何都不会歧义。(初版用了一个**裸 NUL 字节**做分隔符,
 * 后果是 git 把整个文件判成二进制 —— 本期最核心的一个文件在 diff 里不可审。
 * 源码里不要出现裸控制字符;守卫见 headless-boundary-check 的同名规则。)
 */
function statusKey(pluginId: string, id: string): string {
  return `${pluginId.length}:${pluginId}:${id}`
}

export interface CorePluginStatusRegistryOptions {
  /**
   * 会话上是否有正在跑的流。
   *
   * 这是"状态只在流内有意义"的执行点。宿主注入(引擎的活动流表),core 不认识
   * 引擎。不注入时**一律放行** —— 让没接这条线的宿主(测试、headless)照常可用,
   * 而不是静默拒绝一切。
   */
  isStreaming?(sessionId: string): boolean
  /** 一次性告警的出口(重复的同类拒绝不再刷屏)。 */
  warn?(message: string): void
  now?(): number
}

/**
 * 每会话的插件状态账。
 *
 * 它存在的两个理由:**清扫需要知道扫什么**(没有账本,流结束时宿主只能盲发,
 * 也扫不掉插件停用后残留的那些),以及**频控需要知道上一次发了什么**。
 */
export class CorePluginStatusRegistry {
  private bySession = new Map<string, Map<string, CorePluginStatusRecord>>()
  private warnedOnce = new Set<string>()

  constructor(private options: CorePluginStatusRegistryOptions = {}) {}

  private now(): number {
    return this.options.now?.() ?? Date.now()
  }

  private warnOnce(key: string, message: string): void {
    if (this.warnedOnce.has(key)) return
    this.warnedOnce.add(key)
    this.options.warn?.(message)
  }

  private countForPlugin(session: Map<string, CorePluginStatusRecord>, pluginId: string): number {
    let count = 0
    for (const record of session.values()) if (record.pluginId === pluginId) count += 1
    return count
  }

  private distinctPlugins(session: Map<string, CorePluginStatusRecord>): Set<string> {
    const plugins = new Set<string>()
    for (const record of session.values()) plugins.add(record.pluginId)
    return plugins
  }

  /**
   * 挂起或更新一条状态。返回要投递的 part;**返回 null 表示"不必投递"**,
   * 可能是被拒(不合法/不在流内/超配额)也可能是纯粹没变化(频控)。
   *
   * 一律不抛:一个写错 label 的插件不该让它正在跑的那次调用失败。
   */
  show(input: { pluginId: string; sessionId: string; id: string; label: string }): CorePluginStatusPart | null {
    const pluginId = String(input.pluginId ?? '').trim()
    const sessionId = String(input.sessionId ?? '').trim()
    const id = String(input.id ?? '').trim()

    if (!pluginId || !sessionId || !id) return null
    if (id.length > CORE_PLUGIN_STATUS_MAX_ID || !SAFE_STATUS_ID.test(id)) {
      this.warnOnce(`${pluginId}:bad-id`, `[PluginStatus] "${pluginId}" used an unusable status id; ids must match ${SAFE_STATUS_ID} and be at most ${CORE_PLUGIN_STATUS_MAX_ID} chars.`)
      return null
    }

    const label = String(input.label ?? '').trim().slice(0, CORE_PLUGIN_STATUS_MAX_LABEL)
    if (!label) return null

    // 流内语义:没有正在跑的流,这条状态没有落点。
    if (this.options.isStreaming && !this.options.isStreaming(sessionId)) {
      this.warnOnce(
        `${pluginId}:no-stream`,
        `[PluginStatus] "${pluginId}" tried to show a status on session ${sessionId} with no active stream. `
        + 'Plugin status lives inside a running stream (a chat bubble); show it from a tool or a stream hook.',
      )
      return null
    }

    let session = this.bySession.get(sessionId)
    if (!session) {
      if (this.bySession.size >= CORE_PLUGIN_STATUS_MAX_SESSIONS) {
        this.warnOnce('too-many-sessions', `[PluginStatus] Refusing to track more than ${CORE_PLUGIN_STATUS_MAX_SESSIONS} sessions.`)
        return null
      }
      session = new Map()
      this.bySession.set(sessionId, session)
    }

    const key = statusKey(pluginId, id)
    const existing = session.get(key)
    const now = this.now()

    if (existing) {
      // 纯去重:label 没变就什么也不发。这是频控的第一道,也是最有效的一道 ——
      // 汇报进度的插件绝大多数调用其实是同一句话。
      if (existing.label === label) return null
      // 合并窗:窗口内的变化只更账不投递,由宿主的 trailing flush 补发最后一条。
      existing.label = label
      if (now - existing.emittedAt < CORE_PLUGIN_STATUS_THROTTLE_MS) {
        existing.dirty = true
        return null
      }
      existing.emittedAt = now
      existing.dirty = false
      return { type: PLUGIN_STATUS_PART_TYPE, pluginId, id, label }
    }

    if (this.countForPlugin(session, pluginId) >= CORE_PLUGIN_STATUS_MAX_PER_PLUGIN) {
      this.warnOnce(
        `${pluginId}:quota`,
        `[PluginStatus] "${pluginId}" already shows ${CORE_PLUGIN_STATUS_MAX_PER_PLUGIN} statuses on one session; `
        + 'reuse an id to update instead of adding another.',
      )
      return null
    }
    const plugins = this.distinctPlugins(session)
    if (!plugins.has(pluginId) && plugins.size >= CORE_PLUGIN_STATUS_MAX_PLUGINS_PER_SESSION) {
      this.warnOnce('too-many-plugins', `[PluginStatus] Refusing more than ${CORE_PLUGIN_STATUS_MAX_PLUGINS_PER_SESSION} plugins showing status on one session.`)
      return null
    }

    session.set(key, { pluginId, sessionId, id, label, emittedAt: now, dirty: false })
    return { type: PLUGIN_STATUS_PART_TYPE, pluginId, id, label }
  }

  /**
   * 合并窗的 trailing flush:把窗口内被压住的最后一次 label 变化补发出去。
   *
   * 没有它的话,合并窗会丢掉突发的**最后**一条 —— 而最后一条恰恰是最终状态
   * (R5 的 panel-refresh 犯过同一个错,这里不再犯第二次)。
   */
  flushPending(onlySessionId?: string): Array<{ sessionId: string; part: CorePluginStatusPart }> {
    const now = this.now()
    const pending: Array<{ sessionId: string; part: CorePluginStatusPart }> = []
    for (const [sessionId, session] of this.bySession) {
      if (onlySessionId !== undefined && sessionId !== onlySessionId) continue
      for (const record of session.values()) {
        if (!record.dirty) continue
        record.dirty = false
        record.emittedAt = now
        pending.push({
          sessionId: record.sessionId,
          part: {
            type: PLUGIN_STATUS_PART_TYPE,
            pluginId: record.pluginId,
            id: record.id,
            label: record.label,
          },
        })
      }
    }
    return pending
  }

  /** 是否还有被合并窗压住的变化(宿主据此决定要不要排 trailing flush)。 */
  hasPending(): boolean {
    return this.pendingSessionIds().length > 0
  }

  /** 哪些会话还有被压住的变化 —— 补发定时器按会话排,不能一个定时器管全部。 */
  pendingSessionIds(): string[] {
    const ids: string[] = []
    for (const [sessionId, session] of this.bySession) {
      for (const record of session.values()) {
        if (record.dirty) {
          ids.push(sessionId)
          break
        }
      }
    }
    return ids
  }

  /** 撤下一条。返回要投递的 part;本来就不存在时返回 null(不重复发)。 */
  clear(input: { pluginId: string; sessionId: string; id: string }): CorePluginStatusPart | null {
    const sessionId = String(input.sessionId ?? '').trim()
    const pluginId = String(input.pluginId ?? '').trim()
    const id = String(input.id ?? '').trim()
    const session = this.bySession.get(sessionId)
    if (!session) return null
    const key = statusKey(pluginId, id)
    const record = session.get(key)
    if (!record) return null
    session.delete(key)
    if (session.size === 0) this.bySession.delete(sessionId)
    return { type: PLUGIN_STATUS_PART_TYPE, pluginId: record.pluginId, id: record.id, label: record.label, cleared: true }
  }

  /**
   * 强制清扫一个会话的全部插件状态(流结束时调用)。
   *
   * 这是 R6 的兜底:插件 show 之后抛错、超时、被熔断,状态都不会留在气泡里
   * 永远转圈。返回全部要投递的撤下事件。
   */
  clearSession(sessionId: string): CorePluginStatusPart[] {
    const session = this.bySession.get(String(sessionId ?? '').trim())
    if (!session) return []
    this.bySession.delete(String(sessionId ?? '').trim())
    return [...session.values()].map(record => ({
      type: PLUGIN_STATUS_PART_TYPE as typeof PLUGIN_STATUS_PART_TYPE,
      pluginId: record.pluginId,
      id: record.id,
      label: record.label,
      cleared: true,
    }))
  }

  /**
   * 清扫某个插件在**所有**会话里的状态(停用 / 熔断 / 卸载时调用)。
   *
   * 只按会话清扫是不够的:一个被熔断禁用的插件,它挂在别的会话上的状态没人再会
   * 来撤下 —— 那些会话可能几小时后才结束。
   */
  clearPlugin(pluginId: string): Array<{ sessionId: string; part: CorePluginStatusPart }> {
    // 返回带 sessionId:撤下事件必须投回**原会话**,而过线的 part 里没有会话地址。
    const cleared: Array<{ sessionId: string; part: CorePluginStatusPart }> = []
    for (const [sessionId, session] of [...this.bySession]) {
      for (const [key, record] of [...session]) {
        if (record.pluginId !== pluginId) continue
        session.delete(key)
        cleared.push({
          sessionId,
          part: {
            type: PLUGIN_STATUS_PART_TYPE,
            pluginId: record.pluginId,
            id: record.id,
            label: record.label,
            cleared: true,
          },
        })
      }
      if (session.size === 0) this.bySession.delete(sessionId)
    }
    return cleared
  }

  /** 当前挂着的状态(调试与测试用)。 */
  list(sessionId: string): CorePluginStatusRecord[] {
    return [...(this.bySession.get(sessionId)?.values() ?? [])]
  }

  /** 全部会话里挂着的条数。 */
  size(): number {
    let total = 0
    for (const session of this.bySession.values()) total += session.size
    return total
  }

  /** 有多少个会话在账上。 */
  sessionCount(): number {
    return this.bySession.size
  }

  reset(): void {
    this.bySession.clear()
    this.warnedOnce.clear()
  }
}
