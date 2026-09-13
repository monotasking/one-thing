import { useT } from '../../../i18n'
import { Tooltip } from '../../../ui/Tooltip'
import { Image as ImageGlyph } from '../../../components/icons'
import type { InlineNode } from '../../model/inline'
import s from './InlineRun.module.css'

/**
 * 行内图 = **一颗芯片,不是一张小图**(正本 §4)。
 *
 * 理由是排版:段落是「纸上的一段字」,由 `pre-wrap` 逐字排出来的;行内塞一件会
 * 长高、而且**高度要等网络才知道**的物件,这一行的行律当场就没了(图到了那一刻
 * 整段重排)。而行内图的真实用法是徽章和笔记里顺手嵌的图 —— 芯片说清「这里有
 * 一张图、它叫什么、它在哪儿」,真要看就把它写成独占一段(模型与人都这么写:
 * 真店 247 张图里 77 张是独占一段的)。
 *
 * ── 非交互 ────────────────────────────────────────────────────────────
 * `<span>`,不给 role、不给 cursor、不接点击:今天点它没有任何事发生,而一个看起来
 * 能点的东西点了不动比它看起来不能点糟(同 InlineRun 里链接那一格的判词)。
 * 点开放大是正本 §6 的 P4。
 *
 * 地址走 `ui/Tooltip`(禁 native `title=`),Tooltip 是 cloneElement 注入,
 * **不多包一层 DOM** —— 行内多一个元素会把 `pre-wrap` 的空白折叠规则在边界上改掉。
 */
export function InlineImage({ node }: { node: Extract<InlineNode, { type: 'image' }> }) {
  const t = useT()
  // alt 空就退到地址末段:芯片上永远有一个说得出口的名字,不画一颗空芯片。
  const label = node.alt || lastSegment(node.ref.url)

  return (
    <Tooltip content={node.ref.url}>
      {/*
        * 读屏那一句由 aria-label 说全(「图片 x」)——芯片上的字只是名字,
        * 少了「图片」两个字念出来就是一个来历不明的词。
        */}
      <span className={s.image} aria-label={t('block.image.inline', { alt: label })}>
        <ImageGlyph className={s.imageGlyph} strokeWidth={1.75} aria-hidden="true" />
        {label}
      </span>
    </Tooltip>
  )
}

/** 地址末段(去掉 query / hash)。取不出来就用整条地址 —— 总比一颗空芯片强。 */
function lastSegment(url: string): string {
  return url.split(/[?#]/)[0]?.split('/').filter(Boolean).pop() || url
}
