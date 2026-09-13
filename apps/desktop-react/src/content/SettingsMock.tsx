import { FocusScope } from '../focus/FocusScope'
import { ButtonBase } from '../ui/ButtonBase'
import { SETTINGS_PAGES, settingsPageOf } from './settings/pages'
import { useSettingsNav } from './settings/store'
import { useT } from '../i18n'
import s from './settings/Settings.module.css'

/**
 * 设置页的**外壳**:左边一条导航,右边当前那一页。
 *
 * ── 版式:从「分区不分页」改成「左导航 + 右页」(2026-09-13 用户拍)──────────
 * 这只文件从前写着「分区不分页:左侧竖向锚点导航等设置真长到那个量级再说」。
 * 那个量级到了 —— 用户当天原话「把模型设置移到设置中去;另外设置增加 theme
 * 选择」,而模型服务是一块**要吃满高度的两栏面**,塞进单列滚动表单只能得到嵌套
 * 滚动。判词整段与页的次序在 `settings/pages.tsx` 的文件头。
 *
 * ── 这只文件里**没有一个页名** ────────────────────────────────────────────
 * 「加功能不许改骨架」的字面落地:导航与内容读**同一张表**,加一页 =
 * `SETTINGS_PAGES` 上加一行,这只文件一个字不动。
 *
 * ── 导航为什么是 `<nav>` + `aria-current`,不是 `role="tablist"` ────────────
 * tab 模式在 WAI-ARIA APG 里带着一整套方向键契约(← → 换 tab、Home/End、
 * 焦点跟着选中走),而这是一条**侧栏导航**:Tab 逐项走、↵ 进那一页,与文件树 /
 * 会话列表同族。声明成 tablist 却不实现方向键,是给辅助技术一份做不到的承诺。
 *
 * ── 只渲染当前页 ──────────────────────────────────────────────────────────
 * 切页即卸载上一页。这一条对这几页都安全:它们的取数都住在 `data/` 的 query 里
 * (query 的寿命不是组件的),`ProviderSettingsPanel` 自己那几发 `ensure()` 也是
 * 幂等的。留着不卸载换来的只有「八页同时订着推送」。
 *
 * ── 名字为什么还叫 `SettingsMock` ─────────────────────────────────────────
 * 它早就不是 mock 了(里面每一格都写真设置),但这个导出名被内容表、单测与
 * `components/__tests__/shelf-rail.test.tsx` 引着 —— 改名是另一批的事,不该混在
 * 版式改动里。
 */
export function SettingsMock() {
  const t = useT()
  const page = useSettingsNav((st) => st.page)
  const setPage = useSettingsNav((st) => st.setPage)
  const spec = settingsPageOf(page)

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
        <div {...scopeProps} className={s.settings} data-testid="settings-panel">
          <nav className={s.nav} aria-label={t('item.settings')}>
            {SETTINGS_PAGES.map((one) => (
              <ButtonBase
                key={one.id}
                className={[s.navItem, one.id === spec.id ? s.navItemOn : ''].filter(Boolean).join(' ')}
                aria-current={one.id === spec.id ? 'page' : undefined}
                data-testid={`settings-nav-${one.id}`}
                onClick={() => setPage(one.id)}
              >
                {t(one.titleKey)}
              </ButtonBase>
            ))}
          </nav>
          <div
            className={s.page}
            data-layout={spec.layout}
            data-testid={`settings-page-${spec.id}`}
          >
            {/*
              **页标题:只念不看**(全局 `.visually-hidden`,与外壳那句 `a11y.appTitle`
              同一手)。它治的是一条真违例 —— `gate:a11y` 逐页扫的时候报
              `heading-order`:外壳的 `<h1>` 之下直接就是节标那一排 `<h3>`,中间缺了
              一级,读屏软件的「按标题跳」于是跳不出「我此刻在设置的哪一页」。
              视觉上不画,是因为**屏幕上已经有这句话**:左边那一行导航正亮着
              `aria-current="page"`。补一个可见的大标题只会把同一句话说两遍,
              而两种 `layout` 里那块地的归属也不一样(`fill` 那一页整块吃满)。
            */}
            <h2 className="visually-hidden">{t(spec.titleKey)}</h2>
            {spec.layout === 'form' ? <div className={s.form}>{spec.render()}</div> : spec.render()}
          </div>
        </div>
      )}
    </FocusScope>
  )
}
