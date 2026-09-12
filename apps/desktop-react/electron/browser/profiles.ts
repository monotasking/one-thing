/**
 * **身份(profile)名册在主进程这一侧的落地**(B3-b)。
 *
 * 一格身份 = 一个持久分区 `persist:browser-<id>` = 一套独立的 cookie /
 * localStorage / 登录态。名册本身是**设置**(`settings.browser.profiles`,
 * 契约在 `@shared/ipc/settings`)—— 建一个、改个名、删一个,全是往那份设置里
 * 写一行,与改主题、改语言没有任何区别。
 *
 * ## 那为什么主进程还要一只文件
 *
 * 因为**删**有后果,而后果只有主进程做得到:
 *
 *   ① 那一格身份下还开着的 tab 要先关掉;
 *   ② 那个分区里的数据要清掉(`session.clearStorageData()`)。
 *
 * 让壳去做这两件是错的:壳没有 `session`,也没有 tab 的真源。让**设置域**去做
 * 也是错的 —— 设置域跑在 backend 里,它同样没有 Electron。所以这条路与
 * `cdp-settings.ts` 逐字同族:**设置域只管存,宿主订变更、自己折出后果**。
 * 一句话判据:「删一格身份会让数据消失」是宿主的活,不该传染给设置域。
 *
 * ## 次序是硬的:**先关 tab,再清分区**
 *
 * 反过来做的结果不是「慢一点」,是**清了一半**:一片还活着的 `WebContentsView`
 * 正在跑那一页,清完之后它一次 `fetch`、一次 `document.cookie` 就把登录态写了
 * 回去。所以 reconciler 里那两句的顺序是判据本身,单测直接钉调用序
 * (反证:把两句对调 → 「先关 tab 再清分区」那条当场红)。
 *
 * ## 只处理**消失**的那几格
 *
 * 新增与改名对主进程**什么都不是**:分区是懒建的(第一格 tab 用到它的那一刻
 * `sessionFor` 才建),名字只活在屏幕上。所以这只 reconciler 的输入是两份名册
 * 的差集,而它只认一种差:**上一份里有、这一份里没有**。
 *
 * ## 零 electron import
 *
 * 与这个目录里除 `index.ts` 之外的每一只文件同一条纪律:tab 的关法与分区的
 * 清法都是注入的窄口,于是次序与差集这两件真会藏 bug 的事在 vitest 里量得到。
 */

import type { AppSettings, BrowserProfile } from '@shared/ipc/settings.js'
import { DEFAULT_BROWSER_PROFILE_ID } from '@shared/ipc/settings.js'
import type {
  SettingsEvent,
  SettingsEventBroadcaster,
} from '@onething/backend/wiring/settings/events.js'

/** 名册在主进程这一侧要的全部:有哪几格,新 tab 缺省用哪一格。 */
export interface BrowserProfileTable {
  readonly ids: readonly string[]
  readonly defaultProfile: string
}

/**
 * 设置 → 名册。
 *
 * **回落那一格不是装饰**:老 store / 手改坏的 `settings.json` 走到这里时
 * `profiles` 可能整格缺席。答一张空名册的后果是下一拍 reconciler 把**每一格**
 * 身份都当成「被删了」,连着 tab 一起清掉 —— 一次归一失败变成一次数据删除。
 * 所以空名册一律读成出厂那一格。
 */
export function profileTableFromSettings(settings: Pick<AppSettings, 'browser'>): BrowserProfileTable {
  const rows: readonly BrowserProfile[] = settings.browser?.profiles ?? []
  const ids = rows.map(row => row?.id).filter((id): id is string => typeof id === 'string' && id.length > 0)
  if (ids.length === 0) {
    return { ids: [DEFAULT_BROWSER_PROFILE_ID], defaultProfile: DEFAULT_BROWSER_PROFILE_ID }
  }
  const wanted = settings.browser?.defaultProfile
  return {
    ids,
    defaultProfile: typeof wanted === 'string' && ids.includes(wanted) ? wanted : ids[0]!,
  }
}

