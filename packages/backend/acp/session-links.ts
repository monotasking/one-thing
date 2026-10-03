import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import { getOnethingStorePath } from '../storage/paths.js'
import { getLogger } from '../logging/index.js'
import type { ACPSessionOption } from '@shared/contracts/acp.js'
import type { ExternalAgentSessionLink } from '../external-agent/types.js'

const log = getLogger('acp')

/**
 * onething 会话 ↔ agent 会话的**对应关系**,落盘(2026-09-24)。
 *
 * ACP 的会话历史本来就在 agent 自己那里(Claude Code 的 `~/.claude/projects/…jsonl`、
 * pi 的 session 目录);onething 缺的只是「这条会话对的是它哪一条」这一句话。
 * 从前这句话只活在 `ACPClient` 的内存 Map 里 —— 适配器闲置被收、桌面重启、换目录,
 * 下一条消息就 `session/new` 一条空会话,而 onething 每轮只发最后一句,于是 agent
 * 什么都不记得。落了盘,重连时先 `resume` / `load` 回原会话。
 *
 * 顺带记两样东西,都只为了一件事 —— 让选项在「还没有 agent 会话」时也说得出话:
 *  · `link.options`:**这条会话里**用户明确选过的值(不是快照 —— agent 的缺省不钉死);
 *  · `profile.preferred` / `profile.catalog`:这台 agent 上次被选中的值与上次见到的
 *    选项目录。新会话开出来先按 `preferred` 调一遍(CLI 自己也记得上次用的模型);
 *    草稿态(还没有会话 id)画的就是 `catalog`。
 */
export interface ACPSessionLink {
  agentId: string
  localSessionId: string
  acpSessionId: string
  cwd: string
  options: Record<string, string>
  updatedAt: number
  /**
   * 哪个外部 agent 连接器的链接(A0-3 起两条路同吃这一个文件)。缺省 = `'acp'`,此时
   * `agentId` 是 ACP agent 的 id;非 ACP 连接器的记录里 `agentId` 就等于连接器 id,
   * `acpSessionId` 存它自己的外部会话 id。A6-b 起没有非 ACP 连接器了(退役的
   * `claude-code-agent` 记录在读表时并成 ACP `claude-code` 的链接,见 `foldRetiredClaudeLinks`)。
   */
  connectorId?: string
  /** 第一次落盘的时刻;覆盖写时沿用旧值。老记录没有这一格,读时按 `updatedAt` 兜底。 */
  createdAt?: number
}

export interface ACPAgentProfile {
  agentId: string
  preferred: Record<string, string>
  catalog?: ACPSessionOption[]
  updatedAt: number
}

export interface ACPSessionLinkStore {
  getLink(agentId: string, localSessionId: string): ACPSessionLink | undefined
  putLink(link: ACPSessionLink): void
  /** 外部 agent 契约(`ExternalAgentSessionLink`)那一面的读写,落在同一张表上。 */
  getExternalLink(connectorId: string, localSessionId: string): ExternalAgentSessionLink | undefined
  putExternalLink(link: ExternalAgentSessionLink): void
  getProfile(agentId: string): ACPAgentProfile | undefined
  putProfile(profile: ACPAgentProfile): void
  /**
   * 这台 ACP agent 的这条 agent 会话对应着哪些本地会话(A5 认领查重),新的在前。
   * 只看 ACP 连接器的链接。
   */
  findByAcpSession(agentId: string, acpSessionId: string): ACPSessionLink[]
}

interface LinkFile {
  version: 1
  links: Record<string, ACPSessionLink>
  profiles: Record<string, ACPAgentProfile>
}

function emptyFile(): LinkFile {
  return { version: 1, links: {}, profiles: {} }
}

function linkKey(agentId: string, localSessionId: string): string {
  return `${agentId}:${localSessionId}`
}

/** ACP 连接器的 id;外部 agent 契约里它就是 `connectorId`。 */
export const ACP_CONNECTOR_ID = 'acp'

/**
 * A6-b(2026-09-26)退役的 Claude SDK 连接器 id,与它在 ACP 名册里的接班人。SDK 路记下的
 * 外部会话 id 就是 `~/.claude/projects` 里的原生 id,claude-agent-acp 的 `session/resume`
 * 认的也是它 —— 所以并过去只换键与 agent,`acpSessionId` 原样。
 */
const RETIRED_CLAUDE_CONNECTOR_ID = 'claude-code-agent'
const CLAUDE_CODE_ACP_AGENT_ID = 'claude-code'

function connectorOf(link: ACPSessionLink): string {
  return link.connectorId ?? ACP_CONNECTOR_ID
}

function toExternalLink(link: ACPSessionLink): ExternalAgentSessionLink {
  const connectorId = connectorOf(link)
  return {
    localSessionId: link.localSessionId,
    connectorId,
    externalSessionId: link.acpSessionId,
    cwd: link.cwd,
    createdAt: link.createdAt ?? link.updatedAt,
    lastUsedAt: link.updatedAt,
    ...(connectorId === ACP_CONNECTOR_ID ? { agentId: link.agentId } : {}),
  }
}

