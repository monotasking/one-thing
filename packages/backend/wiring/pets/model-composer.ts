/**
 * **模型作曲器** —— 一条时刻过了注意力预算、又没带现成台词时,让工具模型按宠物的口吻写一句
 * (宠物 P4,正本 `docs/design/pet-system-2026-09.md` §11.2)。
 *
 * 提示词与回复解析是产品层的两只纯函数(`@onething/runtime/pets` 的 `buildMomentPrompt` /
 * `parseMomentReply`),这里只做装配层才做得了的三件事:拿小模型、跑一次、记账。
 *
 * ── 用哪只模型 ─────────────────────────────────────────────────────────────
 * `createUtilityProvider(settings)` —— `settings.tools.toolCallModel`,与会话目录 / 标题生成同一只
 * 小模型,**不回落到聊天模型**:宠物一句闲话花掉一次昂贵模型的钱,比它不说话更糟。没配 → 答
 * `null`(宿主记 `nothing-to-say`),warn **只记一次**:没配是一种状态,不是每条时刻都要重报的错。
 *
 * ── 为什么 8 秒 ───────────────────────────────────────────────────────────
 * 宿主在作曲期间占着说话位(`PetHost.composing`),电台口播要认领时得等它。一句话晚过 8 秒才
 * 写出来,那条事实也已经过时了 —— 超时就当没话说。
 *
 * ── 为什么关思考、只跑一轮 ──────────────────────────────────────────────────
 * 与会话目录同一次踩坑(`wiring/toc/index.ts` 那段注释):混合推理模型留给服务端缺省时会把整个
 * 输出预算花在推理通道里,回来一个空串还照样计费。一句 60 字以内的话不需要推理,也不需要工具。
 *
 * 没有辅助模型的「意图 / 结果」账(`beginAuxiliaryModelRequest`):那一份记在**会话**的事件账本里,
 * 而宠物开口不属于任何会话;这一句话本身已经进了宠物自己的账本(话语行 / `nothing-to-say` 行)。
 */

import { createAgentExecutionLifetime, runAgentLoop, type AgentLoopOptions } from '@onething/core/agent-loop'
import { buildMomentPrompt, parseMomentReply, type MomentComposeInput, type MomentComposer } from '@onething/runtime/pets'
import type { AppSettings } from '@shared/ipc.js'
import { getLogger } from '../logging/index.js'
import { createUtilityProvider, type UtilityProviderRef } from '../providers/utility-provider.js'
import { getSettings } from '../../stores/settings.js'
import { billPetUsage, type SideLineUsage } from '../usage/bill-side-line.js'

const log = getLogger('pets.composer')

/** 一次写词最多等多久(§11.2)。 */
export const PET_COMPOSE_TIMEOUT_MS = 8_000
/** 两句话、60 字,一百来个 token 就够;余量留给不守「关思考」的 provider。 */
const PET_COMPOSE_MAX_TOKENS = 300
/** 没设语言偏好时用什么语言开口。黑豆的 persona 本来就是中文写的。 */
const DEFAULT_LOCALE = 'zh-CN'

export interface ModelMomentComposerPorts {
  settings(): AppSettings
  createProvider(settings: AppSettings): Promise<UtilityProviderRef | undefined>
  runLoop(options: AgentLoopOptions): Promise<{ text?: string; usage?: SideLineUsage }>
  bill(providerId: string, modelId: string): (usage: SideLineUsage) => void
  now(): number
}

const DEFAULT_PORTS: ModelMomentComposerPorts = {
  settings: () => getSettings(),
  createProvider: settings => createUtilityProvider(settings),
  runLoop: options => runAgentLoop(options),
  bill: billPetUsage,
  now: () => Date.now(),
}

/** 本地时间的人话:`2026-09-18 星期五 02:14`。时区跟着这台机器走。 */
export function formatPetLocalTime(at: number): string {
  const date = new Date(at)
  const pad = (n: number) => String(n).padStart(2, '0')
  const weekday = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'][date.getDay()]
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${weekday} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

export class ModelMomentComposer implements MomentComposer {
  private readonly ports: ModelMomentComposerPorts
  private readonly timeoutMs: number
  private warnedUnconfigured = false

  constructor(options: { ports?: Partial<ModelMomentComposerPorts>; timeoutMs?: number } = {}) {
    this.ports = { ...DEFAULT_PORTS, ...options.ports }
    this.timeoutMs = options.timeoutMs ?? PET_COMPOSE_TIMEOUT_MS
  }

  async compose({ pet, moment, memory }: MomentComposeInput): Promise<string | null> {
    const fields = { petId: pet.id, scheme: moment.scheme, event: moment.event }
    try {
      const settings = this.ports.settings()
      const utility = await this.ports.createProvider(settings)
      if (!utility) {
        if (!this.warnedUnconfigured) {
          this.warnedUnconfigured = true
          log.warn('no tool-call model configured; the pet stays quiet (settings.tools.toolCallModel)', fields)
        }
        return null
      }
      this.warnedUnconfigured = false

      const prompt = buildMomentPrompt({
        pet,
        moment,
        memory,
        localTime: formatPetLocalTime(this.ports.now()),
        locale: settings.general?.userProfile?.language || DEFAULT_LOCALE,
      })
      const abort = new AbortController()
      const timer = setTimeout(() => abort.abort(), this.timeoutMs)
      const executionLifetime = createAgentExecutionLifetime()
      let result: { text?: string; usage?: SideLineUsage }
      try {
        result = await this.ports.runLoop({
          provider: utility.provider,
          executionLifetime,
          model: utility.model,
          messages: [
            { role: 'system', content: prompt.system },
            { role: 'user', content: prompt.user },
          ],
          tools: [],
          selectedToolNames: [],
          maxTurns: 1,
          temperature: 0.8,
          maxTokens: PET_COMPOSE_MAX_TOKENS,
          thinking: 'disabled',
          sessionId: `pet:${pet.id}`,
          messageId: `pet:${pet.id}:${moment.event}:${moment.at}`,
          abortSignal: abort.signal,
        })
      } catch (error) {
        log.warn(abort.signal.aborted ? 'pet line timed out' : 'pet line model call failed', { ...fields, timeoutMs: this.timeoutMs }, error)
        return null
      } finally {
        clearTimeout(timer)
        // 不等排干:一只不理会中止的 provider 会让排干一直挂着,而宿主在作曲期间占着说话位 ——
        // 8 秒的上限必须是真的上限。排干在后台跑完。
        void executionLifetime.drain().catch(() => {})
      }
      if (result.usage) this.ports.bill(utility.providerId, utility.model)(result.usage)
      const say = parseMomentReply(result.text ?? '')
      if (say === null) log.debug('pet had nothing to say', { ...fields, reply: (result.text ?? '').slice(0, 200) })
      return say
    } catch (error) {
      log.warn('pet composer failed', fields, error)
      return null
    }
  }
}
