import { useEffect, useMemo, useRef, useState } from 'react'
import { ChevronUp, ChevronDown, TriangleAlert } from '../../components/icons'
import { Button } from '../../ui/Button'
import { IconButton } from '../../ui/IconButton'
import { Tooltip } from '../../ui/Tooltip'
import { CodeLines, splitLines } from '../code/CodeLines'
import { lineDiff } from '../code/line-diff'
import { ChangeMap } from './ChangeMap'
import { splitPath } from './ChangeList'
import type { GitChangedFile, GitFileText, GitFileView } from '../../data/changes-source'
import type { QuerySnapshot } from '../../data/kernel'
import type { MessageKey } from '../../i18n'
import s from './ChangesPanel.module.css'

/**
 * **选中那个文件的整文件视图**(2026-09-13 批 ③-b;正本
 * `docs/changes-file-view-2026-09.md` §3「③-b 壳」)。
 *
 * 它替掉了 `ChangeBody`(hunk 文本模型那一版)。用户 09-13 裁定:**只有整个文件
 * 一种形态,不折叠**;上一处 / 下一处只留两枚箭头,**改动数要看得见**。
 *
 * ── 一条链,三段各归各 ──────────────────────────────────────────────────
 * 后端交两份原文(`git:` 的 `file` 读法:HEAD 版与工作区版)→ 壳里 `lineDiff`
 * 算行级 diff(`content/code/line-diff.ts`,纯函数)→ 基础件 `CodeLines` 画
 * (两列行号 + 加删符号 + 逐行跳渲)。**这块面自己一行「怎么画一行」的代码都没有**,
 * 它只管四件:檐、导航(↑ k/N ↓)、右缘的改动地图、以及四种诚实态。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 状态先行 · 三张表
 * ══════════════════════════════════════════════════════════════════════════
 *
 * ── ① 生命周期 ───────────────────────────────────────────────────────────
 *  · 挂载   —— 只声明「我在看这一格」(`useFileLive` 在面板那一层),零 `ensure`;
 *  · 首载   —— 读回来第一份 ready 时**自动落到第一块**(`picked` 一格 ref 记
 *              「落过没有」,与文件列那条「首次自动选第一行」逐字同形);
 *  · 换文件 —— 键换了 = 换一份读数 = 导航重新起算(`useEffect` 依赖 `file.path`);
 *  · 重拉   —— 旧屏一格不动(律②),块表变了就把 `active` 夹回范围内,**不回顶**;
 *  · 换宿主 —— 拼贴树结构共享保证不重挂;滚动位是 DOM 自己的,跟着走;
 *  · 卸载   —— 无订阅、无计时器、无模块级副作用 → 不需要 HMR dispose。
 *
 * ── ② UI 生命状态 ────────────────────────────────────────────────────────
 *  · empty   —— 两版原文都读到了、但**一个改动块都没有** → 一句「此刻没有改动」。
 *               判据是块数不是行数:两版逐字相同时整篇都是未改行,画出来是一份
 *               没有任何改动的文件 —— 那不是「改动面」该说的话(这个文件在列表里
 *               是因为两次刷新之间它被撤销了改动);
 *  · loading —— **只有首载**画三条骨架(`phase === 'initial'`),重拉期间旧屏不动;
 *  · ready   —— 四种形:两版都在 = 整文件;只有 head = 整篇 del;只有 work =
 *               整篇 add;任一版 binary = 一句话(不画乱码);
 *  · error   —— 通知行 + **后端原话** + 一颗重试,**旧屏不清**;
 *  · 超量    —— 两万行的文件:`skip` 交给基础件逐行跳渲,地图按比例定位(它画的是
 *               块数不是行数),↑↓ 只改一格下标 —— 三件都与行数无关。
 *
 * ── ③ UI 交互状态 ────────────────────────────────────────────────────────
 *  · rest / hover / focus —— 两颗箭头是 `ui/IconButton`(皮肤随件走,焦点环全局);
 *  · active  —— 「此刻停在第几块」:檐上读数 `k / N` + 那一行的 `data-current` +
 *               地图上那一格 `data-active`,**三处读同一格状态**;
 *  · disabled —— 一处都没有:只有一块改动时 ↑↓ 仍然按得动(循环回自己),
 *               零块时整组不画(没有「按了没反应」的钮);
 *  · pending —— 这块面没有写动作;重试那一颗的忙由 query 自己说。
 */

