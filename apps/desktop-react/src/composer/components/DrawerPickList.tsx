import { Fragment } from 'react'
import type { MouseEvent } from 'react'
import { ButtonBase } from '../../ui/ButtonBase'
import { useT } from '../../i18n'
import type { MessageKey } from '../../i18n'
import type { CommandEntry } from '../../data/commands-source'
import type { FileMentionsStatus } from '../../data/file-mentions-source'
import type { CommandGroup, CommandGroupId } from '../transitions'
import s from './Composer.module.css'

/**
 * @ 文件与 / 命令共用同一种行 —— 它们是同一件事的两种内容,不是两个控件。
 * 行上用 mousedown + preventDefault 而不是 click:点下去的那一瞬间输入框会失焦,
 * 而插入 chip 要靠那个还没散的光标(demo 同一判例)。
 *
 * ── 列表封顶之后多出来的一件事:把选中项滚进视野 ──────────────────────────
 * 限高(`.pickScroll`,token `--composer-drawer-max`)之前,「选中的那条在不在
 * 屏幕上」不是个问题 —— 抽屉有多长就长多长。限高之后,↑↓ 走到第 12 条时它就在
 * 视野外面了:键盘还在动,屏幕上却什么都没变,那是**比不限高更糟**的手感。
 *
 * 所以限高与滚入视野是**同一件事的两半**,不许只做前一半。滚这件事已经收进
 * `ui/a11y/list-selection` 的 `rowRef`(`block:'nearest'`,理由同上:已经在
 * 视野里的一动不动)。焦点仍然留在输入框里(行是 mousedown 拾取的,从不落焦),
 * 所以滚的是**元素**,不是焦点 —— roving 那一套没有被碰。
 *
 * ── 09-01 修:mouseenter 不再写选中位 ────────────────────────────────────
 * 从前每一行挂着 `onMouseEnter={() => onHover(i)}`,把键盘位直接交给鼠标。
 * 两个后果:①鼠标停在列表上时按 ↑↓,↵ 落在鼠标那一行而不是键盘那一行;
 * ②上面那段滚入视野把列表滚一段,**鼠标一动没动**却换了脚下的行,浏览器
 * 补一发 mouseenter,键盘位当场被拽走(二次污染)。
 * 现在 hover 纯由 CSS 的 `.pickRow:hover` / `.pickSel:hover` 画,一个 JS
 * 状态都不占;改选中位的只剩键盘与**点击**。法条见 CLAUDE.md 禁令区。
 *
 * ══ 09-12 三修 ════════════════════════════════════════════════════════════
 *
 * **① `@` 候选的四态**(用户报障「command / file 出现的动画很突兀」的病根之一)。
 * 从前这一列只按**长度**判:长度 0 就写「无匹配」。而刚敲下 `@` 的那一瞬候选
 * 恰好是 0(去抖 120ms + 一次往返都还没走完),于是屏幕上先说一句
 * 「无匹配」,再整列换成真候选 —— 突兀的不是曲线,是**先说了一句不成立的话
 * 再改口**。今天判据是 `fileStatus`,四态各有各的画法:
 *
 *   | 候选 | status        | 画什么                                   |
 *   | 有   | ready         | 候选行                                   |
 *   | 有   | loading       | 候选行(**旧的留屏**,不闪、不清)         |
 *   | 有   | error         | 候选行 + 一行弱色错误文字(不换底)       |
 *   | 无   | idle/loading  | 一行「正在找…」(**纯文字**:Spinner 只许 |
 *   |      |               | 在按钮内 / 状态栏,禁令区)               |
 *   | 无   | error         | 一行弱色错误文字                          |
 *   | 无   | ready         | 「无匹配」—— 只有这一格才说这句话         |
 *
 * 命令那一半没有取数态:内置是编译期常量,插件 / 技能拉不到就是那一组不出现
 * (静默降级,判词在各自的 source 文件头)。
 *
 * **② 命令行画 usage**(用户报障「命令无提示」)。一行三格:名 · 说明 · 用法。
 * 用法是**语法**(`/cd <path>`),等宽弱色;窄档(`@container composerDrawer
 * (max-width: 448px)`)收掉它 —— 为什么收的是用法不是说明,判词在那条 CSS 上。
 *
 * **③ 分组**(命令 / 技能 / 插件)。切组在 `transitions.groupCommands`,
 * 这里只画 —— **空组不会到这儿**(它自己滤掉了),所以这个文件一句「这组空不空」
 * 都没有。**分组只许一次**(禁令区):三个组头在一列里各出现恰好一次,靠的是
 * 那只函数做的是稳定分区而不是相邻切段。
 *
 * 键盘走位仍旧是**一条扁平序**:`index` 与 `onPick(i)` 的下标按各组 `items`
 * 顺次相连算 —— 下面那个 `offset` 就是它。分组一个字都没改选择模型。
 *
 * ══ 09-12 第二批:高度这件事整个不归这里了 ════════════════════════════════
 * 同日早些时候这块滚动区自己走一次高度 FLIP(`ui/flip-height`),让「一行
 * 『正在找…』→ 整列」那一下有得看。用户当天报回来的正是它:
 * 「它太慢了,我能看到它先很短、再慢慢长出来;能不能直接看到一个固定长度、
 * 固定宽度的最终结果」。
 *
 * 所以 FLIP **删了**(原语留着,工具卡还在用)。抽屉改成**固定高的框**
 * (`.drawerFixed`,推导在 `--composer-drawer-h` 上),这一列在框里铺满自己滚 ——
 * 四态之间换的只是框里第一行写什么,**一个像素的几何都不动**。
 * 于是这个文件里再没有任何一处量高、记高、改高:要「一出来就是最终大小」,
 * 最可靠的写法是让它压根没有第二个尺寸。
 * ──────────────────────────────────────────────────────────────────────
 */
