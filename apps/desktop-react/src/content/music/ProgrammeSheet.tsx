import { useState } from 'react'
import { Ellipsis, GripVertical } from '../../components/icons'
import { AsyncButton } from '../../ui/AsyncButton'
import { IconButton } from '../../ui/IconButton'
import { Input } from '../../ui/Input'
import { useListReorder } from '../../ui/list-reorder'
import { Menu, MenuItem, MenuSection } from '../../ui/Menu'
import { Tooltip } from '../../ui/Tooltip'
import { useMutation, useQuery } from '../../data/kernel'
import type { MusicProgrammeEntryDTO } from '@shared/ipc/music'
import { musicOps, musicProgrammeQuery } from '../../data/music-source'
import { copyText } from '../../services/clipboard'
import { useT } from '../../i18n'
import { PROGRAMME_LIMIT, firstError, splitTitle } from './turntable'
import s from '../MusicPanel.module.css'

interface RowMenu {
  entry: MusicProgrammeEntryDTO
  index: number
  x: number
  y: number
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
 */
export function ProgrammeSheet() {
  const t = useT()
  const programme = useQuery(musicProgrammeQuery)
  const request = useMutation(musicOps.request)
  const edit = useMutation(musicOps.programmeAction)
  const [song, setSong] = useState('')
  const [menu, setMenu] = useState<RowMenu | null>(null)

  const entries = programme.data?.entries ?? []
  const shown = entries.slice(0, PROGRAMME_LIMIT)
  const hidden = entries.length - shown.length
  const error = firstError(request, edit)

  const act = (entry: MusicProgrammeEntryDTO, action: Record<string, unknown>) =>
    void musicOps.programmeAction.run({ action: { encryptedId: entry.encryptedId, ...action } })

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
      <h2 className={s.head}>
        {entries.length > 0 ? t('music.programmeCount', { count: entries.length }) : t('music.programme')}
      </h2>

      {programme.phase === 'ready' && entries.length === 0 && <p className={s.none}>{t('music.programmeEmpty')}</p>}

      {shown.length > 0 && (
        <ol className={s.list} data-testid="music-programme" {...reorder.listProps}>
          {shown.map((entry, index) => {
            const { name, artist } = splitTitle(entry.title)
            return (
              <li
                key={entry.encryptedId}
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
                <div className={s.entryText}>
                  <span className={s.entryTitle}>
                    <span className={s.entryName}>{name}</span>
                    {artist && <span className={s.entryArtist}>{artist}</span>}
                    {entry.note && <span className={s.entryNote}>{entry.note}</span>}
                  </span>
                  {entry.say && (
                    <Tooltip content={entry.say}>
                      <span className={s.entrySay}>{entry.say}</span>
                    </Tooltip>
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
            )
          })}
        </ol>
      )}
      {hidden > 0 && <p className={s.meta}>{t('music.programmeMore', { count: hidden })}</p>}

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
      {error && (
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
