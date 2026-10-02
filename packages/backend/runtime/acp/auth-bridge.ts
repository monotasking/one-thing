/**
 * ACP agent 的「去登录」(A3-c,方案 `docs/design/acp-integration-2026-09.md` §3.5 / §3.9 ② / §11.3)。
 *
 * 登录是**那家 CLI 自己的流程**,onething 不存凭据、不替谁做 OAuth。我们只做两件事:
 *
 *  - 终端型方法(`type: 'terminal'`):按协议「在配置好的 agent 起法后面**追加**方法给的 args」,
 *    在 onething 的 `TerminalService` 里起一格(owner = 这台 agent),**立刻**把 terminalId 答给壳
 *    —— 壳开终端瓦,人在里面走完那家的登录(开浏览器、贴码……)。那条程序退出码 0 = 成功:
 *    清掉 `auth.required`,并断开这台 agent,让它下一轮带着新凭据重连;非 0 = 失败,`required`
 *    留着,记一行日志。结局经 `acp:agent-state` 推给壳,不另开通道。
 *  - agent 型方法:连上那一台(握手不需要凭据),调它的 `authenticate({ methodId })`。
 *
 * 这台宿主没有终端(server 缺省、CLI daemon)时终端型方法答 `no-terminal` —— 也正因为这样,
 * 握手里的 `auth.terminal` 只在有终端时才声明(`terminalAvailable()`)。
 */
import { homedir } from 'node:os'
import { ACPManager, authMethodsOf } from '@onething/backend/runtime/acp'
import type { AcpAuthBridge, AcpAuthenticateOutcome } from '@onething/backend/runtime/acp'
import type { ACPAgentConfig } from '@shared/contracts/acp'
import {
  getTerminalService,
  hasTerminalHost,
  type TerminalService,
} from '@onething/backend/runtime/terminal/service.wiring'
import { resolveExternalAgentSpawnEnv } from '@onething/backend/wiring/external-agents/spawn-env.js'
import { getLogger } from '@onething/backend/wiring/logging/index.js'

const log = getLogger('acp.auth')

/** 桥用得着的那几件(测试换成假的)。缺省 = 进程里那只 `ACPManager` 与终端服务。 */
export interface AcpAuthBridgeDeps {
  manager?: Pick<
    typeof ACPManager,
    'getAgentState' | 'getAgentHandshake' | 'connectAgent' | 'authenticateAgent' | 'markAgentAuthenticated' | 'disconnectAgent'
  >
  terminal?: () => Pick<TerminalService, 'create' | 'onExit'>
  terminalAvailable?: () => boolean
  spawnEnv?: () => Record<string, string | undefined>
}

/** 握手答复(SDK 的形状只经产品层递过来,装配层不直接 import ACP SDK)。 */
type InitializeResponse = NonNullable<ReturnType<typeof ACPManager.getAgentHandshake>>
type TerminalMethod = { id: string; type: 'terminal'; args?: string[]; env?: Record<string, string> }

function definedEnv(env: Record<string, string | undefined>): Record<string, string> {
  return Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined))
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function createAcpAuthBridge(deps: AcpAuthBridgeDeps = {}): AcpAuthBridge {
  const manager = deps.manager ?? ACPManager
  const terminal = deps.terminal ?? getTerminalService
  const terminalAvailable = deps.terminalAvailable ?? hasTerminalHost
  const spawnEnv = deps.spawnEnv ?? resolveExternalAgentSpawnEnv

  /** 这台 agent 自报的方法表;没连过就先连一次(`initialize` 不需要凭据,方法表就在答复里)。 */
  async function handshakeOf(agentId: string): Promise<InitializeResponse | undefined> {
    const known = manager.getAgentHandshake(agentId)
    if (known) return known
    await manager.connectAgent(agentId)
    return manager.getAgentHandshake(agentId)
  }

  function runTerminalLogin(config: ACPAgentConfig, method: TerminalMethod): AcpAuthenticateOutcome {
    const args = [...(config.args ?? []), ...(method.args ?? [])]
    const info = terminal().create({
      command: config.command,
      args,
      cwd: config.cwd?.trim() || homedir(),
      // 底 = 外部 agent 子进程那一份(进程环境 + 应用代理),再叠这台 agent 自己的 env 与方法的 env。
      env: { ...definedEnv(spawnEnv()), ...(config.env ?? {}), ...(method.env ?? {}) },
      owner: { kind: 'acp', agentId: config.id },
    })
    log.info('terminal login started', { agentId: config.id, methodId: method.id, terminalId: info.id })
    terminal().onExit(info.id, status => {
      if (status.exitCode === 0) {
        log.info('terminal login succeeded', { agentId: config.id, methodId: method.id, terminalId: info.id })
        manager.markAgentAuthenticated(config.id)
        // 凭据落在 agent 自己那里;已经跑着的那个进程未必重读 —— 断开,下一轮自然重连。
        manager.disconnectAgent(config.id).catch(error => {
          log.warn('disconnect after terminal login failed', { agentId: config.id }, error)
        })
        return
      }
      log.warn('terminal login failed', {
        agentId: config.id,
        methodId: method.id,
        terminalId: info.id,
        exitCode: status.exitCode,
        signal: status.signal ?? null,
      })
    })
    return { ok: true, terminalId: info.id }
  }

  return {
    terminalAvailable: () => terminalAvailable(),

    async authenticate(agentId, methodId) {
      const config = manager.getAgentState(agentId)?.config
      if (!config) return { ok: false, code: 'unknown-agent', error: `ACP agent "${agentId}" not found` }

      let handshake: InitializeResponse | undefined
      try {
        handshake = await handshakeOf(agentId)
      } catch (error) {
        log.warn('connect before authenticate failed', { agentId }, error)
        return { ok: false, code: 'failed', error: messageOf(error) }
      }
      const known = authMethodsOf(handshake).find(method => method.id === methodId)
      if (!known) {
        return { ok: false, code: 'unknown-method', error: `ACP agent "${agentId}" did not offer login method "${methodId}"` }
      }

      if (known.type === 'terminal') {
        if (!terminalAvailable()) {
          return { ok: false, code: 'no-terminal', error: '这台机器上没有终端可用,无法在 onething 里跑这种登录' }
        }
        const raw = (handshake?.authMethods ?? []).find(method => method.id === methodId) as unknown as TerminalMethod
        try {
          return runTerminalLogin(config, raw)
        } catch (error) {
          log.warn('terminal login could not start', { agentId, methodId }, error)
          return { ok: false, code: 'failed', error: messageOf(error) }
        }
      }

      try {
        await manager.authenticateAgent(agentId, methodId)
        log.info('agent login succeeded', { agentId, methodId })
        return { ok: true }
      } catch (error) {
        log.warn('agent login failed', { agentId, methodId }, error)
        return { ok: false, code: 'failed', error: messageOf(error) }
      }
    },
  }
}
