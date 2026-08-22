<template>
  <div class="tab-content">
    <SettingsSection
      title="Voice Input"
      description="Use speech in chat without setting up a separate voice stack."
    >
      <SettingsGroup>
        <div class="voice-setup-summary">
          <div class="voice-setup-copy">
            <span
              class="voice-state-pill"
              :class="{ on: voice.enabled }"
            >
              {{ voice.enabled ? 'Voice on' : 'Voice off' }}
            </span>
            <h4>Current voice setup</h4>
            <p>{{ voiceSetupSummary }}</p>
          </div>
          <div class="voice-setup-grid">
            <div class="voice-setup-item">
              <span>Speech to text</span>
              <strong>{{ asrProviderLabel }}</strong>
              <small :class="{ warning: Boolean(asrSetupIssue) }">
                {{ asrSetupIssue || asrSetupStatus }}
              </small>
            </div>
            <div class="voice-setup-item">
              <span>Voice replies</span>
              <strong>{{ effectiveTTSProviderLabel }}</strong>
              <small :class="{ warning: Boolean(ttsSetupIssue) }">
                {{ ttsSetupIssue || ttsSetupStatus }}
              </small>
            </div>
          </div>
        </div>

        <SettingRow
          label="Turn on voice"
          description="Use the microphone while onething is running."
        >
          <Switch
            variant="ledger"
            :model-value="voice.enabled"
            aria-label="Turn on voice"
            @update:model-value="updateVoice({ enabled: Boolean($event) })"
          />
        </SettingRow>

        <SettingRow
          layout="stack"
          label="Conversation"
          description="The mic button starts a voice turn: listen, transcribe, send to the selected agent, then speak the assistant reply when voice replies are on."
        >
          <div class="settings-grid">
            <SettingsField label="Voice agent">
              <Select
                v-bind="LEDGER_SELECT"
                :model-value="voice.conversation.defaultAgentId"
                :options="agentOptions"
                aria-label="Voice agent"
                @update:model-value="updateConversation({ defaultAgentId: String($event) })"
              />
            </SettingsField>
            <SettingsField label="Response timing">
              <Select
                v-bind="LEDGER_SELECT"
                :model-value="voice.conversation.endpointing"
                :options="ENDPOINTING_OPTIONS"
                aria-label="Response timing"
                @update:model-value="setEndpointing(String($event) as VoiceEndpointingMode)"
              />
            </SettingsField>
          </div>
        </SettingRow>

        <SettingRow
          layout="stack"
          label="Speech to text"
          :description="transcriptionDescription"
        >
          <div
            v-if="voice.asr.provider === 'openai-transcribe'"
            class="provider-note"
          >
            <span>Advanced OpenAI transcription is active.</span>
            <Button
              unstyled
              native-type="button"
              @click="useRecommendedTranscription"
            >
              Use streaming ASR
            </Button>
          </div>
          <div
            v-else-if="voice.asr.provider === 'funasr-server'"
            class="provider-note"
          >
            <span>Advanced FunASR transcription is active.</span>
            <Button
              unstyled
              native-type="button"
              @click="useRecommendedTranscription"
            >
              Use streaming ASR
            </Button>
          </div>
          <div
            v-else-if="voice.asr.provider === 'funasr-stream'"
            class="settings-grid settings-grid-compact"
          >
            <SettingsField
              label="FunASR WebSocket URL"
              hint="Required for streaming ASR. Example: ws://127.0.0.1:10095"
            >
              <Input
                variant="ledger"
                :model-value="voice.asr.funasr.url"
                placeholder="ws://127.0.0.1:10095"
                spellcheck="false"
                @update:model-value="updateFunASR({ url: $event })"
              />
            </SettingsField>
          </div>
          <div
            v-else-if="voice.asr.provider === 'doubao'"
            class="settings-grid settings-grid-compact"
          >
            <SettingsField
              label="Doubao API key"
              hint="One key covers both speech recognition and Doubao voices. Create it in the Volcano Engine speech console."
            >
              <Input
                variant="ledger"
                type="password"
                autocomplete="off"
                :model-value="voice.doubao.apiKey"
                placeholder="Volcano Engine API key"
                spellcheck="false"
                @update:model-value="updateDoubao({ apiKey: $event })"
              />
            </SettingsField>
          </div>
          <div
            v-else
            class="settings-grid settings-grid-compact"
          >
            <SettingsField
              label="OpenRouter API key"
              :hint="hasOpenRouterProviderKey ? 'Global key found. Fill this only to override it.' : 'Required for voice input.'"
            >
              <Input
                variant="ledger"
                type="password"
                autocomplete="off"
                :model-value="voice.asr.openrouter.apiKey"
                :placeholder="hasOpenRouterProviderKey ? 'Using global key' : 'sk-or-...'"
                spellcheck="false"
                @update:model-value="updateOpenRouterASR({ apiKey: $event })"
              />
            </SettingsField>
          </div>
        </SettingRow>

        <SettingRow
          layout="stack"
          label="Voice replies"
          :description="ttsDescription"
        >
          <div class="voice-replies-control">
            <div class="voice-replies-toggle">
              <div>
                <span>Speak assistant replies</span>
                <small>Only replies to voice-started turns are read aloud.</small>
              </div>
              <Switch
                variant="ledger"
                :model-value="voice.tts.autoSpeak"
                aria-label="Speak assistant replies"
                @update:model-value="updateTTS({ autoSpeak: Boolean($event) })"
              />
            </div>

            <div class="settings-grid settings-grid-compact">
              <SettingsField
                label="TTS provider"
                :hint="ttsProviderHint"
              >
                <Select
                  v-bind="LEDGER_SELECT"
                  :model-value="voice.tts.provider"
                  :options="TTS_PROVIDER_OPTIONS"
                  aria-label="TTS provider"
                  @update:model-value="updateTTS({ provider: String($event) as VoiceSettings['tts']['provider'] })"
                />
              </SettingsField>

              <SettingsField
                v-if="voice.tts.provider === 'openrouter-tts'"
                label="OpenRouter API key"
                :hint="hasOpenRouterTTSKey ? 'Using the voice OpenRouter key, speech-to-text key, or global OpenRouter key.' : 'Required for OpenRouter TTS. Without it, replies fall back to System voice.'"
              >
                <Input
                  variant="ledger"
                  type="password"
                  autocomplete="off"
                  :model-value="voice.tts.openrouter.apiKey"
                  :placeholder="openRouterTTSPlaceholder"
                  spellcheck="false"
                  @update:model-value="updateOpenRouterTTS({ apiKey: $event })"
                />
              </SettingsField>

              <SettingsField
                v-else-if="voice.tts.provider === 'openai-tts'"
                label="OpenAI API key"
                :hint="hasOpenAIProviderKey ? 'Global OpenAI key found. Fill this only to override it.' : 'Required for OpenAI TTS. Without it, replies fall back to System voice.'"
              >
                <Input
                  variant="ledger"
                  type="password"
                  autocomplete="off"
                  :model-value="voice.tts.openai.apiKey"
                  :placeholder="hasOpenAIProviderKey ? 'Using global key' : 'sk-...'"
                  spellcheck="false"
                  @update:model-value="updateOpenAITTS({ apiKey: $event })"
                />
              </SettingsField>

              <SettingsField
                v-else-if="voice.tts.provider === 'doubao'"
                label="Doubao API key"
                hint="Shared with Doubao speech recognition; fill it once in either place."
              >
                <Input
                  variant="ledger"
                  type="password"
                  autocomplete="off"
                  :model-value="voice.doubao.apiKey"
                  placeholder="Volcano Engine API key"
                  spellcheck="false"
                  @update:model-value="updateDoubao({ apiKey: $event })"
                />
              </SettingsField>

              <SettingsField
                v-else-if="voice.tts.provider === 'qwen-tts'"
                label="Qwen / CosyVoice URL"
                hint="OpenAI-compatible /audio/speech base URL."
              >
                <Input
                  variant="ledger"
                  :model-value="voice.tts.qwen.baseUrl"
                  placeholder="https://..."
                  spellcheck="false"
                  @update:model-value="updateQwenTTS({ baseUrl: $event })"
                />
              </SettingsField>

              <SettingsField
                v-else
                label="System voice"
                value="Default"
                hint="Uses the built-in browser/system speech voice."
              >
                <div class="readonly-provider">
                  No cloud TTS setup needed
                </div>
              </SettingsField>
            </div>

            <div
              v-if="voice.tts.provider === 'openrouter-tts'"
              class="settings-grid settings-grid-compact provider-config-grid"
            >
              <SettingsField
                label="OpenRouter TTS model"
                :hint="openRouterTTSModelHint"
              >
                <Select
                  v-if="ttsModels.length"
                  v-bind="LEDGER_SELECT"
                  :model-value="voice.tts.openrouter.model"
                  :options="ttsModelOptions"
                  aria-label="OpenRouter TTS model"
                  @update:model-value="selectOpenRouterTTSModel(String($event))"
                />
                <Input
                  v-else
                  variant="ledger"
                  :model-value="voice.tts.openrouter.model"
                  spellcheck="false"
                  @update:model-value="updateOpenRouterTTS({ model: $event })"
                />
              </SettingsField>
              <SettingsField
                label="Voice"
                :hint="openRouterTTSVoiceHint"
              >
                <Select
                  v-if="selectedOpenRouterTTSVoices.length"
                  v-bind="LEDGER_SELECT"
                  :model-value="voice.tts.openrouter.voice"
                  :options="openRouterTTSVoiceOptions"
                  aria-label="OpenRouter TTS voice"
                  @update:model-value="updateOpenRouterTTS({ voice: String($event) })"
                />
                <Input
                  v-else
                  variant="ledger"
                  :model-value="voice.tts.openrouter.voice"
                  spellcheck="false"
                  @update:model-value="updateOpenRouterTTS({ voice: $event })"
                />
              </SettingsField>
            </div>

            <div
              v-if="voice.tts.provider === 'openrouter-tts'"
              class="model-actions"
            >
              <Button
                unstyled
                native-type="button"
                class="secondary-button compact-button"
                :disabled="ttsModelsStatus === 'loading'"
                @click="loadOpenRouterTTSModels(true)"
              >
                <Loader2
                  v-if="ttsModelsStatus === 'loading'"
                  class="spin"
                  :size="14"
                />
                <RefreshCw
                  v-else
                  :size="14"
                />
                <span>{{ ttsModels.length ? 'Refresh TTS models' : 'Load TTS models' }}</span>
              </Button>
              <span
                v-if="ttsModelsMessage"
                class="model-status"
                :class="ttsModelsStatus"
              >
                {{ ttsModelsMessage }}
              </span>
            </div>

            <div
              v-if="voice.tts.provider === 'qwen-tts'"
              class="settings-grid settings-grid-compact provider-config-grid"
            >
              <SettingsField
                label="Qwen / CosyVoice API key"
                hint="Required for Qwen / CosyVoice. Without it, replies fall back to System voice."
              >
                <Input
                  variant="ledger"
                  type="password"
                  autocomplete="off"
                  :model-value="voice.tts.qwen.apiKey"
                  spellcheck="false"
                  @update:model-value="updateQwenTTS({ apiKey: $event })"
                />
              </SettingsField>
              <SettingsField label="Voice">
                <Input
                  variant="ledger"
                  :model-value="voice.tts.qwen.voice"
                  spellcheck="false"
                  @update:model-value="updateQwenTTS({ voice: $event })"
                />
              </SettingsField>
            </div>

            <div
              v-if="voice.tts.provider === 'doubao'"
              class="settings-grid settings-grid-compact provider-config-grid"
            >
              <SettingsField label="Doubao voice">
                <Select
                  v-bind="LEDGER_SELECT"
                  :model-value="voice.doubao.speaker"
                  :options="DOUBAO_SPEAKER_OPTIONS"
                  aria-label="Doubao voice"
                  @update:model-value="updateDoubao({ speaker: String($event) })"
                />
              </SettingsField>
            </div>

            <div
              v-if="voice.tts.provider === 'openai-tts'"
              class="settings-grid settings-grid-compact provider-config-grid"
            >
              <SettingsField label="OpenAI TTS model">
                <Input
                  variant="ledger"
                  :model-value="voice.tts.openai.model"
                  spellcheck="false"
                  @update:model-value="updateOpenAITTS({ model: $event })"
                />
              </SettingsField>
              <SettingsField label="OpenAI voice">
                <Input
                  variant="ledger"
                  :model-value="voice.tts.openai.voice"
                  spellcheck="false"
                  @update:model-value="updateOpenAITTS({ voice: $event })"
                />
              </SettingsField>
            </div>

            <p
              v-if="ttsSetupIssue"
              class="setup-status warning"
            >
              {{ ttsSetupIssue }}
            </p>
          </div>
        </SettingRow>

        <SettingRow
          layout="stack"
          label="Wake word"
          description="Keep listening for a spoken wake phrase, then start a voice turn hands-free. Detection runs locally; audio only goes to the cloud after the wake phrase."
        >
          <div class="voice-replies-control">
            <div class="voice-replies-toggle">
              <div>
                <span>Listen for the wake phrase</span>
                <small>The mic stays open while onething runs.</small>
              </div>
              <Switch
                variant="ledger"
                :model-value="wakeWordEnabled"
                aria-label="Listen for the wake phrase"
                @update:model-value="setWakeWordEnabled(Boolean($event))"
              />
            </div>

            <div
              v-if="wakeWordEnabled"
              class="settings-grid settings-grid-compact"
            >
              <SettingsField
                label="Wake phrase"
                hint="Chinese characters, 4+ recommended (e.g. 你好小一)."
              >
                <Input
                  variant="ledger"
                  :model-value="voice.wake.phrase"
                  placeholder="你好小一"
                  spellcheck="false"
                  @update:model-value="updateWake({ phrase: $event })"
                />
              </SettingsField>
              <SettingsField
                label="Sensitivity"
                hint="Higher triggers more easily but risks false wakes."
              >
                <Select
                  v-bind="LEDGER_SELECT"
                  :model-value="voice.wake.sensitivity || 'medium'"
                  :options="WAKE_SENSITIVITY_OPTIONS"
                  aria-label="Wake sensitivity"
                  @update:model-value="updateWake({ sensitivity: String($event) as WakeSensitivity })"
                />
              </SettingsField>
            </div>
          </div>
        </SettingRow>

        <div class="setup-actions">
          <Button
            unstyled
            native-type="button"
            class="secondary-button"
            @click="useRecommendedDefaults"
          >
            <RefreshCw :size="15" />
            <span>Reset to recommended</span>
          </Button>
          <Button
            unstyled
            native-type="button"
            class="secondary-button"
            :disabled="isTestingTTS"
            @click="testSystemVoice"
          >
            <Loader2
              v-if="isTestingTTS"
              class="spin"
              :size="15"
            />
            <Volume2
              v-else
              :size="15"
            />
            <span>{{ ttsTestButtonLabel }}</span>
          </Button>
          <Button
            unstyled
            native-type="button"
            class="secondary-button"
            :disabled="isTestingASR"
            @click="testSpeechToText"
          >
            <Loader2
              v-if="isTestingASR"
              class="spin"
              :size="15"
            />
            <Mic
              v-else
              :size="15"
            />
            <span>{{ asrTestButtonLabel }}</span>
          </Button>
          <p
            v-if="asrTestMessage"
            class="setup-status"
            :class="asrTestStatus"
          >
            {{ asrTestMessage }}
          </p>
          <p
            v-if="ttsTestMessage"
            class="setup-status"
            :class="ttsTestStatus"
          >
            {{ ttsTestMessage }}
          </p>
        </div>
      </SettingsGroup>
    </SettingsSection>

    <Button
      unstyled
      native-type="button"
      class="advanced-toggle"
      @click="showAdvanced = !showAdvanced"
    >
      {{ showAdvanced ? 'Hide advanced settings' : 'Advanced settings' }}
    </Button>

    <SettingsSection
      v-if="showAdvanced"
      title="Advanced Recording"
      description="Tune automatic stop detection for mic button recordings."
    >
      <SettingsGroup>
        <div class="settings-grid">
          <SettingsField label="VAD provider">
            <Select
              v-bind="LEDGER_SELECT"
              :model-value="voice.vad.provider"
              :options="VAD_PROVIDER_OPTIONS"
              aria-label="VAD provider"
              @update:model-value="updateVAD({ provider: String($event) as VoiceSettings['vad']['provider'] })"
            />
          </SettingsField>
          <SettingsField label="Silence ms">
            <Input
              variant="ledger"
              type="number"
              min="300"
              max="10000"
              :model-value="voice.vad.silenceMs"
              @update:model-value="updateCustomSilenceMs(Number($event))"
            />
          </SettingsField>
        </div>

        <div class="settings-grid">
          <SettingsField label="Energy threshold">
            <Input
              variant="ledger"
              type="number"
              min="0.001"
              max="0.25"
              step="0.001"
              :model-value="voice.vad.energyThreshold"
              @update:model-value="updateVAD({ energyThreshold: Number($event) })"
            />
          </SettingsField>
          <SettingsField label="Max recording ms">
            <Input
              variant="ledger"
              type="number"
              min="3000"
              max="120000"
              :model-value="voice.vad.maxRecordingMs"
              @update:model-value="updateVAD({ maxRecordingMs: Number($event) })"
            />
          </SettingsField>
        </div>
      </SettingsGroup>
    </SettingsSection>

    <SettingsSection
      v-if="showAdvanced"
      title="Advanced Speech Providers"
      description="Override models, local servers, or paid voice services."
    >
      <SettingsGroup>
        <div class="settings-grid">
          <SettingsField label="ASR provider">
            <Select
              v-bind="LEDGER_SELECT"
              :model-value="voice.asr.provider"
              :options="ASR_PROVIDER_OPTIONS"
              aria-label="ASR provider"
              @update:model-value="updateASR({ provider: String($event) as VoiceSettings['asr']['provider'] })"
            />
          </SettingsField>
          <SettingsField label="OpenAI ASR model">
            <Input
              variant="ledger"
              :model-value="voice.asr.openai.model"
              spellcheck="false"
              @update:model-value="updateOpenAIASR({ model: $event })"
            />
          </SettingsField>
        </div>

        <div class="settings-grid">
          <SettingsField
            label="OpenRouter ASR model"
            hint="Use openai/whisper-1 if you want OpenRouter's OpenAI Whisper route. API keys and server URLs live under Voice input above."
          >
            <Input
              variant="ledger"
              :model-value="voice.asr.openrouter.model"
              spellcheck="false"
              @update:model-value="updateOpenRouterASR({ model: $event })"
            />
          </SettingsField>
        </div>
      </SettingsGroup>
    </SettingsSection>
  </div>
