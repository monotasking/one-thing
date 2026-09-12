import { useMemo } from 'react'
/* 引用种类的注册 barrel。**谁要查表,谁负责保证表是装好的**(与 `workbench/
 * CenterRegion` 对内容种类那一条逐字同判例)。生产那条路由 `main.tsx` 先 import
 * 一次;这一行管的是「不经过 main.tsx 的宿主」(用例、将来的第二个壳)。 */
import '../references'
import { ReferenceChip } from '../references/ReferenceChip'
import { segmentReferenceParts, segmentReferenceText } from '../references/segment'
import type { ResolvedSegment, TextSegmentValue } from '../references/segment'
import type { ReferencePart } from '../references/kind'

/**
 * **用户那句话里的引用怎么画**(2026-09-12)。
 *
 * ── 这只文件里**一个种类名都没有**(09-12 第三批)────────────────────────────
 * 它从前是两张 switch(正文一张按文本切、部件一张按 `contentParts` 切)加三个
 * 各写各的 chip 组件 —— 「加一种引用」= 改这只文件两处 + 加一个组件。今天它只做
 * 两件与种类无关的事:**挑一个来源**(有部件按部件、没有才切正文),
 * 与**把切出来的每一段交给它自己那一种去画**(`references/ReferenceChip`)。
 * 切的判据在 `references/segment.ts`,画的判据在各种引用自己的 `render`,
 * 打开的动作在各自的 `open`。加一种引用,这只文件一个字都不用改。
 *
 * ── 病(它为什么存在)──────────────────────────────────────────────────────
 * 气泡从前是 `{message.content}` 一句纯文本。composer 里用 `@` 选中的文件在出站
 * 之后是 `@<绝对路径>` —— 于是屏幕上露出一整串绝对路径:不能点、不截断、把气泡
 * 撑破。**第二病**(09-12 用户真机报障:「发 `/skill:名` 出去,气泡里是一整份
 * SKILL.md」):引擎收到用户消息后跑 `resolvePromptReferences`,把技能引用展成
 * 两样东西 —— **模型版**(整份 SKILL.md,落在 `content`)与**显示版**
 * (`contentParts`)。照着 `content` 画就是把整份 SKILL.md 摆进气泡。
 *
 * ── 「发出去的东西」一张表 ────────────────────────────────────────────────
 * 这张表**今天不在这只文件里了** —— 每一种自己那份自述就是它那一行
 * (`src/references/kinds/*.ts`:文件 / 目录 / 命令 / 技能 / 插件 / 提示词 / 网页)。
 * 要看全表,读 `src/references/index.ts` 那七行 import。
 */

/** 部件那一格的形状。名字沿用旧的,产地在契约层(`references/kind.ts`)。 */
export type UserContentPart = ReferencePart

/**
 * 切分表交出来的一段。**它是异构的**:文字段的形归这一层,引用段的形归那一种
 * 自己(`references/kinds/*.ts` 各自 `toRef` 出来的东西)—— 核心层认得的只有
 * 「它有一个 `kind`」。所以这里是一个**开放形状**:多出来的那几格由读的人按
 * `kind` 自己收窄,而不是在这里把每一种的字段抄一遍(那就又是一张枚举表,
 * 而且是一张会在加第八种引用的那天悄悄过期的表)。
 */
export type UserSegment = { kind: string } & Record<string, string | undefined>

/**
 * **切分表**(单测钉的就是它)。交出去的是「一段一段的东西」:文字段是
 * `{kind:'text', text}`,引用段是那一种自己 `toRef` 出来的那一枚。
 *
 * 它是 `segmentReferenceText` 的**投影** —— 同一次计算的另一种读法,不是第二次
 * 计算(画那一半要知道每一段是哪一种,切分表的读者不关心)。
 */
export function segmentUserMessage(text: string): UserSegment[] {
  return segmentReferenceText(text).map((seg) => seg.value as UserSegment)
}

/**
 * **部件切分表**。与 runtime 的 `displayTextFromPromptParts` 同一条纪律:
 * **不认识的一律不画** —— 「不认识就原样摆出来」在这里是错的,一格 `skill-ref`
 * 的 `content` 正是那份 4862 字的 SKILL.md。
 */
export function segmentUserParts(parts: readonly UserContentPart[]): UserSegment[] {
  return segmentReferenceParts(parts).map((seg) => seg.value as UserSegment)
}

/** 一段:文字原样,引用交给它自己那一种去画。 */
function SegmentView({ seg }: { seg: ResolvedSegment }) {
  if (seg.kindId === null) return <>{(seg.value as TextSegmentValue).text}</>
  return <ReferenceChip kindId={seg.kindId} value={seg.value} />
}

/**
 * 气泡正文。换行仍旧由 `.user` 那句 `white-space: pre-wrap` 保留 —— 切分一个字符
 * 都不吃,拼回来与原文逐字相同。
 *
 * ── 两个来源,一条判据 ────────────────────────────────────────────────────
 * **有 `parts` 就按部件画,没有才切 `text`。** 判据是「引擎到底有没有替这条消息
 * 折过显示版」:折过的那些,`text`(= 账本上的 `content`)是**模型版** ——
 * 技能那一支里它是整份 SKILL.md,照着画就是这一单要治的病。老会话、以及引擎
 * 没展开过引用的那些消息上没有这一格,照旧走正文切分,行为逐字不变。
 *
 * **空数组 = 没有**:`contentParts` 在投影那头只有 `length > 0` 时才挂上去,
 * 一个空数组只可能是某条路径传了个空壳 —— 按它画会画出一个空气泡。
 *
 * key 用下标:段序列是**一个不可变输入**的投影,同一条消息里它不会重排也不会
 * 增删(消息正文改了就是另一条消息,输入变则整段重算)。
 */
export function UserMessageBody({
  text,
  parts,
}: {
  text: string
  parts?: readonly UserContentPart[]
}) {
  const segments = useMemo(
    () =>
      parts && parts.length > 0 ? segmentReferenceParts(parts) : segmentReferenceText(text),
    [text, parts],
  )
  return (
    <>
      {segments.map((seg, i) => (
        <SegmentView key={i} seg={seg} />
      ))}
    </>
  )
}
