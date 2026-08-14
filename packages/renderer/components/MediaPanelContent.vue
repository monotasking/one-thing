<template>
  <!-- Media 视图本体。P2 按设计稿(Claude Design «Media Panel», Turn 2/4)重做:
       PanelShell 骨架 + 双行控制区 + 日期分组网格/文件行 + 同层推入的详情 +
       多选粘底条 + 四态之二(空态两屏 / 骨架)。底色不在这里画:它住在工作台的
       `surface="panel"` 面里。 -->
  <!-- 落区绑在这一格的根上,于是遮罩天然只盖 pane 内容、盖不到上方的页签条
       (设计稿要求:拖到一半还能换目标页签)。`v-on="dropHandlers"` 的键是**裸
       事件名**,而且落区必须经 `useFileDrop` 注册 —— 全局守卫会把未注册落区的
       drop 设成 `dropEffect:none`,裸 `@drop` 只会跟守卫打架。
       自己的两枚监听写在 `v-on` **之前**:合并后按出现次序执行,⌥ 于是在
       useFileDrop 的 drop 处理器读走文件之前就已经记下了。 -->
  <div
    class="media-panel-content"
    @dragover="captureDragIntent"
    @drop="captureDragIntent"
    v-on="dropHandlers"
  >
    <!-- web 没有原生文件对话框(`showOpenDialog` 是 canceled stub),用它兜底。 -->
    <input
      ref="fileInputRef"
      type="file"
      multiple
      class="visually-hidden-input"
      @change="onFileInputChange"
    >

    <PanelShell
      :busy="isBusy"
      :padded="false"
    >
      <template #controls>
        <!-- `.content-header` 这个类名是留给下拉的:Select 缺省**在流内**渲染,
             它必须待在一个自成层叠上下文的容器里才盖得住下方的瓦片。 -->
        <div
          class="content-header media-filter-bar"
          :class="{ 'is-dimmed': isLibraryEmpty }"
        >
          <div class="filter-row">
            <FilterSearchInput
              v-model="searchInput"
              size="compact"
              class="media-search-control"
              placeholder="搜索文件名、prompt、模型"
              label="搜索素材"
            />
            <Select
              v-model="activeKindModel"
              class="media-kind-filter"
              :options="kindFilterOptions"
              aria-label="按类型筛选"
              fit-input-width
            >
              <template #label="{ option, label }">
                <span class="media-select-label">
                  <component
                    :is="optionIcon(option)"
                    v-if="optionIcon(option)"
                    :size="13"
                    :stroke-width="1.8"
                    class="media-select-icon"
                  />
                  <span class="media-select-text">{{ label }}</span>
                </span>
              </template>
              <template #option="{ option, label }">
                <span class="media-select-label">
                  <component
                    :is="optionIcon(option)"
                    v-if="optionIcon(option)"
                    :size="13"
                    :stroke-width="1.8"
                    class="media-select-icon"
                  />
                  <span class="media-select-text">{{ label }}</span>
                </span>
              </template>
            </Select>
          </div>

          <div class="filter-row is-secondary">
            <SegmentedPill
              v-model="activeSourceModel"
              class="media-source-filter"
              :options="sourceFilterOptions"
              aria-label="按来源筛选"
            />

            <Button
              unstyled
              class="text-action sort-toggle"
              native-type="button"
              @click="toggleSort"
            >
              {{ sortLabel }}
              <component
                :is="sortOrder === 'newest' ? ChevronDown : ChevronUp"
                :size="12"
                :stroke-width="1.8"
                class="sort-chevron"
              />
            </Button>

            <button
              type="button"
              class="select-pill"
              :class="{ 'is-active': selectMode }"
              :aria-pressed="selectMode"
              @click="toggleSelectMode"
            >
              {{ selectMode ? '完成' : '多选' }}
            </button>
          </div>
        </div>
      </template>

      <div class="media-scroll">
        <PanelSkeleton v-if="showSkeleton" />

        <template v-else-if="groups.length > 0">
          <section
            v-for="group in groups"
            :key="group.key"
            class="media-group"
          >
            <LedgerGroupHeader
              sticky
              :label="group.label"
              :count="group.assets.length"
            />

            <div
              v-if="group.layout === 'grid'"
              class="media-grid"
            >
              <div
                v-for="asset in group.assets"
                :key="asset.id"
                class="media-tile"
                :class="{
                  'is-open': selectedAsset?.id === asset.id,
                  'is-picked': isPicked(asset.id),
                }"
                role="button"
                tabindex="0"
                @click="activateAsset(asset)"
                @keydown.enter.prevent="activateAsset(asset)"
                @keydown.space.prevent="activateAsset(asset)"
                @contextmenu.prevent="openContextMenu($event, asset)"
              >
                <img
                  :src="mediaStore.getImageUrl(asset)"
                  :alt="assetTitle(asset)"
                  :width="asset.width"
                  :height="asset.height"
                  class="media-thumbnail"
                  loading="lazy"
                  decoding="async"
                >
                <SelectionMark
                  v-if="selectMode"
                  class="tile-mark"
                  :checked="isPicked(asset.id)"
                  :aria-label="assetTitle(asset)"
                />
                <!-- 字幕 scrim 只在**打开项**上出现(设计稿裁决:hover 就浮字会让
                     整面网格变成闪烁的字幕墙)。 -->
                <div
                  v-if="selectedAsset?.id === asset.id"
                  class="tile-caption"
                >
                  <span class="tile-caption-text">{{ assetTitle(asset) }}</span>
                </div>
              </div>
            </div>

            <div
              v-else
              class="media-file-list"
            >
              <MediaFileRow
                v-for="asset in group.assets"
                :key="asset.id"
                :asset="asset"
                :meta="fileRowMeta(asset)"
                :source-label="sourceLabel(asset.source)"
                :source-tone="sourceTone(asset.source)"
                :select-mode="selectMode"
                :selected="isPicked(asset.id)"
                :active="selectedAsset?.id === asset.id"
                @click="activateAsset(asset)"
                @keydown.enter.prevent="activateAsset(asset)"
                @keydown.space.prevent="activateAsset(asset)"
                @contextmenu.prevent="openContextMenu($event, asset)"
              />
            </div>
          </section>
        </template>

        <!-- 筛选空态是**另一屏**:库里有东西、只是这组条件捞不着,该给的是
             「清除筛选」而不是「去生成一张」。 -->
        <div
          v-else-if="hasActiveFilter"
          class="empty-state is-filtered"
        >
          <span
            class="empty-icon"
            aria-hidden="true"
          >
            <SearchX
              :size="21"
              :stroke-width="1.6"
            />
          </span>
          <h3 class="empty-title">
            没有匹配的素材
          </h3>
          <p class="empty-hint">
            换个类型或来源试试,也可以直接清掉这组筛选。
          </p>
          <Button
            unstyled
            class="text-action is-primary"
            native-type="button"
            @click="clearFilters"
          >
            清除筛选
          </Button>
        </div>

        <div
          v-else
          class="empty-state"
        >
          <span
            class="empty-icon"
            aria-hidden="true"
          >
            <ImageIcon
              :size="21"
              :stroke-width="1.6"
            />
          </span>
          <h3 class="empty-title">
            还没有素材
          </h3>
          <p class="empty-hint">
            对话里生成或上传的图片、文件会自动收进这里。也可以直接拖进面板。
          </p>
          <Button
            type="primary"
            size="small"
            native-type="button"
            @click="pickFiles"
          >
            选择文件
          </Button>
        </div>
      </div>

      <!-- 粘底操作条:住在滚动体内,`position: sticky` 贴在滚动视口底部。 -->
      <div
        v-if="selectMode"
        class="bulk-bar"
      >
        <span class="bulk-count">已选 {{ pickedIds.size }} 项</span>
        <Button
          unstyled
          class="text-action"
          native-type="button"
          @click="selectAllVisible"
        >
          全选
        </Button>
        <span class="bulk-spacer" />
        <Button
          unstyled
          class="text-action"
          native-type="button"
          :disabled="pickedIds.size === 0"
          @click="insertPicked"
        >
          插入对话
        </Button>
        <!-- 多选另存为**只弹一次**目录选择,然后逐个静默落盘 —— 选了 12 张就弹
             12 次保存框是这条路存在的理由(设计稿 v1 的「导出 zip」已剪)。 -->
        <Button
          unstyled
          class="text-action"
          native-type="button"
          :disabled="pickedIds.size === 0"
          @click="savePickedAs"
        >
          另存为
        </Button>
        <Button
          unstyled
          class="text-action is-danger"
          native-type="button"
          :disabled="pickedIds.size === 0"
          @click="removePicked"
        >
          移出
        </Button>
      </div>

      <template #status>
        <span class="status-text">{{ statusText }}</span>
      </template>
    </PanelShell>

    <!-- 详情:**同层推入**,不是右滑抽屉。它盖住整格 pane(含控制区与状态条),
         所以底色要一枚不透明面 —— 走 `--media-pane-bg` 这枚本地别名转手,
         区域面自绘归 Surface 档位管(ui-system §4 surface-literal)。 -->
    <Transition name="detail">
      <div
        v-if="selectedAsset"
        class="detail-view"
      >
        <div class="detail-header">
          <Button
            unstyled
            class="detail-back"
            native-type="button"
            aria-label="返回列表"
            @click="closeDetail"
          >
            <ArrowLeft
              :size="15"
              :stroke-width="1.8"
            />
          </Button>
          <span class="detail-title">{{ selectedAsset.fileName || 'Untitled' }}</span>
          <span class="detail-index">{{ detailPosition }} / {{ flatAssets.length }}</span>
        </div>

        <div class="detail-body">
          <img
            v-if="selectedAsset.kind === 'image'"
            :src="mediaStore.getImageUrl(selectedAsset)"
            :alt="selectedAsset.fileName"
            class="detail-preview"
            @click="launchGallery(selectedAsset)"
          >
          <div
            v-else
            class="detail-preview-fallback"
          >
            <component
              :is="kindIcon(selectedAsset.kind)"
              :size="40"
              :stroke-width="1.4"
            />
          </div>

          <div class="spec-list">
            <div
              v-for="spec in detailSpecs"
              :key="spec.label"
              class="spec-row"
            >
              <span class="spec-label">{{ spec.label }}</span>
              <span class="spec-val">{{ spec.value }}</span>
            </div>
          </div>

          <div
            v-if="selectedAsset.metadata?.prompt"
            class="detail-section"
          >
            <div class="section-title-with-action">
              <h4 class="section-heading">
                Prompt
              </h4>
              <Button
                unstyled
                class="text-action"
                native-type="button"
                @click="copyPromptText(selectedAsset.metadata.prompt)"
              >
                {{ copiedPrompt ? 'copied' : 'copy' }}
              </Button>
            </div>
            <div class="prompt-excerpt">
              {{ selectedAsset.metadata.prompt }}
            </div>
          </div>

          <div
            v-if="selectedAsset.metadata?.revisedPrompt"
            class="detail-section"
          >
            <div class="section-title-with-action">
              <h4 class="section-heading">
                Revised prompt
              </h4>
              <Button
                unstyled
                class="text-action"
                native-type="button"
                @click="copyRevisedPromptText(selectedAsset.metadata.revisedPrompt)"
              >
                {{ copiedRevisedPrompt ? 'copied' : 'copy' }}
              </Button>
            </div>
            <div class="prompt-excerpt">
              {{ selectedAsset.metadata.revisedPrompt }}
            </div>
          </div>
        </div>

        <div class="detail-footer">
          <Button
            unstyled
            class="text-action"
            native-type="button"
            @click="insertAssetIntoChat(selectedAsset)"
          >
            在聊天中引用
          </Button>
          <Button
            v-if="isLocalFile(selectedAsset)"
            unstyled
            class="text-action"
            native-type="button"
            @click="revealAsset(selectedAsset)"
          >
            显示于访达
          </Button>
          <Button
            v-if="isLocalFile(selectedAsset)"
            unstyled
            class="text-action"
            native-type="button"
            @click="copyFilePath(selectedAsset.filePath!)"
          >
            {{ copiedPath ? 'copied' : 'copy path' }}
          </Button>
          <Button
            unstyled
            class="text-action is-danger detail-delete"
            native-type="button"
            @click="deleteFromDetail(selectedAsset)"
          >
            delete
          </Button>
        </div>
      </div>
    </Transition>

    <!-- 拖放遮罩。`pointer-events: none` 是必需的:它自己吃掉指针事件的话,
         dragover 就再也到不了下面的落区,拖进来立刻"卡住"。 -->
    <div
      v-if="isDragActive"
      class="drop-overlay"
      aria-hidden="true"
    >
      <div class="drop-frame">
        <span class="drop-icon">
          <Upload
            :size="20"
            :stroke-width="1.6"
          />
        </span>
        <span class="drop-title">松手加入 Media</span>
        <span class="drop-meta">{{ dropMetaText }}</span>
        <span class="drop-chip">按 ⌥ 松手可同时插入对话</span>
      </div>
    </div>

    <ContextMenu
      :show="menuOpen"
      :x="menuX"
      :y="menuY"
      :items="menuItems"
      :min-width="206"
      @select="onMenuSelect"
      @close="closeContextMenu"
    />
  </div>
