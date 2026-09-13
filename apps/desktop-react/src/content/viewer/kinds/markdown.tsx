import { useMemo } from 'react'
import { parseMarkdown } from '../../markdown/parse'
import { blockKey } from '../../assemble/key'
import { BlockView } from '../../blocks/BlockView'
import chat from '../../ChatStream.module.css'
import { registerViewer, disposeRegistrations } from '../registry'
import type { ViewerBodyProps, ViewerViewMode } from '../registry'
import { CodeCanvas, splitLines } from './code'
import s from '../FileViewer.module.css'

/**
 * **markdown 型** —— 壳自己那张块翻译表的**整套**渲染,外加「渲染 ⇄ 源码」一格。
 *
 * 一句话:这里画出来的东西与聊天正文里的一模一样。段落、标题、列表、引用、
 * 表、图、diff、围栏里的代码 —— 全部经同一个 `parseMarkdown` → 同一张块注册表
 * → 同一个 `BlockView`。**没有第二套 markdown 渲染**,所以「加一个块」在聊天和
 * 在文件查看器里同一天生效(§3.1 铁律 1 的字面兑现)。
 *
 * ── 节奏表也是同一份 ────────────────────────────────────────────────────
 * 容器直接吃 `ChatStream.module.css` 的 `.row` —— 那张「隔多远(前,后)=
 * max(前的下缘, 后的上缘)」的邻接表长在那个类上。**抄一份到这里是错的**:
 * 两份同特异性的规则谁赢取决于两个 CSS Module 的打包先后(那正是 ChatStream 的
 * ⓪ 清零那一段记下来的坑),而且改了一处必然忘另一处。于是列宽、字号、
 * 密度三档阅读轴在查看器里**免费生效**,一个变量都不用接。
 *
 * ── 一处与设计稿的出入,以壳为准(记档)────────────────────────────────
 * claude design 的查看器稿给引用块画了一条 2px 左线。**壳不跟** —— 引用块的定稿
 * 是同日拍板的 quote-C「大引号纯排版、无左线」(tokens.css 的 --quote-* 三格)。
 * 跟设计稿就意味着同一个引用在聊天里和在查看器里长得不一样,那比「与这一张稿
 * 不同」严重得多:一套排版只能有一个定稿。
 *
 * ── key 走同一条产地 ───────────────────────────────────────────────────
 * `blockKey` 按**源偏移**发 key(不是下标):文件重读一段更长的前缀时,前面
 * 那些块的起点一个都没变,于是 React 只打补丁 —— 已经上过色的代码块不会因为
 * 「继续加载」而整片重染。messageId 位给一个说得清产地的名字(`viewer:<path>`),
 * 它会进块的错误边界现场名,不给空串。
 */
export function MarkdownCanvas({ path, source }: { path: string; source: string }) {
  const parsed = useMemo(() => parseMarkdown(source), [source])
  const origin = `viewer:${path}`
  /*
   * **这份文档在哪个目录** —— 资产地址里的相对路径就是相对它(正本 §2)。
   *
   * 手写取目录而不是 `node:path.dirname`:这是渲染层,壳也跑在浏览器里(web 档),
   * 而这条 path 永远是 posix 的一条绝对路径(文件面自己的词汇)。没有斜杠时得到
   * 空串,`resolveAssetRef` 读作「没有文档位置」—— 与不传是同一件事。
   */
  const baseDir = path.slice(0, path.lastIndexOf('/'))

  return (
    <div className={`${s.prose} ${chat.row}`} data-testid="viewer-markdown">
      {parsed.map(({ block, offset }, index) => (
        <BlockView
          key={blockKey(origin, index, block, offset)}
          block={block}
          ctx={{ messageId: origin, streaming: false, baseDir: baseDir || undefined }}
        />
      ))}
    </div>
  )
}

function MarkdownBody({ file, view }: ViewerBodyProps) {
  if (file.kind !== 'markdown') return null
  // 源码那一面走 code 的本体 —— markdown 的源码就是一段带高亮的文本,
  // 没有第二种画法(行号、当前行、折行因此白得)。
  if (view.showSource) {
    return (
      <CodeCanvas
        source={file.content}
        lang="markdown"
        wrap={view.wrap}
        currentLine={view.currentLine}
      />
    )
  }
  return <MarkdownCanvas path={file.path} source={file.content} />
}

/**
 * 「渲染 ⇄ 源码」两档。**它是数据,不是一件工具条**(W7-c 裁定 2)。
 *
 * W1 起它是一件 `Segmented`,挂在叶檐的动作组里;W7-c 把顶栏的内容工具条槽位
 * 整格删掉(用户 09-05:「按钮太多」),这两档跟着搬进**内容区自己的右键菜单**
 * ——「一个文件能做什么」全仓只有那一张表(09-01 判例)。搬过去之后它不再需要
 * 一件会自己读 store 的组件:菜单要的只是「有哪几档、此刻哪一档、选它写什么」。
 */
const MARKDOWN_VIEW_MODES = [
  { id: 'rendered', labelKey: 'viewer.mdRendered', on: (v) => !v.showSource, patch: { showSource: false } },
  { id: 'source', labelKey: 'viewer.mdSource', on: (v) => v.showSource, patch: { showSource: true } },
] as const satisfies readonly ViewerViewMode[]

registerViewer({
  id: 'markdown',
  match: (file) => file.kind === 'markdown',
  Body: MarkdownBody,
  viewModes: MARKDOWN_VIEW_MODES,
  viewModesLabelKey: 'viewer.mdView',
  editable: true,
  /* 渲染面不按行寻址(一段话可能是三行也可能是三十行);源码面按行。 */
  lineCount: ({ file, view }) =>
    file.kind === 'markdown' && view.showSource ? splitLines(file.content).length : undefined,
  statusItems: ({ view, onView }) =>
    view.showSource
      ? [
          {
            id: 'wrap',
            labelKey: 'viewer.wrap',
            on: view.wrap,
            onToggle: () => onView({ wrap: !view.wrap }),
          },
        ]
      : [],
  status: ({ file, view }) =>
    file.kind === 'markdown'
      ? [view.showSource ? 'markdown' : 'markdown · rendered', 'UTF-8'].join(' · ')
      : undefined,
})

/*
 * HMR 退役(09-01 立法:模块级副作用必须配 dispose)。这个文件在被 import 时
 * 往注册表里塞东西,而那张表**重复注册即抛** —— 不退役,热更后新模块进来当场
 * 白屏。复用 registry 那一口唯一的拆卸,不写第二套。
 */
if (import.meta.hot) {
  import.meta.hot.dispose(() => disposeRegistrations({ viewers: ['markdown'] }))
}
