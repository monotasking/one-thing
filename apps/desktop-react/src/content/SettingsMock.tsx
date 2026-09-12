import type { ReactNode } from 'react'
import { useStageStore } from '../stage/store'
import { Segmented } from '../ui/Segmented'
import type { SegmentedOption } from '../ui/Segmented'
import { Switch } from '../ui/Switch'
import { useT } from '../i18n'
import type { Locale, MessageKey } from '../i18n'
import type {
  DockAlign,
  DockDisplay,
  DockEdge,
  DockMagnifyLevel,
  DockSize,
  ResolvedOpen,
} from '../stage/types'
import {
  SESSION_OPEN_MODE_LABELS,
  SESSION_OPEN_MODES,
  useSessionOpenMode,
} from '../data/session-open-mode'
import type { SessionOpenMode } from '../data/session-open-mode'
import { useReadingStore, effectiveMotionTier } from '../reading/store'
import { useSystemReducedMotion } from '../reading/useSystemReducedMotion'
import type { MotionTier, ReadingColumn, ReadingDensity, ReadingFontSize } from '../reading/types'
import { FocusScope } from '../focus/FocusScope'
import { KeymapSettings } from './KeymapSettings'
import { BrowserSettings } from './settings/BrowserSettings'
import { PermissionGrants } from './settings/PermissionGrants'
import s from './mocks.module.css'

/**
 * 选项表只存 key,渲染时才翻译 —— 表是常量,文案是当下的语言,两件事分开。
 * 唯一一个真接 store 的 mock:切换它,Dock 的形状 / 打开方式 / 界面语言当场生效。
 *
 * ── 版式:按**领域**分区(08-29 拍板)────────────────────────────────────────
 * 通用 / Dock / 打开方式 / 快捷键。一个控件属于哪个区,判据是「用户想改的是哪件事」,
 * 不是「它接的是哪个 store 字段」。所以 Dock 的显示方式 / 边 / 沿边位置 / 大小归一区,
 * 而「点图标落到哪」是另一件事,单独一区。
 * 分区不分页:左侧竖向锚点导航等设置真长到那个量级再说。
 * 这一页里**不许有游离在分区外的控件** —— 加一个控件就得先回答它属于哪个领域。
 * ──────────────────────────────────────────────────────────────────────────
 */
const DOCK_OPTIONS: Array<{ value: DockDisplay; labelKey: MessageKey }> = [
  { value: 'always', labelKey: 'settings.dockAlways' },
  { value: 'autohide', labelKey: 'settings.dockAutohide' },
]

const EDGE_OPTIONS: Array<{ value: DockEdge; labelKey: MessageKey }> = [
  { value: 'bottom', labelKey: 'dock.edgeBottom' },
  { value: 'top', labelKey: 'dock.edgeTop' },
  { value: 'left', labelKey: 'dock.edgeLeft' },
  { value: 'right', labelKey: 'dock.edgeRight' },
]

const ALIGN_OPTIONS: Array<{ value: DockAlign; labelKey: MessageKey }> = [
  { value: 'start', labelKey: 'dock.alignStart' },
  { value: 'center', labelKey: 'dock.alignCenter' },
  { value: 'end', labelKey: 'dock.alignEnd' },
]

const SIZE_OPTIONS: Array<{ value: DockSize; labelKey: MessageKey }> = [
  { value: 'sm', labelKey: 'dock.sizeSm' },
  { value: 'md', labelKey: 'dock.sizeMd' },
  { value: 'lg', labelKey: 'dock.sizeLg' },
]

/*
 * 放大幅度三档(09-02 追补)。macOS 那里是一根连续滑杆,这里按「设置极简」收敛成
 * 三格 —— 三个真实的数住在 tokens.css 的 --dock-lens-max-*,这张表只认档名。
 */
const MAGNIFY_OPTIONS: Array<{ value: DockMagnifyLevel; labelKey: MessageKey }> = [
  { value: 'sm', labelKey: 'dock.magnifySm' },
  { value: 'md', labelKey: 'dock.magnifyMd' },
  { value: 'lg', labelKey: 'dock.magnifyLg' },
]

// 舞台不在此列(08-30 拍板:点开统一浮窗,舞台只是浮窗的放大目标 —— 见 stage/types.ts)。
const OPEN_OPTIONS: Array<{ value: ResolvedOpen; labelKey: MessageKey }> = [
  { value: 'float', labelKey: 'dock.openFloat' },
  { value: 'pinned', labelKey: 'dock.openPinned' },
]

/*
 * 「点会话列表一行是什么意思」三档(C2)。
 *
 * **表在 `data/session-open-mode.ts`,这里只取次序与文案键** —— 与上面那几张
 * 就地写死的表不同,这一张有第二个消费方(标签的右键菜单),而「三档是哪三档、
 * 按什么次序排」只该有一个产地(判例:`FILE_OPEN_MODES` 与 `FileActionsMenu`)。
 */
