<template>
  <Splitter
    ref="shellRef"
    class="app-shell"
    :class="{ 'is-sidebar-resizing': sidebarResizing }"
    :gap="0"
    :resizer-size="1"
    :resizer-hit-size="12"
    @resize-start="emit('sidebar-resize-start')"
    @resize-end="emit('sidebar-resize-end')"
  >
    <!-- 左栏。**常驻 DOM**(L4):浮层态只是收成 0 宽,槽里那个唯一的 `<Sidebar>`
         实例始终活着,于是浮层⇄停靠不丢滚动位置与展开的分组。
         折叠 = 整条侧栏收没(classic 与 workbench 同一套语义)。方案三曾在
         workbench 下把折叠画成一条 46px 的 rail,2026-07-31 撤掉:macOS 的三颗
         交通灯横跨到窗口左起 ~70px,比 rail 还宽,于是黄绿两颗压在聊天区上、
         横跨那条竖分隔线;顶栏又按"顶到窗口左缘"死留 84px,没扣掉左边这 46px,
         标题被平白推远一截。左上角因此永远对不齐。 -->
    <SplitterPanel
      as="aside"
      class="app-left-sidebar-region"
      size-unit="px"
      :size="sidebarWidth"
      :min="sidebarMinWidth"
      :max="sidebarMaxWidth"
      :collapsed="!sidebarDocked"
      :resizable="sidebarDocked"
      @update:size="size => emit('update:sidebarWidth', size)"
    >
      <slot name="sidebar" />
    </SplitterPanel>

    <SplitterPanel
      flex
      class="app-shell-main-region"
      :resizable="sidebarDocked"
    >
      <div
        ref="contentRef"
        class="app-content"
        :style="contentStyle"
      >
        <Splitter
          class="app-content-splitter"
          :gap="0"
          :resizer-size="1"
          :resizer-hit-size="12"
          @resize-start="emit('workbench-resize-start')"
          @resize-end="emit('workbench-resize-end')"
        >
          <!-- 中栏吃剩下的所有宽度(flex),右栏才是那个被拖的定宽列。
               `:min` 在 px 模式下是**拖拽下限**:拖到聊天列只剩 480px 就停手。 -->
          <SplitterPanel
            flex
            size-unit="px"
            :min="chatMinWidth"
            :resizable="workbenchVisible"
          >
            <slot name="main" />
          </SplitterPanel>

          <!-- Collapsed (not unmounted) when hidden: the panel slides shut
               symmetrically and workbench tab state survives toggles. The
               slide wrapper is width-frozen in CSS (`--workbench-width`, one
               write per commit — never per frame) so the panel edge clips it
               instead of reflowing tabs every frame; the splitter releases
               the freeze while the divider is being dragged. -->
          <SplitterPanel
            v-if="workbenchMounted"
            as="aside"
            class="app-right-sidebar-region"
            size-unit="px"
            :size="workbenchPanelWidth"
            :min="workbenchMinWidth"
            :max="workbenchMaxWidth"
            :collapsed="!workbenchRevealed"
            @update:size="size => emit('update:workbenchPanelWidth', size)"
          >
            <div class="workbench-slide">
              <slot name="workbench" />
            </div>
          </SplitterPanel>
        </Splitter>

        <!-- 窗内的全局浮层(语音)。它们 `position: fixed`,住这儿只为留在
             `.app-content` 的作用域里(wallpaper.css 的 C 级块以它为根)。 -->
        <slot name="content-overlays" />
      </div>
    </SplitterPanel>
  </Splitter>
</template>

