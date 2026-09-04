/**
 * 脱敏规则表(检索重建 S0 立、S3a 从 `scripts/lib/` 搬进 core)。
 *
 * 设计:docs/design/search-index-2026-09.md §5.2c —— 索引前的横切面有两个缺省
 * `DocumentFilter`,脱敏是其中一个。S0 时这八条规则住在
 * `scripts/lib/search-corpus-redact.mjs`(只服务语料抽取与夹具自检);S3a 起
 * **真正的索引写路**也要跑同一条规则表(密钥不进倒排、不进摘要),而 `scripts/`
 * 不是产品代码的可 import 之处 —— 于是规则搬进这里,`.mjs` 降为一行再导出。
 * **一份实现,三个消费者**(抽取脚本 / 夹具自检 / 索引过滤器),这正是 S0 文件头
 * 里「洗过的语料再洗一遍恒等」那条恒等式成立的前提:三边跑的必须是同一份规则。
 *
 * 这个文件里只有**纯函数** —— 没有 IO、没有仓内依赖,所以 core 的零依赖不破。
 * 它也不出现任何能力 id 字面量(边界检查器 `checkCoreSearchNamesNoCapability`
 * 的射程覆盖本目录)。
 *
 * ## 规则表(顺序有意义,见每条的说明)
 *
 * | # | 认什么 | 换成 |
 * | --- | --- | --- |
 * | 1 | 家目录下的绝对路径 `/Users/<name>/…`、`/home/<name>/…` | `~/…` |
 * | 2 | 邮箱 | `<redacted:email>` |
 * | 3 | `sk-…` 形状的 API key(OpenAI / Anthropic 一族) | `<redacted:apikey>` |
 * | 4 | `Bearer <token>` | `Bearer <redacted:token>` |
 * | 5 | `key=…` / `token: "…"` 一族的**赋值右边** | `<redacted:secret>`(键名留着) |
 * | 6 | 手机号(中国大陆 11 位,可带 `+86` 与分隔符) | `<redacted:phone>` |
 * | 7 | 32 位以上的 `[A-Za-z0-9_-]` 随机串(**得先过 `accept`:标识符不算**) | `<redacted:token>` |
 * | 8 | **公网** IPv4(点分四段) | `<ip>` |
 *
 * **顺序**:1 先跑(路径里的用户名就是 PII,且切成段之后不会再被 7 吃掉整条路径);
 * 2 在 7 之前(邮箱的本地部分可能超过 32 位,先按邮箱认);5 在 7 之前(键名要留住,
 * 交给 7 会把整段吃成一个 token);6 在 7 之前(手机号是纯数字、7 也认,但 6 的
 * 占位更准)。
 *
 * **两个刻意的取舍**:
 *  · 规则 7 会顺带吃掉 UUID(36 位,带连字符)。这是**故意**的 —— 语料里的 id 一律
 *    另行哈希,正文里出现的裸 UUID 没有保留价值,吃掉反而更干净。
 *  · 规则 6 用 `(?<!\d)` / `(?!\d)` 夹住,所以 13 位的毫秒时间戳(`1785684318323`)
 *    不会被当成手机号 —— 真库里满地都是时间戳,这一条没夹住就会把语料洗烂。
 *
 * ## 形状之外的判据:`accept`(规则 7 与规则 8 各用一个)
 *
 * 有两条规则,正则只答得出「长得像」,答不出「是不是真要换」。所以规则多了一格
 * **`accept(match)`** —— 一个纯谓词。它是「洗」与「验」**共用**的判据:`redactText`
 * 只换 `accept` 点头的那些,`findRedactionHits` 也只把 `accept` 点头的算命中。少了
 * 这个共用,留下来的那些会被「验」那一半永远报成漏网,幂等那条恒等式当场不成立。
 *
 * ### 规则 8:点分四段不等于「一台机器的地址」
 *
 * `10.62.172.242` 与 `42.193.111.28` 形状逐字一样,前者是内网门牌(洗掉等于把
 * 「他们在讨论内网拓扑」这条信号也洗没了),后者是一台真机的公网地址(必须洗)。
 *
 * ### 规则 7:32 位以上不等于「一把密钥」
 *
 * S3c 的 parity-B 在真库上跑出两条红,病根都在这里:
 * `translatesAutoresizingMaskIntoConstraints`(41 位)与
 * `elcc_bot_res_signal_buttonOnly_buttonNumber`(43 位)是**正经标识符**,却被整段换成
 * `<redacted:token>`,于是它们的词元(`into` / `only` / `constraints` …)根本没进倒排 ——
 * 用户搜 `Only`、`into` 就漏。这不是「脱敏的必然代价」,是规则 7 的误伤。
 *
 * 分开它们的**不是长度,是结构**:真密钥是无结构的随机串,几乎必含数字,且数字散在
 * 串里;标识符是驼峰 / 蛇形拼起来的自然词。于是 `isLikelySecretToken` 这样判(见函数)。
 */