</template>

<script setup lang="ts">
import Button from '@/components/common/Button.vue'
import Input from '@/components/common/Input.vue'
import Select from '@/components/common/Select.vue'
import Switch from '@/components/common/Switch.vue'
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { Loader2, Mic, RefreshCw, Volume2 } from 'lucide-vue-next'
import type { SelectOptionLike } from '@/components/common/select'
import type { AgentDefinition, AppSettings, VoiceEndpointingMode, VoiceSettings, VoiceTTSModel } from '@/types'
import {
  SettingRow,
  SettingsField,
  SettingsGroup,
  SettingsSection,
} from './settings-primitives'
import { DEFAULT_VOICE_SETTINGS } from '@shared/defaults/settings'
import { voiceApi } from '@/platform/voice-client'
import { agentsApi } from '@/platform/agents-client'

const props = defineProps<{
  settings: AppSettings
}>()

const emit = defineEmits<{
  'update:settings': [settings: AppSettings]
}>()

const voice = computed<VoiceSettings>(() => props.settings.voice ?? DEFAULT_VOICE_SETTINGS)

type WakeSensitivity = NonNullable<VoiceSettings['wake']['sensitivity']>

const DOUBAO_SPEAKERS = [
  { id: 'zh_female_cancan_mars_bigtts', name: '灿灿(女声)' },
  { id: 'zh_female_shuangkuaisisi_moon_bigtts', name: '爽快思思(女声)' },
  { id: 'zh_male_wennuanahu_moon_bigtts', name: '温暖阿虎(男声)' },
  { id: 'zh_male_yangguangqingnian_moon_bigtts', name: '阳光青年(男声)' },
  { id: 'zh_female_linjianvhai_moon_bigtts', name: '邻家女孩(女声)' },
  { id: 'zh_male_jingqiangkanye_moon_bigtts', name: '京腔侃爷(男声)' },
]

