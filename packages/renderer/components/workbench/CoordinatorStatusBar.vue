<template>
  <section
    class="cd"
    :class="{ 'is-open': open, 'is-frozen': state?.frozen }"
  >
    <!-- 常驻条:**永远在**。空闲也是状态 —— 「现在没人在动」正是用户来这一格
         要确认的事。撞闸与暂停把动作直接放在条上,不必展开。 -->
    <div
      class="cd-bar"
      role="button"
      tabindex="0"
      :aria-expanded="open"
      @click="toggle"
      @keydown.enter.prevent="toggle"
      @keydown.space.prevent="toggle"
    >
      <i
        class="cd-lamp"
        :class="`is-${bar.lamp}`"
        aria-hidden="true"
      />
      <span class="cd-who">{{ bar.text }}</span>
      <!-- 死信红点:一封信炸了,循环继续跑而系统静默变哑 —— 这颗点是「它没回应」
           与「它试过但炸了」之间的第一条分界线。点它跳后台的调度时间轴。 -->
      <Tooltip
        v-if="bar.deadLetters > 0"
        :text="`${bar.deadLetters} 封事件处理失败 —— 去看时间轴`"
      >
        <button
          type="button"
          class="cd-dead"
          :aria-label="`${bar.deadLetters} 封事件处理失败`"
          @click.stop="openDeadLetters"
        >
          <i
            class="cd-dead-dot"
            aria-hidden="true"
          />
          {{ bar.deadLetters }}
        </button>
      </Tooltip>
      <span class="cd-tail">
        <button
          v-if="bar.action === 'resume'"
          type="button"
          class="cd-resume"
          @click.stop="resume"
        >恢复</button>
        <template v-else>{{ bar.tail }}</template>
      </span>
      <i
        class="cd-chev"
        aria-hidden="true"
      />
    </div>

    <div
      v-if="open"
      class="cd-body"
    >
      <template v-if="nowRows.length">
        <div class="cd-sec">
          现在
        </div>
        <div
          v-for="row in nowRows"
          :key="row.key"
          class="cd-now"
          :class="{
            'is-run': row.hold === 'generating',
            'is-hold': row.hold !== null && row.hold !== 'generating',
            'is-flat': !row.agentSessionId && !row.activationId,
          }"
          @click="row.agentSessionId && emit('openThread', row.agentSessionId)"
        >
          <i class="cd-glyph">{{ row.glyph }}</i>
          <span class="cd-name">{{ row.name }}</span>
          <span class="cd-reason">{{ row.reason }}</span>
          <span
            v-if="row.running"
            class="cd-elapsed"
          >{{ formatCoordinatorElapsed(row.startedAt, now) }}</span>
          <!--
            「停」在 E5 之前 emit 的是房级 `stopTurn`(换代 = 把在外的牌一起作废),
            而它画在**某一行人**旁边 —— 语义与位置对不上:点小李那一行,阿般和
            Iris 一起被打断。现在这一行有牌号(v3 快照里 `agentSessionId` 就是
            leaseId)就走人级,只收这一张;没有牌号的行(v2 旧快照)才回落房级。
          -->
          <button
            v-if="row.running"
            type="button"
            class="cd-act"
            @click.stop="row.agentSessionId ? emit('stopLease', row.agentSessionId) : emit('stopTurn')"
          >
            停
          </button>
        </div>
      </template>

      <!-- 排队:六道闸细分成徽标。要人动手的四道(链闸/相位/冻结/预算)加重,
           自解的两道(裁决中/等座位)保持轻 —— 眼睛该先落在需要出手的那一格。 -->
      <template v-if="queueBadges.length">
        <div class="cd-sec">
          排队
        </div>
        <div class="cd-badges">
          <Tooltip
            v-for="badge in queueBadges"
            :key="badge.key"
            :text="badge.hint"
          >
            <span
              class="cd-badge"
              :class="{ 'is-actionable': badge.actionable }"
            >{{ badge.label }} {{ badge.count }}</span>
          </Tooltip>
        </div>
      </template>

      <!-- 裁决窗三态。防抖 = 虚点 + 倒计;在飞 = 转圈 + 候选;降级 = 黄牌。 -->
      <template v-if="judgment">
        <div class="cd-sec">
          裁决
        </div>
        <!-- 降级成因挂在整行上,但行是 flex 容器(子项吃 flex:1),不能被
             tooltip-wrapper 包住 —— 用 trigger-el 只借浮层、不进 DOM 结构。 -->
        <Tooltip
          v-if="judgment.state === 'degraded'"
          :trigger-el="judgeRowRef"
          :text="`降级成因:${judgment.reason}`"
        />
        <div
          ref="judgeRowRef"
          class="cd-judge"
          :class="`is-${judgment.state}`"
        >
          <i
            class="cd-judge-mark"
            aria-hidden="true"
          />
          <span class="cd-judge-text">{{ judgment.text }}</span>
          <span
            v-if="judgment.state === 'debouncing'"
            class="cd-judge-at"
          >{{ judgment.countdown }}</span>
          <span
            v-else-if="judgment.state === 'inflight'"
            class="cd-judge-at"
          >{{ formatCoordinatorElapsed(judgment.since, now) }}</span>
          <span
            v-else
            class="cd-judge-at"
          >{{ formatCoordinatorAgo(judgment.at, now) }}</span>
        </div>
        <div
          v-if="judgment.state === 'inflight' && judgment.candidates.length"
          class="cd-judge-who"
        >
          {{ judgment.candidates.join(' · ') }}
        </div>
      </template>

      <template v-if="plan">
        <div class="cd-sec">
          编排
        </div>
        <!-- 一批一行。单人批连起来看着仍然像一条环,而多人批(`阿般 · 小李`)是
             环画不出来的 —— 那正是编排比"模式"多出来的表达力。 -->
        <div class="cd-plan">
          <template
            v-for="(wave, index) in plan.waves"
            :key="index"
          >
            <span
              v-if="index > 0"
              class="cd-plan-sep"
              aria-hidden="true"
            >›</span>
            <b
              v-if="wave.current"
              class="cd-plan-on"
            >{{ wave.names.join(' · ') }}</b>
            <span v-else>{{ wave.names.join(' · ') }}</span>
          </template>
        </div>
        <div
          v-if="plan.why"
          class="cd-plan-why"
        >
          {{ plan.why }}
        </div>
        <div class="cd-plan-meta">
          <span>{{ plan.progress }}</span>
          <span>{{ plan.limit }}</span>
        </div>
      </template>

      <div class="cd-sec">
        闸
      </div>
      <div
        v-for="gate in gateRows"
        :key="gate.key"
        class="cd-gate"
        :class="{ 'is-warn': gate.warn }"
      >
        <span class="cd-gate-name">{{ gate.label }}</span>
        <span class="cd-gate-bar"><i :style="{ width: `${gate.percent}%` }" /></span>
        <span class="cd-gate-value">{{ gate.value }}</span>
      </div>

      <template v-if="logRows.length">
        <div class="cd-sec">
          刚才
        </div>
        <div
          v-for="entry in logRows"
          :key="entry.key"
          class="cd-log"
          :class="{ 'is-muted': entry.muted }"
        >
          <span class="cd-log-at">{{ formatCoordinatorAgo(entry.at, now) }}</span>
          <span class="cd-log-text">{{ entry.text }}</span>
        </div>
      </template>
    </div>
  </section>