export interface ChangeFileViewProps {
  /** 选中的那一行(没有选中 = 面板不该渲染这一块)。 */
  file: GitChangedFile
  /** 那一格「两个版本原文」的读数。 */
  snapshot: QuerySnapshot<GitFileView>
  onRetry: () => void
  t: (key: MessageKey, vars?: Record<string, string | number>) => string
}

export function ChangeFileView({ file, snapshot, onRetry, t }: ChangeFileViewProps) {
  const view = snapshot.data
  const bodyRef = useRef<HTMLDivElement | null>(null)

  /*
   * 两份原文 → 一串行。**只在原文真变了的时候算一遍** —— 这块面每一次选中 / 刷新 /
   * 拖分栏都会重渲染,不 memo 就是每一帧对着两万行跑一次 Myers。
   */
  const diff = useMemo(() => {
    if (!view) return undefined
    if (view.head?.binary || view.work?.binary) return undefined
    return lineDiff(textLines(view.head), textLines(view.work))
  }, [view])

  const blocks = diff?.blocks ?? []
  const [active, setActive] = useState(0)

  /*
   * 首次 ready 落到第一块;换一个文件重新起算。判据是「落过没有」而不是
   * `active === 0` —— 那两者分不开(出厂值就是 0),于是人手动跳回第一块之后
   * 再刷新一次会被判成「还没落过」。
   */
  const picked = useRef(false)
  useEffect(() => {
    picked.current = false
    setActive(0)
  }, [file.path])
  useEffect(() => {
    if (picked.current || blocks.length === 0) return
    picked.current = true
    setActive(0)
  }, [blocks.length])

  /* 重拉之后块数可能变少:把下标夹回范围内,**不回顶**(律②:旧屏别乱跳)。 */
  const at = blocks.length === 0 ? 0 : Math.min(active, blocks.length - 1)
  const currentRow = blocks.length === 0 ? -1 : blocks[at]

  /**
   * **只滚自己这一格**:把目标行摆到视口中段。
   *
   * 不用 `scrollIntoView` —— 它会连**外层**的滚动容器一起滚(整页跟着动),
   * 而且元素比视口宽时还会横向拨一下(批 ① 在查看器上量到过 12px)。
   * 这里要的是「这一格内部滚到那一行」,所以直接写 `scrollTop`。
   */
  const goTo = (next: number) => {
    setActive(next)
    const body = bodyRef.current
    const row = body?.querySelector<HTMLElement>(`[data-line-index="${blocks[next]}"]`)
    if (!body || !row) return
    body.scrollTop = Math.max(0, row.offsetTop - body.clientHeight / 2)
  }

  const step = (delta: number) => {
    if (blocks.length === 0) return
    goTo((at + delta + blocks.length) % blocks.length)
  }

  const path = splitPath(file.path)
  const binary = Boolean(view?.head?.binary || view?.work?.binary)
  const truncated = Boolean(view?.head?.truncated || view?.work?.truncated)

  return (
    <div className={s.fileArea}>
      <div className={s.body} ref={bodyRef} data-testid="changes-body" data-change-body-path={file.path}>
        {/*
          * 檐:身份 + ± 统计 + 导航。**sticky**(样式表那一条)—— 一份文件铺开好几屏,
          * 滚到中间时「我在看哪个文件、这是第几处改动」必须还在屏上。
          */}
        <div className={s.bodyHead}>
          <Tooltip content={file.path}>
            <span className={s.bodyPath}>
              <span className={s.bodyPathDir}>{path.dir}</span>
              <span className={s.bodyPathName}>{path.name}</span>
            </span>
          </Tooltip>
          {file.add ? <span className={s.statAdd}>{`+${file.add}`}</span> : null}
          {file.del ? <span className={s.statDel}>{`−${file.del}`}</span> : null}
          {blocks.length > 0 && (
            <span className={s.navGroup} data-testid="changes-nav">
              <IconButton
                icon={ChevronUp}
                size="xs"
                label={t('diff.prevChange')}
                testId="changes-prev"
                onClick={() => step(-1)}
              />
              {/*
                * **文字读数,不是计数徽**(计数禁令:徽只禁在 tab / 列表 / 组头上,
                * 「第几 / 共几」这种读数一直是允许的那一格)。给读屏的是一整句。
                */}
              <span
                className={s.navCount}
                data-testid="changes-nav-count"
                aria-label={t('diff.changeAt', { k: at + 1, n: blocks.length })}
              >
                {`${at + 1} / ${blocks.length}`}
              </span>
              <IconButton
                icon={ChevronDown}
                size="xs"
                label={t('diff.nextChange')}
                testId="changes-next"
                onClick={() => step(1)}
              />
            </span>
          )}
        </div>

        {/* 错误:一条通知行 + 后端原话 + 一颗重试。**旧内容不清**(律②)。 */}
        {snapshot.error && (
          <p className={s.notice} role="alert" data-testid="changes-body-error">
            <TriangleAlert className={s.noticeIcon} strokeWidth={1.75} aria-hidden="true" />
            <span className={s.noticeText}>{snapshot.error}</span>
            <Button size="sm" variant="ghost" onClick={onRetry}>
              {t('diff.retry')}
            </Button>
          </p>
        )}

        {binary ? (
          <p className={s.bodyNote} data-testid="changes-body-binary">
            {t('diff.fileBinary')}
          </p>
        ) : diff && diff.blocks.length > 0 ? (
          <>
            <CodeLines
              lines={diff.lines}
              numbers="both"
              signs
              skip
              /*
               * **当前行按下标定位,不按新行号** —— 一个改动块的首行可能是删除行,
               * 而删除行没有新行号(整篇删除的文件里一行都没有)。递 0 的意思是
               * 「我认『当前行』这件事,但我不按新行号找它」,标记由 `rowAttrs` 落。
               */
              currentLine={0}
              rowAttrs={(_line, index) => ({
                'data-line-index': String(index),
                'data-current': index === currentRow ? 'true' : undefined,
              })}
            />
            {truncated && (
              <p className={s.bodyNote} data-testid="changes-body-truncated">
                {t('diff.fileTruncated')}
              </p>
            )}
          </>
        ) : snapshot.phase === 'initial' ? (
          /* 首载骨架:三条短横。**只在 `phase === 'initial'` 画**(律②)。 */
          <div className={s.skel} aria-hidden="true" data-testid="changes-body-skeleton">
            <span className={`${s.skelBar} ${s.skelBar1}`} />
            <span className={`${s.skelBar} ${s.skelBar2}`} />
            <span className={`${s.skelBar} ${s.skelBar3}`} />
          </div>
        ) : (
          /* 读到了、但一行差别都没有:说出来,而不是画一块空框。 */
          !snapshot.error && (
            <p className={s.bodyNote} data-testid="changes-body-empty">
              {t('diff.noDiff')}
            </p>
          )
        )}
      </div>
      {diff && <ChangeMap lines={diff.lines} blocks={blocks} active={at} onPick={goTo} />}
    </div>
  )
}

/**
 * 一版原文 → 行。**缺席那一版是零行**(不是一行空串):文件删掉了 = 工作区版
 * 不存在 = 整篇都是删除行,而 `splitLines('')` 给的是一行空串,那会在整篇 add 的
 * 文件顶上凭空多一条删除行。
 */
function textLines(version: GitFileText | null | undefined): string[] {
  if (!version || version.binary) return []
  return version.text ? splitLines(version.text) : []
}