interface Props {
  kind: 'files' | 'commands'
  files: string[]
  /** `@` 候选此刻处在哪一态(四态表见文件头)。 */
  fileStatus: FileMentionsStatus
  /** 已切好组的命令(空组不在里面)。扁平序 = 各组 `items` 顺次相连。 */
  commandGroups: CommandGroup<CommandEntry>[]
  index: number
  /** 下标 → 行 ref。由 `useListSelection` 交下来,滚入视野靠它认行。 */
  rowRef: (i: number) => (el: HTMLElement | null) => void
  onPick: (i: number) => void
}

/** 三个组头各念什么。加一组 = 这张表加一行(与 `CommandGroupId` 同源)。 */
const GROUP_HEAD_KEY: Record<CommandGroupId, MessageKey> = {
  command: 'composer.headCommands',
  skill: 'composer.headSkills',
  plugin: 'composer.headPlugins',
}

export function DrawerPickList({
  kind,
  files,
  fileStatus,
  commandGroups,
  index,
  rowRef,
  onPick,
}: Props) {
  const t = useT()
  const hold = (i: number) => (e: MouseEvent) => {
    e.preventDefault()
    onPick(i)
  }

  const rows = kind === 'files' ? files.length : commandGroups.reduce((n, g) => n + g.items.length, 0)

  /** 候选一条没有时,那一行该说什么(四态表的下半截;null = 什么都不说)。 */
  const emptyNote: MessageKey | null =
    kind === 'commands'
      ? rows === 0
        ? 'composer.noMatch'
        : null
      : files.length > 0
        ? null
        : fileStatus === 'ready'
          ? 'composer.noMatch'
          : fileStatus === 'error'
            ? 'composer.searchFailed'
            : 'composer.searching'

  let offset = -1

  return (
    <div className={s.pickScroll}>
      {kind === 'files' && <div className={s.pickHead}>{t('composer.headFiles')}</div>}

      {emptyNote && <div className={s.pickEmpty}>{t(emptyNote)}</div>}

      {kind === 'files'
        ? files.map((f, i) => (
            <ButtonBase
              key={f}
              ref={rowRef(i)}
              className={i === index ? `${s.pickRow} ${s.pickSel}` : s.pickRow}
              onMouseDown={hold(i)}
            >
              <span className={s.pickMono}>{f}</span>
              <span className={s.pickHint}>{i === index ? t('composer.hintFile') : ''}</span>
            </ButtonBase>
          ))
        : commandGroups.map((group) => (
            <Fragment key={group.id}>
              <div className={s.pickHead}>{t(GROUP_HEAD_KEY[group.id])}</div>
              {group.items.map((c) => {
                // 扁平序的下标:一条列表不许有两种序,所以这里只是接着数,不重算。
                offset += 1
                const i = offset
                return (
                  <ButtonBase
                    key={c.name}
                    ref={rowRef(i)}
                    className={i === index ? `${s.pickRow} ${s.pickSel}` : s.pickRow}
                    onMouseDown={hold(i)}
                  >
                    <span className={`${s.pickMono} ${s.pickName}`}>{c.name}</span>
                    <span className={s.pickDesc}>{c.desc}</span>
                    {/* 用法与命令名一样时不画 —— `/compact` 的 usage 就是它自己,
                      * 把同一个词在一行里写两遍是噪声,不是提示。 */}
                    {c.usage && c.usage !== c.name && (
                      <span className={s.pickUsage}>{c.usage}</span>
                    )}
                    <span className={s.pickHint}>
                      {i === index ? t('composer.hintCommand') : ''}
                    </span>
                  </ButtonBase>
                )
              })}
            </Fragment>
          ))}

      {/* 候选还在屏上但这一发失败了:错误与它**并陈**,不抹掉旧答案(律②)。 */}
      {kind === 'files' && files.length > 0 && fileStatus === 'error' && (
        <div className={s.pickEmpty}>{t('composer.searchFailed')}</div>
      )}
    </div>
  )
}
