import type { InlineNode } from '../../model/inline'
import s from './InlineRun.module.css'

/**
 * **行内树 → React**,全仓一份。
 *
 * 段落、标题、列表项、表格单元格、引用……凡是装着 `InlineNode[]` 的地方都用它。
 * 各画各的会让「行内码长什么样」有五种答案 —— 这正是块壳把公共件收在一处的同一条
 * 道理,只是这次收的是行内那一层。
 *
 * ── 链接本批不点 ─────────────────────────────────────────────────────
 * 桌面壳里点外链必须交给宿主(`shell.openExternal`),而 P1 的壳还没有那个面
 * (platform 层没有 shell 域)。两个错误答案:画成 `<a href>` —— 点了会把整个应用
 * 导航走,壳就没了;悄悄画成纯文字 —— 人看不出这里本来有个链接。
 * 所以本批画成**看得出是链接、能选中、title 显示目标地址**的一段字:信息一点不少,
 * 点击行为留账(等 shell 面进来,这里加一个 onClick,别处不动)。
 */
export function InlineRun({ nodes }: { nodes: readonly InlineNode[] }) {
  return <>{nodes.map(renderInline)}</>
}

function renderInline(node: InlineNode, index: number) {
  switch (node.type) {
    case 'text':
      // 直接吐字符串,不套 span —— 多一层元素会让 `pre-wrap` 的空白折叠规则
      // 在边界上出现意外(相邻元素间的换行),而这一段的排版是逐像素定过的。
      return node.text
    case 'code':
      return (
        <code key={index} className={s.code}>
          {node.text}
        </code>
      )
    case 'emphasis':
      return node.strong ? (
        <strong key={index}>
          <InlineRun nodes={node.children} />
        </strong>
      ) : (
        <em key={index}>
          <InlineRun nodes={node.children} />
        </em>
      )
    case 'strike':
      return (
        <s key={index}>
          <InlineRun nodes={node.children} />
        </s>
      )
    case 'link':
      return (
        <span key={index} className={s.link} title={node.href}>
          <InlineRun nodes={node.children} />
        </span>
      )
    case 'citation':
      // 角标的呈现(预览卡、来源清单联动)是 P4 的事;在那之前只画一个数字,
      // 而不是把它悄悄丢掉 —— 正文里确实有这一处引用,这是事实。
      return (
        <sup key={index} className={s.citation}>
          {node.index}
        </sup>
      )
  }
}
