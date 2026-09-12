import type { ReferenceKind, ReferenceTrigger, ReferenceWhere } from './kind'

/**
 * **引用种类的注册表**(正本 §2)。体例逐字照 `workbench/kinds.ts` 的
 * `registerContentKind` 与 `content/blocks/registry.ts` 的 `registerBlock`:
 * 重名**抛**而不是替换(两处抢同一个名字是真冲突,放宽成替换等于为了治热更把
 * 真冲突一起放过),热更那一路由调用模块自己递进来的 `import.meta.hot` 摘干净。
 *
 * ── 这只文件里一个种类名都没有 ─────────────────────────────────────────────
 * 它只认得「有这么五格」。`parseToken` 的两条正则从前写死在
 * `composer/transitions.ts` 里,今天由下面 `triggerTable()` **从表里长出来**:
 * 触发字符、句首还是句中、token 收哪些字符,三样都是各家自述的并。
 *
 * ── 谁来 import 那张 barrel ────────────────────────────────────────────────
 * 与 `workbench/CenterRegion` 对内容种类那一条逐字同判例:**谁要查表,谁负责
 * 保证表是装好的**。所以 `references/index.ts`(登记 barrel)被四处 import:
 * `main.tsx`(第一帧)、`content/user-message.tsx`(画气泡)、`composer/
 * usePickDrawer.ts`(开抽屉)、`composer/components/ComposerInput.tsx`(草稿出口
 * 要查 `expand`)。生产那条路由 `main.tsx` 先装好,后三行管的是「不经过 main.tsx
 * 的宿主」(用例、将来的第二个壳)。
 */

/** Vite 的 `import.meta.hot` 里这一批只用得到 `dispose` 一口。 */
export interface ImportMetaHot {
  dispose(cb: () => void): void
}

const REGISTRY = new Map<string, ReferenceKind>()

/**
 * 派生表的缓存。它们全由 `REGISTRY` 算出来,所以每一次登记 / 注销都整格作废 ——
 * 「缓存与它的产地之间只有一条边」是这格能放心存在的唯一理由。
 */
let derived: {
  triggers: TriggerSpec[]
  pick: ReferenceKind[]
  text: ReferenceKind[]
  part: ReferenceKind[]
  tokenTail: RegExp
} | null = null

/** 一个触发字符在 `parseToken` 那边的全部事实。**由表算出来,不是写死的。** */
export interface TriggerSpec {
  trigger: ReferenceTrigger
  where: ReferenceWhere
  /** 光标前那一截怎么切出 token(带一个捕获组 = 查询词)。 */
  re: RegExp
}

function invalidate(): void {
  derived = null
}

/**
 * 登记一种引用。返回注销口;给了 `hot` 就自动配好热更退役。
 *
 * **有 `parse` 就必须有 `render`**:认得出却画不出来,是一格会在屏幕上开天窗的
 * 自述。在登记这一刻抛,而不是等它真的出现在某条消息里才静默什么都不画。
 */
export function registerReferenceKind(kind: ReferenceKind, hot?: ImportMetaHot): () => void {
  const now = REGISTRY.get(kind.id)
  if (now && now !== kind) throw new Error(`reference kind 重复注册:${kind.id}`)
  if (kind.parse && !kind.render) {
    throw new Error(`reference kind 认得出却画不出来:${kind.id}`)
  }
  REGISTRY.set(kind.id, kind)
  invalidate()
  const off = () => {
    // 只摘「确实是我登记的那一格」—— 别人已经换上去了就不动它。
    if (REGISTRY.get(kind.id) === kind) {
      REGISTRY.delete(kind.id)
      invalidate()
    }
  }
  hot?.dispose(off)
  return off
}

export function referenceKindOf(id: string | undefined): ReferenceKind | undefined {
  return id === undefined ? undefined : REGISTRY.get(id)
}

/** 按登记序。登记序**就是**抽屉里从上到下的组序。 */
export function referenceKindList(): readonly ReferenceKind[] {
  return [...REGISTRY.values()]
}

/** 只给测试与演练:用例之间归零。 */
export function resetReferenceKinds(): void {
  REGISTRY.clear()
  invalidate()
}

/* ── 派生表 ────────────────────────────────────────────────────────────── */

function escapeForClass(chars: string): string {
  // `-` 摆在最后一位就是字面量(不必反斜杠,也就不会在别的实现里读成范围);
  // `]` / `\` / `^` 三个在字符组里有身份,逐个转义。
  const set = [...new Set(chars)].filter((c) => c !== '-')
  const body = set.map((c) => (/[\]\\^]/.test(c) ? `\\${c}` : c)).join('')
  return chars.includes('-') ? `${body}-` : body
}

