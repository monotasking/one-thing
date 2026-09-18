import { useCallback, useEffect, useRef, useState } from 'react'
import { activateScopeAfterCommit } from '../focus/after-commit'
import { FocusScope } from '../focus/FocusScope'
import { useQuery } from '../data/kernel'
import {
  musicBriefQuery,
  musicNowPlayingQuery,
  musicOps,
  musicProgrammeQuery,
  musicRuntimeQuery,
  useMusicLive,
} from '../data/music-source'
import { useT } from '../i18n'
import type { PetStageHandle } from '../pets/PetStage'
import { DeckRow } from './music/DeckRow'
import { PlaylistDrawer } from './music/PlaylistDrawer'
import { RecordDeck } from './music/RecordDeck'
import { recordSideOf, SIDE_CAP } from './music/record-geometry'
import { SetupWizard, useSetupWizardVisible } from './music/SetupWizard'
import { useMusicPanelForm } from './music/panel-width'
import { useHostTalk } from './music/useHostTalk'
import { usePlaybackPosition } from './music/usePlaybackPosition'
import s from './MusicPanel.module.css'

/**
 * **音乐面 v8 · 唱针读歌词**(2026-09-18;样例「黑豆电台」v7 —— 用户:「ok,就按照这个去实现,100%」)。
 *
 * 面板只有两部分:**上面一整块是唱片和黑豆**(`music/RecordDeck`),**下面一行是进度和按钮**
 * (`music/DeckRow`)。播放列表住在那一行最右边那颗钮后面的抽屉里(`PlaylistDrawer`)。
 * 宽的面板只是唱片更大、歌词更宽,布局一模一样,也没有「歌词」钮 —— 歌词一直都在。
 *
 * 这一版推翻了 v7 的整面:用户 09-18 连着三句 ——「布局很奇怪,歌词和 cd 机竟然是分开的」
 * 「cd 的复杂」「开关、打开歌词等操作,会让 ui 布局变化」。所以:
 *  · 电台条、歌词页 / 歌词栏、歌名那一行、「接下来」那一行、说话条、音量条、⏮ 全部并掉;
 *  · 开台 = ⏯(关着时它就是「开台」)或者「说话」说一句想听什么;换台 = 开着时「说话」;
 *    关台与账号在播放列表抽屉的檐上;
 *  · **布局从不跟着状态变**:唱片那一块与按钮那一行的高度由 token 定死,开台 / 关台 / 暂停 /
 *    说话 / 黑豆挑歌,变的只是格子里的东西。
 *
 * ── 一句话:这块面上每一颗按钮走的都是 `resources.do` ────────────────────
 * 与模型调 `music:player` / `music:radio` 的那只工具是同一条路;电台开着时 `next` 走跳过、
 * `like` 按 onDeck 走服务端,这些分档全在后端端口里,面板只发 `do`。
 *
 * ── 封面:**不画** ──────────────────────────────────────────────────────
 * 自述里 `nowPlaying` 没有封面,标签颜色从歌名算(`labelColorsFor`),不画占位图:一张灰方块
 * 会被读成「封面还没加载出来」,而它永远不会来。
 *
 * ── DJ 语音不在这块面上播(M3:主进程播)────────────────────────────────
 * 主持人是唱片左下角的黑豆;他的话走宠物那条路冒在他头顶。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 三张状态表(整面;唱片那一块与按钮那一行各自的表在各自文件头)
 * ══════════════════════════════════════════════════════════════════════════
 *
 * ── ① 生命周期 ──────────────────────────────────────────────────────────
 *  · 挂载    —— `useMusicLive()` 订 `resource:event` + 五条读数各 `ensure()`(先订后拉);抽屉关着;
 *  · 事件到达 —— 标脏 → 后台补拉,旧读数留在屏上;
 *  · 播放钟  —— `usePlaybackPosition`(在放时每 250ms 一拍),唱臂、进度条、歌词高亮吃同一个数;
 *  · 说话    —— 按钮那一行就地换成输入框,焦点由这一格的落点交给框;回车 / Esc / 取消回到按钮;
 *  · 抽屉    —— 开 / 关不动主界面;关掉焦点结构性地回到那颗钮;
 *  · 换宿主  —— 浮窗 / 舞台 / 全屏不重挂;唱头拖到一半换宿主,`PointerTrack` 作废这一下;
 *  · 卸载    —— 退订;抽屉与说话状态不落盘。
 *
 * ── ② UI 生命状态 ───────────────────────────────────────────────────────
 *  · 后端没配好 → 接入向导占唱片那一块(按钮那一行不画:这几步里它没有可说的);
 *    后端整个读不到 → 顶上一句 `music.backendNotReady`;
 *  · 错误(后端 / 按钮)→ 唱片上方一行原话,零 Toast;
 *  · 其余全部在唱片那一块里演(关着 / 没歌 / 挑歌 / 没歌词),高度不变。
 *
 * ── ③ UI 交互状态 ───────────────────────────────────────────────────────
 *  · 随库件;pending 逐格;Esc:有抽屉先关抽屉(它更深),其次退出说话;都没有就放行。
 */
