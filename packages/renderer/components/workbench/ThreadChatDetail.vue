<template>
  <section class="thread-chat-detail">
    <header class="thread-head">
      <div class="head-line">
        <span class="head-tag">{{ tag }}</span>
        <span class="head-title">{{ headTitle }}</span>
        <span
          v-if="isGenerating"
          class="head-live"
        >运行中</span>
      </div>
    </header>

    <!-- 详情层就是**整个既有的聊天面**。
         `ChatPanel` 一挂,右栏拿到的就是中栏那一套:`MessageList` → `MessageItem`
         (工具卡 / StepsPanel / 真 diff / 附件)+ composer + GoalStatusBar +
         BackgroundJobsStatusBar + **权限账页栏位**,一行渲染都没重写。

         权限账页栏位是本期的正题,不是负担:待批请求按**工作会话 id** 存
         (`collabBoard.hasPendingAsk(workSessionId)`),而左栏活卡片 / 看板行 /
         背台三处都只画一个「待审批」状态标 —— 系统到处说"有东西等你批",却
         没有一处能批。搬整个 `ChatPanel` 正好补上:看到标 → 点进线程 → 就在
         这儿批。(先前 W6「审批不进右栏」按此作废。)

         `footerTarget` / `outlineRailTarget` 都不传:
          - footer 不 teleport,composer 就地落在列表下面(本组件是 flex 列);
          - 大纲轨 `useSideOutlineRail` 恒 false,`AssistantMessageNavRail`
            连渲染都不进,右栏不会凭空多一根轨。

         `:permission-shortcuts="false"` 是**必须**的:`usePermissionShortcuts`
         注册的是 window 级 capture keydown。中栏与右栏同时挂着 `MessageList`
         时,若两条会话各自都有待批请求,一次 Enter 会同时命中两个处理器 ——
         批错对象。键盘归中栏,右栏靠点击(按钮照样可点)。 -->
    <ChatPanel
      class="thread-chat-panel"
      :session-id="props.sessionId"
      :permission-shortcuts="false"
      @open-file="(filePath: string) => emit('openFile', filePath)"
    />
  </section>
</template>

<script setup lang="ts">
/**
 * 右栏「线程」的**详情层**:一条执行会话,用**整个既有的聊天面**渲染。
 *
 * 这里不存在第二套聊天 UI —— 之前那版「`MessageList` + 自建轻量回复框」已经
 * 删掉:自建那只回复框既没有附件/@/模型选择,也没有权限账页栏位,而**待批请求
 * 恰恰是按工作会话 id 存的**,右栏不给栏位就等于全系统没有一处能批。
 *
 * 窄栏(右栏 250–310px)适配全部写在**本组件的作用域样式**里(`:deep(...)`,
 * 前缀 `.thread-chat-detail`)—— 直聊那一面够不着,逐像素不变。
 */
import { computed, watch } from 'vue'
import ChatPanel from '@/components/chat/ChatPanel.vue'
import { useChatSession } from '@/composables/useChatSession'
import { useChatStore } from '@/stores/chat'
import { useSessionsStore } from '@/stores/sessions'

const props = withDefaults(defineProps<{
  /** 这条线程对应的执行(工作台)会话。 */
  sessionId: string
  /**
   * 头部那枚小字标(默认 THREAD)。
   *
   * 本组件是「右栏里的一整面聊天」这件事的**唯一**实现 —— 窄栏适配、权限栏位、
   * 补拉消息全在这里。私聊就地打开(AgentSpace 的对话面)复用的正是它,只换
   * 这枚标与标题:另起一份等于把下面那两百行窄栏适配再抄一遍。
   */
  tag?: string
  /** 标题定值。不给就跟着会话名走(线程的老行为)。 */
  title?: string
}>(), {
  tag: 'THREAD',
  title: '',
})

const emit = defineEmits<{
  openFile: [filePath: string]
  /** 让 tab 标题跟着会话名走(与 review tab 同一手法)。 */
  titleResolved: [title: string]
}>()

