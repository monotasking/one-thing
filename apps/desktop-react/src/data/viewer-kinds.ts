import { langOfPath, baseNameOf } from './files-source'
import type { FileFailure } from './files-source'
import { extensionOf } from './file-icons'

/**
 * **分型表** —— 「这个文件该用哪一种查看形」的唯一产地(查看器 F1 §2 / F2 §扩展性)。
 *
 * 一张纯表、一组纯函数:不 import React、不碰端口、不认识 store。与
 * `data/file-icons.ts` 同族同测法 —— 那一张说「这一行画什么标识」,这一张说
 * 「这个文件用哪一种画法」。两张表刻意**不合并**:图标问的是「它长什么样」,
 * 查看形问的是「它怎么读」,同一个 `.svg` 在前者是媒体图标、在后者既是图又是
 * 一段可看的源码。
 *
 * ── 09-01:加一型只动三处(用户定的交卷判据)────────────────────────────────
 * 从前加一型要动九处(扩展名表、ViewerKind 联合、resolveViewerKind 的分支、
 * viewerKindOfPath 的分支、另一个文件里的 ViewerFile 联合、read() 里那个 switch、
 * directFileOf、处理器、barrel)。现在「这一型是什么形状 / 认哪些扩展名 /
 * 吃不吃体积闸 / 怎么从一次读造出来」**全收进下面 VIEWER_KINDS 那一行**,于是:
 *
 *   ① `data/viewer-kinds.ts` —— ViewerFile 联合加一支 + VIEWER_KINDS 加一行;
 *   ② `content/viewer/kinds/<新型>.tsx` —— 它长什么样(registerViewer);
 *   ③ `content/viewer/kinds/index.ts` —— 一行 import。
 *
 * 头、脚、跳转条、键位、落点、状态留存、右键菜单**一个字都不改**。
 *
 * ── 判定次序是有理由的,不是随手排的 ─────────────────────────────────────
 * ① **direct 的型先判**,而且**不吃体积闸**:图与播放条是靠 `src` 显示的,这一层
 *    从头到尾没有把它们的字节读进渲染进程 —— 体积上限管的是「读多少字节进内存」,
 *    对一条从没被读过的路径不成立。一张 40MB 的 png 该画就画,画不出来由浏览器
 *    自己报错(那时才落诚实态)。
 * ② **oversize 压过 binary**:两者都不给内容,但说的不是同一句话 ——
 *    「太大了没读」与「读了也不是文本」对用户是两种不同的下一步。
 * ③ **binary 三条判据取并**:扩展名黑名单是**预判**(不用读就知道),后端的
 *    `isBinary` 与 NUL 探测是**实测**。三条都留着:黑名单挡的是「读回来一堆
 *    乱码之前」,实测挡的是「扩展名骗人」(`.txt` 里塞着一个 ELF)。
 * ④ markdown 与 code 在最后分岔 —— 到这一步它已经确定是一段能读的文本了。
 */

/* ── 体积闸(常量表)────────────────────────────────────────────────────── */

/**
 * 超过它就**不按文本打开**。20MB 不是随手取的:它比任何一份人写的源码都大一个
 * 数量级,而一次性把 20MB 字符串搬进渲染进程 + 逐行建 DOM 是秒级的卡顿。
 * 到了这一档,诚实态(类型 + 大小 + 去 Finder)比一屏冻住的界面有用。
 */
export const VIEWER_OVERSIZE_BYTES = 20 * 1024 * 1024

/**
 * 一段有多大。文件 ≤ 一段就整份读回来;更大就**只读首段**,屏幕上给一颗
 * 「继续加载」,按一次再多一段。
 *
 * ── 「继续加载」为什么是重读一段更长的前缀 ───────────────────────────────
 * `files.readContent` 只有 `maxSize`(读前 n 字节),**没有 offset**。所以续读
 * 的写法是把 `maxSize` 加一段再问一次 —— 代价是前一段被重读了一遍,换来的是
 * 端口一个字都不用改。这条是有意的取舍,不是没想到:真要省那一次重读,得先在
 * `@shared/ipc/files` 的契约上开一格 offset,那是拍板件。
 */