<script setup lang="ts">
/**
 * 外壳三栏树(L5,`docs/design/shell-layout-2026-08.md` §L5)。
 *
 * 这个组件**只画格子**:两层 Splitter、三块 SplitterPanel、右栏那层滑动壳,
 * 以及区域之间的接缝线。它不知道会话、不知道插件、不知道空间 —— 每一个数
 * 都由 props 灌进来,每一次拖拽都以事件抛回去。
 *
 * 抽它出来解决的是 P8:App.vue 从前一个人扛着"窗口模式分发 + 三栏布局 +
 * 事件路由 + 空间切换 + 插件层"。布局是其中唯一**可以**被单独看懂的一块 ——
 * 它的输入只有协调器(`useShellLayout`)那几个数。
 *
 * 边界(有意为之):
 *  · **不**持有布局状态。宽度、开合、降级全归协调器与 `layoutPrefs`;
 *  · **不**量宽度。全仓唯一一处量外壳宽的 ResizeObserver 仍在协调器里,
 *    这里只把两个元素 expose 出去给宿主接;
 *  · 三块内容全走插槽,所以左栏是不是 `<Sidebar>`、中栏是不是聊天,这一层
 *    不知道也不需要知道。
 */
import { computed, ref } from 'vue'
import Splitter from '@/components/common/Splitter.vue'
import SplitterPanel from '@/components/common/SplitterPanel.vue'

const props = withDefaults(defineProps<{
  /** 侧栏当前宽度(px)。拖拽时由 `update:sidebarWidth` 回吐。 */
  sidebarWidth: number
  sidebarMinWidth: number
  /** 协调器给的拖拽上限 —— 拖到头也要给聊天列留下限。 */
  sidebarMaxWidth: number
  /** 侧栏在停靠位上。false = 收成 0 宽(用户折叠的,或预算挤成浮层的)。 */
  sidebarDocked: boolean
  /** 正在拖侧栏分隔条(拖拽期间关掉宽度过渡)。 */
  sidebarResizing?: boolean

  /** 聊天列的硬下限(px)。 */
  chatMinWidth: number

  /** 右栏挂没挂(首次打开后就一直挂着,收起只是折叠)。 */
  workbenchMounted?: boolean
  /** 右栏是不是展开态(折叠动画的驱动位)。 */
  workbenchRevealed?: boolean
  /** 右栏可不可拖(收起时中栏不再需要那条分隔条)。 */
  workbenchVisible?: boolean
  /** 右栏面板宽度的**活值**(拖拽每帧回吐)。 */
  workbenchPanelWidth: number
  workbenchMinWidth: number
  workbenchMaxWidth: number
  /**
   * 右栏内容的**冻结宽**:来自已提交的偏好,拖拽期间纹丝不动。
   *
   * 折叠/展开是一条 flex-basis 过渡,内容若跟着每帧的面板宽走,tab 条与终端
   * 会在 200ms 里重排几十次。所以内容常态定宽,让收拢的面板边缘去裁它。
   */
  workbenchSlideWidth: number
}>(), {
  sidebarResizing: false,
  workbenchMounted: false,
  workbenchRevealed: false,
  workbenchVisible: false,
})

const emit = defineEmits<{
  'update:sidebarWidth': [width: number]
  'sidebar-resize-start': []
  'sidebar-resize-end': []
  'update:workbenchPanelWidth': [width: number]
  'workbench-resize-start': []
  'workbench-resize-end': []
}>()

const shellRef = ref<InstanceType<typeof Splitter> | null>(null)
const contentRef = ref<HTMLElement | null>(null)

/**
 * 冻结宽写成 `.app-content` 上的一枚 CSS 变量,**一次写入、不每帧**:祖先的
 * 自定义属性一变,Blink 会重算整棵子树里所有引用 var() 的样式(2026-08-18
 * trace:一次 10.9ms / 3272 元素)。
 *
 * 减 1 是面板自己的 `border-left`(全局 border-box):px 模式下 flex-basis 就是
 * 精确的像素数,内容盒正好少这 1px。
 */
const contentStyle = computed(() => ({
  '--workbench-width': `${Math.max(0, props.workbenchSlideWidth - 1)}px`,
}))

