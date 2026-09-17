import { Search } from '../../components/icons'
import { ButtonBase } from '../../ui/ButtonBase'
import { useT } from '../../i18n'
import { useQuery } from '../../data/kernel'
import {
  browserSettingsQuery,
  setBrowserSearchEngineMutation,
} from '../../data/browser-settings-source'
import {
  BROWSER_SEARCH_ENGINES,
  DEFAULT_BROWSER_SEARCH_ENGINE_ID,
} from '../../browser/omnibox'
import s from './BrowserStartPage.module.css'

/**
 * **一格空标签页画什么**(B3-b)。
 *
 * ── 它是**壳自己的一块 DOM**,不是一张网页 ────────────────────────────────
 * 这是这一格最要紧的一句话。旧壳的起始页是一个 `about:blank` + 注入脚本;
 * 那条路上,「起始页」变成了一张我们自己写的、跑在陌生分区里的网页 —— 它能被
 * 页面脚本看见、要走 CSP、要走 UA、还得在八个分区里各存一份。这里反过来:
 * `row.url` 是空串的时候**整片原生视图根本不画**(叶那边不渲染 `NativeViewSlot`,
 * 于是 layout 收不到帧,视图保持 `setVisible(false)`),屏幕上这块是普通的 React。
 *
 * 顺带白拿一格:空标签页**不花一个渲染进程** —— 惰性视图那条路(`tab.ts` 文件头)
 * 正是等第一个 `visible` 帧才建 `WebContentsView`。
 *
 * ── 三张状态表 ────────────────────────────────────────────────────────────
 *
 * ① **生命周期**:挂载 = 这一格 tab 的 `url` 是空串;卸载 = 它去了一个地址
 *    (人回车、AI `navigate`、页面自己跳)。**没有换宿主那一格** —— 它跟着叶走,
 *    而叶换宿主时拼贴树的结构共享保证不重挂。零订阅、零计时器、零 DOM 监听。
 *
 * ② **UI 生命状态**
 *
 * | 态 | 判据 | 屏幕上 |
 * | --- | --- | --- |
 * | 正常 | 恒 | 一句「输入网址,或者搜点什么」+ 一排搜索引擎丸 |
 * | 设置还没问到 | `browserSettingsQuery` 首载未回 | 那排丸照画,选中的是**出厂那一格**。不画骨架:四枚丸的位置不会变,闪一下骨架比直接画更吵 |
 * | 最近关闭的几条 | —— | **不画**。派工单问的那一句「从 tabs.json 历史?」答案是:那份账本里**没有关闭历史**(`PersistedTabTable` 只有此刻开着的那几格,`close` 是把行删掉)。为它加一段历史要动落盘契约、要定保留期、要答「清不清得掉」——那是另一单。**没有就不画,不编三条假的** |
 * | 出错 | —— | 不存在:这一块不发请求(那排丸读的是设置那一条读数,它出错时叶檐那边已经说过一次了) |
 *
 * ③ **UI 交互状态**
 *
 * | 交互 | 结果 |
 * | --- | --- |
 * | 点一枚引擎丸 | 把它存成缺省搜索引擎(`settings.browser.searchEngine`)。**不跳转** —— 人点它是在挑「等下我搜的时候去哪儿」,不是「现在带我去谷歌首页」 |
 * | 已经选中的那一枚 | 照样可点(恒等),但 `aria-pressed` 说得出它是选中的 |
 * | 键盘 | 四枚丸各是一个 `<button>`,天生在 Tab 序里;焦点环走全局 `:focus-visible` |
 * | 写路 pending | 不禁、不转圈:这一下是**乐观**的(`setBrowserSearchEngineMutation` 当场把屏上那一格换过去),而它的全部可见结果就是哪一枚亮着 |
 *
 * ── 焦点落在地址栏,不落在这里 ────────────────────────────────────────────
 * 这块面**一个焦点都不抢**。空标签页的落点是地址栏,判据写在 `BrowserLeaf` 的
 * `restingTarget` 上(`row?.url ? 占位格 : 地址栏`)—— 一格空标签页人第一件想做的
 * 事就是打地址,全世界的浏览器都这样。
 *
 * ── `backdrop`:同一块 DOM 的第二种身份(2026-09-17)────────────────────────
 * 从起始页出发的第一次加载还没画出首帧的那一段(`browserBodyPhase` 的 `warming`),
 * 这块面**留在占位格底下当底**:原生视图首帧之前是透明的,底下的 DOM 会露出来,
 * 留着它就没有那段空底。它那时是**装饰**——不占地(绝对定位)、不接指针、不进
 * 无障碍树(`inert` + `aria-hidden`),所以那排引擎丸不会变成一组点不着又能 Tab
 * 到的假按钮。判词整段在 `start-backdrop.ts` 上。
 */
export function BrowserStartPage({ backdrop = false }: { backdrop?: boolean } = {}) {
  const t = useT()
  const settings = useQuery(browserSettingsQuery)
  /*
   * 设置还没问到就画出厂那一格 —— **不是猜**:那正是 `resolveBrowserSearchEngine`
   * 对认不出的 id 的回落,两处同一条判据、同一个缺省(`omnibox.ts` 是产地)。
   */
  const current = settings.data?.searchEngine ?? DEFAULT_BROWSER_SEARCH_ENGINE_ID

  return (
    <div
      className={s.start}
      data-testid="browser-start"
      data-backdrop={backdrop || undefined}
      inert={backdrop}
      aria-hidden={backdrop || undefined}
    >
      <Search className={s.glyph} strokeWidth={1.5} aria-hidden="true" />
      <p className={s.hint}>{t('browser.startHint')}</p>
      <div className={s.engines} role="group" aria-label={t('browser.startEngineSection')}>
        {BROWSER_SEARCH_ENGINES.map((engine) => (
          <ButtonBase
            key={engine.id}
            className={s.engine}
            data-on={engine.id === current || undefined}
            aria-pressed={engine.id === current}
            aria-label={t('browser.startEngine', { name: engine.name })}
            data-testid="browser-start-engine"
            data-engine-id={engine.id}
            onClick={() => void setBrowserSearchEngineMutation.run(engine.id)}
          >
            <span className={s.token} aria-hidden="true">{engine.token}</span>
            {engine.shortName}
          </ButtonBase>
        ))}
      </div>
    </div>
  )
}