export const VIEWER_CHUNK_BYTES = 5 * 1024 * 1024

/**
 * 超过这么多行就给每一行开 `content-visibility`(行跳渲,U3 判例)。
 *
 * 2000 行以下全量渲染更快 —— 跳渲本身有代价(每行一次 containment 计算)。
 * 这个数在两条曲线的交点附近,不必精确:它决定的是「哪一档更划算」,
 * 而不是对错。
 */
export const VIEWER_SKIP_LINES = 2000

/* ── 型的联合 ──────────────────────────────────────────────────────────── */

/**
 * 查看器手上这一份文件。**判别联合,不是一个带一堆空字段的结构**:消费方
 * `switch (file.kind)`,不会有「binary 却去读 content」这种半空对象
 * (同 file-icons 的 FileGlyph 判例)。
 *
 * `error` 是**第七种**,与六种查看形平级:读不到也是一种如实的呈现,
 * 不是别的型的一个失败标志位。
 *
 * 它 09-01 从 `viewer-source.ts` 搬到这里 —— 理由是文件头那条「加一型只动三处」:
 * 型的**形状**与型的**判据**本来就是同一件事,分在两个文件里就一定要改两处。
 */
export type ViewerFile =
  | {
      kind: 'code'
      path: string
      name: string
      /** 高亮语言;null = 这台不认识它,画素文本(不是错误)。 */
      lang: string | null
      content: string
      /** 文件真实字节数。 */
      size: number
      /** 这一次问后端要了多少字节 —— 「继续加载」的下一段从它算起。 */
      loaded: number
      /** 真实字节数 > 已要到的量 —— 屏幕上只是开头一段。 */
      truncated: boolean
      /** 盘上的时间戳。写回时当乐观锁用(缺席 = 后端没给,那就不加锁)。 */
      mtimeMs?: number
    }
  | {
      kind: 'markdown'
      path: string
      name: string
      content: string
      size: number
      loaded: number
      truncated: boolean
      mtimeMs?: number
    }
  | {
      kind: 'image'
      path: string
      name: string
      /** `<img>` 的 src(file:// —— 唯一产地是 fileUrlOf)。 */
      src: string
      /** svg 才有:它的那份源码,好让「源码 ⇄ 渲染」切得动。 */
      svgSource?: string
    }
  | {
      /** 播放条:视频与音频同一型,它们要的是同一件东西。 */
      kind: 'media'
      path: string
      name: string
      src: string
      /** 画 `<video>` 还是 `<audio>` —— 判据在这里定一次。 */
      audio: boolean
    }
  | {
      kind: 'binary'
      path: string
      name: string
      /** 后端给了就给,没给就缺席 —— **不拿 0 B 顶**。 */
      size?: number
    }
  | {
      kind: 'oversize'
      path: string
      name: string
      size: number
      /** 闸值,好让界面说得出「超过多少」。 */
      limit: number
    }
  | {
      kind: 'error'
      path: string
      name: string
      failure: FileFailure
      /** 后端原话。归类归类,原话原样。 */
      error?: string
    }

export type ViewerKind = ViewerFile['kind']

/* ── 表 ────────────────────────────────────────────────────────────────── */

/** 一次读回来的事实。表里每一行的 `build` 只吃它,不认识 store、不认识端口。 */
export interface ViewerReadFacts {
  path: string
  name: string
  /** 读回来那一段(direct 的型收到空串 —— 它一个字节都没读)。 */
  content: string
  /** 文件真实字节数。0 = 后端没给。 */
  size: number
  /** 这一次问后端要了多少字节。 */
  want: number
  mtimeMs?: number
  /** 读失败时的两格(只有 error 那一行用得着)。 */
  failure?: FileFailure
  error?: string
}

