import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import { getOnethingStorePath } from '../storage/paths.js'
import { getLogger } from '../logging/index.js'
import type { ACPSessionOption } from './types.js'

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
  getProfile(agentId: string): ACPAgentProfile | undefined
  putProfile(profile: ACPAgentProfile): void
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

/** 进程内那一份;测试与无盘宿主用。 */
export class MemoryACPSessionLinkStore implements ACPSessionLinkStore {
  protected data: LinkFile = emptyFile()

  getLink(agentId: string, localSessionId: string): ACPSessionLink | undefined {
    return this.read().links[linkKey(agentId, localSessionId)]
  }

  putLink(link: ACPSessionLink): void {
    const data = this.read()
    data.links[linkKey(link.agentId, link.localSessionId)] = link
    this.write(data)
  }

  getProfile(agentId: string): ACPAgentProfile | undefined {
    return this.read().profiles[agentId]
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

  constructor(private readonly pathOf: () => string = defaultLinksPath) {
    super()
  }

  protected override read(): LinkFile {
    const path = this.pathOf()
    if (this.loadedFrom !== path) {
      this.data = loadLinkFile(path)
      this.loadedFrom = path
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
