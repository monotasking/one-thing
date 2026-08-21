import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import type {
  PracticeConfig,
  PracticeEventPayload,
  PracticeLedgerRecord,
  PracticeSnapshot,
} from '@/types'
import { platformApi } from '@/platform'
import { practiceApi } from '@/platform/practice-client'
import { playPracticeCue } from '@/services/practice-sound'

/**
 * Renderer view of the main-process practice engine. The engine's state lives
 * in main (surviving renderer reloads); this store subscribes to PRACTICE_EVENT
 * pushes and re-pulls a snapshot on init.
 */
export const usePracticeStore = defineStore('practice', () => {
  const snapshot = ref<PracticeSnapshot>({ status: 'idle' })
  const config = ref<PracticeConfig | null>(null)
  const lastSettled = ref<PracticeLedgerRecord | null>(null)
  let unsubscribe: (() => void) | null = null
  /** Kind of the session a trailing 'finished' edge belongs to (snapshot is already idle then). */
  let lastRunningKind: 'kegel' | 'pomodoro' | null = null

  const isRunning = computed(() => snapshot.value.status !== 'idle')
  const soundEnabled = computed(() => config.value?.kegel.sound ?? true)

  function cueFor(payload: PracticeEventPayload): void {
    if (!soundEnabled.value) return
    const kind = payload.snapshot.kind ?? lastRunningKind
    for (const edge of payload.edges) {
      // Kegel cues carry the rhythm; pomodoro only marks its end.
      if (kind === 'kegel' || edge === 'finished') playPracticeCue(edge)
    }
  }

  function handleEvent(payload: PracticeEventPayload): void {
    cueFor(payload)
    snapshot.value = payload.snapshot
    if (payload.snapshot.kind === 'kegel' || payload.snapshot.kind === 'pomodoro') {
      lastRunningKind = payload.snapshot.kind
    }
    if (payload.settled) lastSettled.value = payload.settled
  }

  async function init(): Promise<void> {
    if (unsubscribe) return
    unsubscribe = platformApi.onPracticeEvent(handleEvent)
    try {
      const [state, cfg] = await Promise.all([
        practiceApi.getState({}),
        practiceApi.getConfig({}),
      ])
      snapshot.value = state.snapshot
      config.value = cfg.config
    } catch {
      // Web build / early startup: stay idle with defaults.
    }
  }

  async function startKegel(): Promise<void> {
    const { snapshot: next } = await practiceApi.start({ kind: 'kegel' })
    snapshot.value = next
    lastRunningKind = 'kegel'
  }

  async function startPomodoro(category: string, label?: string): Promise<void> {
    const { snapshot: next } = await practiceApi.start({ kind: 'pomodoro', category, label })
    snapshot.value = next
    lastRunningKind = 'pomodoro'
  }

  async function pause(): Promise<void> {
    snapshot.value = (await practiceApi.pause({})).snapshot
  }

  async function resume(): Promise<void> {
    snapshot.value = (await practiceApi.resume({})).snapshot
  }

  async function stop(): Promise<void> {
    snapshot.value = (await practiceApi.stop({})).snapshot
  }

  /** Aborts the session without settling a ledger record. */
  async function cancel(): Promise<void> {
    snapshot.value = (await practiceApi.stop({ discard: true })).snapshot
  }

  async function saveConfig(partial: {
    kegel?: Partial<PracticeConfig['kegel']>
    pomodoro?: Partial<PracticeConfig['pomodoro']>
  }): Promise<void> {
    const { config: next } = await practiceApi.setConfig({ config: partial })
    config.value = next
  }

  async function logExercise(input: {
    name: string
    sets?: number
    repsPerSet?: number
    durationMin?: number
    note?: string
  }): Promise<PracticeLedgerRecord> {
    const { record } = await practiceApi.log({
      name: input.name,
      source: 'manual',
      note: input.note,
      exercise: { sets: input.sets, repsPerSet: input.repsPerSet, durationMin: input.durationMin },
    })
    lastSettled.value = record
    return record
  }

  return {
    snapshot,
    config,
    lastSettled,
    isRunning,
    soundEnabled,
    init,
    startKegel,
    startPomodoro,
    pause,
    resume,
    stop,
    cancel,
    saveConfig,
    logExercise,
  }
})
