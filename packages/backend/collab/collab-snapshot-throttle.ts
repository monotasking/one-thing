/**
 * 快照广播的**双档节流**(架构收敛 C4 §1 立的规矩,D8 §7 沿用)。
 *
 * 这个文件里只有时间,没有内容 —— 它不知道谁在播、播的是什么,只回答一个问题:
 * 「这一发现在说,还是攒到某个时刻再说」。房间快照(inspector)与 agent 快照
 * (agent-activity)共用它。
 *
 * 抽出来的理由不是"少写几行":两条广播链的节流规则**必须**一模一样,而两份各自
 * 演化的实现迟早会在某个边角上分家(尾发丢不丢、短窗口能不能抢长窗口的位置),
 * 而那种分家只在真机的某一帧上现身。第三份复制是这个文件被写出来的直接原因。
 *
 * 三条规则,逐条对应 C4 的实测教训:
 *
 *  1. **窗口里的多次推送攒成一次尾发,不丢最后一帧**。最后那一次通常正是"停下来
 *     了"这种最该被看见的状态,丢了界面就永远停在倒数第二帧;
 *  2. **快照是现算的全量**,所以谁触发的都一样 —— 规则只有一条:**到期早的那一发
 *     说了算**。一发已经排在 900ms 之后的普通推送,不该把一次要在 120ms 内亮起来
 *     的灯拖着一起等;
 *  3. **`lastSentAt` 由回调自己盖**。发不出去(快照现算下来是 null)的那一次不该
 *     消耗掉节流预算 —— 否则一次空推能把真正的下一帧压住整整一个窗口。
 */

/** 普通推送的节流窗口。快照本身很小,但一次判定轮能在几毫秒里连着改好几处状态。 */
export const COLLAB_SNAPSHOT_THROTTLE_MS = 1_000

/**
 * **活动**转变的节流窗口 —— 比上面那道短一个量级。
 *
 * 活动转变不是"面板上的一个数字",而是界面上会**动**的东西:停止按钮的出现、
 * 打字波纹的亮灭、徽标从🟡翻到🟢。按秒节流的话,想打断的人要等最多一秒按钮才画
 * 出来,而一句短 `say` 的灯会被整个吞掉("打了又删"那一帧再也看不到)。
 *
 * 仍然是节流而不是直发:同一个回合里 `say` 可以连着调好几次,而 120ms 已经短到
 * 人眼读作"立刻"。
 */
export const COLLAB_SNAPSHOT_ACTIVITY_THROTTLE_MS = 120

/** 一条广播链的节流槽。房间一间一个,agent 一位一个(一个话痨不拖累别人)。 */
export interface CollabSnapshotThrottle {
  /** 上一次真正发出去的时刻。 */
  lastSentAt: number
  /** 节流窗口里攒下的那一次待发。 */
  pending?: ReturnType<typeof setTimeout>
  /** 那一次待发的到期时刻 —— 短窗口的请求要能抢在长窗口的待发之前。 */
  pendingDueAt?: number
}

export function createCollabSnapshotThrottle(): CollabSnapshotThrottle {
  return { lastSentAt: 0 }
}

/** 撤掉待发。删房/删人、以及进程收摊都要走它 —— 一发广播不该活过它的发行方。 */
export function clearCollabSnapshotThrottle(slot: CollabSnapshotThrottle): void {
  if (slot.pending) clearTimeout(slot.pending)
  slot.pending = undefined
  slot.pendingDueAt = undefined
}

export interface CollabSnapshotThrottleOptions {
  /** 走短窗口(见 `COLLAB_SNAPSHOT_ACTIVITY_THROTTLE_MS`)。 */
  activity?: boolean
  /** 注入时钟,测试用。 */
  now?: number
}

/**
 * 推一次(节流)。
 *
 * `emit` 负责发,并且**自己盖 `slot.lastSentAt`** —— 见文件头第 3 条。
 */
export function scheduleCollabSnapshot(
  slot: CollabSnapshotThrottle,
  emit: () => void,
  options: CollabSnapshotThrottleOptions = {},
): void {
  const throttleMs = options.activity
    ? COLLAB_SNAPSHOT_ACTIVITY_THROTTLE_MS
    : COLLAB_SNAPSHOT_THROTTLE_MS
  const now = options.now ?? Date.now()
  const elapsed = now - slot.lastSentAt
  if (elapsed >= throttleMs) {
    clearCollabSnapshotThrottle(slot)
    emit()
    return
  }
  const dueAt = now + (throttleMs - elapsed)
  // 已经排了一发、而且到期不比这一发晚 —— 让它去说。
  if (slot.pending && slot.pendingDueAt !== undefined && slot.pendingDueAt <= dueAt) return
  clearCollabSnapshotThrottle(slot)
  slot.pendingDueAt = dueAt
  slot.pending = setTimeout(() => {
    clearCollabSnapshotThrottle(slot)
    emit()
  }, dueAt - now)
  slot.pending.unref?.()
}
