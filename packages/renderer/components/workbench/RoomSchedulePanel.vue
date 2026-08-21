<template>
  <section class="room-schedule">
    <div class="rs-scroll">
      <!-- ① 租约表:谁持牌、为什么发的、多久了、真在生成吗。 -->
      <div class="rs-sec">
        <span>租约</span>
        <i class="rs-count">{{ leases.length }}</i>
      </div>
      <p
        v-if="!leases.length"
        class="rs-empty"
      >
        此刻没有牌在外面。
      </p>
      <div
        v-for="lease in leases"
        :key="lease.key"
        class="rs-lease"
        :class="{ 'is-run': lease.executing }"
      >
        <span class="rs-name">{{ lease.name }}</span>
        <span class="rs-state">{{ lease.stateText }}</span>
        <span class="rs-meta">{{ lease.reason }}</span>
        <span class="rs-at">{{ formatCoordinatorElapsed(lease.since, now) }}</span>
        <span class="rs-lease-id">{{ shortLeaseId(lease.leaseId) }}</span>
        <!--
          「撤牌」= 人级停止(E5)。只动这一张牌,同房其他人不受影响 —— 这与
          状态条那颗房级的「停」是两个动作,见 <script> 里那段说明。
        -->
        <Tooltip :text="`收回 ${lease.name} 手里的这张牌,并停掉它此刻在飞的那一轮`">
          <button
            type="button"
            class="rs-revoke"
            :disabled="revoking === lease.leaseId"
            @click="revoke(lease)"
          >
            {{ revoking === lease.leaseId ? '收牌中' : '撤牌' }}
          </button>
        </Tooltip>
      </div>
      <p
        v-if="revokeError"
        class="rs-empty is-warn"
      >
        {{ revokeError }}
      </p>

      <!-- ② 举手队列:人 / 原因 / 卡在哪道闸 / 举了多久。 -->
      <div class="rs-sec">
        <span>举手</span>
        <i class="rs-count">{{ hands.length }}</i>
      </div>
      <p
        v-if="!hands.length"
        class="rs-empty"
      >
        没有人在排队。
      </p>
      <div
        v-for="hand in hands"
        :key="hand.key"
        class="rs-hand"
      >
        <span class="rs-name">{{ hand.name }}</span>
        <Tooltip :text="hand.gateHint">
          <span
            class="rs-gate"
            :class="{ 'is-actionable': hand.actionable }"
          >{{ hand.gateLabel }}</span>
        </Tooltip>
        <span class="rs-meta">{{ hand.reason }}</span>
        <span class="rs-at">{{ hand.raisedAt ? formatCoordinatorElapsed(hand.raisedAt, now) : '' }}</span>
      </div>

      <!-- ③ 裁决卡片:当前窗三态 + 最近一次的完整回放。 -->
      <div class="rs-sec">
        <span>裁决</span>
      </div>
      <div
        class="rs-judge-now"
        :class="`is-${judgment?.state ?? 'idle'}`"
      >
        <i
          class="rs-judge-mark"
          aria-hidden="true"
        />
        <span class="rs-judge-text">{{ judgment?.text ?? '窗关着' }}</span>
        <span
          v-if="judgment?.state === 'debouncing'"
          class="rs-at"
        >{{ judgment.countdown }}</span>
        <span
          v-else-if="judgment?.state === 'inflight'"
          class="rs-at"
        >{{ formatCoordinatorElapsed(judgment.since, now) }}</span>
        <span
          v-else-if="judgment?.state === 'degraded'"
          class="rs-at"
        >{{ formatCoordinatorAgo(judgment.at, now) }}</span>
      </div>
      <p
        v-if="!verdict"
        class="rs-empty"
      >
        账上还没有裁决记录。
      </p>
      <div
        v-else
        class="rs-verdict"
        :class="{ 'is-degraded': verdict.degraded }"
      >
        <div class="rs-verdict-head">
          <span class="rs-verdict-order">{{ verdictOrderText }}</span>
          <span class="rs-at">{{ formatCoordinatorAgo(verdict.at, now) }}</span>
        </div>
        <p
          v-if="verdict.why"
          class="rs-verdict-why"
        >
          {{ verdict.why }}
        </p>
        <p
          v-if="verdict.degraded"
          class="rs-verdict-why is-warn"
        >
          降级:{{ verdict.degradedReason || '未注明' }} —— 这一轮回落 FIFO
        </p>
        <div class="rs-verdict-meta">
          <span v-if="verdict.candidates.length">候选 {{ verdict.candidates.length }}</span>
          <span v-if="verdict.elapsedMs">{{ verdict.elapsedMs }}ms</span>
          <span v-if="verdict.model">{{ verdict.model }}</span>
        </div>
      </div>

      <!-- ④ 时间轴:尾部 N 条,按类型着四档色,因果引用读成人话。 -->
      <div class="rs-sec">
        <span>时间轴</span>
        <button
          type="button"
          class="rs-reload"
          :disabled="loading"
          @click="reload"
        >
          {{ loading ? '读取中' : '刷新' }}
        </button>
      </div>
      <div class="rs-filters">
        <button
          v-for="option in ROOM_SCHEDULE_LOG_FILTERS"
          :key="option.key || 'all'"
          type="button"
          class="rs-filter"
          :class="{ 'is-on': option.key === filter }"
          @click="filter = option.key"
        >
          {{ option.label }}
        </button>
      </div>
      <p
        v-if="logError"
        class="rs-empty is-warn"
      >
        {{ logError }}
      </p>
      <p
        v-else-if="!logRows.length"
        class="rs-empty"
      >
        {{ filter ? '这一类还没有记录。' : '账上还没有这间房的调度记录。' }}
      </p>
      <div
        v-for="row in logRows"
        :key="row.key"
        class="rs-log"
        :class="`is-${row.tone}`"
      >
        <span class="rs-log-at">{{ formatCoordinatorAgo(row.at, now) }}</span>
        <span class="rs-log-text">{{ row.text }}</span>
        <span
          v-if="row.triggeredBy"
          class="rs-log-from"
        >{{ row.triggeredBy }}</span>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