export interface ViewerKindSpec {
  kind: ViewerKind
  /**
   * 认哪些扩展名。**空表 = 不靠扩展名认** —— oversize / error 是壳级判据
   * (「太大了」「读不到」跟后缀无关),code 是兜底。
   */
  exts: readonly string[]
  /**
   * **一个字节都不读**:把路径交给浏览器(`<img src>` / `<video src>`)。
   * 这一族同时**不吃体积闸** —— 闸管的是「读多少字节进渲染进程」,
   * 对一条从没被读过的路径不成立。
   */
  direct?: boolean
  /** 从一次读的事实造出这一型的记录。 */
  build(facts: ViewerReadFacts): ViewerFile
}

/** 播放条那一型里,画 `<audio>` 的那一半。 */
const AUDIO_EXTS = new Set(['mp3', 'wav', 'flac', 'ogg', 'm4a', 'aac'])

/**
 * **分型表 —— 加一型只动这一行(和另外两处)**。
 *
 * 次序即判定序,而且是有理由的(见文件头那四条):direct 的两型在最前(它们
 * 压过体积闸),binary 压过 markdown / code(黑名单挡的是「读回来一堆乱码」),
 * `code` 在它们之后当兜底 —— 认不出后缀但读得动的纯文本就是它。
 * oversize / error 排在表尾且 `exts` 为空:它们永远不由扩展名认领。
 */
export const VIEWER_KINDS: readonly ViewerKindSpec[] = [
  {
    kind: 'image',
    exts: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'bmp', 'ico', 'tif', 'tiff', 'svg'],
    direct: true,
    /*
     * svg 是唯一一种既是图也是一段源码的。走真读那条路时 content 有值,
     * direct 那条路(位图)收到的是空串,于是 svgSource 缺席 —— 判据一处,
     * 不在两个地方各写一次「svg 特殊」。
     */
    build: ({ path, name, content }) => ({
      kind: 'image',
      path,
      name,
      src: fileUrlOf(path),
      svgSource: isSvgPath(path) && content ? content : undefined,
    }),
  },
  {
    kind: 'media',
    exts: ['mp4', 'mov', 'webm', 'm4v', 'mkv', 'avi', 'mp3', 'wav', 'flac', 'ogg', 'm4a', 'aac'],
    direct: true,
    build: ({ path, name }) => ({
      kind: 'media',
      path,
      name,
      src: fileUrlOf(path),
      audio: AUDIO_EXTS.has(extensionOf(baseNameOf(path))),
    }),
  },
  {
    /**
     * 扩展名黑名单 —— **预判**那一半。可执行体 / 归档 / 字体 / 文档容器:
     * 它们里面确实有可打印字符,所以光靠 NUL 探测会漏(读回来半屏乱码 + 半屏
     * 认得出的字符串,比一句「这是二进制」糟得多)。
     *
     * 与 file-icons 那张 `bin` 字标表**有交集但不是同一张**:那一张说的是
     * 「这一行画 BIN 两个字母」(只列可执行体),这一张说的是「别按文本打开」
     * (还包括 zip / pdf —— 它们各有各的图标,却同样不是文本)。
     *
     * 音视频**不在这一行里**了(F2 media 转正):它们由上面那一行认领,
     * 而这一行留着一份副本只会让「删掉 media 行会怎样」变得说不清。
     */
    kind: 'binary',
    exts: [
      // 可执行体与目标文件
      'exe', 'dll', 'so', 'dylib', 'bin', 'o', 'a', 'wasm', 'class', 'pyc', 'node',
      // 归档
      'zip', 'tar', 'gz', 'tgz', 'bz2', 'xz', '7z', 'rar', 'zst', 'jar', 'dmg', 'iso',
      // 字体与文档容器
      'woff', 'woff2', 'ttf', 'otf', 'eot', 'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx',
      // 数据库
      'sqlite', 'db', 'lockb',
    ],
    build: ({ path, name, size }) => ({
      kind: 'binary',
      path,
      name,
      // 后端给了就给,没给就缺席 —— 不拿 0 B 顶。
      size: size > 0 ? size : undefined,
    }),
  },
  {
    kind: 'markdown',
    exts: ['md', 'markdown', 'mdx'],
    build: ({ path, name, content, size, want, mtimeMs }) => ({
      kind: 'markdown',
      path,
      name,
      content,
      size,
      loaded: want,
      truncated: size > want,
      mtimeMs,
    }),
  },
  {
    /** 兜底:源码 + 认不出后缀但读得动的纯文本(`lang === null` 就是后者)。 */
    kind: 'code',
    exts: [],
    build: ({ path, name, content, size, want, mtimeMs }) => ({
      kind: 'code',
      path,
      name,
      lang: viewerLangOf(path),
      content,
      size,
      loaded: want,
      truncated: size > want,
      mtimeMs,
    }),
  },
  {
    kind: 'oversize',
    exts: [],
    build: ({ path, name, size }) => ({
      kind: 'oversize',
      path,
      name,
      size,
      limit: VIEWER_OVERSIZE_BYTES,
    }),
  },
  {
    kind: 'error',
    exts: [],
    build: ({ path, name, failure, error }) => ({
      kind: 'error',
      path,
      name,
      failure: failure ?? 'failed',
      error,
    }),
  },
]