/**
 * 四条公共 DNS —— 它们是**常量**,不是谁的地址,洗掉只会让「他把 DNS 改成了 8.8.8.8」
 * 这句话读不懂。
 */
const PUBLIC_DNS_IPV4 = new Set(['8.8.8.8', '8.8.4.4', '1.1.1.1', '114.114.114.114'])

/**
 * 「这一段点分四段,是不是一台真机的**公网**地址?」—— 规则 8 的判据,`redactText`
 * 与 `findRedactionHits` 共用同一个答案。
 *
 * 返回 `false` 的都不洗:任一段 > 255(那压根不是 IP,是版本号或日期)、私网
 * (`10/8`、`172.16–31/12`、`192.168/16`)、回环 `127/8`、链路本地 `169.254/16`、
 * `0/8`、首段 ≥ 224(组播 `224–239` 与其上的保留段 `240–255`,顺带盖住 `255.x` 掩码)、
 * 四条公共 DNS,以及文档 / 基准测试专用段:`1.2.3.4`、RFC 2544 的 `198.18/15`、
 * 三条 TEST-NET(`192.0.2/24`、`198.51.100/24`、`203.0.113/24`)。
 */
function isPublicIpv4(text: string): boolean {
  const octets = text.split('.').map(part => Number(part))
  if (octets.length !== 4) return false
  if (octets.some(octet => !Number.isInteger(octet) || octet < 0 || octet > 255)) return false
  const [a, b, c] = octets as [number, number, number, number]
  if (a === 0 || a === 10 || a === 127 || a >= 224) return false
  if (a === 172 && b >= 16 && b <= 31) return false
  if (a === 192 && b === 168) return false
  if (a === 169 && b === 254) return false
  if (PUBLIC_DNS_IPV4.has(text)) return false
  if (a === 198 && (b === 18 || b === 19)) return false
  if (a === 192 && b === 0 && c === 2) return false
  if (a === 198 && b === 51 && c === 100) return false
  if (a === 203 && b === 0 && c === 113) return false
  if (text === '1.2.3.4') return false
  return true
}

/**
 * 把一个 `[A-Za-z0-9_-]` 串按**蛇形 + 驼峰**拆成词段;拆不动(有一段不是纯字母)就
 * 返回 `undefined`。
 *
 * 驼峰那一层用 `[A-Z]+(?![a-z])|[A-Z]?[a-z]+`:前一支吃连续大写的缩写(`HTTPServer`
 * → `HTTP` / `Server`),后一支吃普通的一段。
 */
function wordSegments(text: string): string[] | undefined {
  const segments: string[] = []
  for (const piece of text.split(/[-_]+/)) {
    if (piece.length === 0) continue
    if (!/^[A-Za-z]+$/.test(piece)) return undefined
    for (const segment of piece.match(/[A-Z]+(?![a-z])|[A-Z]?[a-z]+/g) ?? []) {
      segments.push(segment)
    }
  }
  return segments.length > 0 ? segments : undefined
}

