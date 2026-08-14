<template>
  <!-- 样板 `.sb .r` + `.sb3 .r`:状态点 + 名字 + 右端一句副文。方案二那张两行卡
       (标题/头像/状态签/进度条)在方案三里整个退役 —— 单类面板要的是一行能铺
       很长的清单,不是一叠卡片。 -->
  <button
    type="button"
    class="work-card"
    :class="[`tone-${card.tag.tone}`, { 'is-active': active, 'is-live': live }]"
    @click="$emit('open', card)"
  >
    <!-- `.st`:样板里**唯一**的颜色。绿 = 在跑,琥珀 = 待你,其余一律灰。 -->
    <span
      class="work-card-dot st"
      :class="{ run: card.tag.tone === 'running', wait: card.tag.tone === 'awaiting' }"
      aria-hidden="true"
    />
    <span class="work-card-title nm">{{ card.title }}</span>
    <span
      v-if="meta"
      class="work-card-meta meta"
    >{{ meta }}</span>
    <!-- 未读墨点:判定仍然只有 sessions store 那一处(经场账转发)。样板共用底子
         里的 `.sb .unread` 就是它 —— 群聊/联系人行同一枚。 -->
    <span
      v-if="unread"
      class="sidebar-unread-dot"
      aria-label="有新消息"
    />
  </button>
</template>

<script setup lang="ts">
/**
 * 左栏「进行中」面板里的一行活(方案三,样板 sidebar-4.html 第三格的 `.r`)。
 *
 * 一个组件画三种状态:点的颜色由根节点上的 `tone-*` 类切换,模板只有一份。
 * 行上的每一格都来自 `ActiveWorkCardModel` 与 `resolveActiveWorkRowMeta`
 * (纯函数算好的),这里不从 task 上现算任何东西。
 */
import { computed } from 'vue'
import { useCollabTypingAgents } from '@/composables/useCollabTyping'
import type { ActiveWorkCardModel } from './active-work'

const props = defineProps<{
  card: ActiveWorkCardModel
  /** 行右端那一句(`resolveActiveWorkRowMeta` 的产物,一处计时算好后发下来)。 */
  meta?: string
  /** 这张卡所属的房此刻有一轮在跑(场账的「在忙」)。 */
  busy?: boolean
  /** 这张卡所属的房有未读(场账转发 store 的唯一判定)。 */
  unread?: boolean
  /** 这间房正开着 —— 行跟着点亮,免得用户找不到自己刚点的那行。 */
  active?: boolean
}>()

defineEmits<{ open: [card: ActiveWorkCardModel] }>()

/**
 * 打字信号取自 `useCollabTypingAgents`(C0 取件),一行一记脉搏;安静的房间
 * 一个定时器都不跑。没挂 pinia(单测)就退成"没人在打字",行照画。
 */
const typingAgents = (() => {
  try {
    return useCollabTypingAgents(computed(() => props.card.roomSessionId))
  } catch {
    return computed<string[]>(() => [])
  }
})()

/**
 * 「正在执行」= 负责人此刻在这间房打字,或者(房里确实有一轮在跑且)这张卡
 * 正是负责人当前那张。后半句是 `findAgentDoingTask` 的结论 —— 一个人名下压着
 * 三张 doing 卡时,只有最新那张该亮。方案三里它不再是第二枚点,而是让 `.st`
 * 那一枚**跳起来**:样板一行只有一个圆点,多画一枚就是多一种要学的记号。
 */
const live = computed(() =>
  (!!props.card.assigneeAgentId && typingAgents.value.includes(props.card.assigneeAgentId))
  || (props.busy === true && props.card.isAssigneeCurrent))
</script>

<style scoped>
/* 样板 `.sb .r`:30px 行高、6px 圆角、左右 8px 外边距,hover 才有 4.5% 的极淡
   填充,当前项 7.5% 且转墨色。一条线都不画 —— 这正是样板"少放颜色和线"的那一层。
   墨阶由主题层派生成 `--ui-sidebar-rail-*`(整棵 sidebar 共用的那条派生链),
   于是任何主题下 当前项 > 行文 > 副文 的对比关系都成立。 */
.work-card {
  display: flex;
  /* 选中底只定义一次,下面加深的那一档贴着它写,免得两处数值各自漂移。 */
  --work-card-active-fill: var(--ui-sidebar-rail-active-bg);

  align-items: center;
  gap: 8px;
  flex: 0 0 auto;
  height: 30px;
  margin: 0 8px;
  padding: 0 8px;
  border: none;
  border-radius: 6px;
  background: transparent;
  font-family: inherit;
  /* 活卡片是「进行中」这条列表的主标题,与会话名 / 房间行同档。 */
  font-size: var(--sidebar-type-title);
  line-height: 1.45;
  text-align: left;
  white-space: nowrap;
  color: var(--sidebar-row-fg, var(--ui-text-primary-fg));
  cursor: pointer;
}

.work-card:hover,
.work-card:focus-visible {
  background: var(--ui-sidebar-rail-hover-bg);
  color: var(--sidebar-row-ink, var(--ui-text-primary-fg));
}

.work-card:focus-visible {
  outline: none;
}

.work-card.is-active {
  background: var(--work-card-active-fill);
  color: var(--sidebar-row-ink, var(--ui-text-primary-fg));
  font-weight: 500;
}

/* 手指着一张已经选中的卡。`.is-active` (0,2,0) 与 `:hover` (0,2,0) 原本平局、
   靠书写顺序赢,选中那张成了死区 —— 选中不等于这一行不再响应指针
   (ui-system.md §1)。面 register 只剩"加深一档",掺 `--ui-text-primary-fg`
   让这一档在深浅两种主题下都成立,不写死 alpha/hex。(0,3,0) 压过,不留平局。 */
.work-card.is-active:hover,
.work-card.is-active:focus-visible {
  background: color-mix(in srgb, var(--work-card-active-fill) 92%, var(--ui-text-primary-fg));
}

/* 样板 `.sb .st`:6px 一枚,默认灰,只有"在跑"与"待你"两种颜色。 */
.work-card-dot {
  flex: 0 0 6px;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--ui-sidebar-rail-muted-fg);
}

.work-card-dot.run {
  background: var(--ui-status-success-fg, var(--color-success));
}

.work-card-dot.wait {
  background: var(--ui-status-warning-fg, var(--color-warning));
}

/* 「此刻在动」让那一枚点跳,不另加记号。 */
.work-card.is-live .work-card-dot {
  animation: work-card-pulse 1.6s ease-in-out infinite;
}

/* 样板 `.sb .r .nm`:名字吃掉所有余量,省略号永远画在名字上。 */
.work-card-title {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* 样板 `.sb .r .meta`:meta 档、副文墨阶、等宽数字(时间跳动时不抖)。 */
.work-card-meta {
  flex: 0 0 auto;
  font-size: var(--sidebar-type-meta);
  color: var(--ui-sidebar-rail-muted-fg);
  font-variant-numeric: tabular-nums;
}

/* 未读点:与侧栏别处同一枚(5px 墨点),类名也照搬,免得长出第二种未读。 */
.work-card .sidebar-unread-dot {
  flex: 0 0 5px;
  width: 5px;
  height: 5px;
  margin-left: 0;
  border-radius: 50%;
  background: var(--sidebar-row-ink, var(--ui-text-primary-fg));
  opacity: 0.6;
}

@keyframes work-card-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.35; }
}

@media (prefers-reduced-motion: reduce) {
  .work-card.is-live .work-card-dot { animation: none; }
}
</style>