export function specOf(kind: ViewerKind): ViewerKindSpec {
  const hit = VIEWER_KINDS.find((k) => k.kind === kind)
  if (!hit) {
    // 走到这里说明表与联合分家了 —— 那是装配错误,不是内容错误。
    throw new Error(`分型表里没有这一型:${kind}`)
  }
  return hit
}

/** 兜底那一行(认不出扩展名时落它)。取一次,不每次查表。 */
const CODE_SPEC = specOf('code')

/**
 * ── 留表位:这两种今天**不接**,但位子写在这里 ──────────────────────────────
 * PDF 与 CSV 都有各自成立的画法(分页渲染 / 表格),而两者都不是「加一行注册」
 * 就能有的东西:PDF 要一台渲染器(零新依赖那条铁律先挡着),CSV 要一张能横滚、
 * 能按列对齐、能认表头的表(壳里那张 table 块是为 markdown 表格定的,量级不同)。
 * 所以它们今天走 binary / code 型的诚实态,而不是画一个半成品。
 *
 * 这张表的用处与 `PLUGIN_DEFERRED_REGISTRIES` 同款:**说出「知道但没做」**,
 * 免得下一个人以为是漏了。接上一种 = VIEWER_KINDS 加一行 + 一个处理器 +
 * barrel 一行(三处),再从这里删一行。
 */
export const DEFERRED_VIEWER_TYPES: readonly { ext: readonly string[]; why: string }[] = [
  { ext: ['pdf'], why: '要一台 PDF 渲染器,与「零新依赖」这条铁律冲突,属拍板件' },
  { ext: ['csv', 'tsv'], why: '要一张能横滚 / 对齐 / 认表头的真表,块系统那张 table 是为 markdown 定的' },
]

/* ── 判定 ──────────────────────────────────────────────────────────────── */

/** 这条路径的扩展名落在表里哪一行上。认不出 = 兜底那一行(code)。 */
export function specOfPath(path: string): ViewerKindSpec {
  const ext = extensionOf(baseNameOf(path))
  return VIEWER_KINDS.find((spec) => spec.exts.includes(ext)) ?? CODE_SPEC
}

export function isImagePath(path: string): boolean {
  return specOfPath(path).kind === 'image'
}

export function isMediaPath(path: string): boolean {
  return specOfPath(path).kind === 'media'
}

/** svg **是图也是文本** —— 它是唯一一种能在两种画法之间切的型。 */
export function isSvgPath(path: string): boolean {
  return extensionOf(baseNameOf(path)) === 'svg'
}

export function isMarkdownPath(path: string): boolean {
  return specOfPath(path).kind === 'markdown'
}

export function isBinaryExtension(path: string): boolean {
  return specOfPath(path).kind === 'binary'
}