/**
 * One spelling of "a settings-area dropdown", spread onto every Select on this
 * tab. `teleported` is not optional here: the settings body is a scroll
 * container, and an in-flow panel gets clipped by it the moment the field is
 * near the bottom — which is exactly where the ASR provider field lives.
 */
const LEDGER_SELECT = {
  variant: 'ledger',
  size: 'small',
  teleported: true,
  fitInputWidth: true,
} as const

const ENDPOINTING_OPTIONS: SelectOptionLike[] = [
  { value: 'fast', label: 'Fast response' },
  { value: 'balanced', label: 'Balanced' },
  { value: 'patient', label: 'Patient' },
  { value: 'custom', label: 'Custom' },
]

const TTS_PROVIDER_OPTIONS: SelectOptionLike[] = [
  { value: 'system-tts', label: 'System voice (no key)' },
  { value: 'openrouter-tts', label: 'OpenRouter TTS' },
  { value: 'openai-tts', label: 'OpenAI TTS' },
  { value: 'qwen-tts', label: 'Qwen / CosyVoice' },
  { value: 'doubao', label: 'Doubao voices' },
]

const WAKE_SENSITIVITY_OPTIONS: SelectOptionLike[] = [
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
]

const VAD_PROVIDER_OPTIONS: SelectOptionLike[] = [
  { value: 'silero-web', label: 'Silero Web' },
  { value: 'energy', label: 'Energy fallback' },
]