/**
 * 「这一串 32 位以上的 `[A-Za-z0-9_-]`,是**一把密钥**还是**一个标识符**?」——
 * 规则 7 的判据,`redactText` 与 `findRedactionHits` 共用同一个答案。
 *
 * 三句话,顺序有意义:
 *
 *  1. **标识符形放过**:按蛇形 + 驼峰拆开之后,每一段都是 ≥ 3 位的**纯字母**段
 *     (`translates` / `Autoresizing` / `Mask` / `Into` / `Constraints`)。密钥拆不出
 *     这样的段 —— 它没有词边界,拆出来全是一两位的碎片。
 *  2. **至少 3 个数字**:随机串里数字是均匀撒开的,32 位以上几乎不可能一个数字都
 *     没有,更不可能只有一两个。
 *  3. **带分隔符又带数字**:`sk_live_51H8xKl…` 这种「前缀 + 随机段」的形,数字可能
 *     不多,但 `-` / `_` 与数字同时出现,标识符里罕见。
 *
 * 第 1 句今天与「串里一个数字都没有」是同一个答案(纯字母段 ⇒ 无数字 ⇒ 2、3 都不
 * 成立),写出来是因为**它才是判据本身**:2、3 是手段,「这是个标识符」是理由;哪天
 * 阈值要动,拦住标识符的仍然是这一句。
 *
 * **刻意留的口子**:纯字母、又拆不出词段的随机串(`aBcDeFgHiJ…`,32 位无数字)
 * 会被放过。收紧到「不是标识符形就洗」会把 `x_y_z_aaaa…` 这类也吃掉 —— 宁可漏洗
 * 一种今天没见过的形,也不再误伤正经标识符,方向是**少洗**(多洗一个词就是倒排里
 * 少一个词)。真密钥的一般形(含数字)照洗。
 */
function isLikelySecretToken(text: string): boolean {
  if (wordSegments(text)?.every(segment => segment.length >= 3)) return false
  let digits = 0
  for (const ch of text) if (ch >= '0' && ch <= '9') digits += 1
  if (digits >= 3) return true
  return digits >= 1 && /[-_]/.test(text)
}

/**
 * 一条规则:`id` 进报告与单测,`pattern` 同时用于「洗」与「验」。
 *
 * 可选的 `accept(match)` 是**形状之外**的判据(规则 7 与规则 8 各一个):正则说
 * 「长得像」,`accept` 说「是不是真要换」。两个消费者读同一个 `accept`,所以「洗过
 * 之后没有任何规则再命中」这条恒等式对带谓词的规则同样成立。
 */
interface RedactRule {
  id: string
  pattern: RegExp
  replace: string
  accept?: (match: string) => boolean
}

