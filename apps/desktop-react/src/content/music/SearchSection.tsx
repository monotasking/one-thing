import { useState } from 'react'
import type { MusicSearchRecordDTO } from '@shared/ipc/music'
import { Search } from '../../components/icons'
import { useMutation } from '../../data/kernel'
import { musicPickOp, musicSearchOp } from '../../data/music-source'
import { useT } from '../../i18n'
import { AsyncButton } from '../../ui/AsyncButton'
import { Input } from '../../ui/Input'
import { discStyle } from './ProgrammeSheet'
import { MUSIC_RADIO_SECTION } from './section-ids'
import s from './MusicFrame.module.css'
import panel from '../MusicPanel.module.css'

/** 一次搜索最多列几行。再多就是一张滚不完的单子,而人要的通常在前几行。 */
export const MUSIC_SEARCH_LIMIT = 30

/** 一行结果的「歌名 歌手」—— `request` 认的就是这个形(自述原话)。 */
function songOf(record: MusicSearchRecordDTO): string {
  return record.artist ? `${record.title} ${record.artist}` : record.title
}

/**
 * **「搜索」那一格**(音乐面 v9,2026-09-25;正本 `docs/music-panel-2026-09.md` §10.5)。
 *
 * 成熟的音乐 App 都有一格搜索。这台机器上**放歌的正路是电台**(模型那只工具的自述:电台开着时绝不
 * 手动放),所以点一首的意思跟着电台走 —— 开着 = 插到下一首(`request`),关着 = 以它开台
 * (`open`,意图是「先放这首,再接相似的」)。钮上的字把这件事说出来(「插到下一首」/「用它开台」),
 * 输入框下一句灰字再说一遍:人按下去之前就知道会发生什么。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 三张状态表
 * ══════════════════════════════════════════════════════════════════════════
 * ① 生命周期:查询词与最近一次答案是这一格的本地状态,切到别的分区不丢(分区保挂载),不落盘;
 *    答案只在**新答案回来那一刻**换(律②:搜索期间旧结果一行不动)。
 * ② UI 生命状态:
 *    · 还没搜    —— 一句指引(搜什么、点了会怎样);
 *    · 搜索中    —— 搜索钮「搜索中…」+ 停用;旧结果留着;
 *    · 有结果    —— 一行:碟形色块 / 歌名 · 歌手 / 动作钮;`playFlag === false` 的行灰掉、钮换成「没有版权」;
 *    · 没结果    —— 「没搜到『词』,换个说法试试」;
 *    · 出错      —— 结果区上方一行原话(搜索的错与点歌的错各一行,互不覆盖);
 *    · 超量      —— 封顶 `MUSIC_SEARCH_LIMIT` 行 + 一句「只列出前 N 首」;歌名单行截断。
 * ③ UI 交互状态:输入随 `ui/Input`;回车 = 搜索;每行的钮按 `song` 分格 pending(点第三行只有第三行在转)。
 */
export function SearchSection({ radioOn, navigate }: { radioOn: boolean; navigate: (id: string) => void }) {
  const t = useT()
  const search = useMutation(musicSearchOp)
  const pick = useMutation(musicPickOp)
  const [query, setQuery] = useState('')
  const [answer, setAnswer] = useState<{ query: string; records: MusicSearchRecordDTO[] } | null>(null)
  const [picked, setPicked] = useState<string | null>(null)

  const run = () => {
    const term = query.trim()
    if (!term) return
    void musicSearchOp.run({ query: term }).then((records) => {
      if (records) setAnswer({ query: term, records })
    })
  }

  const records = answer?.records ?? []
  const shown = records.slice(0, MUSIC_SEARCH_LIMIT)

  return (
    <div className={s.page} data-testid="music-section-search">
      <form
        className={s.formRow}
        role="search"
        onSubmit={(e) => {
          e.preventDefault()
          run()
        }}
      >
        <Input
          value={query}
          onValueChange={setQuery}
          prefix={<Search className={s.inputIcon} aria-hidden="true" />}
          placeholder={t('music.search.placeholder')}
          aria-label={t('music.search.placeholder')}
          data-testid="music-search-input"
        />
        <AsyncButton type="submit" variant="primary" action={musicSearchOp} pendingLabel={t('music.search.searching')} disabled={!query.trim()} data-testid="music-search-submit">
          {t('music.search.submit')}
        </AsyncButton>
      </form>
      <p className={s.hint}>{t(radioOn ? 'music.search.hintOn' : 'music.search.hintOff')}</p>

      {search.error ? <p className={s.bad} data-testid="music-search-error">{search.error}</p> : null}
      {pick.error ? (
        <p className={s.bad} data-testid="music-pick-error">
          {t('music.search.pickFailed', { name: picked ?? '', message: pick.error })}
        </p>
      ) : null}

      {answer === null ? null : records.length === 0 ? (
        <p className={s.hint} data-testid="music-search-empty">{t('music.search.empty', { query: answer.query })}</p>
      ) : (
        <>
          <ul className={s.results} aria-label={t('music.search.results', { query: answer.query })} data-testid="music-search-results">
            {shown.map((record, index) => {
              const song = songOf(record)
              const blocked = record.playFlag === false
              return (
                <li key={`${index}:${song}`} className={s.result} data-blocked={blocked || undefined}>
                  <span className={panel.disc} style={discStyle(record.title)} aria-hidden="true" />
                  <span className={s.resultText}>
                    <span className={s.resultTitle}>{record.title}</span>
                    {record.artist ? <span className={s.resultArtist}>{record.artist}</span> : null}
                  </span>
                  {blocked ? (
                    <span className={s.resultNote}>{t('music.search.blocked')}</span>
                  ) : (
                    <AsyncButton
                      size="sm"
                      action={musicPickOp}
                      pendingKey={song}
                      pendingLabel={t('common.working')}
                      aria-label={t(radioOn ? 'music.search.requestOne' : 'music.search.openWithOne', { name: record.title })}
                      data-testid="music-search-pick"
                      onClick={() => {
                        setPicked(record.title)
                        void musicPickOp
                          .run({ song, radioOn, intent: t('music.search.openIntent', { song }) })
                          .then(() => {
                            // 关着时以它开台:成了就带人去电台那一格看这一台开起来(开台要一分钟,那边有状态)。
                            if (!radioOn && !musicPickOp.get().error) navigate(MUSIC_RADIO_SECTION)
                          })
                      }}
                    >
                      {t(radioOn ? 'music.search.request' : 'music.search.openWith')}
                    </AsyncButton>
                  )}
                </li>
              )
            })}
          </ul>
          {records.length > MUSIC_SEARCH_LIMIT ? <p className={s.hint}>{t('music.search.capped', { count: MUSIC_SEARCH_LIMIT })}</p> : null}
        </>
      )}
    </div>
  )
}