const ASR_PROVIDER_OPTIONS: SelectOptionLike[] = [
  { value: 'funasr-stream', label: 'FunASR Streaming' },
  { value: 'doubao', label: 'Doubao Streaming' },
  { value: 'openai-transcribe', label: 'OpenAI Transcribe' },
  { value: 'openrouter-transcribe', label: 'OpenRouter Whisper' },
  { value: 'funasr-server', label: 'FunASR HTTP Server' },
]

const DOUBAO_SPEAKER_OPTIONS: SelectOptionLike[] = DOUBAO_SPEAKERS.map(
  speaker => ({ value: speaker.id, label: speaker.name }),
)
const showAdvanced = ref(false)
const agents = ref<AgentDefinition[]>([])
const asrTestStatus = ref<'idle' | 'recording' | 'testing' | 'success' | 'error'>('idle')
const asrTestMessage = ref('')
const ttsTestStatus = ref<'idle' | 'testing' | 'success' | 'error'>('idle')
const ttsTestMessage = ref('')
const ttsModels = ref<VoiceTTSModel[]>([])
const ttsModelsStatus = ref<'idle' | 'loading' | 'success' | 'error'>('idle')
const ttsModelsMessage = ref('')
let asrTestStream: MediaStream | null = null
let asrTestRecorder: MediaRecorder | null = null
const transcriptionDescription = computed(() => {
  if (voice.value.asr.provider === 'doubao') {
    return 'Realtime path. Streams microphone PCM to Doubao (Volcano Engine) streaming ASR; the cloud detects the end of your sentence.'
  }
  if (voice.value.asr.provider === 'funasr-stream') {
    return 'Realtime path. Streams microphone PCM to your FunASR WebSocket server and receives partial transcripts.'
  }
  if (voice.value.asr.provider === 'funasr-server') {
    return 'Legacy path. Sends one completed recording to your FunASR HTTP endpoint.'
  }
  if (voice.value.asr.provider === 'openai-transcribe') {
    return 'This batch transcription path is enabled from Advanced settings. Switch back to streaming ASR below.'
  }
  return 'Batch path. Uses OpenRouter Whisper with your global OpenRouter key or the key below.'
})
const hasOpenRouterProviderKey = computed(() => Boolean(
  (props.settings.ai.providers.openrouter as any)?.apiKey?.trim(),
))
const hasOpenAIProviderKey = computed(() => Boolean(
  (props.settings.ai.providers.openai as any)?.apiKey?.trim(),
))
const hasOpenRouterASRKey = computed(() => Boolean(voice.value.asr.openrouter.apiKey?.trim()))
const hasOpenRouterTTSKey = computed(() => Boolean(
  voice.value.tts.openrouter.apiKey?.trim()
  || voice.value.asr.openrouter.apiKey?.trim()
  || hasOpenRouterProviderKey.value,
))
const openRouterTTSPlaceholder = computed(() => {
  if (voice.value.tts.openrouter.apiKey?.trim()) return ''
  if (hasOpenRouterASRKey.value) return 'Using speech-to-text OpenRouter key'
  if (hasOpenRouterProviderKey.value) return 'Using global OpenRouter key'
  return 'sk-or-...'
})
const selectedOpenRouterTTSModel = computed(() => (
  ttsModels.value.find(model => model.id === voice.value.tts.openrouter.model)
))
const selectedOpenRouterTTSVoices = computed(() => selectedOpenRouterTTSModel.value?.supportedVoices || [])
const agentOptions = computed<SelectOptionLike[]>(() => (
  agents.value.map(agent => ({ value: agent.id, label: agent.name }))
))
const ttsModelOptions = computed<SelectOptionLike[]>(() => (
  ttsModels.value.map(model => ({ value: model.id, label: model.name || model.id }))
))
const openRouterTTSVoiceOptions = computed<SelectOptionLike[]>(() => (
  selectedOpenRouterTTSVoices.value.map(voiceName => ({ value: voiceName, label: voiceName }))
))
const openRouterTTSModelHint = computed(() => {
  if (ttsModelsStatus.value === 'loading') return 'Loading speech models from OpenRouter...'
  if (ttsModels.value.length) return 'Loaded from OpenRouter models API.'
  if (ttsModelsStatus.value === 'error') return 'Model loading failed. You can still type a model slug manually.'
  return 'Use OpenRouter speech model slugs, or load the model list.'
})
const openRouterTTSVoiceHint = computed(() => {
  if (selectedOpenRouterTTSVoices.value.length) return 'Voices are loaded from the selected OpenRouter model.'
  if (ttsModels.value.length) return 'This model did not report voices. You can type a provider-supported voice manually.'
  return 'Voice names depend on the selected OpenRouter model.'
})
const asrProviderLabel = computed(() => {
  if (voice.value.asr.provider === 'doubao') return 'Doubao Streaming'
  if (voice.value.asr.provider === 'funasr-stream') return 'FunASR Streaming'
  if (voice.value.asr.provider === 'funasr-server') return 'FunASR Server'
  if (voice.value.asr.provider === 'openai-transcribe') return `OpenAI ${voice.value.asr.openai.model || 'Transcribe'}`
  return `OpenRouter ${voice.value.asr.openrouter.model || 'Whisper'}`
})
const asrSetupIssue = computed(() => getASRProviderSetupIssue())
const asrSetupStatus = computed(() => {
  if (voice.value.asr.provider === 'openrouter-transcribe' && hasOpenRouterProviderKey.value && !voice.value.asr.openrouter.apiKey?.trim()) {
    return 'Using global OpenRouter key'
  }
  if (voice.value.asr.provider === 'openai-transcribe' && hasOpenAIProviderKey.value && !voice.value.asr.openai.apiKey?.trim()) {
    return 'Using global OpenAI key'
  }
  return 'Configured'
})
const configuredTTSProviderLabel = computed(() => {
  if (voice.value.tts.provider === 'openrouter-tts') return 'OpenRouter TTS'
  if (voice.value.tts.provider === 'openai-tts') return 'OpenAI TTS'
  if (voice.value.tts.provider === 'qwen-tts') return 'Qwen / CosyVoice'
  if (voice.value.tts.provider === 'doubao') return 'Doubao voices'
  return 'System voice'
})
const hasDoubaoCredentials = computed(() => Boolean(
  voice.value.doubao.apiKey?.trim()
  || (voice.value.doubao.appId?.trim() && voice.value.doubao.accessToken?.trim()),
))
const ttsProviderHasRequiredConfig = computed(() => {
  if (voice.value.tts.provider === 'system-tts') return true
  if (voice.value.tts.provider === 'openrouter-tts') return hasOpenRouterTTSKey.value
  if (voice.value.tts.provider === 'openai-tts') {
    return Boolean(voice.value.tts.openai.apiKey?.trim() || hasOpenAIProviderKey.value)
  }
  if (voice.value.tts.provider === 'doubao') return hasDoubaoCredentials.value
  return Boolean(voice.value.tts.qwen.baseUrl.trim() && voice.value.tts.qwen.apiKey?.trim())
})
const effectiveTTSProviderLabel = computed(() => {
  if (!voice.value.tts.autoSpeak) return 'Off'
  if (ttsProviderHasRequiredConfig.value) return configuredTTSProviderLabel.value
  return `System voice fallback`
})
const ttsSetupIssue = computed(() => {
  if (!voice.value.tts.autoSpeak) return ''
  if (voice.value.tts.provider === 'openrouter-tts' && !ttsProviderHasRequiredConfig.value) {
    return 'Missing OpenRouter key; using System voice.'
  }
  if (voice.value.tts.provider === 'openai-tts' && !ttsProviderHasRequiredConfig.value) {
    return 'Missing OpenAI key; using System voice.'
  }
  if (voice.value.tts.provider === 'qwen-tts' && !voice.value.tts.qwen.baseUrl.trim()) {
    return 'Missing Qwen / CosyVoice URL; using System voice.'
  }
  if (voice.value.tts.provider === 'qwen-tts' && !voice.value.tts.qwen.apiKey?.trim()) {
    return 'Missing Qwen / CosyVoice API key; using System voice.'
  }
  if (voice.value.tts.provider === 'doubao' && !hasDoubaoCredentials.value) {
    return 'Missing Doubao API key; using System voice.'
  }
  return ''
})
const ttsSetupStatus = computed(() => {
  if (!voice.value.tts.autoSpeak) return 'Assistant replies will not be spoken'
  if (voice.value.tts.provider === 'system-tts') return 'No API key needed'
  if (voice.value.tts.provider === 'openrouter-tts' && hasOpenRouterASRKey.value && !voice.value.tts.openrouter.apiKey?.trim()) {
    return 'Using speech-to-text OpenRouter key'
  }
  if (voice.value.tts.provider === 'openrouter-tts' && hasOpenRouterProviderKey.value && !voice.value.tts.openrouter.apiKey?.trim()) {
    return 'Using global OpenRouter key'
  }
  if (voice.value.tts.provider === 'openai-tts' && hasOpenAIProviderKey.value && !voice.value.tts.openai.apiKey?.trim()) {
    return 'Using global OpenAI key'
  }
  return 'Configured'
})
const ttsDescription = computed(() => {
  if (!voice.value.tts.autoSpeak) return 'Voice replies are off. The assistant will answer in text only.'
  if (ttsSetupIssue.value) return 'The selected cloud TTS is incomplete, so replies fall back to System voice instead of failing silently.'
  return `Assistant replies from voice turns will be spoken with ${effectiveTTSProviderLabel.value}.`
})
const ttsProviderHint = computed(() => {
  if (voice.value.tts.provider === 'system-tts') return 'Recommended MVP path. It works without a paid TTS API.'
  if (voice.value.tts.provider === 'openrouter-tts') return 'Uses the same OpenRouter account as speech to text when available.'
  if (voice.value.tts.provider === 'openai-tts') return 'Uses OpenAI audio speech when a key is available; otherwise System voice is used.'
  if (voice.value.tts.provider === 'doubao') return 'Streams Doubao (Volcano Engine) voices with the shared Doubao API key.'
  return 'Uses an OpenAI-compatible Qwen/CosyVoice speech endpoint when configured.'
})
const voiceSetupSummary = computed(() => {
  if (!voice.value.enabled) return 'Turn on Voice, add speech-to-text credentials, then use the mic button in chat.'
  const inputState = asrSetupIssue.value ? 'speech to text still needs setup' : `${asrProviderLabel.value} is ready`
  const replyState = voice.value.tts.autoSpeak
    ? `replies use ${effectiveTTSProviderLabel.value}`
    : 'spoken replies are off'
  return `${inputState}; ${replyState}.`
})
const isTestingASR = computed(() => asrTestStatus.value === 'recording' || asrTestStatus.value === 'testing')
const isTestingTTS = computed(() => ttsTestStatus.value === 'testing')
const asrTestButtonLabel = computed(() => {
  if (asrTestStatus.value === 'recording') return 'Listening...'
  if (asrTestStatus.value === 'testing') return 'Checking...'
  if (voice.value.asr.provider === 'funasr-stream' || voice.value.asr.provider === 'doubao') return 'Test in chat'
  return 'Test speech to text'
})
const ttsTestButtonLabel = computed(() => isTestingTTS.value ? 'Testing voice...' : 'Test voice')

