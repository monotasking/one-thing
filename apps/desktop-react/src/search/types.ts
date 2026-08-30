/**
 * 检索面的形状。和 expose/ 一样:这里只有数据,没有 React、没有 DOM。
 *
 * 终稿的形状决定了这张表长什么样:面板上**只有一张平铺列表**,没有分组、没有分栏,
 * 所以模型里也不能有「组」这一层 —— 一行就是 SearchRow,列表就是 SearchRow[]。
 * 会话命中和文件命中在同一条流水线上被造出来,靠 domain / badge 区分,不靠两棵树。
 */
export type SearchScope = 'all' | 'sessions' | 'files'

/** 素材来自哪一侧。scope 过滤只看这一个字段。 */
export type SearchDomain = 'session' | 'file'

/**
 * 行首那颗空心小徽。**它是可辨识联合而不是一个字符串** ——
 * 前两种的字面文案归字典(换语言要变),第三种的 ext 是从路径推出来的**数据**
 * (`.ts` → `TS`,换语言不该变)。两者混成一个 string 就分不清谁该进字典了。
 */
export type SearchBadge =
  | { kind: 'session' }
  | { kind: 'message' }
  | { kind: 'file'; ext: string }

/**
 * 跳转目标。同样是可辨识联合而不是裸字符串:
 * 「会话 id」和「文件路径」是两种不同的东西,拼成一个字符串就得再解析一次。
 *
 * `line` 是**可选**的(D5):真实产地 `files.list` 是按名字找文件,它给不出行号。
 * 缺席 = 落点就是这个文件本身。将来接上内容检索(rg --json)时那一格才有值,
 * 届时这里一个字不用改 —— 这正是把它写成可选而不是删掉的理由。
 */
export type SearchTarget =
  | { kind: 'session'; sessionId: string }
  | { kind: 'file'; path: string; line?: number }

/**
 * 行尾那行灰色小字的**素材**,不是成品字符串 —— 拼法(`:`、` · `)由
 * transitions 的 originText 定一次,组件不许自己拼。
 */
export type SearchOrigin =
  /** 消息 / 章节命中 → 所属会话名 */
  | { kind: 'session'; session: string }
  /** 文件行命中 → 文件名:行号 */
  | { kind: 'fileLine'; file: string; line: number }
  /** 会话标题命中 → 项目名 · 时间 */
  | { kind: 'projectTime'; project: string; time: string }
  /** 不属于任何项目的会话,以及空态的最近会话 → 只剩时间 */
  | { kind: 'time'; time: string }
  /** 文件名命中,以及空态的最近文件 → 路径 */
  | { kind: 'path'; path: string }

/**
 * 排序只有两级,**不是按类型分堆**:
 * 标题 / 文件名 / 章节标题命中(title)整体排在正文 / 代码行命中(body)之前,
 * 同级里会话与文件交替出现,各自保持自己那张表的次序。
 */
export type SearchTier = 'title' | 'body'

export interface SearchRow {
  id: string
  domain: SearchDomain
  badge: SearchBadge
  /** 中间的主角:命中原文一行(视图负责高亮与省略号) */
  text: string
  /** 代码行用等宽字体 */
  code: boolean
  origin: SearchOrigin
  target: SearchTarget
  tier: SearchTier
}

/* ── 文件侧素材 ──────────────────────────────────────────────────────────
 * D5 之后这里**一个类型都没有**:文件侧的素材就是 `@shared/ipc/files` 的
 * `FileSearchEntry`(后端契约),壳不再在它旁边立第二份形状。
 * 旧的 `FileMock` / `FileLineMock`(假路径 + 假代码行)随 mock 一起退役,
 * 理由写在 ./data.ts 顶部。
 * ────────────────────────────────────────────────────────────────────── */