const SESSION_OPEN_OPTIONS: Array<{ value: SessionOpenMode; labelKey: MessageKey }>
  = SESSION_OPEN_MODES.map((value) => ({ value, labelKey: SESSION_OPEN_MODE_LABELS[value] }))

/* ── 外观·阅读的四根轴 ────────────────────────────────────────────────────
 * 档值即写进 DOM 的属性值(src/reading/types.ts 是那张表的另一半),这里只配文案。
 * 四枚分段器都是**即点即生效**:没有「保存」按钮,因为没有一次改动是需要确认的
 * —— 改错了再点回来就是,而版式的对错只有看着才知道。
 * ────────────────────────────────────────────────────────────────────────── */
const READING_FS_OPTIONS: Array<{ value: ReadingFontSize; labelKey: MessageKey }> = [
  { value: '13', labelKey: 'settings.readingFsSm' },
  { value: '14', labelKey: 'settings.readingFsMd' },
  { value: '15', labelKey: 'settings.readingFsLg' },
  { value: '16', labelKey: 'settings.readingFsXl' },
]

const READING_DENSITY_OPTIONS: Array<{ value: ReadingDensity; labelKey: MessageKey }> = [
  { value: 'compact', labelKey: 'settings.readingDensityCompact' },
  { value: 'comfortable', labelKey: 'settings.readingDensityComfortable' },
  { value: 'relaxed', labelKey: 'settings.readingDensityRelaxed' },
]

const READING_COL_OPTIONS: Array<{ value: ReadingColumn; labelKey: MessageKey }> = [
  { value: 'standard', labelKey: 'settings.readingColStandard' },
  { value: 'wide', labelKey: 'settings.readingColWide' },
  { value: 'full', labelKey: 'settings.readingColFull' },
]

const MOTION_OPTIONS: Array<{ value: MotionTier; labelKey: MessageKey }> = [
  { value: 'standard', labelKey: 'settings.motionStandard' },
  { value: 'calm', labelKey: 'settings.motionCalm' },
  { value: 'none', labelKey: 'settings.motionNone' },
]

const LOCALE_OPTIONS: Array<{ value: Locale; labelKey: MessageKey }> = [
  { value: 'system', labelKey: 'settings.localeSystem' },
  { value: 'zh', labelKey: 'settings.localeZh' },
  { value: 'en', labelKey: 'settings.localeEn' },
]

/**
 * 一个领域一节:小节标题 + 若干行。标题走 <h3> 是为了让辅助技术读得出层级,
 * 视觉上它只是一行 11px 的小字 —— 层级由标签给,分量由 CSS 给,两件事不混。
 */
function Section({ titleKey, children }: { titleKey: MessageKey; children: ReactNode }) {
  const t = useT()
  return (
    <section className={s.section}>
      <h3 className={s.sectionTitle}>{t(titleKey)}</h3>
      {children}
    </section>
  )
}