</template>

<script setup lang="ts">
import Button from '@/components/common/Button.vue'
import { ref, computed, onMounted, onUnmounted, watch, type Component } from 'vue'
import FilterSearchInput from './common/FilterSearchInput.vue'
import Select from './common/Select.vue'
import SegmentedPill from './common/SegmentedPill.vue'
import ContextMenu from './common/ContextMenu.vue'
import type { ContextMenuItem } from './common/context-menu'
import PanelShell from './workspace/PanelShell.vue'
import LedgerGroupHeader from './workspace/LedgerGroupHeader.vue'
import PanelSkeleton from './workspace/PanelSkeleton.vue'
import MediaFileRow from './workspace/MediaFileRow.vue'
import SelectionMark from './workspace/SelectionMark.vue'
import { useConfirm } from '@/composables/useConfirm'
import { useFileDrop } from '@/composables/useFileDrop'
import { useMediaStore } from '@/stores/media'
import { useSessionsStore } from '@/stores/sessions'
import type {
  MediaAsset,
  MediaIngestFileInput,
  MediaKind,
  MediaQuery,
  MediaSource,
  MessageAttachment,
} from '@/types'
import {
  ArrowLeft,
  ChevronDown,
  ChevronUp,
  Copy,
  CornerUpRight,
  Download,
  Eye,
  FileText,
  FolderOpen,
  Image as ImageIcon,
  Images,
  LayoutGrid,
  MessageSquare,
  Music,
  SearchX,
  Trash2,
  Upload,
  Video,
  X,
} from 'lucide-vue-next'
import { platformApi } from '@/platform'

