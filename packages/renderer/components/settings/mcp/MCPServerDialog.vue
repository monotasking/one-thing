<template>
  <Dialog
    :open="show"
    variant="paper"
    dividers="header"
    :width="480"
    :title="editingServer ? 'Edit Server' : 'Add MCP Server'"
    @update:open="value => { if (!value) $emit('close') }"
  >
    <template #header-extra>
      <button
        type="button"
        class="close-btn"
        @click="$emit('close')"
      >
        <svg
          width="18"
          height="18"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
        >
          <path d="M18 6L6 18M6 6l12 12" />
        </svg>
      </button>
    </template>

    <div class="dialog-content">
      <div class="form-group">
        <label class="form-label">Server Name</label>
        <Input
          v-model="form.name"
          variant="underline"
          placeholder="My MCP Server"
        />
      </div>

      <div class="form-group">
        <label class="form-label">Transport Type</label>
        <div class="transport-selector">
          <Button
            unstyled
            :class="['transport-option', { active: form.transport === 'stdio' }]"
            @click="form.transport = 'stdio'"
          >
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
            >
              <rect
                x="4"
                y="4"
                width="16"
                height="16"
                rx="2"
                ry="2"
              />
              <rect
                x="9"
                y="9"
                width="6"
                height="6"
              />
              <line
                x1="9"
                y1="1"
                x2="9"
                y2="4"
              />
              <line
                x1="15"
                y1="1"
                x2="15"
                y2="4"
              />
              <line
                x1="9"
                y1="20"
                x2="9"
                y2="23"
              />
              <line
                x1="15"
                y1="20"
                x2="15"
                y2="23"
              />
            </svg>
            <span>Stdio</span>
            <span class="transport-desc">Local process</span>
          </Button>
          <Button
            unstyled
            :class="['transport-option', { active: form.transport === 'http' }]"
            @click="form.transport = 'http'"
          >
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
            >
              <circle
                cx="12"
                cy="12"
                r="10"
              />
              <line
                x1="2"
                y1="12"
                x2="22"
                y2="12"
              />
              <path d="M12 2a15.3 15.3 0 014 10 15.3 15.3 0 01-4 10 15.3 15.3 0 01-4-10 15.3 15.3 0 014-10z" />
            </svg>
            <span>HTTP</span>
            <span class="transport-desc">Remote server</span>
          </Button>
          <Button
            unstyled
            :class="['transport-option', { active: form.transport === 'sse' }]"
            @click="form.transport = 'sse'"
          >
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
            >
              <circle
                cx="12"
                cy="12"
                r="10"
              />
              <line
                x1="2"
                y1="12"
                x2="22"
                y2="12"
              />
              <path d="M12 2a15.3 15.3 0 014 10 15.3 15.3 0 01-4 10 15.3 15.3 0 01-4-10 15.3 15.3 0 014-10z" />
            </svg>
            <span>SSE</span>
            <span class="transport-desc">Legacy (deprecated)</span>
          </Button>
        </div>
      </div>

      <!--
        三个 transport 的字段区叠在同一 grid 格子里:高度恒等于较高的一档,
        切换时对话框不再跳高(实测 504↔355 的 149px 跳动);隐藏侧只隐形不
        卸载,顺带保住来回切换时已填的值。visibility:hidden 会把隐藏侧从
        焦点链与可访问性树里摘掉,不需要再管 tabindex。
        http 与 sse 共用同一份 URL 字段区。
      -->
      <div class="transport-fields">
        <!-- Stdio Configuration -->
        <div
          class="transport-pane"
          :class="{ 'is-hidden': form.transport !== 'stdio' }"
        >
          <div class="form-group">
            <label class="form-label">Command</label>
            <Input
              v-model="form.command"
              variant="underline"
              placeholder="npx, python, node..."
            />
          </div>
          <div class="form-group">
            <label class="form-label">Arguments</label>
            <Input
              v-model="form.argsString"
              variant="underline"
              placeholder="-y @modelcontextprotocol/server-everything"
            />
            <p class="form-hint">
              Space-separated arguments
            </p>
          </div>
          <div class="form-group">
            <label class="form-label">Working Directory (optional)</label>
            <Input
              v-model="form.cwd"
              variant="underline"
              placeholder="/path/to/working/dir"
            />
          </div>
        </div>

        <!-- Remote configuration (Streamable HTTP / legacy SSE share the URL field) -->
        <div
          class="transport-pane"
          :class="{ 'is-hidden': form.transport === 'stdio' }"
        >
          <div class="form-group">
            <label class="form-label">Server URL</label>
            <Input
              v-model="form.url"
              variant="underline"
              :placeholder="form.transport === 'http' ? 'https://example.com/mcp' : 'http://localhost:3000/sse'"
            />
          </div>
        </div>
      </div>

      <ErrorNote
        v-if="error"
        class="error-message"
        :message="error"
      />

      <!-- P2-2 preflight probe result -->
      <div
        v-if="probeResult"
        class="probe-result"
        :class="{ 'is-ok': probeResult.ok }"
      >
        <template v-if="probeResult.ok">
          {{ probeResult.serverName ?? 'Server' }}{{ probeResult.serverVersion ? `@${probeResult.serverVersion}` : '' }}
          · protocol {{ probeResult.protocolVersion ?? 'unknown' }}<span
            v-if="probeResult.capabilities?.length"
          > · {{ probeResult.capabilities.join(', ') }}</span>
        </template>
        <template v-else-if="probeResult.requiredProtocol">
          This server requires protocol {{ probeResult.requiredProtocol }}.
        </template>
        <template v-else-if="probeResult.authRequired">
          Reachable — this server requires OAuth login (connect after adding to start authorization).
        </template>
        <template v-else>
          {{ probeResult.error || 'Probe failed' }}
        </template>
      </div>
    </div>

    <template #actions>
      <button
        type="button"
        class="app-dialog-text-btn"
        :disabled="isProbing"
        @click="handleProbe"
      >
        {{ isProbing ? 'Probing...' : 'Test' }}
      </button>
      <button
        type="button"
        class="app-dialog-text-btn"
        @click="$emit('close')"
      >
        Cancel
      </button>
      <button
        type="button"
        class="app-dialog-text-btn is-primary"
        :disabled="isSaving"
        @click="handleSave"
      >
        {{ isSaving ? 'Saving...' : (editingServer ? 'Save Changes' : 'Add Server') }}
      </button>
    </template>
  </Dialog>
