/**
 * **`@<绝对路径>` 这条写法本身** —— 文件与目录两种引用共用的那一句语法。
 *
 * 它不是第三种引用,是那两种**同一条语法**的产地:两家各自 `toRef` 时都要先把
 * 这一句解出来,再各自回答「这一条是不是我的」(尾巴上那个 `/`)。写在这里而不是
 * 让目录去 import 文件,是因为它谁都不属于 —— 两家是对等的读者。
 *
 * ── 不发明新语法 ──────────────────────────────────────────────────────────
 * 与 `docs/design/message-references-2026-08.md` 同一条裁定:引用是**已经在正文里
 * 的写法**,壳只是认出来。所以「裸文件名不算文件」——`@foo` 没有斜杠就是三个字。
 */

/**
 * 正文里的 `@` 引用。
 *
 * 三条判据各自挡一类误判,拆掉哪条就有哪类假引用:
 *  · `(^|[\s…])` —— `@` 前必须是行首、空白,**或一个左括号**。挡掉 `user@/path`
 *                  这种地址形(rsync / scp 的写法),它不是引用;左括号那一格
 *                  是给「(@/a/b.ts)」「(@/a/dir/)」这种夹注写法留的门 ——
 *                  它与地址形无关(`backup@/mnt` 里 `@` 前是字母,照旧挡住)。
 *  · `(?:~\/|\/)` —— `@` 后必须紧跟绝对路径的起笔。挡掉邮箱 `a@b.com` 与
 *                  `@foo` 这种裸名字;
 *  · 路径的字符集 —— 到下一个**空白或全角标点**为止(见下)。于是
 *                  **带空格的路径认不出整条**(`@/Users/my file.ts` 只认到
 *                  `/Users/my`),这是明知的取舍:认空格就得猜哪一个空格是路径的
 *                  一部分,而猜错的代价是把后半句正文吞进一枚 chip 里。
 */
