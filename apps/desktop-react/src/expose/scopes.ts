import type { MessageKey } from '../i18n'
import { isRoomKind } from './row-kinds'
import type { ProjectScope, SessionSummary } from './types'

/**
 * **范围自述表**(方向 A §1.3 的 `SCOPE_SPECS`)。
 *
 * 侧栏、窄档的项目选择器、列表过滤三处读的是同一张表:
 * 一行 = `{ kind, labelKey, icon, predicate }`,谁都不许自己写
 * `if (scope === 'collab')`。「加一档范围:归档」= 这张表加一行 + i18n 一对,
 * 零分支改动(设计 §6 演练第一条)。
 *
 * ── 侧栏的三条常设纪律,都长在这张表上 ─────────────────────────────────────
 *  · `all` 恒在;`collab` / `loose` **只在非空时出现**(见 `visibleScopes`);
 *  · 项目那一档不写在表里 —— 它是**一族**(每个项目一格),由 `projectScope`
 *    从 `buildProjects` 的名册现造,次序即那份名册的次序(最近活动倒序);
 *  · 侧栏项**不带数字**(08-30 计数禁令),所以表上没有 count 这一格,
 *    `visibleScopes` 也只回「在不在」而不回「有几条」。
 */
export interface ScopeSpec {
  kind: ProjectScope['kind']
  labelKey: MessageKey
  /**
   * 图标**名**,由 `components/icons.ts` 的 `resolveIcon` 解析。
   * 这一层不 import 组件(纯数据,与 stage 的 `StageItemSpec.icon` 同判例)。
   */
  icon: string
  /**
   * 这条会话算不算在这一档里。`scope` 一并递进来,因为 `project` 那一档带参数
   * —— 表要能用**同一个签名**表达带参与不带参的两种,否则 project 就得开后门。
   */
  predicate: (session: SessionSummary, scope: ProjectScope) => boolean
}

/** 协作三档(room / dm / swap)—— 判据来自形态表,不在这里重列一遍。 */
function isCollabSession(session: SessionSummary): boolean {
  return isRoomKind(session.kind)
}

export const SCOPE_SPECS: readonly ScopeSpec[] = [
  { kind: 'all', labelKey: 'expose.scopeAll', icon: 'Layers', predicate: () => true },
  {
    kind: 'collab',
    labelKey: 'expose.scopeCollab',
    icon: 'MessagesSquare',
    predicate: (session) => isCollabSession(session),
  },
  {
    /*
     * 「无项目」= 没有工作目录**而且**不是协作 —— 房间即便没有目录也归协作那一档,
     * 否则同一条会话会同时出现在两格里,而侧栏的语义是「各看各的一摞」。
     */
    kind: 'loose',
    labelKey: 'expose.scopeLoose',
    /* 单气泡 = 「就是一条聊天」。**不用空心方框 `Square`**:这套词汇里方框是
       composer 的「停止」,摆在侧栏一列里会被读成一枚没勾上的勾选框
       (09-04 真机走查用户看图当场指出)。 */
    icon: 'MessageSquare',
    predicate: (session) => !session.projectId && !isCollabSession(session),
  },
  {
    /*
     * 「这个项目」= 工作目录撞在这一格上的会话,**而且不是房间**
     * (09-04 用户真机报「项目里面没过滤 room 和私聊」)。
     *
     * 判据与 `loose` 那一格是同一句话的两端,08-28 那条裁决的完整形:
     * **房间即便带着工作目录也归协作**,协作与项目互斥完备。房间的工作目录是
     * 它派工时给子会话用的那一格,不是「这间房属于某个项目」——按它归档,
     * 侧栏点进一个项目会看见一串房间,而房间该在的地方是「协作」。
     * 子行不必在这里另判:`list-model.applyScope` 让它跟着父房间走,
     * 所以房间被这一格滤掉时,它的 `[任务]` / `[执行]` 一并不在。
     *
     * 与侧栏那份项目名册同源:`projection.buildProjects` 早就跳过房间
     * (它只按非房间会话的最新活动排项目),所以修的是这里对不上那里。
     */
    kind: 'project',
    labelKey: 'expose.scopeLabel',
    icon: 'Folder',
    predicate: (session, scope) =>
      scope.kind === 'project' &&
      session.projectId === scope.projectId &&
      !isCollabSession(session),
  },
]

const BY_KIND = new Map(SCOPE_SPECS.map((spec) => [spec.kind, spec]))

/** 恒在的那一档,也是出厂值。 */
export const ALL_SCOPE: ProjectScope = { kind: 'all' }

export function scopeSpecOf(scope: ProjectScope): ScopeSpec {
  // 表是封闭的(联合的每一档都在里面),所以这里不会缺 —— `!` 由类型兜着。
  return BY_KIND.get(scope.kind)!
}

/** 这条会话在不在这一档范围里。**过滤的唯一判据。** */
export function scopeMatches(scope: ProjectScope, session: SessionSummary): boolean {
  return scopeSpecOf(scope).predicate(session, scope)
}

/**
 * 范围的**稳定标识** —— React 的 key、`data-testid`(`expose-scope-<id>`)、
 * 「这两格是不是同一格」都读它。项目那一档带上目录,别的档就是档名。
 */
export function scopeId(scope: ProjectScope): string {
  return scope.kind === 'project' ? `project:${scope.projectId}` : scope.kind
}

export function sameScope(a: ProjectScope, b: ProjectScope): boolean {
  return scopeId(a) === scopeId(b)
}

/** 一个项目目录 → 它那一档范围。侧栏与选择器都从这里造,不各拼各的。 */
export function projectScope(projectId: string): ProjectScope {
  return { kind: 'project', projectId }
}

/**
 * 固定三档里此刻**该出现**的那几格。
 *
 * `all` 恒在;`collab` / `loose` 空了就不出现 —— 一个点开只会看见「没有会话」
 * 的入口不是选项,是死路(08-30 判例:不画没有产地的格)。
 * 项目那一族不在这里,它跟着 `buildProjects` 的名册走。
 */
export function visibleScopes(sessions: readonly SessionSummary[]): ProjectScope[] {
  const out: ProjectScope[] = [ALL_SCOPE]
  for (const kind of ['collab', 'loose'] as const) {
    const scope: ProjectScope = { kind }
    if (sessions.some((session) => scopeMatches(scope, session))) out.push(scope)
  }
  return out
}

/**
 * 这一格范围还站得住吗 —— 项目被删空 / 协作清零之后,记在家具里的那一格
 * 会指向一个不存在的入口。站不住就退回 `all`(而不是留一张空表让用户以为坏了)。
 */
export function resolveScope(
  scope: ProjectScope,
  sessions: readonly SessionSummary[],
): ProjectScope {
  if (scope.kind === 'all') return scope
  return sessions.some((session) => scopeMatches(scope, session)) ? scope : ALL_SCOPE
}
