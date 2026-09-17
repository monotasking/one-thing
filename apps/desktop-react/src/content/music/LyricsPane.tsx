import { useLayoutEffect, useMemo, useRef } from 'react'
import { ButtonBase } from '../../ui/ButtonBase'
import { Fold, FoldBody, FoldTrigger } from '../../ui/Fold'
import { useQuery } from '../../data/kernel'
import { musicLyricsQuery, musicOps } from '../../data/music-source'
import { useT } from '../../i18n'
import { lyricIndexAt } from './turntable'
import s from '../MusicPanel.module.css'

/**
 * **歌词**(唱机音乐面 M1)。当前那一句居中高亮;点任意一句 = 从这句开始放(`seek`)。
 *
 * 高亮跟的是播放钟推出来的位置(`usePlaybackPosition`),读数里的 `at` 是那一句的
 * 坐标。居中靠一格 `translateY` 写在列表上(`--lyrics-shift`),只在「唱到哪一句」
 * 换了的那一拍量一次 —— 不是每 250ms 量一次。
 *
 * 三张状态表:① 纯读数 + 一格折叠开合(`ui/Fold` 自持,缺省展开);
 * ② 首载 → 身子不画;没有歌词(`null` / 空)→ 一句「这首没有歌词」;读失败 → 另起一行;
 * ③ 每一句是一颗 ButtonBase(结构性交互件),hover / focus 随全局配方;没有歌 → 整块不画。
 */
export function LyricsPane({ position, hasSong }: { position: number | undefined; hasSong: boolean }) {
  const t = useT()
  const lyrics = useQuery(musicLyricsQuery)
  const windowRef = useRef<HTMLDivElement | null>(null)
  const listRef = useRef<HTMLOListElement | null>(null)
  const lines = useMemo(() => lyrics.data?.lines ?? [], [lyrics.data])
  const current = position === undefined ? -1 : lyricIndexAt(lines, position)

  useLayoutEffect(() => {
    const win = windowRef.current
    const list = listRef.current
    if (!win || !list) return
    const row = list.children[Math.max(0, current)] as HTMLElement | undefined
    const shift = row ? win.clientHeight / 2 - row.offsetTop - row.offsetHeight / 2 : 0
    list.style.setProperty('--lyrics-shift', `${Math.round(shift)}px`)
  }, [current, lines])

  if (!hasSong) return null

  return (
    <section className={s.lyricsBlock} data-testid="music-lyrics">
      <Fold defaultOpen>
        <h2 className={s.head}>
          <FoldTrigger as="span" className={s.foldHead} data-testid="music-lyrics-toggle">
            {t('music.lyrics')}
          </FoldTrigger>
        </h2>
        <FoldBody>
          {lyrics.phase === 'ready' && lines.length === 0 ? (
            <p className={s.none}>{t('music.lyricsEmpty')}</p>
          ) : (
            <div ref={windowRef} className={s.lyricsWindow}>
              <ol ref={listRef} className={s.lyrics}>
                {lines.map((line, i) => (
                  // 一行歌词没有 id;`at` 是它在这首歌里的坐标,同一首里不会重复。
                  <li key={`${line.at}-${i}`} className={s.lyricLine} data-current={i === current ? 'true' : undefined}>
                    <ButtonBase
                      className={s.lyricButton}
                      aria-label={t('music.lyricSeek', { line: line.text })}
                      onClick={() => void musicOps.seek.run({ position: Math.round(line.at) })}
                    >
                      {line.text}
                    </ButtonBase>
                  </li>
                ))}
              </ol>
            </div>
          )}
        </FoldBody>
      </Fold>
      {lyrics.error && <p className={s.bad}>{lyrics.error}</p>}
    </section>
  )
}
