/**
 * R3a —— `resolveScene`:回合入口的场景解析(§5 的 `SceneResolver`)。
 *
 * 旧 `tools/scene-surface.ts` 是一张**集中式减法表**:它逐条知道「协作四件套挂
 * 哪些场子」「goal 只在 active 时给」「工作会话看不见 task」「feature_* 挂哪个
 * skill」,然后吐一串 hidden id。那张表的问题不是它错,是它**放错了地方** ——
 * 一个新工具要露面,改的是一个跟它没有任何代码关系的文件,而漏改不会报错,
 * 只会静静地多给或少给一个工具。
 *
 * 新树把判据搬回工具自己身上(`Tool.visibleIn(scene)`),这里只剩**把会话翻成
 * 一个 `Scene`**:场子、有没有 active 目标、是不是工作会话、本回合启用了哪些
 * skill。四个字段都是**已经归一化过的结论**,内核与工具都不必再认识会话形状。
 *
 * 等价性由 `__tests__/scene.test.ts` 钉住:同一组输入下,
 * `Surface.resolve(...).names()` 与 `resolveSceneHiddenToolIds` 取补集**逐一相等**。
 */

import type { Scene } from '@onething/core/toolkit'
import { resolveCollabVenue } from '../collab/tool-surface.js'
import { isTaskSession, type TaskSessionLike } from '../tasks/index.js'

/** 场景解析读的那一小片会话形状(结构类型 —— 产品层不认 IPC 契约包)。 */
export interface SceneSessionLike extends TaskSessionLike {
  id?: string
  kind?: string | null
  goal?: { status?: string } | null
  workingDirectory?: string
}

export interface ResolveSceneInput {
  session?: SceneSessionLike | null
  /** 本回合启用的 skill **名字**(SKILL.md frontmatter 的 `name`,不是带前缀的 id)。 */
  enabledSkillNames?: Iterable<string> | null
}

export function resolveScene(input: ResolveSceneInput): Scene {
  const session = input.session ?? null
  const skills = [...(input.enabledSkillNames ?? [])]
  return {
    ...(session?.kind ? { kind: session.kind } : {}),
    ...(session?.id ? { sessionId: session.id } : {}),
    skills,
    ...(session?.workingDirectory ? { workspaceRoot: session.workingDirectory } : {}),
    // 认不出的 kind 一律算 `chat` —— 归一化只有一个方向(见场子表的注释:
    // 网关按远端身份建出来的会话 kind 为空,把它读成"说不准,先放过"就是一个
    // 授权洞)。
    venue: resolveCollabVenue(session?.kind ?? undefined),
    goalActive: session?.goal?.status === 'active',
    taskSession: isTaskSession(session),
  }
}