type KindFilter = 'all' | 'image' | 'file' | 'audio' | 'video'
type SourceFilter = 'all' | 'user-upload' | 'ai-generated'
type SortOrder = 'newest' | 'oldest'
type KindFilterOption = { value: KindFilter; label: string; icon: Component }

interface MediaGroup {
  key: string
  label: string
  layout: 'grid' | 'rows'
  assets: MediaAsset[]
}

const emit = defineEmits<{
  /**
   * 右键「跳到来源消息」。本期只把意图冒到工作台那一层(那里留了 TODO);
   * 真正的 `chatContainerRef.jumpToMessage` 接线是 P3 的活。
   */
  'jump-to-source': [payload: { sessionId: string; messageId: string }]
}>()

const mediaStore = useMediaStore()
const sessionsStore = useSessionsStore()
const { confirm } = useConfirm()

const SEARCH_DEBOUNCE_MS = 250

/** 输入框的即时值;`searchQuery` 是防抖后真正进查询的那个。 */
const searchInput = ref('')
const searchQuery = ref('')
const activeKind = ref<KindFilter>('all')
const activeSource = ref<SourceFilter>('all')
const sortOrder = ref<SortOrder>('newest')
const selectMode = ref(false)
const pickedIds = ref<Set<string>>(new Set())
const selectedAsset = ref<MediaAsset | null>(null)
const copiedPrompt = ref(false)
const copiedRevisedPrompt = ref(false)
const copiedPath = ref(false)

// ── 入库态 ─────────────────────────────────────────────────────────────────
//
// 声明提到这里(而不是紧挨着下面的入库函数)只有一个理由:`isBusy` / `statusText`
// 两个 computed 就在几行之后,而它们要读 `isIngesting` / `ingestNote`。
const fileInputRef = ref<HTMLInputElement | null>(null)
const isIngesting = ref(false)
/** 一次入库/另存/复制的结果,借状态条说一句就消失(4s)。 */
const ingestNote = ref('')
/** 这次拖放松手时按着 ⌥ 吗 —— 入库后是否顺带插入对话。 */
const dropWithInsert = ref(false)
const dragFileCount = ref(0)

// ── 筛选:改走服务端 MediaQuery ──────────────────────────────────────────────
//
// `kind` 只把**一一对应**的三档交给服务端(image/audio/video)。「文件」这一档
// 故意不下发:服务端是 `asset.kind === query.kind` 的精确比较,而产品语义里
// 「文件」是 `file ∪ document` 两种 kind 的并集 —— 下发 `kind:'file'` 会把
// document 静默吃掉。所以这一档只发 source/search,并集在本地补(下面
// `matchesKindFilter`)。要根治得改服务端的 kind 归并,那是后端的活。
const SERVER_KIND: Partial<Record<KindFilter, MediaKind>> = {
  image: 'image',
  audio: 'audio',
  video: 'video',
}

function currentQuery(): MediaQuery {
  const query: MediaQuery = {}
  const kind = SERVER_KIND[activeKind.value]
  if (kind) query.kind = kind
  if (activeSource.value !== 'all') query.source = activeSource.value
  const search = searchQuery.value.trim()
  if (search) query.search = search
  return query
}

const hasActiveFilter = computed(() =>
  activeKind.value !== 'all' || activeSource.value !== 'all' || searchQuery.value.trim().length > 0)

function matchesKindFilter(asset: MediaAsset): boolean {
  if (activeKind.value === 'all') return true
  if (activeKind.value === 'file') return asset.kind === 'file' || asset.kind === 'document'
  return asset.kind === activeKind.value
}

const visibleAssets = computed(() => {
  const list = mediaStore.assets.filter(matchesKindFilter)
  const direction = sortOrder.value === 'newest' ? -1 : 1
  return [...list].sort((a, b) => (a.createdAt - b.createdAt) * direction)
})

// ── 分组:一天一段日期,段内先图片网格后文件行 ─────────────────────────────
//
// 拆法:每个日期最多产出**两个** group —— 图片组(label = 日期)与文件组
// (label =「文件 · 日期」)。设计稿画的就是这两种组头并列,而不是一个组里
// 塞两种排版;两个 group 也让 sticky 组头、计数、空组判定各归各的,
// 比"一个 group 内部再分岔"少一层条件。
const groups = computed<MediaGroup[]>(() => {
  const order: string[] = []
  const buckets = new Map<string, { label: string; images: MediaAsset[]; files: MediaAsset[] }>()

  for (const asset of visibleAssets.value) {
    const key = dayKey(asset.createdAt)
    let bucket = buckets.get(key)
    if (!bucket) {
      bucket = { label: dayLabel(asset.createdAt), images: [], files: [] }
      buckets.set(key, bucket)
      order.push(key)
    }
    if (asset.kind === 'image') bucket.images.push(asset)
    else bucket.files.push(asset)
  }

  const result: MediaGroup[] = []
  for (const key of order) {
    const bucket = buckets.get(key)!
    if (bucket.images.length > 0) {
      result.push({ key: `${key}:image`, label: bucket.label, layout: 'grid', assets: bucket.images })
    }
    if (bucket.files.length > 0) {
      result.push({ key: `${key}:file`, label: `文件 · ${bucket.label}`, layout: 'rows', assets: bucket.files })
    }
  }
  return result
})

/** 展示次序摊平 —— 详情的「3 / 48」与上一张/下一张都读这一份。 */
const flatAssets = computed(() => groups.value.flatMap(group => group.assets))

const detailPosition = computed(() => {
  if (!selectedAsset.value) return 0
  return flatAssets.value.findIndex(asset => asset.id === selectedAsset.value?.id) + 1
})

const isBusy = computed(() =>
  mediaStore.isLoading || mediaStore.isRebuilding || isIngesting.value)
const showSkeleton = computed(() => isBusy.value && mediaStore.assets.length === 0)
const isLibraryEmpty = computed(() =>
  !isBusy.value && !hasActiveFilter.value && mediaStore.assets.length === 0)

const totalBytes = computed(() =>
  visibleAssets.value.reduce((sum, asset) => sum + (asset.size || 0), 0))

const statusText = computed(() => {
  // 一次动作的回执优先:它是**刚发生的事**,压过常驻的清点。
  if (ingestNote.value) return ingestNote.value
  if (isIngesting.value) return '正在加入…'
  if (isBusy.value) return `正在索引 ${mediaStore.assets.length} 项…`
  return `${visibleAssets.value.length} 项 · 共 ${formatBytes(totalBytes.value)}`
})

