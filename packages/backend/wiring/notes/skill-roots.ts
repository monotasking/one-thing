/**
 * 「技能来源库」投影成技能自定义根(P3,`docs/design/notes-obsidian-cli-2026-09.md` §4.4)。
 *
 * 用户在设置页给某个库勾上「技能来源」,那个库的根就进 `listCustomSkillRoots()`
 * —— 与接入目录**同一条 `custom:` 链路**(递归、`custom:<dirId>:<rel>` 的 id、
 * 同一套启用/绑定覆盖),而不是从前 note-skills 插件那条 `plugin:<id>:<sha1>:<rel>`
 * 的链路:后者的 id 里嵌的是绝对路径的哈希,用户挪一次库,settings 里针对这些
 * 技能的覆盖全成孤儿(判词逐字见 `stores/connected-directories.ts`)。
 *
 * ## 那一段 `<note_skill_context>`,以及它为什么要缓存
 *
 * 从前这段 JSON 由 note-skills 插件现算:它自己往上找 `.obsidian`、自己读
 * `app.json` 的 `attachmentFolderPath`。今天问的是**库自己**(`NoteVault`),于是
 * 「附件该落哪」只有一个产地,Obsidian 活着时答的还是 Obsidian 自己的话。
 *
 * 代价是这个答案是 `Promise`(库可能要问一次 app,也可能要读一次快照),而技能
 * 加载器整条链是**同步**的(`loadAllSkills()` → `SessionSkillsCache`,十几个调用
 * 点)。所以这里的形是:**问过一次就记住,没问过就先省掉那一格并在后台去问**,
 * 答案落定时喊一声 `onResolved`(接的是 `invalidateSessionSkillsCache`),下一次
 * 加载就带上了。省掉比编一个强 —— 与 `NoteReadOptions.offline` 同一条判据。
 *
 * 缓存的键是 **(库 id, 技能目录)**,不是库:Obsidian 的 `attachmentFolderPath`
 * 有「文档同目录」这一档,同一个库里两个技能的落点可以不同。
 */

import * as path from 'node:path'
import type { NoteVault } from '@onething/runtime/notes'

/**
 * 一个技能根。形状是技能加载器的 `SkillDirectoryConfig` 加一格
 * `instructionContext` —— 那一格是**运行期语境**,不进 `settings.json`,所以它
 * 不在 `@shared/ipc` 的那份契约上。
 */
export interface NoteSkillRoot {
  id: string
  path: string
  label?: string
  agentId?: string | null
  enabled: boolean
  instructionContext(input: { skillDir: string; rootDir: string }): string
}

export interface NoteSkillRootsPorts {
  /** 勾了「技能来源」的库,**现取**(库表会变,快照会过期)。 */
  listVaults(): NoteVault[]
  /** 一格附件目录刚算出来:技能缓存该重扫了。 */
  onResolved?(): void
  logger?: { warn(message: string, fields?: Record<string, unknown>, error?: unknown): void }
}

/** 探附件目录用的假文件名。只取 `dirname`,这个文件从不被创建。 */
const PROBE_FILE_NAME = 'onething-note-skill-probe.md'

export class NoteSkillRoots {
  /** (库 id, 技能目录) → 附件目录;`null` = 问过了,库答不出。 */
  private readonly attachmentDirs = new Map<string, string | null>()
  private readonly pending = new Set<string>()

  constructor(private readonly ports: NoteSkillRootsPorts) {}

  list(): NoteSkillRoot[] {
    return this.ports.listVaults().map(vault => ({
      // dirId 与路径无关(库 id 才是身份),挪库不改 id —— 覆盖不会成孤儿。
      id: `note-vault:${vault.id}`,
      path: vault.root,
      label: vault.name,
      agentId: null,
      enabled: true,
      instructionContext: (input: { skillDir: string; rootDir: string }) =>
        this.contextFor(vault, input),
    }))
  }

  /** 库表变了 / 这台后端要收摊了:记住的落点全作废。 */
  reset(): void {
    this.attachmentDirs.clear()
    this.pending.clear()
  }

  private contextFor(vault: NoteVault, input: { skillDir: string; rootDir: string }): string {
    const skillDirectory = path.resolve(input.skillDir)
    const key = `${vault.id}\u0000${skillDirectory}`
    const known = this.attachmentDirs.get(key)
    if (known === undefined) void this.resolveAttachmentDir(vault, key, skillDirectory)

    const payload: Record<string, unknown> = {
      note_root: path.resolve(input.rootDir),
      skill_directory: skillDirectory,
      // `system` 只给人看 —— 这里把它原样交给模型,消费方一个笔记系统的名字都不认识。
      note_system: vault.system,
    }
    // 答不出就**省掉这一格**,而不是给一个编的目录:模型据它写文件。
    if (known) payload.attachment_directory = known

    return `<note_skill_context>\n${JSON.stringify(payload, null, 2)}\n</note_skill_context>`
  }

  private async resolveAttachmentDir(vault: NoteVault, key: string, skillDir: string): Promise<void> {
    if (this.pending.has(key)) return
    this.pending.add(key)
    try {
      const file = await vault.attachmentPathFor(PROBE_FILE_NAME, path.join(skillDir, PROBE_FILE_NAME))
      this.attachmentDirs.set(key, path.dirname(file))
      this.ports.onResolved?.()
    } catch (error) {
      // 库现在答不了(app 没跑且连快照都没有)。记 `null` 免得每一次加载都再问一遍;
      // 下一次 `refresh` 会把它清掉,那时库可能已经答得上了。
      this.attachmentDirs.set(key, null)
      this.ports.logger?.warn(
        'resolving the attachment directory for a note skill root failed',
        { vaultId: vault.id, skillDir },
        error,
      )
    } finally {
      this.pending.delete(key)
    }
  }
}
