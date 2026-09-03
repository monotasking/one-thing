<template>
  <div
    ref="containerRef"
    class="terminal-view"
  >
    <div
      v-if="descriptor?.exited"
      class="terminal-exited-bar"
    >
      <span class="terminal-exited-text">
        进程已退出{{ descriptor.exited.code !== null ? `（code ${descriptor.exited.code}）` : '' }}
      </span>
      <Button
        unstyled
        class="terminal-restart"
        @click="handleRestart"
      >
        重启
      </Button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import Button from '@/components/common/Button.vue'
import { shellResizing } from '@/composables/useShellLayout'
import { useTerminalsStore } from '@/stores/terminals'
import {
  detachView,
  ensureAttached,
  fitTerminal,
  focusTerminal,
} from '@/services/terminal-registry'

const props = defineProps<{
  terminalId: string
}>()

const emit = defineEmits<{
  /** The user restarted an exited terminal: the owner must swap its id. */
  restarted: [newTerminalId: string]
}>()

const containerRef = ref<HTMLDivElement | null>(null)
const terminalsStore = useTerminalsStore()
const descriptor = computed(() =>
  terminalsStore.terminals.find(t => t.id === props.terminalId),
)

let observer: ResizeObserver | null = null
let fitFrame = 0
let fitDeferredByResize = false

/* 拖外壳分隔条期间不 refit:xterm 的 fit 会整本重排 scrollback 并把新列数
   同步给 PTY(SIGWINCH → shell 重绘回流),逐帧做就是拖拽掉帧的大头。拖拽中
   内容保持旧排版被面板边缘裁切,松手补一次(shellResizing watch)。 */
function scheduleFit(): void {
  if (shellResizing.value) {
    fitDeferredByResize = true
    return
  }
  if (fitFrame) return
  fitFrame = requestAnimationFrame(() => {
    fitFrame = 0
    fitTerminal(props.terminalId)
  })
}

watch(shellResizing, resizing => {
  if (!resizing && fitDeferredByResize) {
    fitDeferredByResize = false
    scheduleFit()
  }
})

async function mountTerminal(terminalId: string): Promise<void> {
  const container = containerRef.value
  if (!container) return
  await ensureAttached(terminalId, container)
  scheduleFit()
}

onMounted(async () => {
  await terminalsStore.ensureLoaded()
  await mountTerminal(props.terminalId)
  const container = containerRef.value
  if (container && typeof ResizeObserver !== 'undefined') {
    // TabPane v-show flips and Splitter drags never dispatch element resize
    // events — observing our own box is the only reliable refit signal.
    observer = new ResizeObserver(() => scheduleFit())
    observer.observe(container)
  }
  focusTerminal(props.terminalId)
})

watch(
  () => props.terminalId,
  async (next, previous) => {
    if (next === previous) return
    if (previous) detachView(previous)
    await mountTerminal(next)
    focusTerminal(next)
  },
)

onBeforeUnmount(() => {
  observer?.disconnect()
  observer = null
  if (fitFrame) cancelAnimationFrame(fitFrame)
  // Keep the xterm instance alive — the host div just leaves this view.
  detachView(props.terminalId)
})

async function handleRestart(): Promise<void> {
  const newId = await terminalsStore.restartTerminal(props.terminalId)
  emit('restarted', newId)
}
</script>

<style scoped>
.terminal-view {
  position: relative;
  width: 100%;
  height: 100%;
  min-height: 0;
  overflow: hidden;
  /* Background stays with the host container (workbench corner-mark layer);
     xterm paints its own themed background inside. */
}

/* The registry's persistent host div is re-parented in at runtime. */
.terminal-view :deep(.onething-terminal) {
  width: 100%;
  height: 100%;
  padding: 4px 0 0 8px;
  box-sizing: border-box;
}

.terminal-exited-bar {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  z-index: 2;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 4px 10px;
  font-size: 12px;
  color: var(--ui-text-muted-fg);
  background: var(--ui-surface-elevated-bg);
  border-bottom: 1px solid var(--ui-border-default-border);
}

.terminal-restart {
  font-size: 12px;
  color: var(--ui-text-primary-fg);
  text-decoration: underline;
  text-underline-offset: 3px;
  cursor: pointer;
}
</style>
