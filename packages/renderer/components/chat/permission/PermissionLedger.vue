<template>
  <!-- Permission ledger: the request read as a key/value form in the
       composer's blueprint language — hairline rows, mono cells, zero
       fill. Scope is a column of the form, not a row of pill buttons,
       so a standing grant can never be a mis-click on "Allow". -->
  <div class="session-permission-panel">
    <div class="permission-row">
      <span class="permission-key">tool</span>
      <span class="permission-value">{{ permissionTool(toolCall) }}</span>
    </div>
    <div class="permission-row">
      <span class="permission-key">target</span>
      <span class="permission-value">{{ permissionTarget(toolCall) }}</span>
    </div>
    <div
      v-if="permissionPreview(toolCall)"
      class="permission-row"
    >
      <span class="permission-key">{{ permissionDetailKey(toolCall) }}</span>
      <span class="permission-value is-dim">{{ permissionPreview(toolCall) }}</span>
    </div>
    <div class="permission-row is-scope">
      <span class="permission-key">scope</span>
      <span class="permission-value">
        <Button
          v-for="option in scopeOptions"
          :key="option.value"
          unstyled
          class="permission-scope-btn"
          native-type="button"
          :aria-pressed="permissionScope === option.value"
          @click="permissionScope = option.value"
        >
          {{ option.label }}
        </Button>
      </span>
    </div>
    <div
      v-if="showRejectInstruction"
      class="permission-row is-instruction"
    >
      <span class="permission-key">reason</span>
      <textarea
        v-model="rejectInstruction"
        class="permission-instruction-input"
        placeholder="Tell the assistant what to do instead..."
        rows="2"
        @keydown.stop
      />
    </div>
    <div class="permission-foot">
      <span class="permission-hint">
        {{ queuedCount > 0
          ? `${queuedCount} queued behind this permission`
          : 'awaiting your decision' }}
      </span>
      <Button
        v-if="showRejectInstruction"
        unstyled
        class="permission-btn reject"
        native-type="button"
        @click="rejectWithInstruction"
      >
        SEND REJECTION
      </Button>
      <template v-else>
        <Button
          unstyled
          class="permission-btn reject"
          native-type="button"
          @click="emit('reject', toolCall)"
        >
          REJECT
        </Button>
        <Tooltip text="Reject and tell the assistant what to do instead">
          <Button
            unstyled
            class="permission-btn instruct"
            native-type="button"
            @click="showRejectInstruction = true"
          >
            REJECT…
          </Button>
        </Tooltip>
      </template>
      <Button
        unstyled
        class="permission-btn allow"
        native-type="button"
        :aria-label="`Allow (${permissionScopeLabel})`"
        @click="emit('allow', toolCall, permissionScope)"
      >
        ALLOW
      </Button>
    </div>
  </div>
</template>

<script setup lang="ts">
/**
 * 权限账页栏位 —— 中栏底部、composer 上方,按 toolCallId 应答。
 *
 * 去复用重构 R1(§8 铁律 1)把它从 `ChatPanel.vue` 抬成一个组件,**没有改动
 * 任何字段、任何像素、任何快捷键**:抬出来是为了让房面(`RoomSurface`)与旧壳
 * 共用同一个实现,而不是各自抄一份。位置与语义的"零变化"因此是结构保证,
 * 不是比对结论。
 *
 * 这一层只画与收集意图;真正的应答(sessionCommands.emit + 本地状态收尾)由
 * `usePermissionResponder` 统一执行 —— 两处也共用同一份。
 */
import { computed, ref, watch } from 'vue'
import Button from '@/components/common/Button.vue'
import Tooltip from '@/components/common/Tooltip.vue'
import type { ToolCall } from '@/types'
import {
  buildScopeOptions,
  permissionDetailKey,
  permissionPreview,
  permissionTarget,
  permissionTool,
  type PermissionResponse,
} from './permission-ledger'

const props = withDefaults(defineProps<{
  toolCall: ToolCall
  /** 排在这次审批后面的调用数(脚注那句话)。 */
  queuedCount?: number
  /** collab 会话(room/work):scope 只给 once。 */
  collabScopeOnly?: boolean
}>(), {
  queuedCount: 0,
  collabScopeOnly: false,
})

const emit = defineEmits<{
  allow: [toolCall: ToolCall, scope: PermissionResponse]
  reject: [toolCall: ToolCall]
  rejectWithInstruction: [toolCall: ToolCall, reason: string | undefined]
}>()

const showRejectInstruction = ref(false)
const rejectInstruction = ref('')
const permissionScope = ref<PermissionResponse>('once')

watch(() => props.toolCall?.id, () => {
  showRejectInstruction.value = false
  rejectInstruction.value = ''
  // Never carry a standing scope across requests — each grant is chosen fresh.
  permissionScope.value = 'once'
})

const scopeOptions = computed(() =>
  buildScopeOptions(props.toolCall, { collabScopeOnly: props.collabScopeOnly }),
)

const permissionScopeLabel = computed(() =>
  scopeOptions.value.find(option => option.value === permissionScope.value)?.label || 'once',
)

// A scope can disappear between requests (workspace is withheld for sensitive
// reads); fall back rather than approve with a scope the UI no longer offers.
watch(scopeOptions, options => {
  if (!options.some(option => option.value === permissionScope.value)) {
    permissionScope.value = 'once'
  }
})

function rejectWithInstruction() {
  emit('rejectWithInstruction', props.toolCall, rejectInstruction.value.trim() || undefined)
}
</script>