export function MusicPanel({
  initialPlaylistOpen = false,
}: {
  /** 只给实验台用:一开就要量「抽屉开着」那一态。产品里不传。 */
  initialPlaylistOpen?: boolean
} = {}) {
  const t = useT()
  useMusicLive()
  const runtime = useQuery(musicRuntimeQuery)
  const now = useQuery(musicNowPlayingQuery)
  const brief = useQuery(musicBriefQuery)
  const programme = useQuery(musicProgrammeQuery)
  const playRef = useRef<HTMLButtonElement | null>(null)
  const talkRef = useRef<HTMLInputElement | null>(null)
  const playlistRef = useRef<HTMLButtonElement | null>(null)
  const petRef = useRef<PetStageHandle | null>(null)
  const panelRef = useRef<HTMLDivElement | null>(null)
  const position = usePlaybackPosition(now.data)
  const form = useMusicPanelForm(panelRef)
  const talk = useHostTalk()
  const [playlistOpen, setPlaylistOpen] = useState(initialPlaylistOpen)
  const [talking, setTalking] = useState(false)
  const [rowError, setRowError] = useState<string | undefined>(undefined)

  const state = runtime.data
  const wizard = useSetupWizardVisible(state?.setupStage)
  const unreachable = state === undefined && (runtime.error !== undefined || runtime.phase === 'ready')
  const title = now.data?.title
  const radioOn = brief.data?.active === true

  // 说话框开合:焦点由这一格的落点交过去(开 → 框,合 → 播放钮),排在提交之后。
  const firstTalk = useRef(true)
  useEffect(() => {
    if (firstTalk.current) {
      firstTalk.current = false
      return
    }
    activateScopeAfterCommit('music')
  }, [talking])

  const seek = useCallback((seconds: number) => void musicOps.seek.run({ position: seconds }), [])
  const playEntry = useCallback((encryptedId: string) => {
    void musicOps.programmeAction.run({ action: { kind: 'promote', encryptedId } }).then(() => {
      if (!musicOps.programmeAction.get().error) void musicOps.next.run({})
    })
  }, [])
  const onLiked = useCallback(() => petRef.current?.love(), [])
  const closePlaylist = useCallback(() => setPlaylistOpen(false), [])

  // 抽屉里「翻面以后」那条线画在第几首之后:这一面还能再排几首。
  const side = recordSideOf({
    nowTitle: title,
    nowDuration: now.data?.duration,
    recent: brief.data?.recent,
    entries: programme.data?.entries,
  })
  const sideRoom = side ? SIDE_CAP - side.current - 1 : undefined

  const notice = unreachable ? t('music.backendNotReady') : state?.lastError ? t('music.backendError', { message: state.lastError }) : (now.error ?? rowError)

  return (
    <FocusScope
      scope="music"
      rootRef={panelRef}
      restingTarget={() => (talking ? talkRef.current : playRef.current)}
      onEscape={() => {
        if (!talking) return false
        setTalking(false)
        return true
      }}
    >
      {({ scopeProps }) => (
        <div {...scopeProps} className={s.panel} data-testid="music-panel">
          <div className={s.scroller}>
            <div className={s.layout}>
              {notice && (
                <p className={s.notice} data-testid={unreachable ? 'music-not-ready' : 'music-backend-error'}>
                  {notice}
                </p>
              )}
              <section className={s.deck} data-testid="music-player">
                {wizard && state ? (
                  <SetupWizard state={state} />
                ) : (
                  <>
                    <RecordDeck
                      runtime={state}
                      brief={brief.data}
                      nowPlaying={now.data}
                      nowError={now.error}
                      programme={programme.data}
                      position={position}
                      wide={form.wide}
                      onSeek={seek}
                      onPlayEntry={playEntry}
                      petRef={petRef}
                      listening={radioOn && talk.typing}
                      awaitingHost={radioOn && talk.waiting}
                    />
                    <DeckRow
                      title={title}
                      playing={now.data?.playing ?? false}
                      position={position}
                      duration={now.data?.duration}
                      talk={talk}
                      talking={talking}
                      onTalking={setTalking}
                      playRef={playRef}
                      talkRef={talkRef}
                      playlistRef={playlistRef}
                      playlistOpen={playlistOpen}
                      onTogglePlaylist={() => setPlaylistOpen((open) => !open)}
                      onLiked={onLiked}
                      onError={setRowError}
                    />
                  </>
                )}
              </section>
            </div>
          </div>

          {!wizard && playlistOpen && (
            <PlaylistDrawer
              form={form.drawer}
              onClose={closePlaylist}
              nowPlaying={now.data}
              position={position}
              runtime={state}
              radioOn={radioOn}
              sideRoom={sideRoom}
            />
          )}
        </div>
      )}
    </FocusScope>
  )
}