const chatStore = useChatStore()
const sessionsStore = useSessionsStore()
const threadSessionId = computed(() => props.sessionId)
// 头部那一枚「运行中」是本组件仅剩的自有状态:发送/重发/插话/停止全部由
// `ChatPanel` 内部走既有链路,这里不再重复接一遍。
const { isGenerating } = useChatSession(threadSessionId)

const sessionName = computed(() => {
  const id = props.sessionId
  if (!id) return ''
  return sessionsStore.getSessionItem?.(id)?.name || ''
})
const headTitle = computed(() => props.title || sessionName.value || '执行会话')

/**
 * 补拉这条线程的消息。
 *
 * **只在 store 里一条都没有时才拉** —— 同一个会话可能同时开在中栏页签里,那边
 * 是分页加载的,这里再整份灌一次会把它的分页游标冲掉。已经有内容的会话靠既有的
 * 流式事件继续更新(事件按 sessionId 落进同一份 store,不需要线程自己订阅)。
 *
 * 加载中不再另画一档状态:`ChatPanel` → `MessageList` 自己就吃 `isLoading`
 * (空态那一档是 `EmptyState`,当前主题下它是一只零内容的占位 div)。另起一档
 * 就得把 `ChatPanel` 挂在 `v-if` 后面,一进一出会白白触发它的快照存/取。
 */
async function ensureLoaded(sessionId: string): Promise<void> {
  if (!sessionId) return
  if (chatStore.getSessionState(sessionId).messages.value.length > 0) return
  await chatStore.loadMessages(sessionId)
}

watch(() => props.sessionId, async id => {
  await ensureLoaded(id)
}, { immediate: true })

watch(sessionName, name => {
  if (name) emit('titleResolved', name)
}, { immediate: true })

/**
 * 摊在这一面上的会话 = **看见了**,销未读。
 *
 * 已读水位只认「主区可见的会话」(`markVisibleSessionsRead` 吃的是
 * `workspaceStore.visibleSessionIds` = 各分栏的当前页签)—— 右栏这一面不在那份
 * 清单上。收在本组件里而不是各宿主里,是因为"右栏正摊着这段对话"这件事只有它
 * 知道:线程、就地私聊、房里的「私下」三处宿主因此各自不必再补一遍。
 *
 * 执行会话本来就不进任何未读列表(它们骑着 archived 躲开所有列表),对它们这一句
 * 是无害的空转。
 */
watch(
  () => sessionsStore.isUnreadSession?.(props.sessionId) === true,
  unread => {
    if (unread && props.sessionId) sessionsStore.markSessionRead?.(props.sessionId)
  },
  { immediate: true },
)
</script>

<style scoped>
.thread-chat-detail {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  overflow: hidden;
}

.thread-head {
  flex-shrink: 0;
  padding: 9px 10px 8px;
  border-bottom: 1px solid var(--ui-border-default-border, var(--border-color));
}

.head-line {
  display: flex;
  gap: 8px;
  align-items: baseline;
  min-width: 0;
}

.head-tag {
  flex-shrink: 0;
  color: var(--ui-text-faint-fg, var(--ui-text-muted-fg));
  font-family: var(--font-mono, monospace);
  font-size: 9px;
  font-weight: 600;
  letter-spacing: 1.5px;
}

