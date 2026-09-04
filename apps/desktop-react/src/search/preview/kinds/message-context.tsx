import { Highlight } from '../../../expose/components/Highlight'
import { useT } from '../../../i18n'
import type { SearchPreviewProps, SearchPreviewRenderer } from '../registry'
import s from '../Preview.module.css'

/**
 * `kind: 'message-context'` —— 命中那条消息 ± 2 条
 * (`runtime/src/search/capabilities/preview.ts` 的 `MessageContextPreview`)。
 *
 * ── 零副作用是硬规矩(§4.5 ④)────────────────────────────────────────────
 * 这个组件**不碰任何 store**:不进会话、不改已读、不动 `locate-message` 那格待办、
 * 不发一条 RPC。它手上只有后端交下来的那份载荷。这不是「暂时还没接」——
 * 预览就该是只读的一眼,接上任何一条写路都是 bug。
 *
 * ── 为什么不复用聊天流的块渲染(与设计的一处出入,已记账)──────────────────
 * §4.5 那张表写的是「画它的既有件 = 聊天流的消息渲染(同一套块)」。落地时发现
 * **喂不进去**:块渲染吃的是 `ChatMessage`(带 steps / toolCalls / 流式态 / 折叠
 * 上下文 / 消息级插件状态),而预览载荷是后端刻意收窄过的四格
 * (`PreviewMessage { id, role, text, timestamp }`)—— 那次收窄是对的(预览要过
 * JSON、只画正文)。为了复用块渲染而在壳里把四格**伪造**成一条 ChatMessage,
 * 等于在聊天流旁边立第二个「消息长什么样」的产地,而且那份伪造件会随 ChatMessage
 * 的每一次演进悄悄失真。所以这里画的是**正文本身**:角色标 + 正文 + 命中那条描一条
 * 左缘线。真要让预览长得跟聊天流一样,治法是让 messages 能力的预览交出真的
 * `ChatMessage`(后端契约改动,自成一批),不是在这里凑。
 *
 * 「工具卡折叠」那一条因此**天然成立**:载荷里根本没有工具卡。
 */

/** 预览里的一条消息(后端 `PreviewMessage` 的同形件;**验而不信**,见下)。 */
interface PreviewMessage {
  id: string
  role: string
  text: string
  timestamp?: number
}

interface MessageContextPayload {
  sessionId: string
  messageId: string
  hit: PreviewMessage
  before: PreviewMessage[]
  after: PreviewMessage[]
}

/** 一条消息的形。缺 `id` / `text` 的当没有 —— 不让一条手搓载荷把整块面拖白。 */
function messageOf(raw: unknown): PreviewMessage | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const { id, role, text, timestamp } = raw as Partial<PreviewMessage>
  if (typeof id !== 'string' || typeof text !== 'string') return undefined
  const shell: PreviewMessage = { id, role: typeof role === 'string' ? role : '', text }
  return typeof timestamp === 'number' ? { ...shell, timestamp } : shell
}

function listOf(raw: unknown): PreviewMessage[] {
  if (!Array.isArray(raw)) return []
  return raw.map(messageOf).filter((m): m is PreviewMessage => m !== undefined)
}

/**
 * 载荷校验。**验而不信**(与目标渲染器的 `payloadOf` 同款):插件能力也在同一张
 * 注册表上,`payload` 是开放的 `unknown`,一条手搓的载荷不许让这块面抛。
 */
export function messageContextPayloadOf(payload: unknown): MessageContextPayload | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined
  const raw = payload as Partial<MessageContextPayload>
  const hit = messageOf(raw.hit)
  if (hit === undefined) return undefined
  return {
    sessionId: typeof raw.sessionId === 'string' ? raw.sessionId : '',
    messageId: typeof raw.messageId === 'string' ? raw.messageId : hit.id,
    hit,
    before: listOf(raw.before),
    after: listOf(raw.after),
  }
}

function Turn({ message, hit, query }: { message: PreviewMessage; hit: boolean; query: string }) {
  const t = useT()
  return (
    <div className={hit ? `${s.turn} ${s.turnHit}` : s.turn} data-preview-turn={hit ? 'hit' : 'context'}>
      <span className={s.role}>
        {/* 角色是**数据**('user' / 'assistant' / 别的什么),而屏幕上那两个字是文案。
          * 认得的两种查字典,认不得的原样画 —— 不去编一个「未知」。 */}
        {message.role === 'user'
          ? t('search.previewRoleUser')
          : message.role === 'assistant'
            ? t('search.previewRoleAssistant')
            : message.role}
      </span>
      {/* 命中那条把词标出来;上下文那几条不标(标了就分不清哪条是命中)。 */}
      <p className={s.turnText}>
        {hit ? <Highlight text={message.text} query={query} /> : message.text}
      </p>
    </div>
  )
}

function MessageContextBody({ payload, query }: SearchPreviewProps) {
  const t = useT()
  const context = messageContextPayloadOf(payload)
  if (context === undefined) return <p className={s.meta}>{t('search.previewMalformed')}</p>
  return (
    <div className={s.body}>
      <div className={s.turns}>
        {context.before.map(message => (
          <Turn key={message.id} message={message} hit={false} query={query} />
        ))}
        <Turn message={context.hit} hit query={query} />
        {context.after.map(message => (
          <Turn key={message.id} message={message} hit={false} query={query} />
        ))}
      </div>
    </div>
  )
}

export const messageContextPreviewRenderer: SearchPreviewRenderer = {
  kind: 'message-context',
  Body: MessageContextBody,
}