/**
 * 房间背台的「调度」格 —— D8 观测体系 §4.2。
 *
 * 状态条(`CoordinatorStatusBar`)挂在线程格顶上,宽度只够一行,答的是「此刻一句话
 * 概括」。这一格是它的展开面:租约表、举手队列、裁决卡片、时间轴四块,回答蓝图那
 * 四个必答问题里的第一个(「这间房现在怎么了」)与第四个(「刚才为什么是那样」)。
 *
 * 这一层只画像素。措辞、闸的次序、着色分档、因果引用怎么读,全在 `room-schedule.ts`。
 *
 * ## 「撤牌」这颗按钮(E5 人级停止)
 *
 * 蓝图 §4.2 写的是「每行可操作『撤牌』(走既有 revoke)」。O2 那一版把它做成了
 * **只读**,理由是当时**既有的 revoke 没有面向渲染层的通道**:运行时那侧只有
 * `stopCollabV3RoomFloor`(换代 = 把全部牌一起作废),而一颗写着「撤牌」、按下去
 * 却把整间房清场的按钮,比没有这颗按钮糟得多。那一版同时点名了要真做该怎么做 ——
 * 「在 O0 那一层加一条 `collab:room-revoke-lease`,带 leaseId + epoch 前置条件」。
 *
 * E5 就是照那句话做的:通道有了(`revokeCollabRoomLease` → app 层
 * `revokeCollabV3RoomLease`),按钮因此从只读翻成可操作,而且它撤的**就是这一行
 * 那张牌** —— 撤牌 + 掐这条执行会话的流 + 停外部执行体,同房其他人一个字不受影响。
 *
 * epoch 前置条件由 store 现取(见 `collabBoard.revokeLease`):代数是屏幕上这份
 * 快照的属性,不是按钮的参数。
 */
import { computed, onUnmounted, ref, watch } from 'vue'
import { useAgentsStore } from '@/stores/agents'
import { useCollabBoardStore } from '@/stores/collabBoard'
import { useSessionsStore } from '@/stores/sessions'
import Tooltip from '@/components/common/Tooltip.vue'
import { collabApi } from '@/platform/collab-client'
import type { CollabSchedulerLogEntry } from '@shared/ipc'
import {
  buildCoordinatorJudgment,
  coordinatorReasonLabel,
  formatCoordinatorAgo,
  formatCoordinatorElapsed,
} from './coordinator-status'
import {
  buildRoomScheduleHands,
  buildRoomScheduleLeases,
  buildRoomScheduleLogRows,
  buildRoomScheduleVerdict,
  ROOM_SCHEDULE_LOG_FILTERS,
  ROOM_SCHEDULE_LOG_ROWS,
} from './room-schedule'

