/**
 * session-command(会话命令总线)的渲染侧客户端 —— 结构债 P4c 第四批。
 *
 * 形状照 `skills-client.ts` / `media-client.ts` 的判例:壳外一个模块 + 通用
 * `platformApi.rpcInvoke`,四壳零改动;**不包一层旧签名** —— 被删掉的
 * `platformApi.emitCommand(sessionId, command)` 是位置参数的,这里一律是信封:
 * `sessionCommands.emit({ sessionId, command })`。
 *
 * 这条客户端比别的域多做一件事:**mentions 拍平**。它原来在
 * `preload/bridge.ts` 的 `emitCommand` 包装里 —— 通用的 `rpcInvoke` 不该认识
 * 任何一个域的载荷,所以它跟着调用点走(与 collab 迁移时「结构化克隆防线从
 * 桥挪到调用点」同一判例)。拍平只负责**变成普通对象**,不负责挑字段:
 * 逐字段白名单曾把 `kind`/`userHandle` 悄悄剥掉,于是 `@用户` 只在桌面这条
 * 通道上失效。挪到这里之后两条传输面跑的是同一份拍平。
 */
import type { SessionCommand } from '@shared/events'
import type { ChatMessageMention } from '@shared/ipc/chat.js'
import { sessionCommandRouter } from '@shared/ipc/session-command.js'
import { platformApi } from './index'
import { createRouterClient } from './router-client'

/**
 * 把 mentions 变成可 `structuredClone` 的普通对象。
 *
 * `kind` 缺省是 `'agent'`,那一条**不写这个键** —— 老转录里它本来就不存在,
 * 拍平不该给整仓凭空长出一批 `kind:'agent'`。用户那一条的 `agentId` 是空串
 * (docs/design/collab-handle-codec.md §2.3),身份全在 kind/句柄上。
 */
export function withPlainCommandMentions(command: SessionCommand): SessionCommand {
  const mentions = (command as { mentions?: unknown })?.mentions
  if (!Array.isArray(mentions)) return command
  return {
    ...command,
    mentions: (mentions as Partial<ChatMessageMention>[]).map(mention => ({
      agentId: String(mention?.agentId ?? ''),
      label: String(mention?.label ?? ''),
      ...(mention?.kind === 'user'
        ? {
            kind: 'user' as const,
            ...(mention?.userHandle ? { userHandle: String(mention.userHandle) } : {}),
          }
        : {}),
    })),
  } as SessionCommand
}

const client = createRouterClient(sessionCommandRouter, request =>
  platformApi.rpcInvoke(request),
)

export const sessionCommands = {
  emit: (request: { sessionId: string; command: SessionCommand }) =>
    client.emit({
      sessionId: request.sessionId,
      command: withPlainCommandMentions(request.command),
    }),
}
