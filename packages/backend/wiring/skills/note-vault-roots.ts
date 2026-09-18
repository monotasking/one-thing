/**
 * 「笔记库变了 → 技能缓存作废」的那一根线(P3,正本 §4.4)。
 *
 * 技能根里有一类是**算出来的**:勾了「技能来源」的笔记库
 * (`wiring/skills/loader.ts` 的 `listCustomSkillRoots`)。那张表会变 —— 用户在
 * 设置页勾掉一个库、Obsidian 的名册多了一本、宿主的信任状态翻了面 —— 而技能是
 * **进程级缓存一次**的(`SessionSkillsCache`)。不接这根线,勾掉的库里的技能会
 * 一直活到下一次别的事情碰巧让缓存失效为止。
 *
 * 订的是**笔记域的产物**(`NotesSubsystem.onRefreshed`)而不是 `settings:changed`
 * ——与 `wiring/search/index.ts` 同一条判例:库表由笔记域算,订设置会读到上一份。
 *
 * 第二条线是同一件事的另一半:一个笔记库答「附件该放哪」是异步的,而技能加载器
 * 整条链是同步的,所以第一次加载必然省掉 `<note_skill_context>` 里那一格;库答
 * 上来之后喊一声 `onSkillContextResolved`,这里再失效一次,下一次加载就带上了
 * (判词在 `wiring/notes/skill-roots.ts` 文件头)。
 */

import { getNotesSubsystemSafe } from '../notes/index.js'
import { invalidateSessionSkillsCache } from './session-skills.js'

/**
 * 装配入口。返回的 disposer 由 `backend.ts` 的 `own()` 接住。
 *
 * 没有笔记子系统(还没装配、或这台宿主没有笔记领域)= 这根线不存在,返回一个
 * 空 disposer。
 */
export function bootstrapNoteVaultSkillRoots(): () => void {
  const notes = getNotesSubsystemSafe()
  if (notes === null) return () => undefined
  const offRefreshed = notes.onRefreshed(() => invalidateSessionSkillsCache())
  const offResolved = notes.onSkillContextResolved(() => invalidateSessionSkillsCache())
  return () => {
    offRefreshed()
    offResolved()
  }
}
