import type { ProjectSummary } from './types'

/**
 * **范围菜单这一张表长什么样** —— 纯函数,一处产地(A6,正本
 * `docs/sessions-sidebar-2026-09.md` §9 拍板 2)。
 *
 * 起因是 09-13 用户真机报的第一条:真店 24 个项目,范围菜单一屏装不下。封顶那一半
 * 是库件的事(`ui/Menu` 的 `--menu-max-h`);这只文件管的是另一半 —— **表长到读不
 * 过来时,配一格筛选,再把久没动过的折起来**。
 *
 * 三段的次序就是判据:**固定档钉在最上面**(它们是这块面的语义档,不是数据),
 * 然后是最近活动过的项目,最后是折起来的「更早」。屏幕、键盘、门读的都是这一份。
 */

/**
 * **项目多到这个数以上才配筛选框**。
 *
 * 8 是「一屏读得完」的那一档(菜单体 24 行封顶的三分之一):再少的表,一格输入框
 * 只会多一件要读的东西 —— 眼睛扫八行比打字快。它同时是折叠那一档的闸(见
 * `buildScopeMenu`):把 5 个项目里的 2 个折起来买不到任何东西,只藏住了东西。
 */
export const EXPOSE_SCOPE_FILTER_MIN = 8

/** 「最近」的窗口:7 天。久于它的项目折进「更早」那一行。 */
export const EXPOSE_SCOPE_RECENT_MS = 7 * 24 * 60 * 60 * 1000

/** 菜单上的一行:值 + 屏幕上的字。固定档与项目共用这一格形。 */
export interface ScopeMenuOption {
  value: string
  label: string
}

/** 项目那一族多一格**最近活动**(`projection.buildProjects` 排序用的同一个数)。 */
export interface ScopeMenuProject extends ScopeMenuOption {
  updatedAt: number
}

export interface ScopeMenuInput {
  /** 固定三档(全部 / 协作 / 无项目)。**永不参与过滤**。 */
  fixed: readonly ScopeMenuOption[]
  /** 项目,已按最近活动倒序(`buildProjects` 的次序,这里一格都不重排)。 */
  projects: readonly ScopeMenuProject[]
  /** 筛选框里此刻那个词。空串 = 没在筛。 */
  query: string
  /** 「此刻」。纯函数不许自己去问 `Date.now()`(与 `list-model` 逐字同一条)。 */
  now: number
  /** 「更早」那一行被点开了没有。 */
  olderExpanded: boolean
}

export interface ScopeMenuModel {
  /** 顶上那格筛选框画不画。 */
  filterShown: boolean
  /** 固定三档,原样。 */
  fixed: ScopeMenuOption[]
  /** 要画出来的项目行(有词时 = 全部命中的,无词时 = 最近 7 天动过的)。 */
  recent: ScopeMenuProject[]
  /** 「更早」那一行展开后要画的项目;收着时是空数组。 */
  older: ScopeMenuProject[]
  /**
   * 「更早 · N 个」那一行上的 N。**0 = 不画那一行** —— 它与 `older.length` 是两格:
   * 收着的时候 `older` 是空的,而那一行仍要说得出「下面还有几个」。
   */
  olderCount: number
}

/** 大小写不敏感的子串匹配。**只认名字** —— 路径是副名,不是这一格筛的东西。 */
function matches(label: string, needle: string): boolean {
  return label.toLowerCase().includes(needle)
}

/**
 * 一张范围菜单。
 *
 * 四条规矩,每条都有单测钉着:
 *  ① 项目数 > `EXPOSE_SCOPE_FILTER_MIN` 才画筛选框(**严格大于**:正好 8 个不画);
 *  ② 固定三档**永不参与过滤**,也永远在最上面 —— 打了词之后「全部」还得点得到,
 *    不然人被自己打的词困在一个筛空的表里;
 *  ③ **有词时全部展开**:折叠是「平时少看几行」,不是「搜不到」—— 一个搜索不到
 *    的东西与不存在没有区别;
 *  ④ 折叠这件事**跟着筛选框一起开关**:短表折起来只藏东西,不省事(判词写在
 *    `EXPOSE_SCOPE_FILTER_MIN` 上)。
 */
export function buildScopeMenu(input: ScopeMenuInput): ScopeMenuModel {
  const fixed = [...input.fixed]
  const filterShown = input.projects.length > EXPOSE_SCOPE_FILTER_MIN
  const needle = input.query.trim().toLowerCase()

  if (needle) {
    // ③ 有词 = 全表参与匹配,不折。
    return {
      filterShown,
      fixed,
      recent: input.projects.filter((p) => matches(p.label, needle)),
      older: [],
      olderCount: 0,
    }
  }

  if (!filterShown) {
    // ④ 短表:一格不折,也不画筛选框。
    return { filterShown, fixed, recent: [...input.projects], older: [], olderCount: 0 }
  }

  const recent: ScopeMenuProject[] = []
  const older: ScopeMenuProject[] = []
  for (const project of input.projects) {
    // 边界取**闭区间**:正好 7 天前动过的还算「最近」(折叠是省事,不是判刑)。
    if (input.now - project.updatedAt <= EXPOSE_SCOPE_RECENT_MS) recent.push(project)
    else older.push(project)
  }
  return {
    filterShown,
    fixed,
    recent,
    older: input.olderExpanded ? older : [],
    olderCount: older.length,
  }
}

/**
 * 屏幕上这一刻**按得到**的那几行(固定档 + 画出来的项目)。
 *
 * 它存在的理由是键盘:头部槽里 ↵ 选「当前那一项」,而当前那一项是**画出来的**
 * 第一行 —— 判据得与画面同源,不能各数各的。
 */
export function scopeMenuRows(model: ScopeMenuModel): ScopeMenuOption[] {
  return [...model.fixed, ...model.recent, ...model.older]
}

/** 这只项目名册要不要按 `buildProjects` 的形折一格 `ScopeMenuProject`。 */
export function toScopeMenuProjects(
  projects: readonly ProjectSummary[],
  valueOf: (project: ProjectSummary) => string,
): ScopeMenuProject[] {
  return projects.map((project) => ({
    value: valueOf(project),
    label: project.name,
    updatedAt: project.updatedAt,
  }))
}
