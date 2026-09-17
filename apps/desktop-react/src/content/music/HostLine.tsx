import { Tooltip } from '../../ui/Tooltip'
import { useQuery } from '../../data/kernel'
import { musicBriefQuery, musicProgrammeQuery } from '../../data/music-source'
import { useT } from '../../i18n'
import s from '../MusicPanel.module.css'

/**
 * **主持人一行**(唱机音乐面 M1)。电台开着时,告诉人主持人**接下来要做什么**。
 *
 * ── 只说读得到的事实 ────────────────────────────────────────────────────
 * 今天的读数里没有「正在播的这一张说了什么」:歌一开播,那条 `say` 就随节目单出队了,
 * 也没有「正在说」这一格(方案 M2 补)。所以这一行只答三件读得到的事:
 *   · `brief.starting` 在 → 正在换到那一首,主持人先开口(换歌中)
 *   · 节目单头一条带 `say` → 下一首前要说的那句
 *   · 节目单空着 → 主持人在挑歌
 * 编一句「主持人正在说……」是撒谎,等 M2 的读数到了再把这一行换成当前口播。
 *
 * 口播可能很长,行内两行截断,整句进 Tooltip(禁 native title=)。
 *
 * 三张状态表:① 纯读数、无本地状态;② 电台关着 → 不画;首载未到 → 不画;
 * ③ 无交互(Tooltip 的 hover / focus 随件走)。
 */
export function HostLine() {
  const t = useT()
  const brief = useQuery(musicBriefQuery)
  const programme = useQuery(musicProgrammeQuery)
  if (!brief.data?.active) return null

  const next = programme.data?.entries[0]
  const text = brief.data.starting
    ? t('music.hostStarting', { title: brief.data.starting })
    : programme.phase === 'ready' && !next
      ? t('music.hostCurating')
      : next?.say
        ? t('music.hostNextSay', { say: next.say })
        : next
          ? t('music.hostQuiet')
          : undefined
  if (!text) return null

  return (
    <div className={s.host} data-testid="music-host" data-speaking={brief.data.starting ? 'true' : undefined}>
      <span className={s.hostWho}>{t('music.host')}</span>
      <Tooltip content={text}>
        <p className={s.hostSay}>{text}</p>
      </Tooltip>
    </div>
  )
}