function escapeLiteral(ch: string): string {
  return /[.*+?^${}()|[\]\\/]/.test(ch) ? `\\${ch}` : ch
}

function build(): NonNullable<typeof derived> {
  const kinds = [...REGISTRY.values()]
  const pick = kinds.filter((k) => k.source)
  const byTrigger = new Map<ReferenceTrigger, ReferenceKind[]>()
  for (const kind of pick) {
    const trigger = kind.source!.trigger
    const list = byTrigger.get(trigger)
    if (list) list.push(kind)
    else byTrigger.set(trigger, [kind])
  }

  const triggers: TriggerSpec[] = [...byTrigger.entries()].map(([trigger, list]) => {
    /*
     * **最严格者胜**:同一个触发字符下有一家说「只在句首」,整个字符就按句首算。
     * 理由是触发是**一个字符**的事:两种说法并存时按更保守的那个 —— 不然一种
     * 句中触发的引用会把另一种只该在句首出现的一起拽出来,而人只按了一个键。
     */
    const where: ReferenceWhere = list.some((k) => k.source!.where === 'line-start')
      ? 'line-start'
      : 'anywhere'
    const chars = escapeForClass(list.map((k) => k.source!.tokenChars ?? '').join(''))
    const lead = where === 'line-start' ? '(?:^|\\s)' : ''
    return {
      trigger,
      where,
      re: new RegExp(`${lead}${escapeLiteral(trigger)}([\\w${chars}]*)$`),
    }
  })

  /*
   * 光标前那一截 token 的**尾巴**(`insert` 要把它原地摘掉换成 chip)。它是所有
   * 触发字符与所有 token 字符的并 —— 摘的时候不必知道这一枚是哪一种,
   * 光标前面那一截只可能是刚刚触发出这个抽屉的那一个。
   */
  const allChars = escapeForClass(pick.map((k) => k.source!.tokenChars ?? '').join(''))
  const allTriggers = [...byTrigger.keys()].map(escapeLiteral).join('|')
  const tokenTail = new RegExp(`(${allTriggers})[\\w${allChars}]*$`)

  return {
    triggers,
    pick,
    text: kinds.filter((k) => k.parse?.text),
    part: kinds.filter((k) => k.parse?.part),
    tokenTail,
  }
}

function table(): NonNullable<typeof derived> {
  derived ??= build()
  return derived
}

/**
 * 有拾取半边的那几种,**按登记序**。
 *
 * 抽屉按这个序逐个调它们的 `useQuery`(那是 hook),所以这张表在**渲染期间不许
 * 变**:登记发生在模块装载那一刻(barrel),演练与测试要在 render 之前登记。
 * 这不是一条软约束 —— 渲染中途多一家就是 hook 数量变了,React 会当场喊。
 */
export function referencePickKinds(): readonly ReferenceKind[] {
  return table().pick
}

/** 有正文认出半边的那几种,按登记序。 */
export function referenceTextKinds(): readonly ReferenceKind[] {
  return table().text
}

/** 有部件认出半边的那几种,按登记序。 */
export function referencePartKinds(): readonly ReferenceKind[] {
  return table().part
}

export function referenceTriggers(): readonly TriggerSpec[] {
  return table().triggers
}

/** `insert` 把光标前那截 token 原地摘掉用的那条尾巴。 */
export function draftTokenTailPattern(): RegExp {
  return table().tokenTail
}

/** 一枚 chip 的记号交出去时展成什么。查不到 / 没有展开 = 原样。 */
export function expandReferenceToken(kindId: string | undefined, token: string): string {
  return referenceKindOf(kindId)?.draft?.expand?.(token) ?? token
}

/* ── 触发检测 ──────────────────────────────────────────────────────────── */

/** `@` / `/` 的触发结果。`trigger` 是**字符**,不是种类名 —— 一个字符下可以有好几种。 */
export interface TokenHit {
  trigger: ReferenceTrigger
  query: string
}

/**
 * 光标前那一截里有没有触发 token。
 *
 * 判据一个字没变,变的是它从哪儿来:
 *  · `upto` = 光标之前那一段文本,token 只可能长在它的**末尾**;
 *  · `full` = 整个输入框的纯文本,**只**用来问「这句话是不是以这个字符开头」——
 *    那是 `line-start` 那一档的前提(命令是一句话的主语,不是句中的词)。
 *
 * 表空 = 一个字符都不触发(而不是「按老规矩来」):没登记就是这台上没有这种能力。
 */
export function parseToken(upto: string, full: string): TokenHit | null {
  for (const spec of table().triggers) {
    const m = spec.re.exec(upto)
    if (!m) continue
    if (spec.where === 'line-start' && !full.trim().startsWith(spec.trigger)) continue
    return { trigger: spec.trigger, query: m[1] }
  }
  return null
}
