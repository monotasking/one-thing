import { useEffect, useMemo, useRef, useState } from 'react'
import { ChevronUp, ChevronDown, TriangleAlert } from '../../components/icons'
import { Button } from '../../ui/Button'
import { IconButton } from '../../ui/IconButton'
import { Tooltip } from '../../ui/Tooltip'
import { FocusScope } from '../../focus/FocusScope'
import { useT } from '../../i18n'
import { useQuery } from '../../data/kernel'
import {
  fileQueryOf,
  statusQuery,
  useChangesLive,
  useFileLive,
} from '../../data/changes-source'
import { CodeLines, splitLines } from '../code/CodeLines'
import { lineDiff } from '../code/line-diff'
import { ChangeMap } from './ChangeMap'
import { splitPath } from './ChangeList'
import type { GitChangedFile, GitFileText } from '../../data/changes-source'
import s from './ChangesPanel.module.css'

/**
 * **一个文件的整文件改动视图**(2026-09-13 批 ③-b 立;批⑤ 改成**自足**)。
 *
 * ── 批⑤ 改了什么、为什么 ────────────────────────────────────────────────
 * 从前它收四格 prop(`file` / `snapshot` / `onRetry` / `t`)—— 取数与「此刻选中的
 * 是哪一行」全在改动面那一层,于是它**只能**长在那块面里。用户 09-14 要「文件列
 * 与文件拆开、查看 diff 走文件的 tab 行为」,那就得让它**离开那块面也活得下去**:
 * 今天它只收 `root` + `path` 两格坐标,自己取两份原文、自己从 `status` 那一份里
 * 找自己那一行的 ± 与状态。两个宿主因此是同一件东西:
 *  · `change:<root>|<path>` 那一格内容(`content/kinds/change.tsx`,带 `owner`);
 *  · 改动面 `panel` 档那条分栏内联(不带 `owner`)。
 *
 * ── 一条链,三段各归各(没变)────────────────────────────────────────────
 * 后端交两份原文(`git:` 的 `file` 读法:HEAD 版与工作区版)→ 壳里 `lineDiff`
 * 算行级 diff(`content/code/line-diff.ts`,纯函数)→ 基础件 `CodeLines` 画
 * (两列行号 + 加删符号 + 逐行跳渲)。**这块面自己一行「怎么画一行」的代码都没有**,
 * 它只管四件:檐、导航(↑ k/N ↓)、右缘的改动地图、以及五种诚实态。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 状态先行 · 三张表(批⑤ 自足之后重填)
 * ══════════════════════════════════════════════════════════════════════════
 *
 * ── ① 生命周期 ───────────────────────────────────────────────────────────
 *  · 挂载   —— 两句报到:`useChangesLive(root)`(那个目录的 `status`,它是 ± 与
 *              「这一行还在不在」的来源)与 `useFileLive(root, path)`(两版原文)。
 *              两句都幂等 —— 同一个文件开两格、或者一格开着的同时改动面也开着,
 *              后端只问一次;取数的生命周期归数据层,面只声明「我在看什么」;
 *  · 首载   —— 读回来第一份 ready 时**自动落到第一块**(`picked` 一格 ref 记
 *              「落过没有」,与文件列那条「首次自动选第一行」逐字同形);
 *  · 换文件 —— 这一格的身份就是 (root, path),换文件 = **换一格 tab**,不是换
 *              这一份的 prop。prop 真被换掉时(内联那一档)依赖 `path` 的那条
 *              effect 把导航重新起算;
 *  · 重拉   —— 旧屏一格不动(律②),块表变了就把 `active` 夹回范围内,**不回顶**;
 *  · 换宿主 —— 面板内 / 中央区 / 浮窗 / 钉边:拼贴树的结构共享保证不重挂,滚动位
 *              是 DOM 自己的,跟着走。标准档下它自己是一格 `diff` 作用域(owner =
 *              这一格的 refId),所以「激活这一格 = 焦点进它」;
 *  · 卸载   —— 两本在场账各还一格。**读数留在格子里**(律②′);无计时器、无模块级
 *              副作用 → 不需要 HMR dispose。
 *
 * ── ② UI 生命状态 ────────────────────────────────────────────────────────
 *  · loading —— **只有首载**画三条骨架(`phase === 'initial'`),重拉期间旧屏不动;
 *  · ready   —— 四种形:两版都在 = 整文件;只有 head = 整篇 del;只有 work =
 *               整篇 add;任一版 binary = 一句话(不画乱码);
 *  · gone    —— **`status` 读到了、而这一行不在里头**(批⑤ 新增):这个文件此刻
 *               没有改动了(被提交、被撤销)。说一句话,**tab 不自动关** ——
 *               自动关等于替人关标签(§6.4 裁定)。判据是 status 那一份而不是
 *               两版原文:后者要等一次重拉才知道,而这一格早就不该再画旧内容;
 *  · empty   —— 两版原文都读到了、但**一个改动块都没有** → 同一句话。判据是块数
 *               不是行数:两版逐字相同时整篇都是未改行,画出来是一份没有任何改动
 *               的文件 —— 那不是「改动」该说的话;
 *  · error   —— 通知行 + **后端原话** + 一颗重试,**旧屏不清**;
 *  · 超量    —— 两万行的文件:`skip` 交给基础件逐行跳渲,地图按比例定位(它画的是
 *               块数不是行数),↑↓ 只改一格下标 —— 三件都与行数无关。
 *
 * ── ③ UI 交互状态 ────────────────────────────────────────────────────────
 *  · rest / hover / focus —— 两颗箭头是 `ui/IconButton`(皮肤随件走,焦点环全局);
 *    标准档下整块的落点是**正文那块滚动容器**(`tabIndex={-1}`):进来之后 ↑↓
 *    翻的是这份文件,而不是别处那张列表;
 *  · active  —— 「此刻停在第几块」:檐上读数 `k / N` + 那一行的 `data-current` +
 *               地图上那一格 `data-active`,**三处读同一格状态**;
 *  · disabled —— 一处都没有:只有一块改动时 ↑↓ 仍然按得动(循环回自己),
 *               零块时整组不画(没有「按了没反应」的钮);
 *  · pending —— 这块面没有写动作;重试那一颗的忙由 query 自己说。
 */

