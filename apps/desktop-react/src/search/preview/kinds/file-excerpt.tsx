import { useEffect } from 'react'
import { resolveViewer } from '../../../content/viewer/registry'
import { ensureFilePeek, useFilePeek } from '../../../data/file-peek-source'
import { useT } from '../../../i18n'
import type { SearchPreviewProps, SearchPreviewRenderer } from '../registry'
import s from '../Preview.module.css'

/**
 * `kind: 'file-excerpt'` —— 一个文件的 **peek 态**
 * (设计 `docs/design/search-index-2026-09.md` §4.5 ②:「文件类的预览一律复用
 * 查看器注册表:`resolveViewer(file)` 已经按文件类型分发到文本 / 代码 / 图片 /
 * 媒体 / PDF,预览就是查看器的『peek 态』(只读、无编辑、无持久化)」)。
 *
 * 后端只给一条路径(它一个字节都不读,理由见 `capabilities/files.ts`),所以
 * 壳这一侧读那一段(`data/file-peek-source.ts`,64KB 封顶)再交给查看器分发。
 * **加一种文件型,这个文件一个字不改** —— 那正是复用注册表买到的东西。
 *
 * ── 三条「只读」逐条兑现 ────────────────────────────────────────────────
 *  · **不编辑**:`ViewerBodyProps.onView` 传的是一只**空函数** —— 折行 / 缩放这些
 *    「看的姿势」在预览里没有落点,而给它一个真落点就意味着预览要有自己的一份
 *    view 状态,那是第二台状态机。
 *  · **不持久化**:不碰 `useViewerSource`,所以预览一个文件不会改「此刻打开的是
 *    哪个文件」,也不写任何最近表。
 *  · **不 reveal**:`onReveal` 缺席 —— 去 Finder 是一次真动作,不是一次预览。
 *
 * ── 一处诚实的缺口 ──────────────────────────────────────────────────────
 * `resolveViewer` 查不到型这件事**不会发生**(分型表有 `code` 兜底 + `error` 型),
 * 所以设计里「查看器不认识的,预览也诚实地画『不支持预览 · 在外部打开』」那一句
 * 在今天由**查看器自己的诚实态**答(binary / oversize / error 三型的 Body 就是
 * 那句话),而不是这里再判一次。两处各写一句必然分叉。
 */

interface FileExcerptPayload {
  path: string
}

/** 验而不信(同别的预览渲染器)。 */
export function fileExcerptPayloadOf(payload: unknown): FileExcerptPayload | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined
  const { path } = payload as Partial<FileExcerptPayload>
  if (typeof path !== 'string' || path.length === 0) return undefined
  return { path }
}

/** 预览里「看的姿势」没有落点:一只空函数,不是一处 TODO(见文件头第一条)。 */
const NO_VIEW_CHANGE = (): void => {}

/** peek 用的那份 view:全部取查看器的出厂值,预览不带自己的一台状态机。 */
const PEEK_VIEW = {
  wrap: true,
  showSource: false,
  zoomMode: 'fit' as const,
  scale: 1,
  currentLine: 0,
  keymap: 'default',
  vimMode: 'normal' as const,
}

function FileExcerptBody({ payload }: SearchPreviewProps) {
  const t = useT()
  const file = fileExcerptPayloadOf(payload)
  const path = file?.path ?? ''
  const peek = useFilePeek(path)

  useEffect(() => {
    void ensureFilePeek(path)
  }, [path])

  if (file === undefined) return <p className={s.meta}>{t('search.previewMalformed')}</p>
  // 首载:一句话,不画骨架 —— 骨架的延迟由预览窗那一层统一管(120ms,§4.5 ④)。
  if (peek.data === undefined) {
    return <p className={s.meta} data-peek="loading">{t('search.previewLoading')}</p>
  }
  const handler = resolveViewer(peek.data)
  return (
    <div className={s.body}>
      <p className={s.meta} data-fact="path">{file.path}</p>
      <div className={s.peek} data-viewer-kind={handler.id} data-peek="ready">
        <handler.Body file={peek.data} view={PEEK_VIEW} onView={NO_VIEW_CHANGE} />
      </div>
    </div>
  )
}

export const fileExcerptPreviewRenderer: SearchPreviewRenderer = {
  kind: 'file-excerpt',
  Body: FileExcerptBody,
}