export interface BrowserProfileReconcilerOptions {
  /** 关掉这一格身份下的全部 tab。答关掉了几格(只为记一行日志)。 */
  closeTabs(profile: string): number
  /** 把这个分区清空。**只在 tab 全关掉之后调**(判词在文件头)。 */
  clearPartition(profile: string): Promise<void>
  /** 清分区砸了怎么说。缺席 = 咽掉:一次清不掉不该把保存设置那一发炸了。 */
  onError?(profile: string, error: unknown): void
}

/**
 * 名册变更 → 后果。**持着上一份名册**,所以它是一个对象而不是一个纯函数:
 * 「哪几格消失了」这句话只有拿着前后两份才答得出。
 */
export class BrowserProfileReconciler {
  private known: readonly string[]
  private readonly options: BrowserProfileReconcilerOptions

  constructor(initial: BrowserProfileTable, options: BrowserProfileReconcilerOptions) {
    this.known = initial.ids
    this.options = options
  }

  /** 此刻账上有哪几格(测试与日志读它)。 */
  get profiles(): readonly string[] { return this.known }

  /**
   * 收一份新名册。答**这一次真的被删掉的那几格**(没有变化时是空数组,
   * 于是调用方一眼看得出「这一发什么都没发生」)。
   */
  async apply(next: BrowserProfileTable): Promise<readonly string[]> {
    const alive = new Set(next.ids)
    const gone = this.known.filter(id => !alive.has(id))
    this.known = next.ids
    for (const profile of gone) {
      // ① 先关 tab。同步的一步 —— 关到一半去 await 会给页面留出写回 cookie 的窗口。
      this.options.closeTabs(profile)
      // ② 再清分区。
      try {
        await this.options.clearPartition(profile)
      } catch (error) {
        this.options.onError?.(profile, error)
      }
    }
    return gone
  }
}

export interface BrowserProfilesWatcherOptions extends BrowserProfileReconcilerOptions {
  /** 当下的设置。装配完读一次。 */
  readSettings(): Pick<AppSettings, 'browser'>
  /** 单槽端口的读口(串联用)。 */
  getBroadcaster(): SettingsEventBroadcaster | null
  /** 单槽端口的写口。 */
  setBroadcaster(next: SettingsEventBroadcaster | null): void
  /** 缺省身份变了就叫一声(service 每次 `open` 现问,所以这一口只为测试与日志)。 */
  onTable?(table: BrowserProfileTable): void
}

/**
 * 装上「名册变更 → 关 tab + 清分区」这条路。返回摘掉它的那一手(**幂等**)。
 *
 * 串联进单槽端口的写法与 `installCdpSettingsWatcher` 逐字相同(先叫前一个、
 * 再干自己的;摘的时候只在还是**我**占着那一格时才还原)—— 两处各写一遍是
 * 两处会漂,但把它抽成一只「串联器」要动 B2′ 那只已经入库的文件,
 * 而那条边此刻只有两个消费者。**留账**:第三个消费者出现时抽。
 *
 * **开场不 reconcile**:装配那一刻手上只有一份名册,没有「上一份」可比 ——
 * 拿它与空集比会把每一格身份都当成新增(无后果),拿它与全集比会把没列在
 * 名册里的分区全清掉(有后果,而且是删数据)。所以开场只记账。
 */
export function installBrowserProfilesWatcher(options: BrowserProfilesWatcherOptions): () => void {
  const initial = profileTableFromSettings(options.readSettings())
  options.onTable?.(initial)
  const reconciler = new BrowserProfileReconciler(initial, options)

  const previous = options.getBroadcaster()
  const mine: SettingsEventBroadcaster = (event: SettingsEvent) => {
    previous?.(event)
    const table = profileTableFromSettings(event.settings)
    options.onTable?.(table)
    void reconciler.apply(table)
  }
  options.setBroadcaster(mine)

  let disposed = false
  return () => {
    if (disposed) return
    disposed = true
    if (options.getBroadcaster() === mine) options.setBroadcaster(previous)
  }
}