</template>

<script setup lang="ts">
import Button from '@/components/common/Button.vue'
import Dialog from '@/components/common/Dialog.vue'
import ErrorNote from '@/components/common/ErrorNote.vue'
import Input from '@/components/common/Input.vue'
import { mcpApi } from '@/platform/mcp-client'
import { ref, watch } from 'vue'
import type { MCPServerConfig, MCPProbeServerResponse } from '@/types'
import type { ServerForm } from './useMCPServers'

interface Props {
  show: boolean
  editingServer: MCPServerConfig | null
}

interface Emits {
  (e: 'close'): void
  (e: 'save', form: ServerForm): void
}

const props = defineProps<Props>()
const emit = defineEmits<Emits>()

const error = ref('')
const isSaving = ref(false)
const isProbing = ref(false)
const probeResult = ref<MCPProbeServerResponse | null>(null)

const form = ref<ServerForm>({
  name: '',
  transport: 'stdio',
  command: '',
  argsString: '',
  cwd: '',
  url: '',
})

// Reset form when dialog opens/closes or editing server changes
watch(
  () => [props.show, props.editingServer],
  () => {
    if (props.show) {
      error.value = ''
      probeResult.value = null
      if (props.editingServer) {
        form.value = {
          name: props.editingServer.name,
          transport: props.editingServer.transport,
          command: props.editingServer.command || '',
          argsString: (props.editingServer.args || []).join(' '),
          cwd: props.editingServer.cwd || '',
          url: props.editingServer.url || '',
        }
      } else {
        form.value = {
          name: '',
          transport: 'stdio',
          command: '',
          argsString: '',
          cwd: '',
          url: '',
        }
      }
    }
  },
  { immediate: true }
)

function handleSave() {
  // Basic validation
  if (!form.value.name.trim()) {
    error.value = 'Server name is required'
    return
  }

  if (form.value.transport === 'stdio') {
    if (!form.value.command.trim()) {
      error.value = 'Command is required'
      return
    }
  } else {
    if (!form.value.url.trim()) {
      error.value = 'Server URL is required'
      return
    }
  }

  error.value = ''
  emit('save', { ...form.value })
}

/**
 * P2-2 preflight: dry-run the current form against the real server and show
 * protocol/identity/capabilities (or a readable failure) BEFORE adding.
 */
