/**
 * 自动收起的可见性门(messagelist 过程区整改 · 第五步)。
 *
 * 前四步给「自动塌缩」补了滚动补偿:塌缩发生在视口**顶之上**时,把塌掉的高度
 * 还给 scrollTop。但用户实测下来仍然"丢内容",因为真实场景根本不在那条规则的
 * 覆盖面里 —— 元素**就在眼前**。用户正读着 rail 里的输出、或紧贴它下面那段字,
 * 流一结束 rail 自己折了:眼前的东西消失、下方内容上移。按补偿规范这时候不该
 * 动 scrollTop(补了反而把它上面的内容推下来),所以补偿一分钱也帮不上。
 *
 * 结论是更靠前的一条:**不该在用户看着它的时候收**。这里就是那道门,只管
 * 「自动」收起(用户点击不经过,立即生效):
 *
 * 1. 贴底跟随中 → 立即收(底部锚定,视觉本来就稳);
 * 2. 元素完全在滚动视口外(上方或下方)→ 立即收(在上方时补偿继续兜偏移);
 * 3. 元素与视口相交 且 用户已脱离跟底 → **挂起**:保持展开,直到
 *    - 元素滚出视口(IntersectionObserver,懒创建),或
 *    - 用户重新贴底,或
 *    - 用户手动 toggle(意图直接生效,挂起取消),或
 *    - 新一轮 streaming 又把它自动展开(挂起取消),或
 *    - 组件卸载(直接作废,不执行)。
 *
 * 门在补偿**之前**:它只决定"现在收还是等会儿收";真正收的那一刻,补偿照旧。
 *
 * 降级:没有 IntersectionObserver(happy-dom / jsdom)、量不到滚动容器、或者
 * 拿不到跟底状态(挂在 MessageList 之外,比如侧栏)时,一律"立即收" —— 即现状,
 * 不引入行为突变。
 */
import {
  getCurrentInstance,
  onUnmounted,
  watch,
  type ComputedRef,
  type Ref,
} from 'vue'
import { findScrollContainer } from '@/utils/collapse-compensation'
import { useChatFollowState } from '@/composables/useFollowScroll'

/** 门的裁决:立即收起,还是挂起等一等。 */
export type DeferredCollapseOutcome = 'collapse' | 'defer'

/** 离开挂起态的两种原因。`collapse` 才真的要收。 */
export type DeferredReleaseReason = 'collapse' | 'cancel'

export type FollowStateSource = (() => boolean) | Ref<boolean> | ComputedRef<boolean>

export interface UseDeferredAutoCollapseOptions<K> {
  /**
   * 跟底状态。默认从 MessageList 注入(`provideChatFollowState`);
   * 拿不到时视为 **true**(= 立即收起 = 旧行为),而不是保守挂起:
   * 非 MessageList 挂载点不该因为这道门改变表现。
   */
  isFollowing?: FollowStateSource
  /** 进入挂起:调用方请保持这一项展开。 */
  onDefer?: (key: K) => void
  /** 离开挂起:调用方请丢掉"保持展开"的本地状态;`collapse` 时收起随即发生。 */
  onRelease?: (key: K, reason: DeferredReleaseReason) => void
}

export interface DeferredAutoCollapseGate<K> {
  /**
   * 自动收起前问一次门。返回 `'collapse'` 表示照收不误(调用方什么都不用改),
   * `'defer'` 表示已登记挂起(`onDefer` 已同步触发)。
   */
  request: (key: K, element: HTMLElement | null | undefined) => DeferredCollapseOutcome
  /** 取消挂起(用户手动介入 / 重新展开):不收起。 */
  cancel: (key: K) => void
  /** 取消全部挂起。 */
  cancelAll: () => void
  /** 立刻放行全部挂起(重新贴底时的内部路径,也供测试直接驱动)。 */
  releaseAll: () => void
  isPending: (key: K) => boolean
  pendingKeys: () => K[]
}

interface PendingEntry {
  element: HTMLElement
  observer: IntersectionObserver | null
}

function readFollowState(source: FollowStateSource | null | undefined): boolean {
  if (!source) return true
  return typeof source === 'function' ? source() : source.value
}

/**
 * 元素是否与滚动容器的视口相交(纯几何,便于单测)。
 * 完全在视口上方或下方 = 不相交 = 用户看不见它收。
 */
export function intersectsScrollerViewport(
  element: HTMLElement,
  scroller: HTMLElement,
): boolean {
  const elRect = element.getBoundingClientRect()
  const boxRect = scroller.getBoundingClientRect()
  if (elRect.bottom <= boxRect.top) return false
  if (elRect.top >= boxRect.bottom) return false
  return true
}

/**
 * 展开态的合成 —— 「用户 intent > deferred > auto」这句话的唯一实现。
 *
 * 三票,优先级从高到低:
 *  1. `recorded` —— 落在 expansion-intent 记录里的用户意图(跨重挂载存活);
 *  2. `userToggled` —— 本实例内的用户 toggle(没有 intentKey 时唯一的用户票);
 *  3. `auto` / `deferred` —— 自动展开,以及「auto 想收但用户正看着它」的挂起票。
 *
 * 前两票一旦有值就一锤定音:用户说收就收,挂起票掀不翻它。只有在两票都缺席时
 * auto 与 deferred 才以**或**的关系生效。
 */
