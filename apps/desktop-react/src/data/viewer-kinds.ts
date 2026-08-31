import { langOfPath, baseNameOf } from './files-source'
import { extensionOf } from './file-icons'

/**
 * **分型表** —— 「这个文件该用哪一种查看形」的唯一产地(查看器 F1 §2)。
 *
 * 一张纯表、一组纯函数:不 import React、不碰端口、不认识 store。与
 * `data/file-icons.ts` 同族同测法 —— 那一张说「这一行画什么标识」,这一张说
 * 「这个文件用哪一种画法」。两张表刻意**不合并**:图标问的是「它长什么样」,
 * 查看形问的是「它怎么读」,同一个 `.svg` 在前者是媒体图标、在后者既是图又是
 * 一段可看的源码。
 *
 * ── 五型 ────────────────────────────────────────────────────────────────
 *   code      能按文本读的一切(高亮语言表里有就上色,没有就素文本)
 *   markdown  .md / .markdown / .mdx —— 走壳自己的块翻译表整套渲染
 *   image     位图与 svg —— 不读字节,交给 <img>(svg 另外读一份源码)
 *   binary    扩展名黑名单 / 后端说 isBinary / 内容里探到 NUL
 *   oversize  真实字节数超过上限 —— 不读、不猜、如实说
 *
 * ── 判定次序是有理由的,不是随手排的 ─────────────────────────────────────
 * ① **image 先判**,而且**不吃体积闸**:图是靠 `<img>` 的 src 显示的,这一层
 *    从头到尾没有把它的字节读进渲染进程 —— 体积上限管的是「读多少字节进内存」,
 *    对一条从没被读过的路径不成立。一张 40MB 的 png 该画就画,画不出来由 img
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

/* ── 扩展名表 ──────────────────────────────────────────────────────────── */

/** `<img>` 认得的那些。svg 也在里面 —— 它既是图,也是一段可看的源码。 */
const IMAGE_EXTS = new Set([
  'png',
  'jpg',
  'jpeg',
  'gif',
  'webp',
  'avif',
  'bmp',
  'ico',
  'tif',
  'tiff',
  'svg',
])

const MARKDOWN_EXTS = new Set(['md', 'markdown', 'mdx'])

/**
 * 播放条那一档(**示例档**,定稿点名)。视频与音频合一型:它们要的是同一件东西
 * —— 一条播放条 + 一个原生播放器。与图同一条口径:**不读字节**,交给浏览器,
 * 所以它也不吃体积闸。
 */
const MEDIA_EXTS = new Set([
  'mp4', 'mov', 'webm', 'm4v', 'mkv', 'avi',
  'mp3', 'wav', 'flac', 'ogg', 'm4a', 'aac',
])

/**
 * 扩展名黑名单 —— **预判**那一半。可执行体 / 归档 / 音视频 / 字体 / 文档容器:
 * 它们里面确实有可打印字符,所以光靠 NUL 探测会漏(读回来半屏乱码 + 半屏
 * 认得出的字符串,比一句「这是二进制」糟得多)。
 *
 * 与 file-icons 那张 `bin` 字标表**有交集但不是同一张**:那一张说的是
 * 「这一行画 BIN 两个字母」(只列可执行体),这一张说的是「别按文本打开」
 * (还包括 zip / mp4 / pdf —— 它们各有各的图标,却同样不是文本)。
 */
const BINARY_EXTS = new Set([
  // 可执行体与目标文件
  'exe', 'dll', 'so', 'dylib', 'bin', 'o', 'a', 'wasm', 'class', 'pyc', 'node',
  // 归档
  'zip', 'tar', 'gz', 'tgz', 'bz2', 'xz', '7z', 'rar', 'zst', 'jar', 'dmg', 'iso',
  // 音视频
  'mp3', 'wav', 'flac', 'ogg', 'm4a', 'aac', 'mp4', 'mov', 'mkv', 'webm', 'avi', 'm4v',
  // 字体与文档容器
  'woff', 'woff2', 'ttf', 'otf', 'eot', 'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx',
  // 数据库
  'sqlite', 'db', 'lockb',
])

export type ViewerKind = 'code' | 'markdown' | 'image' | 'media' | 'binary' | 'oversize'