const props = defineProps<{
  roomSessionId: string
  /** 外部入口带来的时间轴过滤(死信红点跳过来时是 'dead-letter')。 */
  initialFilter?: string
  /** 每次落座 +1;同一个过滤器也要能重放一次(第二次点红点 = 再带我去一次)。 */
  landingNonce?: number
}>()

const agentsStore = useAgentsStore()
const collabBoardStore = useCollabBoardStore()
const sessionsStore = useSessionsStore()

const filter = ref(props.initialFilter || '')
const log = ref<CollabSchedulerLogEntry[]>([])
const logError = ref('')
const loading = ref(false)

const state = computed(() => collabBoardStore.coordinatorFor(props.roomSessionId))

const resolveName = (agentId: string): string => agentsStore.displayAgent(agentId).name
/** 房名经 sessions store;拿不到就退回 id(比空着好:id 仍然查得动)。 */
const resolveRoomName = (roomSessionId: string): string =>
  sessionsStore.sessions.find(item => item.id === roomSessionId)?.name || roomSessionId
const resolveMindRoom = (agentId: string): string => {
  const mind = collabBoardStore.agentActivityFor(agentId)?.mind
  return mind?.state === 'thinking' ? mind.roomSessionId : ''
}

/**
 * 秒针。只在这一格挂着的时候走,而且只有 1s ——「持了多久 / 举了多久」是这一面
 * 唯一需要秒级刷新的东西。
 */
const now = ref(Date.now())
const timer = setInterval(() => { now.value = Date.now() }, 1_000)
onUnmounted(() => { clearInterval(timer) })

const leases = computed(() => buildRoomScheduleLeases({
  state: state.value,
  resolveName,
  resolveMindRoom,
  resolveRoomName,
  reasonLabel: coordinatorReasonLabel,
}))

const hands = computed(() => buildRoomScheduleHands({
  state: state.value,
  resolveName,
  reasonLabel: coordinatorReasonLabel,
  log: log.value,
}))

const judgment = computed(() => buildCoordinatorJudgment(state.value, resolveName, now.value))
const verdict = computed(() => buildRoomScheduleVerdict(log.value))

const verdictOrderText = computed(() => {
  const order = verdict.value?.order ?? []
  return order.length > 0 ? order.map(resolveName).join(' → ') : '这轮无人发言'
})

const logRows = computed(() => buildRoomScheduleLogRows({
  log: log.value,
  resolveName,
  filter: filter.value,
  limit: ROOM_SCHEDULE_LOG_ROWS,
}))

/**
 * 撤牌(E5 人级停止)。
 *
 * 三条失败原因各自有话可说,一条都不许退化成「操作失败」:`epoch-stale` 是"你这
 * 一屏过时了"(store 已经顺手重取快照)、`not-found` 是"这张牌本来就已经不在了"、
 * `not-a-room` 是"这个宿主/这间房够不着运行时"。原因说不清的按钮会让人反复点,
 * 而每一次点都是一次真的停止尝试。
 */
const revoking = ref('')
const revokeError = ref('')

async function revoke(lease: { leaseId: string; name: string }): Promise<void> {
  if (!props.roomSessionId || revoking.value) return
  revoking.value = lease.leaseId
  revokeError.value = ''
  try {
    const result = await collabBoardStore.revokeLease(props.roomSessionId, lease.leaseId)
    if (result.ok) return
    revokeError.value = result.reason === 'epoch-stale'
      ? '这一屏已经是上一轮的事了(房间换过代),刚给你重取了一份。'
      : result.reason === 'not-found'
        ? `${lease.name} 手里这张牌已经不在了 —— 它刚让位、过期或被换代作废。`
        : '够不着这间房的运行时(桌面端专属)。'
  } catch (error) {
    revokeError.value = error instanceof Error ? error.message : String(error)
  } finally {
    revoking.value = ''
  }
}

function shortLeaseId(leaseId: string): string {
  const hash = leaseId.indexOf('#')
  return hash >= 0 ? leaseId.slice(hash + 1) : leaseId
}

/**
 * 时间轴**一次读到底,不订阅**。
 *
 * 它是诊断不是直播:一条按秒刷新的日志流既费电又让人读不完一行。刷新是显式动作
 * (段头那颗按钮),换房与落座各自读一次。
 */
