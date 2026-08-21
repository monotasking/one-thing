<template>
  <div class="editor-scroll">
    <div class="editor-body agent-files">
      <section class="agent-field files-column">
        <div class="prompt-header">
          <span class="field-label">私聊文件</span>
          <span
            v-if="roomFiles.length > 0"
            class="prompt-counter"
          >{{ roomFiles.length }}</span>
        </div>

        <p
          v-if="filesLoading"
          class="field-hint"
        >
          读取中…
        </p>
        <p
          v-else-if="filesError"
          class="field-hint"
        >
          {{ filesError }}
        </p>
        <p
          v-else-if="roomFiles.length === 0"
          class="field-hint"
        >
          {{ roomFilesEmptyHint }}
        </p>
        <ol
          v-else
          class="history-rows"
        >
          <li
            v-for="file in roomFiles"
            :key="file.path"
          >
            <button
              class="history-line"
              type="button"
              @click="emit('open-file', file.path)"
            >
              <span class="history-name">{{ file.relativePath }}</span>
              <span
                v-if="file.mtimeMs > 0"
                class="history-meta"
              >{{ formatUpdated(file.mtimeMs) }}</span>
              <span class="history-meta history-count">{{ formatFileSize(file.size) }}</span>
            </button>
          </li>
        </ol>
        <p
          v-if="filesTruncated"
          class="field-hint"
        >
          文件太多,只列了最近改动的 {{ roomFiles.length }} 个。
        </p>
      </section>

      <!-- 交付物按卡分组。路径是卡记下来的(相对该群 folder),群没有工作
           目录时还原不出绝对路径 —— 那一行就不给点,而不是点了打不开。 -->
      <section class="agent-field files-column">
        <div class="prompt-header">
          <span class="field-label">交付物</span>
          <span
            v-if="evidenceGroups.length > 0"
            class="prompt-counter"
          >{{ evidenceGroups.length }}</span>
        </div>

        <p
          v-if="evidenceGroups.length === 0"
          class="field-hint"
        >
          卡上还没有记下交付物。
        </p>
        <div
          v-for="group in evidenceGroups"
          :key="group.taskId"
          class="history-group"
        >
          <span class="history-group-title">{{ group.title }}</span>
          <ol class="history-rows">
            <li
              v-for="file in group.files"
              :key="file.label"
            >
              <button
                v-if="file.path"
                class="history-line"
                type="button"
                @click="emit('open-file', file.path)"
              >
                <span class="history-name">{{ file.label }}</span>
              </button>
              <span
                v-else
                class="history-line is-inert"
              >
                <span class="history-name">{{ file.label }}</span>
              </span>
            </li>
          </ol>
        </div>
      </section>
    </div>
  </div>
</template>

<script setup lang="ts">
/**
 * 「文件」面(agent-im-chat-ui.md §3.2)。两组:私聊房 folder 里的东西(主进程
 * 列目录,folder 的位置只有它算得出),以及卡上按代码统计出来的交付物(看板既有
 * 数据,不新增账)。列表不是文件管理器:只读,点开交给宿主(`open-file`)。
 */
import { computed, ref, toRef, watch } from 'vue'
import { collabApi } from '@/platform/collab-client'
import type { CollabRoomFolderEntry } from '@shared/ipc'
import { useSessionsStore } from '@/stores/sessions'
import { useCollabBoardStore } from '@/stores/collabBoard'
import { resolveDeliverablePath } from '@/components/workbench/collab-board-card'
import { useAgentHistory, formatUpdated } from './use-agent-history'
import '@/styles/agent-space.css'

const props = defineProps<{ agentId: string }>()

const emit = defineEmits<{
  'open-file': [filePath: string]
}>()

const sessionsStore = useSessionsStore()
const { history, ensureBoardData, dmRoomSessionId } = useAgentHistory(toRef(props, 'agentId'))

const roomFiles = ref<CollabRoomFolderEntry[]>([])
const filesLoading = ref(false)
const filesError = ref('')
const filesTruncated = ref(false)
/** 目录还没建过(这个人还没往私聊房里放过东西)—— 不是错误,是另一句空态。 */
const filesMissing = ref(false)

const roomFilesEmptyHint = computed(() => {
  if (!dmRoomSessionId.value) return '还没有和 TA 的私聊房 —— 先发条消息。'
  return filesMissing.value ? '私聊房里还没有放过东西。' : '私聊房 folder 是空的。'
})

async function loadRoomFiles(): Promise<void> {
  const roomSessionId = dmRoomSessionId.value
  roomFiles.value = []
  filesTruncated.value = false
  filesMissing.value = false
  filesError.value = ''
  if (!roomSessionId) return
  filesLoading.value = true
  try {
    const response = await collabApi.roomFolderList({ roomSessionId })
    if (!response?.success) {
      filesError.value = response?.error || '读不到私聊房的文件'
      return
    }
    roomFiles.value = response.entries ?? []
    filesTruncated.value = !!response.truncated
    filesMissing.value = !!response.missing
  } catch (cause) {
    filesError.value = cause instanceof Error ? cause.message : String(cause)
  } finally {
    filesLoading.value = false
  }
}

/* 列目录是 IO:挂载与换人各拉一次,不跟着别的面走。 */
watch(dmRoomSessionId, () => { void loadRoomFiles() }, { immediate: true })
watch(() => props.agentId, ensureBoardData, { immediate: true })

interface AgentEvidenceGroup {
  taskId: string
  title: string
  files: Array<{ label: string; path: string }>
}

const evidenceGroups = computed<AgentEvidenceGroup[]>(() => {
  const groups: AgentEvidenceGroup[] = []
  for (const group of history.value.work) {
    if (!group.taskId) continue
    let found: { roomSessionId: string; task: { report?: { evidence?: { files?: string[] } } } } | undefined
    try {
      found = useCollabBoardStore().findTask(group.taskId)
    } catch {
      // 没挂 pinia(面板单测):这一组就没有交付物,其余照常。
      found = undefined
    }
    const files = found?.task?.report?.evidence?.files ?? []
    if (files.length === 0) continue
    const roomFolder = sessionsStore.sessions
      .find(session => session.id === found?.roomSessionId)?.workingDirectory || ''
    groups.push({
      taskId: group.taskId,
      title: group.title,
      files: files.map(file => ({
        label: file,
        // 还原用看板卡那一份(单点):相对路径的基准是同一个 roomFolder。
        path: resolveDeliverablePath(file, roomFolder),
      })),
    })
  }
  return groups
})

function formatFileSize(bytes: number): string {
  if (!bytes) return '0 B'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}
</script>