/** 进程内那一份;测试与无盘宿主用。 */
export class MemoryACPSessionLinkStore implements ACPSessionLinkStore {
  protected data: LinkFile = emptyFile()

  getLink(agentId: string, localSessionId: string): ACPSessionLink | undefined {
    return this.read().links[linkKey(agentId, localSessionId)]
  }

  putLink(link: ACPSessionLink): void {
    const data = this.read()
    const key = linkKey(link.agentId, link.localSessionId)
    const createdAt = link.createdAt ?? data.links[key]?.createdAt ?? link.updatedAt
    data.links[key] = { ...link, createdAt }
    this.write(data)
  }

  /**
   * ACP 那一路一台连接器背后是很多台 agent,契约的查询只给了连接器 id —— 取这条本地
   * 会话在任一台 ACP agent 上最近用过的那条。其他连接器按 `连接器id:会话id` 直查。
   */
  getExternalLink(connectorId: string, localSessionId: string): ExternalAgentSessionLink | undefined {
    if (connectorId !== ACP_CONNECTOR_ID) {
      const link = this.read().links[linkKey(connectorId, localSessionId)]
      return link && connectorOf(link) === connectorId ? toExternalLink(link) : undefined
    }
    let latest: ACPSessionLink | undefined
    for (const link of Object.values(this.read().links)) {
      if (connectorOf(link) !== ACP_CONNECTOR_ID || link.localSessionId !== localSessionId) continue
      if (!latest || link.updatedAt > latest.updatedAt) latest = link
    }
    return latest ? toExternalLink(latest) : undefined
  }

  /**
   * 契约那一面的写。ACP 链接由 `ACPClient` 开会话时已经带着选项写过,这里只刷新会话 id、
   * 目录与时间,**不动 `options`**;缺 `agentId` 的 ACP 链接无从落位,记一行 warn 丢掉。
   */
  putExternalLink(link: ExternalAgentSessionLink): void {
    if (link.connectorId === ACP_CONNECTOR_ID) {
      if (!link.agentId) {
        log.warn('acp session link without agent id dropped', { sessionId: link.localSessionId })
        return
      }
      const existing = this.getLink(link.agentId, link.localSessionId)
      this.putLink({
        agentId: link.agentId,
        localSessionId: link.localSessionId,
        acpSessionId: link.externalSessionId,
        cwd: link.cwd,
        options: existing?.options ?? {},
        createdAt: existing?.createdAt ?? link.createdAt,
        updatedAt: link.lastUsedAt,
      })
      return
    }
    this.putLink({
      agentId: link.connectorId,
      connectorId: link.connectorId,
      localSessionId: link.localSessionId,
      acpSessionId: link.externalSessionId,
      cwd: link.cwd,
      options: {},
      createdAt: link.createdAt,
      updatedAt: link.lastUsedAt,
    })
  }

  getProfile(agentId: string): ACPAgentProfile | undefined {
    return this.read().profiles[agentId]
  }

  findByAcpSession(agentId: string, acpSessionId: string): ACPSessionLink[] {
    return Object.values(this.read().links)
      .filter(link => connectorOf(link) === ACP_CONNECTOR_ID && link.agentId === agentId && link.acpSessionId === acpSessionId)
      .sort((a, b) => b.updatedAt - a.updatedAt)
  }

  putProfile(profile: ACPAgentProfile): void {
    const data = this.read()
    data.profiles[profile.agentId] = profile
    this.write(data)
  }

  protected read(): LinkFile {
    return this.data
  }

  protected write(data: LinkFile): void {
    this.data = data
  }
}

/**
 * `<store>/acp/session-links.json`。读一次进内存,写是整份原子替换(先写 `.tmp` 再
 * rename)—— 一个坏档不该让整张表丢掉,读不出来就当空表并记一行 warn。
 * 路径**按调用时**解析,`ONETHING_STORE_PATH` 在装配后才钉也不受影响。
 */
export class FileACPSessionLinkStore extends MemoryACPSessionLinkStore {
  private loadedFrom: string | undefined

  constructor(
    private readonly pathOf: () => string = defaultLinksPath,
    /** A0-3 之前 Claude 路自己那份表;首次读时并进来,旧文件不删。`() => undefined` 关掉。 */
    private readonly legacyExternalPathOf: () => string | undefined = defaultLegacyExternalLinksPath,
  ) {
    super()
  }

  protected override read(): LinkFile {
    const path = this.pathOf()
    if (this.loadedFrom !== path) {
      this.data = loadLinkFile(path)
      this.loadedFrom = path
      const legacyPath = this.legacyExternalPathOf()
      const legacyFolded = legacyPath ? foldLegacyExternalLinks(this.data, legacyPath, path) : false
      const retiredFolded = foldRetiredClaudeLinks(this.data, path)
      if (legacyFolded || retiredFolded) this.write(this.data)
    }
    return this.data
  }