// ── 控制区 ─────────────────────────────────────────────────────────────────

const activeKindModel = computed({
  get: () => activeKind.value,
  set: (value: string) => {
    activeKind.value = value as KindFilter
  },
})

const activeSourceModel = computed({
  get: () => activeSource.value,
  set: (value: string) => {
    activeSource.value = value as SourceFilter
  },
})

const kindFilterOptions = computed<KindFilterOption[]>(() => [
  { value: 'all', label: '全部', icon: LayoutGrid },
  { value: 'image', label: '图片', icon: Images },
  { value: 'file', label: '文件', icon: FileText },
  { value: 'audio', label: '音频', icon: Music },
  { value: 'video', label: '视频', icon: Video },
])

/** tool-output / external 没有自己的段:它们落在「全部」里(设计稿 Turn 4)。 */
const sourceFilterOptions = [
  { value: 'all', label: '全部' },
  { value: 'user-upload', label: '上传' },
  { value: 'ai-generated', label: '生成' },
]

const sortLabel = computed(() => (sortOrder.value === 'newest' ? '最新在前' : '最旧在前'))

function optionIcon(option: unknown): Component | null {
  if (!option || typeof option !== 'object' || !('icon' in option)) return null
  return (option as KindFilterOption).icon
}

function toggleSort() {
  sortOrder.value = sortOrder.value === 'newest' ? 'oldest' : 'newest'
}

function clearFilters() {
  activeKind.value = 'all'
  activeSource.value = 'all'
  searchInput.value = ''
  searchQuery.value = ''
}

// ── 多选 ───────────────────────────────────────────────────────────────────

function toggleSelectMode() {
  selectMode.value = !selectMode.value
  if (!selectMode.value) pickedIds.value = new Set()
}

function isPicked(id: string): boolean {
  return pickedIds.value.has(id)
}

function togglePicked(id: string) {
  if (pickedIds.value.has(id)) pickedIds.value.delete(id)
  else pickedIds.value.add(id)
}

function selectAllVisible() {
  pickedIds.value = new Set(flatAssets.value.map(asset => asset.id))
}

async function removePicked() {
  const ids = [...pickedIds.value]
  if (ids.length === 0) return
  if (!await confirm({ ...REMOVE_MEDIA_ASK })) return
  for (const id of ids) {
    await mediaStore.removeMedia(id)
  }
  pickedIds.value = new Set()
}

// ── 打开 / 详情 ────────────────────────────────────────────────────────────

/** 多选态下点一格是**勾选**,不是打开详情 —— 两种意图不能共用一次点击。 */
function activateAsset(asset: MediaAsset) {
  if (selectMode.value) {
    togglePicked(asset.id)
    return
  }
  selectedAsset.value = asset
}

function closeDetail() {
  selectedAsset.value = null
}

function stepDetail(delta: number) {
  if (!selectedAsset.value) return
  const list = flatAssets.value
  const index = list.findIndex(asset => asset.id === selectedAsset.value?.id)
  if (index === -1) return
  const next = list[index + delta]
  if (next) selectedAsset.value = next
}

const detailSpecs = computed<{ label: string; value: string }[]>(() => {
  const asset = selectedAsset.value
  if (!asset) return []

  const rows: { label: string; value: string }[] = [
    { label: '文件名', value: asset.fileName || '—' },
    { label: '格式', value: `${asset.mimeType || '—'} · ${formatBytes(asset.size)}` },
  ]
  if (asset.width && asset.height) {
    rows.push({ label: '尺寸', value: `${asset.width} × ${asset.height}` })
  }
  rows.push({ label: '来源', value: asset.metadata?.model || sourceLabel(asset.source) })
  rows.push({ label: '创建于', value: new Date(asset.createdAt).toLocaleString() })

  const session = sessionOfAsset(asset)
  if (session) rows.push({ label: '所属会话', value: session })
  return rows
})

/** 会话标题取不到就退回 id 截断 —— legacy 资产的 links 常常只剩一个 id。 */
function sessionOfAsset(asset: MediaAsset): string | null {
  const sessionId = asset.links?.[0]?.sessionId
  if (!sessionId) return null
  const found = sessionsStore.sessions.find(session => session.id === sessionId)
  return found?.name || `${sessionId.slice(0, 8)}…`
}

// ── 右键菜单 ───────────────────────────────────────────────────────────────

const menuOpen = ref(false)
const menuX = ref(0)
const menuY = ref(0)
const menuAsset = ref<MediaAsset | null>(null)

function openContextMenu(event: MouseEvent, asset: MediaAsset) {
  menuAsset.value = asset
  menuX.value = event.clientX
  menuY.value = event.clientY
  menuOpen.value = true
}

function closeContextMenu() {
  menuOpen.value = false
  menuAsset.value = null
}

function jumpTargetOf(asset: MediaAsset | null): { sessionId: string; messageId: string } | null {
  const link = asset?.links?.[0]
  if (!link?.sessionId || !link?.messageId) return null
  return { sessionId: link.sessionId, messageId: link.messageId }
}

const menuItems = computed<ContextMenuItem[]>(() => {
  // 多选态折叠成四项(设计稿 Turn 4)——单项动作在这个模式下没有主语。
  if (selectMode.value) {
    const nonePicked = pickedIds.value.size === 0
    return [
      { id: 'bulk-insert', label: '插入当前对话', icon: MessageSquare, disabled: nonePicked },
      { id: 'bulk-save', label: '另存为…', icon: Download, disabled: nonePicked },
      { id: 'bulk-remove', label: `移出 Media(${pickedIds.value.size})`, icon: Trash2, danger: true, separatorBefore: true, disabled: nonePicked },
      { id: 'exit-select', label: '取消多选', icon: X },
    ]
  }

  const asset = menuAsset.value
  const items: ContextMenuItem[] = [
    { id: 'preview', label: '预览', icon: Eye, disabled: asset?.kind !== 'image' },
    { id: 'insert', label: '插入当前对话', icon: MessageSquare, disabled: !asset },
    // 剪贴板图片是**可选**能力(web 端只接 PNG,更老的浏览器根本没有):
    // 宿主接不住就保持禁用,不假装能用。
    { id: 'copy-image', label: '复制图片', icon: Copy, disabled: asset?.kind !== 'image' || !asset?.filePath || !platformApi.writeClipboardImage },
    { id: 'save-as', label: '另存为…', icon: Download, disabled: !asset?.filePath },
    { id: 'jump', label: '跳到来源消息', icon: CornerUpRight, separatorBefore: true, disabled: !jumpTargetOf(asset) },
  ]
  if (asset && isLocalFile(asset)) {
    items.push({ id: 'reveal', label: '在 Finder 中显示', icon: FolderOpen })
  }
  items.push({ id: 'remove', label: '移出 Media', icon: Trash2, danger: true, separatorBefore: true })
  return items
})

