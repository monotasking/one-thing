import { Fragment, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import { ChevronRight, Ellipsis, GripVertical, MicVocal, Play } from '../../components/icons'
import { AsyncButton } from '../../ui/AsyncButton'
import { ButtonBase } from '../../ui/ButtonBase'
import { IconButton } from '../../ui/IconButton'
import { Input } from '../../ui/Input'
import { useListReorder } from '../../ui/list-reorder'
import { Menu, MenuItem, MenuSection } from '../../ui/Menu'
import { Spinner } from '../../ui/Spinner'
import { Tooltip } from '../../ui/Tooltip'
import { useMutation, useQuery } from '../../data/kernel'
import type { MusicProgrammeEntryDTO } from '@shared/ipc/music'
import type { MusicNowPlayingView } from '../../data/music-source'
import { musicBriefQuery, musicOps, musicProgrammeQuery } from '../../data/music-source'
import { copyText } from '../../services/clipboard'
import { useT } from '../../i18n'
import { labelColorsFor } from './record-geometry'
import { PROGRAMME_LIMIT, clockOf, firstError, splitTitle } from './turntable'
import s from '../MusicPanel.module.css'

interface RowMenu {
  entry: MusicProgrammeEntryDTO
  index: number
  x: number
  y: number
}

/** 那一行「立即播放」发出中 / 失败了。一次只有一格 —— 两条同时在飞会打乱同一张节目单。 */
interface PlayNow {
  encryptedId: string
  error?: string
}

/**
 * **碟形色块**(§8.2):一张唱片的最简形 —— 中心一个孔、一圈标签、外面是盘面。
 * 标签色由歌名散列(`labelColorsFor`,与唱片标签同一只函数,所以同一首歌
 * 在列表里、在唱机上是同一个颜色)。
 *
 * **它不是封面占位图**:封面这件事后端没有(判词在 `MusicPanel.tsx` 文件头),
 * 一块灰方块会被读成「还没加载出来」,而它永远不会来。
 */
export function discStyle(title: string | undefined): CSSProperties {
  const colors = labelColorsFor(title ?? '')
  return { '--sleeve-light': colors.paper, '--sleeve-dark': colors.ink } as CSSProperties
}

/**
 * **串联单**(唱机音乐面 M1;v7 起它住在播放列表抽屉里,内容一个字没改):
 * 接下来要放的歌、主持人每首前要说的话、点歌。
 *
 * ── 动作单产地 = 右键菜单 ───────────────────────────────────────────────
 * 一行的全部动作(提到下一首 / 上移 / 下移 / 拿掉 / 复制歌名)收进同一张 `ui/Menu`。
 * 行尾那颗「⋯」开的是**同一张表**,只为键盘与没有右键习惯的人有个看得见的入口
 * (两处调同一只 `setMenu`,表只有一份)。不做双击。
 *
 * 「拿掉」在后端同时是最强的口味信号,菜单项上直接写明「以后少排这类」。
 *
 * ── 换序三条路,一只 `programmeAction` ──────────────────────────────────
 * 09-18 补上了拖拽:行首那颗把手来自 `ui/list-reorder`(那是**唯一**的换序编舞,
 * 业务面一行拖拽代码都没有 —— 「基础件先行」那条法)。三条入口最终都发同一条
 * `{ kind: 'move', encryptedId, toIndex }`:
 *   拖   从把手起拖,松手落在第几位就是 `toIndex`;
 *   键盘 焦点在把手上按 ↑ ↓ Home End(基础件自己认,这块面一个 keydown 都不写);
 *   菜单 上移 / 下移照旧留着 —— 它是「不知道有把手」的人那条路,而且两条键盘路
 *        不打架(把手上的方向键归换序,菜单里的项归菜单)。
 * 乐观补丁与失败回滚一个字没改:`data/music-source.applyProgrammeAction` 认的
 * `toIndex` 本来就是**最终位置**,与基础件交出来的那个数是同一个坐标系。
 *
 * ── 三张状态表 ──────────────────────────────────────────────────────────
 * ① 生命周期:本地两格 —— 点歌草稿、一张半开的菜单;菜单跟着行身份(encryptedId)走,
 *    那一行被别处拿掉时菜单里的动作答「找不到」由乐观补丁原样交回(无副作用)。
 * ② UI 生命状态:首载 → 不画身子;空(含电台关着 —— v7 起这块面住在抽屉里,而人是
 *    **亲手**把它拉开的,交一块空白比交一句「节目单空着」更像坏了)→ 一句「节目单空着」;
 *    超量 → 封顶 `PROGRAMME_LIMIT` 行 + 一句文字读数,列表自带最大高度可滚;
 *    读 / 做失败 → 旧行留着,错误另起一行(`music-programme-error`)。
 * ③ UI 交互状态:行 hover 底色(CSS);「⋯」随 IconButton;编辑是乐观的 —— 行当场挪 /
 *    消失,失败回滚;点歌 AsyncButton 逐格 pending,草稿为空时停用。
 *
 * ── 样例剩下的三条(2026-09-18,正本 §8.1 / §8.2 / §8.3)────────────────────
 *  · **头上一段「正在播放」**:`nowPlaying` 有歌时画一行 —— 碟形色块 + 歌名歌手 +
 *    均衡器条 + 贴着行底边一条进度。那一行**不可点、没有把手、没有 ⋯**:它已经在放了,
 *    「提到下一首」「拿掉」对它都不是一句有意义的话。读数由**父级递进来**而不是这里
 *    再订一次(同一份真相只订一遍:`usePlaybackPosition` 起的是一只
 *    250ms 的钟,订两遍就是两只钟,迟早差一帧)。
 *  · **悬停即放**:每行左边那枚色块上浮一颗三角,点它 = `promote` + `next` ——
 *    与右键菜单里「提到下一首」走**同一条** `programmeAction`,不新开做法。
 *    逐格 pending(律③):发出中的那一行三角转圈,其余行照常可点。
 *  · **小话筒**:`entry.say` 有值的行,歌名后一枚记号,提示里是整句。
 */
export function ProgrammeSheet({
  nowPlaying,
  position,
  sideRoom,
}: {
  /** 正在放的那一首。缺席(或没歌名)= 顶上那一段整段不画,不留空段头。 */
  nowPlaying?: MusicNowPlayingView
  /** 播放钟推出来的位置。与唱臂、进度条、歌词高亮吃同一个数。 */
  position?: number
  /**
   * 这一面还能再排几首(音乐面 v8:唱片就是这一面的节目单)。列表在第 `sideRoom` 首之后画一条
   * 「翻面以后」—— 那之后的歌不在这张唱片的这一面上。缺席 = 没歌在放,说不出这一面在哪结束,不画。
   */
  sideRoom?: number
} = {}) {
  const t = useT()
  const programme = useQuery(musicProgrammeQuery)
  const brief = useQuery(musicBriefQuery)
  const [historyOpen, setHistoryOpen] = useState(false)
  const request = useMutation(musicOps.request)
  const edit = useMutation(musicOps.programmeAction)
  const [song, setSong] = useState('')
  const [menu, setMenu] = useState<RowMenu | null>(null)
  const [playNow, setPlayNow] = useState<PlayNow | null>(null)
  /*
   * 「这一下已经在飞了」是**同一拍之内**就要答得出的事实,所以它是一格 ref 而不是
   * 上面那格 state:两下点击落在同一拍里时,第二只回调手上的 `playNow` 还是旧的 null,
   * 那颗钮的 `disabled` 也要到下一次提交才生效 —— 光靠 state 拦不住连点。
   */
  const firing = useRef(false)

  const entries = programme.data?.entries ?? []
  const shown = entries.slice(0, PROGRAMME_LIMIT)
  const hidden = entries.length - shown.length
  const error = firstError(request, edit)
  const recent = brief.data?.recent ?? []
  const history = recent[0]?.title === nowPlaying?.title ? recent.slice(1) : recent
  const nowTitle = nowPlaying?.title
  const now = nowTitle ? splitTitle(nowTitle) : undefined
  const duration = nowPlaying?.duration
  const played =
    duration !== undefined && duration > 0 && position !== undefined
      ? Math.max(0, Math.min(1, position / duration))
      : 0

  const act = (entry: MusicProgrammeEntryDTO, action: Record<string, unknown>) =>
    void musicOps.programmeAction.run({ action: { encryptedId: entry.encryptedId, ...action } })

  /*
   * 「立即播放」= 提到第一位,再换歌。两条做法都是现成的,这里**只管顺序与那一格 pending**:
   * 第一条没成就停在这儿(硬推 `next` 会放到别的歌上去,那比不动更坏),错话留在那一行下面。
   * 在飞的时候再点一次直接返回 —— 一张节目单上两条 promote 同时在飞,谁在前谁在后没有答案。
   */
  const runPlayNow = async (entry: MusicProgrammeEntryDTO) => {
    if (firing.current) return
    firing.current = true
    const encryptedId = entry.encryptedId
    setPlayNow({ encryptedId })
    try {
      await musicOps.programmeAction.run({ action: { kind: 'promote', encryptedId } })
      const promoted = musicOps.programmeAction.get().error
      if (promoted) {
        setPlayNow({ encryptedId, error: promoted })
        return
      }
      await musicOps.next.run({})
      const advanced = musicOps.next.get().error
      setPlayNow(advanced ? { encryptedId, error: advanced } : null)
    } finally {
      firing.current = false
    }
  }

  /*
   * 换序那一件。`ids` 喂的是**画在屏上的那几行**(`shown`)而不是 `entries`:
   * 超量时列表封顶在 `PROGRAMME_LIMIT`,把手能挪到的位置只能是看得见的那几格 ——
   * 交一个屏幕上不存在的落点等于让人凭空猜。位次对人说是 1 起(「第 3 首」),
   * 对 `toIndex` 说是 0 起,两者的换算只在这两句文案里发生。
   */
  const reorder = useListReorder({
    ids: shown.map((entry) => entry.encryptedId),
    onMove: (encryptedId, toIndex) =>
      void musicOps.programmeAction.run({ action: { kind: 'move', encryptedId, toIndex } }),
    labels: {
      handle: (index) => t('music.rowDrag', { position: index + 1 }),
      moved: (_from, to) => t('music.rowMoved', { position: to + 1, total: shown.length }),
    },
  })

  return (
    <section className={s.sheet} data-testid="music-programme-sheet">
      {/* ── §8.1 正在播放 ──────────────────────────────────────────────────
        * 没歌就整段不画(段头也不画):一个「正在播放」底下空着,说的是「坏了」。 */}
      {now && (
        <>
          <h2 className={s.head}>{t('music.nowSection')}</h2>
          <ol className={s.list}>
            <li className={s.entry} data-now="true" data-testid="music-now-row">
              <span className={s.disc} style={discStyle(nowTitle)} aria-hidden="true" />
              <div className={s.entryText}>
                <span className={s.entryTitle}>
                  <span className={s.entryName}>{now.name || t('music.untitled')}</span>
                  {now.artist && <span className={s.entryArtist}>{now.artist}</span>}
                </span>
              </div>
              {/* 均衡器条:只在真的在放时起伏(暂停时三根静止 —— 停了就不该有声浪)。
                * 动效档「无」与系统偏好下同样停住,形在 MusicPanel.module.css。 */}
              <span className={s.eq} data-playing={nowPlaying?.playing ? 'true' : undefined} aria-hidden="true">
                <i />
                <i />
                <i />
              </span>
              {/* 贴着行底边那条进度。它是**读数**不是控件:不接指针,拖进度在歌条上。 */}
              <span className={s.nowBar} aria-hidden="true">
                <i data-testid="music-now-progress" style={{ width: `${(played * 100).toFixed(2)}%` }} />
              </span>
            </li>
          </ol>
        </>
      )}

      <h2 className={s.head}>
        {entries.length > 0 ? t('music.programmeCount', { count: entries.length }) : t('music.programme')}
      </h2>

      {programme.phase === 'ready' && entries.length === 0 && <p className={s.none}>{t('music.programmeEmpty')}</p>}

      {shown.length > 0 && (
        <ol className={s.list} data-testid="music-programme" {...reorder.listProps}>
          {shown.map((entry, index) => {
            const { name, artist } = splitTitle(entry.title)
            const busy = playNow?.encryptedId === entry.encryptedId && playNow.error === undefined
            const failed = playNow?.encryptedId === entry.encryptedId ? playNow.error : undefined
            const flipBefore = sideRoom !== undefined && sideRoom > 0 && index === sideRoom
            return (
              <Fragment key={entry.encryptedId}>
              {flipBefore && (
                <li className={s.flipLine} data-testid="music-flip-line" aria-hidden="true">
                  {t('music.deckFlipAfter')}
                </li>
              )}
              <li
                className={s.entry}
                data-music-entry={entry.encryptedId}
                {...reorder.itemProps(entry.encryptedId)}
                onContextMenu={(e) => {
                  e.preventDefault()
                  setMenu({ entry, index, x: e.clientX, y: e.clientY })
                }}
              >
                {/* 把手站在行首:它是这一行**唯一**的起拖口(整行可拖会与右键菜单
                    和行里那颗「⋯」打架),名字与播报由这块面给,编舞归基础件。 */}
                <IconButton
                  icon={GripVertical}
                  size="xs"
                  testId={`music-entry-drag:${entry.encryptedId}`}
                  {...reorder.handleProps(entry.encryptedId, index)}
                />
                {/* §8.2 碟形色块 + 悬停即放。三角是**真按钮**(Tab 到得了、有名字),
                    浮出来只是它的可见性 —— 键盘用户与鼠标用户各有各的路。 */}
                <span className={s.disc} style={discStyle(entry.title)}>
                  <ButtonBase
                    className={s.discPlay}
                    aria-label={t('music.rowPlayNow', { name })}
                    data-testid={`music-entry-play:${entry.encryptedId}`}
                    disabled={busy}
                    onClick={() => void runPlayNow(entry)}
                  >
                    {/* ui-consume-allow: spinner-placement — 这枚圈就在这颗钮的 loading 位上
                      * (`ButtonBase` 是钮,只是视觉本该定制所以不是 `ui/Button`);规则认的是
                      * 字面上的 `<button>` 标签,看不见这一层。 */}
                    {busy ? <Spinner /> : <Play className={s.discPlayIcon} aria-hidden="true" />}
                  </ButtonBase>
                </span>
                <div className={s.entryText}>
                  <span className={s.entryTitle}>
                    <span className={s.entryName}>{name}</span>
                    {/* §8.3 主持人要先说话的那一首。它不是钮,是一句「他会先开口」的记号。 */}
                    {entry.say && (
                      <Tooltip content={entry.say}>
                        {/* eslint-disable jsx-a11y/no-noninteractive-tabindex --
                          * 这枚记号**要够得着**:提示只在悬停 / 聚焦时出现,不进 Tab 序
                          * 就等于键盘用户永远读不到那句话。它不是控件(按下去什么都不发生),
                          * 所以也不许报成 button —— 报成钮才是真的说谎。role="img" + 一个
                          * 名字是「一个有名字的记号」该有的报法,这条规则看的是 role 交不交互,
                          * 看不见「这里挂着一只提示」。 */}
                        <span
                          className={s.sayMark}
                          role="img"
                          tabIndex={0}
                          aria-label={t('music.rowSayMark', { say: entry.say })}
                          data-testid={`music-entry-say:${entry.encryptedId}`}
                        >
                          <MicVocal aria-hidden="true" />
                        </span>
                        {/* eslint-enable jsx-a11y/no-noninteractive-tabindex */}
                      </Tooltip>
                    )}
                    {artist && <span className={s.entryArtist}>{artist}</span>}
                    {entry.note && <span className={s.entryNote}>{entry.note}</span>}
                  </span>
                  {entry.say && (
                    <Tooltip content={entry.say}>
                      <span className={s.entrySay}>{entry.say}</span>
                    </Tooltip>
                  )}
                  {/* 失败就地一行:哪一行按坏了,话就留在哪一行下面。 */}
                  {failed && (
                    <span className={s.entryBad} data-testid="music-entry-error">
                      {failed}
                    </span>
                  )}
                </div>
                <IconButton
                  icon={Ellipsis}
                  label={t('music.rowMore')}
                  size="xs"
                  testId={`music-entry-more:${entry.encryptedId}`}
                  onClick={(e) => {
                    const box = e.currentTarget.getBoundingClientRect()
                    setMenu({ entry, index, x: box.right, y: box.bottom })
                  }}
                />
              </li>
              </Fragment>
            )
          })}
        </ol>
      )}
      {hidden > 0 && <p className={s.meta}>{t('music.programmeMore', { count: hidden })}</p>}

      {/* ── 放过的(音乐面 v8)─────────────────────────────────────────────
        * 本场开台以来放过的歌,新的在前;正在放的那一首已经在顶上那一段了,这里不重复。
        * 默认收起:它是回头看的地方,不是这张单子的主角。 */}
      {history.length > 0 && (
        <>
          <h2 className={s.head}>
            <ButtonBase
              className={s.historyToggle}
              aria-expanded={historyOpen}
              data-testid="music-history-toggle"
              onClick={() => setHistoryOpen((open) => !open)}
            >
              <ChevronRight className={s.historyChevron} aria-hidden="true" />
              {t('music.deckHistory')}
            </ButtonBase>
          </h2>
          {historyOpen && (
            <ol className={s.list} data-testid="music-history">
              {history.map((spin) => {
                const { name, artist } = splitTitle(spin.title)
                return (
                  <li key={`${spin.at}:${spin.title}`} className={s.entry} data-past="true">
                    <span className={s.disc} style={discStyle(spin.title)} aria-hidden="true" />
                    <div className={s.entryText}>
                      <span className={s.entryTitle}>
                        <span className={s.entryName}>{name}</span>
                        {artist && <span className={s.entryArtist}>{artist}</span>}
                      </span>
                    </div>
                    {spin.verdict && (
                      <span className={s.verdict} data-verdict={spin.verdict}>
                        {t(spin.verdict === 'love' ? 'music.deckLoved' : 'music.deckSkipped')}
                      </span>
                    )}
                    {spin.durationS !== undefined && <span className={s.entryDur}>{clockOf(spin.durationS)}</span>}
                  </li>
                )
              })}
            </ol>
          )}
        </>
      )}

      <form
        className={s.formRow}
        onSubmit={(e) => {
          e.preventDefault()
          const text = song.trim()
          if (!text) return
          void musicOps.request.run({ song: text }).then(() => {
            if (!musicOps.request.get().error) setSong('')
          })
        }}
      >
        <Input
          value={song}
          onValueChange={setSong}
          placeholder={t('music.requestPlaceholder')}
          aria-label={t('music.requestPlaceholder')}
          data-testid="music-song"
        />
        <AsyncButton
          action={musicOps.request}
          pendingLabel={t('common.working')}
          type="submit"
          disabled={song.trim() === ''}
          data-testid="music-request"
        >
          {t('music.request')}
        </AsyncButton>
      </form>

      {programme.error && <p className={s.bad}>{programme.error}</p>}
      {/* 「立即播放」失败时那句话已经留在它自己那一行下面了 —— 底下这一行是同一只
        * mutation 的同一句错话,两处画出来是同一件事说两遍。 */}
      {error && error !== playNow?.error && (
        <p className={s.bad} data-testid="music-programme-error">
          {error}
        </p>
      )}

      {menu && (
        <Menu x={menu.x} y={menu.y} onClose={() => setMenu(null)} label={t('music.rowMore')}>
          <MenuSection>{splitTitle(menu.entry.title).name}</MenuSection>
          <MenuItem disabled={menu.index === 0} onClick={() => act(menu.entry, { kind: 'promote' })}>
            {t('music.rowPromote')}
          </MenuItem>
          <MenuItem disabled={menu.index === 0} onClick={() => act(menu.entry, { kind: 'move', toIndex: menu.index - 1 })}>
            {t('music.rowUp')}
          </MenuItem>
          <MenuItem
            disabled={menu.index >= entries.length - 1}
            onClick={() => act(menu.entry, { kind: 'move', toIndex: menu.index + 1 })}
          >
            {t('music.rowDown')}
          </MenuItem>
          <MenuItem onClick={() => void copyText(menu.entry.title)}>{t('music.rowCopy')}</MenuItem>
          <MenuItem danger onClick={() => act(menu.entry, { kind: 'remove' })}>
            {t('music.rowRemove')}
          </MenuItem>
        </Menu>
      )}
    </section>
  )
}
