import { useEffect, useMemo } from 'react'
import { withoutBuiltinCollisions } from '../../data/commands-source'
import type { CommandEntry } from '../../data/commands-source'
import { useSkillsSource } from '../../data/skills-source'
import { matchCommands } from '../../composer/transitions'
import { openSkillDirectory } from '../../content/skill-open'
import { registerReferenceKind } from '../registry'
import { commandDraft, commandRow } from './command'
import s from '../../content/user-message.module.css'
import type { PickContext, PickResult, ReferenceKind } from '../kind'

/**
 * **技能引用** `/skill:<名字>`。
 *
 * ── 它有**两种形**,而那不是一种的两个来源 ────────────────────────────────
 *  · **正文形** `{kind:'skill'}` —— 只有一个名字(老会话、或者引擎没展开的那一条);
 *  · **部件形** `{kind:'skillRef'}` —— 引擎把 `/skill:<name>` 折成 `contentParts`
 *    里的一格 `skill-ref`,它**带着 `skillId`**。
 * 「打开它所在的目录」要的正是那个 id,所以前者不可点、后者可点。两形同皮同字,
 * 差的只是那一格能力 —— 所以它们是同一种引用的两条认出路,不是两种引用。
 *
 * ── 账本上那条消息的 `content` 是**模型版** ────────────────────────────────
 * 引擎收到用户消息后跑 `resolvePromptReferences`,`formatSkillForModel` 把整份
 * SKILL.md 内联进 `content`;显示版在 `contentParts`。照着 `content` 画就是把
 * 整份 SKILL.md 摆进气泡 —— 那正是 09-12 报障要治的病,而治法就是这一格
 * `parse.part`:**绝不画 `part.content`**。
 */

/** 正文形与部件形共用的那一个字。它只有一处。 */
const SKILL_MARK = '◇'

/** `/skill:<name>` 的前缀。技能与普通命令的分界只有这一处。 */
const SKILL_HEAD = /^\/skill:([A-Za-z0-9_-]+)(?=\s|$)/

type SkillRef =
  | { kind: 'skill'; token: string; name: string }
  | { kind: 'skillRef'; skillId: string; name: string }

/**
 * 技能表**懒拉一次、按 cwd**。
 *
 * 键是 cwd:契约上 `getAll` 收 `workingDirectory`,而「项目根下的技能按它发现」
 * —— 换一条工作目录看得见的技能表就不同,拿上一条的表去画是说谎。
 * 拉失败**不弹提示**(人此刻正在打字选命令,一条 toast 只会挡住他要点的那一行),
 * 抽屉里于是只是没有「技能」那一组 —— 所以这一格照实答 `ready`:
 * 静默降级的意思就是「没有取数态要说给抽屉听」。
 */
function useSkillCommands(ctx: PickContext): PickResult<CommandEntry> {
  const { active, query, cwd } = ctx
  const commands = useSkillsSource((st) => st.commands)
  const ensureSkills = useSkillsSource((st) => st.ensureSkills)
  useEffect(() => {
    if (!active) return
    void ensureSkills(cwd)
  }, [active, cwd, ensureSkills])
  const hits = useMemo(
    () => (active ? matchCommands(withoutBuiltinCollisions(commands), query) : []),
    [active, commands, query],
  )
  return { hits, status: 'ready' }
}

export const skillReferenceKind: ReferenceKind<CommandEntry, SkillRef> = {
  id: 'skill',

  source: {
    trigger: '/',
    where: 'line-start',
    tokenChars: ':-',
    group: { key: 'composer.headSkills' },
    hint: 'composer.hintCommand',
    useQuery: useSkillCommands,
    row: commandRow,
  },

  // 落稿与命令逐字同一种形(徽 + 空格 + 参数占位)—— 技能引用本来就是一条命令。
  draft: commandDraft,

  parse: {
    text: {
      pattern: SKILL_HEAD,
      at: 'start',
      /*
       * 比普通命令**更具体**:`/skill:commit` 两条正则都命中,同一位置上先试
       * 具体的那一条。判据写成一个数而不是「命令那边排除 skill」—— 后者是让一种
       * 引用去认识另一种的名字,那正是这一单要拆掉的形状。
       */
      specificity: 1,
      toRef: (m) => ({
        ref: { kind: 'skill' as const, token: m[0], name: m[1] },
        start: m.index,
        end: m.index + m[0].length,
      }),
    },
    part: {
      type: 'skill-ref',
      toRef: (part) =>
        part.skillId
          ? { kind: 'skillRef', skillId: part.skillId, name: part.name || part.skillId }
          : null,
      // 抽屉落稿的形就是 `/skill:<name> `,发出去那句里它长这样(裸 `/<name>` 的
      // 手打形引擎也认,但 composer 从不产它,兜底只需还原 composer 产的那一种)。
      typed: (part) => (part.name ? `/skill:${part.name}` : null),
    },
  },

  render: (ref) =>
    ref.kind === 'skill'
      ? {
          className: s.skill,
          mark: SKILL_MARK,
          label: ref.name,
          // 正文形只有名字,没有 id —— 打不开任何东西,所以不可点。
          clickable: false,
        }
      : {
          className: s.skillChip,
          dataKind: 'skillRef',
          mark: SKILL_MARK,
          label: ref.name,
          labelClassName: s.refName,
          tooltipKey: 'chat.ref.openSkill',
          tooltipArgs: { name: ref.name },
          clickable: true,
          failKey: 'chat.ref.openSkillFailed',
          failSource: 'chat.skillRef',
        },

  /*
   * 要等一发(表里没有这条时先补拉一次),所以交的是 promise —— pending 那一格
   * 的判据就是这个。三条路与它们的次序在 `content/skill-open.ts` 自己那儿。
   */
  open: (ref) => (ref.kind === 'skillRef' ? openSkillDirectory(ref.skillId) : false),
}

registerReferenceKind(skillReferenceKind, import.meta.hot)