const RULES: readonly RedactRule[] = [
  {
    id: 'home-path',
    // `/Users/<name>` / `/home/<name>` 的**前两段**换成 `~`,后面的路径原样留下 ——
    // 目录结构对检索是有用的信号(`~/data/code/…` 里的 `code` 是真词),名字不是。
    pattern: /\/(?:Users|home)\/[A-Za-z0-9._-]+/g,
    replace: '~',
  },
  {
    id: 'email',
    pattern: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g,
    replace: '<redacted:email>',
  },
  {
    id: 'sk-key',
    // `sk-`、`sk-ant-`、`sk-proj-` 都在这一条里:前缀之后至少 16 位。
    pattern: /\bsk-[A-Za-z0-9_-]{16,}/g,
    replace: '<redacted:apikey>',
  },
  {
    id: 'bearer',
    pattern: /\bBearer\s+[A-Za-z0-9._-]+/g,
    replace: 'Bearer <redacted:token>',
  },
  {
    id: 'assigned-secret',
    // 键名(捕获组 1)与分隔符(捕获组 2)留着,只换右边的值。右边至少 8 位,
    // 且**不含**尖括号 —— 所以第二遍跑到 `token=<redacted:secret>` 时不再命中。
    pattern: /\b(api[_-]?key|apikey|access[_-]?key|secret[_-]?key|client[_-]?secret|secret|token|password|passwd|pwd)(\s*[=:]\s*["']?)[A-Za-z0-9_\-./+]{8,}["']?/gi,
    replace: '$1$2<redacted:secret>',
  },
  {
    id: 'phone',
    // 中国大陆手机号:可选 `+86` / `86` 前缀,11 位 `1[3-9]xxxxxxxxx`,允许空格或
    // 连字符分隔。两侧的数字断言挡住时间戳与长数字串。
    pattern: /(?<!\d)(?:\+?86[\s-]?)?1[3-9]\d(?:[\s-]?\d){8}(?!\d)/g,
    replace: '<redacted:phone>',
  },
  {
    id: 'long-token',
    // 32 位以上的 `[A-Za-z0-9_-]` 连续串。两侧用同字符集的断言夹住,免得从一个更长
    // 的串中间切一刀。长度只是**候选**的条件 —— 是不是密钥交给 `accept`。
    pattern: /(?<![A-Za-z0-9_-])[A-Za-z0-9_-]{32,}(?![A-Za-z0-9_-])/g,
    replace: '<redacted:token>',
    accept: isLikelySecretToken,
  },
  {
    id: 'public-ipv4',
    // 形状:点分四段,每段 1–3 位。两侧的 `[\d.]` 断言把它夹死在「正好四段」上 ——
    // `1.2.3.4.5`(五段)与 `10.0.0.1.5` 一条都不匹配,版本号 `1.2.3` 段数不够也不
    // 匹配。段值该不该洗交给 `accept`,不塞进正则:那会变成一条没人读得懂的巨正则。
    pattern: /(?<![\d.])\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}(?![\d.])/g,
    replace: '<ip>',
    accept: isPublicIpv4,
  },
]

/** 规则 id 表(单测与报告按它逐条走)。 */
export const REDACT_RULE_IDS: readonly string[] = RULES.map(rule => rule.id)

/**
 * 洗一段文本。非字符串原样返回(投影里 `content` 偶尔是别的形状,由调用方先归一)。
 *
 * 泛型签名是从 `.mjs` 那份的 `.d.mts` 逐字继承来的:`redactText<T>(text: T): T`
 * —— 调用方传字符串拿字符串、传别的原样拿回,类型上不必再判一次。
 */
export function redactText<T>(text: T): T {
  if (typeof text !== 'string' || text.length === 0) return text
  let out: string = text
  for (const rule of RULES) {
    const pattern = new RegExp(rule.pattern.source, rule.pattern.flags)
    const accept = rule.accept
    out = accept
      ? out.replace(pattern, match => (accept(match) ? rule.replace : match))
      : out.replace(pattern, rule.replace)
  }
  return out as unknown as T
}

/**
 * 验一段文本:返回**还命中哪些规则**。洗过之后应当是空表 —— 这就是幂等的另一半。
 *
 * 注意规则 5(`assigned-secret`)的判据里键名与分隔符都在,占位符 `<redacted:secret>`
 * 以 `<` 起头,不在值的字符集里,所以洗过的文本它不再命中。
 */
export function findRedactionHits(text: unknown): string[] {
  if (typeof text !== 'string' || text.length === 0) return []
  const hits: string[] = []
  for (const rule of RULES) {
    const probe = new RegExp(rule.pattern.source, rule.pattern.flags)
    const accept = rule.accept
    if (!accept) {
      if (probe.test(text)) hits.push(rule.id)
      continue
    }
    // 带谓词的规则:形状命中还不够,得 `accept` 也点头 —— 否则私网地址会被报成
    // 「漏网」,而它本来就是**故意留下**的。
    for (const match of text.matchAll(probe)) {
      if (accept(match[0])) {
        hits.push(rule.id)
        break
      }
    }
  }
  return hits
}