function onMenuSelect(id: string) {
  const asset = menuAsset.value
  closeContextMenu()

  switch (id) {
    case 'preview':
      if (asset) launchGallery(asset)
      break
    case 'insert':
      if (asset) void insertAssetIntoChat(asset)
      break
    case 'copy-image':
      if (asset) void copyImageAsset(asset)
      break
    case 'save-as':
      if (asset) void saveAssetAs(asset)
      break
    case 'jump': {
      const target = jumpTargetOf(asset)
      if (target) emit('jump-to-source', target)
      break
    }
    case 'reveal':
      if (asset) revealAsset(asset)
      break
    case 'remove':
      if (asset) void removeAsset(asset.id)
      break
    case 'bulk-insert':
      void insertPicked()
      break
    case 'bulk-save':
      void savePickedAs()
      break
    case 'bulk-remove':
      void removePicked()
      break
    case 'exit-select':
      selectMode.value = false
      pickedIds.value = new Set()
      break
    default:
      break
  }
}

// ── 呈现口径 ───────────────────────────────────────────────────────────────

function sourceLabel(source: MediaSource | SourceFilter): string {
  if (source === 'all') return '全部'
  if (source === 'user-upload') return '上传'
  if (source === 'ai-generated') return '生成'
  if (source === 'tool-output') return '工具'
  return '外部'
}

function sourceTone(source: MediaSource): 'upload' | 'generated' {
  return source === 'user-upload' ? 'upload' : 'generated'
}

function kindIcon(kind: MediaKind) {
  if (kind === 'image') return Images
  if (kind === 'audio') return Music
  if (kind === 'video') return Video
  return FileText
}

function assetTitle(asset: MediaAsset): string {
  return asset.metadata?.prompt || asset.fileName || 'Untitled asset'
}

function fileRowMeta(asset: MediaAsset): string {
  return `${formatBytes(asset.size)} · ${monthDay(asset.createdAt)}`
}

function dayKey(timestamp: number): string {
  const date = new Date(timestamp)
  return `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`
}

function monthDay(timestamp: number): string {
  const date = new Date(timestamp)
  return `${date.getMonth() + 1} 月 ${date.getDate()} 日`
}

function dayLabel(timestamp: number): string {
  const now = new Date()
  const todayKey = dayKey(now.getTime())
  const yesterdayKey = dayKey(now.getTime() - 24 * 60 * 60 * 1000)
  const key = dayKey(timestamp)
  if (key === todayKey) return '今天'
  if (key === yesterdayKey) return '昨天'
  return monthDay(timestamp)
}

function formatBytes(bytes?: number): string {
  if (bytes === undefined || bytes === null || isNaN(bytes)) return 'Unknown size'
  if (bytes === 0) return '0 Bytes'
  const k = 1024
  const sizes = ['Bytes', 'KB', 'MB', 'GB']
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i]
}

/**
 * 桌面才有真路径。server 上 `filePath` 是 `/api/media/file/…` 这样的 URL,
 * 「显示于访达」「copy path」对它没有意义 —— 整条隐藏而不是给个按不动的钮。
 * (`revealPath` 本身是有 web parity 的,拦的是路径形态不是宿主。)
 */
function isLocalFile(asset: MediaAsset): boolean {
  const path = asset.filePath
  if (!path) return false
  return !path.startsWith('/api/') && !/^(https?:)?\/\//.test(path)
}

// ── 动作 ───────────────────────────────────────────────────────────────────

function copyPromptText(text: string) {
  navigator.clipboard.writeText(text)
  copiedPrompt.value = true
  setTimeout(() => copiedPrompt.value = false, 1500)
}

function copyRevisedPromptText(text: string) {
  navigator.clipboard.writeText(text)
  copiedRevisedPrompt.value = true
  setTimeout(() => copiedRevisedPrompt.value = false, 1500)
}

function copyFilePath(path: string) {
  navigator.clipboard.writeText(path)
  copiedPath.value = true
  setTimeout(() => copiedPath.value = false, 1500)
}

function launchGallery(asset: MediaAsset) {
  platformApi.openImageGallery(asset.id)
}

function revealAsset(asset: MediaAsset) {
  if (asset.filePath) void platformApi.revealPath(asset.filePath)
}

const REMOVE_MEDIA_ASK = {
  title: '移出素材库',
  message: '把它移出素材库?原来的聊天消息不受影响。',
  confirmText: '移出',
  danger: true,
} as const

async function deleteFromDetail(asset: MediaAsset) {
  if (!await confirm({ ...REMOVE_MEDIA_ASK })) return
  selectedAsset.value = null
  await mediaStore.removeMedia(asset.id)
}

async function removeAsset(id: string) {
  if (!await confirm({ ...REMOVE_MEDIA_ASK })) return
  if (selectedAsset.value?.id === id) selectedAsset.value = null
  await mediaStore.removeMedia(id)
}

// ── 入库:拖放 / 选择文件 ───────────────────────────────────────────────────

/**
 * 只有**没有本地路径**的文件才需要抬字节(浏览器端、剪贴板来的)。10MB 是
 * composer 附件那条闸的同一个数(useAttachments 的 MAX_ATTACHMENT_SIZE)——
 * 两个入口一个口径,免得同一个文件在两处得到两种答复。桌面走路径,不设上限:
 * 那正是"传路径不传字节"要买的东西。
 */
const WEB_INGEST_MAX_BYTES = 10 * 1024 * 1024

let noteTimer: ReturnType<typeof setTimeout> | null = null

function showNote(text: string) {
  ingestNote.value = text
  if (noteTimer) clearTimeout(noteTimer)
  noteTimer = setTimeout(() => { ingestNote.value = '' }, 4000)
}

const { isDragActive, dropHandlers } = useFileDrop({
  onFiles: files => ingestDroppedFiles(files),
})

/**
 * 遮罩上的那行 mono 字。**只有文件数,没有体积**:dragover 阶段拿到的是
 * `DataTransferItem`,规范不暴露 size(要等 drop 之后的 `File` 才有),编一个
 * 数字出来比不写更糟。
 */
const dropMetaText = computed(() =>
  dragFileCount.value > 0 ? `${dragFileCount.value} 个文件` : '文件')

/**
 * dragover 与 drop 各读一次 ⌥:整程按着与最后一刻才按下都算数(后者不会再有
 * 一次 dragover)。
 */
function captureDragIntent(event: DragEvent) {
  dropWithInsert.value = event.altKey === true
  const items = event.dataTransfer?.items
  if (!items) return
  const count = Array.from(items).filter(item => item.kind === 'file').length
  if (count > 0) dragFileCount.value = count
}

watch(isDragActive, (active) => {
  if (!active) dragFileCount.value = 0
})

function localPathOf(file: File): string {
  try {
    return platformApi.getPathForFile(file) || ''
  } catch {
    return ''
  }
}

function readFileAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result || '').split(',')[1] || '')
    reader.onerror = () => reject(new Error(`读不出 ${file.name}`))
    reader.readAsDataURL(file)
  })
}

async function ingestDroppedFiles(files: File[]) {
  const alsoInsert = dropWithInsert.value
  dropWithInsert.value = false
  await ingestFiles(files, alsoInsert)
}

