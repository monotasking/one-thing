import { useMemo } from 'react'
import { parseMarkdown } from '../../markdown/parse'
import { blockKey } from '../../assemble/key'
import { BlockView } from '../../blocks/BlockView'
import chat from '../../ChatStream.module.css'
import { registerViewer, disposeRegistrations } from '../registry'
import type { ViewerBodyProps } from '../registry'
import { Segmented } from '../../../ui/Segmented'
import { useT } from '../../../i18n'
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

  return (
    <div className={`${s.prose} ${chat.row}`} data-testid="viewer-markdown">
      {parsed.map(({ block, offset }, index) => (
        <BlockView
          key={blockKey(origin, index, block, offset)}
          block={block}
          ctx={{ messageId: origin, streaming: false }}
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
 * 「渲染 ⇄ 源码」分段器。它是**这一型自己**的那一格,所以住工具条而不是头上
 * (头只放身份与去向)。两档互斥、就地切换 —— 那正是 ui/Segmented 的定义。
 */
function MarkdownToolbar({ view, onView }: ViewerBodyProps) {
  const t = useT()
  return (
    <Segmented
      label={t('viewer.mdView')}
      value={view.showSource ? 'source' : 'rendered'}
      onChange={(value) => onView({ showSource: value === 'source' })}
      options={[
        { value: 'rendered', label: t('viewer.mdRendered') },
        { value: 'source', label: t('viewer.mdSource') },
      ]}
    />
  )
}

registerViewer({
  id: 'markdown',
  match: (file) => file.kind === 'markdown',
  Body: MarkdownBody,
  Toolbar: MarkdownToolbar,
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
