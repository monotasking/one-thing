import { isSessionStreamTerminalEvent } from '@shared/events/session-events'
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import type { SessionEventEnvelope } from '@shared/events/index.js'
import type { VoiceEvent, VoiceLatencyMilestone, VoiceRuntimeState } from '@/types'
import { useSessionsStore } from './sessions'
import { platformApi } from '@/platform'
import { voiceApi } from '@/platform/voice-client'

import { SESSION_EVENT_TYPES } from '@shared/events/index.js'

interface VoiceTurn {
  sessionId: string
  assistantMessageId?: string
  active: boolean
}

let initialized = false

export const useVoiceStore = defineStore('voice', () => {
  const state = ref<VoiceRuntimeState>({
    status: 'disabled',
    enabled: false,
    runtimeReady: false,
    updatedAt: Date.now(),
  })
  const lastError = ref<string>('')
  const lastTranscript = ref<string>('')
  const lastMilestone = ref<VoiceLatencyMilestone | null>(null)
  const milestones = ref<VoiceLatencyMilestone[]>([])
  const activeTurn = ref<VoiceTurn | null>(null)

  const isEnabled = computed(() => state.value.enabled)
  const status = computed(() => state.value.status)
  const isRecording = computed(() => state.value.status === 'recording' || state.value.status === 'transcribing')
  const callActive = computed(() => Boolean(state.value.callActive))

  async function initialize() {
    if (initialized) return
    initialized = true

    try {
      const response = await voiceApi.getState()
      if (response.success && response.state) state.value = response.state
    } catch (error: any) {
      lastError.value = error.message || 'Failed to load voice state.'
    }

    platformApi.onVoiceEvent(handleVoiceEvent)
    platformApi.onSessionEvent(handleSessionEvent)
  }

  async function startListening(sessionId?: string) {
    const sessionsStore = useSessionsStore()
    const resolvedSessionId = sessionId || sessionsStore.currentSessionId
    if (!resolvedSessionId) {
      lastError.value = 'No active session for voice input.'
      return { success: false, error: lastError.value }
    }
    const response = await voiceApi.start({ sessionId: resolvedSessionId, reason: 'manual' })
    if (!response.success && response.error) lastError.value = response.error
    return response
  }

  async function stop(reason = 'user', submit = reason === 'mic-button') {
    return voiceApi.stop({ reason, submit })
  }

  async function startCall(sessionId?: string) {
    const sessionsStore = useSessionsStore()
    const resolvedSessionId = sessionId || sessionsStore.currentSessionId
    if (!resolvedSessionId) {
      lastError.value = 'No active session for a voice call.'
      return { success: false, error: lastError.value }
    }
    const response = await voiceApi.start({ sessionId: resolvedSessionId, reason: 'call' })
    if (!response.success && response.error) lastError.value = response.error
    return response
  }

  async function endCall() {
    return voiceApi.stop({ reason: 'call-end', submit: false })
  }

  function dismissError() {
    lastError.value = ''
    state.value = {
      ...state.value,
      status: state.value.enabled ? 'idle' : 'disabled',
      lastError: undefined,
      updatedAt: Date.now(),
    }
  }

  function handleVoiceEvent(event: VoiceEvent) {
    if (event.type === 'state') {
      state.value = event.state
      lastError.value = event.state.lastError || ''
      if (event.state.lastMilestone) rememberMilestone(event.state.lastMilestone)
      return
    }
    if (event.type === 'error') {
      lastError.value = event.error
      return
    }
    if (event.type === 'recording-started') {
      // Fresh turn: drop the previous turn's transcript from the overlay.
      lastTranscript.value = ''
      return
    }
    if (event.type === 'latency-milestone') {
      rememberMilestone(event.milestone)
      return
    }
    if (event.type === 'partial-transcript' || event.type === 'transcript' || event.type === 'submitted') {
      lastTranscript.value = event.text
      if (event.type === 'partial-transcript') return
      activeTurn.value = {
        sessionId: event.sessionId,
        active: true,
      }
    }
  }

  function handleSessionEvent(envelope: SessionEventEnvelope) {
    const turn = activeTurn.value
    if (!turn || envelope.sessionId !== turn.sessionId) return
    const event = envelope.event
    if (event.type === SESSION_EVENT_TYPES.MESSAGE_ASSISTANT_CREATED) {
      turn.assistantMessageId = event.message.id
      return
    }
    if (isSessionStreamTerminalEvent(event.type)) {
      turn.active = false
      activeTurn.value = null
    }
  }

  function rememberMilestone(milestone: VoiceLatencyMilestone) {
    const previous = lastMilestone.value
    lastMilestone.value = milestone
    if (
      previous
      && previous.name === milestone.name
      && previous.at === milestone.at
      && previous.requestId === milestone.requestId
      && previous.transcriptId === milestone.transcriptId
    ) {
      return
    }
    milestones.value = [...milestones.value, milestone].slice(-50)
  }

  return {
    state,
    status,
    isEnabled,
    isRecording,
    callActive,
    lastError,
    lastTranscript,
    lastMilestone,
    milestones,
    initialize,
    startListening,
    stop,
    startCall,
    endCall,
    dismissError,
  }
})