export const PATH_REF_PATTERN = /(^|[\s([{<（【「『《〈])@((?:~\/|\/)[^\s，。、；：！？）】」』》〉（【「『《〈]*)/g

/**
 * 尾随标点**剥下来还给正文**(2026-09-12 review 打回)。
 *
 * 病:路径吞了标点,chip 点开**必然**打不开(那条路径不存在)。中文正文里最自然的
 * 那几种写法全中:「看看 @/a/b.ts,然后…」「(@/a/b.ts)」「@/a/b.ts。」。
 *
 * ── 为什么是两半,不是一条「尾巴剥干净」───────────────────────────────────
 * 半角与全角在这件事上是**两种东西**,一条规则盖不住:
 *  · **全角标点直接不进路径**(写进上面那个字符集的排除表)。中文正文不用空格断句
 *    ——「@/a/b.ts,然后」整串没有一个空白,只在尾部剥的话什么都剥不掉(这正是
 *    review 那条打回的原样复现)。全角标点在真实文件名里近乎不存在,所以它可以当
 *    终止符;顺带也就管住了 `(…)` 夹注的右半边。
 *  · **半角标点只在尾部剥**(下面这条)。`,` `.` `:` 在文件名中间是合法的
 *    ——`@/a/b.v2.ts` 必须整条留着 —— 所以只锚 `$`,一次剥一串
 *    (`(@/a/b.ts)。` 的 `)` 归这条,`。` 归上一条)。
 *
 * 两件事值得写清楚:
 *  · 结尾的 `.` 也剥 —— 一个以点结尾的路径不是文件名,那个点是句号;
 *  · **目录判据在剥完之后才判** —— 不然 `(@/a/dir/)` 的尾巴是 `)`,
 *    剥之前它不以 `/` 结尾,会被判成文件。
 * `/` 两条表里都没有(它是目录的记号,不是标点)。
 */
const TRAILING_PUNCT = /[,.;:!?)\]}>'"]+$/

/** 一次 `@` 命中解出来的那条路径,以及它在正文里**真正吃掉的那一段**。 */
export interface PathRefHit {
  path: string
  start: number
  end: number
}

/**
 * 把一次命中解成路径。剥下来的尾随标点**不在** `[start, end)` 里 —— 于是扫描器
 * 从 `end` 接着走,那几个字自然回到正文里(不是「再 push 一次」,是压根没被吃掉)。
 */
export function pathRefOf(m: RegExpExecArray): PathRefHit {
  const lead = m[1]
  const raw = m[2]
  const path = raw.replace(TRAILING_PUNCT, '')
  // `start` 落在 `@` 上(那一枚记号本身是引用的一部分,不是正文);
  // 所以吃掉的那一段是 `@` + 剥过尾巴的路径 —— 那个 `+1` 就是 `@`。
  const start = m.index + lead.length
  return { path, start, end: start + 1 + path.length }
}

/** 结尾一个 `/` = 用户自己说了这是个目录。**别处不许再猜**(壳没有 stat)。 */
export function isDirectoryPath(path: string): boolean {
  return path.endsWith('/')
}

/* ── 行内码整格是一条路径(09-20)──────────────────────────────────────────
 *
 * 与上面那条 `@` 语法并列的**第二句判词**,住在同一只文件里的理由也一样:
 * 文件与目录两家都要问它,而它谁都不属于。
 *
 * ── 为什么要有这一句 ──────────────────────────────────────────────────────
 * 09-20 真机:`<ref/>` 的提示词确实送到了模型(systemPromptHash 变了),模型照旧
 * 把路径写成行内码 —— 重启后 6900 字正文里 `<ref` 零个、反引号绝对路径三个。
 * 既有裁定「宿主接不住的路修宿主,别只靠劝模型」在这条链上的落地就是这一句:
 * **线上写法一个字不加**,只是壳多认一种早就在正文里的写法。
 *
 * ── 整格,不在码里挖字 ────────────────────────────────────────────────────
 * 一格行内码是一个不可分的整体。`` `npm run build -- /a/b.ts` `` 里那条路径是
 * 那句命令的一部分,把它挖出来画成 chip 就等于把一句命令劈成两半。所以这里的
 * 判据一律锚 `^…$`,而且**首尾不许有空白**(`` ` /a/b.ts ` `` 是写的人有意留的
 * 排版,不是一条路径)。
 */

/**
 * **「像一条本机目录」的根**。
 *
 * 只有目录那一种读它,理由是**目录没有扩展名可判**:文件靠最后一段的扩展名就
 * 能把 `/api/files/read` 这类路由形挡在外面(见 `looksLikeFilePath`),而目录
 * 连那一格都没有 —— `/api/users/` 与 `/Users/me/proj/` 在字符上是同一个形。
 * 于是只剩「它从哪儿起笔」这一条:一条本机绝对目录只可能从这几个根之一开始。
 *
 * 表短是故意的:宁可漏认几条真目录(用 `<ref type="dir"/>` 写的照旧认),也不
 * 把一条 REST 路由画成可点的目录 chip。加一行之前先问「这个根底下会不会有 URL」。
 */
export const LOCAL_DIR_ROOTS: readonly string[] = [
  '/Users/',
  '/home/',
  '~/',
  '/tmp/',
  '/private/',
  '/var/',
  '/opt/',
  '/Volumes/',
]

/**
 * 位置后缀:`:12` / `:12-30` / `:12:5`(行:列)/ `#L12` / `#L12-L30`。
 *
 * 两种写法都收,因为两种都是人与工具在真实世界里写出来的:`:12` 是编译器与
 * `rg` 的输出形,`#L12` 是 GitHub 的链接形。**只锚结尾**:冒号在文件名中间是
 * 合法字符,只有贴在末尾的那一串才是位置。
 */
const CODE_LOCATION = /(?::(\d+)(?:-(\d+)|:(\d+))?|#L(\d+)(?:-L?(\d+))?)$/

/** 扩展名:最后一段末尾 `.` 之后 1–10 个字母数字。 */
const EXTENSION = /\.([A-Za-z0-9]{1,10})$/

/** 一格行内码解出来的那条路径与位置。位置三格缺席各有各的意思,所以不给缺省值。 */
export interface CodePathRef {
  path: string
  line?: number
  endLine?: number
  col?: number
}

function intOf(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined
  const n = Number(raw)
  return Number.isInteger(n) && n > 0 ? n : undefined
}

/**
 * 一格行内码 → 路径 + 位置。答 `null` = 这一格连「形状上像条绝对路径」都不成立。
 *
 * **它不判文件还是目录** —— 那是两家各自的事(尾斜杠 / 扩展名 / 根前缀),这里
 * 只管把那一格字拆开。三条形状判据,拆掉哪条就有哪类假引用:
 *  · `trim` 后与原文相同且非空 —— 首尾空白是排版,不是路径;
 *  · 不含空白、不含反引号 —— 认空格就得猜哪一个空格是路径的一部分(与上面那条
 *    `@` 语法同一条取舍),反引号在一格行内码里只可能是围栏漏进来的;
 *  · `/` 或 `~/` 起笔 —— **这一句就是早退**:`npm run dev` 在第一个字符上就出局,
 *    一条长回复里几百格行内码里的绝大多数走的都是这条最短路。
 */
export function parseCodePathRef(text: string): CodePathRef | null {
  // 早退:首字符先问一次,连 trim 都不必做(判词见上)。
  const head = text.charCodeAt(0)
  // 47 = '/',126 = '~'
  if (head !== 47 && head !== 126) return null
  if (text !== text.trim() || !text) return null
  if (/[\s`]/.test(text)) return null
  if (!text.startsWith('/') && !text.startsWith('~/')) return null

  const m = CODE_LOCATION.exec(text)
  const path = m ? text.slice(0, m.index) : text
  // `:12` 前面什么都没有(整格就是一个位置)= 不是路径。
  if (!path) return null
  if (!m) return { path }

  const line = intOf(m[1] ?? m[4])
  /*
   * 行号写成 0 = **那一截仍旧是位置,只是写的人写错了**:`/a/b.ts:0` 指的还是
   * `b.ts`,所以后缀照剥、行号当没给(与 `file.ts` 的 `parseLineSpan` 同一条:
   * 认不出的整格当没给,不猜、不报错)。
   */
  if (line === undefined) return { path }
  const end = intOf(m[2] ?? m[5])
  const col = intOf(m[3])
  return {
    path,
    line,
    // 区间反着写当只给了起点 —— 落行只认 `line`,损失是零(与 `file.ts` 同判据)。
    ...(end !== undefined && end >= line ? { endLine: end } : {}),
    ...(col === undefined ? {} : { col }),
  }
}

/**
 * **这一格像一份文件吗**。
 *
 * 判据是 08-19 那条既有裁定的照搬:`/api/files/read`、`/usr/bin`、`/v2/users`
 * 这类路由 / 目录形不许被认成文件。它成立要两条之一:
 *  · **最后一段有扩展名** —— `.` 之后 1–10 个字母数字,而且**至少含一个字母**
 *    (`/v1.0` 的 `0` 不算:版本号不是扩展名);
 *  · **带了位置后缀** —— `/etc/hosts:3` 没有扩展名,但写的人已经指到了第 3 行,
 *    那就不可能是一个目录。
 * 尾斜杠一票否决(那是目录自己说的话)。段数不作要求:`/a.ts` 一段也是文件。
 */
export function looksLikeFilePath(hit: CodePathRef): boolean {
  if (hit.path.endsWith('/')) return false
  if (hit.line !== undefined) return true
  const last = hit.path.slice(hit.path.lastIndexOf('/') + 1)
  const ext = EXTENSION.exec(last)
  return Boolean(ext && /[A-Za-z]/.test(ext[1]))
}

/**
 * **这一格像一个本机目录吗**。
 *
 * 三条:尾斜杠(目录的记号)、从 `LOCAL_DIR_ROOTS` 之一起笔(判词在那张表上)、
 * 至少两段(`/tmp/` 这种只有根的太短,`~/notes/` 的两段刚好)。位置后缀一票否决
 * —— 一个目录没有第 12 行。
 */
export function looksLikeDirPath(hit: CodePathRef): boolean {
  if (!hit.path.endsWith('/')) return false
  if (hit.line !== undefined || hit.col !== undefined) return false
  if (!LOCAL_DIR_ROOTS.some((root) => hit.path.startsWith(root))) return false
  return hit.path.split('/').filter(Boolean).length >= 2
}
