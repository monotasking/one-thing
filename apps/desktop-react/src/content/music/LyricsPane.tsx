import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import { Play } from '../../components/icons'
import { ButtonBase } from '../../ui/ButtonBase'
import { IconButton } from '../../ui/IconButton'
import { useQuery } from '../../data/kernel'
import { musicLyricsQuery, musicOps } from '../../data/music-source'
import { useT } from '../../i18n'
import { clockOf, splitTitle } from './turntable'
import { currentRowAt, fillOf, hasWords, lyricRowsOf, nearestRowTo } from './lyrics-rows'
import s from '../MusicPanel.module.css'

/**
 * **歌词**(音乐面 v7,正本 `apps/desktop-react/docs/music-panel-2026-09.md` §1)。
 *
 * 一件两形,形由外面那块面按自己的宽给(`panel-width.ts`),这里不量宽:
 *  · `column` —— 面板 ≥ 900 时右边那一栏,常驻,没有页头;
 *  · `page`   —— 面板 < 900 时点「歌词」进的那一屏,唱机场景整块换成它,
 *                页头一颗小碟点回唱机(`onBack`)。
 *
 * ── 跟唱是什么样(逐字搬自用户认可的样例)────────────────────────────────
 *  · 当前那一句**逐字填色**:已唱的那一半是 `--text-1`,没唱到的那一半淡一档,
 *    分界线是一格百分比(`lyrics-rows.ts` 的 `fillOf`),靠 `background-clip: text` 画;
 *  · 自动滚到窗口四成高的位置 —— 不是正中:正中意味着下半屏永远只剩两行,
 *    而人看歌词时想知道的是「接下来唱什么」;
 *  · **手一滚就停跟随 3 秒**,这期间视野正中画一条定位条(时间 + 一颗播放钮),
 *    按它就是从那一句开始放。判据是**手势**(滚轮 / 触摸 / 拖滚动条 / 方向键),
 *    不是 `scroll` 事件 —— 自动滚动自己也发 `scroll`,拿它当判据就是自己把自己停掉;
 *  · 间奏(一段够长的无词空当)画成三个点,一个一个亮起来,不接点击。
 *
 * ── 三张状态表 ──────────────────────────────────────────────────────────
 * ① 生命周期:本地三格 —— 跟不跟随(手势后 3 秒回到跟随)、定位条指着哪一句、
 *    「第一次落位」那一格(第一次不做平滑滚动,直接落位;换歌重置)。卸载清计时器。
 * ② UI 生命状态:首载 → 身子不画;这首没有歌词(一句词都没有,纯音乐也算)→
 *    一句「这首没有歌词」;读失败 → 另起一行;没有歌 → 整件由外面那块面不画。
 * ③ UI 交互状态:每一句是一颗 `ui/ButtonBase`(结构性交互件),hover / focus 随全局配方;
 *    当前句填色;离当前句两行以外淡下去;定位条只在没跟随时在场。
 */

/** 手一滚,多久之后回到跟随。 */
const FOLLOW_RESUME_MS = 3000