<style scoped>
/* Permission ledger — the composer's blueprint frame, one row per field:
   zero fill, one outline, hairline cell dividers, mono annotations. The
   only colour is carried by the two decisions themselves. */
/* G8 私有 token 岛判决:这四枚**保留**。前两枚是边框浓度(主题层的档位表只管
   "面"与"态",没有边框档 —— 波 1 判 Select 的 hover border 时立的规矩);后两枚是
   纯区域别名(照 sidebar 的 `--sidebar-row-*` 先例:别名给区域留改名点,零派生逻辑)。
   真正吃到主题层的是它们的**态**(见文件末两条 hover)。 */
.session-permission-panel {
  --permission-frame: color-mix(in srgb, var(--ui-border-strong-border) 52%, transparent);
  --permission-divider: color-mix(in srgb, var(--ui-border-strong-border) 30%, transparent);
  --permission-allow-fg: var(--ui-status-success-fg);
  --permission-reject-fg: var(--ui-status-warning-fg);

  width: var(--chat-composer-width);
  margin: 0 var(--chat-content-column-right, auto) 8px var(--chat-content-column-left, auto);
  display: flex;
  flex-direction: column;
  border: 1px solid var(--permission-frame);
  border-radius: var(--radius-xs, 4px);
  background: transparent;
  overflow: hidden;
}

.permission-row {
  display: grid;
  grid-template-columns: 76px minmax(0, 1fr);
  align-items: stretch;
  min-height: 30px;
  border-bottom: 1px solid var(--permission-divider);
}

.permission-key {
  display: flex;
  align-items: center;
  padding: 0 11px;
  border-right: 1px solid var(--permission-divider);
  font-family: var(--font-mono, monospace);
  font-size: 10.5px;
  font-weight: 600;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--ui-text-faint-fg, var(--ui-text-muted-fg));
}

.permission-value {
  display: flex;
  align-items: center;
  min-width: 0;
  padding: 0 11px;
  font-family: var(--font-mono, monospace);
  font-size: 11.5px;
  color: var(--ui-text-primary-fg);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.permission-value.is-dim {
  color: var(--ui-text-muted-fg);
}

.permission-row.is-scope .permission-value {
  padding: 0;
}

.permission-scope-btn {
  min-height: 30px;
  padding: 0 12px;
  border: 0;
  border-right: 1px solid var(--permission-divider);
  background: transparent;
  cursor: pointer;
  font-family: var(--font-mono, monospace);
  font-size: 11.5px;
  font-weight: 600;
  color: var(--ui-text-muted-fg);
  transition: color var(--duration-normal) var(--ease-default), background var(--duration-normal) var(--ease-default);
}

.permission-scope-btn:hover {
  background: var(--ui-state-hover-bg);
  color: var(--ui-text-primary-fg);
}

.permission-scope-btn[aria-pressed='true'] {
  color: var(--permission-allow-fg);
  background: color-mix(in srgb, var(--permission-allow-fg) 10%, transparent);
}

.permission-row.is-instruction {
  align-items: start;
}

.permission-row.is-instruction .permission-key {
  align-items: flex-start;
  padding-top: 9px;
}

.permission-instruction-input {
  min-width: 0;
  min-height: 48px;
  resize: vertical;
  padding: 8px 11px;
  border: 0;
  background: transparent;
  color: var(--ui-text-primary-fg);
  font-family: var(--font-mono, monospace);
  font-size: 11.5px;
  line-height: 1.5;
}

textarea.permission-instruction-input:focus {
  outline: none;
  background: var(--ui-state-hover-bg);
}

.permission-foot {
  display: flex;
  align-items: stretch;
  min-height: 32px;
}

.permission-hint {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  padding: 0 11px;
  font-family: var(--font-mono, monospace);
  font-size: 10.5px;
  color: var(--ui-text-faint-fg, var(--ui-text-muted-fg));
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.permission-btn {
  flex-shrink: 0;
  min-height: 32px;
  padding: 0 14px;
  border: 0;
  border-left: 1px solid var(--permission-divider);
  border-radius: 0;
  background: transparent;
  cursor: pointer;
  font-family: var(--font-mono, monospace);
  font-size: 11.5px;
  font-weight: 600;
  letter-spacing: 0.03em;
  color: var(--ui-text-muted-fg);
  transition: background var(--duration-normal) var(--ease-default);
}

.permission-btn.allow {
  color: var(--permission-allow-fg);
}

.permission-btn.reject,
.permission-btn.instruct {
  color: var(--permission-reject-fg);
}

/* 两条 hover 底走主题层的状态面 token(G8):`--ui-status-*-bg` 的配方就是
   "同色 fg 压 10% 透明",与这里原来手写的 12% 是**同一条配方**,只差两个百分点。
   18 主题 × 明暗双向实跑:手写 vs token Δ中位 7.2(允许)/ 7.7(警示),迁移后
   离消息面 Δ中位 21.3 / 25.5(最小 15.5 / 17.5,远在门槛之上,不会把 hover 迁没)。
   换来的是"状态色浓度全窗一个出处"。字色仍走 `--permission-*-fg` 区域别名,
   两个通道各自独立。 */
.permission-btn.allow:hover {
  background: var(--ui-status-success-bg);
}

.permission-btn.reject:hover,
.permission-btn.instruct:hover {
  background: var(--ui-status-warning-bg);
}
</style>