  protected override write(data: LinkFile): void {
    this.data = data
    const path = this.pathOf()
    this.loadedFrom = path
    try {
      mkdirSync(dirname(path), { recursive: true })
      const tmp = `${path}.tmp`
      writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8')
      renameSync(tmp, path)
    } catch (error) {
      log.warn('session link write failed', { path }, error)
    }
  }
}

function defaultLinksPath(): string {
  return join(getOnethingStorePath(), 'acp', 'session-links.json')
}

function defaultLegacyExternalLinksPath(): string {
  return join(getOnethingStorePath(), 'external-agents', 'session-links.json')
}

/**
 * 把旧的 `<store>/external-agents/session-links.json` 并进来:只补这边没有的键,
 * 所以重复执行是空操作。答「这次并进了东西没有」,调用方据此决定要不要写回。
 */
function foldLegacyExternalLinks(data: LinkFile, legacyPath: string, targetPath: string): boolean {
  if (!existsSync(legacyPath)) return false
  let legacy: Record<string, Partial<ExternalAgentSessionLink>>
  try {
    legacy = JSON.parse(readFileSync(legacyPath, 'utf8')) as Record<string, Partial<ExternalAgentSessionLink>>
  } catch (error) {
    log.warn('legacy external session links unreadable; skipped', { path: legacyPath }, error)
    return false
  }
  let folded = 0
  for (const entry of Object.values(legacy ?? {})) {
    if (!entry?.connectorId || !entry.localSessionId || !entry.externalSessionId) continue
    // 退役的 Claude SDK 链接直接落成 ACP `claude-code` 那一格 —— 旧文件不删,并成旧键的话
    // 每次读表都会被 `foldRetiredClaudeLinks` 再搬一次、再写一次盘。
    const retired = entry.connectorId === RETIRED_CLAUDE_CONNECTOR_ID
    const key = retired
      ? linkKey(CLAUDE_CODE_ACP_AGENT_ID, entry.localSessionId)
      : linkKey(entry.connectorId, entry.localSessionId)
    if (data.links[key]) continue
    const updatedAt = entry.lastUsedAt ?? entry.createdAt ?? Date.now()
    data.links[key] = {
      ...(retired
        ? { agentId: CLAUDE_CODE_ACP_AGENT_ID }
        : { agentId: entry.connectorId, connectorId: entry.connectorId }),
      localSessionId: entry.localSessionId,
      acpSessionId: entry.externalSessionId,
      cwd: entry.cwd ?? '',
      options: {},
      createdAt: entry.createdAt ?? updatedAt,
      updatedAt,
    }
    folded += 1
  }
  if (folded > 0) log.info('legacy external session links folded', { from: legacyPath, into: targetPath, count: folded })
  return folded > 0
}

/**
 * A6-b:表里 `connectorId: 'claude-code-agent'` 的记录(A0-3 起 SDK 路也写这张表)并成 ACP
 * `claude-code` 的链接:键 `claude-code:<本地会话>`、`agentId: 'claude-code'`、不带
 * `connectorId`(= ACP),`acpSessionId` / `cwd` / 时间原样。那格已有 ACP 链接就留 ACP 的
 * (更新的那条路写的)。旧键一律删,所以只搬一次。答「这次动了没有」。
 */
function foldRetiredClaudeLinks(data: LinkFile, targetPath: string): boolean {
  let moved = 0
  for (const [key, link] of Object.entries(data.links)) {
    if (connectorOf(link) !== RETIRED_CLAUDE_CONNECTOR_ID) continue
    delete data.links[key]
    moved += 1
    const target = linkKey(CLAUDE_CODE_ACP_AGENT_ID, link.localSessionId)
    if (data.links[target]) continue
    data.links[target] = {
      agentId: CLAUDE_CODE_ACP_AGENT_ID,
      localSessionId: link.localSessionId,
      acpSessionId: link.acpSessionId,
      cwd: link.cwd,
      options: link.options ?? {},
      createdAt: link.createdAt ?? link.updatedAt,
      updatedAt: link.updatedAt,
    }
  }
  if (moved > 0) log.info('retired claude-code-agent session links folded into acp', { path: targetPath, count: moved })
  return moved > 0
}

function loadLinkFile(path: string): LinkFile {
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch {
    return emptyFile()
  }
  try {
    const parsed = JSON.parse(raw) as Partial<LinkFile>
    return {
      version: 1,
      links: parsed.links && typeof parsed.links === 'object' ? parsed.links : {},
      profiles: parsed.profiles && typeof parsed.profiles === 'object' ? parsed.profiles : {},
    }
  } catch (error) {
    log.warn('session link file unreadable; starting empty', { path }, error)
    return emptyFile()
  }
}
