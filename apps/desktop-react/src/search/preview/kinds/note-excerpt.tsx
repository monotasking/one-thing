import { Highlight } from '../../../expose/components/Highlight'
import { useT } from '../../../i18n'
import type { SearchPreviewProps, SearchPreviewRenderer } from '../registry'
import s from '../Preview.module.css'

/**
 * `kind: 'note-excerpt'` —— 一篇笔记里命中行 ±3 行
 * (`runtime/src/search/capabilities/preview.ts` 的 `NoteExcerptPreview`)。
 *
 * **画的是素文本,不是渲染后的 markdown**,而且这是刻意的:载荷是从文件里切出来的
 * **中间几行**,它在语法上根本不是一份完整的 markdown(一段可能从表格中间起笔、
 * 从围栏代码块中间断开)。把半截语法交给渲染器,画出来的东西比原文更难认。
 * 要「渲染着看」是打开这篇笔记的事,不是预览的事。
 */

interface NoteExcerptPayload {
  path: string
  title: string
  excerpt: string
}

/** 验而不信(同 message-context)。 */
export function noteExcerptPayloadOf(payload: unknown): NoteExcerptPayload | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined
  const raw = payload as Partial<NoteExcerptPayload>
  if (typeof raw.excerpt !== 'string') return undefined
  return {
    path: typeof raw.path === 'string' ? raw.path : '',
    title: typeof raw.title === 'string' ? raw.title : '',
    excerpt: raw.excerpt,
  }
}

function NoteExcerptBody({ payload, query }: SearchPreviewProps) {
  const t = useT()
  const note = noteExcerptPayloadOf(payload)
  if (note === undefined) return <p className={s.meta}>{t('search.previewMalformed')}</p>
  return (
    <div className={s.body}>
      {/* 标题归檐(R6);这里只画出处与正文 —— 同一句话不在一块面里画两遍。 */}
      {note.path.length > 0 && <p className={s.meta} data-fact="path">{note.path}</p>}
      <p className={s.text}>
        <Highlight text={note.excerpt} query={query} />
      </p>
    </div>
  )
}

export const noteExcerptPreviewRenderer: SearchPreviewRenderer = {
  kind: 'note-excerpt',
  Body: NoteExcerptBody,
}