/**
 * ── 留表位:这两种今天**不接**,但位子写在这里 ──────────────────────────────
 * PDF 与 CSV 都有各自成立的画法(分页渲染 / 表格),而两者都不是「加一行注册」
 * 就能有的东西:PDF 要一台渲染器(零新依赖那条铁律先挡着),CSV 要一张能横滚、
 * 能按列对齐、能认表头的表(壳里那张 table 块是为 markdown 表格定的,量级不同)。
 * 所以它们今天走 code 型(纯文本 / 或诚实态),而不是画一个半成品。
 *
 * 这张表的用处与 `PLUGIN_DEFERRED_REGISTRIES` 同款:**说出「知道但没做」**,
 * 免得下一个人以为是漏了。接上一种 = 写一个处理器 registerViewer,再从这里删一行。
 */
export const DEFERRED_VIEWER_TYPES: readonly { ext: readonly string[]; why: string }[] = [
  { ext: ['pdf'], why: '要一台 PDF 渲染器,与「零新依赖」这条铁律冲突,属拍板件' },
  { ext: ['csv', 'tsv'], why: '要一张能横滚 / 对齐 / 认表头的真表,块系统那张 table 是为 markdown 定的' },
]

export function isImagePath(path: string): boolean {
  return IMAGE_EXTS.has(extensionOf(baseNameOf(path)))
}

export function isMediaPath(path: string): boolean {
  return MEDIA_EXTS.has(extensionOf(baseNameOf(path)))
}

/** svg **是图也是文本** —— 它是唯一一种能在两种画法之间切的型。 */
export function isSvgPath(path: string): boolean {
  return extensionOf(baseNameOf(path)) === 'svg'
}

export function isMarkdownPath(path: string): boolean {
  return MARKDOWN_EXTS.has(extensionOf(baseNameOf(path)))
}

export function isBinaryExtension(path: string): boolean {
  return BINARY_EXTS.has(extensionOf(baseNameOf(path)))
}

/**
 * NUL 探测 —— 「这段字符不是文本」的**实测**判据。
 *
 * 只看开头一段:真正的二进制在头几百字节里必然有 ` `(魔数、长度字段、
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
 * **不用读就知道的那一半**。树上一行、右键菜单、将来的形态记忆都可以先问它一句
 * ——「点下去会看到哪一种东西」。它认不出 oversize(那要真实字节数),也不做
 * 实测的那两条判据,所以它交出来的 `code` 可能在读完之后被改判成 `binary`。
 */
export function viewerKindOfPath(path: string): Exclude<ViewerKind, 'oversize'> {
  if (isImagePath(path)) return 'image'
  if (isMediaPath(path)) return 'media'
  if (isBinaryExtension(path)) return 'binary'
  if (isMarkdownPath(path)) return 'markdown'
  return 'code'
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
 * **读完之后的定型**。次序见文件头那四条。
 */
export function resolveViewerKind(input: ViewerKindInput): ViewerKind {
  if (isImagePath(input.path)) return 'image'
  // 播放条与图同一条理由:字节没被读进来,体积闸管不着它。
  if (isMediaPath(input.path)) return 'media'
  if (input.size !== undefined && input.size > VIEWER_OVERSIZE_BYTES) return 'oversize'
  if (isBinaryExtension(input.path)) return 'binary'
  if (input.isBinary === true) return 'binary'
  if (input.content !== undefined && containsNul(input.content)) return 'binary'
  if (isMarkdownPath(input.path)) return 'markdown'
  return 'code'
}

/**
 * 高亮语言。**表在 `files-source.langOfPath`,这里不抄第二份** —— 分型表要用它
 * (「扩展名在高亮语言表里」是 code 型能上色的判据),但一张表两个产地必然分叉。
 */
export function viewerLangOf(path: string): string | null {
  return langOfPath(path)
}

/**
 * 一条绝对路径 → `file://` URL。**图的 src 只有这一个产地。**
 *
 * 逐段 encodeURIComponent 而不是整条 encodeURI:路径里的 `#` 与 `?` 在 URL 里
 * 是分隔符,整条编码留着它们,一个叫 `note#1.png` 的文件会被截成 `note`。
 * 分隔用的 `/` 由 join 补回去,所以段内的 `/` 不可能存在(它本来就是分隔符)。
 *
 * ── 它在哪儿真能用 ─────────────────────────────────────────────────────
 * 打包后的壳是 `file://` 起源的页面,同源取 `file://` 图片成立。dev 服务器
 * (`http://localhost`)与浏览器面上取不到 —— Chromium 不许 http 页面读本地文件。
 * 那不是缺陷,是宿主的事实,所以 `<img>` 报错时查看器落**诚实态**并说出这句话,
 * 而不是留一片空白。
 */
export function fileUrlOf(path: string): string {
  return `file://${path.split('/').map(encodeURIComponent).join('/')}`
}