/**
 * NUL 探测 —— 「这段字符不是文本」的**实测**判据。
 *
 * 只看开头一段:真正的二进制在头几百字节里必然有一个 NUL 字节(魔数、长度字段、
 * 对齐填充),而扫一份 5MB 的字符串只为找一个字符是白花的钱。8KB 是 `file(1)`
 * 一族的通行窗口,这里跟着它。
 */
export function containsNul(text: string, window = 8 * 1024): boolean {
  const end = Math.min(text.length, window)
  for (let i = 0; i < end; i += 1) {
    if (text.charCodeAt(i) === 0) return true
  }
  return false
}

/**
 * **不用读就知道的那一半**。树上一行、右键菜单、形态记忆都可以先问它一句
 * ——「点下去会看到哪一种东西」。它认不出 oversize(那要真实字节数),也不做
 * 实测的那两条判据,所以它交出来的 `code` 可能在读完之后被改判成 `binary`。
 */
export function viewerKindOfPath(path: string): ViewerKind {
  return specOfPath(path).kind
}

export interface ViewerKindInput {
  path: string
  /** 文件**真实**字节数(不是读回来那一段的长度)。缺席 = 后端没给。 */
  size?: number
  /** 后端的判断。它比我们的黑名单见多识广,但它也可能缺席。 */
  isBinary?: boolean
  /** 读回来那一段。用于 NUL 探测。 */
  content?: string
}

/**
 * **读完之后的定型**,回的是表里那一行。次序见文件头那四条 —— 这个函数是那四条
 * 的**唯一**落点,分型的判断在全仓不许有第二处。
 */
export function resolveViewerSpec(input: ViewerKindInput): ViewerKindSpec {
  const byExt = specOfPath(input.path)
  // ① direct 的两型压过体积闸:它们的字节从没被读进来过。
  if (byExt.direct) return byExt
  // ② 「太大了没读」与「读了也不是文本」是两句话,前者压后者。
  if (input.size !== undefined && input.size > VIEWER_OVERSIZE_BYTES) return specOf('oversize')
  // ③ 三条判据取并:黑名单是预判,后端的 isBinary 与 NUL 探测是实测。
  if (byExt.kind === 'binary') return byExt
  if (input.isBinary === true) return specOf('binary')
  if (input.content !== undefined && containsNul(input.content)) return specOf('binary')
  // ④ 到这一步已经确定是一段能读的文本了:markdown 与 code 在这里分岔。
  return byExt
}

/** 老口径的薄壳(单测与按 kind 说话的调用方用)。 */
export function resolveViewerKind(input: ViewerKindInput): ViewerKind {
  return resolveViewerSpec(input).kind
}

/**
 * 高亮语言。**表在 `files-source.langOfPath`,这里不抄第二份** —— 分型表要用它
 * (「扩展名在高亮语言表里」是 code 型能上色的判据),但一张表两个产地必然分叉。
 */
export function viewerLangOf(path: string): string | null {
  return langOfPath(path)
}

/**
 * 一条绝对路径 → `file://` URL。**图与播放条的 src 只有这一个产地。**
 *
 * 逐段 encodeURIComponent 而不是整条 encodeURI:路径里的 `#` 与 `?` 在 URL 里
 * 是分隔符,整条编码留着它们,一个叫 `note#1.png` 的文件会被截成 `note`。
 * 分隔用的 `/` 由 join 补回去,所以段内的 `/` 不可能存在(它本来就是分隔符)。
 *
 * ── 它在哪儿真能用 ─────────────────────────────────────────────────────
 * 打包后的壳是 `file://` 起源的页面,同源取 `file://` 资源成立。dev 服务器
 * (`http://localhost`)与浏览器面上取不到 —— Chromium 不许 http 页面读本地文件。
 * 那不是缺陷,是宿主的事实,所以取不到时查看器落**诚实态**并说出这句话,
 * 而不是留一片空白(图与播放条两型各有一格 —— F2 起播放条也有了)。
 */
export function fileUrlOf(path: string): string {
  return `file://${path.split('/').map(encodeURIComponent).join('/')}`
}
