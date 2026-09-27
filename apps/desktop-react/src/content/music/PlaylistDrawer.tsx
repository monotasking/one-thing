import { useT } from '../../i18n'
import type { MusicNowPlayingView } from '../../data/music-source'
import { musicOps } from '../../data/music-source'
import { AsyncButton } from '../../ui/AsyncButton'
import { Drawer } from '../../ui/Drawer'
import { ProgrammeSheet } from './ProgrammeSheet'

/**
 * **播放列表抽屉**(音乐面 v7,正本 `docs/music-panel-2026-09.md` §1)。
 *
 * 用户原话:「你这个歌词我以为是歌曲列表呢。谁家歌曲列表直接往下铺一排啊。」——
 * 所以任何宽度下节目单都**不铺在页面上**,它住在歌条上那颗钮后面。
 *
 * ── 两档,差别只有「从哪儿来」────────────────────────────────────────────
 * ≥ 560 从右边滑出(宽 `--drawer-w`、通高),< 560 从底下升起(高
 * `--drawer-h`)。骨架(遮罩 / 两档形 / Esc / ✕ / 焦点归还)住 `ui/Drawer`(主持人抽屉 H0 抬上去的,
 * 像素一格没改)。哪一档由**面板自己的宽**说(`panel-width.ts`),这件只读那格
 * `form`;里面装的东西两档逐字相同 —— 就是今天的 `ProgrammeSheet`(拖拽换序还没有,
 * 上移 / 下移与其余动作在右键菜单里,一个字没改)。
 *
 * ── 三条出口,一条归还 ──────────────────────────────────────────────────
 * 点遮罩、按 Esc、按 ✕ 都关。焦点的归还是**结构性**的(响应链 §3.5 规则 5):
 * 这一格 `float` 作用域一卸载,路径缩回它的父,焦点回到父上次所在的元素 ——
 * 也就是开它的那颗「播放列表」钮。这里因此没有一句 `focus()`,也没有一句
 * 「借了要还」的簿记。Esc 由这一层认领(`onEscape` 答 true):它比音乐面那一格深,
 * 所以「有抽屉先关抽屉」是**树的深度**保证的,不是谁先注册。
 *
 * ── 三张状态表 ──────────────────────────────────────────────────────────
 * ① 生命周期:挂载即 `activateOnMount`,焦点落到抽屉里第一个可聚焦元素(✕);
 *    换歌不关、电台关台不关(里面换成空态);卸载不落盘 —— 下次开面板从唱机开始。
 * ② UI 生命状态:身子就是 `ProgrammeSheet` 自己的四态(首载不画 / 空一句 /
 *    超量封顶 + 读数 / 出错就地一行),这件不重画一份。
 * ③ UI 交互状态:遮罩 hover 无态(它不是控件);✕ 随 `ui/IconButton`;
 *    抽屉内滚动由身子那一层管。
 */
export function PlaylistDrawer({
  form,
  onClose,
  nowPlaying,
  position,
  radioOn = false,
  sideRoom,
}: {
  form: 'side' | 'sheet'
  onClose: () => void
  /*
   * 「正在播放」那一段要的两格(正本 §8.1)。**父级递进来**而不是这里再订一次:
   * `usePlaybackPosition` 起的是一只 250ms 的钟,同一份真相订两遍就是两只钟,
   * 迟早在某一帧不一致(同一份真相只订一遍)。
   */
  nowPlaying?: MusicNowPlayingView
  position?: number
  /** 电台开着 → 檐上一颗「关台」(v8:关台从电台条挪到这里,与样例同位)。 */
  radioOn?: boolean
  /** 这一面还能再排几首(`ProgrammeSheet` 在那之后画「翻面以后」)。 */
  sideRoom?: number
}) {
  const t = useT()

  return (
    <Drawer
      form={form}
      title={t('music.playlist')}
      onClose={onClose}
      testId="music-playlist"
      tools={
        radioOn && (
          <AsyncButton action={musicOps.radioStop} pendingLabel={t('common.working')} data-testid="music-radio-close" onClick={() => void musicOps.radioStop.run({})}>
            {t('music.deckClose')}
          </AsyncButton>
        )
      }
    >
      <ProgrammeSheet nowPlaying={nowPlaying} position={position} sideRoom={sideRoom} />
    </Drawer>
  )
}
