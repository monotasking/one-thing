<template>
  <!-- 方案三:面板头(类别名 + 计数)由 `Sidebar.vue` 的 `.sidebar-pane-head`
       画,这一区只剩「组头 + 行」。分区头/折叠钮随分区折叠一起退役了。 -->
  <div class="sidebar-active-work">
    <!-- rail 上四类恒在(见 sidebar-sections.ts 的说明),所以没有活时这一面
         必须自己说话,否则点进来是一片空白。 -->
    <p
      v-if="groups.length === 0"
      class="active-work-empty"
    >
      没有在跑的活
    </p>

    <template
      v-for="group in groups"
      :key="group.tone"
    >
      <!-- 样板 `.sb3 .grp`:类内分组。空组不画(`groupActiveWorkCards` 已滤)。 -->
      <div class="active-work-group grp">
        {{ group.label }}
      </div>
      <ActiveWorkCard
        v-for="card in group.cards"
        :key="card.taskId"
        :card="card"
        :meta="rowMeta(card)"
        :busy="isRoomBusy(card.roomSessionId)"
        :unread="isRoomUnread(card.roomSessionId)"
        :active="card.roomSessionId === openedSessionId"
        @open="$emit('open', $event)"
      />
    </template>
  </div>
</template>

<script setup lang="ts">
/**
 * 左栏「进行中」面板(方案三,样板 sidebar-4.html 第三格)。
 *
 * 这一层只做编排:清单与在场信号由 `Sidebar.vue` 取好发下来(rail 上这一类的
 * 徽标与计数在别的类别被选中时也得算,所以取数必须待在更上面),判定全部在
 * `active-work.ts`(纯函数),行的三种状态由 `ActiveWorkCard` 一份模板画完。
 */
import { computed, onUnmounted, ref } from 'vue'
import { useSessionsStore } from '@/stores/sessions'
import ActiveWorkCard from './ActiveWorkCard.vue'
import {
  groupActiveWorkCards,
  resolveActiveWorkRowMeta,
  type ActiveWorkCardModel,
} from './active-work'

const props = defineProps<{
  cards: ActiveWorkCardModel[]
  /** 这间房此刻有一轮在跑。函数由 `useActiveWork` 给,这里不重算。 */
  isRoomBusy: (roomSessionId: string) => boolean
  /** 这间房有未读。判定仍然只有 sessions store 那一处。 */
  isRoomUnread: (roomSessionId: string) => boolean
}>()

defineEmits<{ open: [card: ActiveWorkCardModel] }>()

const sessionsStore = useSessionsStore()

const groups = computed(() => groupActiveWorkCards(props.cards))

/**
 * 「执行中」那一行的副文是"跑了多久",它得自己走。**一处计时** —— 一分钟一跳,
 * 整区一个定时器,不是每行各起一个(左栏一屏可以有十几行)。
 */
const NOW_TICK_MS = 60_000
const now = ref(Date.now())
const timer = setInterval(() => { now.value = Date.now() }, NOW_TICK_MS)
onUnmounted(() => clearInterval(timer))

function rowMeta(card: ActiveWorkCardModel): string {
  return resolveActiveWorkRowMeta(card, now.value)
}

/* 只读。变量名刻意不叫 `currentSessionId` —— 那个名字的赋值是
   stores/sessions.ts 的专属(workspace-ownership.test.ts 那道围栏)。 */
const openedSessionId = computed(() => sessionsStore.currentSessionId)
</script>

<style scoped>
.sidebar-active-work {
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  /* 行间 2px 呼吸缝(ui-system.md §1):卡是满宽圆角底色块,hover 与 active 紧邻
     时圆角互相填平会焊成一整条通板。容器已是 flex column,缝用 `gap` 画 —— 只落
     在卡与卡之间,首尾不多出一份,外缘几何逐像素不变。 */
  gap: 2px;
}

/* 样板 `.sb3 .grp`:小、静、不用宽字距(Linear 不这么做)。 */
.active-work-empty {
  margin: 0;
  padding: 12px 14px 3px;
  font-size: var(--sidebar-type-caption);
  font-weight: 500;
  color: var(--ui-sidebar-item-muted-fg, var(--ui-text-muted-fg));
}

.active-work-group {
  flex: 0 0 auto;
  padding: 12px 14px 3px;
  font-size: var(--sidebar-type-caption);
  font-weight: 500;
  line-height: 1.45;
  color: var(--ui-sidebar-rail-muted-fg);
  user-select: none;
}
</style>