async function ingestFiles(files: File[], alsoInsert = false) {
  if (files.length === 0) return
  const payload: MediaIngestFileInput[] = []
  const skipped: string[] = []

  for (const file of files) {
    const filePath = localPathOf(file)
    if (filePath) {
      payload.push({ filePath, fileName: file.name, mimeType: file.type || undefined })
      continue
    }
    if (file.size > WEB_INGEST_MAX_BYTES) {
      skipped.push(file.name)
      continue
    }
    try {
      payload.push({
        base64Data: await readFileAsBase64(file),
        fileName: file.name,
        mimeType: file.type || undefined,
      })
    } catch {
      skipped.push(file.name)
    }
  }

  await ingestInputs(payload, { alsoInsert, skippedCount: skipped.length })
}

async function ingestInputs(
  files: MediaIngestFileInput[],
  options: { alsoInsert?: boolean; skippedCount?: number } = {},
) {
  const skippedCount = options.skippedCount ?? 0
  if (files.length === 0) {
    if (skippedCount > 0) showNote(`${skippedCount} 个文件太大,未加入`)
    return
  }

  isIngesting.value = true
  try {
    const response = await mediaStore.ingestFiles({ files, source: 'user-upload' })
    // 强制重取:走的是当前筛选条件,刚入库的东西可能根本不在这一屏里。
    await refreshMedia(true)
    if (options.alsoInsert) {
      for (const asset of response.assets) await insertAssetIntoChat(asset)
    }
    const failed = response.errors.length + skippedCount
    showNote(failed > 0
      ? `已加入 ${response.created} 项 · ${failed} 项未能加入`
      : `已加入 ${response.created} 项`)
  } finally {
    isIngesting.value = false
  }
}

/**
 * 空态的「选择文件」。桌面走宿主对话框(记得上次目录、有标题);web 端
 * `showOpenDialog` 是一颗 canceled stub,所以那一侧改用隐藏的 `<input type=file>`
 * —— 按能力分岔,而不是靠"返回了 canceled"去猜自己在哪个宿主上。
 */
async function pickFiles() {
  if (!platformApi.capabilities.localFileSystem) {
    fileInputRef.value?.click()
    return
  }
  const result = await platformApi.showOpenDialog({
    properties: ['openFile', 'multiSelections'],
  })
  if (result.canceled || result.filePaths.length === 0) return
  await ingestInputs(result.filePaths.map(filePath => ({
    filePath,
    fileName: filePath.split(/[\\/]/).pop() || filePath,
  })))
}

async function onFileInputChange(event: Event) {
  const input = event.target as HTMLInputElement
  const files = Array.from(input.files ?? [])
  // 清空:同一个文件连选两次也要能再触发一次 change。
  input.value = ''
  await ingestFiles(files)
}

// ── 插入对话 / 复制 / 另存 ──────────────────────────────────────────────────

function pickedAssets(): MediaAsset[] {
  return flatAssets.value.filter(asset => pickedIds.value.has(asset.id))
}

function attachmentMediaType(kind: MediaKind): MessageAttachment['mediaType'] {
  if (kind === 'image' || kind === 'audio' || kind === 'video' || kind === 'document') return kind
  return 'file'
}

/**
 * 「插入当前对话」/「在聊天中引用」。
 *
 * **不新造 IPC**:composer 早就听着 `onething:composer-attach`(内嵌浏览器的
 * 元素拾取就是走它),这里只是第二个生产者 —— 聊天那一侧一行都不用改。
 * 图片顺手把字节读出来:有 base64 才是"原生投递",没有就只剩路径引用,
 * useAttachments 的 resolveDelivery 会如实降级并在附件上标 PATH。
 */
async function insertAssetIntoChat(asset: MediaAsset | null) {
  if (!asset) return
  const attachment: MessageAttachment = {
    id: `media-${asset.id}`,
    fileName: asset.fileName || 'untitled',
    mimeType: asset.mimeType || 'application/octet-stream',
    size: asset.size || 0,
    mediaType: attachmentMediaType(asset.kind),
    ...(isLocalFile(asset) && asset.filePath ? { filePath: asset.filePath } : {}),
    width: asset.width,
    height: asset.height,
  }

  if (asset.kind === 'image' && asset.filePath) {
    try {
      const dataUrl = await platformApi.readImageBase64(asset.filePath)
      const base64 = String(dataUrl || '').split(',')[1]
      if (base64) attachment.base64Data = base64
    } catch {
      // 读不出就退回路径引用,不因此拦下整次插入。
    }
  }

  window.dispatchEvent(new CustomEvent('onething:composer-attach', { detail: attachment }))
}

async function insertPicked() {
  for (const asset of pickedAssets()) await insertAssetIntoChat(asset)
}

/**
 * 「复制图片」。桌面在 preload 里就地写剪贴板(与 `writeClipboardText` 同一层,
 * 不经 IPC);web 端由 platform 那侧 fetch 字节 + 异步剪贴板,且只接 PNG ——
 * 那是剪贴板规范的限制,不是实现偷懒,所以失败时把原话报出来。
 */
async function copyImageAsset(asset: MediaAsset) {
  if (!asset.filePath || !platformApi.writeClipboardImage) return
  const result = await platformApi.writeClipboardImage(asset.filePath)
  showNote(result.success ? '已复制图片' : (result.error || '复制失败'))
}

/** server 上 `filePath` 是一条 URL:浏览器里的「另存为」就是一次下载。 */
function downloadInBrowser(asset: MediaAsset) {
  const link = document.createElement('a')
  link.href = asset.filePath || ''
  link.download = asset.fileName || 'download'
  document.body.appendChild(link)
  link.click()
  link.remove()
}

async function saveAssetAs(asset: MediaAsset) {
  if (!asset.filePath) return
  if (!isLocalFile(asset)) {
    downloadInBrowser(asset)
    return
  }
  const result = await platformApi.saveMediaAs({
    filePath: asset.filePath,
    fileName: asset.fileName,
  })
  if (result.canceled) return
  showNote(result.success ? `已另存 ${asset.fileName}` : (result.error || '另存失败'))
}

/** 多选另存:**只**问一次目录,然后逐个静默落盘。 */
async function savePickedAs() {
  const assets = pickedAssets().filter(asset => asset.filePath)
  if (assets.length === 0) return

  if (!platformApi.capabilities.localFileSystem) {
    for (const asset of assets) downloadInBrowser(asset)
    return
  }

  const picked = await platformApi.showOpenDialog({
    properties: ['openDirectory'],
    title: '选择保存位置',
  })
  if (picked.canceled || picked.filePaths.length === 0) return

  const targetDir = picked.filePaths[0]
  let saved = 0
  let failed = 0
  for (const asset of assets) {
    const result = await platformApi.saveMediaAs({
      filePath: asset.filePath!,
      fileName: asset.fileName,
      targetDir,
    })
    if (result.success) saved += 1
    else failed += 1
  }
  showNote(failed > 0 ? `已另存 ${saved} 项 · ${failed} 项失败` : `已另存 ${saved} 项`)
}

// ── 键盘 ───────────────────────────────────────────────────────────────────

/**
 * 详情不是浮层,所以**不进 esc-stack**(那条栈是给 Popover/Dialog 那一族用的,
 * 混进一个非浮层会让"栈顶才响应 Esc"的口径失真)。取而代之的两道闸:
 *  · `defaultPrevented` —— 内核那一族在捕获期先跑并 preventDefault,于是
 *    "下拉开着按 Esc" 只关下拉,不会连详情一起收掉;
 *  · 输入框内的方向键归输入框,不做上一张/下一张。
 */