export function resolveDeferredExpanded(input: {
  /** expansion-intent 记录;`undefined` = 用户没表过态。 */
  recorded?: boolean | undefined
  /** 本实例内的 toggle;`null` = 没点过。 */
  userToggled?: boolean | null
  auto: boolean
  deferred: boolean
}): boolean {
  if (input.recorded !== undefined) return input.recorded
  if (input.userToggled !== null && input.userToggled !== undefined) return input.userToggled
  return input.auto || input.deferred
}

/**
 * 同一套合成的**多键**形态(StepsPanel 的受控集合)。
 *
 * 差异是真实的,不是疏忽:这里的 `base` 是已经把 intent 揉进去的结果集
 * (`recorded ?? (auto || subtreeHasIntent)`),所以每个 key 只剩 auto 与
 * deferred 两票 —— 也就是说一个 key 若同时"被用户记为收起"又"挂着自动收起",
 * 集合形态会让它保持展开,而单键形态(ProcessRail)会听用户的。实际路径上不会
 * 撞上:用户一 toggle 就 `cancel` 掉了那条挂起。保留差异,不抹平。
 *
 * `undefined` 原样透传:CollapseGroup 收到 `undefined` 就是"不受控"(旧行为)。
 */
export function resolveDeferredExpandedKeys<K>(
  base: readonly K[] | undefined,
  deferred: readonly K[],
): K[] | undefined {
  if (!base) return undefined
  if (deferred.length === 0) return [...base]
  const inBase = new Set<K>(base)
  const inDeferred = new Set<K>(deferred)
  // auto 裁定展开的那批保持原序在前,挂起票带进来的补在后面。
  const seen = new Set<K>()
  const merged: K[] = []
  for (const key of [...base, ...deferred]) {
    if (seen.has(key)) continue
    seen.add(key)
    if (!resolveDeferredExpanded({ auto: inBase.has(key), deferred: inDeferred.has(key) })) continue
    merged.push(key)
  }
  return merged
}

export function useDeferredAutoCollapse<K = string>(
  options: UseDeferredAutoCollapseOptions<K> = {},
): DeferredAutoCollapseGate<K> {
  // inject 只能在 setup 期调用 —— 显式传入的 source 优先,便于测试与非组件用法。
  const followSource: FollowStateSource | null =
    options.isFollowing ?? (getCurrentInstance() ? useChatFollowState() : null) ?? null

  const pending = new Map<K, PendingEntry>()

  function disconnect(entry: PendingEntry): void {
    entry.observer?.disconnect()
    entry.observer = null
  }

  /** 只拆监听、不回调:卸载路径用。 */
  function dispose(): void {
    for (const entry of pending.values()) disconnect(entry)
    pending.clear()
  }

  function release(key: K, reason: DeferredReleaseReason): void {
    const entry = pending.get(key)
    if (!entry) return
    disconnect(entry)
    pending.delete(key)
    options.onRelease?.(key, reason)
  }

  function request(key: K, element: HTMLElement | null | undefined): DeferredCollapseOutcome {
    // 已经挂着了就别重复登记(也别重复触发 onDefer)。
    if (pending.has(key)) return 'defer'
    // 1. 贴底跟随中:底部锚定,收起不会把眼前的东西挪走。
    if (readFollowState(followSource)) return 'collapse'
    if (!element) return 'collapse'
    const scroller = findScrollContainer(element)
    if (!scroller) return 'collapse'
    // 2. 完全在视口外:用户看不见,收了也不会"眼前一空"。
    if (!intersectsScrollerViewport(element, scroller)) return 'collapse'
    // 无 IO(happy-dom / 老环境):没法知道它何时滚出视口 → 退化为立即收起。
    if (typeof IntersectionObserver === 'undefined') return 'collapse'

    const entry: PendingEntry = { element, observer: null }
    pending.set(key, entry)
    try {
      const observer = new IntersectionObserver(
        (entries) => {
          // 挂上的那一刻 IO 会回调一次当前状态(相交),忽略即可。
          if (entries.some(record => record.isIntersecting)) return
          release(key, 'collapse')
        },
        { root: scroller },
      )
      observer.observe(element)
      entry.observer = observer
    } catch {
      // 造不出 observer 就不挂起 —— 宁可收早了,也不要一个永远醒不来的挂起。
      pending.delete(key)
      return 'collapse'
    }

    options.onDefer?.(key)
    return 'defer'
  }

  function cancel(key: K): void {
    release(key, 'cancel')
  }

  function cancelAll(): void {
    for (const key of [...pending.keys()]) release(key, 'cancel')
  }

  function releaseAll(): void {
    for (const key of [...pending.keys()]) release(key, 'collapse')
  }

  // 用户重新贴底 → 底部锚定重新成立,挂着的这批可以收了。
  if (followSource) {
    watch(
      () => readFollowState(followSource),
      (following) => {
        if (following) releaseAll()
      },
    )
  }

  if (getCurrentInstance()) {
    // 卸载 / 会话切换:挂起直接作废,不执行(收给谁看)。
    onUnmounted(dispose)
  }

  return {
    request,
    cancel,
    cancelAll,
    releaseAll,
    isPending: key => pending.has(key),
    pendingKeys: () => [...pending.keys()],
  }
}