const ENDPOINTING_PRESETS: Record<Exclude<VoiceEndpointingMode, 'custom'>, number> = {
  fast: 650,
  balanced: 900,
  patient: 1300,
}

onMounted(async () => {
  try {
    const response = await agentsApi.listAgents()
    if (response.success && response.agents?.length) agents.value = response.agents
  } catch {
    agents.value = []
  }
  if (!agents.value.some(agent => agent.id === voice.value.conversation.defaultAgentId)) {
    agents.value = [{
      id: voice.value.conversation.defaultAgentId || 'default',
      name: 'Default Agent',
      systemPrompt: '',
      isDefault: true,
      createdAt: 0,
      updatedAt: 0,
    }]
  }

  if (voice.value.tts.provider === 'openrouter-tts') {
    void loadOpenRouterTTSModels()
  }
})

onUnmounted(() => {
  cleanupASRTest()
})

watch(() => voice.value.tts.provider, (provider) => {
  if (provider === 'openrouter-tts' && ttsModelsStatus.value === 'idle') {
    void loadOpenRouterTTSModels()
  }
})

function updateVoice(updates: Partial<VoiceSettings>) {
  emit('update:settings', {
    ...props.settings,
    voice: {
      ...voice.value,
      ...updates,
    },
  })
}

function updateVAD(updates: Partial<VoiceSettings['vad']>) {
  updateVoice({ vad: { ...voice.value.vad, ...updates } })
}