</template>

<script setup lang="ts">
/**
 * 协调器状态条 —— docs/design/collab-coordinator-inspector.md。
 *
 * 挂在「线程」格列表层的顶部。放这儿不是随手选的位置:线程回答的是"这间房正在
 * 发生什么",而协调器是那件事的**发动机**。同处一面,「谁在说」到「他的执行会话」
 * 就是一次点击,而不是在两个视图之间来回对照。
 *
 * 这个组件只画像素:所有措辞、阈值、单位、排序都在 `coordinator-status.ts`
 * (纯逻辑,可判定)。数据一份都不新增 —— 快照由协调器现算,store 只做镜像。
 */
import { computed, onUnmounted, ref, watch } from 'vue'
import { useAgentsStore } from '@/stores/agents'
import { useCollabBoardStore } from '@/stores/collabBoard'
import { useSessionsStore } from '@/stores/sessions'
import Tooltip from '@/components/common/Tooltip.vue'
import {
  buildCoordinatorBar,
  buildCoordinatorGateRows,
  buildCoordinatorJudgment,
  buildCoordinatorLogRows,
  buildCoordinatorNowRows,
  buildCoordinatorPlan,
  buildCoordinatorQueueBadges,
  formatCoordinatorAgo,
  formatCoordinatorElapsed,
} from './coordinator-status'
import { OPEN_ROOM_SCHEDULE_EVENT, type OpenRoomScheduleDetail } from './room-schedule'
import { getLogger } from '@/services/log'