async function reload(): Promise<void> {
  if (!props.roomSessionId) return
  loading.value = true
  logError.value = ''
  try {
    const response = await collabApi.schedulerLogTail({
      roomSessionId: props.roomSessionId,
      limit: ROOM_SCHEDULE_LOG_ROWS * 2,
    })
    if (!response?.success) {
      logError.value = response.error || '读不到调度账本。'
      log.value = []
      return
    }
    log.value = response.rows ?? []
  } catch (error) {
    logError.value = error instanceof Error ? error.message : String(error)
    log.value = []
  } finally {
    loading.value = false
  }
}

watch(() => props.roomSessionId, id => {
  filter.value = props.initialFilter || ''
  log.value = []
  if (!id) return
  void collabBoardStore.loadCoordinator(id)
  void reload()
}, { immediate: true })

// 落座指令:换过滤器 + 重读一次(死信红点跳过来的那一路)。
watch(() => props.landingNonce, () => {
  if (props.initialFilter !== undefined) filter.value = props.initialFilter
  void reload()
})

// 持牌的人要问一次 agents 账 —— 「等大脑」与「在别处思考」的分界只有那本账知道。
watch(() => (state.value?.turns ?? []).map(turn => turn.agentId).join(','), () => {
  const agentIds = (state.value?.turns ?? []).map(turn => turn.agentId).filter(Boolean)
  if (agentIds.length > 0) collabBoardStore.ensureAgentActivity(agentIds)
}, { immediate: true })

defineExpose({ reload })
</script>

<style scoped>
.room-schedule {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  background: var(--ui-surface-panel-bg);
}

.rs-scroll {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  padding-bottom: 12px;
}

.rs-scroll:not(:hover)::-webkit-scrollbar-thumb {
  background: transparent;
}

/* 段头:与状态条的 `.cd-sec` 同一 register(小、灰、贴着内容)。 */
.rs-sec {
  display: flex;
  gap: 6px;
  align-items: center;
  padding: 11px 12px 3px;
  color: var(--ui-text-muted-fg);
  font-size: 10.5px;
  letter-spacing: 0.02em;
}

.rs-count {
  font-family: var(--font-mono, monospace);
  font-style: normal;
  font-variant-numeric: tabular-nums;
}

.rs-reload {
  margin-left: auto;
  padding: 0;
  border: 0;
  background: none;
  color: var(--ui-text-muted-fg);
  cursor: pointer;
  font: inherit;
  font-size: 10.5px;
}

.rs-reload:hover:not(:disabled) {
  color: var(--ui-text-primary-fg);
}

.rs-empty {
  margin: 0;
  padding: 3px 12px 6px;
  color: var(--ui-text-faint-fg, var(--ui-text-muted-fg));
  font-size: 11.5px;
}

.rs-empty.is-warn {
  color: var(--ui-status-warning-fg, var(--color-warning));
}

/* ── 租约 / 举手:同一条行式骨架,行宽不跳 ── */
.rs-lease,
.rs-hand {
  display: flex;
  gap: 8px;
  align-items: baseline;
  padding: 4px 12px;
}