function updateDoubao(updates: Partial<VoiceSettings['doubao']>) {
  updateVoice({ doubao: { ...voice.value.doubao, ...updates } })
}

function updateWake(updates: Partial<VoiceSettings['wake']>) {
  updateVoice({ wake: { ...voice.value.wake, ...updates } })
}

const wakeWordEnabled = computed(() => (
  voice.value.alwaysOn && voice.value.wake.enabled && voice.value.wake.provider === 'sherpa-kws'
))

function setWakeWordEnabled(enabled: boolean) {
  updateVoice({
    alwaysOn: enabled,
    wake: {
      ...voice.value.wake,
      enabled,
      provider: 'sherpa-kws',
    },
  })
}

function updateConversation(updates: Partial<VoiceSettings['conversation']>) {
  updateVoice({ conversation: { ...voice.value.conversation, ...updates } })
}

function setEndpointing(mode: VoiceEndpointingMode) {
  const silenceMs = mode === 'custom'
    ? voice.value.vad.silenceMs
    : ENDPOINTING_PRESETS[mode]
  updateVoice({
    conversation: {
      ...voice.value.conversation,
      endpointing: mode,
    },
    vad: {
      ...voice.value.vad,
      silenceMs,
    },
  })
}

function updateCustomSilenceMs(silenceMs: number) {
  updateVoice({
    conversation: {
      ...voice.value.conversation,
      endpointing: 'custom',
    },
    vad: {
      ...voice.value.vad,
      silenceMs,
    },
  })
}

function updateASR(updates: Partial<VoiceSettings['asr']>) {
  updateVoice({ asr: { ...voice.value.asr, ...updates } })
}

function updateOpenAIASR(updates: Partial<VoiceSettings['asr']['openai']>) {
  updateASR({ openai: { ...voice.value.asr.openai, ...updates } })
}

function updateOpenRouterASR(updates: Partial<VoiceSettings['asr']['openrouter']>) {
  updateASR({ openrouter: { ...voice.value.asr.openrouter, ...updates } })
}

function updateFunASR(updates: Partial<VoiceSettings['asr']['funasr']>) {
  updateASR({ funasr: { ...voice.value.asr.funasr, ...updates } })
}

function updateTTS(updates: Partial<VoiceSettings['tts']>) {
  updateVoice({ tts: { ...voice.value.tts, ...updates } })
}

function updateOpenAITTS(updates: Partial<VoiceSettings['tts']['openai']>) {
  updateTTS({ openai: { ...voice.value.tts.openai, ...updates } })
}

function updateOpenRouterTTS(updates: Partial<VoiceSettings['tts']['openrouter']>) {
  updateTTS({ openrouter: { ...voice.value.tts.openrouter, ...updates } })
}

function selectOpenRouterTTSModel(modelId: string) {
  const model = ttsModels.value.find(item => item.id === modelId)
  const nextVoice = model?.supportedVoices?.includes(voice.value.tts.openrouter.voice)
    ? voice.value.tts.openrouter.voice
    : model?.supportedVoices?.[0] || voice.value.tts.openrouter.voice
  updateOpenRouterTTS({
    model: modelId,
    voice: nextVoice,
  })
}

function updateQwenTTS(updates: Partial<VoiceSettings['tts']['qwen']>) {
  updateTTS({ qwen: { ...voice.value.tts.qwen, ...updates } })
}

async function loadOpenRouterTTSModels(force = false) {
  if (ttsModelsStatus.value === 'loading') return
  try {
    ttsModelsStatus.value = 'loading'
    ttsModelsMessage.value = 'Loading OpenRouter TTS models...'
    const response = await voiceApi.getTTSModels({ force })
    if (!response.success) throw new Error(response.error || 'Failed to load OpenRouter TTS models.')
    ttsModels.value = response.models || []
    ttsModelsStatus.value = 'success'
    ttsModelsMessage.value = ttsModels.value.length
      ? `Loaded ${ttsModels.value.length} TTS models.`
      : 'No OpenRouter TTS models were returned.'

    const selected = ttsModels.value.find(model => model.id === voice.value.tts.openrouter.model)
    if (selected?.supportedVoices?.length && !selected.supportedVoices.includes(voice.value.tts.openrouter.voice)) {
      updateOpenRouterTTS({ voice: selected.supportedVoices[0] })
    }
  } catch (error: any) {
    ttsModelsStatus.value = 'error'
    ttsModelsMessage.value = error?.message || 'Failed to load OpenRouter TTS models.'
  }
}

function useRecommendedTranscription() {
  updateASR({
    provider: 'funasr-stream',
    funasr: {
      ...voice.value.asr.funasr,
      mode: '2pass',
      chunkSize: [5, 10, 5],
      chunkInterval: 10,
    },
  })
}

function useRecommendedDefaults() {
  updateVoice({
    alwaysOn: false,
    bargeIn: true,
    wake: {
      ...voice.value.wake,
      enabled: false,
      provider: 'porcupine-web',
    },
    vad: {
      ...voice.value.vad,
      provider: 'silero-web',
      silenceMs: ENDPOINTING_PRESETS.fast,
      maxRecordingMs: 20000,
      energyThreshold: 0.012,
    },
    conversation: {
      ...voice.value.conversation,
      endpointing: 'fast',
      speakProtocol: 'speak-blocks',
    },
    asr: {
      ...voice.value.asr,
      provider: 'funasr-stream',
      funasr: {
        ...voice.value.asr.funasr,
        mode: '2pass',
        chunkSize: [5, 10, 5],
        chunkInterval: 10,
      },
    },
    tts: {
      ...voice.value.tts,
      provider: 'system-tts',
      autoSpeak: true,
    },
  })
}

async function testSystemVoice() {
  if (isTestingTTS.value) return
  if (!voice.value.enabled) {
    ttsTestStatus.value = 'error'
    ttsTestMessage.value = 'Turn on voice first.'
    return
  }
  if (!voice.value.tts.autoSpeak) {
    ttsTestStatus.value = 'error'
    ttsTestMessage.value = 'Turn on Speak replies first.'
    return
  }

  try {
    ttsTestStatus.value = 'testing'
    ttsTestMessage.value = 'Sending a test voice reply...'
    await sleep(650)
    const response = await voiceApi.testTTS({ text: 'Voice reply is ready.' })
    if (!response.success) throw new Error(response.error || 'Voice test failed.')
    ttsTestStatus.value = 'success'
    ttsTestMessage.value = 'Voice test sent. You should hear a reply.'
  } catch (error: any) {
    ttsTestStatus.value = 'error'
    ttsTestMessage.value = error?.message || 'Voice test failed.'
  }
}

