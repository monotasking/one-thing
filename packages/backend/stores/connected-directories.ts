/**
 * 「接入目录」的单一读出口。
 *
 * 用户在设置里加一个目录,它同时获得五件套能力:@ 引用 / 搜索 /
 * **直接编辑(免逐次确认)** / SKILL.md 自动发现 / markdown 附件根。
 * 五个接线点散在四个子系统里,但它们必须看见**同一份清单** —— 五处各读一次
 * settings 就是五份判据,迟早在某个归一细节上分家(而其中一处是权限面)。
 *
 * 所以这里是唯一的读点,下面五个接线点全部从这里取:
 *   1. `files/file-search.ts`            @ / 文件选择器根
 *   2. `search/providers.ts`             搜索根
 *   3. `tools/sandbox.ts`                沙箱可写根(权限面)
 *   4. `app/skills/loader.ts`            技能发现根
 *   5. `app/markdown/asset-service.ts`   markdown 附件根
 *
 * 存在性不在这里判:目录可以后挂后建,而且这个函数在 analyze 热路径上被调用
 * (每次 write/edit 审批判定一次),不能每次都去 stat 盘。不存在的目录在各
 * 接线点自然降级 —— 沙箱根永不匹配、技能扫描跳过、搜索列不出东西 —— 都不炸。
 *
 * ## 三层语义(批 B2)
 *
 * 生效接入目录 = **全局层 ∪ 会话归属 space 的 overlay**。
 *  - 全局层 `settings.tools.connectedDirectories` 继续存在、全空间共享(零迁移);
 *  - space overlay(`workspaces/<id>/space.json`)是**追加集**,只加不减。
 *
 * 取哪个 space 由「**会话归属**」决定,不是「当前 space」—— A 空间的会话在跑时
 * 用户切到 B,那条流的工具执行必须仍然取 A 的目录(设计盲点 1)。所以入口是
 * `getConnectedDirectoriesForSession(sessionId)`,而**拿不到 sessionId 的调用面
 * 一律退回纯全局层**(诚实降级),绝不去猜「用户现在在看哪个空间」—— 猜错的那
 * 一次是权限面。
 */

import { normalizeConnectedDirectories } from '@shared/defaults/settings.js'
import type { SkillDirectoryConfig } from '@shared/ipc/skills.js'
import {
  getSpaceOverlayConnectedDirectories,
  mergeConnectedDirectories,
} from '@onething/runtime/spaces/overlay'
import { resolveSessionSpaceId } from './sessions.js'
import { getSettings } from './settings.js'

/**
 * **全局层**接入目录(绝对路径、去重、已过归一)。默认空数组。
 *
 * 这是没有会话语境时的诚实答案,也是所有 space 的共同底座。需要「这条会话看得见
 * 什么」时用 `getConnectedDirectoriesForSession`。
 */
export function getConnectedDirectories(): string[] {
  return normalizeConnectedDirectories(getSettings().tools?.connectedDirectories)
}

/**
 * 会话归属的 space id —— 批 B3 起搬到 `./sessions.ts`(它是会话表的投影,不是
 * 目录概念)。这里保留一个再导出,是因为它与下面两个函数在同一句语义上成对出现。
 */
export { resolveSessionSpaceId }

/** 指定 space 的生效接入目录 = 全局层 ∪ 该 space overlay。 */
export function getConnectedDirectoriesForSpace(spaceId: string | undefined | null): string[] {
  return mergeConnectedDirectories(
    getConnectedDirectories(),
    getSpaceOverlayConnectedDirectories(spaceId),
  )
}

/**
 * 某条会话的生效接入目录。**没有 sessionId 就只给全局层** —— 不回落到「当前
 * 空间」,那是一个后端根本不持有的概念(currentSpaceId 是 window 级状态)。
 */
export function getConnectedDirectoriesForSession(
  sessionId: string | undefined | null,
): string[] {
  if (!sessionId) return getConnectedDirectories()
  return getConnectedDirectoriesForSpace(resolveSessionSpaceId(sessionId))
}

/**
 * 接入目录投影成技能自定义根。
 *
 * 复用 `listCustomSkillRoots` 那条既有链路,而不是 note-skills 的插件链路:
 * 后者的技能 id 里嵌的是**绝对路径的 sha1**(`plugin:<id>:<hash>:<rel>`),
 * 用户挪一次目录,settings 里所有针对这些技能的启用/绑定覆盖就全成孤儿;
 * 而且它会给每个技能强塞 note 语义的 `<note_skill_context>`。
 * 自定义根这条链的 id 是 `custom:<dirId>:<rel>`,dirId 与路径无关,挪目录 id 不变。
 *
 * dirId 用 `connected:` 前缀 + 路径,和用户在技能页手工加的目录(`dir-<ts>-<rand>`)
 * 天然不撞;而技能设置页读的是 `settings.skills.customDirectories` **原始值**,
 * 不经过这个适配器,所以这些合成根不会漏进那个列表里去。
 *
 * **批 B2 起明确停留在全局层**:技能根是进程级的一份扫描结果(加载一次、全局
 * 缓存、没有会话语境),把 space overlay 掺进去等于让「哪些技能存在」取决于扫描
 * 发生时恰好是哪个空间 —— 那比不做更糟。space 维度的技能根等技能加载本身变成
 * 按会话解析时再说。
 */
export function listConnectedSkillRoots(): SkillDirectoryConfig[] {
  return getConnectedDirectories().map(path => ({
    id: `connected:${path}`,
    path,
    label: path,
    agentId: null,
    enabled: true,
  }))
}