.head-title {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  color: var(--ui-text-primary-fg);
  font-size: 12.5px;
  font-weight: 600;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.head-live {
  flex: 0 0 auto;
  color: var(--ui-status-success-fg, var(--color-success));
  font-family: var(--font-mono, monospace);
  font-size: 10px;
}

.thread-chat-panel {
  flex: 1 1 auto;
  min-width: 0;
  min-height: 0;
}

/* 右栏这份聊天面同样要有 `chat-surface` 容器(L5):`.thread-chat-panel` 与
   `.chat-panel` 是**同一个元素**,查不了自己,所以容器落在 `.thread-chat-detail`
   上。这里恰恰是窄栏降级最该生效的地方 —— 右栏 250–310px,而旧的 `@media` 查的
   是窗口宽,整块聊天面在这儿从来没进过 768 那一档。 */
.thread-chat-detail {
  container-type: inline-size;
  container-name: chat-surface;
}

/* ────────────────────────────────────────────────────────────────────────
   窄栏适配(右栏 250–310px)。
   一条纪律:**只压尺寸,不裁内容** —— 放不下的一律给横滚,永远不 `hidden`。
   全部带 `.thread-chat-detail` 前缀 + `:deep()`,直聊那棵树够不着。
   ──────────────────────────────────────────────────────────────────────── */

/* 阅读列量尺。
   `ChatPanel` 的公式是 `min(--content-measure, --chat-measure-cap)`,cap 是
   `max(58%, 100% - 144px)` —— 310px 下算出来是 180px,凭空丢掉 130px。
   照 `ChatPanel.vue` 那条纪律**只改两枚输入变量**(不直接写
   `--chat-content-width`),两枚都给 100%,阅读列就等于右栏实宽。
   写在 `.chat-panel` 上而不是 `.message-list-wrapper` 上是必须的:composer /
   goal 条读的是同一枚变量,但它们是列表的**兄弟**,写在列表里够不着它们。 */
.thread-chat-detail :deep(.chat-panel) {
  --content-measure: 100%;
  --chat-measure-cap: 100%;
}

/* 行内边距:中栏那套 14–24px 的左右留白在 250px 下要吃掉五分之一的行宽。 */
.thread-chat-detail :deep(.message-list) {
  --message-padding: 8px 10px;
}

/* 长 token(URL / 路径 / 无空格串)在窄栏必须断行,否则它自己就是一根撑杆。 */
.thread-chat-detail :deep(.message-text) {
  overflow-wrap: anywhere;
}

/* ── 工具行:窄栏改**两行**(实拍依据)────────────────────────────────────
   `.operation-copy` 是行内那根 flex:左边 `.operation-primary`(动作 + 靶子),
   右边 `.operation-secondary`(`+35 -0 · 0.1s`)。250px 下右边固定吃掉 86px,
   靶子只剩 86px —— 实拍是 `write Ma...` / `edit Wr...`,文件名等于没写。
   放开换行后靶子拿满 178px:`write MarkdownPreview.tsx` 全见,计量落到第二行。
   代价是行高 28 → 41px,换来的是"这一步动了哪个文件"重新可读 —— 窄栏里这条
   比 0.1s 重要。省略号仍在(say 那种整段正文的靶子不会撑爆行)。 */
.thread-chat-detail :deep(.operation-copy) {
  flex-wrap: wrap;
  row-gap: 0;
}

.thread-chat-detail :deep(.operation-copy > .operation-primary) {
  flex: 1 1 100%;
  min-width: 100%;
}

/* ── 展开层的缩进:窄栏收窄一档 ──────────────────────────────────────────
   步骤展开后 `.collapse-panel-content`(margin 10/2)套 `.tool-step-details`
   (margin-left 22 + padding 14/14),250px 里光缩进就吃掉 62px(25%),实拍
   diff 只剩 167px 可用。收到 4 / 8+8 后 diff 拿到 193px。
   `!important` 是必需的:被压的那两条来自组件自己的 scoped 规则,特异性与
   `:deep()` 打平,只靠源序不稳。作用域仍是 `.thread-chat-detail`,直聊够不着。 */
.thread-chat-detail :deep(.collapse-panel-content.activity-inline-details) {
  margin-right: 0 !important;
  margin-left: 4px !important;
}

.thread-chat-detail :deep(.tool-step-details) {
  margin-left: 8px !important;
  padding-right: 8px !important;
  padding-left: 8px !important;
}

/* ── composer 一带(`ChatPanel` 搬过来才有的四样)────────────────────────
   底部留白:中栏 16px 是为了让 composer 浮在阅读列上方留口气,右栏 250px
   下那 16px 就是纯粹的空白面积,收到 8px。 */
.thread-chat-detail :deep(.composer-container) {
  padding-bottom: 8px;
}

/* ── composer 工具条:窄栏改**两行**(实拍依据)──────────────────────────
   `.composer-toolbar` 是 `nowrap` 的一根 flex:左边 `.toolbar-left`(模型 /
   ctx 量尺 / think / guard 档),右边 `.toolbar-right`(附件 / 语音 / SEND)。
   310px 下两边加起来要 334px,而 `.toolbar-left` 是 `overflow: hidden` ——
   实拍 `guard:off` 那一枚被**整整裁掉 25.6px**,只剩 "guard:o"。这是"内容被
   裁没",不是"排得挤"。
   (InputBox 自己备了一道窄栏阶梯 —— `@container` 到 360px 就把 guard 那枚
   收走。**它没生效**:实测同一条规则文本手工注进页面就能生效,说明查询为真、
   是级联里有一条同特异性的 `display` 在它之后翻回来。那是 InputBox/Select 自己
   的旧账,不在本期改动面内,所以这里按本文件一贯的办法自己兜住。)

   放开换行后 `.toolbar-left` 独占一整行(310 → 内容只要 201),两档全见;
   `.toolbar-right` 落到第二行并靠右。`flex-basis: auto` 是**必需**的:
   `.toolbar-left` 原本是 `flex: 1 1 0%`,基准 0 → 两条永远"放得下",
   `flex-wrap` 单独写等于没写。
   再补一条 `overflow-x: auto` 兜底:哪怕将来模型名更长、一整行也放不下,
   也是给横滚而不是接着裁(本文件的一贯纪律)。 */
.thread-chat-detail :deep(.composer-toolbar) {
  flex-wrap: wrap;
  row-gap: 2px;
}

.thread-chat-detail :deep(.composer-toolbar > .toolbar-left) {
  flex-basis: auto;
  overflow-x: auto;
}

.thread-chat-detail :deep(.composer-toolbar > .toolbar-right) {
  margin-left: auto;
}

/* Goal 条:中栏 `margin: 8px auto` 走的是测出来的阅读列;右栏阅读列已经是满宽,
   把上外边距收一档,免得它和列表之间开出一道空行。 */
.thread-chat-detail :deep(.composer-container > .goal-bar) {
  margin-top: 6px;
}

/* ── 权限账页栏位(本期的正题)────────────────────────────────────────────
   栏位本体是一张账页表:`tool / target / scope` 三行(key | value 网格)+
   一条 `permission-foot`(左边一句提示,右边三颗键)。

   1)value 那一列在中栏是 `nowrap + ellipsis`。250px 下 value 只剩 172px,
      实拍 `~/data/code/pi-mono/AGENTS.md`(223px)被截成 `…/pi-mono/AGE…`
      —— **批一个操作的时候被截掉的恰恰是"批的是哪个文件"**。这里让它换行。
      `.is-dim` 那一行(命令 / diff 预览)不放开:它可能是几百字符,在 250px
      里放开就是把整条列表挤没,那一行留着一行省略号是对的。
   2)`permission-foot` 是 `nowrap`:三颗键要 218px,提示 `flex: 1 1 0` 被压到
      30px,实拍只剩 "awa"。放开换行 + 提示独占一行,三颗键整排落到第二行
      (218 ≤ 248,一颗都不掉)。 */
.thread-chat-detail :deep(.permission-value:not(.is-dim)) {
  overflow: visible;
  white-space: normal;
  overflow-wrap: anywhere;
}

.thread-chat-detail :deep(.permission-foot) {
  flex-wrap: wrap;
  row-gap: 4px;
}

.thread-chat-detail :deep(.permission-foot > .permission-hint) {
  flex: 1 1 100%;
}
</style>