const handleKeyDown = (event: KeyboardEvent) => {
  if (!selectedAsset.value || event.defaultPrevented) return

  if (event.key === 'Escape') {
    closeDetail()
    return
  }

  const target = event.target as HTMLElement | null
  const tag = target?.tagName?.toLowerCase()
  if (tag === 'input' || tag === 'textarea' || target?.isContentEditable) return

  if (event.key === 'ArrowRight' || event.key === 'j') {
    event.preventDefault()
    stepDetail(1)
  } else if (event.key === 'ArrowLeft' || event.key === 'k') {
    event.preventDefault()
    stepDetail(-1)
  }
}

// ── 数据 ───────────────────────────────────────────────────────────────────

async function refreshMedia(force = false) {
  await mediaStore.loadMedia({ rebuild: false, force, query: currentQuery() })
}

let searchTimer: ReturnType<typeof setTimeout> | null = null

watch(searchInput, (value) => {
  if (searchTimer) clearTimeout(searchTimer)
  searchTimer = setTimeout(() => {
    searchQuery.value = value
  }, SEARCH_DEBOUNCE_MS)
})

watch([activeKind, activeSource, searchQuery], () => {
  selectedAsset.value = null
  void refreshMedia()
})

let unsubscribe: (() => void) | null = null

/**
 * 索引在**挂载**时拉一次(`TabPane lazy` 让"挂载"就等于"第一次露面")。
 * 生成出新图由 `onImageGenerated` 这条订阅补,带上当前查询强制重取。
 */
onMounted(async () => {
  unsubscribe = platformApi.onImageGenerated(async () => {
    await refreshMedia(true)
  })
  window.addEventListener('keydown', handleKeyDown)
  await refreshMedia()
})

onUnmounted(() => {
  if (unsubscribe) unsubscribe()
  if (searchTimer) clearTimeout(searchTimer)
  if (noteTimer) clearTimeout(noteTimer)
  window.removeEventListener('keydown', handleKeyDown)
})
</script>

<style scoped>
/*
 * Media 视图 —— 画线风 (ledger / ink-line),按设计稿 Turn 2/4 重做。
 *
 * z 的处置:这一格自己**建一个层叠上下文**(`isolation`),于是"控制区盖住网格"
 * 「详情盖住一切」全部是个位数的局部关系,不再需要从 `--z-dropdown` 借档
 * (从前是 `calc(var(--z-dropdown) + 5)`,ui-system §3 里那条 "+5 MediaPanel 工具条"
 * 随之撤销)。用 `isolation` 而不是 `z-index: 0`:它只建上下文,不带布局约束,
 * Select 的流内下拉照旧能溢出控制条。
 */
.media-panel-content {
  position: relative;
  flex: 1 1 auto;
  width: 100%;
  height: 100%;
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  isolation: isolate;

  /* 详情那一面要一枚不透明底才盖得住底下的列表。区域面自绘归 Surface 档位管
     (ui-system §4 surface-literal),所以这里只**转手**一个别名,不落笔涂底
     —— 和 PanelShell 的 `--panel-shell-bg` 同一种手法。 */
  --media-pane-bg: var(--ui-surface-panel-bg);
}

/* ---- 控制区:两行 ---- */
.content-header {
  position: relative;
  z-index: 2;
  display: flex;
  flex-direction: column;
  gap: 8px;
  flex: 1;
  min-width: 0;
  overflow: visible;
  transition: opacity var(--duration-normal) var(--ease-default);
}

/* 空态:控制区暗下来但**不禁用** —— 库是空的不代表筛选器坏了。 */
.content-header.is-dimmed {
  opacity: 0.5;
}

.filter-row {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.filter-row.is-secondary {
  gap: 10px;
}

.media-search-control {
  flex: 1 1 auto;
  min-width: 0;
}

.media-kind-filter {
  flex: 0 0 auto;
  min-width: 104px;
}

.media-source-filter {
  flex: 0 0 auto;
}

.media-select-label {
  display: inline-flex;
  align-items: center;
  min-width: 0;
  gap: 6px;
}

.media-select-icon {
  flex: 0 0 auto;
  color: var(--ui-text-muted-fg);
}

.media-select-text {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.sort-toggle {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  font-family: inherit;
  font-size: 11.5px;
}

.sort-chevron {
  flex: 0 0 auto;
}

/* 多选丸:进多选后是**主行动**,主色底 + 反色字。选中态禁涂底那条针对的是
   列表行,不是一颗自愿表态的按钮。 */
.select-pill {
  appearance: none;
  margin-left: auto;
  height: 24px;
  padding: 0 9px;
  border: 1px solid var(--ui-border-default-border);
  border-radius: var(--radius-full);
  background: transparent;
  color: var(--ui-text-muted-fg);
  font-family: inherit;
  font-size: 11.5px;
  white-space: nowrap;
  cursor: pointer;
  transition:
    color var(--duration-fast) var(--ease-default),
    background var(--duration-fast) var(--ease-default),
    border-color var(--duration-fast) var(--ease-default);
}

.select-pill:hover {
  color: var(--ui-text-primary-fg);
  border-color: var(--ui-border-strong-border);
}

.select-pill.is-active {
  border-color: var(--ui-accent-primary-fg);
  background: var(--ui-action-primary-bg, var(--ui-accent-primary-fg));
  color: var(--ui-action-primary-fg, var(--ui-text-inverse-fg));
}

.select-pill:focus-visible {
  outline: 1px solid var(--ui-accent-primary-fg);
  outline-offset: 2px;
}

/* ---- 内容 ---- */
.media-scroll {
  padding: 0 14px 16px;
}

.media-group {
  min-width: 0;
}

.media-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(118px, 1fr));
  gap: 8px;
  padding: 2px 0 12px;
}

.media-tile {
  position: relative;
  aspect-ratio: 1;
  border-radius: var(--radius-sm);
  overflow: hidden;
  cursor: pointer;
  outline: 1px solid transparent;
  outline-offset: -1px;
  transition: outline-color var(--duration-fast) var(--ease-default);
}

.media-tile:hover {
  outline-color: var(--ui-border-strong-border);
}

.media-tile:focus-visible,
.media-tile.is-open,
.media-tile.is-picked {
  outline-color: var(--ui-accent-primary-fg);
}

.media-thumbnail {
  width: 100%;
  height: 100%;
  display: block;
  object-fit: cover;
}

.tile-mark {
  position: absolute;
  top: 6px;
  left: 6px;
}

/* 字幕 scrim:图纸给的是 rgba(16,15,15,.72),这里翻成 `--ui-text-primary-fg` 的
   72% —— 正文墨色本来就是那枚近黑,而且它跟着主题走;字用 `--ui-text-inverse-fg`
   (= 页面底色),于是深色主题下 scrim 变浅、字变深,反差不会翻车。 */
.tile-caption {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  padding: 14px 7px 6px;
  background: linear-gradient(transparent, color-mix(in srgb, var(--ui-text-primary-fg) 72%, transparent));
  pointer-events: none;
}

