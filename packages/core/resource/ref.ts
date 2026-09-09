/**
 * K0 —— 地址(`docs/design/atom-2026-09.md` §2「原子的定义」、§7 盲点 2「两套地址」、
 * §9 分期 K0「地址与类型」)。
 *
 * 原子的四条判据(§1)里最后一条是「有地址」:能被指着说「这个」—— 人能指、
 * AI 能指、链接能指。这只文件就是那套地址语法的全部,一共两条规矩:
 *
 *   1. **在第一个冒号处切**。冒号左边是 `scheme`(= 命名空间 = 应用 id),右边是
 *      这种资源自己的路径。路径里允许再出现冒号与斜杠 —— `file:/a/b:c` 合法,
 *      将来的 `web:https://…` 也合法。这一条与壳里
 *      `apps/desktop-react/src/workbench/kinds.ts` 的 `ContentRef {kind, key}` /
 *      `refId = ${kind}:${key}` / `parseRefId`(同样在第一个冒号处切,同样的理由)
 *      **逐字同形**:§7 盲点 2 要的是「同一套语法、同一张 scheme 表」,而不是
 *      两处各写一份差不多的。K2 并入时那边只是改名,K0 不碰壳。
 *
 *   2. **内核不认识任何 scheme**(§2 不变量 3)。这只文件里因此一个具体 scheme 的
 *      名字都没有,一个都不许有:谁提供一种资源,谁交一份自述(`spec.ts`)去注册表
 *      (`registry.ts`)登记,内核只做语法与路由。`__tests__/stranger.test.ts` 是这条
 *      的门 —— 它扫本目录的非测试文件,发现任何具体 scheme 的名字就红。
 *
 * ── `Ref` 为什么是模板字面量类型 ─────────────────────────────────────────────
 * 三个选项各自的代价:
 *   · 裸 `string` = 没类型。任何字符串都能当地址传,错要到运行时才发现。
 *   · 品牌类型 = 每个入口一次 `as Ref`。地址会从 JSON / RPC / 命令行 / deeplink
 *     进来(§4 出口那一整张表),满仓库的 `as` 等于把守卫关掉,还看不出哪一处是
 *     真的校验过、哪一处只是编译器闭嘴。
 *   · `${string}:${string}` = 折中,也是本文件选的:字面量 `'demo:x'` 直接可赋、
 *     少写冒号编译期就红,而一个来路不明的 `string` **进不来** —— 它必须先过
 *     `isRef` / `parseRef`,而那正是唯一该校验的地方。
 * 它只挡形状(有没有冒号)。语法(scheme 合不合法、path 空不空)由守卫挡,两半
 * 加起来才是完整判据 —— 别把 `Ref` 类型当成「已经校验过」的证据。
 */

/** scheme 语法:小写开头,后面小写字母 / 数字 / 连字符。与包名、命名空间同一族。 */
const SCHEME_PATTERN = /^[a-z][a-z0-9-]*$/

/**
 * 一个地址。形是 `${scheme}:${path}`。
 *
 * 类型只保证「有一个冒号」;`isRef` 才保证它合语法。
 */
export type Ref = `${string}:${string}`

/** 拆开的地址。`path` 的解释权归提供这种资源的人,内核不看。 */
export interface ResourceRef {
  readonly scheme: string
  readonly path: string
}

/** scheme 本身合不合语法。注册表登记时也用它(见 `contract.ts`)。 */
export function isRefScheme(value: string): boolean {
  return SCHEME_PATTERN.test(value)
}

/**
 * 解析一个地址。**在第一个冒号处切**,切不出合法的两半就回 `null` —— 不抛。
 *
 * 地址大多来自外面(用户输入、模型的工具参数、deeplink),「不认识」是常态而不是
 * 异常;抛错会逼每个调用方包一层 try。要断言的人自己判 `null`。
 *
 * 判据三条:
 *   · 冒号必须存在且不在第 0 位(scheme 非空);
 *   · scheme 过 `SCHEME_PATTERN`(所以 `Demo:x` / `1a:x` / `a_b:x` 都不是地址);
 *   · path 非空。path 之内不再有任何限制 —— 冒号、斜杠、空格都随它去,
 *     那是资源自己的坐标系(§7 盲点 6:`file:` 用路径当身份是接受的代价)。
 */
export function parseRef(id: string): ResourceRef | null {
  const at = id.indexOf(':')
  if (at <= 0 || at === id.length - 1) return null
  const scheme = id.slice(0, at)
  if (!isRefScheme(scheme)) return null
  return { scheme, path: id.slice(at + 1) }
}

/** 是不是一个合法地址。`Ref` 类型挡形状,这只守卫挡语法。 */
export function isRef(value: string): value is Ref {
  return parseRef(value) !== null
}

/**
 * 拼回一个地址。**不校验** —— 它是格式化器不是构造器,给它一份垃圾就还你一份
 * 垃圾(而那份垃圾过不了 `isRef`,下游该拦的地方仍然拦得住)。
 *
 * 往返保证:凡是 `parseRef` 吐出来的 `ResourceRef`,`parseRef(formatRef(r))` 与 `r`
 * 逐字段相等。反过来不成立(见上一段),测试两边都钉。
 */
export function formatRef(ref: ResourceRef): Ref {
  return `${ref.scheme}:${ref.path}`
}

/** 两个地址是不是同一个。与壳里的 `sameRef` 同形。 */
export function sameRef(a: ResourceRef, b: ResourceRef): boolean {
  return a.scheme === b.scheme && a.path === b.path
}

/**
 * 一个前缀合不合法。前缀只有两种形状,别的一律不是前缀:
 *
 *   · `scheme:`        —— 整个命名空间(「看住所有邮件」);
 *   · `scheme:path/`   —— 路径上的一段(「看住这个目录下面」)。
 *
 * 为什么**必须以 `:` 或 `/` 收尾**:这是把「前缀」钉在段边界上的唯一办法。允许
 * `file:/a` 当前缀,`file:/ab` 就会被算成命中 —— 一个看住 `/a` 的订阅会收到
 * `/ab` 的事件,而这种越界在事件流里是安静的(没人报错,只是多收了)。收尾符一
 * 卡,`file:/a/` 命中 `file:/a/b`、不命中 `file:/ab`,判据是结构性的而不是靠在
 * `startsWith` 之后再补一串 if。
 *
 * 顺带挡掉的第二种病:`demo` 这种没有冒号的串。裸 `startsWith` 会让它命中
 * `demo-archive:x`,即「一个 scheme 前缀吃掉了另一个 scheme」。
 */
export function isRefPrefix(prefix: string): boolean {
  if (!prefix.endsWith(':') && !prefix.endsWith('/')) return false
  const at = prefix.indexOf(':')
  if (at <= 0) return false
  if (!isRefScheme(prefix.slice(0, at))) return false
  // `scheme:` 本身合法(整个命名空间);`scheme:…/` 要求冒号后面真有东西。
  return at === prefix.length - 1 || prefix.endsWith('/')
}

/**
 * 这个地址在不在这个前缀底下(`watch` 一个前缀时的判据,§2 `Watch`)。
 *
 * 两边都得先是合法的形状,然后就是**字面前缀**——没有第二条规则,没有大小写折叠,
 * 没有路径规范化(`.` / `..` 不解析:内核不知道 path 是不是路径)。
 */
export function matchesRefPrefix(ref: string, prefix: string): boolean {
  if (!isRef(ref)) return false
  if (!isRefPrefix(prefix)) return false
  return ref.startsWith(prefix)
}