export interface ChangeFileViewProps {
  /** 那个工作目录(= 改动面那一格的 root,也是两族 query 键的头一段)。 */
  root: string
  /** **仓库根相对**路径(与 git 自己说的一样)。 */
  path: string
  /**
   * 这一格在拼贴台里的名字(`refId(changeRef(root, path))`)。
   *
   * **它同时是「这一份是不是一格独立内容」的判据**:给了 = 标准档(它自己是一格
   * `diff` 作用域,焦点点名进得来);不给 = 改动面 `panel` 档那条**内联**分栏 ——
   * 那时它是那块面的一部分,再登记一格同名作用域只会让 `activateScope('diff')`
   * 在两份实例之间靠 MRU 猜(而那正是 W5-c 立法要治的病)。
   */
  owner?: string
}

export function ChangeFileView({ root, path, owner }: ChangeFileViewProps) {
  const t = useT()
  /*
   * 两句报到。**这块面自己说「我在看什么」,取数的生命周期归数据层** —— 与
   * `ChangesPanel` 那一句 `useChangesLive` 是同一条纪律,而且两句都幂等:改动面
   * 开着的同时再开一格这个文件,后端一次都不多问。
   */
  useChangesLive(root)
  useFileLive(root, path)

  const status = useQuery(statusQuery.get(root))
  const snapshot = useQuery(fileQueryOf(root, path))
  const view = snapshot.data
  const bodyRef = useRef<HTMLDivElement | null>(null)

  /**
   * **自己那一行**(± 与状态的来源)。从前它是一格 prop —— 那正是「只能长在那块
   * 面里」的产地。
   *
   * `gone` = status 读到了、而这一行不在里头。`status.data === undefined` 时它是
   * **false**(还没读到不等于没有了):一格刚开出来的 tab 不该先说一句「此刻没有
   * 改动」再改口。
   */
  const row: GitChangedFile | undefined = status.data?.files?.find((f) => f.path === path)
  const gone = status.data !== undefined && row === undefined

  /*
   * 两份原文 → 一串行。**只在原文真变了的时候算一遍** —— 这块面每一次刷新 /
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
  }, [path])
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
    const line = body?.querySelector<HTMLElement>(`[data-line-index="${blocks[next]}"]`)
    if (!body || !line) return
    body.scrollTop = Math.max(0, line.offsetTop - body.clientHeight / 2)
  }

  const step = (delta: number) => {
    if (blocks.length === 0) return
    goTo((at + delta + blocks.length) % blocks.length)
  }

  const name = splitPath(path)
  const binary = Boolean(view?.head?.binary || view?.work?.binary)
  const truncated = Boolean(view?.head?.truncated || view?.work?.truncated)
  /** 正文画不画得出来。`gone` 压过一切:那时旧内容是一份已经不成立的事实。 */
  const showDiff = !gone && !binary && diff !== undefined && diff.blocks.length > 0

  const body = (
    <>
      <div
        className={s.body}
        ref={bodyRef}
        /*
         * 标准档下这块滚动容器就是作用域的落点,所以它要接得住焦点。
         * `-1` 而不是 `0`:Tab 序里不多一站(檐上那两颗钮才是这块面的键盘入口),
         * 但树把焦点送进来时它接得住 —— 不变量 I1 要的正是「焦点永远落在东西上」。
         */
        tabIndex={-1}
        data-testid="changes-body"
        data-change-body-path={path}
      >
        {/*
          * 檐:身份 + ± 统计 + 导航。**sticky**(样式表那一条)—— 一份文件铺开好几屏,
          * 滚到中间时「我在看哪个文件、这是第几处改动」必须还在屏上。
          */}
        <div className={s.bodyHead}>
          <Tooltip content={path}>
            <span className={s.bodyPath}>
              <span className={s.bodyPathDir}>{name.dir}</span>
              <span className={s.bodyPathName}>{name.name}</span>
            </span>
          </Tooltip>
          {row?.add ? <span className={s.statAdd}>{`+${row.add}`}</span> : null}
          {row?.del ? <span className={s.statDel}>{`−${row.del}`}</span> : null}
          {showDiff && blocks.length > 0 && (
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
            <Button size="sm" variant="ghost" onClick={() => void fileQueryOf(root, path).refetch()}>
              {t('diff.retry')}
            </Button>
          </p>
        )}

        {gone ? (
          /*
           * 这个文件此刻不在改动表里了(提交掉 / 撤销掉)。**说出来,tab 留着**
           * —— 关掉别人的标签不是这块面的事(§6.4 裁定)。
           */
          <p className={s.bodyNote} data-testid="changes-body-gone">
            {t('diff.noDiff')}
          </p>
        ) : binary ? (
          <p className={s.bodyNote} data-testid="changes-body-binary">
            {t('diff.fileBinary')}
          </p>
        ) : showDiff && diff ? (
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
      {showDiff && diff && <ChangeMap lines={diff.lines} blocks={blocks} active={at} onPick={goTo} />}
    </>
  )

  /*
   * 内联那一档(改动面 `panel` 档的分栏):它是那块面的一部分,**不登记作用域**
   * ——判词在 `owner` 那格 prop 上。
   */
  if (!owner) {
    return (
      <div className={s.fileArea} data-testid="changes-file-view" data-change-inline="true">
        {body}
      </div>
    )
  }

  return (
    <FocusScope
      scope="diff"
      owner={owner}
      /* 落点 = 正文那块滚动容器(它带 `tabIndex={-1}`);答不出就落根上。 */
      restingTarget={() => bodyRef.current}
    >
      {({ scopeProps }) => (
        <div {...scopeProps} className={s.fileArea} data-testid="changes-file-view">
          {body}
        </div>
      )}
    </FocusScope>
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