async function testSpeechToText() {
  if (isTestingASR.value) return

  const setupIssue = getASRSetupIssue()
  if (setupIssue) {
    asrTestStatus.value = 'error'
    asrTestMessage.value = setupIssue
    return
  }

  if (voice.value.asr.provider === 'funasr-stream' || voice.value.asr.provider === 'doubao') {
    asrTestStatus.value = 'success'
    asrTestMessage.value = 'Streaming ASR runs from the chat mic button so partial transcripts can appear live.'
    return
  }

  try {
    asrTestStatus.value = 'recording'
    asrTestMessage.value = 'Recording for 4 seconds. Say a short phrase.'
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        autoGainControl: true,
        noiseSuppression: true,
      },
    })
    asrTestStream = stream

    const chunks: Blob[] = []
    const mimeType = preferredMimeType()
    const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined)
    asrTestRecorder = recorder
    const stopped = new Promise<Blob>((resolve, reject) => {
      recorder.onerror = event => reject((event as any).error || new Error('Microphone test failed.'))
      recorder.ondataavailable = event => {
        if (event.data.size > 0) chunks.push(event.data)
      }
      recorder.onstop = () => {
        resolve(new Blob(chunks, { type: recorder.mimeType || 'audio/webm' }))
      }
    })

    recorder.start()
    await sleep(4000)
    if (recorder.state !== 'inactive') recorder.stop()
    const blob = await stopped
    cleanupASRTest()

    if (blob.size === 0) throw new Error('No microphone audio was captured.')
    asrTestStatus.value = 'testing'
    asrTestMessage.value = 'Sending the recording to speech to text...'

    // Settings save automatically from the parent page; give the debounce time to flush
    // so a freshly pasted API key is included in the test request.
    await sleep(650)
    const response = await voiceApi.testASR({
      audioBase64: await blobToBase64(blob),
      mimeType: blob.type || 'audio/webm',
    })

    if (!response.success) {
      throw new Error(response.error || 'Speech to text test failed.')
    }

    asrTestStatus.value = 'success'
    asrTestMessage.value = response.transcript
      ? `Heard: ${response.transcript}`
      : 'Speech to text returned no transcript.'
  } catch (error: any) {
    cleanupASRTest()
    asrTestStatus.value = 'error'
    asrTestMessage.value = normalizeASRTestError(error)
  }
}

function getASRSetupIssue() {
  if (!voice.value.enabled) return 'Turn on voice first.'
  return getASRProviderSetupIssue()
}

function getASRProviderSetupIssue() {
  if (voice.value.asr.provider === 'doubao') {
    const doubao = voice.value.doubao
    const hasKey = Boolean(doubao.apiKey?.trim() || (doubao.appId?.trim() && doubao.accessToken?.trim()))
    return hasKey ? '' : 'Add a Doubao (Volcano Engine) API key before using Doubao speech.'
  }
  if (voice.value.asr.provider === 'funasr-stream') {
    const url = voice.value.asr.funasr.url.trim()
    if (!url) return 'Add a FunASR WebSocket URL before testing speech to text.'
    return /^wss?:\/\//i.test(url) ? '' : 'FunASR streaming ASR needs a ws:// or wss:// URL.'
  }
  if (voice.value.asr.provider === 'openrouter-transcribe') {
    const voiceKey = voice.value.asr.openrouter.apiKey?.trim()
    const globalKey = (props.settings.ai.providers.openrouter as any)?.apiKey?.trim()
    return voiceKey || globalKey ? '' : 'Add an OpenRouter API key before testing speech to text.'
  }
  if (voice.value.asr.provider === 'openai-transcribe') {
    const voiceKey = voice.value.asr.openai.apiKey?.trim()
    const globalKey = (props.settings.ai.providers.openai as any)?.apiKey?.trim()
    return voiceKey || globalKey ? '' : 'OpenAI transcription is selected but no OpenAI API key is configured.'
  }
  return voice.value.asr.funasr.url.trim() ? '' : 'Add a FunASR server URL before testing speech to text.'
}

function preferredMimeType() {
  if (typeof MediaRecorder === 'undefined' || !MediaRecorder.isTypeSupported) return ''
  const candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4']
  return candidates.find(type => MediaRecorder.isTypeSupported(type)) || ''
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result || '').split(',')[1] || '')
    reader.onerror = () => reject(reader.error || new Error('Could not read recorded audio.'))
    reader.readAsDataURL(blob)
  })
}

function sleep(ms: number) {
  return new Promise(resolve => window.setTimeout(resolve, ms))
}

function cleanupASRTest() {
  if (asrTestRecorder && asrTestRecorder.state !== 'inactive') {
    try {
      asrTestRecorder.stop()
    } catch {
      // Ignore cleanup races.
    }
  }
  asrTestRecorder = null
  asrTestStream?.getTracks().forEach(track => track.stop())
  asrTestStream = null
}

function normalizeASRTestError(error: any) {
  const message = String(error?.message || error || 'Speech to text test failed.')
  if (message.includes('Permission denied') || message.includes('NotAllowedError')) {
    return 'Microphone access was blocked. Allow microphone access and try again.'
  }
  if (message.includes('OpenRouter transcription failed (401)') || message.includes('OpenRouter transcription failed (403)')) {
    return 'OpenRouter rejected the API key.'
  }
  if (message.includes('transcription returned an empty transcript')) {
    return 'No speech was detected. Try the test again and say a short phrase.'
  }
  return message
}
</script>

<style scoped>
.tab-content {
  animation: fadeIn 0.15s ease;
}

.settings-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px;
  padding: 12px 14px;
  border-bottom: 1px solid var(--settings-rule-soft, var(--ui-border-default-border));
}

.settings-grid:last-child {
  border-bottom: 0;
}

.settings-grid-compact {
  padding: 0;
  border-bottom: 0;
}

.voice-setup-summary {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1.2fr);
  gap: 14px;
  padding: 14px;
  border-bottom: 1px solid var(--settings-rule-soft, var(--ui-border-default-border));
}

.voice-setup-copy {
  min-width: 0;
}

/* Status ring: outlined, zero fill — state lives in the line color */
.voice-state-pill {
  display: inline-flex;
  align-items: center;
  width: fit-content;
  min-height: 22px;
  padding: 3px 9px;
  border: 1px solid var(--settings-rule, var(--ui-border-default-border));
  border-radius: 999px;
  background: transparent;
  color: var(--settings-ink-4, var(--ui-text-muted-fg));
  font-family: var(--font-mono, monospace);
  font-size: 11px;
  line-height: 1;
  white-space: nowrap;
}

.voice-state-pill.on {
  border-color: var(--ui-status-success-fg);
  color: var(--ui-status-success-fg);
}

.voice-setup-copy h4 {
  margin: 10px 0 4px;
  color: var(--settings-ink, var(--ui-text-primary-fg));
  font-size: 14px;
  font-weight: 700;
  line-height: 1.25;
}

.voice-setup-copy p {
  margin: 0;
  color: var(--settings-ink-3, var(--ui-text-secondary-fg));
  font-size: 12px;
  line-height: 1.45;
}