const log = getLogger('renderer.coordinator')

const props = defineProps<{ roomSessionId: string }>()

const emit = defineEmits<{
  /** 点「现在」里正在说的那一行 → 下钻到它的执行会话(与线程列表同一个靶子)。 */
  openThread: [sessionId: string]
  /**
   * 房级喊停 —— 复用房头那个停止入口,不另开一条中止路径。
   *
   * E5 之后它只是**回落**:「现在」那几行只要有牌号就走下面那条人级的。
   */
  stopTurn: []
  /**
   * 人级停止(E5):点名收回这一张牌。
   *
   * 与 `stopTurn` 分成两个事件而不是一个带可选参数的:两者的**影响面**差一个
   * 数量级(一个人 vs 整间房),而一个"参数缺席就升级成全场清空"的事件,是那种
   * 出事之后没人说得清为什么的接口。
   */
  stopLease: [leaseId: string]
}>()

const agentsStore = useAgentsStore()
const collabBoardStore = useCollabBoardStore()
const sessionsStore = useSessionsStore()

/** 裁决行本体:降级成因的 tooltip 借它当触发区(见模板里的注释)。 */
const judgeRowRef = ref<HTMLElement | null>(null)

/**
 * 展开状态**存在组件里而不是 localStorage**:它是一次会话内的注意力,不是偏好。
 * 换房时保持不变 —— 关心调度的人换个房还是关心。
 */
const open = ref(false)

function toggle(): void {
  open.value = !open.value
}

watch(() => props.roomSessionId, id => {
  if (id) void collabBoardStore.loadCoordinator(id)
}, { immediate: true })

const state = computed(() => collabBoardStore.coordinatorFor(props.roomSessionId))

/**
 * 秒针。**只在展开且有东西在跑的时候走** —— 「跑了多久」是这一面唯一需要秒级
 * 刷新的东西,而一个恒定 1s 的定时器会让一间安静的房也每秒重算一遍整棵树。
 */
const now = ref(Date.now())
let timer: ReturnType<typeof setInterval> | undefined

function stopTicking(): void {
  if (timer) clearInterval(timer)
  timer = undefined
}

// 裁决窗的防抖倒计与在飞计时也要秒针 —— 一个不走的倒计时读起来像卡死了。
watch(
  () => open.value && (
    (state.value?.turns.length ?? 0) > 0
    || state.value?.judgment.state === 'debouncing'
    || state.value?.judgment.state === 'inflight'
  ),
  ticking => {
    stopTicking()
    if (!ticking) return
    now.value = Date.now()
    timer = setInterval(() => { now.value = Date.now() }, 1_000)
  },
  { immediate: true },
)

// 快照到达时刷一次基准(2026-08-02 三审):秒针只在「展开 + 有回合在跑」时走
// (省电,刻意),但一间安静的房也会来新 log 行 —— 不刷的话 `now` 停在上次
// 走秒的时刻,新行恒显「0s」、旧行不再变老,直到下一个回合起跑才纠正。
watch(state, () => { now.value = Date.now() })

onUnmounted(stopTicking)

const resolveName = (agentId: string): string => agentsStore.displayAgent(agentId).name

/**
 * 「持牌等大脑」与「在别处思考」的分界读 agents 账(D8 §4.6)——
 * 房间账里根本没有别的房,这个问题在那本账里问不出来。
 *
 * 补水按**这间房此刻持牌的人**要,而不是全体成员:一个安静的成员没有任何一格要画。
 */
const collabAgents = collabBoardStore
watch(() => (state.value?.turns ?? []).map(turn => turn.agentId).join(','), () => {
  const agentIds = (state.value?.turns ?? []).map(turn => turn.agentId).filter(Boolean)
  if (agentIds.length > 0) collabAgents.ensureAgentActivity(agentIds)
}, { immediate: true })