defineExpose({
  /** `.app-shell` 元素 —— 宿主拿它挂那唯一一处量外壳宽的 ResizeObserver。 */
  shellElement: computed(() => (shellRef.value?.$el as HTMLElement | null) ?? null),
  /** `.app-content` 元素 —— 搜索窗要按这块内容区(不含侧栏)居中。 */
  contentElement: contentRef,
})
</script>

<style scoped>
.app-shell {
  --app-sidebar-transition-duration: var(--duration-slow);
  --app-sidebar-transition-ease: var(--ease-default);
  /* 区域之间的接缝线。窗口边框不归任何人画 —— 交给系统投影收口。 */
  --app-seam-line: color-mix(in srgb, var(--ui-border-subtle-border) 52%, transparent);

  height: 100%;
  width: 100%;
  /* 判过不接 `surface="app"` 档(自绘 UI 收敛波 6·批 1,2026-08-11)——
     四处区域根(.app-shell / .app-content 在本文件,.app-main-region /
     .workspace-view-stack 在 App.vue)是同一条判决,理由与 G7-1 判 `.sidebar` 不接同型:

     · 非壁纸态迁过来确实零变化(同一枚 token,只是改由档位画);
     · 壁纸态下四处已由 A 级·让位整张透明化(wallpaper.css `html.has-wallpaper
       .app-shell` / `.app-content, .app-main-region, .workspace-view-stack`),
       档位画的底压根到不了眼前 —— 迁移买不到壁纸参与度;
     · 而盖章的**副作用**是真的:B 级通用规则
       `html.has-wallpaper .app-surface[data-surface='app']` 会把
       `--ui-surface-app-bg` 就地稀释成 18% 的纱,并按继承落到整棵子树。
       本波实测这枚 token 在 renderer 里有 **91 处**消费、约 45 个文件,其中
       Link / BorderBox / BreadcrumbItem / Dialog 的
       `box-shadow: 0 0 0 2px var(--ui-surface-app-bg)` 是**焦点环的实色垫底**,
       Progress / RoomSurface 拿它当**反色文字**,todo-popover 拿它当浮层底 ——
       稀释成纱等于焦点环透明、反色文字透明。

     wallpaper.css 的 app 档预写注里那句"第一个住户进档前必须先量一遍它的子树"
     就是这件事;这里是量完的结论。

     ── G8-c 复审(2026-08-11):**判决转正,四根永远具名** ────────────────────
     波 6 留的口子是"等 G8 让 app 档不再是整棵树都在读的那一枚"。G8 复审时认真
     评估过那条路 —— **区域 ink 中介层**:再造一枚 `--ui-region-app-bg:
     var(--ui-surface-app-bg)`,区域根只画中介,B 级只稀释中介、不动原 token,
     91 处消费(焦点环垫底 / 反色文字)就都不受影响。判不做,两条理由:

     · **买不到东西**:这四根在壁纸下是 A 级·让位(整张透明),中介层稀释了也
       画不到眼前 —— 波 6 量的那句"迁移买不到壁纸参与度"对中介层同样成立。
     · **代价不是零风险**:四档要各配一枚中介(app/panel/chat/elevated),每个
       区域根的 CSS 都要改引中介,而"面 token 与中介 token 长得一样、该引哪个"
       这个新坑会长期在场。为一个当前住户为零的收益造两套平行 token,是把
       G7 刚终结的枚举制换成一张更难维护的对照表。

     所以:根级大区**不进档位表**,壁纸下由 A 级·让位承担(那才是它们该有的
     处理 —— 根级大区没有"自己的底色"要保,它们的活是让路)。档位表继续只服务
     "有自己的面、且要被壁纸认出来"的区域根。这条判决与 `.sidebar` 的 G8-b 判决
     (不并档、永久具名)是同一条:**能被档位表收的是面,不是根,也不是态**。 */
  background: var(--ui-surface-app-bg);
}