.tile-caption-text {
  display: block;
  font-size: 10px;
  color: var(--ui-text-inverse-fg);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.media-file-list {
  padding-bottom: 12px;
}

/* ---- 空态两屏 ---- */
.empty-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 14px;
  padding: 56px 56px 0;
  text-align: center;
}

.empty-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 46px;
  height: 46px;
  border: 1px dashed var(--ui-border-strong-border);
  border-radius: 10px;
  color: var(--ui-text-faint-fg);
}

.empty-title {
  margin: 0;
  font-family: var(--font-display, var(--font-serif, serif));
  font-size: 16px;
  font-weight: 600;
  color: var(--ui-text-primary-fg);
}

.empty-hint {
  margin: 0;
  font-size: 12.5px;
  line-height: 1.7;
  color: var(--ui-text-secondary-fg);
}

/* ---- 多选粘底条 ---- */
.bulk-bar {
  position: sticky;
  bottom: 0;
  z-index: 3;
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 10px 14px;
  border-top: 1px solid var(--ui-border-default-border);
  background: var(--panel-shell-bg, var(--ui-surface-panel-bg));
  /* 向上的投影没有对应的 `--shadow-*` 档(现存三档都朝下),所以这里自写方向、
     但颜色仍从墨色 token 推导 —— 不落任何颜色字面量。 */
  box-shadow: 0 -4px 12px color-mix(in srgb, var(--ui-text-primary-fg) 6%, transparent);
}

.bulk-count {
  font-size: 12px;
  font-weight: 600;
  color: var(--ui-text-primary-fg);
}

.bulk-spacer {
  flex: 1;
}

.status-text {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* ---- 拖放遮罩 ---- */
/*
 * 它只活在一次拖放期间,盖住整格 pane(页签条在这一格之外,天然不受影响)。
 *
 * `backdrop-filter` 在 ui-system 里被登记为**浮层专属**,且"勿过渡" —— 这一枚
 * 是拖放期间的临时覆盖层,不是常驻区域面,而且它**不参与任何 transition**
 * (出现/消失走 v-if,不是淡入),所以那条禁令针对的开销与抖动都不成立。
 */
.drop-overlay {
  position: absolute;
  inset: 0;
  z-index: 5;
  display: flex;
  align-items: center;
  justify-content: center;
  background: color-mix(in oklab, var(--ui-accent-primary-fg) 9%, transparent);
  backdrop-filter: blur(3px);
  /* 自己吃掉指针事件的话,dragover 就再也到不了下面的落区,拖进来立刻卡住。 */
  pointer-events: none;
}

.drop-frame {
  position: absolute;
  inset: 10px;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
  border: 2px dashed var(--ui-accent-primary-fg);
  border-radius: 10px;
  text-align: center;
}

.drop-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 44px;
  height: 44px;
  border-radius: var(--radius-full);
  border: 1px solid var(--ui-accent-primary-fg);
  color: var(--ui-accent-primary-fg);
}

.drop-title {
  font-family: var(--font-display, var(--font-serif, serif));
  font-size: 16px;
  font-weight: 600;
  color: var(--ui-text-primary-fg);
}

.drop-meta {
  font-family: var(--font-mono, monospace);
  font-size: 11px;
  color: var(--ui-text-muted-fg);
  font-variant-numeric: tabular-nums;
}

.drop-chip {
  padding: 3px 9px;
  border: 1px solid var(--ui-border-default-border);
  border-radius: var(--radius-full);
  font-size: 11px;
  color: var(--ui-text-secondary-fg);
}

/* 隐藏的文件输入:web 端「选择文件」的落点。`display:none` 在部分浏览器里会让
   程序化 `.click()` 失效,所以是移出视口而不是移出渲染树。 */
.visually-hidden-input {
  position: absolute;
  width: 1px;
  height: 1px;
  opacity: 0;
  pointer-events: none;
  left: -9999px;
}

/* ---- 详情:同层推入 ---- */
.detail-view {
  position: absolute;
  inset: 0;
  z-index: 4;
  display: flex;
  flex-direction: column;
  background: var(--media-pane-bg);
  overflow: hidden;
}

.detail-header {
  flex: none;
  display: flex;
  align-items: center;
  gap: 10px;
  height: 44px;
  padding: 0 12px;
  border-bottom: 1px solid var(--ui-border-subtle-border);
}

.detail-back {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  flex: none;
  border-radius: var(--radius-sm);
  color: var(--ui-text-muted-fg);
}

.detail-back:hover {
  color: var(--ui-text-primary-fg);
  background: var(--ui-state-hover-bg);
}

.detail-title {
  flex: 1;
  min-width: 0;
  font-family: var(--font-display, var(--font-serif, serif));
  font-size: 15px;
  font-weight: var(--font-weight-semibold, 600);
  color: var(--ui-text-primary-fg);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.detail-index {
  flex: none;
  font-family: var(--font-mono, monospace);
  font-size: 11px;
  color: var(--ui-text-faint-fg);
  font-variant-numeric: tabular-nums;
}

.detail-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 14px;
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.detail-preview {
  width: 100%;
  max-height: 320px;
  object-fit: contain;
  border-radius: var(--radius-sm);
  cursor: zoom-in;
}

.detail-preview-fallback {
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 32px 0;
  border-radius: var(--radius-sm);
  background: var(--ui-surface-input-bg);
  color: var(--ui-text-faint-fg);
}

.spec-list {
  min-width: 0;
}

.spec-row {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
  padding: 7px 0;
  border-top: 1px solid var(--ui-border-subtle-border);
}

.spec-label {
  flex: none;
  font-size: 12px;
  color: var(--ui-text-muted-fg);
  white-space: nowrap;
}

.spec-val {
  min-width: 0;
  font-family: var(--font-mono, monospace);
  font-size: 11px;
  color: var(--ui-text-primary-fg);
  text-align: right;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.detail-section {
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-width: 0;
}

.section-title-with-action {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 10px;
}

.section-heading {
  margin: 0;
  font-size: 11px;
  font-weight: var(--font-weight-semibold, 600);
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--ui-text-primary-fg);
}

/* 引用块:一根左墨线托住文字,不填底。 */
.prompt-excerpt {
  margin: 0;
  padding: 2px 0 2px 10px;
  border-left: 1px solid var(--ui-border-default-border);
  font-family: var(--font-mono, monospace);
  font-size: 11px;
  line-height: 1.65;
  color: var(--ui-text-muted-fg);
  white-space: pre-wrap;
  word-break: break-word;
  max-height: 150px;
  overflow-y: auto;
}

.detail-footer {
  flex: none;
  display: flex;
  align-items: baseline;
  flex-wrap: wrap;
  gap: 16px;
  padding: 11px 14px 13px;
  border-top: 1px solid var(--ui-border-subtle-border);
}

.detail-footer .detail-delete {
  margin-left: auto;
}

/* 推入动画 */
.detail-enter-active,
.detail-leave-active {
  transition: transform var(--duration-slow) var(--ease-out);
}

.detail-enter-from,
.detail-leave-to {
  transform: translateX(100%);
}

@media (prefers-reduced-motion: reduce) {
  .detail-enter-active,
  .detail-leave-active {
    transition: none;
  }
}
</style>