const resolveMind = (agentId: string) => collabBoardStore.agentActivityFor(agentId)?.mind ?? null

const bar = computed(() => buildCoordinatorBar(state.value, resolveName))
const nowRows = computed(() => buildCoordinatorNowRows(state.value, resolveName, resolveMind))
const queueBadges = computed(() => buildCoordinatorQueueBadges(state.value, resolveName))
const judgment = computed(() => buildCoordinatorJudgment(state.value, resolveName, now.value))
const gateRows = computed(() => buildCoordinatorGateRows(state.value))
const plan = computed(() => buildCoordinatorPlan(state.value, resolveName))
const logRows = computed(() => buildCoordinatorLogRows(state.value, resolveName))

async function resume(): Promise<void> {
  if (!props.roomSessionId) return
  try {
    await sessionsStore.setCollabRoomFrozen(props.roomSessionId, false)
  } catch (error) {
    log.error('coordinator resume failed', {}, error)
  }
}

/**
 * 死信红点 → 后台的「调度」页,时间轴过滤到 dead-letter。
 *
 * 走 window 事件而不是往上 emit:状态条挂在线程格里,而调度页是**另一格** ——
 * 一路把 ref 透传上去只为了换一格,与「打开成员」那条链路是同一种耦合
 * (契约见 `room-schedule.ts`,与 `OPEN_MEMBERS_EVENT` 同一条解耦线路)。
 */
function openDeadLetters(): void {
  if (!props.roomSessionId) return
  window.dispatchEvent(new CustomEvent<OpenRoomScheduleDetail>(OPEN_ROOM_SCHEDULE_EVENT, {
    detail: { roomSessionId: props.roomSessionId, filter: 'dead-letter' },
  }))
}
</script>

<style scoped>
.cd {
  flex: 0 0 auto;
  border-bottom: 1px solid var(--ui-border-subtle-border);
}

/* ── 常驻条 ── */
.cd-bar {
  display: flex;
  gap: 7px;
  align-items: center;
  height: 32px;
  padding: 0 12px;
  cursor: pointer;
  user-select: none;
}

.cd-bar:hover {
  background: var(--ui-state-hover-bg);
}

.cd-lamp {
  flex: 0 0 auto;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--ui-text-muted-fg);
}

/* 在跑的灯外面那一圈:用 status **bg** token,不是从 fg 兑出来的 color-mix ——
   一个语义色族的表面色是设计系统给的,自己兑一个只是碰巧在当前主题下好看。 */
.cd-lamp.is-run {
  background: var(--ui-status-success-fg, var(--color-success));
  box-shadow: 0 0 0 3px var(--ui-status-success-bg, transparent);
}

.cd-lamp.is-wait {
  background: var(--ui-status-warning-fg, var(--color-warning));
}

/* 空闲是一个**空心**点:有状态,但没在动。实心灰会读成"灭了"。 */
.cd-lamp.is-off {
  background: transparent;
  box-shadow: inset 0 0 0 1px var(--ui-text-muted-fg);
}