export function LyricsPane({
  mode,
  position,
  duration,
  title,
  playing,
  onBack,
}: {
  mode: 'column' | 'page'
  position: number | undefined
  duration: number | undefined
  title: string | undefined
  playing: boolean
  /** `page` 形里点小碟回唱机。`column` 形不传。 */
  onBack?: () => void
}) {
  const t = useT()
  const lyrics = useQuery(musicLyricsQuery)
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const resumeRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const landedRef = useRef(false)
  const [following, setFollowing] = useState(true)
  const [guide, setGuide] = useState<number | null>(null)

  const lines = useMemo(() => lyrics.data?.lines ?? [], [lyrics.data])
  const rows = useMemo(() => lyricRowsOf(lines, duration), [lines, duration])
  const current = currentRowAt(rows, position)
  const words = hasWords(rows)

  /** 换一首歌 = 重新落位(第一次不平滑),并且回到跟随。 */
  useEffect(() => {
    landedRef.current = false
    setFollowing(true)
    setGuide(null)
  }, [lyrics.data?.title])

  useEffect(
    () => () => {
      if (resumeRef.current) clearTimeout(resumeRef.current)
    },
    [],
  )

  /** 一次手势:停跟随,3 秒后自己回来。 */
  const handGesture = useCallback(() => {
    setFollowing(false)
    if (resumeRef.current) clearTimeout(resumeRef.current)
    resumeRef.current = setTimeout(() => {
      setFollowing(true)
      setGuide(null)
    }, FOLLOW_RESUME_MS)
  }, [])

  /** 回到跟随(点了一句 / 按了定位条 —— 人已经说清楚要听哪儿了)。 */
  const resumeFollowing = useCallback(() => {
    if (resumeRef.current) clearTimeout(resumeRef.current)
    landedRef.current = false
    setFollowing(true)
    setGuide(null)
  }, [])

  const rowAt = (index: number): HTMLElement | null =>
    scrollRef.current?.querySelector<HTMLElement>(`[data-lyric-index='${index}']`) ?? null

  /** 跟随中:当前句换了就滚到窗口四成高的位置。 */
  useLayoutEffect(() => {
    if (!following || current < 0) return
    const box = scrollRef.current
    const row = rowAt(current)
    if (!box || !row || typeof box.scrollTo !== 'function') return
    const top = row.offsetTop - box.clientHeight * 0.4 + row.offsetHeight / 2
    box.scrollTo({ top: Math.max(0, top), behavior: landedRef.current ? 'smooth' : 'auto' })
    landedRef.current = true
    // rows 进依赖表:换歌时行集换了,同一个下标指的是另一句。
  }, [current, following, rows])

  /** 没跟随的时候,定位条指着视野正中最近的一句。 */
  const refreshGuide = useCallback(() => {
    const box = scrollRef.current
    if (!box) return
    const boxes = rows.map((_, i) => {
      const row = rowAt(i)
      return row ? { top: row.offsetTop, height: row.offsetHeight } : { top: 0, height: 0 }
    })
    const near = nearestRowTo(rows, boxes, box.scrollTop + box.clientHeight / 2)
    setGuide(near >= 0 ? near : null)
  }, [rows])

  const head =
    mode === 'page' ? (
      <div className={s.lyricsHead}>
        <ButtonBase
          className={s.miniDisc}
          data-spinning={playing ? 'true' : undefined}
          aria-label={t('music.backToTurntable')}
          data-testid="music-lyrics-back"
          onClick={onBack}
        />
        <span className={s.lyricsHeadName}>{splitTitle(title).name}</span>
      </div>
    ) : null

  return (
    <section className={s.lyricsBlock} data-mode={mode} data-testid="music-lyrics">
      {head}
      {lyrics.phase === 'ready' && !words ? (
        <p className={s.lyricsNone} data-testid="music-lyrics-empty">
          {t('music.lyricsEmpty')}
        </p>
      ) : (
        <div className={s.lyricsStage}>
          {/* eslint-disable jsx-a11y/no-noninteractive-element-interactions, jsx-a11y/no-noninteractive-tabindex --
            * **一块可滚动的地是键盘要够得着的**(WCAG 2.1.1:只能用鼠标滚的内容等于键盘
            * 用户看不全),所以 tabIndex=0 + 一个名字;挂在它身上的几只手也不是「给静态
            * 元素加交互」—— onWheel / onTouchMove / onPointerDown / onKeyDown 一个都不改
            * 事件、不 preventDefault,只记一笔「人在自己翻」(跟唱据此让开 3 秒),
            * onScroll 更是浏览器自己发的。jsx-a11y 这两条认的是「元素的 role 交不交互」,
            * 看不见「可滚动」这件事,在这里是误报。真正的交互件是里面每一句那颗
            * ButtonBase —— 点它 = 从这句开始放。 */}
          <div
            ref={scrollRef}
            className={s.lyricsScroll}
            data-testid="music-lyrics-scroll"
            /* 一块**可滚动**的地:键盘要够得着它才滚得动,所以 tabIndex=0 + 一个名字。
             * `group` 而不是 `region`:region 是地标,一块面里的歌词不该进地标表。 */
            role="group"
            tabIndex={0}
            aria-label={t('music.lyrics')}
            /* 手势三路 —— 判的是「手动过」,不是 `scroll`(自动滚动自己也发 scroll)。
             * 方向 / 翻页键那一路走 React 的 onKeyDown:它是这只滚动区自己的结构键,
             * 不拦不改,只记一笔「人在自己翻」。 */
            onWheel={handGesture}
            onTouchMove={handGesture}
            onPointerDown={handGesture}
            onKeyDown={(e) => {
              if (/^(Arrow|Page)/.test(e.key) || e.key === 'Home' || e.key === 'End') handGesture()
            }}
            onScroll={() => {
              if (!following) refreshGuide()
            }}
          >
            <div className={s.lyricsPad} aria-hidden="true" />
            <ol className={s.lyrics}>
              {rows.map((row, i) => {
                const near = current >= 0 && Math.abs(i - current) <= 2
                return (
                  <li
                    // 一行歌词没有 id;`at` 是它在这首歌里的坐标,同一首里不会重复。
                    key={`${row.at}-${i}`}
                    className={s.lyricLine}
                    data-lyric-index={i}
                    data-current={i === current ? 'true' : undefined}
                    data-far={current >= 0 && !near ? 'true' : undefined}
                    style={
                      i === current
                        ? ({ '--music-lyric-p': `${(fillOf(row, position) * 100).toFixed(1)}%` } as CSSProperties)
                        : undefined
                    }
                  >
                    {row.interlude ? (
                      <span className={s.interlude} aria-hidden="true">
                        <i />
                        <i />
                        <i />
                      </span>
                    ) : (
                      <ButtonBase
                        className={s.lyricButton}
                        aria-label={t('music.lyricSeek', { line: row.text })}
                        onClick={() => {
                          resumeFollowing()
                          void musicOps.seek.run({ position: Math.round(row.at) })
                        }}
                      >
                        {row.text}
                      </ButtonBase>
                    )}
                  </li>
                )
              })}
            </ol>
            <div className={s.lyricsPad} aria-hidden="true" />
          </div>
          {/* eslint-enable jsx-a11y/no-noninteractive-element-interactions, jsx-a11y/no-noninteractive-tabindex */}
          {!following && guide !== null && rows[guide] && (
            <div className={s.guide} data-testid="music-lyrics-guide">
              <span className={s.guideTime}>{clockOf(rows[guide].at)}</span>
              <i className={s.guideLine} aria-hidden="true" />
              <IconButton
                icon={Play}
                size="xs"
                label={t('music.lyricSeek', { line: rows[guide].text })}
                testId="music-lyrics-guide-play"
                onClick={() => {
                  const at = rows[guide].at
                  resumeFollowing()
                  void musicOps.seek.run({ position: Math.round(at) })
                }}
              />
            </div>
          )}
        </div>
      )}
      {lyrics.error && <p className={s.bad}>{lyrics.error}</p>}
    </section>
  )
}
