import { create } from 'zustand'
import type { SkillDefinition } from '@shared/ipc/skills'
import { argHintOf } from './commands-source'
import type { CommandEntry } from './commands-source'
import { skillsPort } from './skills-port'
import { truncate } from '../composer/transitions'
import { t } from '../i18n'

/**
 * `/skill:<name>` 的**真数据源**(09-12,用户报障「skill 没接入 command」)。
 *
 * ── 后端一直认,壳一直没问 ────────────────────────────────────────────────
 * `packages/onething-runtime/src/prompts/resolver.ts` 的 `collectReferenceMatches`
 * 早就认 `/skill:<name>`(大小写不敏感,名字取自这条会话看得见的技能),
 * 而 `wiring/engine/stream/agent-loop-runtime.ts` 在**每一条用户消息**上跑
 * `resolvePromptReferences`。也就是说:把 `/skill:写作 帮我改这段` 原样发出去,
 * 引擎那头就会把那份技能正文展开进这一轮。
 * 缺的一直只是**壳这一头的发现性** —— React 壳从没调过 `skills.getAll`,
 * 于是这条能力只有读过后端代码的人知道。这只 store 就是把它摆到 `/` 抽屉里。
 *
 * ── 所以它是「插一段文本」,不是一条要执行的命令 ──────────────────────────
 * `executeCommand` 对 `kind: 'skill'` 答 `sendAsText`:壳**不执行**任何东西,
 * 发出去的就是 `/skill:name …` 那句话本身,展开发生在引擎侧。这与内置里
 * goal / kegel 那四条「壳不执行」的降级是两回事 —— 那四条是缺口,这一条是设计:
 * 引用的收件人本来就该是引擎。
 *
 * ── 取数纪律:懒拉一次、按 cwd、失败静默降级 ──────────────────────────────
 * 与 `commands-source.ensurePluginCommands` 逐条同款:抽屉第一次开才发;
 * 拉失败**不弹提示**(人此刻正在打字选命令,一条 toast 只会挡住他要点的那一行),
 * 抽屉里于是只是没有「技能」那一组。
 *
 * 键是 **cwd**:契约上 `getAll` 收 `workingDirectory`,而「项目根下的技能按它
 * 发现」—— 换一条工作目录看得见的技能表就不同,拿上一条的表去画是说谎。
 * 所以缓存的判据是「上一次拉的是不是这个 cwd」,不是「拉过没有」。
 */

/** 抽屉里一行技能的说明最多念多少个字(超出省略号)。 */
export const SKILL_DESC_MAX = 48

/**
 * 一条技能 → 命令表里的一行。
 *
 * `name` 是 `/skill:<技能名>` —— **后端按名字查表**(`collectReferenceMatches`
 * 拿到的就是 `skill:` 之后那一截),所以这里一个字都不改写它。
 * `usage` 那一截的方括号是**给 `argHintOf` 读的语法**,不是装饰:
 * 选中之后那一截会变成输入框里的幽灵占位,告诉人「后面接着说你要它干什么」。
 */
export function toSkillCommand(skill: SkillDefinition, argLabel = t('composer.skillArg')): CommandEntry {
  const name = `/skill:${skill.name}`
  const usage = `${name} [${argLabel}]`
  return {
    id: `skill:${skill.id}`,
    name,
    // 技能的 description 契约上可到 1024 字(它是写给模型看的那一句),
    // 抽屉里一行放不下 —— 截断的**唯一**写法在 composer/transitions。
    desc: truncate(skill.description, SKILL_DESC_MAX),
    usage,
    kind: 'skill',
    insertText: `${name} `,
    // 技能引用后面接着说的就是「要它干什么」——参数一律放行,由引擎那头去认。
    allowArgs: true,
    argHint: argHintOf(usage),
  }
}

/* ── store ────────────────────────────────────────────────────────────── */

export type SkillsStatus = 'idle' | 'loading' | 'ready' | 'error'

export interface SkillsSourceState {
  status: SkillsStatus
  /** **产生 `commands` 的那个 cwd**(null = 那一次没带工作目录)。缓存判据就是它。 */
  cwd: string | null
  commands: CommandEntry[]
  /** 拉一次这条 cwd 下的技能表。懒的 —— 命令抽屉第一次开的时候才发。 */
  ensureSkills(cwd: string | null): Promise<void>
  reset(): void
}

const EMPTY = {
  status: 'idle' as SkillsStatus,
  cwd: null as string | null,
  commands: [] as CommandEntry[],
}

export const useSkillsSource = create<SkillsSourceState>()((set, get) => {
  /** 在飞的那一发,连同它问的是哪个 cwd —— 换了 cwd 就得重新问一次。 */
  let inflight: { cwd: string | null; run: Promise<void> } | undefined

  return {
    ...EMPTY,

    ensureSkills: async (cwd) => {
      const now = get()
      if (now.status === 'ready' && now.cwd === cwd) return
      if (inflight && inflight.cwd === cwd) return inflight.run
      const run = (async () => {
        set({ status: 'loading' })
        try {
          const port = await skillsPort()
          const response = await port.getAll(cwd)
          if (!response.success) {
            // **不清 commands**:上一批还在屏上的技能行留着,与
            // file-mentions 的律②逐字同一条(错误不抹掉旧答案)。
            set({ status: 'error' })
            return
          }
          set({
            status: 'ready',
            cwd,
            // 关掉的技能引擎那头也认不出来(`getSkillsForSession` 只给开着的),
            // 画出来就是一条点了没反应的行。
            commands: (response.skills ?? [])
              .filter((skill) => skill.enabled)
              .map((skill) => toSkillCommand(skill)),
          })
        } catch {
          // 静默降级:抽屉里只是没有「技能」那一组(见文件头)。
          set({ status: 'error' })
        } finally {
          inflight = undefined
        }
      })()
      inflight = { cwd, run }
      return run
    },

    reset: () => {
      inflight = undefined
      set({ ...EMPTY })
    },
  }
})