.cd-who {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  color: var(--ui-text-primary-fg);
  font-size: 12px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.cd.is-frozen .cd-who {
  color: var(--ui-text-muted-fg);
}

.cd-tail {
  flex: 0 0 auto;
  color: var(--ui-text-muted-fg);
  font-family: var(--font-mono, monospace);
  font-size: 10.5px;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

.cd-resume {
  padding: 0;
  border: 0;
  background: none;
  color: var(--ui-status-warning-fg, var(--color-warning));
  cursor: pointer;
  font: inherit;
  font-size: 10.5px;
}

/* 死信:条尾一颗红点 + 计数。用 danger 语义色族的 fg,不自己兑 color-mix。 */
.cd-dead {
  display: flex;
  flex: 0 0 auto;
  gap: 4px;
  align-items: center;
  padding: 0;
  border: 0;
  background: none;
  color: var(--ui-status-danger-fg, var(--color-danger));
  cursor: pointer;
  font: inherit;
  font-family: var(--font-mono, monospace);
  font-size: 10.5px;
  font-variant-numeric: tabular-nums;
}

.cd-dead-dot {
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: var(--ui-status-danger-fg, var(--color-danger));
}

.cd-chev {
  flex: 0 0 auto;
  width: 8px;
  height: 8px;
  border-right: 1.4px solid var(--ui-text-muted-fg);
  border-bottom: 1.4px solid var(--ui-text-muted-fg);
  transform: rotate(45deg) translate(-2px, -2px);
  transition: transform var(--duration-fast) var(--ease-default);
}

.cd.is-open .cd-chev {
  transform: rotate(-135deg) translate(-1px, -1px);
}

/* ── 展开体 ── */
.cd-body {
  padding: 2px 0 8px;
}

.cd-sec {
  padding: 9px 12px 2px;
  color: var(--ui-text-muted-fg);
  font-size: 10.5px;
  letter-spacing: 0.02em;
}

/* 「现在」:左端是**状态字形**而不是头像 —— 头像在下面的线程列表里已经是主角,
   这一段要的是"谁处在什么阶段",字形比脸更快读。 */
.cd-now {
  display: flex;
  gap: 8px;
  align-items: center;
  padding: 5px 12px;
  cursor: pointer;
}

.cd-now.is-flat {
  cursor: default;
}

.cd-now:hover:not(.is-flat) {
  background: var(--ui-state-hover-bg);
}

.cd-glyph {
  flex: 0 0 12px;
  color: var(--ui-text-muted-fg);
  font-size: 10px;
  font-style: normal;
  line-height: 1;
  text-align: center;
}

.cd-now.is-run .cd-glyph {
  color: var(--ui-status-success-fg, var(--color-success));
}

/* 持牌但还没起跑:字形压暗一档。它不是"在跑",也不是"没排上" —— 那个中间态
   在这一列里就该长成一个中间的样子。 */
.cd-now.is-hold .cd-glyph {
  color: var(--ui-status-warning-fg, var(--color-warning));
}

.cd-now.is-hold .cd-name {
  color: var(--ui-text-secondary-fg, var(--ui-text-primary-fg));
}

/* ── 排队徽标 ── */
.cd-badges {
  display: flex;
  flex-wrap: wrap;
  gap: 5px;
  padding: 3px 12px 5px;
}

.cd-badge {
  padding: 1px 6px;
  border: 1px solid var(--ui-border-subtle-border);
  color: var(--ui-text-muted-fg);
  font-size: 10.5px;
  font-variant-numeric: tabular-nums;
  cursor: default;
}

/* 要人动手的四道闸加重:眼睛该先落在这一格上,自解的两道不必抢注意力。 */
.cd-badge.is-actionable {
  border-color: var(--ui-status-warning-fg, var(--color-warning));
  color: var(--ui-status-warning-fg, var(--color-warning));
}

/* ── 裁决窗三态 ── */
.cd-judge {
  display: flex;
  gap: 8px;
  align-items: center;
  padding: 4px 12px;
  font-size: 11.5px;
}

.cd-judge-mark {
  flex: 0 0 auto;
  width: 6px;
  height: 6px;
  border-radius: 50%;
}

/* 防抖:一个**虚**点 —— 窗还没开,钱还没花。 */
.cd-judge.is-debouncing .cd-judge-mark {
  background: transparent;
  box-shadow: inset 0 0 0 1px var(--ui-text-muted-fg);
}

/* 在飞:一圈转着的弧。转圈是"正在花钱"唯一诚实的记号。 */
.cd-judge.is-inflight .cd-judge-mark {
  border: 1.4px solid var(--ui-border-subtle-border);
  border-top-color: var(--ui-text-primary-fg);
  border-radius: 50%;
  width: 9px;
  height: 9px;
  animation: cd-judge-spin 0.9s linear infinite;
}

@keyframes cd-judge-spin {
  to { transform: rotate(360deg); }
}

/* 降级:黄牌。一次回落 FIFO 是失败,不是答案 —— 它必须与「没有裁决在跑」长得
   完全不一样,那正是这一格存在的全部理由。 */
.cd-judge.is-degraded {
  color: var(--ui-status-warning-fg, var(--color-warning));
}

.cd-judge.is-degraded .cd-judge-mark {
  background: var(--ui-status-warning-fg, var(--color-warning));
  border-radius: 1px;
}

.cd-judge-text {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.cd-judge-at {
  flex: 0 0 auto;
  color: var(--ui-text-muted-fg);
  font-family: var(--font-mono, monospace);
  font-size: 10.5px;
  font-variant-numeric: tabular-nums;
}

.cd-judge-who {
  padding: 0 12px 4px 26px;
  color: var(--ui-text-muted-fg);
  font-size: 11px;
}

.cd-name {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  color: var(--ui-text-primary-fg);
  font-size: 12.5px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.cd-reason {
  flex: 0 0 auto;
  color: var(--ui-text-muted-fg);
  font-size: 11px;
}

.cd-elapsed {
  flex: 0 0 auto;
  width: 34px;
  color: var(--ui-text-muted-fg);
  font-family: var(--font-mono, monospace);
  font-size: 10.5px;
  font-variant-numeric: tabular-nums;
  text-align: right;
}

/* 动作只在悬停时顶掉计时 —— 一行里两样东西各占一次位置,行宽不跳。 */
.cd-act {
  display: none;
  flex: 0 0 34px;
  padding: 0;
  border: 0;
  background: none;
  color: var(--ui-status-warning-fg, var(--color-warning));
  cursor: pointer;
  font: inherit;
  font-size: 10.5px;
  text-align: right;
}

.cd-now:hover .cd-elapsed {
  display: none;
}

.cd-now:hover .cd-act {
  display: block;
}

/* 编排:一批一行,正在跑的那批上墨加粗 + 一道底线。 */
.cd-plan {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  align-items: center;
  padding: 3px 12px 6px;
  color: var(--ui-text-muted-fg);
  font-size: 11.5px;
}

.cd-plan-sep {
  opacity: 0.45;
}

.cd-plan-on {
  position: relative;
  color: var(--ui-text-primary-fg);
  font-weight: 600;
}

.cd-plan-on::after {
  content: '';
  position: absolute;
  right: 0;
  bottom: -3px;
  left: 0;
  height: 1.5px;
  background: var(--ui-text-primary-fg);
}

.cd-plan-why {
  padding: 0 12px 3px;
  color: var(--ui-text-muted-fg);
  font-size: 11px;
}

.cd-plan-meta {
  display: flex;
  justify-content: space-between;
  padding: 0 12px 2px;
  color: var(--ui-text-muted-fg);
  font-family: var(--font-mono, monospace);
  font-size: 10.5px;
  font-variant-numeric: tabular-nums;
}

/* 闸:一条 3px 的量线,不是进度条控件。 */
.cd-gate {
  display: flex;
  gap: 8px;
  align-items: center;
  padding: 4px 12px;
}

.cd-gate-name {
  flex: 0 0 52px;
  color: var(--ui-text-muted-fg);
  font-size: 11px;
}

.cd-gate-bar {
  position: relative;
  flex: 1 1 auto;
  height: 3px;
  background: var(--ui-border-subtle-border);
}

.cd-gate-bar i {
  position: absolute;
  inset: 0 auto 0 0;
  background: var(--ui-text-secondary-fg, var(--ui-text-primary-fg));
  transition: width var(--duration-normal) var(--ease-default);
}

.cd-gate.is-warn .cd-gate-bar i,
.cd-gate.is-warn .cd-gate-value {
  color: var(--ui-status-warning-fg, var(--color-warning));
  background: var(--ui-status-warning-fg, var(--color-warning));
}

.cd-gate.is-warn .cd-gate-value {
  background: none;
}

.cd-gate-value {
  flex: 0 0 auto;
  color: var(--ui-text-muted-fg);
  font-family: var(--font-mono, monospace);
  font-size: 10.5px;
  font-variant-numeric: tabular-nums;
}

/* 「刚才」:时间一列、事件一列。 */
.cd-log {
  display: flex;
  gap: 9px;
  padding: 3px 12px;
  font-size: 11.5px;
}

.cd-log-at {
  flex: 0 0 30px;
  padding-top: 1px;
  color: var(--ui-text-muted-fg);
  font-family: var(--font-mono, monospace);
  font-size: 10.5px;
  font-variant-numeric: tabular-nums;
  text-align: right;
}

.cd-log-text {
  flex: 1 1 auto;
  min-width: 0;
  color: var(--ui-text-secondary-fg, var(--ui-text-primary-fg));
}

.cd-log.is-muted .cd-log-text {
  color: var(--ui-text-muted-fg);
}
</style>
