import {
  acpRouter,
  type ACPSessionOption,
  type ACPSessionOptionsRequest,
  type ACPSessionOptionsResponse,
  type ACPSetSessionOptionRequest,
} from '@shared/ipc/acp'
import { createMutation, createQueryFamily, type Mutation } from './kernel'
import { notify } from '../services/notify'
import { t } from '../i18n'

/**
 * **ACP agent 自述的会话选项**(2026-09-24,用户:「ACP 应该是直接用 agent,我们只是
 * 一个会话的映射」「选择模型是切换 cli,没办法切换模型」)。
 *
 * 模型选择器里「ACP › Claude Code」那一行选的是**哪台 agent**;这台 agent 自己用哪个
 * 模型、什么模式、思考几档,是它在自己的会话里列出来的(ACP `configOptions`),
 * onething 不认识其中任何一格 —— 列什么画什么,选中原样交回。这只文件是那一格的
 * 读(按「agent × 会话」一格一份)与写。
 *
 * 草稿态(还没有会话 id)后端不起 agent 进程,答的是这台 agent 上次见过的目录,
 * `live: false`;屏上据此说一句「发出第一条消息后生效」。
 */

export interface AcpOptionsView {
  options: ACPSessionOption[]
  live: boolean
}

export interface AcpOptionsPort {
  sessionOptions(request: ACPSessionOptionsRequest): Promise<ACPSessionOptionsResponse>
  setSessionOption(request: ACPSetSessionOptionRequest): Promise<ACPSessionOptionsResponse>
}

let port: AcpOptionsPort | undefined
let pending: Promise<AcpOptionsPort> | undefined

/** 测试用:换掉端口实现。传 undefined 恢复真实现。 */
export function configureAcpOptionsPort(next: AcpOptionsPort | undefined): void {
  port = next
  pending = undefined
}

async function realPort(): Promise<AcpOptionsPort> {
  const { onethingClient } = await import('../platform/connection')
  const api = (await onethingClient()).api(acpRouter)
  return {
    sessionOptions: (request) => api.sessionOptions(request),
    setSessionOption: (request) => api.setSessionOption(request),
  }
}

function acpOptionsPort(): Promise<AcpOptionsPort> {
  if (port) return Promise.resolve(port)
  pending ??= realPort()
  return pending
}

/** 一格 = 一台 agent × 一条会话(草稿是空串)。分隔符取一个 id 里不会出现的字。 */
const SEP = '\u0000'

export function acpOptionsKey(agentId: string, sessionId: string | null | undefined): string {
  return `${agentId}${SEP}${sessionId ?? ''}`
}

function parseKey(key: string): { agentId: string; sessionId?: string } {
  const [agentId = '', sessionId = ''] = key.split(SEP)
  return sessionId ? { agentId, sessionId } : { agentId }
}

function viewOf(response: ACPSessionOptionsResponse): AcpOptionsView {
  if (!response.success) throw new Error(response.error || 'acp.sessionOptions 未成功')
  return { options: response.options, live: response.live }
}

export const acpOptionsQuery = createQueryFamily<AcpOptionsView>('acp.sessionOptions', async (ctx) =>
  viewOf(await (await acpOptionsPort()).sessionOptions(parseKey(ctx.key))),
)

export interface SetAcpOptionInput {
  agentId: string
  sessionId: string | null | undefined
  optionId: string
  value: string
}

/** 律③的那一格:忙态长在被改的那一个选项上。 */
export function acpOptionPendingKey(agentId: string, sessionId: string | null | undefined, optionId: string): string {
  return `${acpOptionsKey(agentId, sessionId)}${SEP}${optionId}`
}

export const setAcpOptionMutation: Mutation<SetAcpOptionInput, void> = createMutation<SetAcpOptionInput, void>(
  'acp.setSessionOption',
  {
    key: (input) => acpOptionPendingKey(input.agentId, input.sessionId, input.optionId),
    optimistic: (input) =>
      acpOptionsQuery.get(acpOptionsKey(input.agentId, input.sessionId)).patch((prev) =>
        prev
          ? {
              ...prev,
              options: prev.options.map((option) =>
                option.id === input.optionId ? { ...option, currentValue: input.value } : option,
              ),
            }
          : prev,
      ),
    run: async (input) => {
      viewOf(
        await (await acpOptionsPort()).setSessionOption({
          agentId: input.agentId,
          ...(input.sessionId ? { sessionId: input.sessionId } : {}),
          optionId: input.optionId,
          value: input.value,
        }),
      )
    },
    onError: (error) => {
      notify({
        level: 'error',
        source: 'composer.acp-options',
        title: t('composer.agentOptionFailed'),
        body: error.message,
        detail: error.message,
      })
    },
    settle: (_result, input) => acpOptionsQuery.invalidate(acpOptionsKey(input.agentId, input.sessionId)),
  },
)
