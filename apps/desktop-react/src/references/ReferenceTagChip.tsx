import { memo } from 'react'
import { defaultRefTagText, formatRefTag } from '@onething/core/references'
/* 引用种类的注册 barrel。**谁要查表,谁负责保证表是装好的**(与
 * `content/user-message.tsx` 那一行逐字同判例)。 */
import '.'
import { ReferenceChip } from './ReferenceChip'
import { resolveReferenceTag } from './registry'
import s from './ReferenceChip.module.css'
import type { RefTag } from '@onething/core/references'

/**
 * **助手那句话里的一条 `<ref/>` 画出来的样子**(B2,正本
 * `docs/design/reference-tag-2026-09.md` §2.5)。
 *
 * 它只做一件事:**把一条标签交给注册表,认得出就交给那一种自己去画**。
 * 于是用户气泡里那一枚与助手消息里那一枚是**同一个组件、同一份 `render(ref)`**
 * —— 两边的图标、提示、可不可点、点了做什么,全是一个答案。
 *
 * ── 认不出那一形:一枚中性、不可点的 chip ─────────────────────────────────
 * 认不出有两种来处(新版本写的 type / 属性不合法),而它们在屏幕上是同一件事。
 * 画什么:`defaultRefTagText(tag)` —— 编解码器那句缺省投影(label ▷ path[:line]
 * ▷ href ▷ name ▷ 第一个属性值 ▷ type),**永不为空**。
 *
 * **不吞字**是这一形唯一的要求:一段正文里作者确实指着一个东西,壳不认得它不是
 * 把它删掉的理由。也不画成可点的 —— 屏幕上不该出现一个按下去没反应的东西。
 *
 * ── 这只文件里一个种类名都没有 ───────────────────────────────────────────
 * 与 `InlineRun` / `segment.ts` / `registry.ts` 同一条纪律,守卫在
 * `__tests__/structure.test.ts` 的名字闸里。
 *
 * ── memo 比的是**那条标签的字节** ─────────────────────────────────────────
 * `tag` 每次解析都是一个新对象(行内树是不可变的),浅比必然次次落空。比
 * `formatRefTag(tag)` 是把「这两条标签是不是同一条」变成一次字符串比较 ——
 * 而那串字节本来就是决定性的(属性按插入序渲染)。超量格量的就是它:父重渲时
 * chip 的渲染次数不涨。
 */
function ReferenceTagChipView({ tag }: { tag: RefTag }) {
  const resolved = resolveReferenceTag(tag)
  if (resolved) return <ReferenceChip kindId={resolved.kindId} value={resolved.value} />
  return (
    <span className={s.unknown} data-ref-kind="unknown">
      {defaultRefTagText(tag)}
    </span>
  )
}

export const ReferenceTagChip = memo(
  ReferenceTagChipView,
  (prev, next) => formatRefTag(prev.tag) === formatRefTag(next.tag),
)