.app-shell :deep(.app-shell-body),
.app-shell :deep(.app-shell-main-region),
.app-shell :deep(.app-content-body),
.app-shell :deep(.app-content-main-region),
.app-shell :deep(.app-main-body),
.app-shell :deep(.app-main-content-region) {
  min-width: 0;
  min-height: 0;
}

.app-shell :deep(.app-shell-body),
.app-shell :deep(.app-shell-main-region),
.app-shell :deep(.app-content-body),
.app-shell :deep(.app-content-main-region),
.app-shell :deep(.app-main-body),
.app-shell :deep(.app-main-content-region) {
  height: 100%;
}

.app-shell :deep(.app-left-sidebar-region),
.app-shell :deep(.app-right-sidebar-region) {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  overflow: hidden;
}

/*
 * 接缝归邻居画,而不是归中间的聊天面板画。
 *
 * 两侧 region 收起时都挂 is-collapsed(宽度 0)—— "邻居不在,线就不在",所以线
 * 永远落在两块内容之间,绝不会跑到窗口边上去跟系统投影叠成一条粗边。
 * 全局 box-sizing: border-box,这 1px 不会把面板挤宽。
 *
 * L4 起左栏 region **常驻 DOM**(单实例侧栏要靠它活着),所以它也必须像右栏那样
 * 写成 `:not(.is-collapsed)`:0 宽的面板加一条 border 就是窗口左缘上一条 1px 的
 * 竖线,正是这条注释在防的那件事。
 */
.app-shell :deep(.app-left-sidebar-region:not(.is-collapsed)) {
  border-right: 1px solid var(--app-seam-line);
}

.app-shell :deep(.app-right-sidebar-region:not(.is-collapsed)) {
  border-left: 1px solid var(--app-seam-line);
}

.app-shell :deep(.app-shell-main-region),
.app-shell :deep(.app-content-main-region),
.app-shell :deep(.app-main-content-region) {
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.app-shell :deep(.app-left-sidebar-region > .sidebar) {
  flex: 1 1 auto;
  height: 100%;
}

.app-shell :deep(.app-left-sidebar-region) {
  /* Keep layout width discrete; animating it relayouts the full message list every frame. */
  transition: none;
}

.app-shell.is-sidebar-resizing :deep(.app-left-sidebar-region) {
  transition: none;
}

/* Main Content - Full height, horizontal layout */
.app-content {
  width: 100%;
  height: 100%;
  min-height: 0;
  min-width: 0;
  position: relative;
  overflow: hidden;
  background: var(--ui-surface-app-bg);
}

.app-content-splitter {
  width: 100%;
  height: 100%;
  min-width: 0;
  min-height: 0;
}

.app-right-sidebar-region {
  position: relative;
}

/*
 * 右栏内容的**冻结宽**(L1)。
 *
 * 折叠/展开是一条 flex-basis 过渡:内容若跟着每帧的面板宽走,tab 条与终端会在
 * 200ms 里重排几十次。所以内容常态定宽 = 面板宽减掉那 1px border-left
 * (`--workbench-width` 由本组件一次写在 `.app-content` 上,不每帧),让收拢的
 * 面板边缘去裁它。
 *
 * 唯一的例外是用户正拖分隔条:那时内容就该跟着走,否则边缘和内容脱节。
 * `.is-dragging` 是 Splitter 自己挂在根上的,不必再造一个状态。
 */
.workbench-slide {
  /* 主轴是**纵向**(.app-right-sidebar-region 是 column):flex 这一行管的是高度,
     宽度归下面那条 width —— 两者别混。 */
  flex: 1 1 auto;
  width: var(--workbench-width, 100%);
  min-width: 0;
  min-height: 0;
}

.app-content-splitter.is-dragging .workbench-slide {
  width: 100%;
}

/* Hide only after the slide-out finishes; reappear instantly on expand. */
.app-right-sidebar-region.is-collapsed .workbench-slide {
  visibility: hidden;
  transition: visibility 0s linear var(--duration-normal);
}
</style>