.rs-name {
  flex: 0 1 auto;
  min-width: 0;
  overflow: hidden;
  color: var(--ui-text-primary-fg);
  font-size: 12.5px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.rs-state {
  flex: 0 0 auto;
  color: var(--ui-text-muted-fg);
  font-size: 11px;
}

/* 真在生成的那一行才上墨 —— 「持牌」与「生成中」在这一列上必须看得出差别。 */
.rs-lease.is-run .rs-state {
  color: var(--ui-status-success-fg, var(--color-success));
}

.rs-meta {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  color: var(--ui-text-faint-fg, var(--ui-text-muted-fg));
  font-size: 11px;
  text-overflow: ellipsis;
  white-space: nowrap;
  text-align: right;
}

.rs-at {
  flex: 0 0 auto;
  color: var(--ui-text-muted-fg);
  font-family: var(--font-mono, monospace);
  font-size: 10.5px;
  font-variant-numeric: tabular-nums;
}

.rs-lease-id {
  flex: 0 0 auto;
  color: var(--ui-text-faint-fg, var(--ui-text-muted-fg));
  font-family: var(--font-mono, monospace);
  font-size: 10px;
}

/* 撤牌:与刷新那颗同一句法(裸字、悬停才亮)。停止是个重动作,但它不该在
   一张诊断表上一直嚷嚷 —— 扎眼的位置留给要人动手的闸。 */
.rs-revoke {
  flex: 0 0 auto;
  padding: 0;
  border: 0;
  background: none;
  color: var(--ui-text-faint-fg, var(--ui-text-muted-fg));
  cursor: pointer;
  font: inherit;
  font-size: 10.5px;
}
.rs-revoke:hover:not(:disabled) {
  color: var(--ui-status-danger-fg, var(--color-danger));
}
.rs-revoke:disabled {
  cursor: default;
}

.rs-empty.is-warn {
  color: var(--ui-status-warning-fg, var(--color-warning));
}

/* 闸:要人动手的四道加重(与状态条的排队徽标同一句法)。 */
.rs-gate {
  flex: 0 0 auto;
  padding: 0 5px;
  border: 1px solid var(--ui-border-subtle-border);
  color: var(--ui-text-muted-fg);
  font-size: 10.5px;
}

.rs-gate.is-actionable {
  border-color: var(--ui-status-warning-fg, var(--color-warning));
  color: var(--ui-status-warning-fg, var(--color-warning));
}

/* ── 裁决 ── */
.rs-judge-now {
  display: flex;
  gap: 8px;
  align-items: center;
  padding: 4px 12px;
  font-size: 11.5px;
}

.rs-judge-mark {
  flex: 0 0 auto;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: transparent;
  box-shadow: inset 0 0 0 1px var(--ui-text-muted-fg);
}

.rs-judge-now.is-inflight .rs-judge-mark {
  background: var(--ui-text-primary-fg);
  box-shadow: none;
}

.rs-judge-now.is-degraded {
  color: var(--ui-status-warning-fg, var(--color-warning));
}

.rs-judge-now.is-degraded .rs-judge-mark {
  background: var(--ui-status-warning-fg, var(--color-warning));
  border-radius: 1px;
  box-shadow: none;
}

.rs-judge-text {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* 回放卡片:左侧一道墨线,与账页系其余的引用块同一句法。 */
.rs-verdict {
  margin: 2px 12px 4px;
  padding: 6px 0 6px 9px;
  border-left: 1.5px solid var(--ui-border-subtle-border);
}

.rs-verdict.is-degraded {
  border-left-color: var(--ui-status-warning-fg, var(--color-warning));
}

.rs-verdict-head {
  display: flex;
  gap: 8px;
  align-items: baseline;
}

.rs-verdict-order {
  flex: 1 1 auto;
  min-width: 0;
  color: var(--ui-text-primary-fg);
  font-size: 12px;
}

.rs-verdict-why {
  margin: 3px 0 0;
  color: var(--ui-text-secondary-fg, var(--ui-text-primary-fg));
  font-size: 11.5px;
  line-height: 1.6;
}

.rs-verdict-why.is-warn {
  color: var(--ui-status-warning-fg, var(--color-warning));
}

.rs-verdict-meta {
  display: flex;
  gap: 10px;
  margin-top: 4px;
  color: var(--ui-text-faint-fg, var(--ui-text-muted-fg));
  font-family: var(--font-mono, monospace);
  font-size: 10px;
  font-variant-numeric: tabular-nums;
}

/* ── 时间轴 ── */
.rs-filters {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  padding: 3px 12px 5px;
}

.rs-filter {
  padding: 1px 6px;
  border: 1px solid transparent;
  background: none;
  color: var(--ui-text-muted-fg);
  cursor: pointer;
  font: inherit;
  font-size: 10.5px;
}

.rs-filter.is-on {
  border-color: var(--ui-border-subtle-border);
  color: var(--ui-text-primary-fg);
}

.rs-log {
  display: flex;
  gap: 8px;
  align-items: baseline;
  padding: 2px 12px;
  font-size: 11.5px;
}

.rs-log-at {
  flex: 0 0 30px;
  color: var(--ui-text-faint-fg, var(--ui-text-muted-fg));
  font-family: var(--font-mono, monospace);
  font-size: 10px;
  font-variant-numeric: tabular-nums;
  text-align: right;
}

.rs-log-text {
  flex: 1 1 auto;
  min-width: 0;
  color: var(--ui-text-secondary-fg, var(--ui-text-primary-fg));
}

.rs-log-from {
  flex: 0 0 auto;
  color: var(--ui-text-faint-fg, var(--ui-text-muted-fg));
  font-family: var(--font-mono, monospace);
  font-size: 10px;
}

/* 四档而不是十四色:出事了 / 花钱了 / 动了牌 / 只是流水。 */
.rs-log.is-fault .rs-log-text {
  color: var(--ui-status-danger-fg, var(--color-danger));
}

.rs-log.is-judge .rs-log-text {
  color: var(--ui-text-primary-fg);
}

.rs-log.is-plain .rs-log-text {
  color: var(--ui-text-muted-fg);
}
</style>
