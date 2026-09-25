import { useMemo } from 'react'
import type { AcpSessionCommand } from '@shared/contracts/acp'
import { BUILTIN_COMMANDS, commandTokenOf } from '../../data/commands-source'
import type { CommandEntry } from '../../data/commands-source'
import { useAcpSessionState } from '../../data/acp-session-state-source'
import { matchCommands } from '../../composer/transitions'
import { registerReferenceKind } from '../registry'
import { commandRow } from './command'
import type { PickContext, PickResult, ReferenceKind } from '../kind'

/**
 * **agent 自报的命令**(A2-c,正本 `docs/design/acp-integration-2026-09.md` §3.8)。
 * `/` 抽屉里的第四组,只在 agent 会话里、而且 agent 推过 `available_commands_update`
 * 之后才有行。
 *
 * ── 它**只有拾取那一格**,与插件命令同一个形 ───────────────────────────────
 * ACP 里命令**就是 prompt 文本**:选中落下的是一枚命令记号 `/name`(`source.kindOf` 交给
 * 命令那一家落稿,于是草稿里的形、出站展成什么、退格整枚删,三样都与内置命令逐字相同),
 * 发送时 `useComposerSend` 的命令岔口查不到它(它不在本地命令表里),于是**原样**当一句话
 * 交给 agent —— 那正是 ACP 要的。所以这里没有 `draft` / `parse` / `render` / `open`。
 *
 * ── 三格从哪来 ──────────────────────────────────────────────────────────
 * 名 = `/` + agent 报的 `name`;说明 = `description`;`inputHint` 当参数的幽灵占位
 * (命令那一家的 `argHint`,落稿后挂在记号后面,不会被发出去)。同名撞上内置命令的
 * 那几条**不进抽屉**:发送时本地那一条先认领(`/compact` 永远是本地压缩),列一行按下去
 * 却跑了另一件事是骗人。
 *
 * ── 取数态 ──────────────────────────────────────────────────────────────
 * 命令表来自会话状态那一格(冷读 + 推送,见 `data/acp-session-state-source.ts`),没有一次
 * 「为抽屉而发」的往返;还没推来就是零行,不是「正在找」—— 抽屉照实答 `ready`,与插件
 * 命令拉失败静默降级同一口径(人此刻在打字选命令,一句「正在等 agent」只会挡路)。
 */

const BUILTIN_TOKENS = new Set(BUILTIN_COMMANDS.map((entry) => commandTokenOf(entry)))

/** 一条 agent 命令 → 抽屉一行的那份形(借命令那一家的 `CommandEntry`,落稿时它读 `name` 与 `argHint`)。 */
export function agentCommandEntry(command: AcpSessionCommand): CommandEntry {
  const name = `/${command.name}`
  const hint = command.inputHint?.trim()
  return {
    id: `agent:${command.name}`,
    kind: 'agent',
    name,
    desc: command.description,
    usage: hint ? `${name} ${hint}` : name,
    insertText: `${name} `,
    allowArgs: true,
    ...(hint ? { argHint: hint } : {}),
  }
}

/** 会话状态里的命令表 → 抽屉候选(撞内置的剔掉,名字不合命令词语法的剔掉)。 */
export function agentCommandEntries(commands: readonly AcpSessionCommand[]): CommandEntry[] {
  const out: CommandEntry[] = []
  const seen = new Set<string>()
  for (const command of commands) {
    const token = command.name.replace(/^\//, '').toLowerCase()
    // 命令词里不许有空白与斜杠(与命令那一家 `COMMAND_HEAD` 同一条刹车):认不回来的记号不落稿。
    if (!token || /[\s/]/.test(token) || BUILTIN_TOKENS.has(token) || seen.has(token)) continue
    seen.add(token)
    out.push(agentCommandEntry({ ...command, name: command.name.replace(/^\//, '') }))
  }
  return out
}

function useAgentCommands(ctx: PickContext): PickResult<CommandEntry> {
  const { active, query, sessionId } = ctx
  const state = useAcpSessionState(sessionId)
  const commands = state?.commands
  const table = useMemo(() => (commands ? agentCommandEntries(commands) : []), [commands])
  const hits = useMemo(() => (active ? matchCommands(table, query) : []), [active, table, query])
  return { hits, status: 'ready' }
}

export const agentCommandReferenceKind: ReferenceKind<CommandEntry, never> = {
  id: 'agent-command',

  source: {
    trigger: '/',
    where: 'line-start',
    tokenChars: ':-',
    group: { key: 'composer.headAgentCommands' },
    hint: 'composer.hintCommand',
    useQuery: useAgentCommands,
    row: commandRow,
    /* 落稿时算**命令**:一条 agent 命令在句子里就是一条命令,agent 只是它的出处。 */
    kindOf: () => 'command',
  },
}

registerReferenceKind(agentCommandReferenceKind, import.meta.hot)