async function handleProbe() {
  if (form.value.transport === 'stdio' && !form.value.command.trim()) {
    error.value = 'Command is required'
    return
  }
  if (form.value.transport !== 'stdio' && !form.value.url.trim()) {
    error.value = 'Server URL is required'
    return
  }

  error.value = ''
  probeResult.value = null
  isProbing.value = true
  try {
    const config: MCPServerConfig = {
      id: `probe-${Date.now()}`,
      name: form.value.name.trim() || 'probe',
      transport: form.value.transport,
      enabled: true,
    }
    if (form.value.transport === 'stdio') {
      config.command = form.value.command.trim()
      config.args = form.value.argsString.trim().split(/\s+/).filter(Boolean)
      if (form.value.cwd.trim()) config.cwd = form.value.cwd.trim()
    } else {
      config.url = form.value.url.trim()
    }
    probeResult.value = await mcpApi.probeServer({ config })
  } catch (probeError) {
    probeResult.value = { ok: false, error: String(probeError) }
  } finally {
    isProbing.value = false
  }
}

// Expose for parent to set error and loading state
defineExpose({
  setError: (msg: string) => { error.value = msg },
  setLoading: (loading: boolean) => { isSaving.value = loading },
})
</script>

<style scoped>
/*
 * Paper dialog in the ledger language: hairline borders, hard ink shadow,
 * underline inputs, text-button footer. The shell (overlay, panel, header
 * rule, section paddings) is `Dialog variant="paper"` since P2 — what remains
 * here is only the form's own content.
 */
.close-btn {
  border: none;
  background: transparent;
  padding: 2px;
  color: var(--ui-text-muted-fg);
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: color var(--duration-fast) var(--ease-default);
}

.close-btn:hover {
  color: var(--ui-text-primary-fg);
}


.form-group {
  margin-bottom: 16px;
}

/* Explicit last-child reset. Without it the scoped `.form-group` ties with the
   global `.form-group:last-child { margin-bottom: 0 }` at (0,2,0) and the
   trailing gap depends on stylesheet order. */
.form-group:last-child {
  margin-bottom: 0;
}

.form-label {
  display: block;
  font-size: 11px;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--ui-text-muted-fg);
  margin-bottom: 5px;
}

.form-hint {
  font-size: 11px;
  color: var(--ui-text-faint-fg, var(--ui-text-muted-fg));
  margin-top: 5px;
}

/* Underline inputs: the line is the control, drawn by `<Input variant="underline">`. */

.transport-selector {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 10px;
}

/* 两个 transport 字段区同格叠放:高度取两者较高者,切换零跳动 */
.transport-fields {
  display: grid;
}

.transport-pane {
  grid-area: 1 / 1;
  min-width: 0;
}

.transport-pane.is-hidden {
  visibility: hidden;
  pointer-events: none;
}

/* Transport choice: square outline, accent line marks the selection */
.transport-option {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 5px;
  padding: 12px;
  min-width: 0;
  border: 1px solid var(--ui-border-default-border);
  background: transparent;
  color: var(--ui-text-muted-fg);
  cursor: pointer;
  transition: border-color var(--duration-fast) var(--ease-default), color var(--duration-fast) var(--ease-default);
}

.transport-option:hover {
  border-color: var(--ui-border-strong-border);
  color: var(--ui-text-primary-fg);
}

.transport-option.active {
  border-color: var(--ui-accent-primary-fg);
  color: var(--ui-accent-primary-fg);
}

.transport-option span {
  font-size: 13px;
  font-weight: var(--font-weight-medium, 500);
  color: var(--ui-text-primary-fg);
}

.transport-option.active span {
  color: var(--ui-accent-primary-fg);
}

.transport-desc {
  font-family: var(--font-mono, monospace);
  font-size: 10px !important;
  font-weight: 400 !important;
  color: var(--ui-text-faint-fg, var(--ui-text-muted-fg)) !important;
}

/* positioning only — visuals come from ErrorNote */
.error-message {
  margin-top: 16px;
}

.probe-result {
  margin: 10px 24px 0;
  padding: 8px 0;
  font-family: var(--font-mono, monospace);
  font-size: 12px;
  line-height: 1.5;
  color: var(--ui-status-error-fg, var(--ui-text-muted-fg));
  border-top: 1px dashed var(--ui-border-muted, currentColor);
}

.probe-result.is-ok {
  color: var(--ui-status-success-fg, var(--ui-text-fg));
}

.app-dialog-text-btn:disabled {
  opacity: 0.5;
  cursor: default;
}

/* Footer buttons are `.app-dialog-text-btn` (published by Dialog.vue's
   non-scoped block). They used to be a scoped `.btn` here, which tied with the
   global `.btn.primary` / `.btn.secondary` at (0,2,0) and was decided by
   stylesheet order — P2 reshuffled that order and the tie flipped to a solid
   accent block with accent text on it. */
</style>