export function SettingsMock() {
  const t = useT()
  const dockDisplay = useStageStore((st) => st.dockDisplay)
  const setDockDisplay = useStageStore((st) => st.setDockDisplay)
  const dockEdge = useStageStore((st) => st.dockEdge)
  const setDockEdge = useStageStore((st) => st.setDockEdge)
  const dockAlign = useStageStore((st) => st.dockAlign)
  const setDockAlign = useStageStore((st) => st.setDockAlign)
  const dockSize = useStageStore((st) => st.dockSize)
  const setDockSize = useStageStore((st) => st.setDockSize)
  const dockMagnify = useStageStore((st) => st.dockMagnify)
  const setDockMagnify = useStageStore((st) => st.setDockMagnify)
  const dockMagnifyLevel = useStageStore((st) => st.dockMagnifyLevel)
  const setDockMagnifyLevel = useStageStore((st) => st.setDockMagnifyLevel)
  const dockRunningDot = useStageStore((st) => st.dockRunningDot)
  const setDockRunningDot = useStageStore((st) => st.setDockRunningDot)
  const defaultOpen = useStageStore((st) => st.defaultOpen)
  const setDefaultOpen = useStageStore((st) => st.setDefaultOpen)
  const locale = useStageStore((st) => st.locale)
  const setLocale = useStageStore((st) => st.setLocale)
  const sessionOpenMode = useSessionOpenMode((st) => st.mode)
  const setSessionOpenMode = useSessionOpenMode((st) => st.setMode)

  const readingFs = useReadingStore((st) => st.fontSize)
  const setReadingFs = useReadingStore((st) => st.setFontSize)
  const readingDensity = useReadingStore((st) => st.density)
  const setReadingDensity = useReadingStore((st) => st.setDensity)
  const readingCol = useReadingStore((st) => st.column)
  const setReadingCol = useReadingStore((st) => st.setColumn)
  const setMotion = useReadingStore((st) => st.setMotion)
  // 动效那一枚高亮的是**生效档**,不是存着的那个:系统开着「减弱动态效果」而用户
  // 还没表过态时,面上就该显示「无」—— 显示「标准」而屏幕上不动是在骗人。
  const systemReduced = useSystemReducedMotion()
  const motion = useReadingStore((st) => effectiveMotionTier(st, systemReduced))

  const opts = <T extends string>(
    table: Array<{ value: T; labelKey: MessageKey }>,
  ): Array<SegmentedOption<T>> => table.map((o) => ({ value: o.value, label: t(o.labelKey) }))

  /*
   * ── 设置面是响应链上的一格 `region`(09-03 R2)────────────────────────────
   * 与消息流同一条:它没有局部键、不认 Esc,接树买到的是「焦点此刻在哪块面」
   * 有一个说得出名字的答案 —— 尤其它里面装着**录制态那个独占口**
   * (`KeymapSettings`:录键时要吃所有键),而独占与作用域是两回事:
   * 独占口向注册表申请,作用域回答「这块面是不是当前」。两者都在树上,
   * 于是「录制的时候 ⌘P 不会真的把检索面弹出来」不再取决于谁的监听先挂。
   */
  return (
    <FocusScope scope="settings">
      {({ scopeProps }) => (
        <div {...scopeProps} className={s.demo}>
          <div className={s.form}>
            <Section titleKey="settings.sectionGeneral">
              <div className={s.settingRow}>
                <div className={s.settingRowLabel}>{t('settings.language')}</div>
                <Segmented
                  options={opts(LOCALE_OPTIONS)}
                  value={locale}
                  onChange={setLocale}
                  label={t('settings.language')}
                />
              </div>

              <div className={s.settingRow}>
                <div className={s.settingRowLabel}>{t('settings.workdir')}</div>
                <div className={s.stub} />
              </div>
            </Section>

            {/*
              外观·阅读 —— 四根**正交**的轴,读者自己调读物长什么样。
              分区判据照旧是「用户想改的是哪件事」:这四件都是「这段字读起来怎么样」,
              所以它们归一区;它们**只管聊天正文列**,不动外壳与面板(那是「界面」不是
              「读物」,判据写在 styles/tokens.css 的阅读轴一节)。
            */}
            <Section titleKey="settings.sectionReading">
              <div className={s.settingRow}>
                <div className={s.settingRowLabel}>{t('settings.readingFs')}</div>
                <Segmented
                  options={opts(READING_FS_OPTIONS)}
                  value={readingFs}
                  onChange={setReadingFs}
                  label={t('settings.readingFs')}
                />
              </div>

              <div className={s.settingRow}>
                <div>
                  <div className={s.settingRowLabel}>{t('settings.readingDensity')}</div>
                  <div className={s.settingRowHint}>{t('settings.readingDensityHint')}</div>
                </div>
                <Segmented
                  options={opts(READING_DENSITY_OPTIONS)}
                  value={readingDensity}
                  onChange={setReadingDensity}
                  label={t('settings.readingDensity')}
                />
              </div>

              <div className={s.settingRow}>
                <div className={s.settingRowLabel}>{t('settings.readingCol')}</div>
                <Segmented
                  options={opts(READING_COL_OPTIONS)}
                  value={readingCol}
                  onChange={setReadingCol}
                  label={t('settings.readingCol')}
                />
              </div>

              <div className={s.settingRow}>
                <div>
                  <div className={s.settingRowLabel}>{t('settings.motion')}</div>
                  <div className={s.settingRowHint}>{t('settings.motionHint')}</div>
                </div>
                <Segmented
                  options={opts(MOTION_OPTIONS)}
                  value={motion}
                  onChange={setMotion}
                  label={t('settings.motion')}
                />
              </div>
            </Section>

            <Section titleKey="settings.sectionDock">
              <div className={s.settingRow}>
                <div>
                  <div className={s.settingRowLabel}>{t('settings.dockDisplay')}</div>
                  <div className={s.settingRowHint}>{t('settings.dockDisplayHint')}</div>
                </div>
                <Segmented
                  options={opts(DOCK_OPTIONS)}
                  value={dockDisplay}
                  onChange={setDockDisplay}
                  label={t('settings.dockDisplay')}
                />
              </div>

              <div className={s.settingRow}>
                <div className={s.settingRowLabel}>{t('dock.edge')}</div>
                <Segmented
                  options={opts(EDGE_OPTIONS)}
                  value={dockEdge}
                  onChange={setDockEdge}
                  label={t('dock.edge')}
                />
              </div>

              <div className={s.settingRow}>
                <div className={s.settingRowLabel}>{t('dock.align')}</div>
                <Segmented
                  options={opts(ALIGN_OPTIONS)}
                  value={dockAlign}
                  onChange={setDockAlign}
                  label={t('dock.align')}
                />
              </div>

              <div className={s.settingRow}>
                <div className={s.settingRowLabel}>{t('dock.size')}</div>
                <Segmented
                  options={opts(SIZE_OPTIONS)}
                  value={dockSize}
                  onChange={setDockSize}
                  label={t('dock.size')}
                />
              </div>

              {/*
                磁性放大那两行(09-02 追补,对齐 macOS 「Dock 与菜单栏」里那枚放大开关 +
                那根幅度滑杆)。**开关与幅度是两件事**:关掉是「这条链不跑」,幅度只是
                条上一个 CSS 变量。所以幅度那一行在关掉时**禁掉而不是藏掉** —— 藏掉会让
                人以为这个选项没了,禁掉才说得清「它还在,只是现在管不着」。
              */}
              <div className={s.settingRow}>
                <div>
                  <div className={s.settingRowLabel}>{t('dock.magnify')}</div>
                  <div className={s.settingRowHint}>{t('dock.magnifyHint')}</div>
                </div>
                <Switch checked={dockMagnify} onChange={setDockMagnify} label={t('dock.magnify')} />
              </div>

              <div className={s.settingRow}>
                <div className={s.settingRowLabel}>{t('dock.magnifyLevel')}</div>
                <Segmented
                  options={opts(MAGNIFY_OPTIONS)}
                  value={dockMagnifyLevel}
                  onChange={setDockMagnifyLevel}
                  label={t('dock.magnifyLevel')}
                  disabled={!dockMagnify}
                />
              </div>

              <div className={s.settingRow}>
                <div>
                  <div className={s.settingRowLabel}>{t('dock.runningDot')}</div>
                  <div className={s.settingRowHint}>{t('dock.runningDotHint')}</div>
                </div>
                <Switch
                  checked={dockRunningDot}
                  onChange={setDockRunningDot}
                  label={t('dock.runningDot')}
                />
              </div>
            </Section>

            <Section titleKey="dock.openWith">
              <div className={s.settingRow}>
                <div>
                  <div className={s.settingRowLabel}>{t('settings.defaultOpen')}</div>
                  <div className={s.settingRowHint}>{t('settings.defaultOpenHint')}</div>
                </div>
                <Segmented
                  options={opts(OPEN_OPTIONS)}
                  value={defaultOpen}
                  onChange={setDefaultOpen}
                  label={t('settings.defaultOpen')}
                />
              </div>
              <div className={s.settingRowNote}>{t('settings.defaultOpenNote')}</div>

              {/*
                「点会话列表一行」那三档(C2,设计 §4.2)。
                **它归「打开方式」这一区**:这一页的分区判据是「用户想改的是哪件事」
                (文件头那一段),而这一件想改的正是**打开方式** —— 只不过宾语从
                「Dock 上那块瓦」换成了「会话列表里那一行」。为它单开一区会让这一页
                多一个只有一行的领域,而那一行说的还是同一件事。
                与标签右键菜单里那一节读写**同一格 store**,不是两份状态。
              */}
              <div className={s.settingRow}>
                <div>
                  <div className={s.settingRowLabel}>{t('sessions.openMode')}</div>
                  <div className={s.settingRowHint}>{t('sessions.openModeHint')}</div>
                </div>
                <Segmented
                  options={opts(SESSION_OPEN_OPTIONS)}
                  value={sessionOpenMode}
                  onChange={setSessionOpenMode}
                  label={t('sessions.openMode')}
                />
              </div>
            </Section>

            {/*
              「已授权」自成一区(应用级许可 · 壳半边,2026-09-10)。这一页的分区
              判据是「用户想改的是哪件事」—— 这一件是「这台机器替我记住了什么、
              我要把哪一条收回来」,与语言 / Dock / 打开方式 / 快捷键都不是同一件。
              排在快捷键之前:它与「打开方式」一样是关于**这台机器怎么替我做事**
              的决定,而快捷键是最后那一节键位表。
            */}
            {/*
              「内置浏览器」自成一区(B2′,2026-09-12)。分区判据照旧是「用户想改
              的是哪件事」—— 这一件是「要不要把内置浏览器交给 AI 与外部工具驱动」,
              与打开方式 / 已授权都不是同一件。排在「已授权」之前:那一节说的是
              「收回已经给出去的」,这一节说的是「要不要给出去」,顺着读。
            */}
            <Section titleKey="settings.sectionBrowser">
              <BrowserSettings />
            </Section>

            <Section titleKey="settings.sectionPermissions">
              <PermissionGrants />
            </Section>

            <Section titleKey="settings.sectionKeymap">
              <KeymapSettings />
            </Section>
          </div>
        </div>
      )}
    </FocusScope>
  )
}