.voice-setup-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 10px;
  min-width: 0;
}

.voice-setup-item {
  min-width: 0;
  padding: 10px;
  border: 1px solid var(--settings-rule-soft, var(--ui-border-default-border));
  background: transparent;
}

.voice-setup-item span,
.voice-setup-item small {
  display: block;
  min-width: 0;
}

.voice-setup-item span {
  color: var(--settings-ink-4, var(--ui-text-muted-fg));
  font-size: 11px;
  font-weight: 650;
  line-height: 1.2;
  text-transform: uppercase;
}

.voice-setup-item strong {
  display: block;
  margin-top: 7px;
  overflow-wrap: anywhere;
  color: var(--settings-ink, var(--ui-text-primary-fg));
  font-size: 13px;
  font-weight: 700;
  line-height: 1.25;
}

.voice-setup-item small {
  margin-top: 5px;
  color: var(--settings-ink-4, var(--ui-text-muted-fg));
  font-size: 12px;
  line-height: 1.35;
}

.voice-setup-item small.warning {
  color: var(--ui-status-warning-fg);
}

/* P3: the three `.native-toggle` checkboxes here are now `<Switch
   variant="ledger">`, which draws the same dashed-rail/ink-dot toggle from
   inside the component. Nothing local styles them — that was the point. */

.voice-replies-control {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.voice-replies-toggle {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  min-height: 42px;
}

.voice-replies-toggle > div {
  min-width: 0;
}

.voice-replies-toggle span,
.voice-replies-toggle small {
  display: block;
}

.voice-replies-toggle span {
  color: var(--settings-ink-2, var(--ui-text-primary-fg));
  font-size: 13px;
  font-weight: 650;
  line-height: 1.3;
}

.voice-replies-toggle small {
  margin-top: 3px;
  color: var(--settings-ink-4, var(--ui-text-muted-fg));
  font-size: 12px;
  line-height: 1.35;
}

.provider-config-grid {
  padding-top: 2px;
}

.model-actions {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  padding-top: 2px;
}

.compact-button {
  min-height: 28px;
  padding: 5px 9px;
  font-size: 12px;
}

.model-status {
  color: var(--settings-ink-4, var(--ui-text-muted-fg));
  font-size: 12px;
  line-height: 1.35;
}

.model-status.error {
  color: var(--ui-status-danger-fg);
}

.model-status.success {
  color: var(--ui-status-success-fg);
}

/* Read-only placeholder: dashed empty-state line, no fill */
.readonly-provider {
  min-height: 34px;
  display: flex;
  align-items: center;
  padding: 8px 10px;
  border: 1px dashed var(--settings-rule, var(--ui-border-default-border));
  background: transparent;
  color: var(--settings-ink-4, var(--ui-text-muted-fg));
  font-size: 13px;
}

.setup-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  padding: 12px 14px;
  border-top: 1px solid var(--settings-rule-soft, var(--ui-border-default-border));
}

.setup-note {
  max-width: 560px;
  margin: 8px 0 0;
  color: var(--settings-ink-4, var(--ui-text-muted-fg));
  font-size: 12px;
  line-height: 1.45;
}

/* Status lines: state hangs on a left ink rule, no filled block */
.setup-status {
  flex-basis: 100%;
  min-width: 0;
  margin: 0;
  padding: 2px 0 2px 8px;
  border-left: 2px solid var(--settings-rule, var(--ui-border-default-border));
  background: transparent;
  color: var(--settings-ink-3, var(--ui-text-secondary-fg));
  font-size: 12px;
  line-height: 1.4;
  overflow-wrap: anywhere;
}

.setup-status.success {
  border-left-color: var(--ui-status-success-fg);
  color: var(--ui-status-success-fg);
}

.setup-status.error {
  border-left-color: var(--ui-status-danger-fg);
  color: var(--ui-status-danger-fg);
}

.setup-status.warning {
  border-left-color: var(--ui-status-warning-fg);
  color: var(--ui-status-warning-fg);
}

.provider-note {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  margin-bottom: 10px;
  padding: 4px 0 4px 8px;
  border-left: 2px solid var(--settings-rule, var(--ui-border-default-border));
  background: transparent;
  color: var(--settings-ink-3, var(--ui-text-secondary-fg));
  font-size: 12px;
  line-height: 1.35;
}

.provider-note span {
  min-width: 0;
}

.provider-note button {
  flex-shrink: 0;
  min-height: 28px;
  padding: 5px 9px;
  border: 1px solid var(--settings-rule, var(--ui-border-default-border));
  background: transparent;
  color: var(--settings-ink-2, var(--ui-text-primary-fg));
  font-size: 12px;
  cursor: pointer;
  transition: border-color var(--duration-fast) var(--ease-default), color var(--duration-fast) var(--ease-default);
}

.provider-note button:hover {
  border-color: var(--settings-ink-3, var(--ui-text-muted-fg));
  color: var(--settings-ink, var(--ui-text-primary-fg));
}

.secondary-button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 7px;
  min-height: 32px;
  padding: 7px 12px;
  border: 1px solid var(--settings-rule, var(--ui-border-default-border));
  background: transparent;
  color: var(--settings-ink-2, var(--ui-text-primary-fg));
  font-size: 13px;
  cursor: pointer;
  transition: border-color var(--duration-fast) var(--ease-default), color var(--duration-fast) var(--ease-default);
}

:deep(.setting-row-stack > .setting-row-control) {
  width: 100%;
}

.secondary-button:hover:not(:disabled) {
  border-color: var(--settings-ink-3, var(--ui-text-muted-fg));
  color: var(--settings-ink, var(--ui-text-primary-fg));
}

.secondary-button:disabled {
  cursor: wait;
  opacity: 0.72;
}

.spin {
  animation: spin 0.8s linear infinite;
}

/* Advanced expander: text action, underline carries the hover */
.advanced-toggle {
  display: block;
  width: 100%;
  margin: 0 0 12px;
  padding: 6px 0;
  text-align: left;
  appearance: none;
  border: none;
  background: transparent;
  font-family: var(--font-mono, monospace);
  font-size: 12px;
  color: var(--settings-ink-3, var(--ui-text-muted-fg));
  cursor: pointer;
  transition: color var(--duration-fast) var(--ease-default);
}

.advanced-toggle:hover {
  color: var(--settings-ink, var(--ui-text-primary-fg));
  text-decoration: underline;
  text-underline-offset: 3px;
  text-decoration-color: var(--settings-accent, var(--ui-accent-primary-fg));
}

@media (max-width: 720px) {
  .voice-setup-summary,
  .voice-setup-grid {
    grid-template-columns: 1fr;
  }

  .settings-grid {
    grid-template-columns: 1fr;
  }

  .provider-note {
    align-items: stretch;
    flex-direction: column;
  }
}

@keyframes fadeIn {
  from { opacity: 0; }
  to { opacity: 1; }
}

@keyframes spin {
  to { transform: rotate(360deg); }
}
</style>
